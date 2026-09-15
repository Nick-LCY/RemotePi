// Room Durable Object — one Room per token (via idFromName(token) in
// index.ts). Owns the per-token tunnel, the bridge slot, and the in-memory
// connection bookkeeping. Imported in env.ts so wrangler can discover the
// class for binding resolution.
//
// Wire-level dispatch contract (per control.md §中间层处理规则):
// the DO deeply handles only `handshake` / `bridge_status` / `error`,
// and `ping` / `pong` carry special nonce-pairing semantics for the
// heartbeat + the duplicate-bridge challenge. Every other envelope type
// — the rest of the control family (session_state, session_list,
// get_state, result, work_dirs) and the entire pi family — passes
// through verbatim via `forwardToOpposite`. The `default` branch in
// `routeOpenMessage` is the catch-all that enforces this contract.
//
// Duplicate-bridge handshake: if a second bridge handshakes while the
// incumbent still occupies `this.bridge` (the race a 1006 abnormal
// close leaves behind when workerd doesn't dispatch a close/error),
// we don't reject immediately — we run `startChallenge`, a 3s ping probe
// against the incumbent. If the incumbent answers, the new comer is
// refused (duplicate_bridge); if the budget elapses, the incumbent is
// evicted and the challenger promoted. This closes the "stale socket
// holds the slot, every fresh reconnect is permanently refused" loop.
// The challenge nonce is tracked independently of the heartbeat's
// `pendingPingNonce` so the two probes stay fully orthogonal.
import {
  PROTOCOL_VERSION,
  Envelope,
  type Role,
  type BridgeStatusReason,
  type ErrorCode,
} from '@remotepi/shared';
import type { Env } from './env.js';
import {
  PONG_TIMEOUT_MS,
  MAX_MISSED_PONGS,
  HANDSHAKE_TIMEOUT_MS,
  startHeartbeat,
} from './heartbeat.js';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/** WebSocket close code for terminal-error frames (control.md §配套常量). */
const FATAL_CLOSE_CODE = 1008;
/** The one subprotocol selected for every authenticated worker upgrade. */
const SUBPROTOCOL_VERSION = 'remotepi.v1';
/** WebSocket close code used when the heartbeat declares a connection stale. */
const STALE_CLOSE_CODE = 1000;
/** Challenge ping budget for the "is the incumbent bridge alive?" probe we
 *  fire when a *second* bridge handshakes before the first one has visibly
 *  disconnected. 3000ms is intentionally tight and sits between the
 *  per-message handshake window (5s) and the heartbeat cycle (20s): a
 *  healthy local bridge answers its own `control/ping` in well under a
 *  millisecond (the pong leaves before the ping has even left the
 *  worker's outbound queue), so 3s is a comfortable ceiling for a real
 *  connection while still fast enough that a human watching the web UI
 *  sees no perceptible pause. Crucially this is fully orthogonal to the
 *  heartbeat's `PONG_TIMEOUT_MS=30_000` and `PING_INTERVAL_MS=20_000` — the
 *  challenge has nothing to do with the running heartbeat, only with the
 *  "is this socket actually open?" question the duplicate-handshake race
 *  exposes. See handleHandshake / startChallenge / resolveChallenge. */
const CHALLENGE_TIMEOUT_MS = 3_000;

const ROLE_HEADER = 'x-remotepi-role';

