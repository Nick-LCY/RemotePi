// WSS client for the bridge daemon.
//
// Responsibilities:
//   1. Open a WebSocket to the worker with subprotocols
//      ['remotepi.v1', token] (envelope.md §锁版承诺).
//   2. On open, immediately send `control/handshake {role:'bridge', token}`.
//      The bridge does NOT wait for an ack — sustained connection IS the
//      success signal (PRD §2 注: "连接保持即视为握手成功——bridge 不等待
//      任何 ack"). Failures surface via `error` frames or socket close,
//      both of which drive the reconnect loop.
//   3. On every `control/ping` from the server, reply with `control/pong`
//      carrying the same nonce (control.md §3).
//   4. Send `control/ping` every 20s. If 3 consecutive 30s windows pass
//      without a pong, declare the connection dead and close it (which
//      drives the reconnect loop).
//   5. Reconnect with exponential backoff: base=1s, cap=30s, ±20% jitter.
//      Reset the attempt counter on a successful open.
//
// We use the global `WebSocket` constructor (Node 22 ships one). It's
// injectable via the `createSocket` option for unit tests; otherwise the
// real global is used.
import { Envelope, PROTOCOL_VERSION, type Envelope as EnvelopeT } from '@remotepi/shared';
import { logger } from './logger.js';

/** Protocol constants — see control.md §2 / §3 and PRD §2. Centralised so
 *  tests can override via the options bag without editing these. */
export const PING_INTERVAL_MS = 20_000;
export const PONG_TIMEOUT_MS = 30_000;
export const PONG_TIMEOUTS_BEFORE_DEAD = 3;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;

/** Compute the reconnect delay for the given 1-indexed attempt number.
 *  Exposed for unit tests — the integration logic lives in the class,
 *  the pure math lives here so it's trivially testable.
 *  Sequence: attempt 1..5 is exponential (1×, 2×, 4×, 8×, 16× baseMs),
 *  attempt 6+ is capped at `capMs` (default 30s). */
export function computeBackoff(
  attempt: number,
  rng: () => number = Math.random,
  baseMs: number = BACKOFF_BASE_MS,
  capMs: number = BACKOFF_CAP_MS,
): number {
  // Exponential growth, capped. 2^(attempt-1): 1, 2, 4, 8, 16, 32, 64…
  // then `min(_, capMs)` flattens the tail at 30000 ms from attempt 6 on.
  const raw = Math.min(baseMs * 2 ** (attempt - 1), capMs);
  // ±20% jitter: rng() ∈ [0, 1) → factor ∈ [0.8, 1.2).
  const factor = 0.8 + rng() * 0.4;
  return raw * factor;
}

/** Minimal WebSocket surface — anything `globalThis.WebSocket` exposes
 *  that we actually use, plus a `readyState` we read before `send()`. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
}

export interface BridgeClientOptions {
  /** Override the WebSocket constructor (test seam). Defaults to
   *  `globalThis.WebSocket`. */
  createSocket?: (url: string, protocols: string[]) => WebSocketLike;
  /** Override the jitter RNG (test seam). Defaults to `Math.random`. */
  rng?: () => number;
  /** Override timing — defaults to the protocol constants above. */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  pongTimeoutsBeforeDead?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

/** Internal record of resolved options so the hot paths don't have to
 *  coalesce defaults on every tick. */
interface ResolvedOptions {
  pingIntervalMs: number;
  pongTimeoutMs: number;
  pongTimeoutsBeforeDead: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  createSocket: (url: string, protocols: string[]) => WebSocketLike;
  rng: () => number;
}

export class BridgeClient {
  private ws: WebSocketLike | null = null;
  private stopped = false;
  private attempt = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongDeadline: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimeouts = 0;
  /** Nonce of the in-flight ping awaiting a matching pong. Set when we
   *  arm the deadline; cleared when a matching pong arrives (or the
   *  deadline fires). Used to distinguish "real answer" from forwarded
   *  pongs that happen to land in our message stream. */
  private pendingNonce: string | null = null;
  private readonly opts: ResolvedOptions;

