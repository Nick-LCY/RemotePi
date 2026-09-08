// Vitest specs for the M4 WsClient outbound commands + inbound routing
// added in tasks/m4/07 (钉子 1 / 钉子 5 / 钉子 6 + ChoicePage + DirectoryBrowser
// wiring).
//
// Surface under test:
//   - Outbound command shape: `sendListDirectories`, `sendWorkDirList`,
//     `sendWorkDirAdd`, `sendWorkDirRemove`, `sendSessionList` —
//     assert the wire shape matches the M4 protocol.
//   - Inbound `control/result` decoding: work_dir_list → `_workDirs`
//     mirror; list_directories → transient `listDirResults` cache;
//     session_list → `_sessionList` mirror; failures cached in
//     `workDirResults` so callers awaiting a specific id can render
//     errors.
//   - `setCurrentWorkDir` mirrors the hash's work_dir so outbound
//     commands (and the eventual task-08 per-session store) can read
//     it off the store without re-parsing the URL.
//
// Strategy: build a `FakeSocket` that captures `WebSocket.send()` and
// exposes a `simulateEnvelope(envelope)` helper to drive the inbound
// dispatch path. Mirrors the recovery.test.ts FakeWsClient shape so
// reviewers can navigate by section heading.

import { PROTOCOL_VERSION, type Envelope, type SessionListEntry } from '@remotepi/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WsClient } from '../ws/WsClient.js';

// ---------------------------------------------------------------------------
// FakeWs — minimal WebSocket-shaped test double for the WsClient
// ---------------------------------------------------------------------------

/** Captures every `send()` call and lets tests drive inbound dispatch
 *  via `simulateEnvelope`. The WsClient only ever reads
 *  `readyState === OPEN` from a real socket; we hard-code OPEN here
 *  so the outbound `sendRaw()` path goes through and the frame lands
 *  in `sentFrames`. */
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

/** Construct a WsClient backed by a fake socket, simulate `connect()`
 *  by manually wiring up the open handler and stamp the open
 *  transition. The WsClient creates its own real WebSocket inside
 *  `openSocket()`, so we wrap it to capture the constructed instance
 *  and replace the WebSocket constructor globally. */
function makeConnectedWs(): { ws: WsClient; fake: FakeWs; sentFrames: () => Envelope[] } {
  const original = globalThis.WebSocket;
  const fake = new FakeWs();
  // StubWebSocket is a constructor function that ignores `new` and
  // returns the same FakeWs instance — so `this.socket` inside the
  // WsClient points at `fake`, and any `event.target` we pass must
  // also be `fake` to satisfy the stale-socket guard in
  // `handleMessage`.
  function StubWebSocket(this: unknown, _url: string, _protocols?: string | string[]) {
    return fake;
  }
  StubWebSocket.OPEN = FakeWs.OPEN;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = StubWebSocket;
  const ws = new WsClient('ws://test/web');
  ws.connect('tok');
  // Restore WebSocket to the original (in case a test wants to do
  // its own setup later).
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = original;
  // The WsClient's open handler ran synchronously inside `connect()`;
  // the fake's send is wired through our StubWebSocket. Pull the
  // captured frames off the fake.
  return {
    ws,
    fake,
    sentFrames: () => fake.sentFrames.slice(),
  };
}

/** Drive `ws.handleMessage` directly — bypasses the WS event loop so
 *  tests can feed an inbound envelope and observe the store mutation
 *  in the same tick. The `target` field must be the same FakeWs
 *  instance the WsClient holds in `this.socket`; otherwise the
 *  `isCurrentSocket()` guard discards the frame as stale. The cast
 *  is needed because `handleMessage` is a private arrow field —
 *  production code never reaches it (the real WebSocket event loop
 *  does), but the test needs to drive the inbound path without
 *  spinning up a real socket. */
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

