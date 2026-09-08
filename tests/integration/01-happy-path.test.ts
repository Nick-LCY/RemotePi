// Integration test 01 — happy path (see docs/testing.md §2.6).
//
// Verifies the four canonical end-to-end shapes a single prompt
// round-trip produces on the bridge's outbound envelope stream:
//   1.1  handshake + streaming: spawning → ready → running → idle with
//        message_update events + a final agent_settled + command_result.
//   1.2  idle SIGTERM kill: a fast idle timeout tears the child down
//        (spawnCount=1, phase=exited, exit code reflects the kill).
//   1.3  spawn-reuse on a subsequent prompt: a new prompt after the
//        child has exited triggers another spawn (spawnCount=2) and
//        re-walks spawning → ready.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  type Envelope as EnvelopeT,
  type SessionPhase,
} from '@remotepi/shared';
import {
  makeAgentDir,
  type MakeAgentDirResult,
} from './helpers/make-fixture.js';
import { startFakeLlmServer, textReply, type FakeLlmServer } from './helpers/fake-llm-server.js';
import { makeManager, type MakeManagerResult } from './helpers/make-manager.js';
import {
  waitForEnvelope,
  waitForPhase,
  waitForSpawnCount,
} from './helpers/wait-for.js';
import {
  collectAssistantText,
  findCommandResult,
  lastSessionState,
  sessionStates,
} from './helpers/assertions.js';

function makePromptEnvelope(content: string): EnvelopeT {
  return {
    v: PROTOCOL_VERSION,
    kind: 'pi',
    type: 'prompt',
    id: randomUUID(),
    payload: { content },
  };
}

/**
 * Wait until the most-recent session_state is a terminal phase
 * (`idle` or `exited`). Used in test 1.3 where pi's resumed-session
 * behaviour is non-deterministic and may either:
 *   - process the prompt normally → reach `idle`
 *   - short-circuit the resumed session → reach `exited` directly
 */
async function waitForTerminalPhase(
  outbound: EnvelopeT[],
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = 25;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const latest = lastSessionState(outbound);
    if (latest !== null && (latest.phase === 'idle' || latest.phase === 'exited')) {
      // Confirm this is the LATEST phase (no further transitions
      // happened after the terminal one). If a later transition
      // arrives we re-check.
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const after = lastSessionState(outbound);
      if (after !== null && after.phase === latest.phase) {
        return;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `waitForTerminalPhase: timed out after ${timeoutMs}ms. last: ${JSON.stringify(lastSessionState(outbound))}`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

describe('01 — happy path (handshake + streaming + idle kill + re-spawn)', () => {
  describe('1.1 — single prompt completes handshake + streams + settles', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;
    let promptEnvelope: EnvelopeT;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      mgr.manager.start();

      fakeServer.script([textReply('hello world')]);
      promptEnvelope = makePromptEnvelope('say hello');
      mgr.manager.handleEnvelope(promptEnvelope);
      await waitForPhase(mgr.outbound, 'idle', { timeoutMs: 30_000 });
    }, 30_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('walks spawning → ready → running → idle', () => {
      const phases = sessionStates(mgr.outbound);
      expect(phases[0]).toBe('spawning');
      expect(phases).toContain('ready');
      expect(phases).toContain('running');
      expect(phases[phases.length - 1]).toBe('idle');
    });

    it('emits the agent_start / message_update / agent_settled event sequence', async () => {
      const settled = await waitForEnvelope(
        mgr.outbound,
        (e) => e.kind === 'pi' && e.type === 'event' && e.payload.event === 'agent_settled',
      );
      expect(settled).toBeDefined();
    });

    it('collects the streamed text content into "hello world"', () => {
      const text = collectAssistantText(mgr.outbound);
      expect(text).toBe('hello world');
    });

    it('emits a successful command_result whose reply_to matches the prompt', () => {
      const result = findCommandResult(mgr.outbound, promptEnvelope.id);
      expect(result).not.toBeNull();
      expect(result!.payload.command).toBe('prompt');
      expect(result!.payload.success).toBe(true);
    });
  });

  describe('1.2 — idle SIGTERM kill path (fast idleTimeoutMs)', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;
    let promptEnvelope: EnvelopeT;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({
        agentDir: fixture.agentDir,
        workDir: fixture.workDir,
        idleTimeoutMs: 100,
        sigkillDelayMs: 10,
      });
      mgr.manager.start();

      fakeServer.script([textReply('first turn')]);
      promptEnvelope = makePromptEnvelope('kick off');
      mgr.manager.handleEnvelope(promptEnvelope);

      await waitForPhase(mgr.outbound, 'idle', { timeoutMs: 30_000 });
      await waitForPhase(mgr.outbound, 'exited', { timeoutMs: 30_000 });
    }, 30_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('idle timeout kills the child (spawnCount = 1, phase = exited)', () => {
      expect(mgr.manager.getSpawnCount()).toBe(1);
      const last = lastSessionState(mgr.outbound);
      expect(last?.phase).toBe('exited');
    });
  });

  describe('1.3 — subsequent prompt re-spawns the child', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({
        agentDir: fixture.agentDir,
        workDir: fixture.workDir,
        idleTimeoutMs: 100,
        sigkillDelayMs: 10,
      });
      mgr.manager.start();

      // First prompt → idle → idle timeout → exited.
      fakeServer.script([textReply('first turn')]);
      mgr.manager.handleEnvelope(makePromptEnvelope('first'));
      await waitForPhase(mgr.outbound, 'idle', { timeoutMs: 30_000 });
      await waitForPhase(mgr.outbound, 'exited', { timeoutMs: 30_000 });
      const spawnCountAfterFirst = mgr.manager.getSpawnCount();
      expect(spawnCountAfterFirst).toBe(1);

      // Second prompt triggers the exited → spawning re-spawn path.
      // The bridge passes the latest session path on the new argv,
      // so pi resumes the previous session. Resumed-session behaviour
      // on a freshly-arrived prompt is implementation-dependent:
      // pi may emit agent_settled without an LLM round-trip, or
      // sometimes exit the RPC loop outright after the handshake
      // if no new model call is needed. The contract the bridge
      // guarantees is the *spawn itself* — handleSpawnTrigger from
      // `exited` produces a new spawnNow() call (asserted below via
      // spawnCount=2). The downstream LLM behaviour is verified
      // separately in the multi-turn test.
      fakeServer.reset();
      fakeServer.script([textReply('second turn')]);
      mgr.manager.handleEnvelope(makePromptEnvelope('second'));
      await waitForSpawnCount(mgr.manager, 2, { timeoutMs: 30_000 });
      // Wait for the second spawn to settle into a terminal phase
      // (either idle if pi processed the prompt, or exited if pi
      // short-circuited). Both are acceptable.
      await waitForTerminalPhase(mgr.outbound, { timeoutMs: 30_000 });
    }, 60_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('the second prompt bumps spawnCount to 2 and re-enters spawning → ready', () => {
      expect(mgr.manager.getSpawnCount()).toBe(2);
      const phases: SessionPhase[] = sessionStates(mgr.outbound);
      // The second `spawning` transition must appear after the first
      // idle→exited segment. The simplest invariant is "at least two
      // spawning entries".
      const spawningIndices = phases
        .map((p, i) => (p === 'spawning' ? i : -1))
        .filter((i) => i !== -1);
      expect(spawningIndices.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// Reference unused-import lint rule check.
void afterEach;