  constructor(
    private readonly url: string,
    private readonly token: string,
    options: BridgeClientOptions = {},
  ) {
    this.opts = {
      pingIntervalMs: options.pingIntervalMs ?? PING_INTERVAL_MS,
      pongTimeoutMs: options.pongTimeoutMs ?? PONG_TIMEOUT_MS,
      pongTimeoutsBeforeDead: options.pongTimeoutsBeforeDead ?? PONG_TIMEOUTS_BEFORE_DEAD,
      backoffBaseMs: options.backoffBaseMs ?? BACKOFF_BASE_MS,
      backoffCapMs: options.backoffCapMs ?? BACKOFF_CAP_MS,
      createSocket: options.createSocket ?? defaultCreateSocket,
      rng: options.rng ?? Math.random,
    };
  }

  /** Begin the connect → handshake → heartbeat → reconnect loop.
   *  Idempotent: subsequent calls after `start()` are no-ops. */
  start(): void {
    if (this.pingInterval !== null || this.reconnectTimer !== null || this.ws !== null) {
      return;
    }
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  /** Stop the loop. No further reconnects will be scheduled. Idempotent.
   *  Closes the current socket if any (its onclose handler will see the
   *  stopped flag and not reconnect). */
  stop(): void {
    this.stopped = true;
    this.cleanupTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // already closed / errored — nothing to do.
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = this.opts.createSocket(this.url, ['remotepi.v1', this.token]);
    this.ws = ws;
    ws.onopen = () => this.handleOpen();
    ws.onmessage = (ev) => this.handleMessage(ev);
    ws.onclose = (ev) => this.handleClose(ev);
    // onerror is purely advisory in browsers/Node — the close event is
    // the authoritative "connection is gone" signal, so we don't drive
    // any state changes from it. We DO log it though: an unexplained
    // 1006 with zero preceding output is the exact "why isn't this
    // connecting?" symptom users hit when pointed at the wrong host.
    ws.onerror = (ev) => this.handleError(ev);
  }

  private handleOpen(): void {
    logger.info(`connected to ${this.url}`);
    this.attempt = 0;
    this.pongTimeouts = 0;
    this.sendHandshake();
    this.startHeartbeat();
  }

  private sendHandshake(): void {
    this.sendEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'handshake',
      id: crypto.randomUUID(),
      payload: { role: 'bridge', token: this.token },
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Send the first ping immediately so the server can confirm liveness
    // ASAP; subsequent ones are paced by `setInterval`.
    this.sendPing();
    this.pingInterval = setInterval(() => this.sendPing(), this.opts.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private sendPing(): void {
    // Full UUID for the nonce — matches what the worker DO emits for its
    // own heartbeats (heartbeat.ts uses crypto.randomUUID()). 8-char
    // truncation was nice for human inspection but birthday-collides
    // across multiple tabs / bridges within the 30s window (2^32 / 2
    // ≈ 65k draws ≈ 50% collision). Protocol only requires `nonce` to
    // be a string (control.md §2), so length is unconstrained.
    const nonce = crypto.randomUUID();
    this.sendEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'ping',
      id: crypto.randomUUID(),
      payload: { nonce },
    });
    if (this.pongDeadline === null) {
      // First ping in this 30s window — arm the deadline and tag it
      // with this nonce so the pong handler can match exactly.
      this.armPongDeadline(nonce);
    } else if (this.pendingNonce === null) {
      // Post-re-arm state: deadline is already armed but `pendingNonce`
      // was cleared by the timeout. Adopt the latest nonce so subsequent
      // pongs (which the server sends in response to this latest ping)
      // can match against it.
      this.pendingNonce = nonce;
    }
    // else: a deadline is armed AND a nonce is already awaited — this
    // ping is "extra" and the existing deadline still covers it. The
    // no-reset invariant from before the nonce-tracking fix is preserved.
  }

  private armPongDeadline(nonce: string): void {
    // Crucial: do NOT reset an already-armed deadline. Each ping's 30s
    // window must elapse independently so 3 CONSECUTIVE windows without
    // a pong can accumulate (control.md §3). Subsequent `sendPing()`s
    // called via `setInterval` would otherwise refresh the deadline and
    // make the connection look healthy forever.
    if (this.pongDeadline !== null) return;
    this.pendingNonce = nonce;
    this.pongDeadline = setTimeout(() => this.handlePongTimeout(), this.opts.pongTimeoutMs);
  }

  private clearPongDeadline(): void {
    if (this.pongDeadline !== null) {
      clearTimeout(this.pongDeadline);
      this.pongDeadline = null;
    }
    // Always clear pendingNonce alongside the deadline — without a live
    // timer the nonce has no meaning, and leaving it set would let a
    // stale entry leak into the next window's match check.
    this.pendingNonce = null;
  }

  private handlePongTimeout(): void {
    this.pongDeadline = null;
    this.pendingNonce = null;
    this.pongTimeouts++;
    logger.warn(
      `pong timeout ${this.pongTimeouts}/${this.opts.pongTimeoutsBeforeDead}`,
    );
    if (this.pongTimeouts >= this.opts.pongTimeoutsBeforeDead) {
      this.declareDead();
    } else {
      // Re-arm a fresh 30s timer for the next window. `pendingNonce`
      // intentionally stays null — the next sendPing (within the next
      // 20s) will adopt a fresh nonce via its `else if` branch above,
      // and strict matching means a pong carrying the previous (now
      // stale) nonce will not reset the miss counter.
      this.pongDeadline = setTimeout(
        () => this.handlePongTimeout(),
        this.opts.pongTimeoutMs,
      );
    }
  }

  private declareDead(): void {
    logger.warn(`no pong for ${this.opts.pongTimeoutsBeforeDead} cycles, closing`);
    this.pongTimeouts = 0;
    this.stopHeartbeat();
    this.clearPongDeadline();
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      // Close code 1000 (normal closure) — the worker DO uses the same
      // code for its own heartbeat-driven stale trips (control.md §3:
      // "3 次认定对端已死，断开"). Code 1008 is reserved for protocol-fatal
      // conditions (auth_failed / duplicate_bridge / unsupported_version)
      // per envelope.md §锁版承诺; a missed-heartbeat is not one of them.
      try {
        ws.close(1000, 'pong timeout');
      } catch {
        // already closed
      }
    }
    // `onclose` will run and schedule the reconnect via handleClose().
  }

