// Bridge daemon entry point — loads the JSON config, prints the token
// and the share URL, then opens the long-lived WSS loop. The token
// lives for the lifetime of the process: we never rotate it, so users
// keep the same URL even across transient network blips (the reconnect
// logic in `client.ts` keeps the existing `BridgeClient` instance alive).
//
// CLI:
//   bridge [--config <path>]
//
// M3 task 03 ([prds/m3-single-session.md#§2-1]): the bridge no longer
// accepts `--worker-url` or `REMOTEPI_WORKER_URL`. All four
// connection-related inputs (worker URL, web base URL, work directory,
// optional persistent token) come from a single JSON file. The only
// remaining CLI flag is `--config <path>` (with `--config=<path>`
// accepted as an equivalent form for wrappers). Unknown flags are
// silently ignored — systemd-style supervisors may pass arbitrary
// extra flags and the bridge must not refuse to start because of them
// (PRD §2.2: "未知 flag 静默忽略").
//
// Config path resolution: `--config` flag → `XDG_CONFIG_HOME` env var
// → `~/.config/remotepi/bridge.json`. Loaded and validated by
// `loadBridgeConfig`; failures surface as a single friendly stderr line
// + `process.exitCode = 1`, never a stack trace.
import { fileURLToPath } from 'node:url';
import { BridgeClient, type WebSocketLike } from './client.js';
import {
  loadBridgeConfig,
  readTokenOrGenerate,
  resolveDefaultConfigPath,
  ConfigError,
  type BridgeConfig,
} from './config.js';
import { logger } from './logger.js';
import { resolvePiAgentDir } from './pi-cwd-encoder.js';
import { PiProcessManager } from './pi-process.js';
import { BridgeSessionLayer, type BridgeSessionLayerOptions } from './session-layer.js';
import {
  resolveDefaultStatePath,
  StateError,
  WorkDirStore,
  migrateFromBridgeConfig,
} from './state.js';
import { shareUrl } from './token.js';

/** Tracks the auto-run client's lifecycle so `uncaughtException` can close
 *  its socket before we exit. Tests hold their own reference via the
 *  return value of `start()` and don't rely on this — it only affects the
 *  "this file is the main entry" code path. */
let activeClient: BridgeClient | null = null;

/** Coerce a thrown value into an `Error`. Some async paths surface
 *  non-Error rejections (raw strings, plain objects); we want a stack
 *  trace in the log regardless. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Parse `--config <value>` out of an argv slice. Returns undefined
 *  when the flag is absent. Stops scanning at `--` so unknown flags
 *  aren't treated as the flag's value. Only recognised CLI flag as of
 *  M3 task 03 — everything else is silently ignored (PRD §2.2
 *  "未知 CLI flag 静默忽略"). The next-token check uses `startsWith('-')`
 *  (not `startsWith('--')`) so systemd-style single-dash flags like
 *  `-D` are not swallowed as the `--config` value. */
function parseConfigPathFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    // Argument-list terminator: anything after `--` is positional, not
    // a flag. Stop scanning immediately so `--config -- /tmp/foo`
    // doesn't pick up `/tmp/foo` as the path.
    if (arg === '--') return undefined;
    if (arg === '--config') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        return next;
      }
      return undefined;
    }
    // Allow `--config=value` form for convenience.
    if (arg.startsWith('--config=')) {
      return arg.slice('--config='.length);
    }
  }
  return undefined;
}

/** Install the bridge's crash handlers exactly once at module load.
 *
 *  Without these, two failure modes are silently fatal:
 *   - top-level `start()` throws synchronously (e.g. a future seam
 *     surfaces a bug). Node prints + exits, but our logger format
 *     never fires — operators see a raw stack instead of the
 *     `[bridge] error` line every other lifecycle event uses.
 *   - an async rejection / sync exception during the connect loop
 *     throws out of a timer callback. The reconnect timer chain
 *     dies and the bridge sits idle with no log evidence of why.
 *
 *  Behaviour:
 *   - `unhandledRejection`: log + keep running. Reconnects stay alive.
 *   - `uncaughtException`: log + close the active socket + exit(1).
 *     The socket close is best-effort — we're already crashing, we
 *     just want a clean TCP FIN before we go.
 *
 *  Wrapped in a function so future re-loads (tsx watch re-imports) don't
 *  pile up duplicate listeners on `process`. */
function installProcessHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    const err = toError(reason);
    // `err.stack` is set for Error instances; for coerced non-Error values
    // we only have the message. Print both when present so a stack is
    // never silently dropped.
    logger.error(`unhandledRejection: ${err.stack ?? err.message}`);
  });
  process.on('uncaughtException', (err) => {
    const e = toError(err);
    logger.error(`uncaughtException: ${e.stack ?? e.message}`);
    if (activeClient !== null) {
      try {
        activeClient.stop();
      } catch {
        // Best-effort cleanup — we're already in a crash path and the
        // stop() call itself could throw if the socket is in a weird
        // state. Don't let cleanup failure mask the original error.
      }
      activeClient = null;
    }
    // Explicit log line so operators can grep for the exact moment we
    // gave up — distinct from the uncaughtException stack above.
    logger.error('bridge crashed, exiting');
    process.exit(1);
  });
}
installProcessHandlers();

