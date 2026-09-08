// Helper: spawn a real bridge subprocess and watch its stdout for the
// "connected to" line that signals a successful WSS handshake with
// the worker DO.
//
// The bridge is started with `node packages/bridge/dist/index.js
// --config <tmp.json>` — NEVER via `tsx watch` (the watch mode is
// known to leave zombie children on the operator's machine; see
// current-state TODO 2026-09-07). The config file is written by
// `global-setup.ts` from the run-tag + fake-llm-base-url + worker
// port discovered at setup time.
//
// `await waitForReady()` resolves the moment the bridge logs its
// first "connected to <url>" line (or rejects with a timeout error
// if the bridge never connects within `timeoutMs`). The
// `connected to` substring is stable across bridge versions because
// it's the literal the `BridgeClient.handleOpen()` logger emits —
// any future log-format change would break this harness AND the
// operator's diagnosis flow, which is the right fail-fast signal.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

export interface BridgeProcessOptions {
  /** Absolute path to the pre-built `packages/bridge/dist/index.js`. */
  bridgeEntry: string;
  /** Absolute path to the JSON config file (written by global-setup). */
  configPath: string;
  /** Working directory the bridge child should inherit (we point it
   *  at the repo root so the node_modules workspace resolves
   *  `@remotepi/shared` natively — the bridge's `dist/index.js`
   *  doesn't bundle node_modules; resolution walks up from the
   *  bridge dir to the workspace). */
  cwd: string;
  /** Env to inject for the bridge child. The bridge itself does
   *  NOT consume provider keys; the env here exists so the bridge
   *  can spawn pi with `PI_CODING_AGENT_DIR` + `PI_OFFLINE` via the
   *  inherited env (per `buildHermeticEnv`). */
  env: NodeJS.ProcessEnv;
  /** Max ms to wait for "connected to" in stdout before rejecting. */
  readyTimeoutMs?: number;
  /** Log prefix tag for stdout/stderr pipes (helps with trace). */
  tag?: string;
}

export interface BridgeProcess {
  /** Underlying Node child. Exposed for diagnostics only — callers
   *  should prefer `stop()` for teardown. */
  child: ChildProcessByStdio<null, Readable, Readable>;
  /** Resolve when the bridge stdout reports the first
   *  "connected to" line. The promise rejects with `Error` if the
   *  child exits before connecting, or if `readyTimeoutMs` elapses. */
  waitForReady: () => Promise<void>;
  /** Best-effort kill of the bridge + its entire process group
   *  (the bridge spawns pi; SIGKILL on the group guarantees pi dies
   *  even if the bridge's own stop() is mid-handshake). Idempotent. */
  stop: () => Promise<void>;
}

export function startBridgeProcess(opts: BridgeProcessOptions): Promise<BridgeProcess> {
  // Make sure the parent directory for the config file exists
  // (global-setup may have written the file via the same mkdir path,
  // but a fresh run with a stale tmp could have lost the dir).
  return mkdir(path.dirname(opts.configPath), { recursive: true }).then(() =>
    spawnBridge(opts),
  );
}