  private handleMessage(ev: MessageEvent): void {
    let raw: unknown;
    try {
      // `ev.data` is typed `any` in the DOM lib (it can be a string,
      // ArrayBuffer, or Blob depending on the socket's binaryType).
      // We narrow it ourselves to keep the JSON.parse path safe.
      const data: unknown = ev.data;
      raw = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      logger.warn('dropping non-JSON frame');
      return;
    }
    const result = Envelope.safeParse(raw);
    if (!result.success) {
      // Log first Zod issue for triage; the server's own sender already
      // had its chance to validate.
      const issue = result.error.issues[0];
      const where = issue ? `${issue.path.join('.')}: ${issue.message}` : result.error.message;
      logger.warn(`dropping invalid envelope (${where})`);
      return;
    }
    const env = result.data;
    switch (env.type) {
      case 'ping':
        this.replyToPing(env.payload.nonce ?? '');
        break;
      case 'pong': {
        // The worker DO may also issue its own pings (control.md §2 备注).
        // A pong from the server means our pending deadline can be cleared
        // and the consecutive-miss counter reset — BUT only when the nonce
        // matches the one we sent. A non-matching pong (e.g. the DO
        // forwarding a peer's pong back at us, or a stale reply) must NOT
        // clear the deadline: doing so would mask an actual missing pong
        // and prevent the bridge from ever declaring the connection dead.
        const replyNonce = env.payload.nonce;
        if (this.pendingNonce === null || this.pendingNonce === replyNonce) {
          this.clearPongDeadline();
          this.pongTimeouts = 0;
        } else {
          logger.warn(`dropping non-matching pong nonce=${replyNonce}`);
        }
        break;
      }
      case 'bridge_status':
        // bridge_status is server-originated metadata; we just log it.
        logger.info(
          `bridge_status: online=${env.payload.online} reason=${env.payload.reason}`,
        );
        break;
      case 'error':
        logger.warn(
          `server error: code=${env.payload.code} message=${env.payload.message}` +
            ` terminal=${env.payload.terminal ?? false}`,
        );
        break;
      // `handshake` from the server is unexpected (only we send it).
      // Other control types (session_state / session_list / result) and
      // the entire pi family are not handled here — M2's bridge has no
      // downstream consumer for them, and pi frames are rejected at the
      // envelope parser anyway.
    }
  }

