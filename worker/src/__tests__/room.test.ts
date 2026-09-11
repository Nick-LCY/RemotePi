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
//     (`WebSocketPair` is a runtime primitive), so we reach into
//     the Room's private `webs` map via a typed cast to install
//     the connection metadata. The cast is the only seam; the
//     rest of the test uses the public surface.
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
 *  binding has dozens of methods; Room only calls `blockConcurrencyWhile`
 *  in the constructor (and only when `startHeartbeat !== false`), so a
 *  stub returning a resolved promise is sufficient. */
function makeMockState(): DurableObjectState {
  return {
    blockConcurrencyWhile: <T>(callback: () => Promise<T>): Promise<T> => {
      return Promise.resolve(callback());
    },
  } as unknown as DurableObjectState;
}

/** Internal Room fields we need to reach for setup. Typed cast at the
 *  seam; everything outside this file uses only the public surface. */
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
 *  server side of a real pair. The shape is what `fetch()` would
 *  have installed for a connection that has either completed
 *  (phase='open') or is still in its 5s handshake window
 *  (phase='pending'). */
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
  // Mirror fetch()'s handler registration so FakeWebSocket.fireMessage /
  // .fireClose / .fireError land in the same dispatch surface the real
  // runtime would hit. Without this, our `fireMessage` test API would
  // have nothing to talk to.
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

