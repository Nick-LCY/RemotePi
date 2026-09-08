// Helper: spawn the fake LLM server as a STANDALONE child process so
// it outlives globalSetup (Playwright spawns globalSetup in its own
// process; when setup returns, any in-process http.createServer owned
// by that process dies with it, and pi's first LLM roundtrip would
// fail with ECONNREFUSED — see ADR-0009 §5.1 密闭性三层防线 + 任务
// 12 §就绪链 for why the harness runs an in-process fake instead of
// reaching a real provider).
//
// The child runs the same `startFakeLlmServer` logic from the
// integration suite (`tests/integration/helpers/fake-llm-server.ts`)
// but wrapped in a tiny standalone script that:
//   1. Boots the server on port 0
//   2. Prints the listening URL to stdout as the FIRST line
//      (`FAKE_LLM_URL=http://127.0.0.1:<port>`) — the parent reads
//      this line and parses the port back out
//   3. Keeps the server alive until the parent sends SIGTERM /
//      SIGKILL (the parent never sends requests to the server
//      itself in the v1 harness — the bridge's pi spawn IS the
//      only client — but the server is hermetic + non-loopback-
//      reject for any future spec that wants to inject scripted
//      SSE responses via a sidecar HTTP API)
//
// We deliberately don't pipe the server's requests log back to the
// parent (no debug stream for the fake LLM); the bridge's bridge-
// stdout log + the wrangler log already capture the full
// LLM-touching story. If a future scenario needs scripted
// responses (e.g. multi-delta streaming for spec assertions), the
// right move is to add a small `/admin/script` HTTP endpoint to
// the child rather than reach into its in-process script queue.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export interface FakeLlmProcessOptions {
  /** Max ms to wait for the `FAKE_LLM_URL=...` first-line banner
   *  before rejecting. Default 10 s — the fake server starts in
   *  tens of milliseconds, so this is mostly defensive against
   *  tsx startup latency. */
  readyTimeoutMs?: number;
}

export interface FakeLlmProcess {
  /** Resolved URL the child is listening on (e.g. `http://127.0.0.1:34567`). */
  url: string;
  /** Port the child bound to (extracted from the URL). */
  port: number;
  /** Underlying child handle. Exposed for diagnostics only — use
   *  `stop()` for teardown. */
  child: ChildProcessByStdio<null, Readable, Readable>;
  /** SIGKILL the child + its process group. Idempotent. */
  stop: () => Promise<void>;
}

/** Spawn a standalone fake LLM server as a child process and read
 *  the listening URL from its first stdout line. The bridge's pi
 *  process will POST to this URL during the recovery ceremony
 *  (`get_messages` is a spawn trigger) and during the first prompt. */
export function startFakeLlmProcess(opts: FakeLlmProcessOptions = {}): Promise<FakeLlmProcess> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;
  // The standalone script lives next to this helper file. It imports
  // + boots `startFakeLlmServer` from the integration suite, prints
  // the URL banner, then sits idle until killed.
  const scriptPath = resolve(fileURLToPath(new URL('./fake-llm-standalone.ts', import.meta.url)));

  const child = spawn('node_modules/.bin/tsx', [scriptPath], {
    cwd: repoRoot,
    env: { ...process.env, PI_CODING_AGENT_DIR: '', PI_OFFLINE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  return new Promise<FakeLlmProcess>((resolveP, rejectP) => {
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    let stderrTail = '';
    let url: string | null = null;
    let port: number | null = null;
    let resolved = false;

    const finishReady = (fn: () => void): void => {
      if (resolved) return;
      resolved = true;
      if (readyTimer !== null) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      fn();
    };

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail += chunk;
      if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-4096);
    });
    child.stdout?.setEncoding('utf8');
    // W4 — accumulate stdout across chunks and match per-line.
    // The previous implementation applied the regex to a single
    // chunk; if the OS / Node pipe split the banner across two
    // chunks (e.g. `FAKE_LLM_URL=http://127.0` + `.0.1:34567\n`)
    // neither chunk matched, the `url !== null` early-return then
    // silenced subsequent chunks, and the harness hung until the
    // 10s readyTimeoutMs fired. The accumulator below grows an
    // `outBuffer` until we see `\n`, then scans the completed line.
    let outBuffer = '';
    child.stdout?.on('data', (chunk: string) => {
      if (url !== null) return;
      outBuffer += chunk;
      // Bound the buffer to a sane upper size to avoid runaway
      // memory if a future log-format change stops emitting the
      // newline entirely (we'd just hit the readyTimeout instead).
      if (outBuffer.length > 4096) {
        outBuffer = outBuffer.slice(-4096);
      }
      const newlineIdx = outBuffer.indexOf('\n');
      if (newlineIdx < 0) return; // banner not yet complete
      // Parse the first line: it MUST be
      // `FAKE_LLM_URL=http://127.0.0.1:<port>`. Anything else is a
      // startup error (e.g. the integration helper's port 0 bind
      // failed). Keep the parsing loose so a future log-format
      // change doesn't break this harness silently.
      const firstLine = outBuffer.slice(0, newlineIdx);
      const match = /^FAKE_LLM_URL=(http:\/\/127\.0\.0\.1:\d+)\b/.exec(firstLine);
      if (match === null) {
        finishReady(() => rejectP(new Error(`fake-llm banner missing or malformed: ${firstLine.slice(0, 200)}`)));
        return;
      }
      const candidate = match[1];
      if (candidate === undefined) return;
      url = candidate;
      const portMatch = /:(\d+)$/.exec(candidate);
      if (portMatch === null) {
        finishReady(() => rejectP(new Error(`fake-llm URL malformed: ${candidate}`)));
        return;
      }
      port = Number.parseInt(portMatch[1] ?? '', 10);
      if (!Number.isFinite(port) || port <= 0) {
        finishReady(() => rejectP(new Error(`fake-llm port invalid in URL: ${candidate}`)));
        return;
      }
      finishReady(() => resolveP({ url: candidate, port: port as number, child, stop: () => stopChild(child) }));
    });

    child.on('exit', (code, signal) => {
      finishReady(() =>
        rejectP(
          new Error(
            `fake-llm process exited before banner (code=${code}, signal=${signal}); ` +
              `stderr tail: ${stderrTail.trim().slice(-500)}`,
          ),
        ),
      );
    });

    readyTimer = setTimeout(() => {
      finishReady(() =>
        rejectP(
          new Error(`fake-llm process did not print banner within ${readyTimeoutMs}ms; ` +
            `stderr tail: ${stderrTail.trim().slice(-500)}`),
        ),
      );
    }, readyTimeoutMs);
  });
}

async function stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
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
  if (child.exitCode === null) {
    await new Promise<void>((r) => {
      child.once('exit', () => r());
    });
  }
}
