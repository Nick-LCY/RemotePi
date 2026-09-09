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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WsClient } from '../ws/WsClient.js';
import { SESSION_LIST_DEFER_MS, watchStemRefilled } from '../ws/stem-refilled.js';

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

  it('W8.1 session_state{session:<stem>} fires hash refill + (deferred) sendSessionList', () => {
    // M4 验收期 4th gap 修复——sendSessionList 不再 turn 开头同步触发
    // （会阻塞 ~309ms 全目录扫描），改为延迟到 agent_settled（phase
    // → idle/exited）或 3s debounce。本 case 断言：
    //   - hash refill + onRefill callback 仍同步触发（核心副作用）；
    //   - sendSessionList 不再同步触发（推迟）；
    //   - 3s 后 debounce 兜底触发 sendSessionList；
    //   - 当前 session mirror 写入已用 stem（保证延迟触发时
    //     envelope.session === <stem>，避免重建 pending manager）。
    vi.useFakeTimers();
    try {
      const { ws, fake, sentFrames } = makeConnectedWs();
      ws.setCurrentWorkDir('/home/me');

      // Recorder for onRefill callback (M4 4th gap 核心——gate rekey).
      const refillCalls: Array<{ stem: string; workDir: string }> = [];
      const rec = makeHashRecorder();
      const unsub = watchStemRefilled(ws, {
        currentSession: 'new',
        workDir: '/home/me',
        token: 'tok',
        writeHash: rec.writeHash,
        onRefill: (stem, workDir) => refillCalls.push({ stem, workDir }),
      });

      expect(rec.writes).toEqual([]); // gate entered → no write yet

      // Simulate bridge stem-derivation broadcast.
      simulateInbound(ws, sessionState('realStem-abc', 'ready', '/home/me'), fake);

      // Hash refill + onRefill fire SYNCHRONOUSLY (M4 4th gap 核心).
      expect(rec.writes).toHaveLength(1);
      const writtenHash = rec.writes[0]!;
      expect(writtenHash).toContain('session=realStem-abc');
      expect(writtenHash).toContain('work_dir=');
      expect(decodeURIComponent(writtenHash)).toContain('/home/me');

      // onRefill fired with (stem, workDir) — gate rekey 入口点。
      expect(refillCalls).toEqual([{ stem: 'realStem-abc', workDir: '/home/me' }]);

      // Mirror updated SYNCHRONOUSLY before deferred sendSessionList
      // (CRITICAL ORDERING — 避免 envelope.session === 'new' 触发
      // 第二个 pending manager，详见 stem-refilled.ts handler JSDoc).
      expect(ws.currentSessionKey).toBe('realStem-abc');

      // sendSessionList NOT yet fired (deferred — 钉子 5 推迟语义).
      const beforeAdvance = sentFrames().find((f) => f.type === 'session_list');
      expect(beforeAdvance).toBeUndefined();

      // 3s debounce elapses → fallback fire sendSessionList.
      vi.advanceTimersByTime(SESSION_LIST_DEFER_MS);

      const frames = sentFrames();
      const sessionListFrame = frames.find((f) => f.type === 'session_list');
      expect(sessionListFrame).toBeDefined();
      expect((sessionListFrame!.payload as { work_dir: string }).work_dir).toBe('/home/me');

      unsub();
    } finally {
      vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    try {
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
      // No sendSessionList fire either — pending-key doesn't start the
      // deferred machinery either (deferred fire would still race with
      // the upcoming real-stem broadcast; bail out at the gate).
      vi.advanceTimersByTime(SESSION_LIST_DEFER_MS + 1_000);
      expect(sentFrames().find((f) => f.type === 'session_list')).toBeUndefined();

      // The NEXT broadcast (migration → real stem) should still
      // fire normally — the filter only excludes the pending key,
      // not all session_states.
      simulateInbound(ws, sessionState('realStem-abc', 'ready', '/home/me'), fake);
      expect(rec.writes).toHaveLength(1);
      expect(rec.writes[0]!).toContain('session=realStem-abc');

      unsub();
    } finally {
      vi.useRealTimers();
    }
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

// ---------------------------------------------------------------------------
// W11 — M4 验收期 4th gap 修复测试（gate rekey + deferred sendSessionList）
// ---------------------------------------------------------------------------

describe('watchStemRefilled — W11 (4th gap gate rekey + deferred sendList)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('W11.1 onRefill callback fires with (stem, workDir) BEFORE hash write (M4 4th gap 核心)', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const refillOrder: string[] = [];
    const rec = makeHashRecorder();

    // writeHash 同时记录到 rec（断言 rec.writes 数量）and refillOrder
    // （断言相对顺序）——单 helper 兼顾两侧断言。
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: (hash: string) => {
        refillOrder.push('hash');
        rec.writeHash(hash);
      },
      onRefill: () => refillOrder.push('onRefill'),
    });

    simulateInbound(ws, sessionState('realStem-xyz', 'ready', '/home/me'), fake);
    // onRefill 必须先于 hash write——App 顺序：onRefill(take-and-set)
    // → writeHash(触发 hashchange) → gateForSession(<stem>) 命中
    // ready gate。onRefill 在前避免 hashchange listener 先于 take-
    // and-set 触发。
    expect(refillOrder).toEqual(['onRefill', 'hash']);
    expect(rec.writes).toHaveLength(1);

    unsub();
  });

  it('W11.2 onRefill throw is caught — watcher continues with hash + sendList', () => {
    // 回调编程错误容差——onRefill throw 不阻断 watcher 主流程。
    const { ws, fake, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const rec = makeHashRecorder();
      const unsub = watchStemRefilled(ws, {
        currentSession: 'new',
        workDir: '/home/me',
        token: 'tok',
        writeHash: rec.writeHash,
        onRefill: () => {
          throw new Error('test-app-bug');
        },
      });

      // 即使回调 throw，watcher 主流程仍继续：
      simulateInbound(ws, sessionState('realStem-xyz', 'ready', '/home/me'), fake);
      // hash refill 仍落地
      expect(rec.writes).toHaveLength(1);
      expect(rec.writes[0]!).toContain('session=realStem-xyz');
      // warn logged
      expect(consoleWarn).toHaveBeenCalled();
      // 延迟 sendSessionList 仍按计划触发（3s debounce）
      vi.advanceTimersByTime(SESSION_LIST_DEFER_MS);
      const sessionListFrame = sentFrames().find((f) => f.type === 'session_list');
      expect(sessionListFrame).toBeDefined();

      unsub();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('W11.3 deferred sendSessionList fires on phase=idle (agent_settled) — earlier than debounce', () => {
    // agent_settled 路径应在 phase=idle 时立即触发，不等 debounce。
    const { ws, fake, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: makeHashRecorder().writeHash,
    });

    simulateInbound(ws, sessionState('realStem-abc', 'ready', '/home/me'), fake);
    // 还未触发 sendSessionList
    expect(sentFrames().find((f) => f.type === 'session_list')).toBeUndefined();

    // < SESSION_LIST_DEFER_MS 时段内 phase → 'idle' → 立即 fire
    vi.advanceTimersByTime(500); // < 3s
    simulateInbound(ws, sessionState('realStem-abc', 'idle', '/home/me'), fake);

    // 立即触发（不等 debounce 到期）
    expect(sentFrames().find((f) => f.type === 'session_list')).toBeDefined();

    // 再 advance 到 debounce 时长——不应重复触发（fired 标志吞）
    const before = sentFrames().filter((f) => f.type === 'session_list').length;
    vi.advanceTimersByTime(SESSION_LIST_DEFER_MS);
    expect(sentFrames().filter((f) => f.type === 'session_list').length).toBe(before);

    unsub();
  });

  it('W11.4 deferred sendSessionList fires on phase=exited (idle alternative)', () => {
    // exited 也是合理 fire 路径（用户 abort / bridge exited）——同样
    // 立即触发，不等 debounce。
    const { ws, fake, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: makeHashRecorder().writeHash,
    });

    simulateInbound(ws, sessionState('realStem-abc', 'ready', '/home/me'), fake);
    vi.advanceTimersByTime(500);
    simulateInbound(ws, sessionState('realStem-abc', 'exited', '/home/me'), fake);

    expect(sentFrames().find((f) => f.type === 'session_list')).toBeDefined();

    unsub();
  });

  it('W11.5 deferred sendSessionList does NOT fire on running phase (mid-turn)', () => {
    // running phase 不应触发 sendSessionList——流式进行中，列表重查
    // 仍会阻塞后续 delta 渲染节奏。
    const { ws, fake, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: makeHashRecorder().writeHash,
    });

    simulateInbound(ws, sessionState('realStem-abc', 'ready', '/home/me'), fake);
    simulateInbound(ws, sessionState('realStem-abc', 'running', '/home/me'), fake);

    expect(sentFrames().find((f) => f.type === 'session_list')).toBeUndefined();

    unsub();
  });

  it('W11.6 unsub cancels pending deferred fire — no leakage post-cleanup', () => {
    // userEffect cleanup 路径：用户退回 level2 / 换 session → unsub
    // 触发。挂起的 deferred 必须清掉，避免延迟 fire 落地污染
    // 不相关的 session_list 镜像。
    const { ws, fake, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: makeHashRecorder().writeHash,
    });

    simulateInbound(ws, sessionState('realStem-abc', 'ready', '/home/me'), fake);
    unsub();

    // debounce 时长已过 —— 不应触发 sendSessionList
    vi.advanceTimersByTime(SESSION_LIST_DEFER_MS + 1_000);
    expect(sentFrames().find((f) => f.type === 'session_list')).toBeUndefined();

    // phase listener 已 unsub —— 即使继续 simulateInbound 也不再触发
    simulateInbound(ws, sessionState('realStem-abc', 'idle', '/home/me'), fake);
    expect(sentFrames().find((f) => f.type === 'session_list')).toBeUndefined();
  });

  it('W11.7 deferred fire produces exactly one sendSessionList (whichever path first) — refill idempotency', () => {
    // 多路径竞争：agent_settled (idle) 先触发 → debounce 到期后不应
    // 再 fire。`hasRefilled` 标志 + `fired` 标志双重吞掉重复
    // （refill 幂等性 + 同一 deferred 的多次触发吞）。
    const { ws, fake, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: makeHashRecorder().writeHash,
    });

    simulateInbound(ws, sessionState('realStem-abc', 'ready', '/home/me'), fake);
    // 先触发 idle（短延迟）
    vi.advanceTimersByTime(100);
    simulateInbound(ws, sessionState('realStem-abc', 'idle', '/home/me'), fake);
    const firedAfterIdle = sentFrames().filter((f) => f.type === 'session_list').length;
    expect(firedAfterIdle).toBe(1);

    // debounce 也到期 —— 不会触发第二次（fired flag）
    vi.advanceTimersByTime(SESSION_LIST_DEFER_MS);
    expect(sentFrames().filter((f) => f.type === 'session_list').length).toBe(1);

    // 额外 phase 广播也不会触发（hasRefilled 顶部 gate + 已 fire 的
    // pendingDeferred 不再创建新 deferred）
    simulateInbound(ws, sessionState('realStem-abc', 'idle', '/home/me'), fake);
    simulateInbound(ws, sessionState('realStem-abc', 'running', '/home/me'), fake);
    simulateInbound(ws, sessionState('realStem-abc', 'idle', '/home/me'), fake);
    expect(sentFrames().filter((f) => f.type === 'session_list').length).toBe(1);

    unsub();
  });

  it('W11.7b refill idempotency: subsequent session_state with same stem is no-op (no re-take-and-set)', () => {
    // 额外防御：watcher fire 后即使连续 phase 广播也不重跑 handler
    // 副作用（onRefill 不再 fire / writeHash 不再 fire / deferred 不
    // 重启）。原行为下每次 session_state 都会重 fire 全部副作用，是
    // 同一根因，本修复同步根治。
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const refillCalls: string[] = [];
    const rec = makeHashRecorder();
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: rec.writeHash,
      onRefill: (stem) => refillCalls.push(stem),
    });

    // First stem broadcast — fires refill.
    simulateInbound(ws, sessionState('realStem-abc', 'ready', '/home/me'), fake);
    expect(refillCalls).toEqual(['realStem-abc']);
    expect(rec.writes).toHaveLength(1);

    // Subsequent phase updates — handler is a no-op (hasRefilled gate).
    simulateInbound(ws, sessionState('realStem-abc', 'running', '/home/me'), fake);
    simulateInbound(ws, sessionState('realStem-abc', 'idle', '/home/me'), fake);
    simulateInbound(ws, sessionState('realStem-abc', 'exited', '/home/me'), fake);

    // Refill side effects did NOT re-fire.
    expect(refillCalls).toEqual(['realStem-abc']);
    expect(rec.writes).toHaveLength(1);

    unsub();
  });

  it('W11.8 deferMs override shortens debounce (test injection seam)', () => {
    // deferMs 用于测试快速验证——不必等 3s 真实时长。
    const { ws, fake, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: makeHashRecorder().writeHash,
      deferMs: 100,
    });

    simulateInbound(ws, sessionState('realStem-abc', 'ready', '/home/me'), fake);
    expect(sentFrames().find((f) => f.type === 'session_list')).toBeUndefined();
    vi.advanceTimersByTime(150);
    expect(sentFrames().find((f) => f.type === 'session_list')).toBeDefined();

    unsub();
  });

  it('W11.9 onRefill not provided = no crash (optional seam)', () => {
    // 不传 onRefill —— 维持既有行为（仅 hash + 延迟 sendSessionList）。
    const { ws, fake, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const rec = makeHashRecorder();
    const unsub = watchStemRefilled(ws, {
      currentSession: 'new',
      workDir: '/home/me',
      token: 'tok',
      writeHash: rec.writeHash,
      // onRefill omitted
    });

    simulateInbound(ws, sessionState('realStem-abc', 'ready', '/home/me'), fake);
    expect(rec.writes).toHaveLength(1);
    vi.advanceTimersByTime(SESSION_LIST_DEFER_MS);
    expect(sentFrames().find((f) => f.type === 'session_list')).toBeDefined();

    unsub();
  });
});

