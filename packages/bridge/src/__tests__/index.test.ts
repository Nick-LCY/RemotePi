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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
function writeConfig(body: Record<string, unknown>): { dir: string; path: string } {
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

/** Snapshot of `XDG_CONFIG_HOME` taken at the start of each test so
 *  the afterEach cleanup can restore it. Tests that call
 *  `isolateXdgConfigHome()` overwrite this snapshot's value for the
 *  duration of one test; without the snapshot + restore pair, a test
 *  run that flips `XDG_CONFIG_HOME` would leak the empty tmpdir into
 *  the developer's effective XDG root for any subsequent vitest run. */
let originalXdgConfigHome: string | undefined;

/** Track every tmpdir we created so `afterEach` can clean them up.
 *  Even successful tests should not leak — tmp dirs accumulate on
 *  CI workers and can trigger disk-pressure flakes. */
const createdDirs: string[] = [];

beforeEach(() => {
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  // Snapshot XDG so `afterEach` can restore it; see note above on
  // why this lives per-test rather than at module load.
  originalXdgConfigHome = process.env['XDG_CONFIG_HOME'];
  // M4 task 04: default XDG_CONFIG_HOME to a fresh empty tmpdir so
  // `start()`'s state.json work (resolveDefaultStatePath → loadStateFile
  // + migrateFromBridgeConfig) lands in a sealed location rather than
  // the developer's real `~/.config/remotepi/`. Without this, every
  // pre-M4 test that calls `start()` with `work_dir: '/tmp'` would
  // silently migrate the developer's bridge.json work_dir to a
  // real `~/.config/remotepi/state.json` (the M3→M4 onboarding path
  // fires for any test config that has a valid work_dir). Tests that
  // explicitly set XDG_CONFIG_HOME for a different purpose (the
  // `isolateXdgConfigHome` callers below) overwrite this snapshot
  // mid-test; the afterEach restore is uniform.
  const hermeticXdg = mkdtempSync(path.join(tmpdir(), 'remotepi-xdg-'));
  createdDirs.push(hermeticXdg);
  process.env['XDG_CONFIG_HOME'] = hermeticXdg;
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
  // Restore XDG_CONFIG_HOME so the test process never leaves the
  // developer's machine with the empty test tmpdir as its effective
  // XDG root. Undefined-in / undefined-out vs. defined-in / same-out
  // is handled so we don't accidentally promote `undefined` into a
  // string and confuse downstream code that does `process.env.XDG`.
  if (originalXdgConfigHome === undefined) {
    delete process.env['XDG_CONFIG_HOME'];
  } else {
    process.env['XDG_CONFIG_HOME'] = originalXdgConfigHome;
  }
});

/** Create and register a fresh directory for work_dir/state fixtures. */
function makeTmpdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'remotepi-bridge-fixture-'));
  createdDirs.push(dir);
  return dir;
}

/** Redirect `XDG_CONFIG_HOME` to a fresh empty tmpdir so that
 *  `resolveDefaultConfigPath()` deterministically resolves to a
 *  nonexistent path inside that tmpdir. Required by the argv-parsing
 *  regression tests below — they rely on `--config` falling through
 *  to the default path (when its value is a flag-shaped token or
 *  follows a `--` terminator) and the default path then failing to
 *  load. On a developer machine with a valid `~/.config/remotepi/
 *  bridge.json`, that fallback would SILENTLY succeed and the tests
 *  would flip from "expect throw" to "expect a working bridge" — the
 *  bug would only show up on CI. Forcing the default path into a
 *  sealed empty dir makes the behaviour hermetic regardless of host
 *  state. The dir is registered with `createdDirs` so afterEach
 *  cleans it up; the env var is restored separately. */
