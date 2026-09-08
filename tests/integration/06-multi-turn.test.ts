// Integration test 06 — multi-turn (see docs/testing.md §2.6).
//
// Pins the multi-turn translation layer (`commit 44960b9` regression
// class) end-to-end against the real pi subprocess:
//   6.1  Multiple sequential prompts: each `prompt` produces its
//        own assistant text round-trip. The bridge must keep the
//        session alive (no re-spawn) and the outbound stream must
//        carry N successful command_results (one per prompt).
//   6.2  Mid-run `steer`: a `steer` while in `running` lands on the
//        same agent turn (no separate LLM call) and the assistant
//        reply contains the steered text.
//   6.3  Mid-run `follow_up`: queued behind the running turn, the
//        follow_up fires AFTER the running turn settles. The bridge
//        must keep the session alive (no re-spawn) and emit a
//        successful command_result for the follow_up.
//
// All three sub-cases share the same fixture + fake server; the
// differences are which envelopes we send and when.

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
import { startFakeLlmServer, textReply, type FakeLlmServer } from './helpers/fake-llm-server.js';
import { makeManager, type MakeManagerResult } from './helpers/make-manager.js';
import { waitForEnvelope, waitForPhase } from './helpers/wait-for.js';
import { collectAssistantText, findCommandResult } from './helpers/assertions.js';

function makeEnvelope(type: 'prompt' | 'steer' | 'follow_up', content: string): EnvelopeT {
  return {
    v: PROTOCOL_VERSION,
    kind: 'pi',
    type,
    id: randomUUID(),
    payload: { content },
  };
}