function controlResult(
  replyTo: string,
  data: unknown,
  ok: boolean,
  error?: { code: 'auth_failed' | 'duplicate_bridge' | 'invalid_envelope' | 'unsupported_version' | 'unsupported_type' | 'internal'; message: string },
): Envelope {
  const payload: { ok: boolean; data?: unknown; error?: { code: 'auth_failed' | 'duplicate_bridge' | 'invalid_envelope' | 'unsupported_version' | 'unsupported_type' | 'internal'; message: string } } = {
    ok,
  };
  if (data !== undefined) payload.data = data;
  if (error !== undefined) payload.error = error;
  return {
    v: PROTOCOL_VERSION,
    kind: 'control',
    type: 'result',
    id: 'res-' + Math.random().toString(36).slice(2, 10),
    reply_to: replyTo,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Outbound command wire shape
// ---------------------------------------------------------------------------

describe('WsClient M4 outbound — wire shape (tasks/m4/07)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('1.1 sendListDirectories (no path) → control/list_directories with empty payload', () => {
    const { ws, sentFrames } = makeConnectedWs();
    const before = sentFrames().length;
    ws.sendListDirectories();
    const newFrames = sentFrames().slice(before);
    expect(newFrames).toHaveLength(1);
    const frame = newFrames[0]!;
    expect(frame.kind).toBe('control');
    expect(frame.type).toBe('list_directories');
    expect(frame.payload).toEqual({});
  });

  it('1.2 sendListDirectories(path) → payload carries the path', () => {
    const { ws, sentFrames } = makeConnectedWs();
    const before = sentFrames().length;
    ws.sendListDirectories('/home/me');
    const newFrames = sentFrames().slice(before);
    expect(newFrames[0]!.payload).toEqual({ path: '/home/me' });
  });

  it('1.3 sendWorkDirList → control/work_dir_list with empty payload', () => {
    const { ws, sentFrames } = makeConnectedWs();
    const before = sentFrames().length;
    ws.sendWorkDirList();
    const newFrames = sentFrames().slice(before);
    expect(newFrames[0]!.kind).toBe('control');
    expect(newFrames[0]!.type).toBe('work_dir_list');
    expect(newFrames[0]!.payload).toEqual({});
  });

  it('1.4 sendWorkDirAdd(path) → payload carries the path', () => {
    const { ws, sentFrames } = makeConnectedWs();
    const before = sentFrames().length;
    ws.sendWorkDirAdd('/Users/foo bar/');
    const newFrames = sentFrames().slice(before);
    expect(newFrames[0]!.kind).toBe('control');
    expect(newFrames[0]!.type).toBe('work_dir_add');
    expect(newFrames[0]!.payload).toEqual({ path: '/Users/foo bar/' });
  });

  it('1.4b sendWorkDirAdd with special-character path passes through verbatim (URL encoding happens on the hash, not the wire)', () => {
    // The wire carries the raw path string; URL encoding happens on
    // the URL hash side (`encodeURIComponent` in encodeHash).
    // Path-side: the work_dir_add payload carries the raw absolute
    // path as-is. The bridge's three-piece check operates on the
    // filesystem, not the URL.
    const { ws, sentFrames } = makeConnectedWs();
    ws.sendWorkDirAdd('/mnt/data&backup/');
    const frames = sentFrames().filter((f) => f.type === 'work_dir_add');
    expect(frames[0]!.payload).toEqual({ path: '/mnt/data&backup/' });
  });

  it('1.5 sendWorkDirRemove(path) → payload carries the path', () => {
    const { ws, sentFrames } = makeConnectedWs();
    const before = sentFrames().length;
    ws.sendWorkDirRemove('/Users/foo bar/');
    const newFrames = sentFrames().slice(before);
    expect(newFrames[0]!.kind).toBe('control');
    expect(newFrames[0]!.type).toBe('work_dir_remove');
    expect(newFrames[0]!.payload).toEqual({ path: '/Users/foo bar/' });
  });

  it('1.6 sendSessionList(work_dir) → payload.work_dir set (裁定 A 操作惯例)', () => {
    const { ws, sentFrames } = makeConnectedWs();
    const before = sentFrames().length;
    ws.sendSessionList('/home/me');
    const newFrames = sentFrames().slice(before);
    expect(newFrames[0]!.kind).toBe('control');
    expect(newFrames[0]!.type).toBe('session_list');
    expect(newFrames[0]!.payload).toEqual({ work_dir: '/home/me' });
  });

  it('1.7 every M4 command returns a unique outbound id', () => {
    const { ws } = makeConnectedWs();
    const ids = new Set<string>([
      ws.sendListDirectories(),
      ws.sendWorkDirList(),
      ws.sendWorkDirAdd('/h'),
      ws.sendWorkDirRemove('/h'),
      ws.sendSessionList('/h'),
    ]);
    expect(ids.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Inbound `control/result` routing (work_dir_list / list_directories /
// session_list mirrors; success + failure caching)
// ---------------------------------------------------------------------------

describe('WsClient M4 inbound — control/result routing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('2.1 work_dir_list reply populates _workDirs mirror', () => {
    const { ws, fake } = makeConnectedWs();
    expect(ws.workDirs).toEqual([]);
    const id = ws.sendWorkDirList();
    simulateInbound(
      ws,
      controlResult(id, { work_dirs: ['/home/me', '/tmp/work'] }, true),
      fake,
    );
    expect(ws.workDirs).toEqual(['/home/me', '/tmp/work']);
  });

  it('2.2 list_directories reply populates the transient cache (take once)', () => {
    const { ws, fake } = makeConnectedWs();
    const id = ws.sendListDirectories('/home/me');
    simulateInbound(
      ws,
      controlResult(id, {
        entries: [
          { name: 'code', path: '/home/me/code' },
          { name: 'docs', path: '/home/me/docs' },
        ],
      }, true),
      fake,
    );
    const first = ws.takeListDirResult(id);
    expect(first).toEqual([
      { name: 'code', path: '/home/me/code' },
      { name: 'docs', path: '/home/me/docs' },
    ]);
    // One-shot: a second take returns null (the cache entry was deleted).
    expect(ws.takeListDirResult(id)).toBeNull();
  });

  it('2.3 session_list reply populates _sessionList mirror', () => {
    const { ws, fake } = makeConnectedWs();
    expect(ws.sessionList).toBeNull();
    const id = ws.sendSessionList('/home/me');
    const entries: SessionListEntry[] = [
      {
        id: '2026-09-08T10-30-00_a3f9b2c1',
        name: 'demo',
        cwd: '/home/me',
        created: '2026-09-08T10:30:00Z',
        modified: '2026-09-08T10:35:00Z',
        message_count: 3,
        first_message: 'hello',
        running: true,
        status: 'idle',
      },
    ];
    simulateInbound(ws, controlResult(id, { sessions: entries }, true), fake);
    expect(ws.sessionList).toEqual(entries);
  });

  it('2.4 session_list empty reply sets mirror to empty array (not null)', () => {
    const { ws, fake } = makeConnectedWs();
    expect(ws.sessionList).toBeNull();
    const id = ws.sendSessionList('/home/me');
    simulateInbound(ws, controlResult(id, { sessions: [] }, true), fake);
    expect(ws.sessionList).toEqual([]);
  });

  it('2.5 work_dir_add failure (result.ok=false) caches error in workDirResults', () => {
    const { ws, fake } = makeConnectedWs();
    const id = ws.sendWorkDirAdd('/nonexistent');
    simulateInbound(
      ws,
      controlResult(id, undefined, false, {
        code: 'internal',
        message: 'directory does not exist or is not readable',
      }),
      fake,
    );
    const outcome = ws.takeWorkDirResult(id);
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'directory does not exist or is not readable',
      },
    });
  });

  it('2.6 work_dir_add success (result.ok=true, no data) caches ok:true', () => {
    const { ws, fake } = makeConnectedWs();
    const id = ws.sendWorkDirAdd('/home/me');
    simulateInbound(ws, controlResult(id, undefined, true), fake);
    expect(ws.takeWorkDirResult(id)).toEqual({ ok: true });
  });

  it('2.7 work_dir_list mirror survives across multiple replies', () => {
    const { ws, fake } = makeConnectedWs();
    const id1 = ws.sendWorkDirList();
    simulateInbound(ws, controlResult(id1, { work_dirs: ['/h'] }, true), fake);
    expect(ws.workDirs).toEqual(['/h']);

    const id2 = ws.sendWorkDirList();
    simulateInbound(ws, controlResult(id2, { work_dirs: ['/h', '/tmp'] }, true), fake);
    expect(ws.workDirs).toEqual(['/h', '/tmp']);
  });
});

