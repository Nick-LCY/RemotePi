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
    installLoggerSpies();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      idleTimeoutMs: 60_000,
    });
    client.start();
    const sock = MockSocket.instances[0]!;

    // Drive the ErrorEvent branch with a real `message` payload.
    sock.onerror?.({ message: 'connect ECONNREFUSED 127.0.0.1:8787' } as unknown as Event);

    expect(warnSpy).toHaveBeenCalledWith('socket error: connect ECONNREFUSED 127.0.0.1:8787');

    // Second branch: no `message`, but a typed `Error` on `.error`.
    sock.onerror?.({ error: new Error('getaddrinfo ENOTFOUND host') } as unknown as Event);
    expect(warnSpy).toHaveBeenCalledWith('socket error: getaddrinfo ENOTFOUND host');

    // Third branch: empty event — we still log something rather than
    // going silent, but without a bogus string in the output.
    sock.onerror?.({} as Event);
    expect(warnSpy).toHaveBeenCalledWith('socket error (close will follow)');

    client.stop();
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
