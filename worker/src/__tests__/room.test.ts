// Vitest specs for the Room DO (`worker/src/room.ts`) — covers the
// challenge-based takeover mechanism that fixes the bridge-zombie
// rejection loop, plus the heartbeat hygiene regressions that the
// same pass cleaned up. Strategy:
//
//   - Build a minimal mock `DurableObjectState` (only
//     `blockConcurrencyWhile` is exercised by Room) and pass
//     `startHeartbeat: false` to the Room constructor so the 20s
//     `setInterval` never fires and every tick can be driven
//     explicitly via `room.tickHeartbeat()`.
//   - Drive the Room's lifecycle by calling its public dispatch
//     methods (`webSocketMessage` / `webSocketClose` /
//     `webSocketError`) directly with `FakeWebSocket` handles. We
//     can't easily call `fetch()` outside the Workers runtime
//     (`WebSocketPair` is a runtime primitive), so we reach into the
//     Room's private `webs` map via a typed cast to install the
//     connection metadata. The cast is the only seam; the rest of
//     the test uses the public surface.
//
// Each case below corresponds to one bullet in the planner's test
// matrix. They're numbered 1–11 (not 1a/1b style — each case is
// self-contained, the comment header carries the matrix number for
// grep traceability).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../room.js';
import { FakeWebSocket } from './fake-ws.js';
import {
  PROTOCOL_VERSION,
  type BridgeStatusReason,
  type Envelope,
  type Role,
} from '@remotepi/shared';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

/** The minimum slice of `DurableObjectState` Room touches. The real
 *  binding has dozens of methods; Room only calls
 *  `blockConcurrencyWhile` in the constructor (and only when
 *  `startHeartbeat !== false`), so a stub returning a resolved
 *  promise is sufficient. */
function makeMockState(): DurableObjectState {
  return {
    blockConcurrencyWhile: <T>(callback: () => Promise<T>): Promise<T> => {
      return Promise.resolve(callback());
    },
  } as unknown as DurableObjectState;
}

/** Internal Room fields we need to reach for setup. Typed cast at
 *  the seam; everything outside this file uses only the public
 *  surface. */
interface RoomInternals {
  webs: Map<WebSocket, ConnMetaShape>;
  bridge: WebSocket | null;
  challenge: {
    oldWs: WebSocket;
    newWs: WebSocket;
    nonce: string;
    timer: ReturnType<typeof setTimeout>;
    startedAt: number;
  } | null;
}

// We can't import the private `ConnMeta` type from room.ts (it's not
// exported), so we describe the shape structurally. Anything we
// actually USE in the test gets a name; the rest are typed `unknown`
// to keep the file from sprawling.
type ConnMetaShape = {
  ws: WebSocket;
  role: Role;
  phase: 'pending' | 'open';
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  pendingPingNonce: string | null;
  pingSentAt: number | null;
  missedPong: number;
  challengeNonce: string | null;
  challengeSentAt: number | null;
};

function asInternals(room: Room): RoomInternals {
  return room as unknown as RoomInternals;
}

/** Build a Room with the test-seam constructor args. Returns the
 *  Room plus a back-channel to its private state for setup. */
function makeRoom(): {
  room: Room;
  internals: ReturnType<typeof asInternals>;
} {
  const room = new Room(makeMockState(), {} as never, { startHeartbeat: false });
  return { room, internals: asInternals(room) };
}

/** Inject a connection metadata entry directly into the Room's
 *  private `webs` map and wire the FakeWebSocket's event handlers to
 *  the Room's dispatch methods. We bypass `fetch()` because
 *  `WebSocketPair` is a Workers runtime primitive not available in
 *  `node`; the handlers here mirror what `fetch()` registers on the
 *  server side of a real pair. */
