// Vitest specs for the M4 WsClient per-session bucket store added in
// tasks/m4/08 (PRD §4.3 + §4.4 + §4.5 + §4.6) + task 08 review 修复轮
// (R1 / R2 / R3 / R4 / R5).
//
// ## 桥端会话字段注入现状（review R2 校准）
//
// bridge `makeOutboundWrapper`（packages/bridge/src/session-layer.ts）
// 仅在 `session_state` 信封上 inject `envelope.session` 字段——
// event / snapshot / command_result 等透传 pi 原 wire shape（pi 0.85.1
// 不带 session 字段）。Result：M4 normal flow 下事件级入站多为
// session-less，依赖 review R2 落地后的 fallback 链落桶。
//
// ## Fallback 链（review R2 钉桩）
//
//   envelope.session ?? this._currentSessionKey ?? M3_LEGACY_KEY
//
// 三档语义：
//   1. `envelope.session` echo（极少——bridge 当前不在 event / snapshot
//      上注入）：路由到对应 session 桶；
//   2. session-less + `currentSessionKey === X`：落 X 桶（M4 单端
//      活动会话模型——用户在 ChatView 看 session X，活动事件
//      必然来自 X 的 manager）；
//   3. session-less + `currentSessionKey === null`：落 M3_LEGACY 桶
//      （M3-compat fallback——用户在 ChoicePage level=2 / M3 token-
//      only 链接）。
//
// ## Surface under test:
//   - Outbound session auto-fill（all pi commands + control/get_state +
//     control/session_list）stamp `envelope.session` from
//     `currentSessionKey`.
//   - Inbound routing（session_state / snapshot / event / get_state reply
//     / session_list reply）：按 R2 fallback 链入桶；
//     `session_state` 是 anchor（bridge 必注入），保留 `envelope.session
//     ?? M3_LEGACY_KEY` 直路由语义。
//   - Cross-session isolation：bucket A 的 messages / streamingDraft /
//     queue / phase / blockedOn / workDir 不会被 envelope.session === B
//     的入站触碰。
//   - session_list reply：per-task-08 W2 — 经 W4 lastSessionListId
//     守卫后，仅当 envelope.session 落入目标桶（R2 fallback 链 +
//     currentSessionKey 兜底）才更新镜像。
//   - R4 stem 回填桶迁移：session_state{session:<stem>} 触发
//     `new` → stem 桶迁移。
//   - `bucketFor(null)` / `bucketFor('m3-legacy')` resolve 到同一个
//     M3_LEGACY 桶（M3-compat fallback）。
//   - `setCurrentSessionKey` / `setCurrentWorkDir` mirror URL hash；
//     兼容 getter 解析到 currentSessionKey 的桶。

import { PROTOCOL_VERSION, type Envelope, type SessionListEntry } from '@remotepi/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { M3_LEGACY_KEY, WsClient } from '../ws/WsClient.js';

// ---------------------------------------------------------------------------
// FakeWs + simulateInbound (shared with ws-client-choice-page.test.ts)
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
  return {
    ws,
    fake,
    sentFrames: () => fake.sentFrames.slice(),
  };
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
  blockedOn: Array<{ method: 'select'; id: string; title: string; options: string[] }> = [],
  workDir?: string,
): Envelope {
  const payload: { phase: typeof phase; blocked_on?: typeof blockedOn; work_dir?: string } = {
    phase,
  };
  if (blockedOn.length > 0) payload.blocked_on = blockedOn;
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

function snapshot(
  session: string | undefined,
  replyTo: string,
  messages: unknown[] = [],
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: 'pi',
    type: 'snapshot',
    id: 'snap-' + Math.random().toString(36).slice(2, 10),
    reply_to: replyTo,
    ...(session !== undefined ? { session } : {}),
    payload: { messages },
  };
}

function event(
  session: string | undefined,
  eventName: string,
  data: unknown,
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: 'pi',
    type: 'event',
    id: 'e-' + Math.random().toString(36).slice(2, 10),
    ...(session !== undefined ? { session } : {}),
    payload: { event: eventName, data },
  };
}

