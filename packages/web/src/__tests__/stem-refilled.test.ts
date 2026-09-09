// Vitest specs for the stem-refilled watcher extracted from App.tsx
// (M4 task 08 review 修复轮 W8 — see `ws/stem-refilled.ts`).
//
// Surface under test:
//   - session_state{session:<stem>} when URL is in 'new' state →
//     hash refill (selectSessionHash) + sendSessionList fire.
//   - session_state{session:'new'} / session_state{session:undefined}
//     / session_state{session:'m3-legacy'} → no fire (defensive).
//   - URL session flipped to non-'new' → unsub registered listener
//     no longer fires (effect-cleanup contract).
//   - work_dir mismatch (broadcast work_dir ≠ URL work_dir) → no
//     fire (defensive — bridge pending 流必同 work_dir)。

import { PROTOCOL_VERSION, type Envelope, type SessionListEntry } from '@remotepi/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { WsClient } from '../ws/WsClient.js';
import { watchStemRefilled } from '../ws/stem-refilled.js';

// ---------------------------------------------------------------------------
// FakeWs + simulateInbound (mirrors web-state-bucket.test.ts shape)
// ---------------------------------------------------------------------------

class FakeWs {
  static readonly OPEN = 1;
  readyState = FakeWs.OPEN;
  readonly sentFrames: Envelope[] = [];
  send(data: string): void {
    this.sentFrames.push(JSON.parse(data) as Envelope);
  }
  close(): void {
    /* no-op */
  }
  addEventListener(): void {
    /* no-op */
  }
  removeEventListener(): void {
    /* no-op */
  }
}

// Helper: record all hash writes the watcher performs (test env
// doesn't have `window` — see choice-page-flow.test.ts comment on
// the intentional no-jsdom policy + ADR-0009 §决策 4).
interface HashRecorder {
  writes: string[];
  writeHash: (hash: string) => void;
}
function makeHashRecorder(): HashRecorder {
  const rec: HashRecorder = { writes: [], writeHash: () => undefined };
  rec.writeHash = (hash: string) => {
    rec.writes.push(hash);
  };
  return rec;
}

function makeConnectedWs(): { ws: WsClient; fake: FakeWs; sentFrames: () => Envelope[] } {
  const original = globalThis.WebSocket;
  const fake = new FakeWs();
  function StubWebSocket(this: unknown) {
    return fake;
  }
  StubWebSocket.OPEN = FakeWs.OPEN;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = StubWebSocket;
  const ws = new WsClient('ws://test/web');
  ws.connect('tok');
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = original;
  return { ws, fake, sentFrames: () => fake.sentFrames.slice() };
}

function simulateInbound(ws: WsClient, envelope: Envelope, fake: FakeWs): void {
  const handleMessage = (ws as unknown as {
    handleMessage: (event: MessageEvent) => void;
  }).handleMessage;
  const messageEvent = {
    data: JSON.stringify(envelope),
    target: fake,
  } as unknown as MessageEvent;
  handleMessage(messageEvent);
}

function sessionState(
  session: string | undefined,
  phase: 'spawning' | 'ready' | 'running' | 'idle' | 'exited',
  workDir?: string,
): Envelope {
  const payload: { phase: typeof phase; work_dir?: string } = { phase };
  if (workDir !== undefined) payload.work_dir = workDir;
  return {
    v: PROTOCOL_VERSION,
    kind: 'control',
    type: 'session_state',
    id: 's-' + Math.random().toString(36).slice(2, 10),
    ...(session !== undefined ? { session } : {}),
    payload,
  };
}

// ---------------------------------------------------------------------------
// W8 — useStemRefilledWatcher 单元测试
// ---------------------------------------------------------------------------