function isolateXdgConfigHome(): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'remotepi-test-'));
  createdDirs.push(dir);
  process.env['XDG_CONFIG_HOME'] = dir;
}

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
      argv: ['--systemd-foo=bar', '--whatever', '--config', configPath, '-D'],
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
    // default config path — which we force to a guaranteed-empty
    // tmpdir via `isolateXdgConfigHome()` so the load attempt
    // deterministically fails with `parse_failed`. Without the
    // isolation, a developer with a valid `~/.config/remotepi/
    // bridge.json` would see the bridge start cleanly here (it
    // would silently load their real config), turning this test
    // into a no-op assertion that pretends to validate argv parsing.
    isolateXdgConfigHome();
    const createSocket = (): WebSocketLike => new NoopSocket();
    expect(() =>
      start({
        createSocket,
        argv: ['--config', '-D'],
      }),
    ).toThrow(/bridge: parse_failed/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^bridge: parse_failed:/));
  });

  it('start() stops scanning for --config at the -- argument terminator', () => {
    // Regression guard for S1: argv of `['--', '--config', '/tmp/x']`
    // must NOT resolve `/tmp/x` as the config path — once the `--`
    // terminator is seen, everything after it is positional. The
    // bridge falls back to the default config path, which we seal
    // into an empty tmpdir via `isolateXdgConfigHome()` so the load
    // attempt deterministically surfaces a `parse_failed` error
    // (see the W3 test above for why hermetic default-path state
    // matters here too).
    isolateXdgConfigHome();
    const createSocket = (): WebSocketLike => new NoopSocket();
    expect(() =>
      start({
        createSocket,
        argv: ['--', '--config', '/tmp/somewhere.json'],
      }),
    ).toThrow(/bridge: parse_failed/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^bridge: parse_failed:/));
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
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^bridge: parse_failed:/));
  });

  it('start() throws when the config is missing worker_url', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const configPath = makeConfig({
      // worker_url omitted on purpose.
      web_base_url: 'https://x.test',
      work_dir: '/tmp',
      token: 'z'.repeat(32),
    });
    expect(() => start({ createSocket, argv: [], configPath })).toThrow(/bridge: missing_field/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^bridge: missing_field:/));
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

  it('S3 review follow-up: start() wires BridgeClient → PiProcessManager envelope routing', async () => {
    class CapturingSocket implements WebSocketLike {
      static instances: CapturingSocket[] = [];
      readyState = 0; // CONNECTING — matches the real WebSocket before open
      readonly sent: string[] = [];
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      constructor(_url: string, _protocols: string[]) {
        CapturingSocket.instances.push(this);
        // The real WebSocket fires `onopen` asynchronously after
        // construction; mirroring that with a microtask preserves
        // the production ordering (the bridge's `connect()` schedules
        // its `onopen` handler before yielding).
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.(undefined as unknown as Event);
        });
      }
      send(data: string): void {
        this.sent.push(data);
      }
      close(): void {
        this.readyState = 3;
      }
    }
    CapturingSocket.instances.length = 0;
    const createSocket = (url: string, protocols: string[]): WebSocketLike =>
      new CapturingSocket(url, protocols);

    const token = 'w'.repeat(32);
    const configPath = makeConfig({
      worker_url: 'wss://wiring.test/bridge',
      web_base_url: 'https://wiring.test',
      work_dir: '/tmp',
      token,
    });
    const result = start({
      createSocket,
      argv: [],
      configPath,
    });
    // Flush the microtask queue so the constructor's queued `onopen`
    // fires synchronously (vitest doesn't auto-flush microtasks
    // between sync test bodies, but `await Promise.resolve()` does
    // the trick).
    await Promise.resolve();
    await Promise.resolve();

    // The first socket should have received at least the handshake
    // frame.
    const sock = CapturingSocket.instances[0]!;
    expect(sock).toBeDefined();
    expect(sock.sent.length).toBeGreaterThan(0);

    // M4 task 06: drive the bridge through the session layer (the
    // same path BridgeClient uses internally). The session layer's
    // `handleEnvelope` routes to the right per-session manager; for
    // a `get_state` without a session field, the M3-compat branch
    // (map.size === 1) forwards to the single registered manager.
    // The manager answers with a `result` envelope; that envelope
    // should land on the socket via the outbound wiring.
    result.sessionLayer.handleEnvelope({
      v: 1,
      kind: 'control',
      type: 'get_state',
      id: 'wiring-gs1',
      payload: {},
    });
    // Look for the result envelope in the socket's send buffer.
    const resultFrame = sock.sent
      .map((s) => {
        try {
          return JSON.parse(s) as { type?: string; reply_to?: string };
        } catch {
          return null;
        }
      })
      .filter((p): p is { type?: string; reply_to?: string } => p !== null)
      .find((r) => r.type === 'result' && r.reply_to === 'wiring-gs1');
    expect(resultFrame).toBeDefined();
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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const reason = new Error('async boom from a stray promise');
    process.emit('unhandledRejection', reason, Promise.reject(reason));

    // The handler must have logged something containing both the tag
    // and the underlying message — the `stringContaining` form lets us
    // assert "reason made it into the line" without depending on the
    // exact stack-string format (which V8 may vary).
    const errorCalls = errorSpy.mock.calls.map((args) => args.map((a) => String(a)).join(' '));
    const matched = errorCalls.some(
      (line) =>
        line.includes('unhandledRejection') && line.includes('async boom from a stray promise'),
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

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stopSpy = vi.spyOn(result.client, 'stop');

    // Drive the handler synthetically. Real Node `uncaughtException`
    // fires from V8's exception machinery, which isn't reachable from
    // a test — `process.emit` is the standard escape hatch for
    // asserting on registered listeners.
    process.emit('uncaughtException', new Error('sync boom from a stray timer'));

    // 1. The error was logged with the stack (or at least the message,
    //    if V8's stack format varies — we accept either, but the
    //    `uncaughtException` tag MUST be present).
    const errorCalls = errorSpy.mock.calls.map((args) => args.map((a) => String(a)).join(' '));
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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    process.emit('uncaughtException', new Error('boom before start()'));

    expect(errorSpy).toHaveBeenCalledWith('bridge crashed, exiting');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});