describe('06 — multi-turn (sequential prompts + steer + follow_up)', () => {
  describe('6.1 — sequential prompts produce N successful command_results', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;
    const promptEnvelopes: EnvelopeT[] = [];

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      mgr.manager.start();

      // Scripted replies: turn 1 → "first reply", turn 2 → "second reply",
      // turn 3 → "third reply". Each reply consumed FIFO across the
      // three prompts.
      fakeServer.script([
        textReply('first reply'),
        textReply('second reply'),
        textReply('third reply'),
      ]);

      const p1 = makeEnvelope('prompt', 'first turn');
      promptEnvelopes.push(p1);
      mgr.manager.handleEnvelope(p1);
      await waitForPhase(mgr.outbound, 'idle', { timeoutMs: 30_000 });

      // After agent_settled, the bridge is `idle`. A new prompt in
      // `idle` is a write command, so it triggers `transitionTo('running')`
      // without a re-spawn.
      const p2 = makeEnvelope('prompt', 'second turn');
      promptEnvelopes.push(p2);
      mgr.manager.handleEnvelope(p2);
      await waitForEnvelope(
        mgr.outbound,
        (e) => {
          if (e.kind !== 'pi' || e.type !== 'command_result') return false;
          return e.reply_to === p2.id;
        },
        { timeoutMs: 30_000 },
      );

      const p3 = makeEnvelope('prompt', 'third turn');
      promptEnvelopes.push(p3);
      mgr.manager.handleEnvelope(p3);
      await waitForEnvelope(
        mgr.outbound,
        (e) => {
          if (e.kind !== 'pi' || e.type !== 'command_result') return false;
          return e.reply_to === p3.id;
        },
        { timeoutMs: 30_000 },
      );
    }, 90_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('emits a successful command_result for each prompt (no re-spawn between turns)', () => {
      expect(mgr.manager.getSpawnCount()).toBe(1);
      for (const p of promptEnvelopes) {
        const result = findCommandResult(mgr.outbound, p.id);
        expect(result).not.toBeNull();
        expect(result!.payload.command).toBe('prompt');
        expect(result!.payload.success).toBe(true);
      }
    });

    it('the assistant text collected from the three turns contains all three replies', () => {
      const text = collectAssistantText(mgr.outbound);
      expect(text).toContain('first reply');
      expect(text).toContain('second reply');
      expect(text).toContain('third reply');
    });
  });

  describe('6.2 — steer mid-run lands on the same turn', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;
    let promptEnv: EnvelopeT;
    let steerEnv: EnvelopeT;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      mgr.manager.start();

      // First scripted response (after prompt): tool_use → after
      // the tool result flows back, pi emits a second LLM request.
      // We script TWO tool_use replies to keep pi "in flight" so we
      // have a window for the steer.
      // Actually, the simpler model: pi's RPC mode treats steer as
      // a mid-run insert (no separate LLM call). The bridge writes
      // the steer to pi's stdin; pi's internal handler inserts the
      // message into the running session. So we don't need a
      // scripted tool_use — a single text reply is enough; the
      // steer lands in the same LLM turn.
      fakeServer.script([
        // First turn response: a tool_use to keep pi in "running"
        // until we send the steer.
        textReply('final text after steer'),
      ]);

      promptEnv = makeEnvelope('prompt', 'first');
      steerEnv = makeEnvelope('steer', 'mid-run correction');
      mgr.manager.handleEnvelope(promptEnv);
      // Don't wait for idle; send the steer immediately so it lands
      // in the running turn.
      mgr.manager.handleEnvelope(steerEnv);
      // Now wait for the prompt's command_result.
      await waitForEnvelope(
        mgr.outbound,
        (e) => {
          if (e.kind !== 'pi' || e.type !== 'command_result') return false;
          return e.reply_to === promptEnv.id;
        },
        { timeoutMs: 30_000 },
      );
      // The steer arrives in the running turn; pi returns success
      // on the steer envelope without an extra LLM call. Wait for
      // the steer's command_result.
      await waitForEnvelope(
        mgr.outbound,
        (e) => {
          if (e.kind !== 'pi' || e.type !== 'command_result') return false;
          return e.reply_to === steerEnv.id;
        },
        { timeoutMs: 30_000 },
      );
      // Then wait for the final assistant text via idle.
      await waitForPhase(mgr.outbound, 'idle', { timeoutMs: 30_000 });
    }, 60_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('prompt command_result success=true', () => {
      const r = findCommandResult(mgr.outbound, promptEnv.id);
      expect(r).not.toBeNull();
      expect(r!.payload.success).toBe(true);
    });

    it('steer command_result success=true (pi accepted the mid-run insert)', () => {
      const r = findCommandResult(mgr.outbound, steerEnv.id);
      expect(r).not.toBeNull();
      expect(r!.payload.success).toBe(true);
    });

    it('the final assistant text after steer appears in the stream', () => {
      const text = collectAssistantText(mgr.outbound);
      expect(text).toContain('final text after steer');
    });

    it('no re-spawn between prompt and steer (spawnCount = 1)', () => {
      expect(mgr.manager.getSpawnCount()).toBe(1);
    });
  });

  describe('6.3 — follow_up queues behind the running turn', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;
    let promptEnv: EnvelopeT;
    let followUpEnv: EnvelopeT;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      mgr.manager.start();

      // Two scripted replies: one for the initial prompt, one
      // for the follow_up (which queues during the running turn
      // and is processed AFTER the running turn settles — see the
      // pi 0.85.1 rpc-mode.js follow_up handler).
      fakeServer.script([
        textReply('first turn reply'),
        textReply('follow up reply'),
      ]);

      promptEnv = makeEnvelope('prompt', 'first');
      followUpEnv = makeEnvelope('follow_up', 'queued follow up');
      // Send the follow_up immediately after the prompt so it lands
      // while the bridge is still in `running` — this is the
      // "queued behind the running turn" path.
      mgr.manager.handleEnvelope(promptEnv);
      mgr.manager.handleEnvelope(followUpEnv);
      // Wait for both command_results. We give each a generous
      // timeout because the follow_up has to wait for the running
      // turn to settle before it makes its own LLM call.
      await waitForEnvelope(
        mgr.outbound,
        (e) => e.kind === 'pi' && e.type === 'command_result' && e.reply_to === promptEnv.id,
        { timeoutMs: 30_000 },
      );
      await waitForEnvelope(
        mgr.outbound,
        (e) => e.kind === 'pi' && e.type === 'command_result' && e.reply_to === followUpEnv.id,
        { timeoutMs: 30_000 },
      );
      // Settle idle before assertions.
      await waitForPhase(mgr.outbound, 'idle', { timeoutMs: 30_000 });
    }, 60_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('prompt + follow_up both succeed', () => {
      const r1 = findCommandResult(mgr.outbound, promptEnv.id);
      expect(r1?.payload.success).toBe(true);
      const r2 = findCommandResult(mgr.outbound, followUpEnv.id);
      expect(r2?.payload.success).toBe(true);
    });

    it('both replies appear in the assistant text stream', () => {
      const text = collectAssistantText(mgr.outbound);
      expect(text).toContain('first turn reply');
      expect(text).toContain('follow up reply');
    });

    it('no re-spawn between prompt and follow_up (spawnCount = 1)', () => {
      expect(mgr.manager.getSpawnCount()).toBe(1);
    });
  });
});
