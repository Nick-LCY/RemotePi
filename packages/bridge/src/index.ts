// Bridge daemon entry point — generates a token, prints the share URL,
// then opens the long-lived WSS loop. The token lives for the lifetime
// of the process: we never rotate it, so users keep the same URL even
// across transient network blips (the reconnect logic in `client.ts`
// keeps the existing `BridgeClient` instance alive).
//
// CLI:
//   bridge [--worker-url <wss-url>]
//
// `--worker-url` overrides the default `wss://remote-pi.sankabox.com/bridge`.
// Useful for `wrangler dev` (`ws://localhost:8787/bridge`) and for
// staging environments.
import { fileURLToPath } from 'node:url';
import { generateToken, shareUrl } from './token.js';
import { BridgeClient, type WebSocketLike } from './client.js';
import { logger } from './logger.js';

/** Default WSS endpoint — production worker domain. Matches the route
 *  the Terraform config creates in [[prds/m2-tunnel.md#§5-infra]]. */
export const DEFAULT_WORKER_URL = 'wss://remote-pi.sankabox.com/bridge';

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
    DEFAULT_WORKER_URL;

  // Two-line banner so it's trivially `grep`-able / paste-able for users
  // running the bridge in a terminal or under a wrapper script.
  log.info(`token: ${token}`);
  log.info(`share URL: ${shareLink}`);

  const client = new BridgeClient(workerUrl, token, {
    createSocket: options.createSocket,
  });
  client.start();

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
    start();
  }
}
