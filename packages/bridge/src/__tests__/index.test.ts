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
// Save & restore the env var so tests don't leak state to each other
// (or to the user's shell, if they happen to have it set when running
// `pnpm test`).
const ORIGINAL_ENV_WORKER_URL = process.env['REMOTEPI_WORKER_URL'];

beforeEach(() => {
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
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
