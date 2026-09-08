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
import { createWriteStream } from 'node:fs';
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
  /** Optional path to an independent post-mortem log file. The
   *  helper appends EVERY stdout/stderr chunk to this file via
   *  its own listener (independent of the parent global-setup
   *  pipe) — used during task 13 review to diagnose
   *  "pipe-dropped-data" symptoms. Set this to a file path and
   *  the helper lazy-creates the file on the first chunk. */
  postMortemLogPath?: string;
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
  // Optional post-mortem log sink — when set, EVERY stdout/stderr
  // chunk is appended to this file (not truncated). Useful when
  // diagnosing "bridge emitted nothing post-setup" mysteries: the
  // main file (bridge.log written by global-setup.ts) might lose
  // data due to pipe timing issues, but a second independent
  // listener on the same stream is the canonical confirmation.
  // Set via `postMortemLogPath` option (default: undefined).
  let postMortemLogStream: ReturnType<typeof createWriteStream> | null = null;
  if (opts.postMortemLogPath !== undefined) {
    postMortemLogStream = createWriteStream(opts.postMortemLogPath, { flags: 'a' });
  }
  stdoutStream.on('data', (chunk: string) => {
    stdoutTail += chunk;
    if (stdoutTail.length > 4096) {
      stdoutTail = stdoutTail.slice(-4096);
    }
    if (postMortemLogStream !== null) {
      postMortemLogStream.write('[bridge stdout] ' + chunk);
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
    if (postMortemLogStream !== null) {
      postMortemLogStream.write('[bridge stderr] ' + chunk);
    }
  });
  child.on('exit', (code, signal) => {
    if (postMortemLogStream !== null) {
      // W2-fanout — close the post-mortem log fd on every exit path
      // (success, throw, SIGKILL mid-flight). The stream's
      // underlying fd is libuv-owned; until `.end()` is called
      // Node holds it open and the GC can't reclaim. The exit
      // listener fires exactly once per child lifetime so this is
      // safe to call here (idempotent on already-closed streams).
      try {
        postMortemLogStream.end();
      } catch {
        // Best-effort — never mask the original error.
      }
      postMortemLogStream = null;
    }
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
    // W5 — follow the `wrangler-process.ts:189` short-circuit pattern.
    // If the bridge self-exited BEFORE stop() was called (e.g.
    // ECONNREFUSED → bridge exited cleanly with code 0, see current-
    // state TODO 2026-09-07 "bridge 僵尸"), `child.exitCode` is
    // already non-null and the `exit` event has already been emitted.
    // There is NO future `exit` event to wait for — `await` would hang
    // until the outer teardown timeout fires, breaking ordering for
    // any later teardown step. Check exitCode FIRST and bail out
    // immediately; the process is already gone.
    if (child.exitCode !== null) {
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
    // W5 — attach the one-shot exit listener AFTER the kill (since
    // we've already bailed out on the self-exited case above, the
    // race that motivated the previous "attach first" ordering no
    // longer exists). We await this listener to reap the zombie
    // cleanly so teardown ordering stays deterministic. The earlier
    // code attached the listener before the exitCode check AND
    // awaited it in the already-exited path — that combination
    // hanged teardown on every self-exited bridge.
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
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
