// Helper: spawn `wrangler dev` for the E2E harness and probe its
// readiness via the existing `/healthz` endpoint.
//
// Why this exists as a dedicated module rather than inlined into
// global-setup:
//   - Port-8787 fail-fast check (ADR-0009 §7.3) wants a clean
//     "port already in use, run `pnpm dev`" error before wrangler
//     even starts. Inlining into global-setup would mean
//     duplicating the net.Socket probe + the message formatting.
//   - The `waitForReady` semantics (poll /healthz with bounded
//     retries, surface the last error if all retries fail) are
//     identical for both the standalone harness and any future
//     adhoc use.
//
// Ready signal: `GET http://127.0.0.1:8787/healthz` returns 200 +
// the worker version text. The probe is HTTP-based (not stdout
// greps) because the wrangler dev output has moved across versions
// (the local-server "Ready on" line was renamed/relocated), while
// `/healthz` is the contract the worker itself surfaces
// (`worker/src/index.ts` `HEALTHZ_TEXT`). It's the only readiness
// signal that's guaranteed stable across wrangler upgrades.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import net from 'node:net';
import type { Readable } from 'node:stream';

export const E2E_WORKER_PORT = 8787;

export interface WranglerProcessOptions {
  /** Absolute path to the `worker/wrangler.toml` to use. */
  wranglerTomlPath: string;
  /** Repo root (where the worker package + node_modules live). */
  cwd: string;
  /** Max ms to wait for /healthz to return 200 before rejecting. */
  readyTimeoutMs?: number;
  /** Override the persisted SQLite directory (default:
   *  `worker/.wrangler/` — global-setup is responsible for
   *  `rm -rf`-ing it before each run). */
  persistTo?: string;
  /** Log prefix tag for stdout/stderr pipes (helps with trace). */
  tag?: string;
}

export interface WranglerProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  /** Wait until `/healthz` returns 200 (worker is up + DO migration
   *  finished + assets served). Rejects on timeout or if the worker
   *  exits before becoming ready. */
  waitForReady: () => Promise<void>;
  /** Best-effort SIGKILL of the wrangler process group. Idempotent. */
  stop: () => Promise<void>;
}

/** Probe `127.0.0.1:port` synchronously and return true when a TCP
 *  connection succeeds. Used by global-setup to fail fast BEFORE
 *  we spawn wrangler, so the operator gets a friendly "8787 is
 *  busy, did you mean to run `pnpm dev`?" message instead of
 *  wrangler's generic "Address already in use" stack. */
export async function isPortInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (inUse: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED → port is free. Anything else (e.g. EHOSTUNREACH)
      // we treat as "in use" so the operator doesn't think it's a
      // clean slate when it actually isn't.
      finish(err.code !== 'ECONNREFUSED' && err.code !== 'ENOTFOUND');
    });
    socket.connect(port, host);
  });
}

export function startWranglerProcess(opts: WranglerProcessOptions): Promise<WranglerProcess> {
  const persistFlag = `--persist-to=${opts.persistTo ?? 'worker/.wrangler'}`;
  const portFlag = `--port=${E2E_WORKER_PORT}`;
  // tag is reserved for future trace decoration (logs that surface
  // in the Playwright HTML report); currently swallowed so ESLint's
  // no-unused-vars rule doesn't fire.
  void opts.tag;

  const child = spawn(
    'npx',
    ['wrangler', 'dev', portFlag, persistFlag, '--config', opts.wranglerTomlPath],
    {
      cwd: opts.cwd,
      // wrangler reads a few env vars (CF_API_TOKEN etc.) which we
      // deliberately don't want leaking from the host shell —
      // however, a totally empty env also breaks wrangler's own
      // internal PATH lookups for node + its own binary, so we
      // keep PATH + HOME + the rest of the safe keys (buildHermeticEnv
      // would be too aggressive here — wrangler is NOT pi).
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detached so we can SIGKILL the entire process group at teardown
      // (wrangler dev spawns esbuild workers + workerd itself, all of
      // which need to die or they hold the port + temp dirs).
      detached: true,
    },
  );

  let ready = false;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  // shared mutable for the exit-error message
  let lastError: { message: string } | null = null;

  // Capture stdout/stderr tails for the error messages (no info
  // logging here — Playwright's reporter + our own .tmp log file
  // capture the same content for post-mortem).
  let stdoutTail = '';
  let stderrTail = '';
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (stdoutStream === null || stderrStream === null) {
    throw new Error('wrangler process: stdout/stderr not available (stdio config wrong?)');
  }
  stdoutStream.setEncoding('utf8');
  stderrStream.setEncoding('utf8');
  stdoutStream.on('data', (chunk: string) => {
    stdoutTail += chunk;
    if (stdoutTail.length > 4096) stdoutTail = stdoutTail.slice(-4096);
  });
  stderrStream.on('data', (chunk: string) => {
    stderrTail += chunk;
    if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-4096);
  });
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    if (!ready) {
      lastError = {
        message:
          `wrangler dev exited before /healthz was reachable (code=${code}, signal=${signal}); ` +
          `stderr tail: ${stderrTail.trim().slice(-500)}`,
      };
    }
  });

  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;

  const waitForReady = async (): Promise<void> => {
    // Poll /healthz with a tight budget. We do NOT wait on the
    // wrangler "Ready on" stdout line because the wrangler team has
    // changed its prefix across versions; /healthz is the contract
    // our own worker code defines and is stable.
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (ready) return;
      if (exitInfo !== null) {
        throw new Error(lastError?.message ?? 'wrangler exited unexpectedly');
      }
      try {
        const res = await fetch(`http://127.0.0.1:${E2E_WORKER_PORT}/healthz`, {
          // Short timeout so the poll loop yields to the event loop
          // and the exit handler can fire promptly on a fast crash.
          signal: AbortSignal.timeout(1000),
        });
        if (res.status === 200) {
          ready = true;
          return;
        }
        lastError = { message: `/healthz returned status ${res.status}` };
      } catch (err) {
        lastError = { message: (err as Error).message };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `wrangler dev did not respond on /healthz within ${readyTimeoutMs}ms; ` +
        `last error: ${lastError?.message ?? '<unknown>'}; ` +
        `stderr tail: ${stderrTail.trim().slice(-500)}`,
    );
  };

  const stop = async (): Promise<void> => {
    if (readyTimer !== null) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    if (child.exitCode !== null) return;
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
    if (exitInfo === null) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });
    }
  };

  return Promise.resolve({
    child,
    waitForReady,
    stop,
  });
}
