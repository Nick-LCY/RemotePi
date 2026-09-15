// WSS client for the bridge daemon.
//
// Responsibilities:
//   1. Open a WebSocket to the worker with subprotocols
//      ['remotepi.v1', token] (envelope.md §锁版承诺).
//   2. On open, immediately send `control/handshake {role:'bridge', token}`.
//      The bridge does NOT wait for an ack — sustained connection IS the
//      success signal (PRD §2 注: "连接保持即视为握手成功——bridge 不等待
//      任何 ack"). Failures surface via two channels: while the socket
//      is still in CONNECTING (e.g. undici cannot complete the TCP/TLS
//      handshake), the platform emits an `error` frame and — empirically —
//      NOT a follow-up `close`. After OPEN, close frames are the
//      authoritative signal: undici reliably fires close after error.
//      Both paths drive the reconnect loop via `handleClose`.
//   3. On every `control/ping` from the server, reply with `control/pong`
//      carrying the same nonce (control.md §3). The bridge does NOT
//      initiate pings itself — the worker DO sends pings to the bridge
//      on its own 20s heartbeat cadence (`worker/src/heartbeat.ts`),
//      so a missing inbound stream is the natural dead signal.
//   4. Track the timestamp of the most recent inbound envelope (any
//      type). If no frame arrives within `IDLE_TIMEOUT_MS` (default
//      90s ≈ DO's 20s heartbeat ×3 + slack), declare the connection
//      dead and close with code 1000 reason 'idle timeout'. The
//      reconnect is scheduled IMMEDIATELY via a synthetic handleClose
//      call rather than waiting for the close event to arrive — for
//      zombie sockets the close can take tcp_retries2=15 (~13-30 min)
//      to surface, leaving the bridge idle with no timers if we waited.
//   5. Reconnect with exponential backoff: base=1s, cap=30s, ±20% jitter.
//      Reset the attempt counter on the first successfully-parsed inbound
//      envelope after a successful open — i.e. once the worker has
//      confirmed the handshake end-to-end. We do NOT reset on `handleOpen`
//      alone: a `new WebSocket(...)` that completes the TCP/TLS handshake
//      and then immediately receives a 1008 (auth_failed / duplicate_bridge)
//      must keep its attempt counter so the next reconnect waits longer,
//      rather than giving the broken host infinite free retries. The
//      confirmation log line ("handshake confirmed by server") is the
//      single source of truth for "this connection is healthy".
//   6. Every event handler (`onopen` / `onmessage` / `onclose` /
//      `onerror`) captures the socket instance via closure and
//      delegates only when `ws === this.ws`. Without this guard, a
//      late `close` event from a stale socket — undici can emit one
//      minutes after the replacement socket has opened — re-enters
//      handleClose on a connection we never owned, schedules a
//      duplicate reconnect, and corrupts the new socket's idle
//      timer. The guard makes "this is my current socket" the only
//      condition under which state changes are accepted.
//
// `WebSocket` is the global constructor (Node 22 ships one). It's
// injectable via the `createSocket` option for unit tests; otherwise the
// real global is used.
import { Envelope, PROTOCOL_VERSION, type Envelope as EnvelopeT } from '@remotepi/shared';
import { logger } from './logger.js';

/** Protocol constants — see control.md §2 / §3 and PRD §2. Centralised so
 *  tests can override via the options bag without editing these.
 *
 *  IDLE_TIMEOUT_MS is the read-side "dead" detector: if no inbound
 *  envelope arrives within this window the connection is considered
 *  gone. 90s ≈ DO's 20s heartbeat ×3 + slack — generous enough to ride
 *  out a single missed heartbeat without false positives, tight
 *  enough that a fully-dead socket is reaped in well under the worst
 *  reconnect budget. The bridge does NOT send its own pings anymore
 *  (see JSDoc item 4 at the top of this file); the DO drives the
 *  inbound stream on its own cadence. */
export const IDLE_TIMEOUT_MS = 90_000;
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
  const raw = Math.min(baseMs * 2 ** (attempt - 1), capMs);
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
  idleTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Optional inbound-envelope sink. Fires for every envelope the
   *  client does NOT handle internally (i.e. anything that isn't
   *  `ping`, `pong`, `bridge_status`, or `error`). The wiring seam
   *  that connects the WSS loop to the pi subprocess manager.
   *  Defaults to a no-op so this option is opt-in. */
  onEnvelope?: (env: EnvelopeT) => void;
}

