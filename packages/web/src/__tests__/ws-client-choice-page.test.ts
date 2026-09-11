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
  addEventListener(_type: string, _listener?: EventListenerOrEventListenerObject): void {
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

  it('1.6 sendSessionList(work_dir) → payload.work_dir set (裁定 A 操作惯例) + envelope.session 钉桩', () => {
    // R5 review 修复轮 W2 闭环：任务 07 移交段（task 08 §任务-07-w2-移交）
    // 要求 `sendSessionList` 出站补 `envelope.session` 字段；本
    // 用例在原 1.6（payload.work_dir 钉桩）之上追加 session
    // 断言——`envelope.session === currentSessionKey`。
    //
    //   1) 默认 currentSessionKey === null → session 字段省略
    //      （M3-compat fallback；M3_LEGACY manager 自答路径）。
    //   2) setCurrentSessionKey('X') → envelope.session === 'X'。
    const { ws, sentFrames } = makeConnectedWs();
    const before = sentFrames().length;
    ws.sendSessionList('/home/me');
    const newFrames = sentFrames().slice(before);
    expect(newFrames[0]!.kind).toBe('control');
    expect(newFrames[0]!.type).toBe('session_list');
    expect(newFrames[0]!.payload).toEqual({ work_dir: '/home/me' });
    // M3-compat 默认：currentSessionKey === null → session 省略。
    expect(newFrames[0]!.session).toBeUndefined();

    // 设 currentSessionKey → session 必带。
    ws.setCurrentSessionKey('sess-A');
    const beforeA = sentFrames().length;
    ws.sendSessionList('/home/me');
    const newFramesA = sentFrames().slice(beforeA);
    expect(newFramesA[0]!.session).toBe('sess-A');
    expect(newFramesA[0]!.payload).toEqual({ work_dir: '/home/me' });
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

  it('2.2 list_directories reply fires registerReplyResolver callback with parsed entries', () => {
    // Review 修复轮 C1——list_directories 不再写入 transient Map
    // (`listDirResults`);改为通过 registerReplyResolver 注册一次性
    // 回调，回执到达即触发；这里 assert 回调被调 + 解析成功 +
    // 一次 unsub 后不再触发。
    const { ws, fake } = makeConnectedWs();
    const id = ws.sendListDirectories('/home/me');
    const calls: Array<unknown> = [];
    const unsub = ws.registerReplyResolver(id, (env) => {
      calls.push(env);
    });
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
    expect(calls).toHaveLength(1);
    // One-shot semantics: a second reply with the same id does NOT
    // re-fire (the resolver was auto-removed on first match).
    simulateInbound(ws, controlResult(id, { entries: [] }, true), fake);
    expect(calls).toHaveLength(1);
    // Manual unsub is also idempotent.
    unsub();
    unsub();
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

  it('2.4b W4 — session_list stale reply (different id) does NOT overwrite fresh mirror data', () => {
    // Review 修复轮 W4——stale-reply 竞态守卫：两层防护。
    // 组件层 inFlightListRef 同款防护（详见 ChoicePage.tsx）通过
    // useEffect cleanup unsub 保证；本测试聚焦 WsClient 集中
    // 处理器的 `_lastSessionListId` 守卫——查询 1 的回执迟于查询 2
    // 到达时，查询 1 的 sessions[] 不覆盖查询 2 的新数据。
    const { ws, fake } = makeConnectedWs();
    // query 1 (older)
    const id1 = ws.sendSessionList('/home/me');
    // query 2 (newer) — WsClient._lastSessionListId is overwritten
    // to id2.
    const id2 = ws.sendSessionList('/home/me');
    expect(id1).not.toBe(id2);
    // query 2 reply lands first (fast bridge).
    const freshEntries: SessionListEntry[] = [
      {
        id: 's2',
        name: null,
        cwd: '/home/me',
        created: '2026-09-08T12:00:00Z',
        modified: '2026-09-08T12:00:00Z',
        message_count: 0,
        first_message: null,
        running: false,
        status: 'idle',
      },
    ];
    simulateInbound(ws, controlResult(id2, { sessions: freshEntries }, true), fake);
    expect(ws.sessionList).toEqual(freshEntries);
    // query 1 reply lands LATER — stale. W4 guard drops it.
    const staleEntries: SessionListEntry[] = [
      {
        id: 's1',
        name: null,
        cwd: '/home/me',
        created: '2026-09-08T10:00:00Z',
        modified: '2026-09-08T10:00:00Z',
        message_count: 0,
        first_message: null,
        running: false,
        status: 'unknown',
      },
    ];
    simulateInbound(ws, controlResult(id1, { sessions: staleEntries }, true), fake);
    // Mirror unchanged — query 2's data survives.
    expect(ws.sessionList).toEqual(freshEntries);
  });

  it('2.5 work_dir_add failure (result.ok=false) → registerReplyResolver sees the failure envelope', () => {
    // Review 修复轮 C1——work_dir_add 不再写入 transient Map
    // (`workDirResults`);失败语义由组件侧的 resolver 回调从
    // `envelope.payload.ok / .error` 解析。
    const { ws, fake } = makeConnectedWs();
    const id = ws.sendWorkDirAdd('/nonexistent');
    const calls: Envelope[] = [];
    ws.registerReplyResolver(id, (env) => {
      calls.push(env);
    });
    simulateInbound(
      ws,
      controlResult(id, undefined, false, {
        code: 'internal',
        message: 'directory does not exist or is not readable',
      }),
      fake,
    );
    expect(calls).toHaveLength(1);
    const env = calls[0]!;
    if (env.kind !== 'control' || env.type !== 'result') throw new Error('shape');
    expect(env.payload.ok).toBe(false);
    expect(env.payload.error).toEqual({
      code: 'internal',
      message: 'directory does not exist or is not readable',
    });
  });

  it('2.6 work_dir_add success (result.ok=true, no data) → resolver sees ok envelope', () => {
    const { ws, fake } = makeConnectedWs();
    const id = ws.sendWorkDirAdd('/home/me');
    const calls: Envelope[] = [];
    ws.registerReplyResolver(id, (env) => {
      calls.push(env);
    });
    simulateInbound(ws, controlResult(id, undefined, true), fake);
    expect(calls).toHaveLength(1);
    const env = calls[0]!;
    if (env.kind !== 'control' || env.type !== 'result') throw new Error('shape');
    expect(env.payload.ok).toBe(true);
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

  it('4.3 tryDecodeSessionListResult returns the parsed sessions', async () => {
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
// ---------------------------------------------------------------------------
// M5 §第二块 G6 / D10 — `connect(A) → connect(B)` 钉桩
//
// TokenModal closable mode wires
// `tokenStorage.write(value); client.connect(value)` to handle a
// user-initiated token swap (D10). The WsClient itself doesn't
// change behaviour — `connect()` already follows the
// teardown + swap + openSocket + reconnect-backoff-reset semantics
// from M2/M3 — but task 05 §测试义务 mandates 钉桩 unit tests
// covering three load-bearing edges:
//
//   1. handshake payload uses B (the latest token), not A
//   2. the old socket received a `close()` call (teardown
//      happened)
//   3. reconnect backoff uses the latest token (the outbound
//      `pi/...` envelopes carry the new token, and the heartbeat
//      `nonce` survives a token swap)
//
// The shared `FakeWs` stubs `close()` as a no-op so the close
// count assertion needs a richer fake. We use a separate
// `CloseCountingFakeWs` that records close-call counts and
// replaces `globalThis.WebSocket` per test.
// ---------------------------------------------------------------------------

/** A `FakeWs` variant that records `close()` calls AND captures
 *  the open listener so the test can fire the `open` event after
 *  `connect()`. The base FakeWs's `addEventListener` is a no-op —
 *  that means the WsClient's handshake (sent from `handleOpen`)
 *  never fires, so tests that assert on the handshake payload
 *  would fail. This variant captures the `'open'` listener and
 *  lets the test fire it via `fireOpen()`. */
class CloseCountingFakeWs extends FakeWs {
  readonly closeCalls: number[] = [];
  private openListener: (() => void) | null = null;
  override close(): void {
    this.closeCalls.push(Date.now());
  }
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'open' && typeof listener === 'function') {
      this.openListener = listener as () => void;
    }
    // Otherwise swallow (matching the base FakeWs behaviour).
  }
  fireOpen(): void {
    if (this.openListener !== null) {
      this.openListener();
    }
  }
}

function makeConnectedWsWithCloseCount(): { ws: WsClient; fake: CloseCountingFakeWs; sentFrames: () => Envelope[] } {
  const fake = new CloseCountingFakeWs();
  // StubWebSocket ignores `new` and returns the SAME `fake` instance
  // every time — so subsequent `openSocket()` calls reuse the same
  // fake (the WsClient's `this.socket` field will point at it each
  // time). This is intentional: it lets the test fire a fresh
  // `open` event after each `connect()` to drive the handshake.
  function StubWebSocket(this: unknown) {
    return fake;
  }
  StubWebSocket.OPEN = FakeWs.OPEN;
  // We DO NOT restore `globalThis.WebSocket` after the first
  // `connect()` — the helper is consumed only by tests in this
  // `describe` block, and the StubWebSocket must stay installed
  // so subsequent `connect()` calls can construct new sockets.
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = StubWebSocket;
  const ws = new WsClient('ws://test/web');
  ws.connect('tok-A');
  // Fire the open event so the WsClient sends the handshake
  // (handleOpen). Without this, no handshake frame lands in
  // `sentFrames` and the connect(A)→connect(B) assertions below
  // would have nothing to compare against.
  fake.fireOpen();
  return {
    ws,
    fake,
    sentFrames: () => fake.sentFrames.slice(),
  };
}

describe('WsClient M5 — connect(A) → connect(B) (token swap via Settings)', () => {
  // Original `WebSocket` is captured at module-init time so we can
  // restore it after the tests in this describe block. The
  // makeConnectedWsWithCloseCount helper installs a stub that
  // persists for the lifetime of each test (because subsequent
  // connect() calls reuse it) — if we didn't restore it, the
  // stub would leak into other describe blocks / test files.
  const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  });

  it('6.1 handshake payload after connect(B) carries token B (not A)', () => {
    // connect(A) → first handshake carries A; connect(B) → second
    // handshake carries B. The first handshake is sent on the
    // initial socket; the second is sent on the new socket (the
    // FakeWs is reused across connects — WsClient.teardownSocket
    // calls `socket.close()` on the old reference but our fake
    // stays the same instance, so the second `openSocket()` reuses
    // `fake` as the new `this.socket`).
    const { ws, fake, sentFrames } = makeConnectedWsWithCloseCount();
    const firstHandshake = sentFrames()[0]!;
    expect(firstHandshake.type).toBe('handshake');
    if (firstHandshake.type !== 'handshake') throw new Error('shape');
    expect((firstHandshake.payload as { token: string }).token).toBe('tok-A');

    // Swap to token B.
    ws.connect('tok-B');
    // Fire the open event on the (reused) fake so the WsClient
    // sends the second handshake. The fake is the same instance
    // across connects because WsClient's StubWebSocket constructor
    // ignores `new` and returns the cached `fake`.
    fake.fireOpen();
    // WsClient calls `this.token = 'tok-B'` synchronously inside
    // connect() (before openSocket). The next handshake uses B.
    const handshakes = sentFrames().filter((f) => f.type === 'handshake');
    expect(handshakes.length).toBeGreaterThanOrEqual(2);
    const secondHandshake = handshakes[1]!;
    if (secondHandshake.type !== 'handshake') throw new Error('shape');
    expect((secondHandshake.payload as { token: string }).token).toBe('tok-B');
    // Sanity: token A is not in the second payload.
    expect((secondHandshake.payload as { token: string }).token).not.toBe('tok-A');
    // Sanity: the fake's closeCalls records the old socket close.
    expect(fake.closeCalls.length).toBe(1);
  });

  it('6.2 connect(A) → connect(B) closes the old socket exactly once', () => {
    // The WsClient.connect() contract is `teardownSocket()` first
    // (which calls `socket.close()`), then `openSocket()` (which
    // constructs a new WebSocket and sets `this.socket`). A
    // token swap therefore produces exactly one `close()` call
    // per connect — the teardown of the previous socket. This
    // is the load-bearing assertion for "old socket close"
    // (task brief §测试义务 条目 2).
    const { ws, fake } = makeConnectedWsWithCloseCount();
    // The first connect('tok-A') inside makeConnectedWsWithCloseCount
    // triggered teardownSocket (no prior socket → no close) then
    // openSocket (new socket). fireOpen then sent the handshake.
    // No close() call yet.
    expect(fake.closeCalls.length).toBe(0);
    ws.connect('tok-A');
    // Second connect('tok-A'): teardownSocket closes the previous
    // socket (the first one). Then openSocket creates a new one.
    expect(fake.closeCalls.length).toBe(1);
    fake.fireOpen();
    ws.connect('tok-B');
    // Third connect: teardownSocket closes the second socket.
    expect(fake.closeCalls.length).toBe(2);
    fake.fireOpen();
    // A disconnect() does NOT add a close call (it already
    // happened in connect's teardown — disconnect calls
    // teardownSocket too but only on the current socket, which
    // is the one we just made).
    ws.disconnect();
    expect(fake.closeCalls.length).toBe(3);
  });

  it('6.3 reconnect backoff uses the latest token (after a forced close on token B)', () => {
    // After connect(B), if the socket drops (handleClose fires),
    // the auto-reconnect backoff schedules a new socket via
    // openSocket() — which sends a NEW handshake carrying the
    // CURRENT token (B), not the original A. We assert that by
    // simulating a server-side close event (handleClose) and
    // advancing timers to trigger the backoff.
    const { ws, fake, sentFrames } = makeConnectedWsWithCloseCount();
    ws.connect('tok-B');
    fake.fireOpen();
    const handshakesBefore = sentFrames().filter((f) => f.type === 'handshake').length;
    // Trigger a close event on the active socket. handleClose is
    // an arrow field — invoke via the fake's `target` reference.
    const handleClose = (ws as unknown as {
      handleClose: (event: CloseEvent) => void;
    }).handleClose;
    const closeEvent = {
      code: 1006,
      reason: '',
      wasClean: false,
      target: fake,
    } as unknown as CloseEvent;
    handleClose(closeEvent);
    // Advance the reconnect timer (jitter 800-1200ms base 1s ±
    // 20%). The minimum jitter is 800ms — advance well past that.
    vi.advanceTimersByTime(2_000);
    // The reconnect path re-registers the open listener on a new
    // socket (same FakeWs instance because StubWebSocket ignores
    // `new`). Fire open so the new handshake lands.
    fake.fireOpen();
    // After the backoff fires, openSocket() constructs a new
    // socket and sends a fresh handshake. Count should grow.
    const handshakesAfter = sentFrames().filter((f) => f.type === 'handshake').length;
    expect(handshakesAfter).toBeGreaterThan(handshakesBefore);
    // The most recent handshake payload must carry B (the
    // currently-cached token), not A.
    const lastHandshake = sentFrames()
      .filter((f) => f.type === 'handshake')
      .slice(-1)[0]!;
    if (lastHandshake.type !== 'handshake') throw new Error('shape');
    expect((lastHandshake.payload as { token: string }).token).toBe('tok-B');
    // Sanity: A must NOT appear in any of the post-swap handshakes.
    for (const h of sentFrames().filter((f) => f.type === 'handshake').slice(1)) {
      if (h.type !== 'handshake') continue;
      expect((h.payload as { token: string }).token).not.toBe('tok-A');
    }
  });
});
