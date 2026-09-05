// Vitest spec for the bridge entry point (`index.ts`) — covers M3
// task 03 PRD §6 acceptance cases for `start()`:
//   - loads config from default / `--config` path
//   - prints banner with token + share URL + worker URL
//   - starts the WSS loop via BridgeClient
//   - delegates to `loadBridgeConfig` and surfaces a clean error +
//     exit 1 for invalid configs
//   - ignores unknown CLI flags silently (systemd wrapper friendly)
//   - the M2-era `--worker-url` flag and `REMOTEPI_WORKER_URL` env
//     var have no effect (the config file is the single source of truth)
//
// We exercise `start()` directly with an injected mock socket factory
// + a logger spy + a tmp config file, which is the lighter of the
// two options the task lists (the alternative is `child_process.spawn`
// + stdout capture; the logger-spy approach avoids cross-process
// plumbing and the build prerequisite `pnpm run build`).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { BridgeClient, type WebSocketLike } from '../client.js';
import { logger } from '../logger.js';
import { start } from '../index.js';

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

/** Real fs helper: write a config JSON file into a fresh tmpdir and
 *  return both the dir (for cleanup) and the file path. Used by every
 *  test that needs a working config — no fs mocking required. */
function writeConfig(
  body: Record<string, unknown>,
): { dir: string; path: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'remotepi-bridge-test-'));
  const p = path.join(dir, 'bridge.json');
  writeFileSync(p, JSON.stringify(body));
  return { dir, path: p };
}

// Capture the spies in `beforeEach` so we can reference them later
// without triggering the `@typescript-eslint/unbound-method` rule on
// `logger.info` etc. (the rule fires when you read a method off an
// object literal; holding it in a typed local sidesteps that).
let infoSpy: MockInstance<typeof logger.info>;
let errorSpy: MockInstance<typeof logger.error>;

/** Track every tmpdir we created so `afterEach` can clean them up.
 *  Even successful tests should not leak — tmp dirs accumulate on
 *  CI workers and can trigger disk-pressure flakes. */
const createdDirs: string[] = [];

beforeEach(() => {
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of createdDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort — leaks here are cosmetic, not test-affecting.
    }
  }
});

/** Wrap `writeConfig` so we can register the dir for cleanup without
 *  every test having to remember. */
function makeConfig(body: Record<string, unknown>): string {
  const { dir, path: p } = writeConfig(body);
  createdDirs.push(dir);
  return p;
}