/** Internal record of resolved options so the hot paths don't have to
 *  coalesce defaults on every tick. */
interface ResolvedOptions {
  idleTimeoutMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  createSocket: (url: string, protocols: string[]) => WebSocketLike;
  rng: () => number;
  onEnvelope?: (env: EnvelopeT) => void;
}

export class BridgeClient {
  private ws: WebSocketLike | null = null;
  private stopped = false;
  private attempt = 0;
  /** Has the worker confirmed the handshake end-to-end? `handleOpen`
   *  flips this to false on every new socket; the first successfully-
   *  parsed inbound envelope after open flips it back to true (and
   *  resets `attempt` to 0). Until that confirmation arrives, a 1008
   *  from the server is treated as a *failed* connection: the next
   *  reconnect uses the next backoff slot, not base. Without this gate,
   *  a host that immediately 1008s every connect would retry forever
   *  at the floor delay, amplifying the load on a broken peer. */
  private handshakeConfirmed = false;
  /** Read-side idle detector: fires `handleIdleTimeout()` if no
   *  inbound envelope arrives within `opts.idleTimeoutMs`. Refreshed
   *  on every message we successfully parse. `null` when no deadline
   *  is armed (off-state: between connections, after a timeout fires,
   *  or after `stop()`/`cleanupTimers()`). */
  private idleDeadline: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: ResolvedOptions;

  constructor(
    private readonly url: string,
    private readonly token: string,
    options: BridgeClientOptions = {},
  ) {
    this.opts = {
      idleTimeoutMs: options.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
      backoffBaseMs: options.backoffBaseMs ?? BACKOFF_BASE_MS,
      backoffCapMs: options.backoffCapMs ?? BACKOFF_CAP_MS,
      createSocket: options.createSocket ?? defaultCreateSocket,
      rng: options.rng ?? Math.random,
      onEnvelope: options.onEnvelope,
    };
  }

  /** Begin the connect → handshake → heartbeat → reconnect loop.
   *  Idempotent: subsequent calls after `start()` are no-ops. */
  start(): void {
    if (this.idleDeadline !== null || this.reconnectTimer !== null || this.ws !== null) {
      return;
    }
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  /** Set (or clear) the inbound envelope sink after construction.
   *  Pass `undefined` to detach. */
  setEnvelopeSink(sink: ((env: EnvelopeT) => void) | undefined): void {
    this.opts.onEnvelope = sink;
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
    // `new WebSocket(...)` throws synchronously for inputs the URL
    // parser rejects (e.g. plain strings that don't parse as ws/wss
    // URLs, IPv6 brackets malformed, etc.). Without this try/catch the
    // throw bubbles out of the reconnect timer callback and the
    // bridge sits idle: the timer has fired but no replacement is
    // scheduled, so no further retries happen until the process is
    // restarted externally. Catch → log → route through the same
    // backoff path a normal close uses, so a malformed URL is just
    // another reason to retry with the next backoff slot.
    let ws: WebSocketLike;
    try {
      ws = this.opts.createSocket(this.url, ['remotepi.v1', this.token]);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error(`socket construction failed: ${e.message}`);
      this.ws = null;
      // Synthesise a close so we re-enter the same backoff path a
      // remote-initiated drop would take. handleClose's own log line
      // then surfaces the URL + attempt + delay, giving operators
      // both "why" (the error above) and "what's next" in one place.
      this.handleClose(undefined);
      return;
    }
    this.ws = ws;
    // Identity guard: every handler captures `ws` via closure and
    // delegates only when it still matches `this.ws`. Without this,
    // a late `close` event from a stale socket — undici can emit one
    // minutes after the replacement socket has opened — re-enters
    // handleClose on a connection we never owned, schedules a
    // duplicate reconnect, and corrupts the new socket's idle
    // timer. See JSDoc item 6 at the top of this file for the full
    // rationale.
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.handleOpen();
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      this.handleMessage(ev);
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this.handleClose(ev);
    };
    // onerror is advisory for OPEN-state sockets: undici reliably
    // fires close after error in that path (or the 90s read-idle
    // detector covers the silent case), so we don't want to race
    // the close handler by also scheduling a reconnect here.
    // However, while the socket is still in CONNECTING (e.g.
    // undici cannot complete the TCP/TLS handshake), undici emits
    // `error` and — empirically — NOT a follow-up `close`. Leaving
    // CONNECTING errors log-only would leave the bridge idle
    // forever on the canonical "wrong host / DNS failure" path,
    // because close never comes to drive the backoff. handleError
    // checks `readyState === 0` and routes CONNECTING failures
    // through the same handleClose path; OPEN-state errors stay
    // log-only.
    ws.onerror = (ev) => {
      if (ws !== this.ws) return;
      this.handleError(ev);
    };
  }

