// Room Durable Object — one Room per token (via idFromName(token) in
// index.ts). Owns the per-token tunnel, the bridge slot, and the in-memory
// connection bookkeeping. Imported in env.ts so wrangler can discover the
// class for binding resolution.
//
// Lifecycle of a connection:
//   1. Worker entry accepts an upgrade at /web or /bridge, derives
//      `expectedRole` from the URL, attaches it to a forwarded header.
//   2. `fetch()` constructs a WebSocketPair, accepts the server side, and
//      starts a 5-second handshake timer.
//   3. First message must be `control/handshake` with the matching `role`.
//      - 5s elapses → `error(auth_failed, terminal:true)` + close 1008.
//      - role mismatches → same.
//      - role=bridge but another bridge already present →
//        `error(duplicate_bridge, terminal:true)` + close 1008 (the
//        incumbent bridge is untouched).
//   4. Handshake OK → mark connection open, clear the timer. If bridge,
//      broadcast `bridge_status{online:true, reason:"connected"}` to every
//      web. If web, send it the current bridge_status immediately so the UI
//      can render without waiting for the next event.
//   5. Subsequent messages (per control.md §中间层处理规则):
//      - control/ping     → forward to the opposite peer.
//      - control/pong     → forward to opposite, OR consume if the nonce
//                            matches the DO's pending heartbeat ping.
//      - control/bridge_status / control/error → drop (the DO is the
//                            authoritative producer; inbound copies are
//                            stale or forged).
//      - v ≠ 1            → `error(unsupported_version, terminal:true)` +
//                            close 1008.
//      - envelope parse fail → `error(invalid_envelope, terminal:false)`,
//                             connection stays open.
//
// Heartbeat (worker/src/heartbeat.ts) drives a 30s × 3 stale check on top of
// the per-message forwarding. webSocketClose / webSocketError cleanup the
// connection map and, if the dropped socket was the bridge, broadcast
// `bridge_status{online:false, reason:"closed"}`.
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
/** WebSocket close code used when the heartbeat declares a connection stale. */
const STALE_CLOSE_CODE = 1000;

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
}

// ---------------------------------------------------------------------------
// Room DO
// ---------------------------------------------------------------------------

export class Room implements DurableObject {
  /** Per-connection map — the WebSocket server is the stable key. The runtime
  //  uses the same object as the dispatch handle in `webSocketMessage` etc. */
  private readonly webs = new Map<WebSocket, ConnMeta>();
  /** The single allowed bridge for this token (control.md §1: duplicate_bridge). */
  private bridge: WebSocket | null = null;
  /** Last bridge_status we announced; replayed to new webs on handshake. */
  private lastBridgeStatus: {
    online: boolean;
    changed_at: string;
    reason: BridgeStatusReason;
  } | null = null;

  constructor(private readonly state: DurableObjectState, _env: Env) {
    // Register the heartbeat loop before serving requests so the first
    // 20s tick is counted from DO cold start, not from the first WS upgrade.
    // blockConcurrencyWhile prevents the fetch() handler from racing the
    // timer registration.
    void this.state.blockConcurrencyWhile(() => {
      startHeartbeat(this);
      // blockConcurrencyWhile requires a `Promise<T>` return — startHeartbeat
      // returns void, but the surrounding async callback resolves
      // immediately so this is purely a marker for the runtime's
      // startup-gate logic.
      return Promise.resolve();
    });
  }

  // -------------------------------------------------------------------------
  // fetch — WS upgrade entry
  // -------------------------------------------------------------------------

