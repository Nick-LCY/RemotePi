// Integration test 04 — extension UI dialogs (see docs/testing.md §2.6).
//
// End-to-end coverage for the 4 blocking extension dialog methods
// (select / confirm / input / editor) plus the cancelled response.
// The fake LLM server scripts a tool_use block that calls
// `trigger_dialog(kind: X)` (declared in
// `tests/integration/fixtures/agent-dir/extensions/test-ext.ts`).
// Pi's extension loader auto-discovers the fixture extension; the
// tool call flows:
//
//   fake server ─► pi (tool_use block) ─► extension trigger_dialog
//     ─► ctx.ui.<method>(...) ─► pi stdout extension_ui_request
//     ─► bridge ExtensionUIRouter ─► session_state.blocked_on
//     ─► test sends extension_ui_response with the real request_id
//     ─► bridge translates to pi native three-state ─► pi stdin
//     ─► extension returns text result ─► tool_execution_end
//     ─► fake server (second turn) ─► "done" text
//
// Each test case asserts:
//   - blocked_on appears with the right method + real request_id
//   - the request_id round-trips: response clears blocked_on
//   - the tool result text contains the expected fragment
//     (e.g. `selected=alpha`, `confirmed=true`, `input=hello`,
//      `editor=final text`)

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  type BlockedOnEntryPayload,
  type Envelope as EnvelopeT,
} from '@remotepi/shared';
import {
  makeAgentDir,
  type MakeAgentDirResult,
} from './helpers/make-fixture.js';
import {
  startFakeLlmServer,
  textReply,
  toolUseReply,
  type FakeLlmServer,
} from './helpers/fake-llm-server.js';
import { makeManager, type MakeManagerResult } from './helpers/make-manager.js';
import {
  waitForBlockedOn,
  waitForBlockedOnCleared,
  waitForPhase,
} from './helpers/wait-for.js';
import { toolExecutionEnds } from './helpers/assertions.js';

function makePromptEnvelope(content: string): EnvelopeT {
  return {
    v: PROTOCOL_VERSION,
    kind: 'pi',
    type: 'prompt',
    id: randomUUID(),
    payload: { content },
  };
}

function makeExtensionUIResponseEnvelope(
  requestId: string,
  payload: { cancelled?: boolean; value?: string | boolean },
): EnvelopeT {
  return {
    v: PROTOCOL_VERSION,
    kind: 'pi',
    type: 'extension_ui_response',
    id: randomUUID(),
    payload: {
      request_id: requestId,
      cancelled: payload.cancelled ?? false,
      ...(payload.value !== undefined ? { value: payload.value } : {}),
    },
  };
}

/**
 * Drive a full prompt → tool_use(blocking dialog) → extension
 * response round-trip. Returns the blocked_on entry as soon as it
 * appears so the caller can grab its `id` (the real pi-assigned
 * request id, NOT anything the test invents).
 */
async function driveDialogRoundTrip(opts: {
  mgr: MakeManagerResult;
  fakeServer: FakeLlmServer;
  promptContent: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  dialogMethod: 'select' | 'confirm' | 'input' | 'editor';
  response: { cancelled?: boolean; value?: string | boolean };
  finalAssistantText?: string;
}): Promise<{ blockedEntry: BlockedOnEntryPayload }> {
  // First scripted response: tool_use block that calls our dialog
  // tool with the requested input. Second scripted response (after
  // the tool result flows back): the final assistant text.
  opts.fakeServer.script([
    toolUseReply({
      toolName: opts.toolName,
      toolId: `toolu_${randomUUID().slice(0, 8)}`,
      input: opts.toolInput,
    }),
    textReply(opts.finalAssistantText ?? 'done'),
  ]);

  opts.mgr.manager.handleEnvelope(makePromptEnvelope(opts.promptContent));
  // Wait for the bridge to surface the blocked_on entry. We do NOT
  // wait for `idle` first because the bridge stays in `running`
  // while the dialog is open (per the ExtensionUIRouter contract).
  const blockedEntry = await waitForBlockedOn(opts.mgr.outbound, opts.dialogMethod, {
    timeoutMs: 30_000,
  });

  // Reply via extension_ui_response, using the REAL request_id
  // from the blocked_on entry (NOT a placeholder).
  opts.mgr.manager.handleEnvelope(
    makeExtensionUIResponseEnvelope(blockedEntry.id, opts.response),
  );
  // Wait for blocked_on to clear (the commit path emits a fresh
  // session_state without the entry).
  await waitForBlockedOnCleared(opts.mgr.outbound, { timeoutMs: 30_000 });
  // Wait for the agent to settle (second tool_use / LLM call).
  await waitForPhase(opts.mgr.outbound, 'idle', { timeoutMs: 30_000 });

  return { blockedEntry };
}
void (null as unknown as BlockedOnEntryPayload); // tsc keep-import-alive