  private handleOpen(): void {
    logger.info(`connected to ${this.url}`);
    // Mark the handshake as unconfirmed on every fresh open. The first
    // successfully-parsed inbound envelope (in handleMessage) flips
    // it back to true and resets `attempt` — that envelope is the
    // worker's "yes, I see you" signal. Until it arrives, a 1008 close
    // counts as a failed connection and the next reconnect uses the
    // next backoff slot rather than restarting at base. See the
    // `handshakeConfirmed` field JSDoc for the full rationale.
    this.handshakeConfirmed = false;
    this.sendHandshake();
    this.armIdleDeadline();
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

  /** (Re)arm the read-side idle detector. Called from `handleOpen()` on
   *  every successful open, and from `handleMessage()` after every
   *  successfully-parsed inbound envelope (so any byte of traffic
   *  refreshes the window). If a deadline is already armed we tear it
   *  down first — the new window starts from "now", not from the
   *  original arm time. */
  private armIdleDeadline(): void {
    this.clearIdleDeadline();
    this.idleDeadline = setTimeout(() => this.handleIdleTimeout(), this.opts.idleTimeoutMs);
  }

  private clearIdleDeadline(): void {
    if (this.idleDeadline !== null) {
      clearTimeout(this.idleDeadline);
      this.idleDeadline = null;
    }
  }

  /** Fires when `IDLE_TIMEOUT_MS` has elapsed without any inbound
   *  envelope. The reconnect is scheduled IMMEDIATELY via a
   *  synthetic `handleClose()` call rather than waiting for the
   *  real close event — for zombie sockets undici can take
   *  tcp_retries2=15 (~13-30 min) to surface the close, and
   *  waiting would leave the bridge idle for that entire window
   *  with no timers armed. The real close event (if/when it
   *  arrives) is rejected by the identity guard in `connect()`,
   *  so it cannot double-schedule the reconnect.
   *
   *  Two direct callers now drive the backoff via synthetic
   *  handleClose: `handleError()` on a CONNECTING-state socket
   *  (undici error without follow-up close) and this method
   *  (idle timeout on an OPEN-state socket whose close may
   *  take minutes to surface). The bridge no longer declares
   *  death via accumulated ping counters; the absence of an
   *  inbound stream IS the death signal (see JSDoc item 4 at
   *  the top of this file). */
  private handleIdleTimeout(): void {
    if (this.stopped) return;
    this.idleDeadline = null;
    logger.warn(`no inbound frame for ${this.opts.idleTimeoutMs}ms, closing`);
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      try {
        ws.close(1000, 'idle timeout');
      } catch {
        // already closed / errored — nothing to do; the synthetic
        // handleClose below still runs and the reconnect path
        // will still execute.
      }
    }
    // Drive the reconnect via synthetic close. The identity
    // guard in connect() rejects any eventual real close event
    // from this (now stale) socket, so this is the single
    // handleClose invocation for this death cycle.
    this.handleClose(undefined, { code: 1000, reason: 'idle timeout' });
  }