function controlResult(
  replyTo: string,
  data: unknown,
  ok: boolean,
  session?: string,
): Envelope {
  const payload: { ok: boolean; data?: unknown } = { ok };
  if (data !== undefined) payload.data = data;
  return {
    v: PROTOCOL_VERSION,
    kind: 'control',
    type: 'result',
    id: 'r-' + Math.random().toString(36).slice(2, 10),
    reply_to: replyTo,
    ...(session !== undefined ? { session } : {}),
    payload,
  };
}

// ---------------------------------------------------------------------------
// Outbound session auto-fill (M4 §4.3 + 任务 06 C2)
// ---------------------------------------------------------------------------

describe('WsClient M4 task 08 — outbound session auto-fill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('1.1 pi/prompt auto-fills session from currentSessionKey', () => {
    const { ws, sentFrames } = makeConnectedWs();
    ws.setCurrentSessionKey('sess-A');
    ws.sendPrompt('hello');
    const prompt = sentFrames().find((f) => f.type === 'prompt')!;
    expect(prompt.session).toBe('sess-A');
  });

  it('1.2 pi/steer / pi/follow_up / pi/abort / pi/get_messages / pi/extension_ui_response all auto-fill session', () => {
    const { ws, sentFrames } = makeConnectedWs();
    ws.setCurrentSessionKey('sess-B');
    ws.sendSteer('mid-run');
    ws.sendFollowUp('queued');
    ws.sendAbort();
    ws.sendGetMessages();
    ws.sendExtensionUIResponse({
      request_id: 'r1',
      cancelled: false,
      value: 'ok',
    });
    const frames = sentFrames();
    const piFrames = frames.filter((f) => f.kind === 'pi');
    for (const f of piFrames) {
      expect(f.session).toBe('sess-B');
    }
  });

  it('1.3 control/session_list auto-fills session + work_dir (W2 移交 + 裁定 A)', () => {
    const { ws, sentFrames } = makeConnectedWs();
    ws.setCurrentSessionKey('sess-C');
    ws.setCurrentWorkDir('/home/me');
    ws.sendSessionList('/home/me');
    const listFrame = sentFrames().find((f) => f.type === 'session_list')!;
    expect(listFrame.session).toBe('sess-C');
    expect(listFrame.payload).toEqual({ work_dir: '/home/me' });
  });

  it('1.4 currentSessionKey === null → session field omitted (M3 token-only / E2E path)', () => {
    const { ws, sentFrames } = makeConnectedWs();
    // No setCurrentSessionKey call — the WsClient default is null.
    ws.sendPrompt('hello');
    const prompt = sentFrames().find((f) => f.type === 'prompt')!;
    expect(prompt.session).toBeUndefined();
  });

  it('1.5 session="new" outbound keeps the literal "new" (bridge pending-key path)', () => {
    const { ws, sentFrames } = makeConnectedWs();
    ws.setCurrentSessionKey('new');
    ws.sendPrompt('hello');
    const prompt = sentFrames().find((f) => f.type === 'prompt')!;
    expect(prompt.session).toBe('new');
  });
});

// ---------------------------------------------------------------------------
// Inbound session routing (M4 §4.3 + §4.4 — per-session buckets)
// ---------------------------------------------------------------------------