function spawnBridge(opts: BridgeProcessOptions): BridgeProcess {
  // tag is reserved for future trace decoration (logs that surface
  // in the Playwright HTML report); currently swallowed so ESLint's
  // no-unused-vars rule doesn't fire.
  void opts.tag;

  // The bridge source is TypeScript and its `@remotepi/shared`
  // dependency resolves through node_modules to a symlink pointing
  // at `src/index.ts` (no dist artefact — see
  // `packages/shared/package.json` `main: "./src/index.ts"`). Pure
  // node can't load `.ts` so we run the bridge via `tsx` (NOT
  // `tsx watch` — see current-state TODO 2026-09-07 "bridge 僵尸"
  // for why watch mode is banned in tests). tsx without --watch is
  // a one-shot TS evaluator with no leftover daemon.
  const child = spawn('npx', ['tsx', opts.bridgeEntry, '--config', opts.configPath], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Detached lets us kill the process group later (so the bridge's
    // pi child dies with it). The bridge itself exits when its
    // parent does, but we want SIGKILL semantics to bypass the
    // bridge's own SIGTERM→SIGKILL grace (which is fine in
    // production but slows teardown in tests).
    detached: true,
  });

  let connected = false;
  // Mutated by the promise's resolve/reject closures below; we read
  // it lazily inside waitForReady so the surface area is minimal.
  let resolveReadyFn: (() => void) | null = null;
  let rejectReadyFn: ((err: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReadyFn = resolve;
    rejectReadyFn = reject;
  });
  let readyTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastError: Error | null = null;

  // Bridge uses the [bridge] info format ("ISO [bridge] info …") for
  // every log line; we grep for the substring "connected to " which
  // `BridgeClient.handleOpen()` emits on a successful WSS handshake.
  // The substring is stable across the codebase (verified 2026-09-08
  // — packages/bridge/src/client.ts `logger.info(\`connected to
  // ${this.url}\`)`).
  const readyMatcher = /connected to /;

  let stdoutTail = '';
  let stderrTail = '';
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (stdoutStream === null || stderrStream === null) {
    throw new Error('bridge process: stdout/stderr not available (stdio config wrong?)');
  }
  stdoutStream.setEncoding('utf8');
  stderrStream.setEncoding('utf8');
  stdoutStream.on('data', (chunk: string) => {
    stdoutTail += chunk;
    if (stdoutTail.length > 4096) {
      stdoutTail = stdoutTail.slice(-4096);
    }
    if (!connected && readyMatcher.test(stdoutTail)) {
      connected = true;
      if (readyTimeout !== null) {
        clearTimeout(readyTimeout);
        readyTimeout = null;
      }
      resolveReadyFn?.();
    }
  });
  stderrStream.on('data', (chunk: string) => {
    stderrTail += chunk;
    if (stderrTail.length > 4096) {
      stderrTail = stderrTail.slice(-4096);
    }
  });
  child.on('exit', (code, signal) => {
    if (!connected) {
      const err = new Error(
        `bridge exited before connecting (code=${code}, signal=${signal}); ` +
          `stderr tail: ${stderrTail.trim().slice(-500)}`,
      );
      lastError = err;
      rejectReadyFn?.(err);
    }
  });

  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  readyTimeout = setTimeout(() => {
    if (connected) return;
    readyTimeout = null;
    const err = new Error(
      `bridge did not log "connected to" within ${readyTimeoutMs}ms; ` +
        `stdout tail: ${stdoutTail.trim().slice(-500)}`,
    );
    lastError = err;
    rejectReadyFn?.(err);
  }, readyTimeoutMs);

  const stop = async (): Promise<void> => {
    if (readyTimeout !== null) {
      clearTimeout(readyTimeout);
      readyTimeout = null;
    }
    // W5 — attach the one-shot exit listener BEFORE the kill (and
    // before checking exitCode), so the listener can never miss an
    // exit that races the kill. The previous code path attached
    // `child.once('exit', …)` AFTER `process.kill(-pid, 'SIGKILL')`,
    // which had a real race: Node 22 SIGKILL's the child within
    // microseconds, the `exit` event fires synchronously on the
    // libuv loop, and by the time we hit the `child.once(...)`
    // attach the event has already been emitted. Node does NOT
    // replay missed exit events, so `await` hangs until the outer
    // promise timeout — teardown ordering then breaks down.
    //
    // Correct ordering: attach first, then check the
    // already-exited case, then send the kill. The exit listener
    // resolves the awaited promise regardless of which path fires
    // it (kill-induced or natural exit).
    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    if (child.exitCode !== null) {
      // Already gone by the time stop() runs (e.g. bridge self-
      // exited on ECONNREFUSED). The once listener may or may not
      // have been called — race-free path is to check exitCode and
      // resolve the await immediately if so.
      await exitPromise;
      return;
    }
    // Process-group kill: the bridge spawns pi via
    // `nodeSpawn('pi', …)` without `detached:true`, so pi is a
    // child of the bridge and shares its process group. Sending
    // SIGKILL to -pid (the negative pid) is the POSIX-portable way
    // to deliver the signal to every process in the group,
    // guaranteeing pi dies even if the bridge is mid-SIGTERM-grace
    // or stuck in an uncaught handler.
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone (race) — fall through to the individual kill.
        try {
          child.kill('SIGKILL');
        } catch {
          // Nothing more we can do.
        }
      }
    }
    // Reap to avoid zombies. The once listener attached above
    // fires either way (kill-induced or already-exited race).
    await exitPromise;
  };

  // waitForReady just returns the inner promise so callers see the
  // connect/timeout error directly (and so we can swap it out
  // without breaking the consumer contract).
  void lastError;

  return {
    child,
    waitForReady: () => readyPromise,
    stop,
  };
}