export interface StartOptions {
  /** Override the config file path (CLI flag / test seam / programmatic
   *  caller). When omitted, `resolveDefaultConfigPath()` is consulted. */
  configPath?: string;
  /** Override the state.json path (test seam). When omitted,
   *  `resolveDefaultStatePath()` is consulted. NOT exposed as a CLI
   *  flag (PRD §2.2: "state.json 路径不暴露 CLI / env 参数") — only
   *  programmatic callers and tests use this seam. */
  statePath?: string;
  /** Override the logger (test seam). */
  logger?: typeof logger;
  /** Override the WebSocket factory (test seam). */
  createSocket?: (url: string, protocols: string[]) => WebSocketLike;
  /** Override the argv slice used for `--config` parsing (test seam).
   *  When omitted, `process.argv.slice(2)` is used (the production CLI
   *  entry). Unknown flags in this slice are silently ignored — see
   *  PRD §2.2. */
  argv?: string[];
  /** Override the token (test seam — production code generates one
   *  via `readTokenOrGenerate`). When omitted AND the config has a
   *  non-empty `token`, that token is used; otherwise a fresh token is
   *  generated and NOT persisted to the config file (PRD §2.1). */
  token?: string;
  /** Optional override for the pi subprocess manager (test seam).
   *  When omitted, start() constructs a real `PiProcessManager`
   *  bound to the resolved config + isolation dir. */
  piProcessManager?: PiProcessManager;
  sessionLayer?: BridgeSessionLayer;
  sessionLayerOptions?: Partial<BridgeSessionLayerOptions>;
}

/** Friendly single-line stderr message for a `ConfigError`. We do NOT
 *  print the stack — operators don't need to chase a stack for "your
 *  config is broken" errors, and a long Zod issue dump makes the
 *  auto-run entry point feel like a crash. The `code` is included so
 *  scripted wrappers / log-aggregators can grep for it. */
function describeConfigError(err: ConfigError): string {
  return `bridge: ${err.code}: ${err.message}`;
}

/** Friendly single-line stderr message for a `StateError`. Same shape
 *  as `describeConfigError` — surfaced to operators as a one-liner
 *  without the underlying Zod / fs stack. The `code` is the same
 *  `parse_failed` / `invalid_state` discriminator the loader emits,
 *  so log aggregators can switch on it the same way they switch on
 *  the ConfigError codes. */
function describeStateError(err: StateError): string {
  return `bridge: state: ${err.code}: ${err.message}`;
}

/** Generate a token, print it + the share URL, and start the client.
 *  Exposed so tests can drive the lifecycle without spawning a child. */