describe('watchStemRefilled — W8 (review 修复轮)', () => {
  afterEach(() => {
    // No-op: tests use injected writeHash recorder (no window).
  });

  it('W8.1 session_state{session:<stem>} fires hash refill + sendSessionList', () => {
    const { ws, fake, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');

    // Install watcher in the 'new' state — observer pattern mirrors
    // App.tsx useEffect (gate: auth.session === 'new').
    const rec = makeHashRecorder();
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: rec.writeHash,
    });

    expect(rec.writes).toEqual([]); // gate entered → no write yet

    // Simulate bridge stem-derivation broadcast.
    simulateInbound(ws, sessionState('realStem-abc', 'ready', '/home/me'), fake);

    expect(rec.writes).toHaveLength(1);
    const writtenHash = rec.writes[0]!;
    expect(writtenHash).toContain('session=realStem-abc');
    expect(writtenHash).toContain('work_dir=');
    expect(decodeURIComponent(writtenHash)).toContain('/home/me');

    // sendSessionList fired (钉子 5 — stem 回填后重查).
    const frames = sentFrames();
    const sessionListFrame = frames.find((f) => f.type === 'session_list');
    expect(sessionListFrame).toBeDefined();
    expect((sessionListFrame!.payload as { work_dir: string }).work_dir).toBe('/home/me');

    unsub();
  });

  it('W8.2 session_state{session:"new"} does NOT fire (still pending — skip)', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');

    const rec = makeHashRecorder();
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: rec.writeHash,
    });

    simulateInbound(ws, sessionState('new', 'spawning', '/home/me'), fake);
    // Still pending — no hash write fired.
    expect(rec.writes).toEqual([]);

    unsub();
  });

  it('W8.3 session_state{session:"m3-legacy"} does NOT fire (never point URL at M3-compat bucket)', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');

    const rec = makeHashRecorder();
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: rec.writeHash,
    });

    simulateInbound(ws, sessionState('m3-legacy', 'ready', '/home/me'), fake);
    expect(rec.writes).toEqual([]);

    unsub();
  });

  it('W8.4 URL session flipped to non-"new" — listener auto-detached (subsequent broadcast is no-op)', () => {
    // Mimics the React useEffect lifecycle: deps change → cleanup
    // unsub → fresh attach with new gate value.
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const rec = makeHashRecorder();

    // Stage 1: attach in 'new' state.
    const unsub1 = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: rec.writeHash,
    });

    // User navigates away — cleanup old unsub; attach fresh in
    // non-'new' state (returns no-op unsub).
    unsub1();
    const unsub2 = watchStemRefilled(ws, {
      currentSession: 'realStem-abc',
      workDir: '/home/me',
      token: 'tok',
      writeHash: rec.writeHash,
    });

    // Stem-derivation broadcast lands (would have fired in stage 1).
    simulateInbound(ws, sessionState('newer-stem', 'ready', '/home/me'), fake);
    // Listener detached — rec.writes still empty (stage 1 unsub
    // removed the listener; stage 2 attached a no-op).
    expect(rec.writes).toEqual([]);

    unsub2();
  });

  it('W8.5 work_dir mismatch does NOT fire (defensive — pending manager and broadcast are guaranteed same)', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');

    const rec = makeHashRecorder();
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: rec.writeHash,
    });

    simulateInbound(ws, sessionState('realStem-abc', 'ready', '/other'), fake);
    expect(rec.writes).toEqual([]);

    unsub();
  });

  it('W8.6 session_state without work_dir payload does NOT fire (defensive — hash would be ambiguous)', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');

    const rec = makeHashRecorder();
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: rec.writeHash,
    });

    simulateInbound(ws, sessionState('realStem-abc', 'ready'), fake); // no work_dir
    expect(rec.writes).toEqual([]);

    unsub();
  });

  // M4 task 08 review 修复轮 W8.10 — the bridge's outbound wrapper
  // forwards the pending manager's FIRST session_state (before the
  // jsonl is on disk, so the migration broadcast can't fire yet)
  // with `envelope.session === 'new:<work_dir>'` — the bridge's
  // internal pending-key map key (task 06 §钉子 2). Without this
  // filter, the watcher would treat it as a real stem and refilled
  // the hash with `&session=new:<work_dir>` — the bridge then sees
  // the recovery ceremony's `get_state` / `get_messages` carrying
  // `session: 'new:<work_dir>'` and rejects them (no such jsonl).
  it('W8.10 session_state{session:"new:<work_dir>"} (pending-key format) does NOT fire', () => {
    const { ws, fake, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');

    const rec = makeHashRecorder();
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: rec.writeHash,
    });

    // The bridge forwards the pending manager's session_state with
    // the literal pending key (e.g. `new:/home/me`) before the
    // migration broadcast carries the real stem.
    simulateInbound(ws, sessionState('new:/home/me', 'spawning', '/home/me'), fake);
    // Watcher must NOT treat the pending key as a real stem.
    expect(rec.writes).toEqual([]);
    // No sendSessionList fire either (钉子 5 trigger is on a real
    // stem only — firing on a pending key would have ChoicePage
    // re-query with a meaningless work_dir bucket association).
    const sessionListFrame = sentFrames().find((f) => f.type === 'session_list');
    expect(sessionListFrame).toBeUndefined();

    // The NEXT broadcast (migration → real stem) should still
    // fire normally — the filter only excludes the pending key,
    // not all session_states.
    simulateInbound(ws, sessionState('realStem-abc', 'ready', '/home/me'), fake);
    expect(rec.writes).toHaveLength(1);
    expect(rec.writes[0]!).toContain('session=realStem-abc');

    unsub();
  });

  it('W8.7 unsub is idempotent (StrictMode double-invoke safe)', () => {
    const { ws } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const rec = makeHashRecorder();
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: rec.writeHash,
    });
    unsub();
    // Second call: must not throw (would surface a warning if the
    // underlying `wsClient.on` unsub was called twice).
    expect(() => unsub()).not.toThrow();
  });

  it('W8.8 gated: currentSession !== "new" attaches NO listener (no-op unsub returned)', () => {
    const { ws, fake, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');

    // Gate off — user already past 'new'.
    const rec = makeHashRecorder();
    const unsub = watchStemRefilled(ws, {
      currentSession: 'some-real-stem',
      workDir: '/home/me',
      token: 'tok',
      writeHash: rec.writeHash,
    });

    const before = sentFrames().length;
    simulateInbound(ws, sessionState('whatever-stem', 'ready', '/home/me'), fake);
    // No listener → no outbound sendSessionList.
    expect(sentFrames().length).toBe(before);
    // Hash unchanged.
    expect(rec.writes).toEqual([]);

    unsub();
  });

  // Sanity: SessionListEntry import doesn't trip lint — used
  // implicitly via WsClient.bucketFor fixtures elsewhere.
  it('W8.9 type-only import kept for forward-compat (SessionListEntry use in fixtures)', () => {
    const entries: SessionListEntry[] = [];
    expect(entries).toEqual([]);
  });
});