describe('WsClient M4 task 08 — inbound per-session routing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('2.1 session_state with session=A writes phase + blockedOn to bucket A only', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentSessionKey('B');
    simulateInbound(
      ws,
      sessionState('A', 'running', [], '/home/me'),
      fake,
    );
    const bucketA = ws.bucketFor('A');
    expect(bucketA.sessionPhase).toBe('running');
    expect(bucketA.workDir).toBe('/home/me');
    const bucketB = ws.bucketFor('B');
    expect(bucketB.sessionPhase).toBeNull();
    expect(bucketB.workDir).toBeNull();
  });

  it('2.2 snapshot with session=A writes messages to bucket A only', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentSessionKey('B');
    const id = ws.sendGetMessages();
    simulateInbound(
      ws,
      snapshot('A', id, [{ role: 'user', content: 'A1' }, { role: 'assistant', content: 'A2' }]),
      fake,
    );
    expect(ws.bucketFor('A').messages).toHaveLength(2);
    expect(ws.bucketFor('B').messages).toEqual([]);
  });

  it('2.3 event with session=A updates bucket A only (e.g. message_update)', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentSessionKey('B');
    simulateInbound(
      ws,
      event('A', 'message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'd1' },
      }),
      fake,
    );
    expect(ws.bucketFor('A').streamingDraft?.text).toBe('d1');
    expect(ws.bucketFor('B').streamingDraft).toBeNull();
  });

  it('2.4 session-less inbound lands in M3_LEGACY bucket when currentSessionKey=null (M3-compat default)', () => {
    // Review 修复轮 R2 落地：session-less inbound 路由语义
    // 现在分两档——
    //   (a) `currentSessionKey === null`（用户在 ChoicePage
    //       level=2 / 未进入任何 session / M3 token-only 链接）：
    //       仍落 M3_LEGACY 桶（保持 M3-compat 语义——bridge
    //       M3_LEGACY manager 的自答路径预期落此桶）。
    //   (b) `currentSessionKey === X`（用户在看 session X）：
    //       落 X 桶（M4 单端活动会话模型：bridge 的
    //       `makeOutboundWrapper` 仅在 session_state 注入
    //       session，event / snapshot 透传无 session 字段——
    //       会话级事件必然来自当前 manager，落当前桶）。
    // 本用例 pin (a)；2.4b pin (b)。
    const { ws, fake } = makeConnectedWs();
    simulateInbound(
      ws,
      sessionState(undefined, 'ready', [], '/home/me'),
      fake,
    );
    expect(ws.bucketFor(M3_LEGACY_KEY).sessionPhase).toBe('ready');
    expect(ws.bucketFor('any-other').sessionPhase).toBeNull();
  });

  it('2.4b session-less inbound lands in currentSessionKey bucket when set (R2 fallback chain)', () => {
    // R2 落地用例：用户在 ChatView 看 session X 时收到 session-less
    // 入站（bridge 不在 event / snapshot 上注入 session）→ 落 X 桶
    // （不是 M3_LEGACY）。这是 M4 单端活动会话模型下事件归属
    // 当前 session 的核心。
    // bridge 实测参考：packages/bridge/src/session-layer.ts
    // `makeOutboundWrapper` 仅 injects session on session_state；
    // event / snapshot 透传 pi 原 wire shape（pi 0.85.1 不带
    // session 字段）。
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentSessionKey('X');
    simulateInbound(
      ws,
      event(undefined, 'message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
      }),
      fake,
    );
    expect(ws.bucketFor('X').streamingDraft?.text).toBe('hello');
    // M3_LEGACY 桶未受污染。
    expect(ws.bucketFor(M3_LEGACY_KEY).streamingDraft).toBeNull();
  });

  it('2.4c session-less snapshot lands in currentSessionKey bucket (R2 fallback chain — snapshot site)', () => {
    // R2 落地用例：get_messages 回执（snapshot 信封）—— bridge
    // 不注入 session → 落 currentSessionKey 桶。同 2.4b 原理。
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentSessionKey('X');
    const id = ws.sendGetMessages();
    simulateInbound(
      ws,
      snapshot(undefined, id, [{ role: 'user', content: 'X1' }]),
      fake,
    );
    expect(ws.bucketFor('X').messages).toHaveLength(1);
    expect(ws.bucketFor(M3_LEGACY_KEY).messages).toEqual([]);
  });

  it('2.5 session=literal "new" still routes to bucket key "new" (bridge pending key — schema 兜底)', () => {
    // Schema 兜底语义：bridge 实际不发字面量 session='new'
    // 入站（pending 期间 session_state 由 manager 自答——`new`
    //     是 outbound 的 `envelope.session`，不是 inbound 形
    //     态）；本用例保留以钉 schema 兜底：session_state
    //     收到 `session === 'new'` 仍按字面键 'new' 写入桶。
    //     R4 stem 回填桶迁移依赖此钉桩——pending 期间若 bridge
    //     发 session_state{session:'new'}（防御性场景），web
    //     不应误判为 stem 而触发迁移。
    const { ws, fake } = makeConnectedWs();
    simulateInbound(ws, sessionState('new', 'spawning', [], '/h'), fake);
    expect(ws.bucketFor('new').sessionPhase).toBe('spawning');
  });

  it('2.6 cross-session isolation: blockedOn in A is NOT touched by B session_state', () => {
    const { ws, fake } = makeConnectedWs();
    // Fill A's bucket with a blocked_on entry.
    simulateInbound(
      ws,
      sessionState('A', 'running', [
        { method: 'select', id: 'dlg-A1', title: 'A1', options: ['x'] },
      ]),
      fake,
    );
    const beforeA = ws.bucketFor('A').blockedOn.length;
    expect(beforeA).toBe(1);
    // Now send a session_state for B with empty blocked_on.
    simulateInbound(
      ws,
      sessionState('B', 'running', [], '/h'),
      fake,
    );
    // A's blockedOn is preserved.
    expect(ws.bucketFor('A').blockedOn).toHaveLength(1);
    expect(ws.bucketFor('A').blockedOn[0]!.entry.id).toBe('dlg-A1');
  });

  it('2.7 blockedOn entries carry enqueuedAt timestamp (PRD §4.5 dialog countdown math)', () => {
    const { ws, fake } = makeConnectedWs();
    const before = Date.now();
    simulateInbound(
      ws,
      sessionState('A', 'running', [
        { method: 'select', id: 'd1', title: 'T1', options: ['x'] },
      ]),
      fake,
    );
    const after = Date.now();
    const entries = ws.bucketFor('A').blockedOn;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry.id).toBe('d1');
    expect(entries[0]!.enqueuedAt).toBeGreaterThanOrEqual(before);
    expect(entries[0]!.enqueuedAt).toBeLessThanOrEqual(after);
  });

  it('2.8 session_state drops blockedOn entries by id (wholesale replace)', () => {
    const { ws, fake } = makeConnectedWs();
    simulateInbound(
      ws,
      sessionState('A', 'running', [
        { method: 'select', id: 'd1', title: 'T1', options: ['x'] },
        { method: 'select', id: 'd2', title: 'T2', options: ['y'] },
      ]),
      fake,
    );
    expect(ws.bucketFor('A').blockedOn).toHaveLength(2);
    simulateInbound(ws, sessionState('A', 'running', [], '/h'), fake);
    expect(ws.bucketFor('A').blockedOn).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// session_list reply routing (M4 W2 — per-session bucket mirror)
// ---------------------------------------------------------------------------

describe('WsClient M4 task 08 — session_list per-bucket routing (W2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('3.1 session_list reply updates the current session bucket (envelope.session === currentSessionKey)', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentSessionKey('sess-A');
    const id = ws.sendSessionList('/home/me');
    const entries: SessionListEntry[] = [
      {
        id: 's1',
        name: null,
        cwd: '/home/me',
        created: '2026-09-08T10:00:00Z',
        modified: '2026-09-08T10:00:00Z',
        message_count: 0,
        first_message: null,
        running: false,
        status: 'idle',
      },
    ];
    simulateInbound(
      ws,
      controlResult(id, { sessions: entries }, true, 'sess-A'),
      fake,
    );
    expect(ws.bucketFor('sess-A').sessionList).toEqual(entries);
  });

  it('3.2 session_list reply with envelope.session=null (M3-compat) lands in M3_LEGACY bucket', () => {
    const { ws, fake } = makeConnectedWs();
    // currentSessionKey === null — typical ChoicePage level=2 mount.
    const id = ws.sendSessionList('/home/me');
    const entries: SessionListEntry[] = [
      {
        id: 's1',
        name: null,
        cwd: '/home/me',
        created: '2026-09-08T10:00:00Z',
        modified: '2026-09-08T10:00:00Z',
        message_count: 0,
        first_message: null,
        running: false,
        status: 'idle',
      },
    ];
    simulateInbound(ws, controlResult(id, { sessions: entries }, true), fake);
    expect(ws.bucketFor(M3_LEGACY_KEY).sessionList).toEqual(entries);
  });

  it('3.3 W4 迟到回执守卫 — stale session_list reply (id mismatch) does NOT overwrite fresh mirror', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentSessionKey('sess-A');
    // query 1 (older).
    const id1 = ws.sendSessionList('/home/me');
    // query 2 (newer) — _lastSessionListId is overwritten.
    const id2 = ws.sendSessionList('/home/me');
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
    simulateInbound(ws, controlResult(id2, { sessions: freshEntries }, true, 'sess-A'), fake);
    expect(ws.bucketFor('sess-A').sessionList).toEqual(freshEntries);
    // query 1 reply lands later — stale. W4 guard drops it.
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
    simulateInbound(ws, controlResult(id1, { sessions: staleEntries }, true, 'sess-A'), fake);
    expect(ws.bucketFor('sess-A').sessionList).toEqual(freshEntries);
  });
});