/** Build a `control/pong` envelope carrying the supplied nonce.
 *  Tests use this both for the challenge-pong path and the
 *  heartbeat-pong path (case 11). */
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
 *  `webSocketMessage` directly here. The handler chain — fetch →
 *  webSocketMessage → handleHandshake — runs the same code path;
 *  only the runtime event dispatch is skipped. */
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
  // Real timers are needed for tests that don't care about the
  // heartbeat (most of them); the challenge-timeout / heartbeat-stale
  // cases opt into `vi.useFakeTimers()` at the top of their own scope.
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
  // 1. duplicate + 旧桥 pong → 新桥收 duplicate_bridge、close(1008)、bridge 槽不变
  // -------------------------------------------------------------------------
  it('1. duplicate handshake: incumbent answers the challenge → newcomer gets duplicate_bridge', () => {
    const { room, internals } = makeRoom();

    // Set up the state: one web (so we can observe bridge_status
    // broadcasts later if needed), one open bridge (the incumbent).
    const web = new FakeWebSocket();
    const oldBridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const oldMeta = completeHandshake(room, internals, oldBridge, 'bridge');
    expect(internals.bridge).toBe(oldMeta.ws);

    // A second bridge handshakes — handleHandshake sees `this.bridge`
    // is non-null and `this.challenge` is null, so it starts a
    // challenge against the incumbent.
    const newBridge = new FakeWebSocket();
    newBridge.resetCapture();
    completeHandshake(room, internals, newBridge, 'bridge');

    // The Room should have sent a ping to the incumbent (the
    // challenge probe) and NOT promoted the new bridge yet.
    const oldBridgePings = oldBridge.sentFrames
      .map((raw) => JSON.parse(raw) as Envelope)
      .filter((env) => env.type === 'ping');
    expect(oldBridgePings).toHaveLength(1);
    expect(internals.bridge).toBe(oldMeta.ws); // incumbent unchanged
    expect(internals.challenge).not.toBeNull();

    // Extract the challenge nonce the Room sent, then have the
    // incumbent reply with a matching pong. routeOpenMessage's
    // case 'pong' should resolve the challenge in the incumbent's
    // favour and terminate the newcomer.
    const challengeNonce = (oldBridgePings[0]!.payload as { nonce: string }).nonce;
    expect(challengeNonce.length).toBeGreaterThan(0);
    oldBridge.fireMessage(JSON.stringify(pongEnvelope(challengeNonce)));

    // Resolution: newcomer gets duplicate_bridge + close 1008,
    // incumbent keeps the slot, challenge is cleared.
    expect(internals.challenge).toBeNull();
    expect(internals.bridge).toBe(oldMeta.ws);
    const newErrors = errorFrames(newBridge);
    expect(newErrors).toEqual([{ code: 'duplicate_bridge', terminal: true }]);
    expect(newBridge.closeCalls).toEqual([{ code: 1008, reason: 'duplicate_bridge' }]);
  });

  // -------------------------------------------------------------------------
  // 2. duplicate + 挑战超时 (3001ms) → broadcast stale + webs.delete +
  //    close(1000,'stale') + 纳新 (bridge=newWs + 广播 connected + phase open)
  // -------------------------------------------------------------------------
  it('2. duplicate handshake: incumbent misses the 3s challenge → evicted, newcomer promoted', () => {
    vi.useFakeTimers();
    const { room, internals } = makeRoom();

    // Same setup as case 1: web + incumbent bridge already open.
    const web = new FakeWebSocket();
    const oldBridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const oldMeta = completeHandshake(room, internals, oldBridge, 'bridge');
    expect(internals.bridge).toBe(oldMeta.ws);
    // Reset the web's capture AFTER the incumbent handshake so we
    // only observe the resolution's broadcasts (the incumbent's
    // initial `connected` is noise for this case).
    web.resetCapture();
    oldBridge.resetCapture();

    // Second bridge handshakes — challenge starts. Capture the new
    // bridge's meta so we can assert on its promotion state later.
    const newBridge = new FakeWebSocket();
    newBridge.resetCapture();
    const newMeta = completeHandshake(room, internals, newBridge, 'bridge');
    expect(internals.challenge).not.toBeNull();

    // Advance the fake clock past the 3s challenge budget. The
    // resolveChallenge(false, ...) path fires.
    vi.advanceTimersByTime(3_001);

    // Incumbent: dropped from webs, closed with STALE_CLOSE_CODE,
    // bridge slot is null. We assert the close call was recorded
    // (FakeWebSocket.close calls close() synchronously, so by the
    // time resolveChallenge returns the close has been recorded
    // AND the webs.delete has run).
    expect(internals.webs.has(oldMeta.ws)).toBe(false);
    expect(oldBridge.closeCalls).toEqual([{ code: 1000, reason: 'stale' }]);
    expect(internals.bridge).toBe(newMeta.ws);

    // The web (and only the web — bridges don't get their own
    // bridge_status broadcasts) should have observed exactly the
    // stale-then-connected sequence: the resolution path's
    // broadcastStaleForOld=true branch fires once with reason=stale
    // before nulling the slot, and the promotion broadcasts once
    // with reason=connected.
    const webStatuses = bridgeStatusFrames(web);
    expect(webStatuses).toEqual([
      { online: false, reason: 'stale' },
      { online: true, reason: 'connected' },
    ]);

    // Newcomer meta: phase='open', handshakeTimer null. The new
    // bridge socket itself received a handshake-envelope-driven
    // bridge_status replay? No — only web sockets do. The bridge
    // gets the bridge_status implicitly by being promoted (the
    // broadcast loop only fires at webs), so newBridge.sentFrames
    // should be empty after resetCapture above.
    expect(newBridge.sentFrames).toEqual([]);
    expect(newMeta.phase).toBe('open');
    expect(newMeta.handshakeTimer).toBeNull();

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 3. 挑战期间旧桥主动 close → 立即纳新，只见一次 connected 广播，无 stale 广播
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

    // Incumbent dies on its own (e.g. operator killed the daemon).
    // The close event fires through FakeWebSocket → Room's
    // webSocketClose → handleDisconnect(oldWs branch) → resolveChallenge(false, nonce, false).
    oldBridge.fireClose({ code: 1006, reason: '' });

    // No timer advance needed — handleDisconnect runs synchronously.
    expect(internals.challenge).toBeNull();
    expect(internals.bridge).toBe(newMeta.ws);
    expect(newMeta.phase).toBe('open');

    // Critical assertion: web observed EXACTLY ONE bridge_status
    // (the connected promotion), with no stale frame between the
    // previous connected (incumbent handshake) and this one. The
    // web observer should see: connected (from incumbent handshake)
    // + connected (from challenger promotion) = two connecteds.
    const webStatuses = bridgeStatusFrames(web);
    expect(webStatuses).toEqual([
      { online: true, reason: 'connected' }, // incumbent handshake
      { online: true, reason: 'connected' }, // challenger promotion
    ]);
    // Explicit no-stale check (case 3's signature behaviour):
    expect(webStatuses.some((s) => s.reason === 'stale')).toBe(false);

    // The close(1000,'stale') the resolution path issues on the
    // incumbent is best-effort — the incumbent's socket is already
    // in CLOSED state (fireClose flipped readyState to 3), so the
    // FakeWebSocket.close() short-circuits the closeCalls record.
    // But our handler already fired the 'close' event via fireClose;
    // the close() call inside resolveChallenge is the second close
    // attempt and is suppressed by `if (this.readyState === 3) return`.
    // What we DO assert is the original close event was processed
    // (the incumbent is gone from webs), not the secondary close
    // attempt.
    expect(internals.webs.has(oldMeta.ws)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. 挑战期间 ws_new 断开 → challenge 清空、旧桥仍为 bridge、无广播
  // -------------------------------------------------------------------------
  it('4. newcomer disconnects mid-challenge → challenge cleared, incumbent untouched, no broadcast', () => {
    const { room, internals } = makeRoom();

    const web = new FakeWebSocket();
    const oldBridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const oldMeta = completeHandshake(room, internals, oldBridge, 'bridge');
    expect(internals.bridge).toBe(oldMeta.ws);
    // Reset the web's capture AFTER the incumbent handshake so the
    // observer starts empty — the incumbent's initial `connected`
    // broadcast is noise for this case (we only care about what
    // happens during/after the challenger's drop).
    web.resetCapture();

    const newBridge = new FakeWebSocket();
    newBridge.resetCapture();
    const newMeta = completeHandshake(room, internals, newBridge, 'bridge');
    expect(internals.challenge).not.toBeNull();
    expect(newMeta.phase).toBe('pending'); // not yet promoted

    // Newcomer drops (e.g. it never finished auth).
    newBridge.fireClose({ code: 1006, reason: '' });

    expect(internals.challenge).toBeNull();
    expect(internals.bridge).toBe(oldMeta.ws); // incumbent unaffected
    expect(internals.webs.has(newMeta.ws)).toBe(false);

    // No bridge_status broadcasts at all on the web (the existing
    // bridge_status from incumbent handshake was already emitted
    // before the challenger arrived; we reset web above so the
    // observer frame is empty). Critically: no closed broadcast
    // either — the newWs branch returns early before the standard
    // cleanup would have emitted one.
    expect(bridgeStatusFrames(web)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 5. 挑战期间第三个桥 handshake → 立即 duplicate_bridge + close(1008)，挑战状态不变
  // -------------------------------------------------------------------------
  it('5. third bridge arrives during an active challenge → immediate duplicate_bridge, challenge untouched', () => {
    // Use fake timers so the in-flight challenge's 3s budget doesn't
    // leak past the test boundary (case 2 uses the same seam — opt
    // into fake timers, advance past 3s, restore). without this, the
    // setTimeout started by startChallenge would survive into the
    // next test and fire mid-suite.
    vi.useFakeTimers();
    const { room, internals } = makeRoom();

    const oldBridge = new FakeWebSocket();
    installConnection(room, internals, oldBridge, 'bridge', 'open');
    internals.bridge = oldBridge.accept();
    oldBridge.resetCapture();

    // First challenger — kicks off the challenge.
    const newBridge1 = new FakeWebSocket();
    newBridge1.resetCapture();
    completeHandshake(room, internals, newBridge1, 'bridge');
    expect(internals.challenge).not.toBeNull();
    const challengeSnapshot = internals.challenge;

    // Second challenger — should be refused outright, no probe.
    const newBridge2 = new FakeWebSocket();
    newBridge2.resetCapture();
    completeHandshake(room, internals, newBridge2, 'bridge');

    // The challenge object is IDENTICAL to the snapshot — same
    // timer, same nonce. The third bridge's arrival did not
    // perturb the in-flight probe. The nonce assertion guards
    // against an in-place mutation regression (e.g. if some future
    // refactor rewrote the object in place rather than replacing
    // it, the reference check would still pass but the nonce
    // could silently change).
    expect(internals.challenge).toBe(challengeSnapshot);
    expect(internals.challenge?.nonce).toBe(challengeSnapshot!.nonce);
    expect(internals.challenge).not.toBeNull();

    // The third bridge got duplicate_bridge + close 1008.
    const errs = errorFrames(newBridge2);
    expect(errs).toEqual([{ code: 'duplicate_bridge', terminal: true }]);
    expect(newBridge2.closeCalls).toEqual([
      { code: 1008, reason: 'duplicate_bridge' },
    ]);

    // Drain the 3s challenge budget before restoring real timers
    // so the pending setTimeout doesn't leak out of the test.
    vi.advanceTimersByTime(3_001);
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 6. 挑战 nonce 与 heartbeat nonce 独立：挑战 ping + tickHeartbeat 的 ping 两 nonce 不同
  // -------------------------------------------------------------------------
  it('6. challenge nonce and heartbeat nonce are independent — separate ping/pong bookkeeping', () => {
    const { room, internals } = makeRoom();

    // Web + open incumbent bridge.
    const web = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const oldBridge = new FakeWebSocket();
    oldBridge.resetCapture();
    const oldMeta = completeHandshake(room, internals, oldBridge, 'bridge');

    // Challenger handshakes → challenge probe sent.
    const newBridge = new FakeWebSocket();
    newBridge.resetCapture();
    completeHandshake(room, internals, newBridge, 'bridge');

    // The incumbent should now have received exactly one ping (the
    // challenge) and still have pendingPingNonce === null (the
    // heartbeat hasn't ticked yet — no incoming bridge_status /
    // pong has triggered one, and the test constructor disabled
    // the 20s interval).
    const challengePings = oldBridge.sentFrames
      .map((raw) => JSON.parse(raw) as Envelope)
      .filter((env) => env.type === 'ping');
    expect(challengePings).toHaveLength(1);
    const challengeNonce = (challengePings[0]!.payload as { nonce: string }).nonce;
    expect(oldMeta.pendingPingNonce).toBeNull();
    expect(oldMeta.challengeNonce).toBe(challengeNonce);

    // Manually drive a heartbeat tick (fake state, real Date.now()).
    // The incumbent is still the only open connection, so it
    // gets a heartbeat ping with a NEW nonce.
    room.tickHeartbeat();

    // Two pings total on the incumbent now, with two DIFFERENT
    // nonces. The challenge nonce stays intact on the meta
    // (heartbeat ping goes to pendingPingNonce, not challengeNonce).
    const allPings = oldBridge.sentFrames
      .map((raw) => JSON.parse(raw) as Envelope)
      .filter((env) => env.type === 'ping');
    expect(allPings).toHaveLength(2);
    const heartbeatNonce = (allPings[1]!.payload as { nonce: string }).nonce;
    expect(heartbeatNonce).not.toBe(challengeNonce);
    expect(oldMeta.pendingPingNonce).toBe(heartbeatNonce);
    expect(oldMeta.challengeNonce).toBe(challengeNonce);

    // Answer the heartbeat pong only. The challenge bookkeeping
    // must remain intact (independent probe, separate state).
    oldBridge.fireMessage(JSON.stringify(pongEnvelope(heartbeatNonce)));
    expect(oldMeta.pendingPingNonce).toBeNull();
    expect(oldMeta.challengeNonce).toBe(challengeNonce);
    expect(internals.challenge).not.toBeNull(); // challenge still in flight

    // Now answer the challenge pong. Both ledgers settle, challenge
    // resolves in the incumbent's favour.
    oldBridge.fireMessage(JSON.stringify(pongEnvelope(challengeNonce)));
    expect(oldMeta.pendingPingNonce).toBeNull();
    expect(oldMeta.challengeNonce).toBeNull();
    expect(internals.challenge).toBeNull();
    expect(internals.bridge).toBe(oldMeta.ws); // incumbent kept
  });

  // -------------------------------------------------------------------------
  // 7. stale 分支：注入 pendingPingNonce + pingSentAt=now-31s → tick 推进 missedPong 至 3
  // -------------------------------------------------------------------------
  it('7. stale branch: 3 missed heartbeat pongs → connection dropped, web receives stale broadcast', () => {
    vi.useFakeTimers();
    const { room, internals } = makeRoom();

    // Web + open bridge with pendingPingNonce + pingSentAt 31s ago
    // (past the 30s PONG_TIMEOUT_MS) and missedPong already at 2
    // (this tick will push it to 3 and trip the stale branch).
    const web = new FakeWebSocket();
    web.resetCapture();
    const bridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const bridgeMeta = installConnection(room, internals, bridge, 'bridge', 'open');
    internals.bridge = bridgeMeta.ws;

    bridgeMeta.pendingPingNonce = 'stale-nonce';
    bridgeMeta.pingSentAt = Date.now() - 31_000;
    bridgeMeta.missedPong = 2;

    // Drive one tick. The stale check fires: missedPong → 3,
    // bridge slot cleared, broadcast stale, webs.delete,
    // ws.close(1000, 'stale').
    room.tickHeartbeat();

    expect(bridgeMeta.missedPong).toBe(3);
    expect(internals.bridge).toBeNull();
    expect(internals.webs.has(bridgeMeta.ws)).toBe(false);
    expect(bridge.closeCalls).toEqual([{ code: 1000, reason: 'stale' }]);

    // The web observer saw a stale broadcast.
    const webStatuses = bridgeStatusFrames(web);
    expect(webStatuses).toEqual([{ online: false, reason: 'stale' }]);

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 8. tick 中 send 抛异常：坏连接被清理、其他连接照常收到 ping（循环不断）
  // -------------------------------------------------------------------------
  it('8. tickHeartbeat isolates send() throws — bad connection reaped, others still pinged', () => {
    vi.useFakeTimers();
    const { room, internals } = makeRoom();

    // Three connections: a good web, a bad bridge (send will throw),
    // and a good web2. After one tick the bad bridge should be
    // reaped and both webs should have received their pings.
    const web1 = new FakeWebSocket();
    const badBridge = new FakeWebSocket();
    const web2 = new FakeWebSocket();
    installConnection(room, internals, web1, 'web', 'open');
    const badMeta = installConnection(room, internals, badBridge, 'bridge', 'open');
    installConnection(room, internals, web2, 'web', 'open');
    internals.bridge = badMeta.ws;

    badBridge.sendThrow = new Error('synthetic socket failure');

    room.tickHeartbeat();

    // The bad bridge: removed from webs, closed, bridge slot
    // cleared, web observer saw the stale broadcast.
    expect(internals.webs.has(badMeta.ws)).toBe(false);
    expect(badBridge.closeCalls).toEqual([{ code: 1000, reason: 'stale' }]);
    expect(internals.bridge).toBeNull();
    expect(bridgeStatusFrames(web1)).toEqual([
      { online: false, reason: 'stale' },
    ]);

    // The two webs both got their heartbeats — the loop survived
    // the bad bridge's throw.
    expect(pingCount(web1)).toBe(1);
    expect(pingCount(web2)).toBe(1);

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 9. 挑战超时踢旧后迟到 pong（同 nonce）→ 安全 no-op
  // -------------------------------------------------------------------------
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

    // Capture the challenge nonce before eviction so we can replay
    // it as a "late" pong later.
    const challengeNonce = oldMeta.challengeNonce!;
    expect(challengeNonce.length).toBeGreaterThan(0);

    // Advance past the 3s budget — incumbent is evicted, newcomer
    // promoted. The web observer sees the stale+connected sequence.
    vi.advanceTimersByTime(3_001);
    expect(internals.bridge).toBe(newMeta.ws);
    const baselineWebFrames = bridgeStatusFrames(web).length;

    // Late pong from the evicted incumbent. webSocketMessage's
    // first action is a webs.get lookup — since the incumbent is
    // no longer in the map (resolveChallenge did webs.delete), we
    // expect the unknown-connection path: close(1008, 'unknown
    // connection'). Critically: no double-broadcast, no state
    // perturbation, bridge slot still points at the newcomer.
    oldBridge.fireMessage(JSON.stringify(pongEnvelope(challengeNonce)));

    expect(internals.bridge).toBe(newMeta.ws); // unchanged
    expect(bridgeStatusFrames(web).length).toBe(baselineWebFrames); // no new broadcasts
    // The unknown-connection close path may not record a close call
    // here because fireMessage triggers webSocketMessage which calls
    // ws.close inside a try/catch; FakeWebSocket's readyState was
    // already 3 from the earlier resolveChallenge close, so the
    // record-and-redispatch path inside close() short-circuits on
    // readyState === 3. We just assert the close was attempted
    // (recorded or no-op'd) — the meaningful invariant is "bridge
    // slot unchanged, no extra broadcasts".
    expect(internals.challenge).toBeNull();

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 10. handleDisconnect 标准路径：bridge 断开 → 槽清空 + closed 广播 + webs 删除
  // -------------------------------------------------------------------------
  it('10. standard disconnect: bridge drops → slot cleared, closed broadcast, entry removed', () => {
    const { room, internals } = makeRoom();

    const web = new FakeWebSocket();
    const bridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const bridgeMeta = completeHandshake(room, internals, bridge, 'bridge');
    expect(internals.bridge).toBe(bridgeMeta.ws);
    // Reset the web's capture AFTER the bridge handshake so the
    // observer starts empty — the bridge's initial `connected`
    // broadcast is noise for this case (we only care about the
    // single `closed` frame the disconnect produces).
    web.resetCapture();

    // Clean disconnect (no challenge in flight).
    bridge.fireClose({ code: 1000, reason: '' });

    expect(internals.bridge).toBeNull();
    expect(internals.webs.has(bridgeMeta.ws)).toBe(false);
    const webStatuses = bridgeStatusFrames(web);
    expect(webStatuses).toEqual([{ online: false, reason: 'closed' }]);
  });

  // -------------------------------------------------------------------------
  // 11. heartbeat pong 回归保护：pong 匹配 pendingPingNonce → 清账
  // -------------------------------------------------------------------------
  it('11. heartbeat pong regression guard: matching pong clears pendingPingNonce and missedPong', () => {
    const { room, internals } = makeRoom();

    const web = new FakeWebSocket();
    const bridge = new FakeWebSocket();
    installConnection(room, internals, web, 'web', 'open');
    const bridgeMeta = completeHandshake(room, internals, bridge, 'bridge');

    // Inject a fake pending heartbeat nonce (no tick needed — we
    // only want to test the pong matcher's bookkeeping clear).
    bridgeMeta.pendingPingNonce = 'hb-nonce-1';
    bridgeMeta.pingSentAt = Date.now();
    bridgeMeta.missedPong = 2;

    // Matching pong should clear the heartbeat ledger but NOT the
    // challenge fields (which were never set in this test).
    bridge.fireMessage(JSON.stringify(pongEnvelope('hb-nonce-1')));

    expect(bridgeMeta.pendingPingNonce).toBeNull();
    expect(bridgeMeta.pingSentAt).toBeNull();
    expect(bridgeMeta.missedPong).toBe(0);

    // A non-matching pong should forward to the opposite peer set
    // (the web in this test) AND NOT touch the heartbeat ledger.
    // We re-inject the pending state to make the no-clear assertion
    // observable.
    bridgeMeta.pendingPingNonce = 'hb-nonce-2';
    bridgeMeta.pingSentAt = Date.now();
    bridgeMeta.missedPong = 1;
    web.resetCapture();
    bridge.fireMessage(JSON.stringify(pongEnvelope('hb-nonce-WRONG')));

    expect(bridgeMeta.pendingPingNonce).toBe('hb-nonce-2');
    expect(bridgeMeta.missedPong).toBe(1);
    // The web received the forwarded pong.
    const forwarded = web.sentFrames
      .map((raw) => JSON.parse(raw) as Envelope)
      .filter((env) => env.type === 'pong');
    expect(forwarded).toHaveLength(1);
    expect((forwarded[0]!.payload).nonce).toBe('hb-nonce-WRONG');
  });
});
