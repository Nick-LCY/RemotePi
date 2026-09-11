// Vitest specs for the WSS client (`client.ts`) — covers PRD §6 / task
// cases 4, 5, 6, 7. Token tests (1–3) live in `token.test.ts`; the
// index-banner stdout test (8) lives in `index.test.ts`.
//
// Strategy: inject a hand-rolled `MockSocket` via the `createSocket`
// option so we never touch the real network. The mock implements the
// `WebSocketLike` interface and exposes `simulateOpen` / `simulateMessage`
// / `simulateClose` helpers so each test can drive the lifecycle
// explicitly.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BridgeClient,
  computeBackoff,
  IDLE_TIMEOUT_MS,
  type WebSocketLike,
} from '../client.js';
import { logger } from '../logger.js';

// ----- Mock WebSocket --------------------------------------------------------

/** Per-instance record of every constructor / send / close call so tests
 *  can assert on what the bridge actually did. */
class MockSocket implements WebSocketLike {
  static instances: MockSocket[] = [];

  readyState = 0; // CONNECTING — matches the real WebSocket before `open`.
  readonly sentFrames: string[] = [];
  /** `close()` calls — captured separately from `simulateClose()` (which
   *  fires the onclose handler) so tests can tell who initiated the close. */
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  /** When `true`, `close()` still records the call and flips readyState
   *  to CLOSED, but does NOT fire `onclose`. Simulates undici's
   *  zombie-socket behaviour: the bridge calls `close(1000, 'idle
   *  timeout')`, the OS hasn't fully torn down the TCP socket yet, and
   *  the platform doesn't deliver a close event until
   *  tcp_retries2=15 (~13-30 min). Tests that want the synthetic
   *  reconnect path (handleIdleTimeout → handleClose without waiting
   *  for an event) flip this on before advancing the idle timer.
   *  Defaults to `false` so the synchronous-fire behaviour matches
   *  every other test in this file. */
  suppressOnclose = false;

  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(
    public readonly url: string,
    public readonly protocols: string[],
  ) {
    MockSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    // Mirror the real WebSocket: calling close() flips the state and
    // fires onclose synchronously, which lets handleClose() schedule
    // the reconnect without `await`.
    if (this.readyState === 3) return; // already CLOSED
    this.readyState = 3;
    // Zombie mode: the OS hasn't fully torn down the TCP socket yet,
    // so the platform can't deliver a close event. The bridge's
    // reconnect path must NOT depend on this event firing — see
    // handleIdleTimeout's synthetic handleClose for the contract.
    if (this.suppressOnclose) return;
    // Bridge-initiated closes don't carry a real CloseEvent (the
    // default `node` env has no constructor for it), and the bridge
    // only needs `code` / `reason` from server-initiated drops. So
    // we pass `undefined` here; tests that want to exercise a real
    // CloseEvent path call `simulateRemoteClose({ code, reason })`.
    this.onclose?.(undefined as unknown as CloseEvent);
  }

  // ---- test helpers ----

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.(undefined as unknown as Event);
  }

  simulateMessage(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.({ data } as unknown as MessageEvent);
  }

  /** Trigger a close WITHOUT recording it as a `close()` call — used to
   *  simulate the server dropping the connection. The optional payload
   *  is forwarded to `onclose` so tests can verify how the client
   *  handles a real CloseEvent (with `.code` / `.reason`). */
  simulateRemoteClose(payload?: { code?: number; reason?: string }): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (payload !== undefined) {
      this.onclose?.(payload as unknown as CloseEvent);
    } else {
      this.onclose?.(undefined as unknown as CloseEvent);
    }
  }
}

/** Factory the BridgeClient options will use. Each test calls this once
 *  up-front and then pulls instances out of `MockSocket.instances`. */
function socketFactory(): (url: string, protocols: string[]) => WebSocketLike {
  return (url, protocols) => new MockSocket(url, protocols);
}

/** Shorthand: parse the bridge's outbound frames into typed JSON for
 *  assertion convenience. */
function parseFrame(raw: string): { type: string; payload?: unknown } {
  return JSON.parse(raw) as { type: string; payload?: unknown };
}

// ----- Lifecycle reset between tests ----------------------------------------

