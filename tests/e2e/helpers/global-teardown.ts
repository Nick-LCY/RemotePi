// E2E harness globalTeardown — see ADR-0009 §决策 7 (清理纪律).
//
// Teardown order is **the reverse of setup**:
//   bridge → wrangler → fake LLM server → fixture cleanup → .tmp/
//
// Reverse order matters because:
//   - bridge.stop() kills the pi child (process group SIGKILL) before
//     wrangler dies; if wrangler died first, the bridge would still
//     hold an open WebSocket to the worker DO and the close event
//     would emit `bridge_status{online:false}` which would briefly
//     flap the browser's StatusBar in any subsequent run that
//     happened to share a token (it doesn't here because each run
//     has a fresh run-tag, but the discipline is cheap and
//     future-proof).
//   - wrangler dev owns the SQLite DO at `worker/.wrangler/`;
//     killing it BEFORE the fake LLM server is fine because pi is
//     already gone, but killing it BEFORE the bridge would leave
//     a half-closed WSS connection that emits a `bridge_status` on
//     the next (non-existent) run's startup window.
//   - fake LLM server last because the bridge's pi child uses it
//     throughout its lifetime — if the fake server died first,
//     pi would crash mid-SSE and the bridge would emit
//     `command_result{success:false, code:'pi_error'}` which we
//     would otherwise interpret as a test failure.
//
// `.tmp/` is preserved across runs (default per task 12 §global-teardown
// spec) so a Playwright `trace.zip` can be inspected against the
// on-disk artifacts. The next run's `globalSetup` overwrites
// `run-state.json` and `.tmp/<runTag>/` rotates.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface RunState {
  token: string;
  baseUrl: string;
  tmpRoot: string;
  agentDir: string;
  workDir: string;
  bridgeConfigPath: string;
  fakeLlmUrl: string;
}

interface HarnessHandles {
  bridgePid: number | null;
  wranglerPid: number | null;
  fakeServerPid: number | null;
  fakeServerPort: number | null;
  runTag: string;
  tmpRoot: string;
}

const e2eRoot = fileURLToPath(new URL('..', import.meta.url));

/** Best-effort SIGKILL of a pid (with process-group SIGKILL when
 *  the pid is a non-zero group leader). Idempotent — silently
 *  swallows ESRCH (already dead) and EPERM (foreign process —
 *  shouldn't happen because both processes are our children). */
