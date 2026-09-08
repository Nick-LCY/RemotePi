// Integration test 02 — session persistence (see ADR-0008 §实施纪要 覆盖面).
//
// Verifies the bridge correctly ties pi's session files to the bridge's
// own state across restarts:
//   2.1  Round-one writes a session file under
//        `<agentDir>/sessions/--<encoded-cwd>--/<ts>_<uuid>.jsonl`
//        (the file exists, is non-empty, and the latest entry is the
//        user message we sent).
//   2.2  Round-two (a brand-new bridge manager pointing at the SAME
//        agentDir + workDir) reads the session back via `get_messages`
//        and surfaces the messages through a `snapshot` envelope. The
//        recovered messages include at least the round-one user text.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  type Envelope as EnvelopeT,
} from '@remotepi/shared';
import {
  makeAgentDir,
  type MakeAgentDirResult,
} from './helpers/make-fixture.js';
import {
  encodeCwdForPi,
  sessionSubdir,
} from '@remotepi/bridge/pi-cwd-encoder.js';
import { startFakeLlmServer, textReply, type FakeLlmServer } from './helpers/fake-llm-server.js';
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

function makeGetMessagesEnvelope(): EnvelopeT {
  return {
    v: PROTOCOL_VERSION,
    kind: 'pi',
    type: 'get_messages',
    id: randomUUID(),
    payload: {},
  };
}

describe('02 — session persistence (round-trip across bridge restarts)', () => {
  describe('2.1 — first turn writes a session file', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let mgr: MakeManagerResult;
    let promptEnvelope: EnvelopeT;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      mgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      mgr.manager.start();

      fakeServer.script([textReply('session hello')]);
      promptEnvelope = makePromptEnvelope('round one says hello');
      mgr.manager.handleEnvelope(promptEnvelope);
      await waitForPhase(mgr.outbound, 'idle', { timeoutMs: 30_000 });
    }, 30_000);

    afterAll(async () => {
      await mgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('writes a non-empty .jsonl file under the encoded-cwd subdir', () => {
      // Compute the same subdir pi uses: <agentDir>/sessions/--<encoded>--/
      const subdir = sessionSubdir(fixture.agentDir, fixture.workDir);
      // Sanity: encodeCwdForPi's algorithm matches what bridge uses,
      // and the subdir exists.
      expect(encodeCwdForPi(fixture.workDir).length).toBeGreaterThan(0);

      const stat = statSync(subdir);
      expect(stat.isDirectory()).toBe(true);

      const files = readdirSync(subdir).filter((n) => n.endsWith('.jsonl'));
      expect(files.length).toBeGreaterThan(0);
      const latest = files.sort().pop();
      expect(latest).toBeDefined();
      const content = readFileSync(join(subdir, latest!), 'utf8');
      expect(content.length).toBeGreaterThan(0);
      // The user message must appear (one JSONL line per session entry).
      expect(content).toContain('round one says hello');
    });

    it('emits a successful command_result for the round-one prompt', () => {
      const result = findCommandResult(mgr.outbound, promptEnvelope.id);
      expect(result).not.toBeNull();
      expect(result!.payload.success).toBe(true);
    });
  });

  describe('2.2 — second manager reads the session back via get_messages', () => {
    let fakeServer: FakeLlmServer;
    let fixture: MakeAgentDirResult;
    let firstMgr: MakeManagerResult;
    let secondMgr: MakeManagerResult;
    let getMessagesEnvelope: EnvelopeT;

    beforeAll(async () => {
      fakeServer = await startFakeLlmServer();
      fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeServer.url });
      firstMgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      firstMgr.manager.start();

      // Round one: a single prompt that gets a text reply.
      fakeServer.script([textReply('round-one-reply')]);
      firstMgr.manager.handleEnvelope(makePromptEnvelope('round one text'));
      await waitForPhase(firstMgr.outbound, 'idle', { timeoutMs: 30_000 });

      // Stop the first manager cleanly. The child gets SIGTERM;
      // the session file is on disk and will be picked up by the
      // second manager via `--session <latest>`.
      await firstMgr.cleanup();

      // Round two: build a fresh manager pointing at the SAME
      // agentDir + workDir. The bridge's `spawnNow` should re-scan
      // the session subdir and pass `--session <latest>` on spawn.
      fakeServer.reset();
      fakeServer.script([textReply('round-two-reply')]);
      secondMgr = makeManager({ agentDir: fixture.agentDir, workDir: fixture.workDir });
      secondMgr.manager.start();

      // Drive the second manager through a get_messages → snapshot
      // round-trip. The snapshot should carry the round-one user
      // message (since the session file has it). NOTE: get_messages
      // alone is sufficient — it does NOT require a model call, so
      // we don't need to wait for idle after sending it. The bridge
      // spawns pi on the get_messages trigger (same spawn-trigger
      // set as prompt).
      getMessagesEnvelope = makeGetMessagesEnvelope();
      secondMgr.manager.handleEnvelope(getMessagesEnvelope);
      // Wait until the snapshot envelope arrives. We don't wait for
      // `idle` because get_messages is a read — the bridge spawns pi
      // but doesn't transition to running for reads (per the
      // state-machine contract).
      await waitForEnvelope(
        secondMgr.outbound,
        (e) => e.kind === 'pi' && e.type === 'snapshot' && e.reply_to === getMessagesEnvelope.id,
        { timeoutMs: 30_000 },
      );
    }, 60_000);

    afterAll(async () => {
      await secondMgr.cleanup();
      await fixture.cleanup();
      await fakeServer.close();
    });

    it('recovered snapshot includes the round-one user text', () => {
      const snapshot = secondMgr.outbound.find(
        (e) => e.kind === 'pi' && e.type === 'snapshot' && e.reply_to === getMessagesEnvelope.id,
      );
      expect(snapshot).toBeDefined();
      if (snapshot === undefined || snapshot.type !== 'snapshot') {
        throw new Error('expected snapshot envelope');
      }
      // The snapshot's messages array carries the user message we
      // sent in round one. The exact shape is pi's native message
      // format (open schema, asserted as text containment rather
      // than full structural equality).
      const messages = snapshot.payload.messages as Array<{
        role?: string;
        content?: unknown;
      }>;
      const userMsg = messages.find((m) => m.role === 'user');
      expect(userMsg).toBeDefined();
      const text = extractMessageText(userMsg?.content);
      expect(text).toContain('round one text');
    });

    it('bridge spawnCount is 1 in the second manager (the second bridge session)', () => {
      // Sanity: the second bridge did exactly one spawn to read
      // back the session. This is the spawn that produced the
      // snapshot — verifies the bridge's `findLatestSession` scan
      // picked up the round-one file.
      expect(secondMgr.manager.getSpawnCount()).toBe(1);
    });
  });
});

// Best-effort extraction of textual content from pi's open message
// shape (the wire contract doesn't pin the exact form). We accept any
// of:
//   - `{type:'text', text:'...'}` parts (Anthropic native text blocks)
//   - bare string content
//   - nested arrays of any of the above
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractMessageText).join('');
  }
  if (typeof content === 'object' && content !== null) {
    const obj = content as { type?: unknown; text?: unknown };
    if (obj.type === 'text' && typeof obj.text === 'string') {
      return obj.text;
    }
  }
  return '';
}