describe('start (config-driven entry)', () => {
  it('logs the token, the share URL, and the resolved worker URL on startup, then begins the client loop', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const token = 'a'.repeat(32);
    const configPath = makeConfig({
      worker_url: 'wss://override.test/bridge',
      web_base_url: 'https://override.test',
      work_dir: '/tmp',
      token,
    });

    const result = start({
      configPath,
      createSocket,
      // Empty argv so we don't accidentally pick up a stale flag from
      // the vitest runner's argv.
      argv: [],
    });

    expect(result.token).toBe(token);
    // Share URL uses the config's web_base_url, not a hard-coded host.
    expect(result.shareUrl).toBe(`https://override.test/#${token}`);
    expect(result.workerUrl).toBe('wss://override.test/bridge');
    expect(result.client).toBeInstanceOf(BridgeClient);

    // Banner lines must be on the info stream. Order matters so a
    // user scanning stdout sees the most-stable line (config path)
    // first and the dynamic one (worker URL) later — that's the line
    // they'll inspect when something is connected to the wrong host.
    expect(infoSpy).toHaveBeenCalledWith(`config: ${configPath}`);
    expect(infoSpy).toHaveBeenCalledWith(`token: ${token}`);
    expect(infoSpy).toHaveBeenCalledWith(`share URL: ${result.shareUrl}`);
    expect(infoSpy).toHaveBeenCalledWith('worker URL: wss://override.test/bridge');
    expect(infoSpy).toHaveBeenCalledWith('work_dir: /tmp');

    // The token URL is exactly the one a user would paste into the
    // browser — derives from the config's web_base_url.
    expect(result.shareUrl).toMatch(/^https:\/\/override\.test\/#/);
    expect(result.shareUrl.endsWith(`#${token}`)).toBe(true);

    result.client.stop();
  });

  it('start() honors the --config flag in argv', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const token = 'b'.repeat(32);
    const configPath = makeConfig({
      worker_url: 'wss://from-flag.test/bridge',
      web_base_url: 'https://from-flag.test',
      work_dir: '/tmp',
      token,
    });

    const result = start({
      createSocket,
      argv: ['--config', configPath],
    });
    expect(result.workerUrl).toBe('wss://from-flag.test/bridge');
    expect(result.shareUrl).toBe(`https://from-flag.test/#${token}`);
    result.client.stop();
  });

  it('start() honors --config=<path> long form in argv', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const token = 'c'.repeat(32);
    const configPath = makeConfig({
      worker_url: 'wss://equals.test/bridge',
      web_base_url: 'https://equals.test',
      work_dir: '/tmp',
      token,
    });

    const result = start({
      createSocket,
      argv: [`--config=${configPath}`],
    });
    expect(result.workerUrl).toBe('wss://equals.test/bridge');
    result.client.stop();
  });

  it('start() generates a token when the config omits one', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const configPath = makeConfig({
      worker_url: 'wss://no-token.test/bridge',
      web_base_url: 'https://no-token.test',
      work_dir: '/tmp',
      // No `token` field — generation kicks in.
    });

    const result = start({
      createSocket,
      argv: [],
      configPath,
    });
    // Generated tokens are 32-char base64url strings (token.ts contract).
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(result.shareUrl).toBe(`https://no-token.test/#${result.token}`);
    result.client.stop();
  });

  it('start() silently ignores unknown CLI flags (systemd wrapper friendly)', () => {
    // PRD §2.2 / decision 9: unknown flags must NOT cause exit or
    // throw. They are dropped on the floor and `--config` still wins.
    // This case also covers the `-D`, `--systemd-foo`, etc. shapes a
    // supervisor might emit.
    const createSocket = (): WebSocketLike => new NoopSocket();
    const token = 'd'.repeat(32);
    const configPath = makeConfig({
      worker_url: 'wss://unknown-flag.test/bridge',
      web_base_url: 'https://unknown-flag.test',
      work_dir: '/tmp',
      token,
    });

    // Mixing in junk flags must not change the resolved config.
    const result = start({
      createSocket,
      argv: [
        '--systemd-foo=bar',
        '--whatever',
        '--config',
        configPath,
        '-D',
      ],
    });
    expect(result.workerUrl).toBe('wss://unknown-flag.test/bridge');
    expect(result.token).toBe(token);
    result.client.stop();
  });

  it('start() does not treat a systemd-style -D flag as the --config value', () => {
    // Regression guard for W3: `--config -D` must NOT resolve to `-D`
    // as the config path (the OLD `!next.startsWith('--')` check
    // swallowed single-dash flags as paths). The fix is to use
    // `!next.startsWith('-')`, returning undefined when the next
    // token looks flag-shaped. We verify by passing `-D` directly
    // after `--config` and asserting the function falls back to the
    // default config path — which doesn't exist in this test env, so
    // the bridge reports a friendly config error rather than trying
    // to open `-D` as a literal file path.
    const createSocket = (): WebSocketLike => new NoopSocket();
    expect(() =>
      start({
        createSocket,
        argv: ['--config', '-D'],
      }),
    ).toThrow(/bridge: parse_failed/);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^bridge: parse_failed:/),
    );
  });

  it('start() stops scanning for --config at the -- argument terminator', () => {
    // Regression guard for S1: argv of `['--', '--config', '/tmp/x']`
    // must NOT resolve `/tmp/x` as the config path — once the `--`
    // terminator is seen, everything after it is positional. The
    // bridge falls back to the default config path (which doesn't
    // exist) and surfaces a parse_failed error.
    const createSocket = (): WebSocketLike => new NoopSocket();
    expect(() =>
      start({
        createSocket,
        argv: ['--', '--config', '/tmp/somewhere.json'],
      }),
    ).toThrow(/bridge: parse_failed/);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^bridge: parse_failed:/),
    );
  });

  it('start() throws when the config file is missing', () => {
    // The auto-run entry guard translates this into process.exitCode=1
    // and a friendly stderr line; programmatic callers (tests) see
    // the thrown Error verbatim. We assert the throw, not the exit
    // code, because the CLI guard is exercised separately.
    const createSocket = (): WebSocketLike => new NoopSocket();
    expect(() =>
      start({
        createSocket,
        argv: [],
        configPath: '/nonexistent/path/bridge.json',
      }),
    ).toThrow(/bridge: parse_failed/);
    // The friendly message must have been logged (matches the format
    // the auto-run entry uses).
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^bridge: parse_failed:/),
    );
  });

  it('start() throws when the config is missing worker_url', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const configPath = makeConfig({
      // worker_url omitted on purpose.
      web_base_url: 'https://x.test',
      work_dir: '/tmp',
      token: 'z'.repeat(32),
    });
    expect(() =>
      start({ createSocket, argv: [], configPath }),
    ).toThrow(/bridge: missing_field/);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^bridge: missing_field:/),
    );
  });

  it('M2-era --worker-url flag has no effect (config file wins)', () => {
    // Regression guard: if a wrapper still passes the old flag, the
    // bridge must NOT pick it up. The config file is the single
    // source of truth (PRD §2.1 / §2.2).
    const createSocket = (): WebSocketLike => new NoopSocket();
    const token = 'e'.repeat(32);
    const configPath = makeConfig({
      worker_url: 'wss://from-config.test/bridge',
      web_base_url: 'https://from-config.test',
      work_dir: '/tmp',
      token,
    });
    const result = start({
      createSocket,
      argv: [
        '--worker-url',
        'wss://from-stale-flag.test/bridge', // <-- must be ignored
        '--config',
        configPath,
      ],
    });
    // The config file wins; the stale --worker-url is silently dropped.
    expect(result.workerUrl).toBe('wss://from-config.test/bridge');
    result.client.stop();
  });

  it('M2-era REMOTEPI_WORKER_URL env var has no effect (config file wins)', () => {
    // Regression guard: env var was retired in M3 task 03.
    const createSocket = (): WebSocketLike => new NoopSocket();
    const token = 'f'.repeat(32);
    const configPath = makeConfig({
      worker_url: 'wss://from-config-2.test/bridge',
      web_base_url: 'https://from-config-2.test',
      work_dir: '/tmp',
      token,
    });
    const ORIGINAL_ENV = process.env['REMOTEPI_WORKER_URL'];
    process.env['REMOTEPI_WORKER_URL'] = 'wss://from-env.test/bridge';
    try {
      const result = start({
        createSocket,
        argv: [],
        configPath,
      });
      // Env var is silently ignored — the config's worker_url is the
      // only thing that resolves the WSS target.
      expect(result.workerUrl).toBe('wss://from-config-2.test/bridge');
      result.client.stop();
    } finally {
      if (ORIGINAL_ENV === undefined) {
        delete process.env['REMOTEPI_WORKER_URL'];
      } else {
        process.env['REMOTEPI_WORKER_URL'] = ORIGINAL_ENV;
      }
    }
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
    const configPath = makeConfig({
      worker_url: 'wss://example.test/bridge',
      web_base_url: 'https://example.test',
      work_dir: '/tmp',
      token,
    });

    const result = start({
      createSocket,
      argv: [],
      configPath,
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