  private handleMessage(ev: MessageEvent): void {
    let raw: unknown;
    try {
      const data: unknown = ev.data;
      raw = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      logger.warn('dropping non-JSON frame');
      return;
    }
    const result = Envelope.safeParse(raw);
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue ? `${issue.path.join('.')}: ${issue.message}` : result.error.message;
      logger.warn(`dropping invalid envelope (${where})`);
      return;
    }
    const env = result.data;
    // First successfully-parsed inbound envelope = worker has confirmed
    // the handshake end-to-end. This is the gate that gates the
    // backoff-reset: until it fires, a 1008 from the server must count
    // as a failed connection and feed into the next backoff slot.
    if (!this.handshakeConfirmed) {
      this.handshakeConfirmed = true;
      this.attempt = 0;
      logger.info('handshake confirmed by server');
    }
    // Any successfully-parsed inbound envelope refreshes the read-side
    // idle detector. We refresh here (after parse, before switch) so
    // the deadline is reset by `ping` (which we then reply to), by
    // `pong` (which we drop), by `bridge_status`, by `error`, AND by
    // every envelope forwarded to the sink — i.e. the user's data path
    // also keeps the connection alive. Without this, a quiet room
    // where nobody's prompting for >IDLE_TIMEOUT_MS would look dead
    // even though the server is healthy. With it, the only thing that
    // fails to refresh the window is a fully-silent socket.
    this.armIdleDeadline();
    switch (env.type) {
      case 'ping':
        // MUST reply — the worker DO pings every 20s as its liveness
        // signal (worker/src/heartbeat.ts); not replying would let the
        // DO declare US dead and tear the bridge down from the other
        // side.
        this.replyToPing(env.payload.nonce ?? '');
        break;
      case 'pong':
        // Bridge no longer initiates pings, so there is no pending
        // nonce to match against. Inbound pongs are either (a) the
        // server replying to a ping we never sent (no-op noise) or
        // (b) a forwarded peer's pong (likewise irrelevant to us).
        break;
      case 'bridge_status':
        logger.info(`bridge_status: online=${env.payload.online} reason=${env.payload.reason}`);
        break;
      case 'error':
        logger.warn(
          `server error: code=${env.payload.code} message=${env.payload.message}` +
            ` terminal=${env.payload.terminal ?? false}`,
        );
        break;
      default:
        this.opts.onEnvelope?.(env);
        break;
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

  /** Public send path — exposed so the PiProcessManager can forward
   *  outbound envelopes through the same socket-ready gate. Tests
   *  can drive the WSS loop with a mock socket and assert on outbound
   *  frames. */
  sendEnvelope(env: EnvelopeT): void {
    const ws = this.ws;
    if (ws === null) return;
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

  /** Tear down the current socket and (if not stopped) schedule a
   *  reconnect. Two call paths land here:
   *    - The platform's `onclose` handler with a real CloseEvent
   *      (server-initiated drop, network reset, normal close from
   *      the worker).
   *    - Synthetic invocations from `handleError()` (CONNECTING-
   *      state error with no follow-up close) and
   *      `handleIdleTimeout()` (open socket whose close event may
   *      take tcp_retries2=15 to surface on a zombie). The
   *      `synthetic` parameter lets those callers stamp a
   *      meaningful `{code, reason}` onto the log line so
   *      operators can tell the two death modes apart.
   *  Idempotent on the `stopped` flag — `stop()` already nulled
   *  `this.ws`, so the second arm of the guard is just
   *  defense-in-depth. */
  private handleClose(
    ev?: CloseEvent,
    synthetic?: { code?: number; reason?: string },
  ): void {
    this.cleanupTimers();
    this.ws = null;
    if (this.stopped) return;
    // The `synthetic` parameter overrides the CloseEvent's
    // code/reason: callers that synthesise a close (currently
    // `handleError` on a CONNECTING error and `handleIdleTimeout`)
    // pass a `{code, reason}` object so the log line carries
    // diagnostic value rather than the bare "code=undefined,
    // reason=''" the unspecified path produces. We surface whatever
    // we got rather than masking it.
    const code = synthetic?.code ?? ev?.code;
    const reason = synthetic?.reason ?? ev?.reason ?? '';
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
    // CONNECTING → drive reconnect. Undici emits `error` without a
    // follow-up `close` when the socket can't complete the TCP/TLS
    // handshake (DNS failure, ECONNREFUSED, SYN blackhole, ...).
    // Leaving CONNECTING errors log-only would idle the bridge
    // forever on the canonical "wrong host" path because close
    // never arrives to drive the backoff. OPEN-state errors stay
    // log-only: undici reliably fires close after error in that
    // state (and the 90s read-idle detector covers the silent
    // case), so we don't want to race the close handler by also
    // scheduling a reconnect from here.
    let message: string | undefined;
    const maybeErrorEvent = ev as { message?: unknown; error?: unknown };
    if (typeof maybeErrorEvent.message === 'string' && maybeErrorEvent.message.length > 0) {
      message = maybeErrorEvent.message;
    } else if (maybeErrorEvent.error instanceof Error) {
      message = maybeErrorEvent.error.message;
    }
    const ws = this.ws;
    if (message) {
      logger.warn(`socket error: ${message}`);
    } else if (ws !== null && ws.readyState === 0) {
      logger.warn('socket error (no close will follow; reconnecting)');
    } else {
      logger.warn('socket error (close will follow)');
    }
    if (ws === null) return;
    if (ws.readyState === 0) {
      this.handleClose(undefined);
    }
  }

  private cleanupTimers(): void {
    this.clearIdleDeadline();
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
  return new WebSocket(url, protocols);
}
