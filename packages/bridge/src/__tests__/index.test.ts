// Vitest spec for the bridge entry point (`index.ts`) — covers PRD §6
// task case 8: `index.ts` startup prints the token and the share URL.
//
// We exercise `start()` directly with an injected mock socket factory
// and a logger spy, which is the lighter of the two options the task
// lists (the alternative is `child_process.spawn` + stdout capture; the
// logger-spy approach avoids cross-process plumbing and the build
// prerequisite `pnpm run build`).

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { BridgeClient, type WebSocketLike } from '../client.js';
import { logger } from '../logger.js';
import { DEFAULT_WORKER_URL, start } from '../index.js';
import { shareUrl } from '../token.js';

class NoopSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  send(): void {
    /* dropped */
  }
  close(): void {
    this.readyState = 3;
    // The bridge doesn't read the CloseEvent payload — its `onclose`
    // is registered as a zero-arg arrow — so we don't construct a real
    // CloseEvent (unavailable in the `node` test environment anyway).
    this.onclose?.(undefined as unknown as CloseEvent);
  }
}

// Capture the spies in `beforeEach` so we can reference them later
// without triggering the `@typescript-eslint/unbound-method` rule on
// `logger.info` etc. (the rule fires when you read a method off an
// object literal; holding it in a typed local sidesteps that).
let infoSpy: MockInstance<typeof logger.info>;
let errorSpy: MockInstance<typeof logger.error>;
// Save & restore the env var so tests don't leak state to each other
// (or to the user's shell, if they happen to have it set when running
// `pnpm test`).
const ORIGINAL_ENV_WORKER_URL = process.env['REMOTEPI_WORKER_URL'];

beforeEach(() => {
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  // Reset to the original value captured at module load. Tests that
  // need a specific value set it explicitly after this hook.
  if (ORIGINAL_ENV_WORKER_URL === undefined) {
    delete process.env['REMOTEPI_WORKER_URL'];
  } else {
    process.env['REMOTEPI_WORKER_URL'] = ORIGINAL_ENV_WORKER_URL;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('start (1 case per M2 PRD §6)', () => {
  it('8. logs the token, the share URL, and the resolved worker URL on startup, then begins the client loop', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();

    // Provide an explicit token so the assertion is deterministic and
    // doesn't rely on the RNG. The shape still matches what
    // `generateToken()` produces in production (32 base64url chars).
    const token = 'a'.repeat(32);
    const result = start({
      token,
      createSocket,
      // Avoid touching process.argv — the test runner's argv isn't a
      // `--worker-url` invocation and the default should win.
      argv: [],
      workerUrl: 'wss://override.test/bridge',
    });

    expect(result.token).toBe(token);
    expect(result.shareUrl).toBe(shareUrl(token));
    expect(result.workerUrl).toBe('wss://override.test/bridge');
    expect(result.client).toBeInstanceOf(BridgeClient);

    // Banner lines must be on the info stream. Order matters so a
    // user scanning stdout sees the most-stable line (token) first
    // and the dynamic one (worker URL) last — that's the line they'll
    // inspect when something is connected to the wrong host.
    expect(infoSpy).toHaveBeenCalledWith(`token: ${token}`);
    expect(infoSpy).toHaveBeenCalledWith(`share URL: ${result.shareUrl}`);
    expect(infoSpy).toHaveBeenCalledWith(`worker URL: ${result.workerUrl}`);
    // Explicit override — production-default hint must NOT show.
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('this is the production default'),
    );

    // The token URL is exactly the one a user would paste into the
    // browser (PRD §2 verification scenario).
    expect(result.shareUrl).toMatch(/^https:\/\/web\.remote-pi\.sankabox\.com\/#/);
    expect(result.shareUrl.endsWith(`#${token}`)).toBe(true);

    result.client.stop();
  });

  it('start() defaults workerUrl to the production domain when no flag is given', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const token = 'b'.repeat(32);
    const result = start({
      token,
      createSocket,
      // Empty argv — explicit so the test isn't sensitive to whatever
      // vitest's runner happens to pass. beforeEach already cleared
      // REMOTEPI_WORKER_URL so the default really wins here.
      argv: [],
    });
    expect(result.workerUrl).toBe(DEFAULT_WORKER_URL);
    // Production-default fallback must surface the hint — that's the
    // whole point of the line: a user running `bridge` with no args
    // gets told they're pointed at prod.
    expect(infoSpy).toHaveBeenCalledWith(
      'hint: this is the production default — for local dev pass -- --worker-url ws://localhost:8787/bridge',
    );
    result.client.stop();
  });

  it('start() honors --worker-url when present in argv', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const token = 'c'.repeat(32);
    const result = start({
      token,
      createSocket,
      argv: ['--worker-url', 'ws://localhost:8787/bridge'],
    });
    expect(result.workerUrl).toBe('ws://localhost:8787/bridge');
    // Explicit override — hint must not appear.
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('this is the production default'),
    );
    result.client.stop();
  });

  it('start() honors REMOTEPI_WORKER_URL env var when no flag is given', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const token = 'd'.repeat(32);
    process.env['REMOTEPI_WORKER_URL'] = 'ws://localhost:8787/bridge';
    const result = start({
      token,
      createSocket,
      // Empty argv so the env var is the only override path.
      argv: [],
    });
    expect(result.workerUrl).toBe('ws://localhost:8787/bridge');
    // The resolved URL differs from the production default, so the
    // hint must NOT fire — it's only for accidental-prod connections.
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('this is the production default'),
    );
    result.client.stop();
  });

  it('start() prefers --worker-url over REMOTEPI_WORKER_URL', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const token = 'e'.repeat(32);
    process.env['REMOTEPI_WORKER_URL'] = 'ws://from-env.test/bridge';
    const result = start({
      token,
      createSocket,
      argv: ['--worker-url', 'ws://from-flag.test/bridge'],
    });
    expect(result.workerUrl).toBe('ws://from-flag.test/bridge');
    result.client.stop();
  });

  it('start() treats empty REMOTEPI_WORKER_URL as not set', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const token = 'f'.repeat(32);
    // A user who exported `REMOTEPI_WORKER_URL=` (or whose shell
    // completion left an empty value behind) must NOT end up with
    // a literal-empty URL passed to the WebSocket constructor.
    process.env['REMOTEPI_WORKER_URL'] = '';
    const result = start({
      token,
      createSocket,
      argv: [],
    });
    expect(result.workerUrl).toBe(DEFAULT_WORKER_URL);
    result.client.stop();
  });
});