function installConnection(
  room: Room,
  internals: ReturnType<typeof asInternals>,
  sock: FakeWebSocket,
  role: Role,
  phase: 'pending' | 'open',
): ConnMetaShape {
  const meta: ConnMetaShape = {
    ws: sock.accept(),
    role,
    phase,
    handshakeTimer: null,
    pendingPingNonce: null,
    pingSentAt: null,
    missedPong: 0,
    challengeNonce: null,
    challengeSentAt: null,
  };
  // Mirror fetch()'s handler registration so FakeWebSocket.fireMessage
  // / .fireClose / .fireError land in the same dispatch surface the
  // real runtime would hit.
  sock.addEventListener('message', (event) => {
    const data = (event as { data: unknown }).data;
    if (typeof data === 'string' || data instanceof ArrayBuffer) {
      room.webSocketMessage(meta.ws, data);
    }
  });
  sock.addEventListener('close', (event) => {
    const ev = event as { code: number; reason: string; wasClean: boolean };
    room.webSocketClose(meta.ws, ev.code, ev.reason, ev.wasClean);
  });
  sock.addEventListener('error', () => {
    room.webSocketError(meta.ws, new Error('fake ws error'));
  });
  internals.webs.set(meta.ws, meta);
  return meta;
}

/** Build a fully-formed `control/handshake` envelope. The Room's
 *  handshake gate requires role to match the connection's expected
 *  role (set on meta) — passing a mismatched role is a useful
 *  negative-case test seam too. */
function handshakeEnvelope(role: Role): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: 'control',
    type: 'handshake',
    id: crypto.randomUUID(),
    payload: { role, token: 'TEST-TOKEN' },
  };
}

/** Build a `control/pong` envelope carrying the supplied nonce. */
function pongEnvelope(nonce: string): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: 'control',
    type: 'pong',
    id: crypto.randomUUID(),
    payload: { nonce },
  };
}

/** Extract every `bridge_status` frame the Room has broadcast on the
 *  supplied FakeWebSocket (typically a web). Returns just the
 *  payload so tests can assert on (online, reason) without
 *  re-parsing the envelope wrapper. */
function bridgeStatusFrames(sock: FakeWebSocket): Array<{ online: boolean; reason: BridgeStatusReason }> {
  return sock.sentFrames
    .map((raw) => JSON.parse(raw) as Envelope)
    .filter((env) => env.type === 'bridge_status')
    .map((env) => {
      // `bridge_status` envelope payload is `{ online, changed_at, reason }`
      // — narrow to the two fields the tests care about.
      const payload = env.payload as { online: boolean; reason: BridgeStatusReason };
      return { online: payload.online, reason: payload.reason };
    });
}

/** Extract every `error` frame the Room has sent on the supplied
 *  FakeWebSocket. Returns just the (code, terminal) so tests can
 *  assert on the rejection without re-parsing the envelope wrapper. */
function errorFrames(sock: FakeWebSocket): Array<{ code: string; terminal: boolean }> {
  return sock.sentFrames
    .map((raw) => JSON.parse(raw) as Envelope)
    .filter((env) => env.type === 'error')
    .map((env) => {
      const payload = env.payload as { code: string; terminal: boolean };
      return { code: payload.code, terminal: payload.terminal };
    });
}

/** Count how many `control/ping` envelopes the Room has sent on the
 *  supplied socket. Used by case 8 to confirm a single bad send
 *  doesn't kill the heartbeat round. */
function pingCount(sock: FakeWebSocket): number {
  return sock.sentFrames.filter((raw) => {
    const env = JSON.parse(raw) as Envelope;
    return env.type === 'ping';
  }).length;
}

/** Drive a handshake to completion on a fake socket. The Room's
 *  `fetch()` registers the message/close/error handlers on the
 *  server side of the `WebSocketPair` and then dispatches via
 *  `webSocketMessage`. Since we bypass `fetch()` (we can't build a
 *  `WebSocketPair` outside the Workers runtime), we call
 *  `webSocketMessage` directly here. The handler chain runs the same
 *  code path; only the runtime event dispatch is skipped. */
function completeHandshake(
  room: Room,
  internals: ReturnType<typeof asInternals>,
  sock: FakeWebSocket,
  role: Role,
): ConnMetaShape {
  const meta = installConnection(room, internals, sock, role, 'pending');
  room.webSocketMessage(meta.ws, JSON.stringify(handshakeEnvelope(role)));
  return meta;
}

// ---------------------------------------------------------------------------
// Lifecycle reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Real timers for tests that don't care about the heartbeat; the
  // challenge-timeout / heartbeat-stale cases opt into
  // `vi.useFakeTimers()` at the top of their own scope.
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// Tests
// ===========================================================================