// ---------------------------------------------------------------------------
// setCurrentWorkDir — hash-mirror into the store
// ---------------------------------------------------------------------------

describe('WsClient M4 — setCurrentWorkDir (hash mirror)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('3.1 initial currentWorkDir is null (no hash yet)', () => {
    const { ws } = makeConnectedWs();
    expect(ws.currentWorkDir).toBeNull();
  });

  it('3.2 setCurrentWorkDir updates the mirror', () => {
    const { ws } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    expect(ws.currentWorkDir).toBe('/home/me');
  });

  it('3.3 setCurrentWorkDir(null) clears the mirror', () => {
    const { ws } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    ws.setCurrentWorkDir(null);
    expect(ws.currentWorkDir).toBeNull();
  });

  it('3.4 setCurrentWorkDir same value is a no-op (identity stability)', () => {
    const { ws } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    // Subscribe + capture listener calls to verify the no-op skip.
    let calls = 0;
    ws.subscribe(() => calls++);
    ws.setCurrentWorkDir('/home/me');
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Type guards — tryDecode* helpers (unit-tested in isolation)
// ---------------------------------------------------------------------------

describe('WsClient M4 — tryDecode* helpers (inbound decoders)', () => {
  it('4.1 tryDecodeWorkDirListResult returns the parsed payload', async () => {
    const { tryDecodeWorkDirListResult } = await import('../ws/WsClient.js');
    const envelope: Envelope = {
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'r1',
      reply_to: 'r1',
      payload: { ok: true, data: { work_dirs: ['/a', '/b'] } },
    };
    expect(tryDecodeWorkDirListResult(envelope)).toEqual({
      work_dirs: ['/a', '/b'],
    });
  });

  it('4.2 tryDecodeWorkDirListResult returns null on malformed data', async () => {
    const { tryDecodeWorkDirListResult } = await import('../ws/WsClient.js');
    const envelope: Envelope = {
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'r1',
      reply_to: 'r1',
      payload: { ok: true, data: { not_work_dirs: [] } },
    };
    expect(tryDecodeWorkDirListResult(envelope)).toBeNull();
  });

  it('4.3 tryDecodeListDirectoriesResult returns the parsed entries', async () => {
    const { tryDecodeListDirectoriesResult } = await import('../ws/WsClient.js');
    const envelope: Envelope = {
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'r1',
      reply_to: 'r1',
      payload: {
        ok: true,
        data: { entries: [{ name: 'code', path: '/h/code' }] },
      },
    };
    expect(tryDecodeListDirectoriesResult(envelope)).toEqual({
      entries: [{ name: 'code', path: '/h/code' }],
    });
  });

  it('4.4 tryDecodeSessionListResult returns the parsed sessions', async () => {
    const { tryDecodeSessionListResult } = await import('../ws/WsClient.js');
    const entry: SessionListEntry = {
      id: 's1',
      name: null,
      cwd: '/h',
      created: '2026-09-08T10:30:00Z',
      modified: '2026-09-08T10:30:00Z',
      message_count: 0,
      first_message: null,
      running: false,
      status: 'unknown',
    };
    const envelope: Envelope = {
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'r1',
      reply_to: 'r1',
      payload: { ok: true, data: { sessions: [entry] } },
    };
    expect(tryDecodeSessionListResult(envelope)).toEqual({ sessions: [entry] });
  });

  it('4.5 tryDecode* return null on `ok: false`', async () => {
    const { tryDecodeSessionListResult, tryDecodeWorkDirListResult } = await import(
      '../ws/WsClient.js'
    );
    const envelope: Envelope = {
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'r1',
      reply_to: 'r1',
      payload: { ok: false, error: { code: 'internal', message: 'fail' } },
    };
    expect(tryDecodeWorkDirListResult(envelope)).toBeNull();
    expect(tryDecodeSessionListResult(envelope)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ChoicePage outbound automation — currentWorkDir mirrors into session_list payload
// (钉子 5 — ChoicePage reads `useCurrentWorkDir()` and feeds
// `sendSessionList(currentWorkDir)`; we assert the contract here.)
// ---------------------------------------------------------------------------

describe('WsClient M4 — currentWorkDir drives session_list payload (钉子 5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('5.1 outbound session_list with the mirror value matches the hash work_dir', () => {
    const { ws, sentFrames } = makeConnectedWs();
    // Simulate App.tsx's hashchange listener mirror logic.
    ws.setCurrentWorkDir('/Users/foo bar/');
    // Simulate ChoicePage level=2 firing the query on mount.
    const before = sentFrames().length;
    ws.sendSessionList(ws.currentWorkDir!);
    const newFrames = sentFrames().slice(before);
    expect(newFrames[0]!.payload).toEqual({
      work_dir: '/Users/foo bar/',
    });
  });

  it('5.2 mirror survives a `setCurrentWorkDir` flip from value to null', () => {
    const { ws, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/h');
    ws.sendSessionList(ws.currentWorkDir!);
    ws.setCurrentWorkDir(null);
    // ChoicePage level=1 wouldn't fire this — we just assert the
    // mirror itself flips cleanly.
    expect(ws.currentWorkDir).toBeNull();
    expect(sentFrames().at(-1)!.payload).toEqual({ work_dir: '/h' });
  });
});