// ----- Crash observability (index.ts process handlers) ----------------------
//
// The handlers are installed once at module load (top of `index.ts`),
// not at the start of `start()` — so we drive them with `process.emit`
// rather than calling private symbols. `process.exit` is mocked so a
// successful handler call doesn't tear down the vitest worker.

describe('crash handlers (installed at module load)', () => {
  it('unhandledRejection logs the rejection with its stack and does not exit', () => {
    // The reason is anything async code rejected with — typed as `any`
    // by Node. We pass a real Error so we can assert the stack landed
    // in the log, and we use `Promise.reject(reason)` only as the
    // second arg (matching Node's signature) — the handler ignores it.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    const reason = new Error('async boom from a stray promise');
    process.emit('unhandledRejection', reason, Promise.reject(reason));

    // The handler must have logged something containing both the tag
    // and the underlying message — the `stringContaining` form lets us
    // assert "reason made it into the line" without depending on the
    // exact stack-string format (which V8 may vary).
    const errorCalls = errorSpy.mock.calls.map((args) =>
      args.map((a) => String(a)).join(' '),
    );
    const matched = errorCalls.some(
      (line) => line.includes('unhandledRejection') && line.includes('async boom from a stray promise'),
    );
    expect(matched).toBe(true);

    // Critical invariant: we keep running. A handler that calls exit(1)
    // on rejection would prevent any future retry / re-flush, and
    // would also tear down the vitest worker — so the assertion is
    // both behavioural and a test-isolation tripwire.
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('uncaughtException logs the stack, closes the active client, and exits with code 1', () => {
    // We need a real BridgeClient instance so the handler's
    // `activeClient.stop()` path actually executes — otherwise the
    // close branch is dead code in this test. We use `start()` so
    // `activeClient` is set the way production sets it.
    const createSocket = (): WebSocketLike => new NoopSocket();
    const token = 'g'.repeat(32);
    const result = start({
      token,
      createSocket,
      argv: [],
      workerUrl: 'wss://example.test/bridge',
    });

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const stopSpy = vi.spyOn(result.client, 'stop');

    // Drive the handler synthetically. Real Node `uncaughtException`
    // fires from V8's exception machinery, which isn't reachable from
    // a test — `process.emit` is the standard escape hatch for
    // asserting on registered listeners.
    process.emit('uncaughtException', new Error('sync boom from a stray timer'));

    // 1. The error was logged with the stack (or at least the message,
    //    if V8's stack format varies — we accept either, but the
    //    `uncaughtException` tag MUST be present).
    const errorCalls = errorSpy.mock.calls.map((args) =>
      args.map((a) => String(a)).join(' '),
    );
    expect(
      errorCalls.some(
        (line) =>
          line.includes('uncaughtException') && line.includes('sync boom from a stray timer'),
      ),
    ).toBe(true);

    // 2. The explicit "bridge crashed, exiting" line landed — this
    //    is the line operators grep for to confirm we tried to clean
    //    up rather than dying on the raw exception.
    expect(errorSpy).toHaveBeenCalledWith('bridge crashed, exiting');

    // 3. The active client's stop() ran (best-effort socket close).
    //    The handler must call exactly the returned client — not a
    //    stale handle — so this also guards against accidentally
    //    caching the wrong reference.
    expect(stopSpy).toHaveBeenCalledTimes(1);

    // 4. exit(1) was called. Vitest is normally the only thing that
    //    gets to terminate the worker process; the handler calling
    //    exit itself means the bridge decides when it's done.
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    // The handler cleared activeClient but our local `result.client`
    // is unaffected — we don't call stop() again because the spy
    // already captured the call and a second stop would just be
    // noise in the test logs.
  });

  it('uncaughtException exits even when no client was ever started', () => {
    // Edge case: a process that imports the module for the handlers
    // (or somehow loses its activeClient) must still exit cleanly.
    // The handler tolerates `activeClient === null` without throwing.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    process.emit('uncaughtException', new Error('boom before start()'));

    expect(errorSpy).toHaveBeenCalledWith('bridge crashed, exiting');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});