describe('04 — extension UI dialogs (select / confirm / input / editor)', () => {
  describe('4.1 — select dialog', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      mgr.manager.start();

      await driveDialogRoundTrip({
        mgr,
        fakeServer,
        promptContent: 'call select_dialog with options alpha beta',
        toolName: 'trigger_dialog',
        toolInput: { kind: 'select', title: 'Pick one', options: ['alpha', 'beta', 'gamma'] },
        dialogMethod: 'select',
        response: { value: 'beta' },
        finalAssistantText: 'selected beta',
      });
    }, 60_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('tool result text contains "selected=beta"', () => {
      const ends = toolExecutionEnds(mgr.outbound);
      const dialogEnd = ends.find((e) => e.toolName === 'trigger_dialog');
      expect(dialogEnd).toBeDefined();
      expect(dialogEnd!.resultText).toContain('selected=beta');
    });
  });

  describe('4.2 — confirm true', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      mgr.manager.start();

      await driveDialogRoundTrip({
        mgr,
        fakeServer,
        promptContent: 'call confirm_dialog',
        toolName: 'trigger_dialog',
        toolInput: { kind: 'confirm', title: 'Continue?', message: 'Are you sure?' },
        dialogMethod: 'confirm',
        response: { value: true },
        finalAssistantText: 'confirmed yes',
      });
    }, 60_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('tool result text contains "confirmed=true"', () => {
      const ends = toolExecutionEnds(mgr.outbound);
      const dialogEnd = ends.find((e) => e.toolName === 'trigger_dialog');
      expect(dialogEnd).toBeDefined();
      expect(dialogEnd!.resultText).toContain('confirmed=true');
    });
  });

  describe('4.3 — confirm false (boolean "no" path, ADR-0004)', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      mgr.manager.start();

      await driveDialogRoundTrip({
        mgr,
        fakeServer,
        promptContent: 'call confirm_dialog (decline)',
        toolName: 'trigger_dialog',
        toolInput: { kind: 'confirm', title: 'Continue?', message: 'Are you sure?' },
        dialogMethod: 'confirm',
        response: { value: false },
        finalAssistantText: 'confirmed no',
      });
    }, 60_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('tool result text contains "confirmed=false"', () => {
      const ends = toolExecutionEnds(mgr.outbound);
      const dialogEnd = ends.find((e) => e.toolName === 'trigger_dialog');
      expect(dialogEnd).toBeDefined();
      expect(dialogEnd!.resultText).toContain('confirmed=false');
    });
  });

  describe('4.4 — input dialog', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      mgr.manager.start();

      await driveDialogRoundTrip({
        mgr,
        fakeServer,
        promptContent: 'call input_dialog',
        toolName: 'trigger_dialog',
        toolInput: { kind: 'input', title: 'Name?', placeholder: 'Type your name' },
        dialogMethod: 'input',
        response: { value: 'hello world' },
        finalAssistantText: 'got input',
      });
    }, 60_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('tool result text contains "input=hello world"', () => {
      const ends = toolExecutionEnds(mgr.outbound);
      const dialogEnd = ends.find((e) => e.toolName === 'trigger_dialog');
      expect(dialogEnd).toBeDefined();
      expect(dialogEnd!.resultText).toContain('input=hello world');
    });
  });

  describe('4.5 — editor dialog', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      mgr.manager.start();

      await driveDialogRoundTrip({
        mgr,
        fakeServer,
        promptContent: 'call editor_dialog',
        toolName: 'trigger_dialog',
        toolInput: { kind: 'editor', title: 'Edit', prefill: 'start' },
        dialogMethod: 'editor',
        response: { value: 'final text' },
        finalAssistantText: 'edited',
      });
    }, 60_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('tool result text contains "editor=final text"', () => {
      const ends = toolExecutionEnds(mgr.outbound);
      const dialogEnd = ends.find((e) => e.toolName === 'trigger_dialog');
      expect(dialogEnd).toBeDefined();
      expect(dialogEnd!.resultText).toContain('editor=final text');
    });
  });

  describe('4.6 — cancelled response', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      mgr.manager.start();

      await driveDialogRoundTrip({
        mgr,
        fakeServer,
        promptContent: 'call confirm_dialog then cancel',
        toolName: 'trigger_dialog',
        toolInput: { kind: 'confirm', title: 'Continue?', message: 'Are you sure?' },
        dialogMethod: 'confirm',
        response: { cancelled: true },
        finalAssistantText: 'user cancelled',
      });
    }, 60_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('tool result text contains "confirmed=false" (pi maps cancel→false on confirm)', () => {
      // The bridge forwards `{cancelled: true}` as
      // `{id, cancelled: true}` to pi (per `translateToPiNative`).
      // Pi's rpc-mode then resolves the confirm dialog promise with
      // `false` (the `cancel` path → `false`, per `rpc-mode.js:85`).
      // The extension's `execute` then formats
      // `confirmed=${v}` = `confirmed=false`.
      const ends = toolExecutionEnds(mgr.outbound);
      const dialogEnd = ends.find((e) => e.toolName === 'trigger_dialog');
      expect(dialogEnd).toBeDefined();
      expect(dialogEnd!.resultText).toContain('confirmed=false');
    });
  });
});