export function start(options: StartOptions = {}): {
  token: string;
  shareUrl: string;
  client: BridgeClient;
  workerUrl: string;
  manager: PiProcessManager | null;
  sessionLayer: BridgeSessionLayer;
  workDirStore: WorkDirStore;
  statePath: string;
} {
  const log = options.logger ?? logger;
  // Path resolution order: explicit `configPath` option → `--config`
  // flag in argv → `XDG_CONFIG_HOME` env / `~/.config/remotepi/bridge.json`
  // default. The CLI flag is parsed before resolving so a `--config`
  // supplied by the user always wins, regardless of env var state.
  const configPath =
    options.configPath ??
    parseConfigPathFlag(options.argv ?? process.argv.slice(2)) ??
    resolveDefaultConfigPath();

  let config: BridgeConfig;
  try {
    config = loadBridgeConfig(configPath);
  } catch (err) {
    // We swallow the stack because (a) the message we already print
    // names the failing field / file, and (b) the auto-run entry
    // guard below also catches + prints + sets exitCode 1. This
    // branch fires when tests drive `start()` directly: they want
    // a clean throw-without-stack for assertion convenience.
    if (err instanceof ConfigError) {
      log.error(describeConfigError(err));
    } else {
      const e = toError(err);
      log.error(`bridge: unexpected config error: ${e.stack ?? e.message}`);
    }
    throw err instanceof ConfigError
      ? // Re-throw a plain Error carrying the same message so callers
        // (tests + the CLI entry guard) don't need to import
        // `ConfigError` to switch on the failure mode. The `cause`
        // preserves the original `ConfigError` (with its `code` +
        // underlying Zod/SyntaxError cause) for diagnostics, while
        // the wrapper Error keeps the auto-run message clean. The
        // `process.exitCode = 1` path in the CLI guard catches the
        // same situation for the auto-run entry.
        new Error(describeConfigError(err), { cause: err })
      : err;
  }

  // M4 task 04: load + M3-migrate the runtime work_dirs state.
  //
  // Path resolution: explicit `statePath` option (test seam) →
  // XDG_CONFIG_HOME env / `~/.config/remotepi/state.json` default.
  // The same XDG env var governs both files (bridge.json + state.json)
  // — operators who set XDG_CONFIG_HOME expect both to land under
  // that root, not just one. We deliberately do NOT expose
  // `statePath` as a CLI flag (PRD §2.2 — "不新增 CLI 参数"):
  // hand-editing a state file is not a supported workflow, and a
  // second config file with its own flag would be operator-confusing.
  //
  // `migrateFromBridgeConfig` does:
  //   - state.json exists → return its work_dirs (no migration).
  //   - state.json missing + bridge.json has work_dir → write
  //     `[work_dir]` to state.json + log the migration line +
  //     return `[work_dir]`.
  //   - state.json missing + bridge.json has empty work_dir →
  //     write `[]` to state.json (so the file exists for future
  //     restarts) and return `[]`. No migration log line because
  //     there was nothing to migrate.
  const statePath = options.statePath ?? resolveDefaultStatePath();
  let initialWorkDirs: string[];
  try {
    initialWorkDirs = migrateFromBridgeConfig(config, statePath, log);
  } catch (err) {
    if (err instanceof StateError) {
      log.error(describeStateError(err));
    } else {
      const e = toError(err);
      log.error(`bridge: unexpected state error: ${e.stack ?? e.message}`);
    }
    throw err instanceof StateError
      ? new Error(describeStateError(err), { cause: err })
      : err;
  }
  // The in-memory WorkDirStore owns the work_dirs list for the
  // lifetime of the bridge process. `add` / `remove` (tasks 05/06
  // wiring) go through it; the on-disk file is the atomic write
  // + rollback seam that keeps the in-memory and on-disk states
  // consistent across crash + restart.
  const workDirStore = new WorkDirStore(initialWorkDirs, statePath);

  // Resolve token: explicit `token` option (test seam) wins over
  // config file's `token`; otherwise delegate to `readTokenOrGenerate`
  // (which honours a non-empty config token or generates a fresh
  // one). Per PRD §2.1, a generated token is NOT persisted to the
  // config file — callers wanting persistence must edit the JSON
  // themselves. The share URL is always rebuilt from the resolved
  // token + `config.web_base_url` so the banner can never print a
  // blank line even when the test seam supplies a token directly.
  const token = options.token ?? readTokenOrGenerate(config).token;
  const shareLink = shareUrl(token, config.web_base_url);

  const workerUrl = config.worker_url;

  // Multi-line banner so it's trivially `grep`-able / paste-able for
  // users running the bridge in a terminal or under a wrapper
  // script. The `worker URL:` line makes the actually-resolved
  // endpoint visible — without it, an operator staring at the
  // banner would have to inspect the config file to know which
  // environment they're connected to. The `state:` line (M4 task
  // 04) makes the resolved state.json path visible so the
  // operator can grep for atomic-write failures / migration lines
  // against the same path the runtime actually wrote to.
  log.info(`config: ${configPath}`);
  log.info(`state: ${statePath}`);
  log.info(`token: ${token}`);
  log.info(`share URL: ${shareLink}`);
  log.info(`worker URL: ${workerUrl}`);
  log.info(`work_dir: ${config.work_dir}`);
  log.info(`work_dirs: ${JSON.stringify(workDirStore.list())}`);

  const client = new BridgeClient(workerUrl, token, {
    createSocket: options.createSocket,
  });
  client.start();
  // Track the auto-run instance so uncaughtException can close it on
  // crash. Tests that call start() directly hold their own reference
  // via the return value and never read this — assignment is harmless
  // for them (it just leaves a stale pointer that .stop() doesn't
  // touch, since tests call stop() on their local handle, not on
  // activeClient).
  activeClient = client;

  // M3 task 04: bring up the pi subprocess manager after the WSS
  // client is up so any session_state broadcast emitted during the
  // handshake reaches the cloud (the client.sendEnvelope path may
  // silently drop frames if the socket isn't open yet, but the
  // bridge is single-tenant and the worker buffer absorbs any blip).
  //
  // Agent dir: bridge uses the operator's own pi profile (no
  // isolated copy next to the config file — that approach was
  // retired on 2026-09-05). `resolvePiAgentDir` honours
  // `PI_CODING_AGENT_DIR` if set, otherwise falls back to
  // `~/.pi/agent` — the same path the host's `pi` TUI writes
  // sessions + auth.json to. Result: web sessions and the
  // operator's terminal sessions land in the same directory, so
  // web can pick up whichever was most recent on restart.
  // M4 task 06: bridge routes inbound + outbound envelopes through
  // a `BridgeSessionLayer` that owns a `Map<sessionKey, manager>`
  // plus the control commands (work_dir_*, list_directories,
  // session_list, get_state). The legacy single-manager path is
  // preserved as a back-compat seam: when `options.piProcessManager`
  // is provided, we wrap it in a synthetic layer that hands every
  // envelope to that manager.
  const agentDir = resolvePiAgentDir();

  let sessionLayer: BridgeSessionLayer;
  if (options.sessionLayer !== undefined) {
    sessionLayer = options.sessionLayer;
  } else if (options.piProcessManager !== undefined) {
    // Back-compat: a single injected manager means the layer has
    // exactly one slot. We hand-wire it under a synthetic M3
    // sentinel key (`m3-legacy`) so the layer's M3-compat branch
    // (map.size === 1) forwards envelopes to the injected manager.
    // Existing M3 tests that drove `result.manager.handleEnvelope(...)`
    // keep working without rewriting.
    sessionLayer = new BridgeSessionLayer({
      agentDir,
      workDirStore,
      onOutbound: (env) => client.sendEnvelope(env),
      makeManager: () => options.piProcessManager!,
      ...(options.sessionLayerOptions ?? {}),
    });
    sessionLayer.start();
    type LayerInternals = {
      spawnManager: (opts: { mapKey: string; workDir: string; sessionJsonlPath: string | null }) => unknown;
    };
    const internals = sessionLayer as unknown as LayerInternals;
    internals.spawnManager({
      mapKey: 'm3-legacy',
      workDir: config.work_dir,
      sessionJsonlPath: null,
    });
  } else {
    sessionLayer = new BridgeSessionLayer({
      agentDir,
      workDirStore,
      onOutbound: (env) => client.sendEnvelope(env),
      ...(options.sessionLayerOptions ?? {}),
    });
    sessionLayer.start();
  }

  // WSS → session layer: every envelope the client doesn't handle
  // internally (everything except ping/pong/bridge_status/error/
  // handshake) lands here. The layer routes by `kind` + `type` and
  // hands the rest to the right per-session manager. → session layer: every envelope the client doesn't handle
  // internally (everything except ping/pong/bridge_status/error/
  // handshake) lands here. The layer routes by  +  and
  // hands the rest to the right per-session manager.
  client.setEnvelopeSink((env) => sessionLayer.handleEnvelope(env));
  // Note: per-session managers only spawn pi on the first §2.7
  // spawn trigger (PRD §2.3 — "延迟到首任务触发, 不预热"). The bridge
  // sitting with an empty map is the intended steady state.

  // `manager` is the legacy single-manager field. In M4 the layer
  // owns the per-session managers; `manager` is null by default and
  // only set when the caller injected a back-compat `piProcessManager`.
  // Existing M3 tests that use `result.manager.handleEnvelope(...)`
  // continue to work via the legacy layer wiring above.
  const legacyManager = options.piProcessManager ?? null;

  return {
    token,
    shareUrl: shareLink,
    client,
    workerUrl,
    manager: legacyManager,
    sessionLayer,
    workDirStore,
    statePath,
  };
}