  fetch(request: Request): Response {
    // Defensive: the worker entry only forwards upgrade requests, but the DO
    // is also reachable via direct stub calls (e.g. wscat) — guard against
    // misrouted non-upgrade traffic here too.
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
    // Non-Hibernation API: `server.accept()` registers the server side with
    // the runtime; the runtime then dispatches messages to this DO instance
    // via `webSocketMessage`/`webSocketClose`/`webSocketError`. No call to
    // `state.acceptWebSocket` — that's reserved for Hibernation.
    server.accept();

    const meta: ConnMeta = {
      ws: server,
      role: expectedRole,
      phase: 'pending',
      handshakeTimer: null,
      pendingPingNonce: null,
      pingSentAt: null,
      missedPong: 0,
    };
    meta.handshakeTimer = setTimeout(() => {
      // Fire the timeout through the normal send+close path so it shares
      // the cleanup logic. If the connection has already been removed
      // (e.g. it closed mid-timer), `sendError` becomes a no-op on a
      // closed socket — we catch any throw below.
      this.sendTerminalError(
        meta,
        'auth_failed',
        'handshake timeout',
      );
    }, HANDSHAKE_TIMEOUT_MS);

    this.webs.set(server, meta);

    return new Response(null, { status: 101, webSocket: client });
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
      // Unknown socket — runtime gave us a handle we don't track. Drop.
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

      // Step 1: JSON-parse. Anything that throws here is malformed input —
      // surface as invalid_envelope and keep the connection open.
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

      // Step 2: discriminate on `v` BEFORE handing to safeParse. The shared
      // schema uses `z.literal(1)` so any v !== 1 surfaces as a parse error,
      // but per control.md §8 `unsupported_version` is a distinct terminal
      // error — we extract v explicitly so it doesn't get flattened into
      // invalid_envelope.
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

      // Step 3: full envelope parse. Any failure here is structural (not a
      // version problem) → invalid_envelope, non-terminal.
      const result = Envelope.safeParse(parsed);
      if (!result.success) {
        this.sendError(ws, 'invalid_envelope', result.error.message, false);
        return;
      }

      const env = result.data;

      // Step 4: handshake gate.
      if (meta.phase === 'pending') {
        this.handleHandshake(meta, env);
        return;
      }

      // Step 5: open-phase routing.
      this.routeOpenMessage(meta, env);
    }
    catch (e) {
      // Catch-all for unexpected runtime errors. Per control.md §8, internal
      // errors are non-terminal — keep the connection open and surface a
      // single error frame so the peer can log it.
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
    // Per Cloudflare docs, webSocketError is followed by webSocketClose, so
    // we route through the same cleanup logic. Doing the work here too is
    // defensive — if the close never lands we still drop the connection.
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
      // token. The new socket is the offender — the incumbent is left
      // intact. control.md §1.
      if (this.bridge !== null && this.bridge !== meta.ws) {
        this.sendTerminalError(
          meta,
          'duplicate_bridge',
          'a bridge is already connected for this token',
        );
        return;
      }
    }

    // Handshake OK — promote phase and clear the 5s timer.
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

