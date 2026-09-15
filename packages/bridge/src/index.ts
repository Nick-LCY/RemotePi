// Bridge daemon entry point — loads the JSON config, prints the token
// and the share URL, then opens the long-lived WSS loop. The token
// lives for the lifetime of the process: we never rotate it, so users
// keep the same URL even across transient network blips (the reconnect
// logic in `client.ts` keeps the existing `BridgeClient` instance alive).
//
// CLI:
//   bridge [--config <path>]
//
// All four connection-related inputs (worker URL, web base URL, work
// directory, optional persistent token) come from a single JSON file.
// The only remaining CLI flag is `--config <path>` (with
// `--config=<path>` accepted as an equivalent form for wrappers).
// Unknown flags are silently ignored — systemd-style supervisors may
// pass arbitrary extra flags and the bridge must not refuse to start
// because of them (PRD §2.2: "未知 flag 静默忽略").
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
 *  aren't treated as the flag's value. Everything else is silently
 *  ignored (PRD §2.2 "未知 CLI flag 静默忽略"). The next-token check
 *  uses `startsWith('-')` (not `startsWith('--')`) so systemd-style
 *  single-dash flags like `-D` are not swallowed as the `--config`
 *  value. */
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
    // Swallow the stack — the message we print names the failing
    // field / file, and the auto-run entry guard below also catches
    // + prints + sets exitCode 1. This branch fires when tests drive
    // `start()` directly: they want a clean throw-without-stack for
    // assertion convenience.
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
        // the wrapper Error keeps the auto-run message clean.
        new Error(describeConfigError(err), { cause: err })
      : err;
  }

  // Path resolution: explicit `statePath` option (test seam) →
  // XDG_CONFIG_HOME env / `~/.config/remotepi/state.json` default.
  // The same XDG env var governs both files (bridge.json + state.json)
  // — operators who set XDG_CONFIG_HOME expect both to land under
  // that root, not just one. We deliberately do NOT expose
  // `statePath` as a CLI flag (PRD §2.2 — "不新增 CLI 参数"):
  // hand-editing a state file is not a supported workflow, and a
  // second config file with its own flag would be operator-confusing.
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
  // lifetime of the bridge process.
  const workDirStore = new WorkDirStore(initialWorkDirs, statePath);

  // Resolve token: explicit `token` option (test seam) wins over
  // config file's `token`; otherwise delegate to `readTokenOrGenerate`.
  // Per PRD §2.1, a generated token is NOT persisted to the
  // config file. The share URL is always rebuilt from the resolved
  // token + `config.web_base_url` so the banner can never print a
  // blank line even when the test seam supplies a token directly.
  const token = options.token ?? readTokenOrGenerate(config).token;
  const shareLink = shareUrl(token, config.web_base_url);

  const workerUrl = config.worker_url;

  // Multi-line banner so it's trivially `grep`-able / paste-able for
  // users running the bridge in a terminal or under a wrapper
  // script.
  log.info(`config: ${configPath}`);
  log.info(`state: ${statePath}`);
  log.info(`token: ${token}`);
  log.info(`share URL: ${shareLink}`);
  log.info(`worker URL: ${workerUrl}`);
  // `work_dir` is optional (M4). When absent, the banner prints
  // "<none>" so the operator doesn't see `work_dir: undefined`.
  // The `work_dirs: [...]` line right below it is always present
  // and is the real source of truth for M4 multi-session.
  log.info(`work_dir: ${config.work_dir ?? '<none>'}`);
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

  // Bring up the pi subprocess manager after the WSS client is up
  // so any session_state broadcast emitted during the handshake
  // reaches the cloud (the client.sendEnvelope path may silently
  // drop frames if the socket isn't open yet, but the bridge is
  // single-tenant and the worker buffer absorbs any blip).
  //
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
    sessionLayer = new BridgeSessionLayer({
      agentDir,
      workDirStore,
      onOutbound: (env) => client.sendEnvelope(env),
      defaultWorkDir: config.work_dir,
      makeManager: () => options.piProcessManager!,
      ...(options.sessionLayerOptions ?? {}),
    });
    sessionLayer.start();
    type LayerInternals = {
      spawnManager: (opts: {
        mapKey: string;
        workDir: string;
        sessionJsonlPath: string | null | undefined;
      }) => unknown;
    };
    const internals = sessionLayer as unknown as LayerInternals;
    // `config.work_dir` is optional. The back-compat single-manager
    // seam (`options.piProcessManager` injection) is a test-only
    // pathway — production callers never set it. If a caller
    // pairs the injection with an absent `work_dir`, fall back to
    // a sentinel `'<unset>'` so the synthetic M3-legacy manager is
    // still registered (we just need a stable string for the test
    // seam to keep working).
    //
    // sessionJsonlPath is `undefined` (NOT `null`) so the M3-compat
    // auto-spawn path keeps using the ADR-0007 "取最新" semantics
    // (spawnNow → sessionArgv(subdir)); `null` is reserved for the
    // pending-key explicit-fresh path. See `spawnManager` JSDoc.
    internals.spawnManager({
      mapKey: 'm3-legacy',
      workDir: config.work_dir ?? '<unset>',
      sessionJsonlPath: undefined,
    });
  } else {
    // Default path: construct a fresh session layer. The
    // `defaultWorkDir` (from `config.work_dir`) preserves M3's
    // token-only URL hash behaviour — when a session-less command
    // arrives and no manager exists yet, the layer auto-spawns
    // an implicit manager under this workDir (M3-compat path).
    sessionLayer = new BridgeSessionLayer({
      agentDir,
      workDirStore,
      onOutbound: (env) => client.sendEnvelope(env),
      defaultWorkDir: config.work_dir,
      ...(options.sessionLayerOptions ?? {}),
    });
    sessionLayer.start();
  }

  // WSS → session layer: every envelope the client doesn't handle
  // internally (everything except ping/pong/bridge_status/error/
  // handshake) lands here. The layer routes by `kind` + `type` and
  // hands the rest to the right per-session manager.
  client.setEnvelopeSink((env) => sessionLayer.handleEnvelope(env));
  // Note: per-session managers only spawn pi on the first §2.7
  // spawn trigger (PRD §2.3 — "延迟到首任务触发, 不预热"). The bridge
  // sitting with an empty map is the intended steady state.

  // `manager` is the legacy single-manager field. In M4 the layer
  // owns the per-session managers; `manager` is null by default and
  // only set when the caller injected a back-compat `piProcessManager`.
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
    try {
      start();
    } catch (err) {
      const e = toError(err);
      logger.error(`bridge start failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