// ----- CLI entry guard -----
//
// Only auto-run when this file is the program's main entry. We compare
// `process.argv[1]` (the path Node executed) against our own module URL,
// resolved to an absolute filesystem path, so symlinks and the various
// `.ts` / `.js` / `/dist/` forms all match consistently.
const argv1 = process.argv[1];
if (argv1 !== undefined) {
  let resolvedArgv1: string;
  try {
    resolvedArgv1 = fileURLToPath(import.meta.url);
  } catch {
    resolvedArgv1 = '';
  }
  // Compare with the suffix-free form too — `tsx` and `node --import tsx`
  // both set argv[1] to the `.ts` path.
  const argvBase = argv1.endsWith('.ts') ? argv1.replace(/\.ts$/, '.js') : argv1;
  if (argvBase === resolvedArgv1 || argv1 === resolvedArgv1) {
    // Top-level safety net: if anything in `start()` throws
    // synchronously (a bad factory call, a config validation
    // error, etc.), Node would print + exit with the raw stack. The
    // `tsx watch` parent would see non-zero exit and restart, but the
    // operator wouldn't see it through our `[bridge] error` log format
    // — they'd see a stack trace. Catch + log + set exitCode so the
    // process exits with code 1 (for tsx watch to detect) AND the log
    // line matches the format the rest of the daemon uses.
    try {
      start();
    } catch (err) {
      // start() already logged a friendly line for ConfigError. For
      // any other error (impossible in current code but defensive),
      // emit a fallback so the auto-run entry still gives the
      // operator a useful message.
      const e = toError(err);
      logger.error(`bridge start failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