function isRole(value: string): value is Role {
  return value === 'web' || value === 'bridge';
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

type ConnPhase = 'pending' | 'open';

interface ConnMeta {
  /** WebSocket server side — the half the runtime dispatches messages to. */
  readonly ws: WebSocket;
  readonly role: Role;
  phase: ConnPhase;
  /** 5-second handshake deadline; cleared once handshake completes. */
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  /** Nonce the DO sent on its last heartbeat ping, awaiting a matching pong. */
  pendingPingNonce: string | null;
  /** Wall-clock ms when `pendingPingNonce` was sent — used for the 30s budget. */
  pingSentAt: number | null;
  /** Count of consecutive heartbeat timeouts. Reset on a matching pong. */
  missedPong: number;
  /** Nonce of the most recent challenge ping, awaiting a matching pong from
   *  this incumbent bridge. Independent of `pendingPingNonce` because the
   *  challenge is a one-shot probe with its own budget, not a heartbeat
   *  cycle — coupling them would let a slow-but-alive bridge clear a
   *  pending heartbeat nonce by answering the challenge, masking a real
   *  stale connection. Set by `startChallenge`, cleared by
   *  `resolveChallenge` or by handleDisconnect when the connection drops
   *  mid-challenge. */
  challengeNonce: string | null;
  /** Wall-clock ms when `challengeNonce` was sent — diagnostic only; the
   *  challenge uses an absolute `CHALLENGE_TIMEOUT_MS` budget inside the
   *  `Room.challenge.timer` rather than reading this back at resolve time.
   *  Kept on the meta for log/observability and so the disconnect path
   *  has a structured handle to clear (instead of poking private fields). */
  challengeSentAt: number | null;
}

// ---------------------------------------------------------------------------
// Room DO
// ---------------------------------------------------------------------------

export class Room implements DurableObject {
  /** Per-connection map — the WebSocket server is the stable key. The runtime
   *  uses the same object as the dispatch handle in `webSocketMessage` etc. */
  private readonly webs = new Map<WebSocket, ConnMeta>();
  /** The single allowed bridge for this token (control.md §1: duplicate_bridge). */
  private bridge: WebSocket | null = null;
  /** Last bridge_status we announced; replayed to new webs on handshake. */
  private lastBridgeStatus: {
    online: boolean;
    changed_at: string;
    reason: BridgeStatusReason;
  } | null = null;
  /** Active "is the incumbent alive?" challenge — present iff a second
   *  bridge handshaked while the first one still occupies `this.bridge`.
   *  Nonce + timer are owned here (rather than on `ConnMeta`) so the
   *  bookkeeping has exactly one owner: `this.challenge !== null`
   *  is the gate that all duplicate-handshake traffic must consult, and
   *  `resolveChallenge` is the only path that flips it back to null.
   *  See `startChallenge` for the lifecycle. */
  private challenge: {
    oldWs: WebSocket;
    newWs: WebSocket;
    nonce: string;
    timer: ReturnType<typeof setTimeout>;
    startedAt: number;
  } | null = null;

  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
    options?: { startHeartbeat?: boolean },
  ) {
    // `options.startHeartbeat === false` is a test seam: production
    // never receives it (worker/index.ts calls `new Room(state, env)`
    // with no third arg), but unit tests opt out so the 20s `setInterval`
    // never fires and every tick path can be exercised explicitly via
    // `room.tickHeartbeat()`. Default is true so the production path is
    // unchanged.
    //
    // `blockConcurrencyWhile` gates the heartbeat registration so the
    // first 20s tick is counted from DO cold start, not from the first
    // WS upgrade — `fetch()` cannot race the timer setup.
    const startHeartbeatEnabled = options?.startHeartbeat ?? true;
    if (!startHeartbeatEnabled) return;
    void this.state.blockConcurrencyWhile(() => {
      startHeartbeat(this);
      // blockConcurrencyWhile requires a `Promise<T>` return; the
      // surrounding async callback resolves immediately so this is a
      // marker for the runtime's startup-gate logic only.
      return Promise.resolve();
    });
  }

  // -------------------------------------------------------------------------
  // fetch — WS upgrade entry
  // -------------------------------------------------------------------------

  fetch(request: Request): Response {
    // Defensive: the worker entry only forwards upgrade requests, but
    // the DO is also reachable via direct stub calls (e.g. wscat) — guard
    // against misrouted non-upgrade traffic here too.
    const upgradeHeader = request.headers.get('upgrade');
    if (upgradeHeader === null || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const roleHeader = request.headers.get(ROLE_HEADER);
    if (roleHeader === null || !isRole(roleHeader)) {
      // Worker should have set this; if it didn't we have a routing bug.
      return new Response('Bad Request: missing X-RemotePi-Role header', {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const expectedRole: Role = roleHeader;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Non-Hibernation API: `server.accept()` registers the server side
    // with the runtime. We stay on the standard event API rather than
    // `state.acceptWebSocket`, which would enable Hibernation.
    server.accept();

    const meta: ConnMeta = {
      ws: server,
      role: expectedRole,
      phase: 'pending',
      handshakeTimer: null,
      pendingPingNonce: null,
      pingSentAt: null,
      missedPong: 0,
      challengeNonce: null,
      challengeSentAt: null,
    };
    meta.handshakeTimer = setTimeout(() => {
      // Fire the timeout through the normal send+close path so it
      // shares the cleanup logic. If the connection has already been
      // removed (e.g. it closed mid-timer), `sendError` is a no-op on
      // a closed socket — the throw is caught downstream.
      this.sendTerminalError(
        meta,
        'auth_failed',
        'handshake timeout',
      );
    }, HANDSHAKE_TIMEOUT_MS);

    this.webs.set(server, meta);

    server.addEventListener('message', (event) => {
      if (isWebSocketMessageData(event.data)) {
        this.webSocketMessage(server, event.data);
      }
    });
    server.addEventListener('close', (event) => {
      this.webSocketClose(server, event.code, event.reason, event.wasClean);
    });
    server.addEventListener('error', () => {
      this.webSocketError(server, new Error('WebSocket error'));
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
      // RFC 6455 requires the server to select exactly one value from
      // the client's offered subprotocol list. The token is deliberately
      // omitted: it is an auth input, not a protocol to advertise after
      // the upgrade.
      headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL_VERSION },
    });
  }

  // -------------------------------------------------------------------------
  // Runtime callbacks
  // -------------------------------------------------------------------------

  webSocketMessage(
    ws: WebSocket,
    raw: string | ArrayBuffer,
  ): void {
    const meta = this.webs.get(ws);
    if (meta === undefined) {
      // Runtime gave us a handle we don't track — drop.
      try {
        ws.close(FATAL_CLOSE_CODE, 'unknown connection');
      }
      catch {
        // best-effort
      }
      return;
    }

    try {
      if (typeof raw !== 'string') {
        this.sendError(ws, 'invalid_envelope', 'binary frames not supported', false);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      }
      catch {
        this.sendError(ws, 'invalid_envelope', 'malformed JSON', false);
        return;
      }

      if (!isRecord(parsed)) {
        this.sendError(ws, 'invalid_envelope', 'frame is not an object', false);
        return;
      }

      // Discriminate on `v` BEFORE handing to safeParse. The shared
      // schema uses `z.literal(1)` so any v !== 1 would surface as a
      // parse error, but per control.md §8 `unsupported_version` is a
      // distinct terminal error — we extract v explicitly so it doesn't
      // get flattened into `invalid_envelope`.
      const v = parsed['v'];
      if (v !== PROTOCOL_VERSION) {
        this.sendErrorAndClose(
          meta,
          'unsupported_version',
          `unsupported protocol version: ${stringifyLite(v)}`,
          FATAL_CLOSE_CODE,
        );
        return;
      }

      const result = Envelope.safeParse(parsed);
      if (!result.success) {
        this.sendError(ws, 'invalid_envelope', result.error.message, false);
        return;
      }

      const env = result.data;

      if (meta.phase === 'pending') {
        this.handleHandshake(meta, env);
        return;
      }

      this.routeOpenMessage(meta, env);
    }
    catch (e) {
      // Per control.md §8, internal errors are non-terminal — keep the
      // connection open and surface a single error frame so the peer
      // can log it.
      this.sendError(
        ws,
        'internal',
        e instanceof Error ? e.message : 'internal error',
        false,
      );
    }
  }

  webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    this.handleDisconnect(ws);
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    // Per Cloudflare docs, webSocketError is followed by webSocketClose;
    // routing through the same cleanup is correct. Doing the work here
    // too is defensive — if the close never lands we still drop the
    // connection.
    this.handleDisconnect(ws);
  }

  // -------------------------------------------------------------------------
  // Handshake handling
  // -------------------------------------------------------------------------

  private handleHandshake(meta: ConnMeta, env: Envelope): void {
    if (env.type !== 'handshake') {
      this.sendTerminalError(
        meta,
        'auth_failed',
        'first frame must be a control/handshake',
      );
      return;
    }

    if (env.payload.role !== meta.role) {
      this.sendTerminalError(
        meta,
        'auth_failed',
        `role "${env.payload.role}" does not match entry "${meta.role}"`,
      );
      return;
    }

    if (meta.role === 'bridge') {
      // Duplicate-bridge check: a *different* bridge already owns this
      // token. Two cases, picked in this order:
      //
      // 1. A challenge is already in flight (this.challenge !== null).
      //    Refuse the new comer outright — first-come-first-served.
      //    A late arrival during the 3s window would otherwise race
      //    the in-progress incumbent-alive probe and could end up
      //    promoting two bridges if it slipped past the gate. The
      //    challenger itself is parked (its handshakeTimer is owned
      //    by the in-flight challenge; see startChallenge) and will
      //    be promoted or terminated when the probe resolves.
      //
      // 2. No challenge yet, but a different bridge occupies the slot.
      //    Start a challenge: probe the incumbent with a `control/ping`
      //    carrying a fresh nonce, set a 3s budget. If the incumbent
      //    answers, reject the new comer with duplicate_bridge; if the
      //    budget elapses, the incumbent is presumed dead (the heartbeat
      //    would have flagged it in ~90s, far too slow for an
      //    operator-driven reconnect), so we evict it and promote the
      //    challenger. This closes the "1006 close → DO keeps stale
      //    bridge slot → fresh reconnects permanently rejected" loop.
      //
      // We deliberately do NOT clear the handshake timer or promote
      // phase here in case (2). Both happen inside `startChallenge`
      // (timer handover) or `resolveChallenge` (phase promotion on the
      // live branch). control.md §1.
      if (this.challenge !== null) {
        this.sendTerminalError(
          meta,
          'duplicate_bridge',
          'a bridge is already connected for this token',
        );
        return;
      }
      if (this.bridge !== null && this.bridge !== meta.ws) {
        this.startChallenge(this.bridge, meta);
        return;
      }
    }

    if (meta.handshakeTimer !== null) {
      clearTimeout(meta.handshakeTimer);
      meta.handshakeTimer = null;
    }
    meta.phase = 'open';

    if (meta.role === 'bridge') {
      this.bridge = meta.ws;
      this.broadcastBridgeStatus(true, 'connected');
      return;
    }

    // Replay the latest bridge_status so the UI shows the right state
    // without waiting for the next event. If we've never had a bridge,
    // synthesise a `closed` snapshot so the bar starts in a defined state.
    const replay = this.lastBridgeStatus ?? {
      online: false,
      changed_at: nowIso(),
      reason: 'closed',
    };
    try {
      this.send(meta.ws, {
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'bridge_status',
        id: crypto.randomUUID(),
        payload: replay,
      });
    }
    catch {
      // The web socket is dying mid-handshake. The runtime will dispatch
      // webSocketClose shortly and handleDisconnect will sweep.
    }
  }

  // -------------------------------------------------------------------------
  // Challenge: probe the incumbent bridge to decide whether to keep it or
  // hand the slot to a fresh challenger. See CHALLENGE_TIMEOUT_MS for the
  // budget rationale.
  // -------------------------------------------------------------------------

  /** Begin a "is the incumbent bridge alive?" probe. Called from
   *  `handleHandshake` when a second bridge handshakes before the first
   *  one has visibly disconnected.
   *
   *  Lifecycle:
   *    1. Take over `newMeta.handshakeTimer` — the 5s handshake window
   *       for the new bridge is now owned by `this.challenge.timer` for
   *       the duration of the probe.
   *    2. Stamp a fresh nonce onto the *incumbent's* `ConnMeta` so a
   *       pong from it can be correlated in `routeOpenMessage` (case
   *       'pong').
   *    3. Send a `control/ping` to the incumbent with that nonce. The
   *       incumbent's bridge-side `replyToPing` answers with a pong,
   *       the pong lands in `routeOpenMessage`, the nonce matches,
   *       `resolveChallenge(true, ...)` runs — incumbent is alive,
   *       new comer gets duplicate_bridge.
   *    4. Start the budget timer. On fire it calls
   *       `resolveChallenge(false, ...)` — incumbent did not answer in
   *       time, treat as dead, evict + promote the challenger.
   *
   *  Pre-conditions (callers are responsible):
   *    - `this.challenge === null` (no challenge in flight)
   *    - `oldWs === this.bridge` (the incumbent truly owns the slot)
   *    - `oldMeta.phase === 'open'` (it's a real open bridge, not a
   *      mid-handshake orphan)
   *    - `newMeta.handshakeTimer !== null` (the challenger is still in
   *      its 5s window) */
  private startChallenge(oldWs: WebSocket, newMeta: ConnMeta): void {
    // Take over the challenger's handshake timer — from here on
    // `newMeta.handshakeTimer` is null and the 5s budget is replaced by
    // the 3s challenge budget. If the probe resolves in time we don't
    // need the 5s window any more (the challenger is either promoted or
    // refused), and if the probe runs out we either promote (which clears
    // the timer via the normal handshake-completion path inside
    // `resolveChallenge`) or refuse (which closes the socket directly).
    if (newMeta.handshakeTimer !== null) {
      clearTimeout(newMeta.handshakeTimer);
      newMeta.handshakeTimer = null;
    }

    // Stamp the incumbent's meta with the challenge nonce so the pong
    // matcher can find it. We do NOT touch the incumbent's
    // `pendingPingNonce` — the heartbeat and the challenge are
    // independent probes, and conflating them would mean a slow-but-alive
    // bridge could clear a real pending heartbeat nonce by answering the
    // challenge, masking a genuine stale condition.
    const oldMeta = this.webs.get(oldWs);
    if (oldMeta === undefined) {
      // Defensive: unreachable in the current synchronous flow
      // (handleHandshake→startChallenge runs in a single tick with no
      // await, so `this.webs` cannot lose `oldWs` between the gate check
      // and this lookup). If some future caller ever invokes us after
      // yielding (e.g. an awaited handshake-validation step), the
      // incumbent could have vanished — we want a defined outcome rather
      // than a null-deref crash. Behaviourally: resolveChallenge would
      // run with `this.bridge === oldWs` still true (the broadcast
      // branch checks that), so a stale→connected sequence WOULD fire
      // on the web — that's the observable cost of the branch.
      const nonce = crypto.randomUUID();
      this.challenge = {
        oldWs,
        newWs: newMeta.ws,
        nonce,
        timer: setTimeout(() => {
          this.resolveChallenge(false, nonce);
        }, CHALLENGE_TIMEOUT_MS),
        startedAt: Date.now(),
      };
      this.resolveChallenge(false, nonce);
      return;
    }

    const nonce = crypto.randomUUID();
    oldMeta.challengeNonce = nonce;
    oldMeta.challengeSentAt = Date.now();

    // Arm the budget timer FIRST so a synchronous throw from `send`
    // can't leave us with no resolution path.
    const timer = setTimeout(() => {
      this.resolveChallenge(false, nonce);
    }, CHALLENGE_TIMEOUT_MS);

    this.challenge = {
      oldWs,
      newWs: newMeta.ws,
      nonce,
      timer,
      startedAt: oldMeta.challengeSentAt,
    };

    // Fire the probe. The send is best-effort wrapped here because the
    // challenge budget timer is the real fallback: if the send fails
    // the incumbent is unreachable from our side, and the budget will
    // fire in 3s to evict it via the timer branch. `send` itself throws
    // on socket failure (so the heartbeat tick can detect dead
    // connections via its outer catch) — we don't want that throw here.
    try {
      this.send(oldWs, {
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'ping',
        id: crypto.randomUUID(),
        payload: { nonce },
      });
    }
    catch {
      // Socket-level send failure. The 3s budget timer will fire
      // resolveChallenge(false, nonce) and evict the incumbent anyway.
    }
  }

  /** Resolve an in-flight challenge. Two outcomes:
   *    - `oldAlive === true`:  incumbent answered in time. Reject the
   *                            new bridge with duplicate_bridge. The
   *                            new bridge's handshake timer is null
   // (taken over by startChallenge), and `sendTerminalError` will
   //                            close the socket via the standard
   //                            auth-failed path. The incumbent keeps
   //                            its slot.
   *    - `oldAlive === false`: incumbent missed the budget. Evict it
   *                            (broadcast stale if `broadcastStaleForOld`
   *                            is true — the parameter is the seam that
   *                            lets handleDisconnect's old-ws branch
   *                            suppress the stale broadcast to avoid a
   *                            stale→connected flicker on the web UI),
   *                            drop it from `this.webs`, close it
   *                            best-effort, then promote the new bridge
   *                            (if it's still in `this.webs`):
   *                            phase='open', `this.bridge = newWs`,
   *                            broadcast `bridge_status{online:true,
   *                            reason:"connected"}`.
   *
   *  `expectedNonce` is the nonce `startChallenge` minted; late pongs
   *  carrying an older nonce hit the guard below and become no-ops
   *  (rather than spuriously resolving a different challenge — the
   *  invariant is that the only path that ever clears `this.challenge`
   *  is this function, and it must use the nonce it was given). */
  private resolveChallenge(
    oldAlive: boolean,
    expectedNonce: string,
    broadcastStaleForOld: boolean = true,
  ): void {
    const ch = this.challenge;
    // Guard: late resolution (a pong finally lands after the timer
    // already fired, or a duplicate resolution call somehow got past
    // every other check). `ch === null` covers "already resolved";
    // `ch.nonce !== expectedNonce` covers "different challenge".
    if (ch === null || ch.nonce !== expectedNonce) return;
    clearTimeout(ch.timer);
    this.challenge = null;

    const oldWs = ch.oldWs;
    const newWs = ch.newWs;
    const oldMeta = this.webs.get(oldWs);
    if (oldMeta !== undefined) {
      oldMeta.challengeNonce = null;
      oldMeta.challengeSentAt = null;
    }

    if (oldAlive) {
      // Incumbent is alive — refuse the challenger. `sendTerminalError`
      // closes the socket via closeWith(FATAL_CLOSE_CODE) which goes
      // through the normal `webSocketClose → handleDisconnect` cleanup;
      // that cleanup will see `this.challenge === null` (we just
      // cleared it) and skip the challenge branch, falling through to
      // the standard "not the bridge, no-op" tail.
      const newMeta = this.webs.get(newWs);
      if (newMeta !== undefined) {
        this.sendTerminalError(
          newMeta,
          'duplicate_bridge',
          'a bridge is already connected for this token',
        );
      }
      return;
    }

    if (broadcastStaleForOld && this.bridge === oldWs) {
      // Clear the bridge slot BEFORE broadcasting so the broadcaster's
      // current view matches what we want observers to see. The web
      // UI's "bridge offline" pulse is rendered off `bridge_status`
      // frames, not `lastBridgeStatus` reads, so this matches the
      // ordering the heartbeat stale branch uses.
      this.bridge = null;
      this.broadcastBridgeStatus(false, 'stale');
    } else if (broadcastStaleForOld === false && this.bridge === oldWs) {
      // Caller (handleDisconnect's old-ws branch) already nulled
      // `this.bridge` and asked us NOT to broadcast stale — skipping
      // both steps avoids a stale→connected flicker on the web UI
      // when the incumbent died on its own.
      this.bridge = null;
    }
    // The `else if` above is currently unreachable — the only caller
    // that passes `broadcastStaleForOld=false` nulls `this.bridge`
    // BEFORE invoking us, so by the time we reach here `this.bridge !==
    // oldWs` and the condition short-circuits. Kept as defence-in-depth
    // against future callers that pass `false` without first nulling the
    // slot — better to have an extra `this.bridge = null` than to
    // accidentally double-emit `stale` from a path we haven't audited.
    this.webs.delete(oldWs);
    try {
      oldWs.close(STALE_CLOSE_CODE, 'stale');
    }
    catch {
      // socket may already be closed.
    }

    // Promote the challenger if it's still around. `newMeta` may be
    // undefined if the challenger closed during the challenge window
    // — the only path to that state is "challenger closed BEFORE
    // handleDisconnect noticed us", which resolves cleanly to "no
    // promotion happens".
    const newMeta = this.webs.get(newWs);
    if (newMeta !== undefined) {
      newMeta.phase = 'open';
      newMeta.handshakeTimer = null;
      this.bridge = newWs;
      this.broadcastBridgeStatus(true, 'connected');
    }
  }

  // -------------------------------------------------------------------------
  // Open-phase routing
  // -------------------------------------------------------------------------

  private routeOpenMessage(meta: ConnMeta, env: Envelope): void {
    switch (env.type) {
      case 'handshake':
        // Re-handshakes after the first are protocol violations. We
        // don't tear down — surface as invalid_envelope (non-terminal)
        // so a buggy peer doesn't get punished for noise.
        this.sendError(
          meta.ws,
          'invalid_envelope',
          'handshake already completed',
          false,
        );
        return;

      case 'bridge_status':
      case 'error':
        // The DO is the only legitimate producer of these two types
        // (control.md §中间层处理规则). Inbound copies are stale, forged,
        // or the result of a routing loop. Drop.
        return;

      case 'ping':
        this.forwardToOpposite(meta, env);
        return;

      case 'pong': {
        const nonce = env.payload.nonce;
        // Three-bucket pong matcher:
        //
        // (a) Challenge pong — meta carries a `challengeNonce` AND the
        //     meta's owning websocket is the incumbent being probed in
        //     `this.challenge`. Matching here means "the incumbent is
        //     alive; resolve the challenge in its favour". The
        //     re-fetch defends the window between message dispatch
        //     and message processing — if the connection was removed
        //     from `this.webs` in that window (e.g. by a parallel
        //     handleDisconnect tick), `meta` would be a stale handle
        //     and the direct read of `meta.challengeNonce` would
        //     silently bypass the live-bookkeeping guard.
        const meta2 = this.webs.get(meta.ws) ?? meta;
        const ch = this.challenge;
        if (
          meta2.challengeNonce !== null
          && meta2.challengeNonce === nonce
          && ch !== null
          && ch.oldWs === meta.ws
        ) {
          // Drop the challenge ping's bookkeeping on the meta BEFORE
          // resolving, so resolveChallenge's "clear challenge fields"
          // step is a no-op overwrite rather than racing our writes.
          meta2.challengeNonce = null;
          meta2.challengeSentAt = null;
          this.resolveChallenge(true, nonce);
          return;
        }
        // (b) Heartbeat pong — meta carries a `pendingPingNonce` AND
        //     the nonce matches. The DO is the heartbeat answerer:
        //     consume it, clear the pending nonce, reset the miss
        //     counter. Pongs that don't match our nonce are forwarded
        //     on (they answer a peer's ping, e.g. web → DO → bridge →
        //     pong → DO → web) and must reach the original requester.
        //     They do NOT count toward liveness (control.md §3 — a
        //     forwarded pong would otherwise mask a real stale
        //     connection).
        if (
          meta.pendingPingNonce !== null
          && meta.pendingPingNonce === nonce
        ) {
          meta.pendingPingNonce = null;
          meta.pingSentAt = null;
          meta.missedPong = 0;
          return;
        }
        // (c) Non-matching pong — forward to the opposite peer set
        //     without resetting the heartbeat miss counter (control.md
        //     §3: only a "corresponding pong" clears it). Otherwise a
        //     peer that forwards pongs faster than it answers our
        //     heartbeats would never be declared stale.
        this.forwardToOpposite(meta, env);
        return;
      }

      // Catch-all: every other envelope type passes through verbatim.
      // control.md §中间层处理规则 reserves deep handling to handshake /
      // bridge_status / error (handled above or in handleHandshake) and
      // gives ping/pong the nonce-pairing carve-out (also above).
      // Everything else — the remaining control family members
      // (session_state, session_list, get_state, result, work_dirs) and
      // the entire pi family — is forwarded. The envelope has already
      // been validated by `Envelope.safeParse` upstream, so this
      // default cannot be hit by a structurally invalid or unknown type;
      // only by legitimate protocol types we don't need to inspect.
      // Future protocol additions land here automatically — the
      // default-branch pattern is the only sustainable
      // forward-compatible shape for this switch.
      default:
        this.forwardToOpposite(meta, env);
        return;
    }
  }

  /** Forward an envelope from one connection to the opposite peer set:
   *  - web     → bridge
   *  - bridge  → all webs
   *  control.md §2 + §3 + §中间层处理规则 (catch-all forwarding).
   *
   *  Each per-socket send is wrapped in its own try/catch: a single
   *  poisoned socket must not abort the broadcast — we'd otherwise
   *  skip the rest of the recipients on a transient send failure.
   *  The heartbeat tick is the only caller that WANTS the throw to
   *  propagate (so its outer catch can reap the dead connection); all
   *  other callers iterate over multiple sockets and need best-effort
   *  semantics. */
  private forwardToOpposite(
    meta: ConnMeta,
    env: Envelope,
  ): void {
    for (const [otherWs, otherMeta] of this.webs) {
      if (otherWs === meta.ws) continue;
      if (otherMeta.phase !== 'open') continue;
      if (meta.role === 'web' && otherMeta.role !== 'bridge') continue;
      if (meta.role === 'bridge' && otherMeta.role !== 'web') continue;
      try {
        this.send(otherWs, env);
      }
      catch {
        // socket is dying — handleDisconnect / webSocketClose will
        // sweep the entry on the next event-loop turn.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat tick — called from heartbeat.ts on a 20s interval
  // -------------------------------------------------------------------------

  /** Inspect every open connection; send a fresh ping if none pending,
   *  and time out connections that haven't answered the previous one.
   *
   *  Exception isolation: the loop body is wrapped in a try/catch so
   *  one misbehaving connection can't take the whole tick down. A
   *  throw inside the body is interpreted as "this connection is
   *  poisoned and should be reaped" — we clear the bridge slot if
   *  appropriate, broadcast stale, drop the entry, close best-effort,
   *  then move on to the next connection. Without this, a single
   *  JSON.stringify failure (or a synthetic throw from a test mock)
   *  would short-circuit the entire heartbeat round and let real
   *  stale connections sit un-pinged for another 20s. */
  tickHeartbeat(): void {
    // Empty tick guard — on a freshly-bootstrapped DO (cold start, no
    // upgrades yet) or after a graceful drain, the connections map is
    // empty and there's nothing to ping. Skipping the loop body also
    // avoids any Date.now() cost on hot idle ticks.
    if (this.webs.size === 0) return;

    const now = Date.now();

    for (const [ws, meta] of this.webs) {
      if (meta.phase !== 'open') continue;
      try {
        this.tickOneConnection(ws, meta, now);
      }
      catch {
        // Treat any throw as "this connection is dead". Reap it like
        // a stale hit: clear the bridge slot if appropriate, broadcast
        // stale (so the web UI sees the bridge go offline), drop the
        // entry, close best-effort, and move on.
        if (meta.role === 'bridge' && this.bridge === ws) {
          this.bridge = null;
          this.broadcastBridgeStatus(false, 'stale');
        }
        this.webs.delete(ws);
        try {
          ws.close(STALE_CLOSE_CODE, 'stale');
        }
        catch {
          // socket may already be gone.
        }
      }
    }
  }

  /** Per-connection heartbeat body, extracted so the surrounding tick
   *  loop can wrap it in an exception-isolation try/catch without
   *  duplicating the reap-on-throw logic. See tickHeartbeat for the
   *  contract. */
  private tickOneConnection(ws: WebSocket, meta: ConnMeta, now: number): void {
    // Stale check first: if the previous ping hasn't been answered
    // inside the 30s window, count a miss and clear the pending nonce
    // so we can send a fresh one.
    if (
      meta.pendingPingNonce !== null
      && meta.pingSentAt !== null
      && now - meta.pingSentAt > PONG_TIMEOUT_MS
    ) {
      meta.missedPong += 1;
      meta.pendingPingNonce = null;
      meta.pingSentAt = null;
      if (meta.missedPong >= MAX_MISSED_PONGS) {
        // Clear the bridge slot BEFORE closing so handleDisconnect sees
        // `this.bridge !== ws` and skips its own broadcast — we'd
        // otherwise emit two bridge_status frames (stale + closed).
        if (meta.role === 'bridge' && this.bridge === ws) {
          this.bridge = null;
          this.broadcastBridgeStatus(false, 'stale');
        }
        // Drop the entry from the connection map BEFORE ws.close().
        // The runtime doesn't always dispatch a close after we
        // initiate one (the socket is already on its way out), and a
        // stale entry would let the next tick double-handle the same
        // ws. Doing the delete here matches the order handleDisconnect
        // uses.
        this.webs.delete(ws);
        try {
          ws.close(STALE_CLOSE_CODE, 'stale');
        }
        catch {
          // socket may already be gone — handleDisconnect will clean up.
        }
        return;
      }
    }

    // Send a fresh ping if no nonce is pending. We don't gate on
    // missedPong == 0 — sending a second ping after a miss is exactly
    // the point; we want to give the peer another chance within the
    // 30s window.
    if (meta.pendingPingNonce === null) {
      const nonce = crypto.randomUUID();
      meta.pendingPingNonce = nonce;
      meta.pingSentAt = now;
      this.send(ws, {
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'ping',
        id: crypto.randomUUID(),
        payload: { nonce },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Disconnect cleanup
  // -------------------------------------------------------------------------

  private handleDisconnect(ws: WebSocket): void {
    const meta = this.webs.get(ws);
    if (meta === undefined) return;
    if (meta.handshakeTimer !== null) {
      clearTimeout(meta.handshakeTimer);
      meta.handshakeTimer = null;
    }
    this.webs.delete(ws);

    // Challenge-related branches come FIRST so a disconnect mid-challenge
    // is always funnelled through the resolve path before we fall through
    // to the standard bridge-slot cleanup below. Order matters: if the
    // new bridge disconnects, we cancel the challenge cleanly (no
    // promotion, no stale broadcast); if the old bridge disconnects on
    // its own, we promote the new one without a stale→connected flicker
    // (the standard `closed` broadcast is suppressed by passing
    // `broadcastStaleForOld = false` to resolveChallenge, and its
    // promotion step emits exactly one `connected` frame).
    const ch = this.challenge;
    if (ch !== null) {
      if (ch.newWs === ws) {
        // Challenger bailed before the probe resolved. Cancel the
        // budget timer, drop the challenge bookkeeping on the old meta
        // if it's still around, and let the old bridge keep its slot.
        clearTimeout(ch.timer);
        this.challenge = null;
        const oldMeta = this.webs.get(ch.oldWs);
        if (oldMeta !== undefined) {
          oldMeta.challengeNonce = null;
          oldMeta.challengeSentAt = null;
        }
        return;
      }
      if (ch.oldWs === ws) {
        // Incumbent died on its own (the operator killed the daemon,
        // or the network dropped) and the probe hadn't yet resolved.
        // Promote the challenger immediately, with NO stale broadcast
        // — emitting `stale` first would flash the UI bar
        // `connected → stale → connected` for ~3s while the challenge
        // timer ticked down, which is precisely the flicker the
        // user-visible contract wants to avoid.
        const nonce = ch.nonce;
        meta.challengeNonce = null;
        meta.challengeSentAt = null;
        // The incumbent IS the bridge (handleHandshake would never
        // have started a challenge against a non-bridge). Null the
        // slot before calling resolveChallenge so the standard
        // `closed` broadcast below is suppressed (since
        // `this.bridge !== ws` by the time we reach it) AND so
        // resolveChallenge's `broadcastStaleForOld=false` branch
        // works cleanly.
        if (this.bridge === ws) {
          this.bridge = null;
        }
        // Hand off to resolveChallenge, which owns the rest of the
        // state machine: clearTimeout, this.challenge = null,
        // webs.delete(oldWs) (idempotent — we already deleted above),
        // best-effort close on the dying incumbent, and exactly one
        // `connected` broadcast for the promotion. We do NOT null
        // `this.challenge` here — resolveChallenge's nonce guard
        // needs to find the matching challenge, and resolveChallenge
        // is the only path that ever clears the field.
        this.resolveChallenge(false, nonce, /* broadcastStaleForOld */ false);
        return;
      }
    }

    if (this.bridge === ws) {
      this.bridge = null;
      this.broadcastBridgeStatus(false, 'closed');
    }
  }

  // -------------------------------------------------------------------------
  // Outbound helpers
  // -------------------------------------------------------------------------

  private broadcastBridgeStatus(
    online: boolean,
    reason: BridgeStatusReason,
  ): void {
    const status = {
      online,
      changed_at: nowIso(),
      reason,
    };
    this.lastBridgeStatus = status;

    const env = {
      v: PROTOCOL_VERSION,
      kind: 'control' as const,
      type: 'bridge_status' as const,
      id: crypto.randomUUID(),
      payload: status,
    };

    for (const [ws, meta] of this.webs) {
      if (meta.role !== 'web') continue;
      if (meta.phase !== 'open') continue;
      try {
        this.send(ws, env);
      }
      catch {
        // socket is dying — handleDisconnect / webSocketClose will
        // sweep the entry on the next event-loop turn.
      }
    }
  }

  /** Send a non-terminal error frame — connection stays open.
   *  Wrapped in try/catch because `send` throws on socket failure:
   *  surfacing an error to a socket that can't accept bytes would be
   *  a contradiction, and we don't want a broken peer to crash the
   *  message dispatcher. */
  private sendError(
    ws: WebSocket,
    code: ErrorCode,
    message: string,
    terminal: boolean,
  ): void {
    try {
      this.send(ws, {
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'error',
        id: crypto.randomUUID(),
        payload: { code, message, terminal },
      });
    }
    catch {
      // connection is dying — closeWith / handleDisconnect will sweep.
    }
  }

  /** Send a terminal error and close the socket with the fatal code.
   *  Send-failure swallowed for the same reason as `sendError`; the
   *  follow-on `closeWith` (already in its own try/catch) does the
   *  actual cleanup. */
  private sendTerminalError(
    meta: ConnMeta,
    code: ErrorCode,
    message: string,
  ): void {
    try {
      this.send(meta.ws, {
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'error',
        id: crypto.randomUUID(),
        payload: { code, message, terminal: true },
      });
    }
    catch {
      // see sendError — a dying socket must not crash the dispatcher.
    }
    this.closeWith(meta, FATAL_CLOSE_CODE, code);
  }

  /** Like sendTerminalError but lets the caller pick the close code.
   *  Same try/catch wrapper as the other two send helpers. */
  private sendErrorAndClose(
    meta: ConnMeta,
    code: ErrorCode,
    message: string,
    closeCode: number,
  ): void {
    try {
      this.send(meta.ws, {
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'error',
        id: crypto.randomUUID(),
        payload: { code, message, terminal: true },
      });
    }
    catch {
      // see sendError.
    }
    this.closeWith(meta, closeCode, code);
  }

  private closeWith(
    meta: ConnMeta,
    code: number,
    reasonCode: ErrorCode,
  ): void {
    try {
      meta.ws.close(code, reasonCode);
    }
    catch {
      // socket may already be closed — webSocketClose will finalize.
    }
  }

  /** Send an envelope on a WebSocket. Throws if the underlying
   *  `ws.send()` throws — the caller decides whether to swallow.
   *  Callers that want best-effort broadcast semantics (one bad
   *  socket must not break the loop iterating over many sockets)
   *  must wrap their own `send` call in a try/catch. Callers that
   *  want to detect dead sockets — currently only the heartbeat
   *  tick — leave it bare so the throw bubbles up to their outer
   *  catch. This shape is what lets `tickHeartbeat`'s
   *  per-connection try/catch actually fire on a poisoned send. */
  private send(ws: WebSocket, env: unknown): void {
    ws.send(JSON.stringify(env));
  }
}

// ---------------------------------------------------------------------------
// Tiny type predicates (kept local so we don't pull zod runtime here)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWebSocketMessageData(value: unknown): value is string | ArrayBuffer {
  return typeof value === 'string' || value instanceof ArrayBuffer;
}

function stringifyLite(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '<unknown>';
}