// ----- M4 task 04: state.json wiring (PRD §2.1) ----------------------------
//
// `start()` must load (or M3-migrate) the runtime work_dirs list
// into a `WorkDirStore` and surface it on the return value, in
// addition to the existing bridge lifecycle hooks. These tests
// verify the wiring without exercising the control-layer commands
// (`work_dir_list` / `work_dir_add` / `work_dir_remove`) — those
// land in task 06 and use the same `WorkDirStore`.

describe('start (state.json wiring — M4 task 04)', () => {
  it('exposes a WorkDirStore on the return value with the loaded work_dirs', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const savedWorkDir = makeTmpdir();
    const configPath = makeConfig({
      worker_url: 'wss://state-wiring.test/bridge',
      web_base_url: 'https://state-wiring.test',
      work_dir: makeTmpdir(),
      token: 'a'.repeat(32),
    });
    const statePath = path.join(makeTmpdir(), 'isolated-state.json');
    // A pre-existing state file is the restart/fast path. Use a real
    // directory so the M3 three-piece validation is exercised.
    writeFileSync(statePath, JSON.stringify({ schema_version: 1, work_dirs: [savedWorkDir] }));
    const result = start({
      createSocket,
      argv: [],
      configPath,
      statePath,
    });
    expect(result.workDirStore.list()).toEqual([savedWorkDir]);
    expect(result.statePath).toBe(statePath);
    result.client.stop();
  });

  it('M3 migration: bridge.json has work_dir + state.json missing → state.json is written + list returns [work_dir]', () => {
    // This is the M3→M4 onboarding case: operator had a M3
    // bridge.json with work_dir but no state.json yet. The
    // first start under M4 must migrate.
    const createSocket = (): WebSocketLike => new NoopSocket();
    const workDir = mkdtempSync(path.join(tmpdir(), 'remotepi-migrate-'));
    createdDirs.push(workDir);
    const configPath = makeConfig({
      worker_url: 'wss://migrate.test/bridge',
      web_base_url: 'https://migrate.test',
      work_dir: workDir,
      token: 'm'.repeat(32),
    });
    // State path is fresh — no pre-existing file.
    const statePath = path.join(
      mkdtempSync(path.join(tmpdir(), 'remotepi-migrate-')),
      'state.json',
    );
    createdDirs.push(path.dirname(statePath));

    const result = start({
      createSocket,
      argv: [],
      configPath,
      statePath,
    });
    // state.json now exists with [work_dir] as the first entry.
    expect(existsSync(statePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as {
      schema_version: number;
      work_dirs: string[];
    };
    expect(onDisk.schema_version).toBe(1);
    expect(onDisk.work_dirs).toEqual([workDir]);
    // The store reflects the same list.
    expect(result.workDirStore.list()).toEqual([workDir]);
    // The migration log line was emitted.
    const infoCalls = infoSpy.mock.calls.map((args) => args.map((a) => String(a)).join(' '));
    expect(
      infoCalls.some(
        (line) => line.includes('migrated work_dir from bridge.json') && line.includes(workDir),
      ),
    ).toBe(true);
    // bridge.json was NOT touched (mtime + content unchanged).
    const afterConfig = readFileSync(configPath, 'utf8');
    expect(afterConfig).toContain(`"work_dir":"${workDir}"`);
    result.client.stop();
  });

  it('rejects start() when state.json is present but invalid (parse_failed / invalid_state)', () => {
    // An operator with a hand-edited state.json that's
    // missing schema_version must see a friendly stderr line
    // + thrown Error — same fail-fast contract as
    // loadBridgeConfig.
    const createSocket = (): WebSocketLike => new NoopSocket();
    const configPath = makeConfig({
      worker_url: 'wss://bad-state.test/bridge',
      web_base_url: 'https://bad-state.test',
      work_dir: '/tmp',
      token: 'b'.repeat(32),
    });
    const stateDir = mkdtempSync(path.join(tmpdir(), 'remotepi-bad-state-'));
    createdDirs.push(stateDir);
    const statePath = path.join(stateDir, 'state.json');
    // state.json is missing schema_version → StateError
    // code=invalid_state.
    writeFileSync(statePath, JSON.stringify({ work_dirs: [] }));
    expect(() =>
      start({
        createSocket,
        argv: [],
        configPath,
        statePath,
      }),
    ).toThrow(/bridge: state: invalid_state/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^bridge: state: invalid_state:/));
  });

  it('rejects start() when existing state.json contains a missing work directory', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const configPath = makeConfig({
      worker_url: 'wss://missing-state-path.test/bridge',
      web_base_url: 'https://missing-state-path.test',
      work_dir: makeTmpdir(),
      token: 'q'.repeat(32),
    });
    const stateDir = makeTmpdir();
    const statePath = path.join(stateDir, 'state.json');
    const missing = path.join(stateDir, 'gone');
    writeFileSync(statePath, JSON.stringify({ schema_version: 1, work_dirs: [missing] }));

    expect(() => start({ createSocket, argv: [], configPath, statePath })).toThrow(
      /bridge: state: invalid_state.*not accessible/,
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^bridge: state: invalid_state:/));
  });

  it('rejects start() when existing state.json contains a regular file path', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const configPath = makeConfig({
      worker_url: 'wss://file-state-path.test/bridge',
      web_base_url: 'https://file-state-path.test',
      work_dir: makeTmpdir(),
      token: 'r'.repeat(32),
    });
    const stateDir = makeTmpdir();
    const statePath = path.join(stateDir, 'state.json');
    const filePath = path.join(stateDir, 'not-a-directory');
    writeFileSync(filePath, 'not a directory');
    writeFileSync(statePath, JSON.stringify({ schema_version: 1, work_dirs: [filePath] }));

    expect(() => start({ createSocket, argv: [], configPath, statePath })).toThrow(
      /bridge: state: invalid_state.*not a directory/,
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^bridge: state: invalid_state:/));
  });

  it('restarts from state.json and does not migrate a changed bridge.json work_dir', () => {
    const createSocket = (): WebSocketLike => new NoopSocket();
    const workDirA = makeTmpdir();
    const workDirB = makeTmpdir();
    const configA = makeConfig({
      worker_url: 'wss://restart-a.test/bridge',
      web_base_url: 'https://restart-a.test',
      work_dir: workDirA,
      token: 'u'.repeat(32),
    });
    const configB = makeConfig({
      worker_url: 'wss://restart-b.test/bridge',
      web_base_url: 'https://restart-b.test',
      work_dir: workDirB,
      token: 'v'.repeat(32),
    });
    const statePath = path.join(makeTmpdir(), 'state.json');

    // First start is the M3 onboarding path: A is migrated into state.
    const first = start({ createSocket, argv: [], configPath: configA, statePath });
    expect(first.workDirStore.list()).toEqual([workDirA]);
    first.client.stop();
    const migrationCountAfterFirst = infoSpy.mock.calls.filter((args) =>
      String(args[0]).includes('migrated work_dir from bridge.json'),
    ).length;
    expect(migrationCountAfterFirst).toBe(1);

    // Second start sees an existing state file. B must not overwrite A,
    // and the lifecycle must still reach a normal started return value.
    const second = start({ createSocket, argv: [], configPath: configB, statePath });
    expect(second.workDirStore.list()).toEqual([workDirA]);
    expect(
      infoSpy.mock.calls.filter((args) =>
        String(args[0]).includes('migrated work_dir from bridge.json'),
      ).length,
    ).toBe(1);
    expect(second.client).toBeInstanceOf(BridgeClient);
    second.client.stop();
  });

  it("start() honours an explicit statePath (test seam) and never touches the developer machine's state.json", () => {
    // Hermetic test: with XDG redirected to a fresh empty
    // tmpdir AND an explicit statePath, the bridge must
    // never read or write the developer's real
    // ~/.config/remotepi/state.json. The statePath test
    // seam wins over the XDG default, so even if the
    // developer's machine has a real state.json, this
    // test exercises a sealed path.
    isolateXdgConfigHome();
    const createSocket = (): WebSocketLike => new NoopSocket();
    const configPath = makeConfig({
      worker_url: 'wss://sealed.test/bridge',
      web_base_url: 'https://sealed.test',
      work_dir: '/tmp',
      token: 's'.repeat(32),
    });
    const statePath = path.join(mkdtempSync(path.join(tmpdir(), 'remotepi-sealed-')), 'state.json');
    createdDirs.push(path.dirname(statePath));
    const result = start({
      createSocket,
      argv: [],
      configPath,
      statePath,
    });
    // The returned statePath is the one we passed, not the
    // XDG-resolved default.
    expect(result.statePath).toBe(statePath);
    // The XDG-resolved default path does NOT have a state.json
    // under it (we redirected XDG to a fresh tmpdir, and the
    // bridge wrote to the explicit statePath instead).
    const xdgDefault = path.join(process.env['XDG_CONFIG_HOME']!, 'remotepi', 'state.json');
    expect(existsSync(xdgDefault)).toBe(false);
    result.client.stop();
  });

  it('start() banner includes the resolved state path and work_dirs list', () => {
    // The banner is what an operator sees when the bridge
    // boots — it must surface the state.json path so an
    // operator grep'ing for "state:" can find it. The
    // work_dirs list must also be there so a freshly-
    // migrated bridge is obviously different from a fresh
    // install.
    const createSocket = (): WebSocketLike => new NoopSocket();
    const configPath = makeConfig({
      worker_url: 'wss://banner.test/bridge',
      web_base_url: 'https://banner.test',
      work_dir: '/tmp',
      token: 'x'.repeat(32),
    });
    const statePath = path.join(mkdtempSync(path.join(tmpdir(), 'remotepi-banner-')), 'state.json');
    createdDirs.push(path.dirname(statePath));
    const result = start({
      createSocket,
      argv: [],
      configPath,
      statePath,
    });
    expect(infoSpy).toHaveBeenCalledWith(`state: ${statePath}`);
    expect(infoSpy).toHaveBeenCalledWith(
      `work_dirs: ${JSON.stringify(result.workDirStore.list())}`,
    );
    result.client.stop();
  });
});