// ---------------------------------------------------------------------------
// W11b — gate take-and-set helper (App.tsx handleRefill 等价语义)
// ---------------------------------------------------------------------------
//
// App.tsx 的 handleRefill 是 useCallback 闭包，无法脱离 React 直接单测。
// 本节把 take-and-set 的核心逻辑抽出断言：'new' gate 移交 stem 键，
// 'new' 键删除；'new' gate 不存在则 no-op（fallback）。
//
// 这是 gate 重键回调的语义契约——watcher 提供 onRefill seam，App 实现
// take-and-set 于此。

describe('gate take-and-set (App.tsx handleRefill contract)', () => {
  /** Mirror of App.tsx handleRefill logic. App passes its gateMapRef
   *  into onRefill; we recreate the same mutation here as a pure
   *  helper for direct unit testing. */
  function handleRefill(
    gateMapRef: { current: Map<string, { tag: string }> },
    stem: string,
  ): void {
    const newGate = gateMapRef.current.get('new');
    if (newGate === undefined) return;
    gateMapRef.current.set(stem, newGate);
    gateMapRef.current.delete('new');
  }

  it('W11b.1 takes "new" gate, sets stem key, deletes "new" key', () => {
    const gateMapRef = { current: new Map<string, { tag: string }>() };
    const newGate = { tag: 'ready' };
    gateMapRef.current.set('new', newGate);
    expect(gateMapRef.current.has('new')).toBe(true);

    handleRefill(gateMapRef, 'realStem-abc');

    // Stem key gets the 'new' gate (object identity preserved).
    expect(gateMapRef.current.get('realStem-abc')).toBe(newGate);
    // 'new' key removed.
    expect(gateMapRef.current.has('new')).toBe(false);
    // Map size = 1 (only stem key).
    expect(gateMapRef.current.size).toBe(1);
  });

  it('W11b.2 "new" gate missing → no-op fallback (does not crash, does not create stem key)', () => {
    // 边界：用户在 stem 到达前已退回 level2，gateMap 没有 'new' 键。
    const gateMapRef = { current: new Map<string, { tag: string }>() };
    // Pre-existing stem gate from a previous mount of the same session
    // (钉子 6 暂存契约) — handleRefill 不应删除或覆盖。
    const existingStemGate = { tag: 'previous-stem-gate' };
    gateMapRef.current.set('realStem-abc', existingStemGate);

    expect(() => handleRefill(gateMapRef, 'realStem-other')).not.toThrow();

    // 'new' 键保持缺失；新 stem 不创建（fallback → 既有
    // gateForSession 路径会触发 initiateRecovery 仪式）
    expect(gateMapRef.current.has('new')).toBe(false);
    expect(gateMapRef.current.has('realStem-other')).toBe(false);
    // 既有 stem gate 保持不变
    expect(gateMapRef.current.get('realStem-abc')).toBe(existingStemGate);
  });

  it('W11b.3 stem already in map → overwrites with "new" gate (M4 4th gap 核心 case)', () => {
    // 正常使用流程——首次走新会话 → 'new' 键有 createReadyGate；
    // watcher fire → handleRefill 把 ready gate 移交到 stem 键。
    // stem 键原本不存在（首次回填），但若用户在 stem 到达前曾快速切
    // 入会话（极边缘），可能留有上次 initiateRecovery 的 gate —
    // 这种情形我们的 take-and-set 仍正确：以 'new' 的 ready gate
    // 覆盖（语义=迁移来的会话按定义历史为空）。
    const gateMapRef = { current: new Map<string, { tag: string }>() };
    const oldStemGate = { tag: 'pending-ceremony' };
    gateMapRef.current.set('realStem-abc', oldStemGate);
    const newGate = { tag: 'ready' };
    gateMapRef.current.set('new', newGate);

    handleRefill(gateMapRef, 'realStem-abc');

    // Stem key overwritten with 'new' gate (object identity replaced).
    expect(gateMapRef.current.get('realStem-abc')).toBe(newGate);
    expect(gateMapRef.current.get('realStem-abc')).not.toBe(oldStemGate);
    expect(gateMapRef.current.has('new')).toBe(false);
  });

  it('W11b.4 multiple stem refills never happen (single-fire invariant), but logic is idempotent', () => {
    // 防御：watcher 一次性事件（URL 翻转后 useEffect 重 attach，gate
    // 改成 currentSession !== 'new' → no-op），但 take-and-set 本身
    // 幂等。
    const gateMapRef = { current: new Map<string, { tag: string }>() };
    const newGate = { tag: 'ready' };
    gateMapRef.current.set('new', newGate);

    handleRefill(gateMapRef, 'realStem-abc');
    handleRefill(gateMapRef, 'realStem-abc'); // 双调（不应崩溃）

    expect(gateMapRef.current.size).toBe(1);
    expect(gateMapRef.current.get('realStem-abc')).toBe(newGate);
    expect(gateMapRef.current.has('new')).toBe(false);
  });
});
