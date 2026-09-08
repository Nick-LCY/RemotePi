// Smoke test for the integration test infrastructure.
//
// Validates that the four primary building blocks work end-to-end
// before the real test cases commit to them:
//   1. `makeAgentDir` writes a four-file agent-dir fixture
//   2. `startFakeLlmServer` binds to 127.0.0.1:0 and answers /v1/messages
//   3. `makeManager` instantiates a real PiProcessManager that points
//      the spawned `pi` at the fake server via the fixture
//   4. The full chain — fixture → manager → pi → fake server —
//      completes a single prompt round-trip with a text reply.
//
// This test is intentionally a single case so it surfaces the most
// common wiring mistakes (env-var bleed, port-0 not picked up by
// models.json, jiti extension discovery failing, etc.) with one
// failure rather than 5 separate ones.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  Envelope,
  PROTOCOL_VERSION,
  type Envelope as EnvelopeT,
} from '@remotepi/shared';
import {
  makeAgentDir,
  type MakeAgentDirResult,
} from './helpers/make-fixture.js';
import { startFakeLlmServer, textReply, type FakeLlmServer } from './helpers/fake-llm-server.js';
import { makeManager, type MakeManagerResult } from './helpers/make-manager.js';
import { waitForPhase } from './helpers/wait-for.js';
import { sessionStates } from './helpers/assertions.js';

describe('integration smoke (fixtures + fake server + real pi subprocess)', () => {
  let fakeServer: FakeLlmServer;
  let fixture: MakeAgentDirResult;
  let mgr: MakeManagerResult;
  let promptEnvelope: EnvelopeT;

  beforeAll(async () => {
    fakeServer = await startFakeLlmServer();
    fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
    mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
    mgr.manager.start();

    // First prompt: text reply with "hello smoke". We verify the full
    // spawn → handshake → prompt → SSE → idle loop completes.
    fakeServer.script([textReply('hello smoke')]);

    promptEnvelope = {
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: randomUUID(),
      payload: { content: 'say hello smoke' },
    };
    mgr.manager.handleEnvelope(promptEnvelope);
    await waitForPhase(mgr.outbound, 'idle', { timeoutMs: 30_000 });
  }, 30_000);

  afterAll(async () => {
    await mgr.cleanup();
    await fixture.cleanup();
    await fakeServer.close();
  });

  it('completes a single prompt → SSE → idle round-trip', () => {
    // 1. State machine reaches idle (via spawning → ready → running → idle).
    const phases = sessionStates(mgr.outbound);
    expect(phases).toContain('spawning');
    expect(phases).toContain('ready');
    expect(phases).toContain('running');
    expect(phases[phases.length - 1]).toBe('idle');

    // 2. Fake server received the prompt as a POST /v1/messages.
    expect(fakeServer.requests.length).toBeGreaterThan(0);
    const last = fakeServer.requests[fakeServer.requests.length - 1];
    expect(last).toBeDefined();
    expect(last!.body.model).toBe('fake-claude-haiku-4-5');
    expect(Array.isArray(last!.body.messages)).toBe(true);
    const userMsg = (last!.body.messages as Array<{ role?: string }>)[0];
    expect(userMsg?.role).toBe('user');

    // 3. Bridge emitted a command_result whose reply_to matches the
    //    original prompt id.
    const results = mgr.outbound.filter(
      (e) => e.kind === 'pi' && e.type === 'command_result' && e.reply_to === promptEnvelope.id,
    );
    expect(results.length).toBeGreaterThan(0);
    const firstResult = results[0];
    if (firstResult === undefined || firstResult.type !== 'command_result') {
      throw new Error('expected command_result envelope');
    }
    expect(firstResult.payload.success).toBe(true);

    // Sanity: the bridge's outbound stream actually parses as Envelope
    // shapes (catches accidental object spread).
    for (const env of mgr.outbound) {
      const result = Envelope.safeParse(env);
      expect(result.success).toBe(true);
    }
  });
});

// Suppress unused-import warning from `afterEach` (not used here but
// imported by other tests that follow the same pattern).
void afterEach;
