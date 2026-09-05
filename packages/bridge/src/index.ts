// Bridge daemon entry point — generates a token, prints the share URL,
// then opens the long-lived WSS loop. The token lives for the lifetime
// of the process: we never rotate it, so users keep the same URL even
// across transient network blips (the reconnect logic in `client.ts`
// keeps the existing `BridgeClient` instance alive).
//
// CLI:
//   bridge [--worker-url <wss-url>]
//
// Resolution chain (highest priority first):
//   1. `--worker-url <wss-url>` CLI flag
//   2. `REMOTEPI_WORKER_URL` environment variable
//   3. default production URL `wss://remote-pi.sankabox.com/bridge`
//
// `--worker-url` / `REMOTEPI_WORKER_URL` are both useful for `wrangler
// dev` (`ws://localhost:8787/bridge`) and for staging environments.
// The env var is the friendlier form for wrappers (systemd, nohup, CI)
// that don't want to thread flags through a process tree.
import { fileURLToPath } from 'node:url';
import { generateToken, shareUrl } from './token.js';
import { BridgeClient, type WebSocketLike } from './client.js';
import { logger } from './logger.js';

/** Default WSS endpoint — production worker domain. Matches the route
 *  the Terraform config creates in [[prds/m2-tunnel.md#§5-infra]]. */
export const DEFAULT_WORKER_URL = 'wss://remote-pi.sankabox.com/bridge';

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
  /** Override the worker URL (env-var, CLI flag, test seam). */
  workerUrl?: string;
  /** Override the logger (test seam). */
  logger?: typeof logger;
  /** Override the WebSocket factory (test seam). */
  createSocket?: (url: string, protocols: string[]) => WebSocketLike;
  /** Override the argv slice used for `--worker-url` parsing (test seam). */
  argv?: string[];
  /** Override the token (test seam — production code generates one). */
  token?: string;
}

/** Parse `--worker-url <value>` out of an argv slice. Returns undefined
 *  when the flag is absent. Stops scanning at `--` so unknown flags
 *  aren't treated as the flag's value. */
function parseWorkerUrlFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--worker-url') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        return next;
      }
      return undefined;
    }
    // Allow `--worker-url=value` form for convenience.
    if (arg.startsWith('--worker-url=')) {
      return arg.slice('--worker-url='.length);
    }
  }
  return undefined;
}

/** Read the worker URL from the `REMOTEPI_WORKER_URL` env var. Returns
 *  undefined when unset OR set to an empty string — the latter so an
 *  accidentally-exported `REMOTEPI_WORKER_URL=` doesn't silently break
 *  the bridge by handing an empty URL to the WebSocket constructor. */
function readEnvWorkerUrl(): string | undefined {
  const v = process.env['REMOTEPI_WORKER_URL'];
  return v !== undefined && v !== '' ? v : undefined;
}

/** Generate a token, print it + the share URL, and start the client.
 *  Exposed so tests can drive the lifecycle without spawning a child. */
export function start(options: StartOptions = {}): {
  token: string;
  shareUrl: string;
  client: BridgeClient;
  workerUrl: string;
} {
  const log = options.logger ?? logger;
  const token = options.token ?? generateToken();
  const shareLink = shareUrl(token);
  const workerUrl =
    options.workerUrl ??
    parseWorkerUrlFlag(options.argv ?? process.argv.slice(2)) ??
    readEnvWorkerUrl() ??
    DEFAULT_WORKER_URL;

  // Multi-line banner so it's trivially `grep`-able / paste-able for users
  // running the bridge in a terminal or under a wrapper script. The
  // `worker URL:` line makes the actually-resolved endpoint visible —
  // without it, an empty arg list silently connects to production
  // (the #1 footgun users hit during local dev).
  log.info(`token: ${token}`);
  log.info(`share URL: ${shareLink}`);
  log.info(`worker URL: ${workerUrl}`);
  if (workerUrl === DEFAULT_WORKER_URL) {
    log.info(
      'hint: this is the production default — for local dev pass -- --worker-url ws://localhost:8787/bridge',
    );
  }

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

  return { token, shareUrl: shareLink, client, workerUrl };
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
    // synchronously (a bad factory call, a future config-validation
    // error, etc.), Node would print + exit with the raw stack. The
    // `tsx watch` parent would see non-zero exit and restart, but the
    // operator wouldn't see it through our `[bridge] error` log format
    // — they'd see a stack trace. Catch + log + set exitCode so the
    // process exits with code 1 (for tsx watch to detect) AND the log
    // line matches the format the rest of the daemon uses.
    try {
      start();
    } catch (err) {
      const e = toError(err);
      logger.error(`bridge start failed: ${e.stack ?? e.message}`);
      process.exitCode = 1;
    }
  }
}
