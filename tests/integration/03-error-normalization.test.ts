// Integration test 03 — Anthropic error handling (see ADR-0008 §关键 wire 发现 #1).
//
// The plan for §3 originally expected the bridge to emit a
// command_result{success:false, error:{code,message}} when the LLM
// returns an Anthropic error response. The actual pi 0.85.1 wire
// shape is different: pi's RPC contract emits the prompt
// command_result AS SOON AS the preflight passes (success=true),
// and the LLM-side failure surfaces only on the EVENT stream
// (`message_end` with stopReason='error' + errorMessage set).
//
// This test pins the actual shape we observed end-to-end against
// the real pi subprocess:
//   - fake server returns a JSON `{type:'error', ...}` body with
//     HTTP 400 (Anthropic's standard invalid_request_error shape);
//   - pi makes the LLM call and gets the error response;
//   - bridge forwards pi's raw `message_end` event with the
//     Anthropic error text on `payload.data.message.errorMessage`.
//
// (The bridge's `normalizePiError` is exercised separately by the
// bridge unit tests in packages/bridge/src/__tests__/pi-process.test.ts;
// we don't re-test it here because the wire path doesn't run
// through `normalizePiError` — pi surfaces the SDK error directly
// in `errorMessage` rather than as a `{command, error}` response.)

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  type Envelope as EnvelopeT,
} from '@remotepi/shared';
import {
  makeAgentDir,
  type MakeAgentDirResult,
} from './helpers/make-fixture.js';
import { startFakeLlmServer, type FakeLlmServer } from './helpers/fake-llm-server.js';
import { makeManager, type MakeManagerResult } from './helpers/make-manager.js';
import { waitForEnvelope, waitForPhase } from './helpers/wait-for.js';
import { findCommandResult } from './helpers/assertions.js';

function makePromptEnvelope(content: string): EnvelopeT {
  return {
    v: PROTOCOL_VERSION,
    kind: 'pi',
    type: 'prompt',
    id: randomUUID(),
    payload: { content },
  };
}

describe('03 — Anthropic error response normalises through pi → bridge to {code, message}', () => {
  let fakeServer: FakeLlmServer;
  let fixture: MakeAgentDirResult;
  let mgr: MakeManagerResult;
  let promptEnvelope: EnvelopeT;

  beforeAll(async () => {
    fakeServer = await startFakeLlmServer();
    fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
    mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
    mgr.manager.start();

    // Scripted Anthropic error response. The status 400 + body shape
    // is what the real Anthropic API returns for an invalid request;
    // pi treats it as an LLM-side failure and surfaces `error: string`
    // on its `response` frame.
    fakeServer.script([
      {
        kind: 'error',
        status: 400,
        body: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'messages: max_tokens must be > 0',
          },
        },
      },
    ]);

    promptEnvelope = makePromptEnvelope('trigger the error');
    mgr.manager.handleEnvelope(promptEnvelope);
    // Wait until the bridge settles back into `idle`. The error
    // response from pi still counts as a settled turn (pi emits
    // agent_settled after the failure response), so the idle phase
    // is reachable.
    await waitForPhase(mgr.outbound, 'idle', { timeoutMs: 30_000 });
  }, 30_000);

  afterAll(async () => {
    await mgr.cleanup();
    await fixture.cleanup();
    await fakeServer.close();
  });

  it('fake server received the prompt and returned the 400 error body', () => {
    expect(fakeServer.requests.length).toBeGreaterThan(0);
    const last = fakeServer.requests[fakeServer.requests.length - 1];
    expect(last).toBeDefined();
    expect(last!.body.model).toBe('fake-claude-haiku-4-5');
  });

  it('emits a command_result (success=true, preflight OK) + error event stream from pi', () => {
    // The pi 0.85.1 RPC contract emits the prompt command_result
    // AS SOON AS the preflight passes — the actual LLM round-trip
    // happens afterwards. So the command_result for the prompt
    // envelope is ALWAYS success=true (assuming the preflight
    // validates), even when the LLM itself returns an error. The
    // error surfaces on the EVENT stream (message_end with
    // stopReason='error' + errorMessage set), NOT on a follow-up
    // command_result.
    //
    // The plan for §3 originally expected success=false on
    // command_result; the actual wire shape is success=true
    // (preflight OK) + a downstream error event. We pin both:
    //   (a) command_result.success === true
    //   (b) some downstream event carries the Anthropic error text
    //       (so downstream consumers can render the failure).

    // (a) preflight-level success.
    const result = findCommandResult(mgr.outbound, promptEnvelope.id);
    expect(result).not.toBeNull();
    expect(result!.payload.command).toBe('prompt');
    expect(result!.payload.success).toBe(true);

    // (b) downstream error event. The bridge forwards pi's raw
    //     `message_end` envelope as a `pi/event`. The shape carries
    //     a `message` object (pi's Message shape) which has
    //     `stopReason` and `errorMessage` fields when the turn failed.
    const errorEvents = mgr.outbound.filter(
      (e) => e.kind === 'pi' && e.type === 'event' && e.payload.event === 'message_end',
    );
    expect(errorEvents.length).toBeGreaterThan(0);
    const lastErrorEvent = errorEvents[errorEvents.length - 1];
    if (lastErrorEvent === undefined || lastErrorEvent.type !== 'event') {
      throw new Error('expected event envelope');
    }
    const errorData = lastErrorEvent.payload.data;
    expect(errorData).toBeDefined();
    if (errorData === null || typeof errorData !== 'object') {
      throw new Error('expected message_end event data to be an object');
    }
    // Per pi 0.85.1 (`rpc-mode.js` + `rpc-types.d.ts`), the
    // `message_end` event ALWAYS carries the full message under
    // `data.message` (a `Message` shape with `stopReason` +
    // `errorMessage`). The bridge forwards the event verbatim (see
    // the "Every other event" branch in `pi-process.ts` event
    // forwarder, around L1129 — no reshape) so asserting on
    // `data.message.stopReason` directly catches any regression in
    // pi's wire shape or the bridge's pass-through. We deliberately
    // do NOT fall back to `errorData` itself here: doing so would
    // mask the very kind of wire regression the bridge→pi
    // translation-layer fix (commit 44960b9) was meant to prevent.
    // If `data.message` is missing, the assertion below surfaces a
    // clear diagnostic rather than a false-positive pass.
    const dataObj = errorData as { message?: unknown };
    if (dataObj.message === undefined || dataObj.message === null || typeof dataObj.message !== 'object') {
      throw new Error(
        'expected pi message_end to carry `message` key per pi 0.85.1 event wire; got data=' +
          JSON.stringify(dataObj).slice(0, 200),
      );
    }
    const messageObj = dataObj.message as { stopReason?: unknown; errorMessage?: unknown };
    expect(messageObj.stopReason).toBe('error');
    expect(typeof messageObj.errorMessage).toBe('string');
    expect(messageObj.errorMessage).toContain('max_tokens must be > 0');
  });

  it('emits agent_settled despite the LLM-side failure (the bridge still reaches idle)', async () => {
    // pi emits agent_settled after a failed turn too — the bridge
    // uses that signal to transition to `idle`. Verifying the event
    // forwarder path here pins the contract that downstream consumers
    // always see agent_settled regardless of the turn outcome.
    const settled = await waitForEnvelope(
      mgr.outbound,
      (e) => e.kind === 'pi' && e.type === 'event' && e.payload.event === 'agent_settled',
    );
    expect(settled).toBeDefined();
  });
});
