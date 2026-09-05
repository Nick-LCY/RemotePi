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
  PONG_TIMEOUT_MS,
  PONG_TIMEOUTS_BEFORE_DEAD,
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
      // Push ping interval far into the future so the test doesn't have
      // to drive the open + first ping cycle to satisfy the heartbeat.
      pingIntervalMs: 60_000,
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
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      pingIntervalMs: 60_000, // suppress our own pings for clarity
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

  it('7. 3 consecutive pong timeouts close the socket and trigger a reconnect', () => {
    vi.useFakeTimers();
    const create = socketFactory();
    const client = new BridgeClient('wss://example.test/bridge', 'TOKEN', {
      createSocket: create,
      // Keep numbers in their normal units (20s / 30s) — fake timers
      // let us advance through them without waiting.
      pingIntervalMs: 20_000,
      pongTimeoutMs: 30_000,
      // Pin the jitter to its minimum (factor = 0.8 → delay = 800ms for
      // attempt 1) so we can advance a deterministic amount and observe
      // the reconnect fire. Real jitter would need us to advance
      // `BACKOFF_BASE_MS * 1.2` (1200ms) to be safe every run.
      rng: () => 0,
    });
    client.start();

    // First socket is constructed immediately.
    expect(MockSocket.instances).toHaveLength(1);
    const first = MockSocket.instances[0]!;
    first.simulateOpen();

    // Handshake + first ping have been sent; clear them so the close
    // assertion at the end only sees the close(1008) call.
    first.sentFrames.length = 0;
    first.closeCalls.length = 0;

    // 3 consecutive 30s windows without a pong:
    //   deadline armed by first ping → 30s
    //   deadline fires → count=1, re-arm
    //   deadline fires → count=2, re-arm
    //   deadline fires → count=3, declareDead → close(1000, "pong timeout")
    // Code 1000 (normal closure) matches what the worker DO uses for its
    // own heartbeat-driven stale trips — 1008 is reserved for protocol
    // fatal conditions (auth_failed / duplicate_bridge / unsupported_version).
    vi.advanceTimersByTime(PONG_TIMEOUT_MS * PONG_TIMEOUTS_BEFORE_DEAD);

    expect(first.closeCalls).toEqual([{ code: 1000, reason: 'pong timeout' }]);

    // The close event also schedules the reconnect — advance just past
    // the smallest possible backoff (base * 0.8 = 800ms with rng=()=>0).
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
      // Push the heartbeat far away so the test only exercises the
      // close path, not the pong-timeout cycle.
      pingIntervalMs: 60_000,
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
      pingIntervalMs: 60_000,
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
});