// ---------------------------------------------------------------------------
// Back-compat top-level getters (M3 callers — legacy code)
// ---------------------------------------------------------------------------

describe('WsClient M4 task 08 — back-compat top-level getters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('4.1 client.messages / client.sessionPhase / client.blockedOn resolve to currentSessionKey bucket', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentSessionKey('A');
    simulateInbound(
      ws,
      sessionState('A', 'running', [
        { method: 'select', id: 'd1', title: 'T1', options: ['x'] },
      ]),
      fake,
    );
    expect(ws.sessionPhase).toBe('running');
    expect(ws.blockedOn).toHaveLength(1);
    expect(ws.blockedOn[0]!.entry.id).toBe('d1');
    // Switch session — back-compat getters now read from B's bucket.
    ws.setCurrentSessionKey('B');
    expect(ws.sessionPhase).toBeNull();
    expect(ws.blockedOn).toEqual([]);
  });

  it('4.2 client.sessionList resolves to currentSessionKey bucket; falls back to M3_LEGACY when null', () => {
    const { ws, fake } = makeConnectedWs();
    // M3_LEGACY path (currentSessionKey === null)
    const id1 = ws.sendSessionList('/home/me');
    const legacyEntries: SessionListEntry[] = [
      {
        id: 'L1',
        name: null,
        cwd: '/home/me',
        created: '2026-09-08T10:00:00Z',
        modified: '2026-09-08T10:00:00Z',
        message_count: 0,
        first_message: null,
        running: false,
        status: 'idle',
      },
    ];
    simulateInbound(ws, controlResult(id1, { sessions: legacyEntries }, true), fake);
    expect(ws.sessionList).toEqual(legacyEntries);
    // Switch to A — sessionList now reads from bucket A.
    ws.setCurrentSessionKey('A');
    expect(ws.sessionList).toBeNull();
    const id2 = ws.sendSessionList('/home/me');
    const aEntries: SessionListEntry[] = [
      {
        id: 'A1',
        name: null,
        cwd: '/home/me',
        created: '2026-09-08T11:00:00Z',
        modified: '2026-09-08T11:00:00Z',
        message_count: 0,
        first_message: null,
        running: false,
        status: 'idle',
      },
    ];
    simulateInbound(ws, controlResult(id2, { sessions: aEntries }, true, 'A'), fake);
    expect(ws.sessionList).toEqual(aEntries);
  });

  it('4.3 bucketFor(null) and bucketFor("m3-legacy") resolve to the same bucket', () => {
    const { ws } = makeConnectedWs();
    const a = ws.bucketFor(null);
    const b = ws.bucketFor(M3_LEGACY_KEY);
    expect(a).toBe(b);
  });

  it('4.4 bucketFor creates the bucket lazily on first read or write', () => {
    const { ws, fake } = makeConnectedWs();
    // First read: bucket doesn't exist yet → created with defaults.
    const b = ws.bucketFor('X');
    expect(b.messages).toEqual([]);
    expect(b.sessionPhase).toBeNull();
    // Subsequent writes land in the same bucket.
    simulateInbound(ws, sessionState('X', 'running', [], '/h'), fake);
    expect(ws.bucketFor('X').sessionPhase).toBe('running');
    // Reference identity preserved across reads.
    expect(ws.bucketFor('X')).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// setCurrentSessionKey / setCurrentWorkDir mirroring
// ---------------------------------------------------------------------------

describe('WsClient M4 task 08 — currentSessionKey / currentWorkDir mirrors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('5.1 setCurrentSessionKey updates the mirror + fan-out', () => {
    const { ws } = makeConnectedWs();
    expect(ws.currentSessionKey).toBeNull();
    ws.setCurrentSessionKey('A');
    expect(ws.currentSessionKey).toBe('A');
  });

  it('5.2 setCurrentSessionKey(null) clears the mirror', () => {
    const { ws } = makeConnectedWs();
    ws.setCurrentSessionKey('A');
    ws.setCurrentSessionKey(null);
    expect(ws.currentSessionKey).toBeNull();
  });

  it('5.3 setCurrentSessionKey same value is a no-op (identity stability)', () => {
    const { ws } = makeConnectedWs();
    ws.setCurrentSessionKey('A');
    let calls = 0;
    ws.subscribe(() => calls++);
    ws.setCurrentSessionKey('A');
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R4 stem 回填桶迁移 — review 修复轮核心场景
// ---------------------------------------------------------------------------

describe('WsClient M4 task 08 review R4 — stem refilled bucket migration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper: 模拟「新会话流」：用户在 'new' 桶累积早期状态，
  // bridge 派生 stem 后 broadcast session_state{session:<stem>}。
  function setupNewBucketWithAccumulatedState(
    ws: WsClient,
    fake: FakeWs,
    workDir: string,
  ): string {
    ws.setCurrentSessionKey('new');
    // bridge pending 期间首条 session_state 发 'new'（schema 兜底）。
    simulateInbound(ws, sessionState('new', 'spawning', [], workDir), fake);
    // 用户 prompt：本地 optimistic append (R2 fallback 链下事件落 'new' 桶)
    simulateInbound(
      ws,
      event('new', 'message_start', {
        assistantMessageEvent: { type: 'start' },
      }),
      fake,
    );
    simulateInbound(
      ws,
      event('new', 'message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'pending-text' },
      }),
      fake,
    );
    return 'pending-text';
  }

  it('7.1 stem refilled broadcast migrates new bucket → stem bucket (preserves messages + draft + queue)', () => {
    const { ws, fake } = makeConnectedWs();
    setupNewBucketWithAccumulatedState(ws, fake, '/h');
    // 'new' 桶累积 streamingDraft 文本（message_start 触发重置、
    // message_update text_delta 累积；message_end 才会 push 到
    // messages 数组；helper 不发 message_end 以保留 draft 状态
    // 验证迁移语义）。
    expect(ws.bucketFor('new').streamingDraft?.text).toBe('pending-text');
    // 同时验证 queue 也累积（pi 发的 queue_update 事件）——
    // 也应被迁移。
    simulateInbound(
      ws,
      event('new', 'queue_update', {
        steering: ['mid-stream-queued'],
        followUp: [],
      }),
      fake,
    );
    expect(ws.bucketFor('new').queue.steering).toEqual(['mid-stream-queued']);

    // Bridge 派生 stem 后 broadcast session_state{session:<stem>}
    // —— R4 触发迁移。App.tsx 即将通过 hashchange 改 currentSessionKey；
    // 这里仍为 'new' 也允许迁移（R4 守卫兼容 'new' 或 stem）。
    simulateInbound(
      ws,
      sessionState('realStem-abc', 'ready', [], '/h'),
      fake,
    );

    // 'new' 桶内容已搬到 stem 桶——所有字段保留（streamingDraft /
    // sessionPhase / workDir / queue / 等）。
    expect(ws.bucketFor('realStem-abc').streamingDraft?.text).toBe('pending-text');
    expect(ws.bucketFor('realStem-abc').sessionPhase).toBe('ready');
    expect(ws.bucketFor('realStem-abc').workDir).toBe('/h');
    expect(ws.bucketFor('realStem-abc').queue.steering).toEqual(['mid-stream-queued']);
    // 'new' 桶被删除——bucketFor('new') 重建为空桶（lazy
    // semantics），不再持有迁移前的累积状态。
    expect(ws.bucketFor('new').messages).toEqual([]);
    expect(ws.bucketFor('new').streamingDraft).toBeNull();
    expect(ws.bucketFor('new').queue).toEqual({ steering: [], followUp: [] });
  });

  it('7.2 after migration, fresh session-less events land in stem bucket (not new bucket)', () => {
    const { ws, fake } = makeConnectedWs();
    setupNewBucketWithAccumulatedState(ws, fake, '/h');
    // Bridge stem 派生。
    simulateInbound(ws, sessionState('realStem-abc', 'ready', [], '/h'), fake);
    // App.tsx 回填 hash 后 currentSessionKey 变 stem；后续事件落 stem 桶。
    ws.setCurrentSessionKey('realStem-abc');
    simulateInbound(
      ws,
      event(undefined, 'message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'post-stem-delta' },
      }),
      fake,
    );
    expect(ws.bucketFor('realStem-abc').streamingDraft?.text).toBe('pending-textpost-stem-delta');
    // 'new' 桶未被新事件污染（空桶重建）。
    expect(ws.bucketFor('new').streamingDraft).toBeNull();
  });

  it('7.3 work_dir mismatch prevents migration (defensive — different workDir new bucket not stolen)', () => {
    const { ws, fake } = makeConnectedWs();
    // user A pending 流（work_dir=/h）累积状态。
    setupNewBucketWithAccumulatedState(ws, fake, '/h');
    // bridge session_state{session:<stem>, work_dir:/other}——这
    // 不会发生（pending 流与 manager 必同 work_dir），但作为防
    // 御测试：work_dir 不匹配不迁移 'new' 桶内容。
    simulateInbound(
      ws,
      sessionState('realStem-abc', 'ready', [], '/other'),
      fake,
    );
    // 'new' 桶内容未动——仍持有累积（迁移未触发）。
    expect(ws.bucketFor('new').streamingDraft?.text).toBe('pending-text');
    // stem 桶**仍接收** session_state 入站的 phase 更新（该
    // 信封本身描述 stem 的状态）——这是正确的（不能因防御 R4
    // 迁移而丢弃 session_state 入站本身）。但其 work_dir 是
    // 新建的（不是从 'new' 桶搬来的 /h）。
    expect(ws.bucketFor('realStem-abc').sessionPhase).toBe('ready');
    expect(ws.bucketFor('realStem-abc').workDir).toBe('/other');
    // 关键：streamingDraft 未被迁移过来。
    expect(ws.bucketFor('realStem-abc').streamingDraft).toBeNull();
  });

  it('7.4 no new bucket → no-op (mature sessions never had pending state)', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentSessionKey('X');
    // User enters existing session — no 'new' bucket created.
    expect(ws.bucketFor('new').messages).toEqual([]);
    simulateInbound(
      ws,
      sessionState('existingStem', 'running', [], '/h'),
      fake,
    );
    expect(ws.bucketFor('existingStem').sessionPhase).toBe('running');
    // 'new' bucket remains empty (or didn't even exist).
    expect(ws.bucketFor('new').messages).toEqual([]);
  });

  it('7.5 currentSessionKey neither new nor stem prevents migration (user navigated away from pending)', () => {
    const { ws, fake } = makeConnectedWs();
    setupNewBucketWithAccumulatedState(ws, fake, '/h');
    // User navigated to session Y mid-flight (rare but defensive).
    ws.setCurrentSessionKey('Y');
    // Bridge stem 派生 broadcast 到达——不应劫持 'new' 桶
    // 归属 Y 的累积（不属于）。
    simulateInbound(ws, sessionState('realStem-abc', 'ready', [], '/h'), fake);
    // 'new' 桶内容未迁移——用户已离开 pending 流。
    expect(ws.bucketFor('new').streamingDraft?.text).toBe('pending-text');
    // stem 桶未从 'new' 桶获得迁移内容。
    expect(ws.bucketFor('realStem-abc').streamingDraft).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resetChatState — per-current-session reset (M3 cross-session invariant)
// ---------------------------------------------------------------------------

describe('WsClient M4 task 08 — resetChatState scope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('6.1 resetChatState clears the current session bucket only (background sessions preserved)', () => {
    const { ws, fake } = makeConnectedWs();
    // Fill A and B with chat state.
    ws.setCurrentSessionKey('A');
    simulateInbound(ws, sessionState('A', 'running', [], '/h'), fake);
    const id = ws.sendGetMessages();
    simulateInbound(ws, snapshot('A', id, [{ role: 'user', content: 'A1' }]), fake);
    expect(ws.bucketFor('A').messages).toHaveLength(1);
    expect(ws.bucketFor('A').sessionPhase).toBe('running');

    ws.setCurrentSessionKey('B');
    simulateInbound(ws, sessionState('B', 'running', [], '/h'), fake);
    const id2 = ws.sendGetMessages();
    simulateInbound(ws, snapshot('B', id2, [{ role: 'user', content: 'B1' }]), fake);
    expect(ws.bucketFor('B').messages).toHaveLength(1);

    // Switch back to A and reset — only A is wiped.
    ws.setCurrentSessionKey('A');
    ws.resetChatState();
    expect(ws.bucketFor('A').messages).toEqual([]);
    expect(ws.bucketFor('A').sessionPhase).toBeNull();
    // B is preserved.
    expect(ws.bucketFor('B').messages).toHaveLength(1);
    expect(ws.bucketFor('B').sessionPhase).toBe('running');
  });
});
