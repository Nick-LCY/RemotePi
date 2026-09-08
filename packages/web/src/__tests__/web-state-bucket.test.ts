// Vitest specs for the M4 WsClient per-session bucket store added in
// tasks/m4/08 (PRD §4.3 + §4.4 + §4.5 + §4.6).
//
// Surface under test:
//   - Outbound session auto-fill (all pi commands + control/get_state
//     + control/session_list stamp `envelope.session` from
//     `currentSessionKey`).
//   - Inbound routing (session_state / snapshot / command_result /
//     event / get_state reply / session_list reply) write to the
//     matching bucket by `envelope.session`; session-less inbound
//     lands in the M3_LEGACY bucket.
//   - Cross-session isolation: bucket A's messages / streamingDraft /
//     queue / phase / blockedOn / workDir are NOT touched by inbound
//     with `envelope.session === B` (the "错路由防护" the PRD §风险
//     section calls out for task 08 coverage).
//   - session_list reply: per-task-08 W2 — only updates the mirror in
//     the matching bucket (the current session's, or the
//     M3_LEGACY bucket when `currentSessionKey === null`).
//   - `bucketFor(null)` / `bucketFor('m3-legacy')` resolve to the
//     same M3_LEGACY bucket (M3-compat path for E2E 3 scenarios).
//   - `setCurrentSessionKey` / `setCurrentWorkDir` mirror the URL
//     hash; the back-compat top-level getters (`client.messages` /
//     `client.sessionPhase` / `client.blockedOn` / `client.queue` /
//     `client.streamingDraft` / `client.sessionList`) resolve to the
//     current session's bucket.

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

  it('2.4 session-less inbound (M3_LEGACY path) lands in M3_LEGACY bucket', () => {
    const { ws, fake } = makeConnectedWs();
    simulateInbound(
      ws,
      sessionState(undefined, 'ready', [], '/home/me'),
      fake,
    );
    expect(ws.bucketFor(M3_LEGACY_KEY).sessionPhase).toBe('ready');
    expect(ws.bucketFor('any-other').sessionPhase).toBeNull();
  });

  it('2.5 session=literal "new" still routes to bucket key "new" (bridge pending key)', () => {
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