beforeEach(() => {
  MockSocket.instances.length = 0;
  // Real timers are needed for most tests; the 30s×3 test explicitly
  // calls `vi.useFakeTimers()` inside its own scope.
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ----- Logger spies -----------------------------------------------------------

// These are opt-in: only tests that care about log output set them up
// (spying globally would change `console.log` reference identity and
// could mask ordering bugs in the no-log-assertion tests).
let infoSpy: MockInstance<typeof logger.info> | undefined;
let warnSpy: MockInstance<typeof logger.warn> | undefined;

function installLoggerSpies(): void {
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
}

/** Pull the `reconnecting in Nms` value out of the most recent
 *  handleClose log line. The tests that need to advance the backoff
 *  timer exactly read the delay from the log (5e established this
 *  pattern) so they never over/under-advance and let a stale timer
 *  leak into the next cycle. Returns the parsed integer ms.
 *  Throws if the most recent infoSpy call doesn't look like a
 *  `disconnected from …` line — guards against a refactor that
 *  changes the log format, AND against an accidental substring
 *  match against some other info line that happens to contain
 *  `reconnecting in Nms` (e.g. an unrelated upstream retry log).
 *  Better to fail loudly here than silently advance by the wrong
 *  number and let a stale timer leak into the next cycle. */
function readReconnectDelay(): number {
  const last = infoSpy?.mock.calls.at(-1);
  expect(last).toBeDefined();
  const line = typeof last![0] === 'string' ? last![0] : '';
  // Anchor on the `disconnected from ` prefix first. handleClose's
  // log line is the only infoSpy call site in this file that emits
  // `reconnecting in Nms` — but the loose regex below would also
  // match any future info line that happens to contain that phrase,
  // silently advancing the timer by the wrong number. Reject the
  // line outright if it doesn't start with the handleClose prefix.
  expect(line.startsWith('disconnected from ')).toBe(true);
  const match = line.match(/reconnecting in (\d+)ms/);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

// ----- Tests -----------------------------------------------------------------

describe('BridgeClient (4 cases per M2 PRD §6)', () => {
  it('4. constructor passes subprotocols [remotepi.v1, token] to the WebSocket', () => {
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN-XYZ', {
      createSocket: create,
      // Push the read-side idle detector far into the future so the
      // test doesn't have to drive traffic just to keep the
      // connection "alive" while it inspects the socket config.
      idleTimeoutMs: 60_000,
    });
    client.start();

    expect(MockSocket.instances).toHaveLength(1);
    const sock = MockSocket.instances[0]!;
    expect(sock.url).toBe('wss://example.test/bridge');
    expect(sock.protocols).toEqual(['remotepi.v1', 'TOKEN-XYZ']);

    // Don't leave the reconnect timer scheduled.
    client.stop();
  });

  it('5. responds to a ping with a pong carrying the same nonce', () => {
    // Regression for the read-side overhaul: even though the bridge
    // no longer initiates pings, it MUST still reply to inbound
    // `control/ping` frames (control.md §3). The worker DO pings
    // every 20s as its liveness signal; not replying would let the
    // DO declare us dead and tear the bridge down from the other
    // side. The reply is the bridge's contribution to its side of
    // the heartbeat contract; the read-side idle detector is the
    // bridge's independent liveness check on the worker.
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      // Far-future idle window so the read-side detector doesn't
      // fire during this test — we're only asserting the ping/pong
      // frame exchange, not liveness.
      idleTimeoutMs: 60_000,
    });
    client.start();
    const sock = MockSocket.instances[0]!;
    sock.simulateOpen();

    // Drop the handshake frame the bridge sent on open — we only care
    // about the ping → pong exchange here.
    sock.sentFrames.length = 0;

    sock.simulateMessage({
      v: 1,
      kind: 'control',
      type: 'ping',
      id: 'server-ping-1',
      payload: { nonce: 'n1' },
    });

    expect(sock.sentFrames).toHaveLength(1);
    const pong = parseFrame(sock.sentFrames[0]!);
    expect(pong.type).toBe('pong');
    expect((pong.payload as { nonce: string }).nonce).toBe('n1');

    // A second ping should get a second pong, also with its own nonce.
    sock.simulateMessage({
      v: 1,
      kind: 'control',
      type: 'ping',
      id: 'server-ping-2',
      payload: { nonce: 'roundtrip-2026' },
    });

    expect(sock.sentFrames).toHaveLength(2);
    const pong2 = parseFrame(sock.sentFrames[1]!);
    expect(pong2.type).toBe('pong');
    expect((pong2.payload as { nonce: string }).nonce).toBe('roundtrip-2026');

    client.stop();
  });

  it('5b. inbound envelope refreshes the read-side idle deadline', () => {
    // The idle detector is a type-agnostic "anything inbound counts"
    // rule: a `bridge_status` push, a forwarded prompt, an error
    // frame — all of them reset the 30s window. This is what
    // prevents a quiet room (no prompts for >IDLE_TIMEOUT_MS) from
    // looking dead. Drive the lifecycle end-to-end with fake
    // timers: open → wait 20s → push an envelope → wait another
    // 20s (40s cumulative, would have fired at 30s without the
    // refresh) → confirm the socket is still open → then advance
    // the full remaining window with no traffic → confirm the
    // close(1000, 'idle timeout') call finally fires.
    vi.useFakeTimers();
    installLoggerSpies();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      idleTimeoutMs: 30_000,
    });
    client.start();
    const sock = MockSocket.instances[0]!;
    sock.simulateOpen();

    // Clear handshake + any close noise so the assertion at the end
    // only sees the final idle-timeout close.
    sock.sentFrames.length = 0;
    sock.closeCalls.length = 0;

    // Advance 20s — well within the 30s window. No close.
    vi.advanceTimersByTime(20_000);
    expect(sock.closeCalls).toEqual([]);

    // Receive a `bridge_status` frame — the envelope refreshes the
    // deadline, so the 20s already-advanced time does NOT count
    // against the new window. `bridge_status` is a natural choice
    // because it's server-originated metadata and would land on
    // every real connect. The payload includes the `changed_at`
    // ISO-8601 timestamp the schema requires; without it safeParse
    // would drop the frame and the test would degenerate into a
    // straightforward idle-timeout fire at the 30s mark.
    sock.simulateMessage({
      v: 1,
      kind: 'control',
      type: 'bridge_status',
      id: 'srv-bs-1',
      payload: {
        online: true,
        changed_at: '2026-01-01T00:00:00Z',
        reason: 'connected',
      },
    });

    // Another 20s. Cumulative advanced time is 40s, but the deadline
    // was re-armed by the bridge_status message, so 20s into the
    // new window — still no close.
    vi.advanceTimersByTime(20_000);
    expect(sock.closeCalls).toEqual([]);

    // Now advance the FULL remaining 30s window with zero inbound
    // traffic. 30_001 ticks past 30s exactly to dodge any off-by-one
    // in the fake-timer scheduler. The deadline fires → close.
    vi.advanceTimersByTime(30_001);
    expect(sock.closeCalls).toEqual([{ code: 1000, reason: 'idle timeout' }]);

    client.stop();
    vi.useRealTimers();
  });

  it('5c. stop() clears the idle deadline so a pending timer can never fire after shutdown', () => {
    // The read-side detector arms a setTimeout on open. If we just
    // left it armed, an operator-driven `stop()` followed by 30s of
    // wall-clock silence would trigger a phantom `no inbound frame`
    // close on a socket we no longer care about — which would
    // invoke handleClose() and (because `stopped=true`) no-op the
    // reconnect, but the warning log would still fire and pollute
    // shutdown traces. The fix is to clear the deadline inside
    // `cleanupTimers()`, which `stop()` calls. This test guards the
    // invariant by advancing well past the original window and
    // asserting nothing was closed.
    vi.useFakeTimers();
    installLoggerSpies();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      idleTimeoutMs: 5_000,
    });
    client.start();
    const sock = MockSocket.instances[0]!;
    sock.simulateOpen();

    sock.closeCalls.length = 0;

    // 3s in — still well inside the 5s window. No close yet.
    vi.advanceTimersByTime(3_000);
    expect(sock.closeCalls).toEqual([]);

    // stop() runs cleanupTimers() which must clear the deadline.
    client.stop();
    sock.closeCalls.length = 0; // ignore stop()'s own ws.close() call
    expect(sock.closeCalls).toEqual([]);

    // Now advance 10s (double the original window). If the deadline
    // had not been cleared we'd see a phantom `idle timeout` close
    // call land here.
    vi.advanceTimersByTime(10_000);
    expect(sock.closeCalls).toEqual([]);

    // The "no inbound frame" warn also must not have been emitted —
    // if it had, it would mean the timer fired before clear ran.
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('no inbound frame'),
    );

    vi.useRealTimers();
  });

  it('5d. inbound pong is silently dropped (no outbound frame, no nonce-related warn)', () => {
    // 方案 A' leaves the bridge with no pending nonce of its own
    // (it doesn't initiate pings). Inbound pongs can therefore
    // arrive only because someone else is echoing — e.g. the DO
    // forwarding a peer's pong, or a pong the server sent in
    // reply to a ping we never issued. Either way the right
    // thing is to silently drop them. This test pins down both
    // halves of that contract:
    //   - no outbound frame is produced (we don't reply-to-pong
    //     because there's no protocol reason to);
    //   - no warn-level log is emitted mentioning `nonce` or
    //     `dropping non-matching` (the old match-check used to
    //     warn on non-matching nonces; that's gone).
    // A `bridge_status` envelope is delivered AFTER the pong to
    // prove the pong did not throw, did not desync the parser,
    // and did not leave the client in a broken state.
    installLoggerSpies();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      idleTimeoutMs: 60_000,
    });
    client.start();
    const sock = MockSocket.instances[0]!;
    sock.simulateOpen();
    sock.sentFrames.length = 0;

    sock.simulateMessage({
      v: 1,
      kind: 'control',
      type: 'pong',
      id: 'srv-pong-1',
      payload: { nonce: 'not-our-nonce' },
    });

    // No outbound frame.
    expect(sock.sentFrames).toEqual([]);

    // No nonce-related warn (the old `dropping non-matching pong
    // nonce=...` line is gone; nothing else should mention nonce).
    // The non-null assertion is safe: `installLoggerSpies()` ran in
    // the lines above and assigned `warnSpy` to a `vi.spyOn(...)`
    // handle. The `let` declaration typing can't be tightened
    // without rewriting the install helper, which the existing
    // tests in this file don't depend on. The runtime
    // `typeof first === 'string'` guard exists because vitest's
    // `mock.calls[i]` is typed as `Parameters<typeof logger.warn>`
    // — a heterogeneous tuple where the first element is sometimes
    // a string and sometimes an Error object. We only care about
    // the string branch here; the `String(...)` lint rule prefers
    // an explicit guard over `String(...)` because the latter
    // would silently fall back to `[object Object]` for non-string
    // arguments and could mask a future regression.
    const nonceWarns = warnSpy!.mock.calls
      .map((c) => {
        const first = c[0];
        return typeof first === 'string' ? first : '';
      })
      .filter((line) => line.toLowerCase().includes('nonce'));
    expect(nonceWarns).toEqual([]);

    // The bridge_status envelope after the pong proves the parser
    // / dispatcher is still healthy: it lands in the logger.info
    // branch as expected. (Includes `changed_at` to satisfy the
    // schema; without it safeParse would drop the frame as
    // invalid and the assertion below would never resolve. The
    // `reason` must be one of the schema's enum values
    // ['connected', 'closed', 'stale'] — `stale` is the closest
    // match for "this bridge is still around after a stray pong".)
    sock.simulateMessage({
      v: 1,
      kind: 'control',
      type: 'bridge_status',
      id: 'srv-bs-2',
      payload: {
        online: true,
        changed_at: '2026-01-01T00:00:00Z',
        reason: 'stale',
      },
    });
    expect(infoSpy).toHaveBeenCalledWith(
      'bridge_status: online=true reason=stale',
    );

    client.stop();
  });

  it('5e. handleOpen no longer resets attempt — consecutive 1008 closes grow the backoff exponentially', () => {
    // Bridge-side half of the zombie-rejection-loop fix (worker side:
    // room.ts startChallenge + resolveChallenge). The previous
    // shape reset the attempt counter on every `handleOpen()`, so a
    // server that 1008s every reconnect (the canonical
    // `duplicate_bridge` rejection) saw the bridge retry at the
    // floor delay forever — pinning a healthy bridge into a
    // permanent 800ms-spam against a hostile or unreachable worker.
    // The fix: `handleOpen()` no longer touches `attempt`. Only the
    // first successfully-parsed inbound envelope (the worker's
    // "yes, I see you" signal) resets the counter via the
    // `handshakeConfirmed` gate inside `handleMessage()`. Until
    // that envelope arrives, every reconnect uses the next backoff
    // slot — so a broken peer pays an exponentially-growing
    // reconnect cost rather than holding the bridge at the floor.
    //
    // Pin jitter to the bottom of the band (factor = 0.8 → delay =
    // 0.8 * base * 2^(attempt-1)) so the expected sequence is the
    // fully-deterministic 800 / 1600 / 3200 / 6400 / 12800 ms. Real
    // jitter would otherwise drag the asserted numbers out of the
    // exact-equality path. Test 6 covers the jittered range in
    // isolation; here we only need to prove the counter grows.
    installLoggerSpies();
    vi.useFakeTimers();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      // Push the read-side idle detector well past the longest
      // single-cycle advance (12800 ms) so it never fires mid-test
      // and shadows the close path we're asserting on.
      idleTimeoutMs: 60_000,
      rng: () => 0,
    });
    client.start();

    // Drive 5 reconnect cycles. Each one opens a fresh socket, the
    // bridge sends a handshake frame, and the server immediately
    // 1008s the connection (the duplicate_bridge scenario the
    // zombie loop reproduces). The attempt counter MUST grow
    // across cycles because handleOpen no longer resets it.
    const delays: number[] = [];
    const attempts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const sock = MockSocket.instances[i]!;
      sock.simulateOpen();
      // Server rejects the handshake with 1008 + reason
      // 'duplicate_bridge' — the canonical rejection the worker
      // DO emits for the zombie-loop scenario (see room.ts
      // startChallenge / resolveChallenge). The bridge never sees
      // a valid inbound envelope, so handshakeConfirmed stays
      // false and the attempt counter keeps growing.
      sock.simulateRemoteClose({ code: 1008, reason: 'duplicate_bridge' });
      // Extract (delay, attempt) from handleClose's log line —
      //   "reconnecting in <delay>ms (attempt <N>)"
      // so we can assert both numbers explicitly. The mock's
      // onclose fires synchronously inside simulateRemoteClose, so
      // by the time we read the log handleClose has already run.
      const lastLog = infoSpy!.mock.calls.at(-1)?.[0];
      expect(typeof lastLog).toBe('string');
      const match = /reconnecting in (\d+)ms \(attempt (\d+)\)/.exec(
        lastLog as string,
      );
      expect(match).not.toBeNull();
      const delay = Number(match![1]);
      const attempt = Number(match![2]);
      delays.push(delay);
      attempts.push(attempt);
      // Advance past the recorded delay so the next reconnect
      // timer fires. Reading the delay from the log keeps the
      // advance exact — no over/undershoot that would let a stale
      // timer leak into the next cycle.
      vi.advanceTimersByTime(delay);
    }

    // Counter grew 1 → 5 across the 5 cycles. The exact-delta
    // assertion is what catches a regression where someone
    // re-introduces the old "handleOpen resets attempt" behaviour
    // — every cycle's attempt would snap back to 1 and this
    // array would read [1, 1, 1, 1, 1].
    expect(attempts).toEqual([1, 2, 3, 4, 5]);

    // Backoff grew exponentially: 0.8 * 1000 * 2^(N-1) → 800,
    // 1600, 3200, 6400, 12800 ms. We assert exact equality
    // because rng=()=>0 pins the jitter at the floor — any
    // deviation here means the backoff math (or the pin) is
    // wrong, not the test.
    expect(delays).toEqual([800, 1600, 3200, 6400, 12800]);

    client.stop();
    vi.useRealTimers();
  });

  it('5f. first successfully-parsed inbound envelope resets attempt and logs "handshake confirmed by server"', () => {
    // The other half of the 5e/5f pair: once the server finally
    // sends a parseable envelope (e.g. `bridge_status`), the
    // bridge treats the handshake as end-to-end confirmed — the
    // `handshakeConfirmed` gate inside `handleMessage()` flips
    // to true, `attempt` resets to 0, and the explicit
    // "handshake confirmed by server" log line fires so an
    // operator scanning the bridge log can tell which reconnects
    // actually completed the protocol (vs. those that opened the
    // TCP/TLS socket but were then 1008'd by the worker).
    //
    // After confirmation, a subsequent disconnect starts back at
    // attempt 1 — proving the reset fired AND that the next
    // backoff slot is the floor again, not the carry-over from
    // the failed cycles. This is the full round-trip: a hostile
    // peer → exponential growth → handshake succeeds → fresh
    // attempt counter for the next failure cycle.
    installLoggerSpies();
    vi.useFakeTimers();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      idleTimeoutMs: 60_000,
      rng: () => 0,
    });
    client.start();

    // Two failed reconnects first so the attempt counter has
    // actually grown above 1 — proving the reset is non-trivial
    // (a test that resets from attempt 1 to 0 wouldn't distinguish
    // "no growth" from "growth happened but the reset undid it").
    for (let i = 0; i < 2; i++) {
      const sock = MockSocket.instances[i]!;
      sock.simulateOpen();
      sock.simulateRemoteClose({ code: 1008, reason: 'duplicate_bridge' });
      // Read the actual delay from the disconnect log and
      // advance by that — same pattern as 5e. After two cycles
      // attempt should be 2 (asserted below).
      const lastLog = infoSpy!.mock.calls.at(-1)?.[0];
      expect(typeof lastLog).toBe('string');
      const match = /reconnecting in (\d+)ms \(attempt (\d+)\)/.exec(
        lastLog as string,
      );
      expect(match).not.toBeNull();
      expect(Number(match![2])).toBe(i + 1); // 1 then 2
      vi.advanceTimersByTime(Number(match![1]));
    }

    // Pre-flight: the "handshake confirmed" line has NOT fired
    // yet — no valid inbound envelope has reached the bridge.
    // Using `.some` with a string-typed guard (vi's mock.calls[i]
    // is `Parameters<typeof logger.info>`, which is a tuple that
    // may include non-string branches in other tests; here it's
    // all strings but we keep the guard consistent with 5d).
    expect(
      infoSpy!.mock.calls
        .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
        .some((line) => line.includes('handshake confirmed by server')),
    ).toBe(false);

    // Third socket opens and the server finally sends a valid
    // envelope. bridge_status is the natural choice — it's
    // server-originated metadata that lands on every real
    // connect, and its schema (online/changed_at/reason) is
    // fully covered by Envelope.safeParse. The changed_at
    // timestamp satisfies the schema's required field; without
    // it safeParse would drop the frame as invalid and the
    // test would degenerate into "first safeParse success
    // never fires, attempt never resets".
    const sock3 = MockSocket.instances[2]!;
    sock3.simulateOpen();
    sock3.simulateMessage({
      v: 1,
      kind: 'control',
      type: 'bridge_status',
      id: 'srv-bs-confirm',
      payload: {
        online: true,
        changed_at: '2026-01-01T00:00:00Z',
        reason: 'connected',
      },
    });

    // The explicit confirmation log line fires. This is the
    // operator-facing seam: without it, a log of "disconnected
    // (code=1008) reconnecting in 800ms" followed by silence
    // gives no clue whether the next connect completed the
    // handshake or just opened a socket.
    expect(infoSpy).toHaveBeenCalledWith('handshake confirmed by server');

    // Now disconnect — the attempt counter MUST restart at 1.
    // If the reset had not fired, the log would say "attempt 3"
    // (carry-over from the two prior cycles). This is the
    // assertion that pins the "reset is wired through" contract.
    sock3.simulateRemoteClose({ code: 1006, reason: '' });
    const lastLog = infoSpy!.mock.calls.at(-1)?.[0];
    expect(typeof lastLog).toBe('string');
    const match = /reconnecting in (\d+)ms \(attempt (\d+)\)/.exec(
      lastLog as string,
    );
    expect(match).not.toBeNull();
    expect(Number(match![2])).toBe(1);
    // And the delay is back at the floor (800 ms with rng=()=>0),
    // not the carry-over 3200 ms — same backoff math, fresh start.
    expect(Number(match![1])).toBe(800);

    client.stop();
    vi.useRealTimers();
  });

  it('5g. CONNECTING-phase error without follow-up close drives reconnect via handleError', () => {
    // Undici on a refused TCP handshake emits `error` and never
    // emits `close` (the canonical "wrong host / DNS failure" path).
    // The previous behaviour left CONNECTING errors log-only, so the
    // bridge sat idle until the process was restarted externally.
    // The fix: handleError checks `readyState === 0` and routes the
    // CONNECTING case through the same handleClose() the close path
    // uses — attempt grows, backoff timer fires, fresh socket is
    // constructed. This test pins down that path end-to-end:
    //   - warn line carries the platform message ("connect
    //     ECONNREFUSED 127.0.0.1:8787") so an operator can
    //     immediately tell DNS / routing / port from auth.
    //   - the bridge never called ws.close() itself — handleError
    //     never invokes close(), only handleIdleTimeout does.
    //   - the synthetic handleClose line carries code=undefined /
    //     reason='' (no CloseEvent exists for an undici CONNECTING
    //     failure), the canonical 800 ms floor delay with rng=()=>0,
    //     and attempt=1.
    //   - advancing exactly BACKOFF_BASE_MS constructs a fresh
    //     MockSocket, proving the backoff timer armed correctly.
    installLoggerSpies();
    vi.useFakeTimers();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      // Far-future so the read-side idle detector can't fire
      // mid-test and shadow the close path we're asserting on.
      idleTimeoutMs: 60_000,
      rng: () => 0,
    });
    client.start();
    const sock = MockSocket.instances[0]!;
    // sock is in CONNECTING (readyState=0) — undici on a refused TCP
    // handshake never opens. This is the whole point: handleError
    // must recognise the CONNECTING branch via readyState, not via
    // simulateOpen.
    sock.onerror?.({ message: 'connect ECONNREFUSED 127.0.0.1:8787' } as unknown as Event);

    // The error message made it to the warn log.
    expect(warnSpy).toHaveBeenCalledWith(
      'socket error: connect ECONNREFUSED 127.0.0.1:8787',
    );
    // handleError never calls close() on the socket — only
    // handleIdleTimeout does. If this array is non-empty, the
    // fix regressed to "log + close" instead of "log + handleClose".
    expect(sock.closeCalls).toEqual([]);
    // The synthetic handleClose fired: code=undefined, reason='',
    // attempt=1, delay=800 ms with rng=()=>0. This is the line
    // operators will see for every "wrong host" failure mode.
    expect(infoSpy).toHaveBeenCalledWith(
      "disconnected from wss://example.test/bridge (code=undefined, reason='') — reconnecting in 800ms (attempt 1)",
    );

    // Advance past the floor delay (1000ms ≥ 800ms floor; rng=()=>0
    // pins the floor): the reconnect timer fires and a fresh socket
    // is constructed. Any advance ≥ the recorded floor is safe
    // here because the timer is one-shot and the next test starts
    // with vi.useFakeTimers()'s clock at the same origin; the exact
    // advance is what keeps a stale timer from leaking into the
    // next test's frame.
    expect(MockSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(MockSocket.instances).toHaveLength(2);

    client.stop();
    vi.useRealTimers();
  });

  it('5h. late close after a CONNECTING-phase error is rejected by the identity guard (no double reconnect)', () => {
    // Worst-case interleaving: undici emits the error first, the
    // bridge drives a reconnect via handleError → handleClose, and
    // THEN undici finally surfaces the close event for the original
    // (already-replaced) socket. Without the identity guard this
    // would re-enter handleClose on a connection the bridge no
    // longer owns, schedule a duplicate reconnect, and corrupt the
    // new socket's idle timer. The fix: every event handler
    // captures `ws` via closure and delegates only when
    // `ws === this.ws`. After the first handleClose nulled
    // `this.ws`, the late close hits `sock !== null` and
    // short-circuits without logging or scheduling.
    installLoggerSpies();
    vi.useFakeTimers();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      idleTimeoutMs: 60_000,
      rng: () => 0,
    });
    client.start();
    const sock = MockSocket.instances[0]!;

    // Phase 1: CONNECTING error → handleError → handleClose.
    sock.onerror?.({ message: 'connect ECONNREFUSED 127.0.0.1:8787' } as unknown as Event);

    // Phase 2: undici eventually delivers a late close event for
    // the stale socket. The identity guard must reject it.
    sock.simulateRemoteClose({ code: 1006, reason: '' });

    // Exactly ONE "disconnected" log line — not two. The first
    // came from the error path (synthetic handleClose); the
    // second would have come from the late close if the guard
    // had failed to reject it. Counting lines (rather than
    // asserting the specific message) keeps the test honest
    // about what the failure mode looks like in production.
    const disconnectLines = infoSpy!.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .filter((line) => line.startsWith('disconnected from '));
    expect(disconnectLines).toHaveLength(1);
    expect(disconnectLines[0]).toBe(
      "disconnected from wss://example.test/bridge (code=undefined, reason='') — reconnecting in 800ms (attempt 1)",
    );

    // Advancing exactly the floor delay constructs a single
    // replacement socket. If the guard had failed, we'd see two
    // backoff timers and two replacement sockets by this point
    // (the second one arriving at 2*BACKOFF_BASE_MS — but the
    // assertion is on count, not timing).
    expect(MockSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(MockSocket.instances).toHaveLength(2);

    client.stop();
    vi.useRealTimers();
  });

  it('5i. idle timeout schedules reconnect immediately, not waiting for the close event (zombie socket)', () => {
    // The TCP zombie case: undici's close event for a fully-dead
    // socket can take tcp_retries2=15 (~13-30 min) to surface.
    // If the bridge waited for the event, it would sit idle for
    // that entire window with no timers armed — exactly the
    // stop-state the fix is meant to prevent. The fix: handleIdleTimeout
    // calls handleClose synthetically with `{code:1000, reason:'idle
    // timeout'}` immediately after `ws.close()`, so the backoff timer
    // fires on the schedule, not on the platform's event latency.
    // The identity guard rejects the real close when it eventually
    // arrives, so the synthetic invocation is the only one.
    //
    // We exercise this with suppressOnclose=true: the mock records
    // the ws.close(1000, 'idle timeout') call but does NOT fire
    // onclose, simulating the zombie scenario.
    vi.useFakeTimers();
    installLoggerSpies();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      // Production default — fake timers let us jump through it
      // instantly. No idle-window manipulation needed because the
      // assertion below is on the post-deadline state, not on the
      // detector's accuracy.
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      rng: () => 0,
    });
    client.start();
    const sock = MockSocket.instances[0]!;
    sock.simulateOpen();
    // Force zombie mode: ws.close() will be called but the mock
    // will NOT fire onclose, simulating undici's tcp_retries2=15
    // delay. This is the whole reason the synthetic handleClose
    // path exists.
    sock.suppressOnclose = true;

    // No traffic — advance exactly the idle window. The deadline
    // armed by handleOpen() fires → handleIdleTimeout → ws.close()
    // (recorded, no onclose) → synthetic handleClose → backoff
    // timer scheduled.
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS);

    // ws.close() was recorded with the correct code/reason.
    expect(sock.closeCalls).toEqual([{ code: 1000, reason: 'idle timeout' }]);

    // Operator-facing breadcrumb: handleIdleTimeout emits a warn
    // line BEFORE the synthetic close fires, so an operator
    // scanning the bridge log can tell "dead connection, not a
    // protocol rejection" from "server-side 1008 / duplicate"
    // at a glance. Pinning the exact format here locks the
    // breadcrumb into the contract — a future refactor that
    // drops or rewrites the line would surface as a failing
    // test rather than a silent regression in triage UX.
    expect(warnSpy).toHaveBeenCalledWith(
      `no inbound frame for ${IDLE_TIMEOUT_MS}ms, closing`,
    );

    // Reconnect scheduled even though onclose never fired.
    expect(MockSocket.instances).toHaveLength(1);
    expect(infoSpy).toHaveBeenCalledWith(
      "disconnected from wss://example.test/bridge (code=1000, reason='idle timeout') — reconnecting in 800ms (attempt 1)",
    );
    // Only ONE disconnect line — the synthetic close did its job,
    // no late close arrived (suppressOnclose is still on).
    const disconnectLines = infoSpy!.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .filter((line) => line.startsWith('disconnected from '));
    expect(disconnectLines).toHaveLength(1);

    // Advancing exactly BACKOFF_BASE_MS constructs the replacement
    // socket — proves the synthetic handleClose scheduled the
    // backoff timer, not just logged.
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(MockSocket.instances).toHaveLength(2);

    client.stop();
    vi.useRealTimers();
  });

  it('5j. late close from a stale socket is ignored once the replacement has opened (identity guard)', () => {
    // The opposite timing from 5h: the original socket's close
    // event arrives AFTER the replacement has already opened and
    // is the live connection. Without the identity guard, the
    // stale close would re-enter handleClose on the new socket's
    // behalf, incrementing `attempt` (corrupting the counter for
    // the next failure) and tearing down the live connection
    // via cleanupTimers. The fix: every handler captures `ws`
    // via closure and delegates only when `ws === this.ws` —
    // the stale close compares the captured `ws` (sock0) against
    // `this.ws` (now sock1) and short-circuits.
    installLoggerSpies();
    vi.useFakeTimers();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      idleTimeoutMs: 60_000,
      rng: () => 0,
    });
    client.start();

    // Full cycle on the first socket: open → remote close(1006)
    // → backoff → second socket opens. This is the same shape as
    // the existing "handleClose logs ..." test, minus the final
    // assertions on the log message (we re-derive them below).
    const sock0 = MockSocket.instances[0]!;
    sock0.simulateOpen();
    sock0.simulateRemoteClose({ code: 1006, reason: '' });
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    const sock1 = MockSocket.instances[1]!;
    sock1.simulateOpen();

    // Snapshot the disconnect line count BEFORE the stale close
    // fires. The first cycle contributes one "disconnected" line
    // (sock0's 1006 close). We do NOT use mockClear because the
    // rest of the spies (warnSpy etc.) are needed by later
    // assertions — instead we filter on the prefix we care about.
    const linesBefore = infoSpy!.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .filter((line) => line.startsWith('disconnected from ')).length;

    // The stale socket finally delivers its close event. The
    // identity guard must reject it. The onclose handler compares
    // its closure-captured `ws` (sock0) against `this.ws` (sock1)
    // and short-circuits before handleClose runs.
    sock0.simulateRemoteClose({ code: 1006, reason: '' });

    const linesAfter = infoSpy!.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .filter((line) => line.startsWith('disconnected from ')).length;
    expect(linesAfter).toBe(linesBefore);

    // sock1 was never touched by the stale close — no spurious
    // close call (the guard short-circuited before any state
    // change), and its readyState is still OPEN because nothing
    // else has happened to it.
    expect(sock1.closeCalls).toEqual([]);
    expect(sock1.readyState).toBe(1);

    client.stop();
    vi.useRealTimers();
  });

  it('5k. stop() suppresses further reconnect attempts even when an error arrives afterwards', () => {
    // After stop() nulls `this.ws`, a stale `sock.onerror` — say
    // a platform event that was already in flight when shutdown
    // began — hits the identity guard in connect() and
    // short-circuits without logging or driving handleError.
    // This is the "5k" arm of the identity-guard rationale: the
    // guard makes "this is my current socket" the only condition
    // under which state changes are accepted, and a post-stop
    // event has no current socket.
    installLoggerSpies();
    vi.useFakeTimers();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      idleTimeoutMs: 60_000,
      rng: () => 0,
    });
    client.start();
    const sock = MockSocket.instances[0]!;
    // Shutdown. cleanupTimers() runs and `this.ws` becomes null.
    client.stop();
    // Reset the spies so we can isolate what the post-stop
    // onerror actually did. Without this reset, prior calls
    // (e.g. the constructor handshake frame) would dilute the
    // assertion.
    infoSpy!.mockClear();
    warnSpy!.mockClear();

    // Post-stop onerror — identity guard rejects because
    // `sock !== null` (this.ws is null).
    sock.onerror?.({ message: 'connect ETIMEDOUT' } as unknown as Event);

    // No new socket was constructed.
    expect(MockSocket.instances).toHaveLength(1);
    // No "disconnected" line: handleClose was never called.
    expect(infoSpy).not.toHaveBeenCalled();
    // No warn line either: handleError was never called (the
    // identity guard short-circuited at the onerror handler).
    expect(warnSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('5l. OPEN-phase error is logged but does NOT drive a reconnect (close is the authoritative signal)', () => {
    // The other half of the handleError contract: OPEN-state
    // errors are advisory only. Undici reliably fires close after
    // error in this state, so we don't want to race the close
    // handler by also scheduling a reconnect from here. If the
    // error didn't come with a follow-up close, the 90s read-idle
    // detector covers the silent case. The handleError body
    // checks `readyState === 0` and only routes CONNECTING
    // errors through handleClose; OPEN errors return early after
    // the warn log. We verify the contract end-to-end:
    //   - warnSpy receives the platform message.
    //   - no new socket, no close call, no "disconnected" log.
    //   - a subsequent legitimate remote close DOES drive a
    //     reconnect — proving the socket is still healthy enough
    //     to terminate normally.
    installLoggerSpies();
    vi.useFakeTimers();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      idleTimeoutMs: 60_000,
      rng: () => 0,
    });
    client.start();
    const sock = MockSocket.instances[0]!;
    sock.simulateOpen();
    // Reset spies to isolate the OPEN-phase error path from the
    // handshake send and open logs.
    infoSpy!.mockClear();
    warnSpy!.mockClear();

    sock.onerror?.({ message: 'TLS handshake failed' } as unknown as Event);

    // Warn line carries the platform message — operators can
    // correlate this with the eventual close (or with no close
    // at all if the socket is still alive despite the warning).
    expect(warnSpy).toHaveBeenCalledWith('socket error: TLS handshake failed');
    // No new socket (handleError did NOT call handleClose).
    expect(MockSocket.instances).toHaveLength(1);
    // No bridge-initiated close call.
    expect(sock.closeCalls).toEqual([]);
    // No "disconnected" log.
    expect(infoSpy).not.toHaveBeenCalled();

    // Subsequent legitimate remote close still drives a normal
    // reconnect — the OPEN-error path didn't desync the parser,
    // the timer machinery, or the identity guard.
    sock.simulateRemoteClose({ code: 1006, reason: '' });
    expect(infoSpy).toHaveBeenCalledWith(
      "disconnected from wss://example.test/bridge (code=1006, reason='') — reconnecting in 800ms (attempt 1)",
    );
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(MockSocket.instances).toHaveLength(2);

    client.stop();
    vi.useRealTimers();
  });

  it('6. computeBackoff produces the 1/2/4/8/16/30/30 sequence within ±20% jitter', () => {
    // Use a fixed midpoint of the jitter range (factor = 1.0) so we can
    // assert exact base values; then sweep with `Math.random` and assert
    // the bracket holds.
    const noJitter = () => 0.25; // factor = 0.8 + 0.25*0.4 = 0.9
    // 0.9 is a deliberate mid-range pick — it lies strictly inside [0.8, 1.2)
    // and isn't an endpoint, so we exercise the multiplicative path.
    const seq = [1, 2, 3, 4, 5, 6, 7].map((attempt) =>
      computeBackoff(attempt, noJitter),
    );
    expect(seq[0]).toBeCloseTo(BACKOFF_BASE_MS * 0.9, 5); // 1000
    expect(seq[1]).toBeCloseTo(BACKOFF_BASE_MS * 2 * 0.9, 5); // 2000
    expect(seq[2]).toBeCloseTo(BACKOFF_BASE_MS * 4 * 0.9, 5); // 4000
    expect(seq[3]).toBeCloseTo(BACKOFF_BASE_MS * 8 * 0.9, 5); // 8000
    expect(seq[4]).toBeCloseTo(BACKOFF_BASE_MS * 16 * 0.9, 5); // 16000
    // Capped: raw would be 32000 and 64000 → both clamp to 30000.
    expect(seq[5]).toBeCloseTo(BACKOFF_CAP_MS * 0.9, 5);
    expect(seq[6]).toBeCloseTo(BACKOFF_CAP_MS * 0.9, 5);

    // Range assertion with the real RNG — each draw must fall inside
    // [base * 0.8, base * 1.2], capped.
    const bases = [
      BACKOFF_BASE_MS, // 1
      BACKOFF_BASE_MS * 2, // 2
      BACKOFF_BASE_MS * 4, // 3
      BACKOFF_BASE_MS * 8, // 4
      BACKOFF_BASE_MS * 16, // 5
      BACKOFF_CAP_MS, // 6
      BACKOFF_CAP_MS, // 7
    ];
    for (let attempt = 1; attempt <= 7; attempt++) {
      const base = bases[attempt - 1]!;
      for (let trial = 0; trial < 20; trial++) {
        const delay = computeBackoff(attempt);
        expect(delay).toBeGreaterThanOrEqual(base * 0.8);
        expect(delay).toBeLessThanOrEqual(base * 1.2);
      }
    }
  });

  it('7. read-side idle timeout closes the socket and triggers a reconnect (no outbound ping required)', () => {
    // The previous incarnation of this test drove "3 consecutive
    // pong timeouts": the bridge sent a ping, waited 30s, counted a
    // miss, re-armed, waited 30s, counted another miss, … and only
    // after 3 misses declared the connection dead. That model is
    // gone (方案 A'): the bridge never initiates pings, and the
    // only signal it owns is "no inbound frame arrived for the
    // idle window". This test now exercises that single signal:
    // simulateOpen (which arms the deadline) → advance exactly
    // IDLE_TIMEOUT_MS with no inbound traffic → handleIdleTimeout
    // fires → ws.close(1000, 'idle timeout') → onclose → handleClose
    // → backoff → second socket is constructed.
    vi.useFakeTimers();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      // Use the production default (90s) — fake timers let us jump
      // through it instantly. This is the key behavioural change
      // vs the old test: there is NO 20s pingInterval to coordinate
      // and NO 30s pong deadline to chain.
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      // Pin jitter to the bottom of the band (factor = 0.8 → delay
      // = 800ms for attempt 1 with rng=()=>0) so the reconnect
      // advance is deterministic. Real jitter would need
      // `BACKOFF_BASE_MS * 1.2` (1200ms) to be safe every run.
      rng: () => 0,
    });
    client.start();

    // First socket is constructed immediately.
    expect(MockSocket.instances).toHaveLength(1);
    const first = MockSocket.instances[0]!;
    first.simulateOpen();

    // Handshake has been sent; clear it and any other outbound
    // frames so the close-assertion below sees ONLY the
    // close(1000, 'idle timeout') call.
    first.sentFrames.length = 0;
    first.closeCalls.length = 0;

    // Advance exactly IDLE_TIMEOUT_MS with zero inbound traffic.
    // The deadline armed by handleOpen() fires → handleIdleTimeout
    // → ws.close(1000, 'idle timeout'). The mock's close() invokes
    // onclose synchronously, which drives handleClose() and
    // schedules the reconnect.
    //
    // Code 1000 (normal closure) is what the worker DO uses for its
    // own heartbeat-driven stale trips — 1008 is reserved for
    // protocol-fatal conditions (auth_failed / duplicate_bridge /
    // unsupported_version) per envelope.md §锁版承诺; a silent
    // socket is not one of them.
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS);

    expect(first.closeCalls).toEqual([{ code: 1000, reason: 'idle timeout' }]);

    // The close event also schedules the reconnect — advance just
    // past the smallest possible backoff (base * 0.8 = 800ms with
    // rng=()=>0). A second MockSocket should be constructed.
    const beforeReconnect = MockSocket.instances.length;
    expect(beforeReconnect).toBe(1);
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(MockSocket.instances.length).toBe(beforeReconnect + 1);

    client.stop();
    vi.useRealTimers();
  });

  it('handleClose logs the disconnected URL with close code/reason when the platform provides a CloseEvent', () => {
    // Real-world diagnostic value: 1006 is the canonical "abnormal
    // closure" code users see when the server doesn't reply or the
    // network drops mid-handshake. Without code/reason in the log,
    // a user staring at "reconnecting in 800ms (attempt 1)" has zero
    // clue whether to blame DNS, routing, auth, or the server itself.
    installLoggerSpies();
    vi.useFakeTimers();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      // Push the read-side idle detector far away so the test only
      // exercises the close path, not the idle-timeout cycle.
      idleTimeoutMs: 60_000,
      // Pin jitter to the bottom of the band so the logged delay is
      // deterministic (800ms for attempt 1 with rng=()=>0).
      rng: () => 0,
    });
    client.start();
    const sock = MockSocket.instances[0]!;
    sock.simulateOpen();
    sock.simulateRemoteClose({ code: 1006, reason: '' });
    vi.advanceTimersByTime(BACKOFF_BASE_MS);

    // The log must contain the target URL, the close code, the empty
    // reason (typical for 1006 — no payload comes back), the delay, and
    // the attempt number — all in one human-grep-able line.
    expect(infoSpy).toHaveBeenCalledWith(
      "disconnected from wss://example.test/bridge (code=1006, reason='') — reconnecting in 800ms (attempt 1)",
    );

    client.stop();
    vi.useRealTimers();
  });

  it('onerror logs a warn instead of silently swallowing the event', () => {
    // The previous behaviour was `ws.onerror = () => undefined;` — any
    // error event vanished, so the only observable signal was the
    // follow-on close (often code=1006 with no context). The fix:
    // surface the message immediately so users can correlate "DNS
    // resolution failed" / "ECONNREFUSED" / etc. with the eventual
    // close. Close still drives the reconnect — onerror stays advisory.
    //
    // Each branch of `handleError`'s message-extraction logic must be
    // driven on a FRESH CONNECTING socket: the identity guard in
    // connect() (`ws !== this.ws` in the onerror closure) rejects any
    // follow-up onerror on a stale socket — i.e. one whose
    // handleError → handleClose has already nulled `this.ws`. So once
    // a CONNECTING socket fires one error and triggers a reconnect,
    // any further onerror events on that same socket are silently
    // dropped by design (5k pins this). To exercise all three
    // message-extraction branches in one test, we advance the backoff
    // after each branch and grab the next fresh MockSocket.
    installLoggerSpies();
    vi.useFakeTimers();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      // Far-future so the read-side idle detector can't fire
      // mid-test and shadow the onerror path we're asserting on.
      idleTimeoutMs: 60_000,
      // Pin jitter to the bottom of the band (factor = 0.8 → delay
      // = 800 ms for attempt 1 with rng=()=>0) so each reconnect
      // advance is deterministic.
      rng: () => 0,
    });
    client.start();

    // ----- Branch 1: ErrorEvent with a real `message` payload -----
    const sock0 = MockSocket.instances[0]!;
    sock0.onerror?.({ message: 'connect ECONNREFUSED 127.0.0.1:8787' } as unknown as Event);
    expect(warnSpy).toHaveBeenCalledWith(
      'socket error: connect ECONNREFUSED 127.0.0.1:8787',
    );
    // Reconnect armed on this fresh CONNECTING socket. The delay
    // doubles each attempt (1000 → 2000 → 4000 ms base, × 0.8 jitter
    // floor with rng=()=>0), so reading the delay from the disconnect
    // log keeps each advance exact — same pattern as 5j — and dodges
    // a stale-timer leak into the next cycle.
    const delay1 = readReconnectDelay();
    expect(MockSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(delay1);
    expect(MockSocket.instances).toHaveLength(2);

    // ----- Branch 2: no `message`, but a typed `Error` on `.error` -----
    const sock1 = MockSocket.instances[1]!;
    sock1.onerror?.({ error: new Error('getaddrinfo ENOTFOUND host') } as unknown as Event);
    expect(warnSpy).toHaveBeenCalledWith('socket error: getaddrinfo ENOTFOUND host');
    const delay2 = readReconnectDelay();
    expect(MockSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(delay2);
    expect(MockSocket.instances).toHaveLength(3);

    // ----- Branch 3: empty event — log something rather than go silent -----
    // sock2 has not been simulateOpen()ed, so it is still CONNECTING
    // (readyState=0). The empty-event fallback log differentiates by
    // readyState: CONNECTING → "no close will follow; reconnecting"
    // (because undici on a refused TCP handshake will never deliver
    // close; we're about to drive the backoff ourselves), every
    // other state → "close will follow" (undici in OPEN reliably
    // fires close, and the 90s read-idle detector covers the
    // silent OPEN case). The split prevents the "wrong host"
    // failure mode from logging the misleading "close will
    // follow" line.
    const sock2 = MockSocket.instances[2]!;
    sock2.onerror?.({} as Event);
    expect(warnSpy).toHaveBeenCalledWith('socket error (no close will follow; reconnecting)');

    client.stop();
    vi.useRealTimers();
  });

  it('a synchronous throw from createSocket() logs an error and routes through the reconnect backoff', () => {
    // `new WebSocket(...)` throws synchronously for inputs the URL
    // parser rejects (e.g. raw strings without `ws://` / `wss://`).
    // Before the fix, the throw bubbled out of the reconnect timer
    // callback and the bridge sat idle: the timer had fired but no
    // replacement was scheduled, so the loop died silently. The fix
    // routes the failure through `handleClose()` so the next backoff
    // slot fires a fresh attempt — same code path as a remote drop.
    installLoggerSpies();
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(logger, 'error');
    let calls = 0;
    const createSocket: (url: string, protocols: string[]) => WebSocketLike = (
      url,
      protocols,
    ) => {
      calls += 1;
      if (calls === 1) {
        // Mirror what `new WebSocket('not-a-url')` throws in Node.
        throw new Error('Invalid URL: not-a-url');
      }
      // Subsequent attempts succeed — proves the retry loop re-armed.
      return new MockSocket(url, protocols);
    };
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket,
      // Pin jitter to the bottom of the band so the timer advance is
      // deterministic (800ms for attempt 1 with rng=()=>0).
      rng: () => 0,
    });

    client.start();

    // First attempt threw synchronously — no MockSocket was constructed,
    // but the error was logged and a backoff timer was scheduled.
    expect(calls).toBe(1);
    expect(MockSocket.instances).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      'socket construction failed: Invalid URL: not-a-url',
    );
    // handleClose also emits the reconnect line so operators see
    // "why" (this log line) AND "what's next" (the disconnect line).
    expect(infoSpy).toHaveBeenCalledWith(
      "disconnected from wss://example.test/bridge (code=undefined, reason='') — reconnecting in 800ms (attempt 1)",
    );

    // Advance just past the smallest possible backoff — the next
    // createSocket call should now fire and succeed (counter > 1).
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(calls).toBe(2);
    expect(MockSocket.instances).toHaveLength(1);

    client.stop();
    vi.useRealTimers();
  });

  it('onEnvelope sink receives every non-internally-handled envelope (S3 review)', () => {
    // S3 review follow-up: the WSS client's onEnvelope seam is the
    // bridge between the network layer and the pi subprocess
    // manager. Every envelope that the client doesn't handle
    // internally (`ping`, `pong`, `bridge_status`, `error`,
    // `handshake`) MUST be forwarded to the sink so the manager
    // can route on `kind` + `type`. This guards against a
    // regression where a new control type added in M3 (e.g.
    // `result` or `session_state` arriving from web) gets
    // accidentally swallowed by the default branch.
    const create = socketFactory();
    const onEnvelope = vi.fn<(env: unknown) => void>();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      idleTimeoutMs: 60_000, // far-future so the read-side idle detector never fires in this test
    });
    client.setEnvelopeSink(onEnvelope);
    client.start();
    const sock = MockSocket.instances[0]!;
    sock.simulateOpen();

    // Drop the handshake frame so the assertion below doesn't see it.
    sock.sentFrames.length = 0;
    onEnvelope.mockClear();

    // Push three envelopes: one pi-family command (forwarded) and
    // one control `get_state` (forwarded). Internally-handled types
    // (`ping`) must NOT reach the sink.
    sock.simulateMessage({
      v: 1,
      kind: 'pi',
      type: 'prompt',
      id: 'web-p1',
      payload: { content: 'hello' },
    });
    sock.simulateMessage({
      v: 1,
      kind: 'control',
      type: 'get_state',
      id: 'web-g1',
      payload: {},
    });
    sock.simulateMessage({
      v: 1,
      kind: 'control',
      type: 'ping',
      id: 'server-ping-1',
      payload: { nonce: 'n1' },
    });

    // Two envelopes should have reached the sink (prompt + get_state);
    // the ping was consumed internally and produced a pong.
    expect(onEnvelope).toHaveBeenCalledTimes(2);
    const types = onEnvelope.mock.calls
      .map((c) => (c[0] as { type?: string }).type)
      .filter((t): t is string => typeof t === 'string');
    expect(types).toContain('prompt');
    expect(types).toContain('get_state');
    expect(types).not.toContain('ping');

    client.stop();
  });
});