  private replyToPing(nonce: string): void {
    this.sendEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'pong',
      id: crypto.randomUUID(),
      payload: { nonce },
    });
  }

  private sendEnvelope(env: EnvelopeT): void {
    const ws = this.ws;
    if (ws === null) return;
    // readyState 1 === OPEN. Anything else (CONNECTING / CLOSING /
    // CLOSED) means the send would just queue / throw silently.
    if (ws.readyState !== 1) {
      logger.warn(`dropping outgoing ${env.type} — socket not open (state=${ws.readyState})`);
      return;
    }
    try {
      ws.send(JSON.stringify(env));
    } catch (err) {
      logger.warn(`failed to send ${env.type}: ${(err as Error).message}`);
    }
  }

  private handleClose(ev?: CloseEvent): void {
    this.cleanupTimers();
    this.ws = null;
    if (this.stopped) return;
    // `code` and `reason` come from the CloseEvent when the platform
    // provides one (browser, Node 22 global WebSocket). They're
    // `undefined` when the event is fabricated — e.g. unit tests pass
    // `undefined as unknown as CloseEvent` to drive the lifecycle
    // without standing up a real socket. We surface whatever we got
    // rather than masking it: an unexplained 1006 is exactly the
    // symptom that the new format is meant to triage.
    const code = ev?.code;
    const reason = ev?.reason ?? '';
    this.attempt++;
    const delay = computeBackoff(
      this.attempt,
      this.opts.rng,
      this.opts.backoffBaseMs,
      this.opts.backoffCapMs,
    );
    logger.info(
      `disconnected from ${this.url} (code=${code}, reason='${reason}') — reconnecting in ${Math.round(delay)}ms (attempt ${this.attempt})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleError(ev: Event): void {
    // Best-effort message extraction. The DOM `ErrorEvent` carries
    // `message` directly; some platforms only expose the underlying
    // `Error` via `error`. We surface whatever we can find rather
    // than swallowing the event — see the connect() comment for why.
    let message: string | undefined;
    const maybeErrorEvent = ev as { message?: unknown; error?: unknown };
    if (typeof maybeErrorEvent.message === 'string' && maybeErrorEvent.message.length > 0) {
      message = maybeErrorEvent.message;
    } else if (maybeErrorEvent.error instanceof Error) {
      message = maybeErrorEvent.error.message;
    }
    logger.warn(message ? `socket error: ${message}` : 'socket error (close will follow)');
  }

  private cleanupTimers(): void {
    this.stopHeartbeat();
    this.clearPongDeadline();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/** Default factory used when the caller doesn't inject one. Reads
 *  `globalThis.WebSocket` lazily (so test code that stubs the global
 *  after construction is picked up on the next reconnect). */
function defaultCreateSocket(url: string, protocols: string[]): WebSocketLike {
  // TS's lib types `new WebSocket(url, protocols?: string | string[])`
  // — a `string[]` argument is accepted as-is, no cast needed. The
  // returned `WebSocket` is structurally wider than `WebSocketLike`
  // (extra methods, event-target parent), so the result needs no cast
  // either: every required property on `WebSocketLike` is present.
  return new WebSocket(url, protocols);
}