    // Web — replay the latest bridge_status so the UI shows the right state
    // without waiting for the next event. If we've never had a bridge,
    // synthesize a `closed` snapshot so the bar starts in a defined state.
    const replay = this.lastBridgeStatus ?? {
      online: false,
      changed_at: nowIso(),
      reason: 'closed',
    };
    this.send(meta.ws, {
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'bridge_status',
      id: crypto.randomUUID(),
      payload: replay,
    });
  }

  // -------------------------------------------------------------------------
  // Open-phase routing
  // -------------------------------------------------------------------------

  private routeOpenMessage(meta: ConnMeta, env: Envelope): void {
    switch (env.type) {
      case 'handshake':
        // Re-handshakes after the first are protocol violations. We don't
        // tear down — surface as invalid_envelope (non-terminal) so a buggy
        // peer doesn't get punished for noise. PRD doesn't list this
        // explicitly; default to the non-terminal bucket.
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
        // (control.md §中间层处理规则). Inbound copies are stale, forged, or
        // the result of a routing loop. Drop.
        return;

      case 'ping':
        this.forwardToOpposite(meta, env);
        return;

      case 'pong': {
        const nonce = env.payload.nonce;
        // The DO also sends its own heartbeat pings (heartbeat.ts). A pong
        // whose nonce matches the one we sent IS the heartbeat answer —
        // consume it, clear the pending nonce, reset the miss counter.
        // Pongs that don't match our nonce are forwarded on: they answer
        // a peer's ping (e.g. web → DO → bridge → pong → DO → web) and
        // must reach the original requester. They do NOT count toward
        // liveness (control.md §3 — a forwarded pong would otherwise
        // mask a real stale connection).
        if (
          meta.pendingPingNonce !== null
          && meta.pendingPingNonce === nonce
        ) {
          meta.pendingPingNonce = null;
          meta.pingSentAt = null;
          meta.missedPong = 0;
          return;
        }
        // Non-matching pongs are forwarded but DO NOT reset the heartbeat
        // miss counter (control.md §3: only a "corresponding pong" clears
        // it). Otherwise a peer that forwards pongs faster than it answers
        // our heartbeats would never be declared stale.
        this.forwardToOpposite(meta, env);
        return;
      }
    }
  }

  /** Forward a ping or pong from one connection to the opposite peer set:
  //  - web  → bridge
  //  - bridge → all webs
  //  control.md §2 + §3 + §中间层处理规则. */
  private forwardToOpposite(
    meta: ConnMeta,
    env: Envelope,
  ): void {
    for (const [otherWs, otherMeta] of this.webs) {
      if (otherWs === meta.ws) continue;
      if (otherMeta.phase !== 'open') continue;
      if (meta.role === 'web' && otherMeta.role !== 'bridge') continue;
      if (meta.role === 'bridge' && otherMeta.role !== 'web') continue;
      this.send(otherWs, env);
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat tick — called from heartbeat.ts on a 20s interval
  // -------------------------------------------------------------------------

  /** Inspect every open connection; send a fresh ping if none pending,
   *  and time out connections that haven't answered the previous one. */
  tickHeartbeat(): void {
    // Empty tick guard — on a freshly-bootstrapped DO (cold start, no
    // upgrades yet) or after a graceful drain, the connections map is
    // empty and there's nothing to ping. Skipping the loop body also
    // avoids any Date.now() cost on hot idle ticks.
    if (this.webs.size === 0) return;

    const now = Date.now();

    for (const [ws, meta] of this.webs) {
      if (meta.phase !== 'open') continue; // skip pre-handshake sockets

      // Stale check first: if the previous ping hasn't been answered inside
      // the 30s window, count a miss and clear the pending nonce so we can
      // send a fresh one.
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
          try {
            ws.close(STALE_CLOSE_CODE, 'stale');
          }
          catch {
            // socket may already be gone — handleDisconnect will clean up.
          }
          continue;
        }
      }

      // Send a fresh ping if no nonce is pending. We don't gate on
      // missedPong == 0 — sending a second ping after a miss is exactly the
      // point, we want to give the peer another chance within the 30s
      // window.
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
      this.send(ws, env);
    }
  }

  /** Send a non-terminal error frame — connection stays open. */
  private sendError(
    ws: WebSocket,
    code: ErrorCode,
    message: string,
    terminal: boolean,
  ): void {
    this.send(ws, {
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'error',
      id: crypto.randomUUID(),
      payload: { code, message, terminal },
    });
  }

  /** Send a terminal error and close the socket with the fatal code. */
  private sendTerminalError(
    meta: ConnMeta,
    code: ErrorCode,
    message: string,
  ): void {
    this.send(meta.ws, {
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'error',
      id: crypto.randomUUID(),
      payload: { code, message, terminal: true },
    });
    this.closeWith(meta, FATAL_CLOSE_CODE, code);
  }

  /** Like sendTerminalError but lets the caller pick the close code
   *  (currently only `unsupported_version` uses a non-default code, and
   *  it's the same 1008, but the indirection keeps the policy legible). */
  private sendErrorAndClose(
    meta: ConnMeta,
    code: ErrorCode,
    message: string,
    closeCode: number,
  ): void {
    this.send(meta.ws, {
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'error',
      id: crypto.randomUUID(),
      payload: { code, message, terminal: true },
    });
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
      // socket may already be closed — webSocketClose will finalize cleanup.
    }
  }

  private send(ws: WebSocket, env: unknown): void {
    try {
      // Best-effort. Drop on a closed socket — handleDisconnect / webSocketClose
      // will sweep the entry on the next event-loop turn.
      ws.send(JSON.stringify(env));
    }
    catch {
      // ignore — connection is dying, runtime will dispatch webSocketClose.
    }
  }
}

// ---------------------------------------------------------------------------
// Tiny type predicates (kept local so we don't pull zod runtime here)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyLite(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '<unknown>';
}