describe('Room — challenge-based takeover of a duplicate bridge handshake', () => {
  // -------------------------------------------------------------------------
  // 1. duplicate + incumbent pong → newcomer gets duplicate_bridge, close 1008
  // -------------------------------------------------------------------------
  it('1. duplicate handshake: incumbent answers the challenge → newcomer gets duplicate_bridge', () => {
    const { room, internals } = makeRoom();

    const web = new FakeWebSocket();
    const oldBridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const oldMeta = completeHandshake(room, internals, oldBridge, 'bridge');
    expect(internals.bridge).toBe(oldMeta.ws);

    const newBridge = new FakeWebSocket();
    newBridge.resetCapture();
    completeHandshake(room, internals, newBridge, 'bridge');

    const oldBridgePings = oldBridge.sentFrames
      .map((raw) => JSON.parse(raw) as Envelope)
      .filter((env) => env.type === 'ping');
    expect(oldBridgePings).toHaveLength(1);
    expect(internals.bridge).toBe(oldMeta.ws);
    expect(internals.challenge).not.toBeNull();

    const challengeNonce = (oldBridgePings[0]!.payload as { nonce: string }).nonce;
    expect(challengeNonce.length).toBeGreaterThan(0);
    oldBridge.fireMessage(JSON.stringify(pongEnvelope(challengeNonce)));

    expect(internals.challenge).toBeNull();
    expect(internals.bridge).toBe(oldMeta.ws);
    const newErrors = errorFrames(newBridge);
    expect(newErrors).toEqual([{ code: 'duplicate_bridge', terminal: true }]);
    expect(newBridge.closeCalls).toEqual([{ code: 1008, reason: 'duplicate_bridge' }]);
  });

  // -------------------------------------------------------------------------
  // 2. duplicate + 3s challenge timeout → broadcast stale + evict incumbent
  //    + promote newcomer
  // -------------------------------------------------------------------------
  it('2. duplicate handshake: incumbent misses the 3s challenge → evicted, newcomer promoted', () => {
    vi.useFakeTimers();
    const { room, internals } = makeRoom();

    const web = new FakeWebSocket();
    const oldBridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const oldMeta = completeHandshake(room, internals, oldBridge, 'bridge');
    expect(internals.bridge).toBe(oldMeta.ws);
    web.resetCapture();
    oldBridge.resetCapture();

    const newBridge = new FakeWebSocket();
    newBridge.resetCapture();
    const newMeta = completeHandshake(room, internals, newBridge, 'bridge');
    expect(internals.challenge).not.toBeNull();

    vi.advanceTimersByTime(3_001);

    expect(internals.webs.has(oldMeta.ws)).toBe(false);
    expect(oldBridge.closeCalls).toEqual([{ code: 1000, reason: 'stale' }]);
    expect(internals.bridge).toBe(newMeta.ws);

    // Web observes stale-then-connected (the resolution path's
    // broadcastStaleForOld=true branch fires once with reason=stale,
    // then the promotion broadcasts once with reason=connected).
    const webStatuses = bridgeStatusFrames(web);
    expect(webStatuses).toEqual([
      { online: false, reason: 'stale' },
      { online: true, reason: 'connected' },
    ]);

    expect(newBridge.sentFrames).toEqual([]);
    expect(newMeta.phase).toBe('open');
    expect(newMeta.handshakeTimer).toBeNull();

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 3. incumbent dies mid-challenge → immediate promotion, no stale broadcast
  //    (avoids the connected → stale → connected flicker)
  // -------------------------------------------------------------------------
  it('3. incumbent disconnects mid-challenge → immediate promotion, no stale broadcast', () => {
    const { room, internals } = makeRoom();

    const web = new FakeWebSocket();
    web.resetCapture();
    const oldBridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const oldMeta = completeHandshake(room, internals, oldBridge, 'bridge');

    const newBridge = new FakeWebSocket();
    newBridge.resetCapture();
    const newMeta = completeHandshake(room, internals, newBridge, 'bridge');
    expect(internals.challenge).not.toBeNull();

    oldBridge.fireClose({ code: 1006, reason: '' });

    expect(internals.challenge).toBeNull();
    expect(internals.bridge).toBe(newMeta.ws);
    expect(newMeta.phase).toBe('open');

    const webStatuses = bridgeStatusFrames(web);
    expect(webStatuses).toEqual([
      { online: true, reason: 'connected' }, // incumbent handshake
      { online: true, reason: 'connected' }, // challenger promotion
    ]);
    // regression guard: case 3's signature behaviour is "no stale broadcast"
    expect(webStatuses.some((s) => s.reason === 'stale')).toBe(false);

    expect(internals.webs.has(oldMeta.ws)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. newcomer disconnects mid-challenge → challenge cleared, incumbent
  //    untouched, no broadcast
  // -------------------------------------------------------------------------
  it('4. newcomer disconnects mid-challenge → challenge cleared, incumbent untouched, no broadcast', () => {
    const { room, internals } = makeRoom();

    const web = new FakeWebSocket();
    const oldBridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const oldMeta = completeHandshake(room, internals, oldBridge, 'bridge');
    expect(internals.bridge).toBe(oldMeta.ws);
    web.resetCapture();

    const newBridge = new FakeWebSocket();
    newBridge.resetCapture();
    const newMeta = completeHandshake(room, internals, newBridge, 'bridge');
    expect(internals.challenge).not.toBeNull();
    expect(newMeta.phase).toBe('pending');

    newBridge.fireClose({ code: 1006, reason: '' });

    expect(internals.challenge).toBeNull();
    expect(internals.bridge).toBe(oldMeta.ws);
    expect(internals.webs.has(newMeta.ws)).toBe(false);

    // No `closed` broadcast — the newWs branch returns early before
    // the standard cleanup would emit one.
    expect(bridgeStatusFrames(web)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 5. third bridge arrives during active challenge → immediate
  //    duplicate_bridge + close 1008; the in-flight challenge is
  //    left untouched (same timer, same nonce)
  // -------------------------------------------------------------------------
  it('5. third bridge arrives during an active challenge → immediate duplicate_bridge, challenge untouched', () => {
    // Fake timers so the in-flight challenge's 3s budget doesn't
    // leak past the test boundary. Without this, the setTimeout
    // started by startChallenge would survive into the next test
    // and fire mid-suite.
    vi.useFakeTimers();
    const { room, internals } = makeRoom();

    const oldBridge = new FakeWebSocket();
    installConnection(room, internals, oldBridge, 'bridge', 'open');
    internals.bridge = oldBridge.accept();
    oldBridge.resetCapture();

    const newBridge1 = new FakeWebSocket();
    newBridge1.resetCapture();
    completeHandshake(room, internals, newBridge1, 'bridge');
    expect(internals.challenge).not.toBeNull();
    const challengeSnapshot = internals.challenge;

    const newBridge2 = new FakeWebSocket();
    newBridge2.resetCapture();
    completeHandshake(room, internals, newBridge2, 'bridge');

    // Regression: the challenge object is IDENTICAL to the snapshot
    // — same timer, same nonce. Guards against an in-place mutation
    // regression (reference identity could survive a refactor while
    // the nonce silently changes).
    expect(internals.challenge).toBe(challengeSnapshot);
    expect(internals.challenge?.nonce).toBe(challengeSnapshot!.nonce);
    expect(internals.challenge).not.toBeNull();

    const errs = errorFrames(newBridge2);
    expect(errs).toEqual([{ code: 'duplicate_bridge', terminal: true }]);
    expect(newBridge2.closeCalls).toEqual([
      { code: 1008, reason: 'duplicate_bridge' },
    ]);

    vi.advanceTimersByTime(3_001);
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 6. challenge nonce and heartbeat nonce are independent probes —
  //    separate ping/pong bookkeeping, separate ledgers
  // -------------------------------------------------------------------------
  it('6. challenge nonce and heartbeat nonce are independent — separate ping/pong bookkeeping', () => {
    const { room, internals } = makeRoom();

    const web = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const oldBridge = new FakeWebSocket();
    oldBridge.resetCapture();
    const oldMeta = completeHandshake(room, internals, oldBridge, 'bridge');

    const newBridge = new FakeWebSocket();
    newBridge.resetCapture();
    completeHandshake(room, internals, newBridge, 'bridge');

    const challengePings = oldBridge.sentFrames
      .map((raw) => JSON.parse(raw) as Envelope)
      .filter((env) => env.type === 'ping');
    expect(challengePings).toHaveLength(1);
    const challengeNonce = (challengePings[0]!.payload as { nonce: string }).nonce;
    expect(oldMeta.pendingPingNonce).toBeNull();
    expect(oldMeta.challengeNonce).toBe(challengeNonce);

    // Manually drive a heartbeat tick — incumbent gets a fresh ping.
    room.tickHeartbeat();

    const allPings = oldBridge.sentFrames
      .map((raw) => JSON.parse(raw) as Envelope)
      .filter((env) => env.type === 'ping');
    expect(allPings).toHaveLength(2);
    const heartbeatNonce = (allPings[1]!.payload as { nonce: string }).nonce;
    expect(heartbeatNonce).not.toBe(challengeNonce);
    expect(oldMeta.pendingPingNonce).toBe(heartbeatNonce);
    expect(oldMeta.challengeNonce).toBe(challengeNonce);

    oldBridge.fireMessage(JSON.stringify(pongEnvelope(heartbeatNonce)));
    expect(oldMeta.pendingPingNonce).toBeNull();
    expect(oldMeta.challengeNonce).toBe(challengeNonce);
    expect(internals.challenge).not.toBeNull();

    oldBridge.fireMessage(JSON.stringify(pongEnvelope(challengeNonce)));
    expect(oldMeta.pendingPingNonce).toBeNull();
    expect(oldMeta.challengeNonce).toBeNull();
    expect(internals.challenge).toBeNull();
    expect(internals.bridge).toBe(oldMeta.ws);
  });

  // -------------------------------------------------------------------------
  // 7. stale branch: 3 missed heartbeat pongs → connection dropped,
  //    web receives stale broadcast
  // -------------------------------------------------------------------------
  it('7. stale branch: 3 missed heartbeat pongs → connection dropped, web receives stale broadcast', () => {
    vi.useFakeTimers();
    const { room, internals } = makeRoom();

    // Bridge: pendingPingNonce + pingSentAt 31s ago (past the 30s
    // PONG_TIMEOUT_MS), missedPong already at 2 — this tick pushes
    // it to 3 and trips the stale branch.
    const web = new FakeWebSocket();
    web.resetCapture();
    const bridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const bridgeMeta = installConnection(room, internals, bridge, 'bridge', 'open');
    internals.bridge = bridgeMeta.ws;

    bridgeMeta.pendingPingNonce = 'stale-nonce';
    bridgeMeta.pingSentAt = Date.now() - 31_000;
    bridgeMeta.missedPong = 2;

    room.tickHeartbeat();

    expect(bridgeMeta.missedPong).toBe(3);
    expect(internals.bridge).toBeNull();
    expect(internals.webs.has(bridgeMeta.ws)).toBe(false);
    expect(bridge.closeCalls).toEqual([{ code: 1000, reason: 'stale' }]);

    const webStatuses = bridgeStatusFrames(web);
    expect(webStatuses).toEqual([{ online: false, reason: 'stale' }]);

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 8. tickHeartbeat isolates send() throws — bad connection reaped,
  //    others still pinged (the loop survives one poisoned socket)
  // -------------------------------------------------------------------------
  it('8. tickHeartbeat isolates send() throws — bad connection reaped, others still pinged', () => {
    vi.useFakeTimers();
    const { room, internals } = makeRoom();

    const web1 = new FakeWebSocket();
    const badBridge = new FakeWebSocket();
    const web2 = new FakeWebSocket();
    installConnection(room, internals, web1, 'web', 'open');
    const badMeta = installConnection(room, internals, badBridge, 'bridge', 'open');
    installConnection(room, internals, web2, 'web', 'open');
    internals.bridge = badMeta.ws;

    badBridge.sendThrow = new Error('synthetic socket failure');

    room.tickHeartbeat();

    expect(internals.webs.has(badMeta.ws)).toBe(false);
    expect(badBridge.closeCalls).toEqual([{ code: 1000, reason: 'stale' }]);
    expect(internals.bridge).toBeNull();
    expect(bridgeStatusFrames(web1)).toEqual([
      { online: false, reason: 'stale' },
    ]);

    expect(pingCount(web1)).toBe(1);
    expect(pingCount(web2)).toBe(1);

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 9. late pong from evicted incumbent after challenge-timeout
  //    eviction → safe no-op (no double-broadcast, no state perturbation)
  // -------------------------------------------------------------------------
  // regression: 挑战超时后迟到 pong 必须 no-op
  it('9. late pong from evicted incumbent after challenge-timeout eviction → safe no-op', () => {
    vi.useFakeTimers();
    const { room, internals } = makeRoom();

    const web = new FakeWebSocket();
    web.resetCapture();
    const oldBridge = new FakeWebSocket();
    oldBridge.resetCapture();
    installConnection(room, internals, web, 'web', 'open');
    const oldMeta = completeHandshake(room, internals, oldBridge, 'bridge');

    const newBridge = new FakeWebSocket();
    newBridge.resetCapture();
    const newMeta = completeHandshake(room, internals, newBridge, 'bridge');

    const challengeNonce = oldMeta.challengeNonce!;
    expect(challengeNonce.length).toBeGreaterThan(0);

    vi.advanceTimersByTime(3_001);
    expect(internals.bridge).toBe(newMeta.ws);
    const baselineWebFrames = bridgeStatusFrames(web).length;

    oldBridge.fireMessage(JSON.stringify(pongEnvelope(challengeNonce)));

    expect(internals.bridge).toBe(newMeta.ws);
    expect(bridgeStatusFrames(web).length).toBe(baselineWebFrames);
    // The unknown-connection close path may not record a close call
    // (FakeWebSocket.readyState is already 3 from the earlier
    // resolveChallenge close, so the record-and-redispatch path
    // inside close() short-circuits on readyState === 3). The
    // meaningful invariant is "bridge slot unchanged, no extra
    // broadcasts" — asserted above.
    expect(internals.challenge).toBeNull();

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 10. standard disconnect: bridge drops → slot cleared, closed
  //     broadcast, entry removed
  // -------------------------------------------------------------------------
  it('10. standard disconnect: bridge drops → slot cleared, closed broadcast, entry removed', () => {
    const { room, internals } = makeRoom();

    const web = new FakeWebSocket();
    const bridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const bridgeMeta = completeHandshake(room, internals, bridge, 'bridge');
    expect(internals.bridge).toBe(bridgeMeta.ws);
    web.resetCapture();

    bridge.fireClose({ code: 1000, reason: '' });

    expect(internals.bridge).toBeNull();
    expect(internals.webs.has(bridgeMeta.ws)).toBe(false);
    const webStatuses = bridgeStatusFrames(web);
    expect(webStatuses).toEqual([{ online: false, reason: 'closed' }]);
  });

  // -------------------------------------------------------------------------
  // 11. heartbeat pong regression guard: matching pong clears the
  //     heartbeat ledger; non-matching pong forwards without clearing
  // -------------------------------------------------------------------------
  // regression: heartbeat pong 匹配 pendingPingNonce 必须清账
  it('11. heartbeat pong regression guard: matching pong clears pendingPingNonce and missedPong', () => {
    const { room, internals } = makeRoom();

    const web = new FakeWebSocket();
    const bridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const bridgeMeta = completeHandshake(room, internals, bridge, 'bridge');

    bridgeMeta.pendingPingNonce = 'hb-nonce-1';
    bridgeMeta.pingSentAt = Date.now();
    bridgeMeta.missedPong = 2;

    bridge.fireMessage(JSON.stringify(pongEnvelope('hb-nonce-1')));

    expect(bridgeMeta.pendingPingNonce).toBeNull();
    expect(bridgeMeta.pingSentAt).toBeNull();
    expect(bridgeMeta.missedPong).toBe(0);

    // Non-matching pong: forwards to the opposite peer set (the web)
    // and must NOT clear the heartbeat ledger — a peer that forwards
    // pongs faster than it answers our heartbeats would never be
    // declared stale otherwise.
    bridgeMeta.pendingPingNonce = 'hb-nonce-2';
    bridgeMeta.pingSentAt = Date.now();
    bridgeMeta.missedPong = 1;
    web.resetCapture();
    bridge.fireMessage(JSON.stringify(pongEnvelope('hb-nonce-WRONG')));

    expect(bridgeMeta.pendingPingNonce).toBe('hb-nonce-2');
    expect(bridgeMeta.missedPong).toBe(1);
    const forwarded = web.sentFrames
      .map((raw) => JSON.parse(raw) as Envelope)
      .filter((env) => env.type === 'pong');
    expect(forwarded).toHaveLength(1);
    expect((forwarded[0]!.payload).nonce).toBe('hb-nonce-WRONG');
  });
});