function killPid(pid: number | null | undefined): void {
  if (pid === null || pid === undefined || !Number.isFinite(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return; // gone or foreign
    return;
  }
  try {
    // Negative pid = process group; the bridge + wrangler are
    // spawned `detached:true` specifically so we can SIGKILL the
    // entire group (their own child processes — pi for bridge,
    // workerd + esbuild for wrangler — die with them).
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

export default async function globalTeardown(): Promise<void> {
  // Read the handles globalSetup stashed on globalThis. We can't
  // rely on Playwright passing a typed value across the
  // globalSetup ↔ globalTeardown boundary (they're separate worker
  // processes), so the typed channel is the JSON files + the
  // process-group kills below.
  const stash = (globalThis as Record<string, unknown>)['__e2eHarness__'] as
    | HarnessHandles
    | undefined;
  // Always clear the stash so a rerun in the same process tree
  // doesn't accidentally reach into a stale handle.
  delete (globalThis as Record<string, unknown>)['__e2eHarness__'];

  const statePath = path.join(e2eRoot, '.tmp', 'run-state.json');
  let state: RunState | null = null;
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(await readFile(statePath, 'utf8')) as RunState;
    } catch {
      state = null;
    }
  }

  // Order matters (see file JSDoc). Each step is wrapped in
  // try/finally so one failure doesn't skip the next.
  try {
    // 1. Bridge + pi child. process-group SIGKILL covers both.
    killPid(stash?.bridgePid);
    // 2. Wrangler dev + workerd + esbuild children.
    killPid(stash?.wranglerPid);
  } finally {
    // 3. Fake LLM server. Now a separate child process (see
    //    fake-llm-process.ts — globalSetup used to own an in-process
    //    http.createServer, but Playwright's globalSetup exits after
    //    setupHarness returns and the server dies with it, leaving
    //    the bridge's pi spawn with ECONNREFUSED on the next LLM
    //    roundtrip). Kill by pid; fall back to lsof-by-port if the
    //    pid was lost (it shouldn't be, but belt + braces).
    killPid(stash?.fakeServerPid);
    const port = stash?.fakeServerPort;
    if (port !== null && port !== undefined && Number.isFinite(port)) {
      killPidOnPort(port);
    }
  }

  // 4. Fixture cleanup. We re-derive the same MakeAgentDirResult
  //    shape from `state` so we can call the same `cleanup()`
  //    closure the integration suite uses. Note: this assumes the
  //    fixture was created via `makeAgentDir` (it was — see
  //    globalSetup.ts); the cleanup is `rm -rf` over the tmpRoot.
  if (state !== null) {
    // Capture the (non-null) state in a local so the cleanup closure
    // doesn't need a non-null assertion on the outer ref.
    const stateRef = state;
    const fixtureLike = {
      agentDir: state.agentDir,
      workDir: state.workDir,
      cleanup: async (): Promise<void> => {
        // PRESERVE the per-run debug.log (wrangler + bridge stdout)
        // before nuking the run-tag subtree — it's the load-bearing
        // post-mortem artefact for "why did the test fail". Copy
        // to the parent `.tmp/` (gitignored, persists across runs)
        // so an operator can grep it after teardown. The next
        // run rotates only on the next fixture cleanup, so the
        // preserved log survives at least one rerun.
        const debugLog = path.join(stateRef.tmpRoot, 'debug.log');
        if (existsSync(debugLog)) {
          try {
            const preservedPath = path.join(
              e2eRoot,
              '.tmp',
              `debug-${path.basename(stateRef.tmpRoot)}.log`,
            );
            const { copyFile } = await import('node:fs/promises');
            await copyFile(debugLog, preservedPath);
          } catch {
            // Best-effort.
          }
        }
        await rm(stateRef.tmpRoot, { recursive: true, force: true });
      },
    };
    try {
      await fixtureLike.cleanup();
    } catch {
      // Best-effort. A stale tmpRoot is harmless because the next
      // run's setup rotates it.
    }
  }

  // 5. The `.tmp/<runTag>/` directory is gone after step 4. The
  //    `run-state.json` + `fakeServer` handles are gone too. We
  //    deliberately DO NOT remove `.tmp/` wholesale — a Playwright
  //    failure may have written `trace.zip` or `playwright-report/`
  //    there (we ship those to the on-disk trace dir even when the
  //    run itself failed), and operators inspect them after the
  //    fact. The next run rotates only its own `<runTag>/` subtree.
  //
  //    See `.gitignore` — `tests/e2e/.tmp/` is the carve-out.
}

/** Find a process listening on `127.0.0.1:<port>` and SIGKILL it.
 *  Uses `lsof` if available; falls back to "no-op" otherwise. We
 *  avoid `fuser` because it's Linux-only and the developer machine
 *  may be macOS.
 */
function killPidOnPort(port: number): void {
  try {
    // Synchronous `lsof` invocation; fine for teardown where a
    // few-ms latency doesn't matter.
    const probe = spawnSync('lsof', ['-ti', `tcp:${port}`], {
      encoding: 'utf8',
      timeout: 1_500,
    });
    if (probe.status === 0 && probe.stdout !== undefined) {
      for (const line of probe.stdout.trim().split('\n')) {
        const pid = Number.parseInt(line, 10);
        if (Number.isFinite(pid) && pid > 0) {
          killPid(pid);
        }
      }
    }
  } catch {
    // lsof not installed or otherwise failed; nothing actionable.
  }
}
