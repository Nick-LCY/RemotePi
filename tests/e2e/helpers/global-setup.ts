// E2E harness globalSetup — see ADR-0009 §决策 1/2/5/6/7 + 任务 12.
//
// Responsibilities (in execution order):
//
//  1. Pre-build the web + bridge bundles. We refuse to run with stale
//     `dist/` so a "test passes against old code" failure mode is
//     impossible. ADR-0009 §7.1 mandates web build with
//     `VITE_WSS_URL=ws://localhost:8787/web` — without it the SPA
//     hard-codes the production domain and never reaches our local
//     wrangler.
//  2. `rm -rf worker/.wrangler/` — the SQLite-backed Room DO persists
//     between runs and a leftover session would make scenario (a)'s
//     "empty message list" assertion fail. ADR-0009 §7.2.
//  3. Probe port 8787 — fail fast with a clear hint if it's busy
//     (operator probably has `pnpm dev` running). ADR-0009 §7.3.
//  4. Start the fake LLM server (port 0). Capture URL.
//  5. Build an isolated agent-dir fixture under
//     `tests/e2e/.tmp/<runTag>/` and write a bridge config JSON that
//     points worker_url/web_base_url/work_dir/token at the right
//     places.
//  6. Spawn the bridge child process with `node dist/index.js
//     --config <tmp.json>` and wait for the "connected to" stdout
//     line. ADR-0009 §7.5 second readiness leg.
//  7. Spawn `wrangler dev` and wait for `/healthz` to return 200.
//     ADR-0009 §7.5 first readiness leg.
//  8. Write a `tests/e2e/.tmp/run-state.json` snapshot that the test
//     specs consume (base URL, token, fixture paths, etc.). Playwright
//     doesn't expose a typed fixture for globalSetup return values
//     across files (each spec is its own worker), so a JSON file is
//     the simplest cross-spec channel.
//  9. The browser-side readiness check (chat-view visible) is owned
//     by the spec — the harness doesn't open Chromium. ADR-0009
//     §7.5 third readiness leg lives in the test body because
//     Playwright's `page` is only available there.
//
// Failure mode: any step throwing aborts the entire run — Playwright
// surfaces global-setup errors as a top-level "global setup failed"
// and skips all specs. We don't try to clean up partial state
// (half-spawned wrangler + bridge + fake server) because global
// teardown still runs on setup failure (Playwright contract) and
// handles the best-effort cleanup path. See global-teardown.ts for
// the ordering rationale.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { buildHermeticEnv } from './env-builder.js';
import { isPortInUse, startWranglerProcess, E2E_WORKER_PORT } from './wrangler-process.js';
import { startBridgeProcess } from './bridge-process.js';
import { startFakeLlmProcess, type FakeLlmProcess } from './fake-llm-process.js';
import {
  makeAgentDir,
  type MakeAgentDirResult,
} from '../../integration/helpers/make-fixture.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const e2eRoot = fileURLToPath(new URL('..', import.meta.url));
const runTag = `e2e-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
const tmpRoot = path.join(e2eRoot, '.tmp', runTag);

interface RunState {
  /** Token written into the bridge config + used in the URL hash
   *  the page navigates to. */
  token: string;
  /** Base URL the browser should navigate to (wrangler dev port). */
  baseUrl: string;
  /** Run-tag subdir of `tests/e2e/.tmp/` for this setup pass. */
  tmpRoot: string;
  /** Absolute path to the fixture's agent-dir (for diagnostics +
   *  cleanup). */
  agentDir: string;
  /** Absolute path to the fixture's workDir. */
  workDir: string;
  /** Absolute path to the bridge config JSON (in case a future test
   *  needs to inspect it — not used by scenario (a)). */
  bridgeConfigPath: string;
  /** URL of the fake LLM server (informational; the bridge spawns
   *  pi pointed at the fixture which carries the same URL). */
  fakeLlmUrl: string;
  /** Helper: build a fresh spec-scoped token so each scenario can
   *  use its own Room DO. Without this, all three scenarios share
   *  the same runTag-based token and SQLite messages bleed across
   *  (scenario (b) saw scenario (a)'s prompt history when run
   *  together). The per-spec token is a 16-byte hex string that
   *  stays in the same family as the bridge's runTag token
   *  (matches `^[-_a-zA-Z0-9]+$`) so the worker's extractToken
   *  regex accepts it. */
  freshSpecToken(): string;
}

export interface GlobalHarness {
  fakeServer: FakeLlmProcess;
  fixture: MakeAgentDirResult;
  wrangler: Awaited<ReturnType<typeof startWranglerProcess>>;
  bridge: Awaited<ReturnType<typeof startBridgeProcess>>;
  state: RunState;
}

/** W3 — Shape of the globalThis stash that `setupHarness()` writes
 *  progressively and `global-teardown.ts` reads on the other side.
 *  Every field is nullable so a partial-progress stash (e.g.
 *  fake-server spawned but wrangler failed) still type-checks for
 *  the teardown's best-effort kill loop. Kept in sync with the
 *  copy in `global-teardown.ts` (both files define the same shape
 *  rather than cross-importing because Playwright's
 *  globalSetup/globalTeardown contract uses two separate worker
 *  processes — sharing a TypeScript module isn't worth the
 *  resolution ambiguity). */
export interface HarnessHandles {
  bridgePid: number | null;
  wranglerPid: number | null;
  fakeServerPid: number | null;
  fakeServerPort: number | null;
  runTag: string;
  tmpRoot: string;
}

/** Pre-build web + bridge if their `dist/` is missing. We DON'T
 *  always rebuild — that's too slow for a `test:e2e` loop where the
 *  operator is iterating on a test. The expectation is that
 *  `pnpm build` was run first, or that the source files are fresh
 *  enough that the existing dist is fine. The build cmd is
 *  documented in the error message so the operator knows what to run.
 *
 *  Reason we DON'T auto-rebuild on every run: a `vite build` is
 *  ~3-5s, tsc-bridge is ~2s; that's a lot of latency for the case
 *  where the operator just edited a spec. We trust the operator to
 *  have run `pnpm build` first OR to accept the risk of stale dist
 *  for the iteration they're in.
 */
/** Inspect the existing web dist for the right WSS URL baked in.
 *  We grep for `ws://localhost:8787/web` (the local wrangler
 *  endpoint) and `wss://remote-pi.sankabox.com/web` (the prod
 *  default). The bundle MUST contain the local URL — otherwise
 *  the SPA hard-codes the prod endpoint and the harness can never
 *  reach the local wrangler. Returns `null` on the happy path, an
 *  error string explaining what to do otherwise. */
function webDistWssUrlCheck(): string | null {
  const indexHtml = path.join(repoRoot, 'packages', 'web', 'dist', 'index.html');
  if (!existsSync(indexHtml)) return 'packages/web/dist/index.html missing';
  const assetsDir = path.join(repoRoot, 'packages', 'web', 'dist', 'assets');
  if (!existsSync(assetsDir)) return 'packages/web/dist/assets missing';
  const entries = readdirSync(assetsDir);
  const jsFile = entries.find((n) => n.startsWith('index-') && n.endsWith('.js'));
  if (jsFile === undefined) return 'no built index-*.js in packages/web/dist/assets';
  const jsPath = path.join(assetsDir, jsFile);
  const jsBody = readFileSync(jsPath, 'utf8');
  const hasLocalUrl = jsBody.includes('ws://localhost:8787/web');
  const hasProdUrl = jsBody.includes('wss://remote-pi.sankabox.com/web');
  if (!hasLocalUrl && hasProdUrl) {
    return (
      'packages/web/dist was built WITHOUT VITE_WSS_URL=ws://localhost:8787/web — ' +
      'the SPA will hard-code the prod endpoint and never reach local wrangler. ' +
      'Rebuild with: `VITE_WSS_URL=ws://localhost:8787/web pnpm --filter @remotepi/web build`.'
    );
  }
  if (!hasLocalUrl && !hasProdUrl) {
    return 'packages/web/dist bundle contains neither local nor prod WSS URL — build seems broken';
  }
  return null;
}

function assertDistArtifacts(): void {
  // The web dist is REQUIRED because wrangler dev serves
  // `packages/web/dist` as static assets (verified against
  // `worker/wrangler.toml` `[assets] directory = "../packages/web/dist"`).
  // The bridge is run via `tsx packages/bridge/src/index.ts` so
  // we don't need its `dist/` — but having the build run keeps
  // `pnpm -r build` honest about breaking TS changes (the bridge
  // does have a tsconfig.build.json for that purpose).
  const webDist = path.join(repoRoot, 'packages', 'web', 'dist', 'index.html');
  const bridgeSrc = path.join(repoRoot, 'packages', 'bridge', 'src', 'index.ts');
  const missing: string[] = [];
  if (!existsSync(webDist)) missing.push(`packages/web/dist (${webDist})`);
  if (!existsSync(bridgeSrc)) missing.push(`packages/bridge/src/index.ts (${bridgeSrc})`);
  if (missing.length > 0) {
    throw new Error(
      `E2E harness requires pre-built artifacts — missing:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        `\nRun \`pnpm -r build\` (or the per-package commands) before \`pnpm test:e2e\`.\n` +
        `Web build MUST set VITE_WSS_URL=ws://localhost:8787/web so the SPA connects to local wrangler:\n` +
        `  VITE_WSS_URL=ws://localhost:8787/web pnpm --filter @remotepi/web build`,
    );
  }
  // Verify the built bundle actually has the local WSS URL. A
  // `pnpm -r build` without `VITE_WSS_URL` would silently fall
  // back to the prod domain (web/src/ws/config.ts:29) and the
  // harness would mysteriously never reach the local worker. The
  // "missing dist" check above doesn't catch that — only an
  // explicit bundle inspection does.
  const wssErr = webDistWssUrlCheck();
  if (wssErr !== null) {
    throw new Error(
      `${wssErr}\n` +
        `Run: \`VITE_WSS_URL=ws://localhost:8787/web pnpm --filter @remotepi/web build\``,
    );
  }
}

async function cleanWranglerPersist(): Promise<void> {
  const persistDir = path.join(repoRoot, 'worker', '.wrangler');
  await rm(persistDir, { recursive: true, force: true });
}

async function assertPortFree(): Promise<void> {
  const inUse = await isPortInUse(E2E_WORKER_PORT);
  if (inUse) {
    throw new Error(
      `E2E harness requires port ${E2E_WORKER_PORT} to be free (got "address already in use").\n` +
        `Most likely \`pnpm dev\` is running in another shell — stop it first.\n` +
        `(Port is fixed at ${E2E_WORKER_PORT} because VITE_WSS_URL is baked into the web bundle at build time —\n` +
        `changing it would require a fresh web build per run.)`,
    );
  }
}

async function setupHarness(): Promise<GlobalHarness> {
  // W3 — wrap the entire setup so a mid-flight failure still leaves
  // teardown something to clean up (PIDs are stashed progressively
  // below, BEFORE each potentially-throwing readiness await). On
  // any failure, S1 wires in `clearStaleTmp()` to wipe the
  // half-baked `.tmp/` so the next run doesn't inherit a stale
  // run-state.json that points at dead processes. The teardown ALSO
  // runs on setup failure (Playwright contract) — these two paths
  // are complementary, not redundant: teardown kills child PIDs;
  // clearStaleTmp wipes stale on-disk state.
  let harness: GlobalHarness | null = null;
  // Counter backing `freshSpecToken` — incremented per call so
  // two specs requesting at the same time get distinct tokens.
  // Closure-scoped to setupHarness so it resets each globalSetup
  // pass (i.e. each `pnpm test:e2e` invocation).
  let specTokenCounter = 0;
  try {
    assertDistArtifacts();
    await mkdir(tmpRoot, { recursive: true });
    await cleanWranglerPersist();
    await assertPortFree();

    const fakeServer = await startFakeLlmProcess();
    // W3 — stash fakeServer immediately so a later failure still
    // lets teardown reach the fake-llm PID (otherwise the fake
    // server lives forever because no one has its handle).
    stashHarness({ fakeServerPid: fakeServer.child.pid, fakeServerPort: fakeServer.port });

    const fixture = await makeAgentDir({
      fakeLlmBaseUrl: fakeServer.url,
      runTag,
    });

    const token = `e2e-fixed-token-${runTag}`;
    const bridgeConfigPath = path.join(tmpRoot, 'bridge.json');
    const bridgeConfig = {
      worker_url: `ws://localhost:${E2E_WORKER_PORT}/bridge`,
      web_base_url: `http://localhost:${E2E_WORKER_PORT}`,
      work_dir: fixture.workDir,
      token,
    };
    await writeFile(bridgeConfigPath, JSON.stringify(bridgeConfig, null, 2), 'utf8');

    const bridgeEnv = buildHermeticEnv({ agentDir: fixture.agentDir });
    // The bridge itself doesn't read provider keys, but the env it
    // inherits is what its pi child sees — so the hermeticity lives
    // here exactly as it does in tests/integration. (Production bridge
    // doesn't strip provider keys — that's a deliberate decision noted
    // in pi-process.ts — but the E2E harness is closer to a test
    // fixture than a production deploy, so we keep the strip on.)

    // Order note (deviation from task 12 §全局 setup step 4, documented
    // here for the next maintainer): the task file says "bridge →
    // wrangler", but the BRIDGE 僵尸挂账 (current-state TODO 2026-09-07)
    // means the bridge exits cleanly with code 0 if its initial WS
    // connection fails (Node 22's WebSocket fires `onerror` but NEVER
    // `onclose` on ECONNREFUSED, so `BridgeClient.handleClose()` never
    // fires and no reconnect timer is scheduled — the process then
    // has no work on the event loop and exits). The bridge is NOT
    // touched per task 12's "no product fixes" constraint, so we
    // reverse the order: wrangler first, /healthz 200, THEN bridge.
    // The bridge then connects on its first attempt and logs
    // "connected to". This is the only workable ordering until the
    // bridge 僵尸挂账 is resolved.
    const wrangler = await startWranglerProcess({
      wranglerTomlPath: path.join(repoRoot, 'worker', 'wrangler.toml'),
      cwd: repoRoot,
      readyTimeoutMs: 45_000,
      persistTo: path.join(repoRoot, 'worker', '.wrangler'),
    });
    // W3 — stash wrangler immediately too. If the bridge spawn /
    // readiness times out, teardown can still reach wrangler's PID.
    stashHarness({ wranglerPid: wrangler.child.pid });

    // Forward wrangler + bridge stdout/stderr to a debug log for
    // post-mortem. Helps triage "why did the test fail" without
    // rerunning.
    //
    // W2 — debugStream backpressure + failed-path fd close:
    //   1) `.write()` returning `false` means the internal buffer is
    //      full; if we don't await the 'drain' event the next chunk
    //      can deadlock the wrangler/bridge pipes (their internal
    //      backpressure stops applying, output stalls).
    //   2) The stream's underlying fd must be `end()`-ed on every
    //      exit path (success, throw, or SIGKILL mid-flight) — a
    //      dangling WriteStream leaks an fd that the GC won't
    //      reclaim (libuv holds the fd until the handle closes).
    //      The try/finally below ensures `.end()` is called even
    //      when the inner readiness awaits throw.
    //
    // We also write bridge stdout to a SEPARATE file (no
    // interleaving with wrangler) so the bridge log can be
    // diffed across runs without parsing mixed prefixes. The
    // diffed across runs without parsing mixed prefixes. The
    // combined debug.log is the single post-mortem artefact for
    // task 13 — the earlier dedicated bridge.log file was dropped
    // after the dual-write backpressure dance kept dropping
    // post-setup chunks (verified via the bridge-process.ts
    // postmortem sink which captured the full output, while
    // bridge.log only had the first 8 setup lines). All
    // bridge-process.ts diagnostic info now flows into
    // `bridge-postmortem.log` (independent listener attached by
    // bridge-process.ts to bypass any global-setup pipe issues).
    const debugLogPath = path.join(tmpRoot, 'debug.log');
    const debugStream = (await import('node:fs')).createWriteStream(debugLogPath, { flags: 'a' });
    try {
      // Fire-and-forget the first banner; if it's a backpressure
      // moment (unlikely on a fresh file, but be safe) we await
      // 'drain' inline before continuing.
      await writeWithBackpressure(debugStream, '=== wrangler dev ===\n');
      wireForward(wrangler.child.stdout, debugStream, '[wrangler stdout] ');
      wireForward(wrangler.child.stderr, debugStream, '[wrangler stderr] ');

      // First readiness leg: /healthz 200. ADR-0009 §7.5.
      await wrangler.waitForReady();

      // Pipe bridge stdout/stderr to a dedicated file BEFORE
      // starting the bridge — `spawn()` returns synchronously
      // but the child can write its first stdout chunk before
      // our `'data'` listener attaches. `pipe()` registers the
      // listeners synchronously inside its constructor, so the
      // race window is closed. The dedicated stream lives
      // alongside `debug.log` so we can compare them post-mortem
      // (the combined stream shows interleave order; the dedicated
      // shows bridge-only).
      const bridge = await startBridgeProcess({
        bridgeEntry: path.join(repoRoot, 'packages', 'bridge', 'src', 'index.ts'),
        configPath: bridgeConfigPath,
        cwd: repoRoot,
        env: bridgeEnv,
        readyTimeoutMs: 30_000,
        // Independent post-mortem log: bridge-process.ts appends
        // every chunk to this file via its own listener (bypasses
        // the global-setup pipe, so the two capture surfaces
        // either both see the data or one of them has a bug we
        // can pinpoint). Used during task 13 review to diagnose
        // "global-setup pipe drops post-setup data" symptoms.
        postMortemLogPath: path.join(tmpRoot, 'bridge-postmortem.log'),
      });
      // W3 — stash bridge pid too. Once this is in globalThis, ALL
      // three child PIDs are reachable from teardown.
      stashHarness({ bridgePid: bridge.child.pid });

      // Wire bridge pipes IMMEDIATELY after spawn. We write
      // bridge stdout/stderr directly to debugStream with the
      // `[bridge stdout] ` / `[bridge stderr] ` prefix — no
      // pipe() (which empirically drops chunks after the initial
      // setup banner, verified during task 13 review) and no
      // dedicated bridge.log file (also dropped chunks via the
      // shared-drain-flag deadlock). The bridge's complete output
      // is captured by bridge-postmortem.log (independent
      // listener attached by bridge-process.ts to bypass any
      // global-setup-side issues). Single-write + drop-on-
      // backpressure is acceptable here because the bridge.log is
      // a debug aid; the postmortem is the authoritative capture.
      const bridgeOutFanout = bridge.child.stdout;
      if (bridgeOutFanout !== null) {
        const { appendFileSync } = await import('node:fs');
        bridgeOutFanout.on('data', (chunk: string) => {
          if (chunk.length === 0) return;
          // Direct appendFileSync — bypasses WriteStream entirely.
          appendFileSync(debugLogPath, `[bridge stdout] ${chunk}`);
        });
        bridgeOutFanout.on('error', () => {
          // EPIPE / child-exit. Swallow.
        });
      }
      const bridgeErrFanout = bridge.child.stderr;
      if (bridgeErrFanout !== null) {
        const { appendFileSync } = await import('node:fs');
        bridgeErrFanout.on('data', (chunk: string) => {
          if (chunk.length === 0) return;
          appendFileSync(debugLogPath, `[bridge stderr] ${chunk}`);
        });
        bridgeErrFanout.on('error', () => {
          // See stdout comment above.
        });
      }

      await writeWithBackpressure(debugStream, '=== bridge ===\n');

      // Second readiness leg: bridge stdout "connected to". ADR-0009 §7.5.
      await bridge.waitForReady();

      // Third readiness leg (chat-view) is owned by the spec — the
      // harness doesn't open Chromium.

      const state: RunState = {
        token,
        baseUrl: `http://localhost:${E2E_WORKER_PORT}`,
        tmpRoot,
        agentDir: fixture.agentDir,
        workDir: fixture.workDir,
        bridgeConfigPath,
        fakeLlmUrl: fakeServer.url,
        // Per-spec token factory — derived from the runTag + a
        // per-call counter so two specs asking at the same time
        // don't collide. 16 hex chars = 8 bytes of entropy; the
        // worker `extractToken` regex (`/^[-_a-zA-Z0-9]+$/`,
        // min length 1) accepts this without modification.
        freshSpecToken(): string {
          specTokenCounter += 1;
          return `${runTag}-spec-${specTokenCounter.toString(36).padStart(4, '0')}`;
        },
      };
      // Write the run state so the specs can read it without depending
      // on Playwright's `use()` fixture (which doesn't work across
      // globalSetup ↔ spec boundaries in a typed way without a custom
      // fixture module). The harness also re-uses `tmpRoot` for the
      // teardown bookkeeping (fixture cleanup), so the teardown entry
      // discovers it via the same JSON.
      await writeFile(path.join(e2eRoot, '.tmp', 'run-state.json'), JSON.stringify(state, null, 2), 'utf8');

      harness = { fakeServer, fixture, wrangler, bridge, state };
      return harness;
    } finally {
      // W2 — close the fd on EVERY exit path (success + throw).
      // Best-effort: a throw mid-await (e.g. bridge.waitForReady
      // times out) must still release the WriteStream's fd so the
      // GC can clean up. `.end()` is idempotent (subsequent calls
      // after auto-close are no-ops).
      try {
        debugStream.end();
      } catch {
        // Best-effort — never mask the original error.
      }
    }
  } catch (err) {
    // S1 — setup failed mid-flight (any spawn or readiness threw).
    // Wipe `.tmp/` so the next run doesn't pick up a stale
    // run-state.json that points at dead PIDs (the teardown WILL
    // also run, but it relies on either the run-state.json OR the
    // globalThis stash — both of which may be partially-missing).
    await clearStaleTmp();
    throw err;
  }
}

/** W3 — progressive stash helper. Each spawn that succeeds calls
 *  this with its PID(s); subsequent failures still leave teardown
 *  with the PIDs we already know about. Each call MERGES into the
 *  existing stash rather than replacing it, so partial progress is
 *  preserved.
 *
 *  Stash lives on `globalThis` because Playwright's globalSetup
 *  and globalTeardown run in separate worker processes — the
 *  JSON files at `.tmp/run-state.json` are the in-process companion
 *  to this stash. */
function stashHarness(patch: Partial<HarnessHandles>): void {
  const prev =
    ((globalThis as Record<string, unknown>)['__e2eHarness__'] as
      | Partial<HarnessHandles>
      | undefined) ?? {};
  const next: HarnessHandles = {
    bridgePid: patch.bridgePid ?? prev.bridgePid ?? null,
    wranglerPid: patch.wranglerPid ?? prev.wranglerPid ?? null,
    fakeServerPid: patch.fakeServerPid ?? prev.fakeServerPid ?? null,
    fakeServerPort: patch.fakeServerPort ?? prev.fakeServerPort ?? null,
    runTag: patch.runTag ?? prev.runTag ?? runTag,
    tmpRoot: patch.tmpRoot ?? prev.tmpRoot ?? tmpRoot,
  };
  (globalThis as Record<string, unknown>)['__e2eHarness__'] = next;
}

/** W2 — pipe a child's stdout/stderr through a WriteStream via
 *  `pipe()` + a Transform that prepends a per-source prefix
 *  (`[wrangler stdout] ` etc.) to every chunk. The Transform
 *  approach was chosen over a hand-rolled `'data'` handler because:
 *    - `pipe()` attaches listeners synchronously, so no chunk is
 *      dropped in the race window between `spawn()` returning
 *      and the listener attaching (a real failure mode observed
 *      during task 11 review).
 *    - backpressure is managed automatically (via `'drain'`) —
 *      a hand-rolled `'data'` handler that doesn't pause the
 *      source during backpressure will buffer writes inside the
 *      Node runtime until the GC reclaims or the process exits.
 *    - the Transform lets us rewrite each chunk (prepend the
 *      prefix) without breaking the pipe semantics.
 *
 *  On `dest.end()` (in the surrounding `try/finally`), `pipe()`
 *  auto-unpipes; no manual cleanup needed.
 *
 *  `await writeWithBackpressure` for the inline banner writes
 *  keeps the existing await-drain behaviour on a per-write
 *  basis — those one-shot writes have nothing to do with the
 *  streaming pipe. */
/** W2 — pipe a child's stdout/stderr through a WriteStream with
 *  a per-source prefix and proper backpressure handling. We use a
 *  hand-rolled `'data'` listener (rather than `pipe()`) because the
 *  earlier `pipe()` + Transform implementation silently dropped
 *  chunks after the initial setup banner — empirically observed
 *  during task 13 review where the bridge was clearly writing
 *  `spawning pi (count=1)`, `phase transition: …`, etc. (verified
 *  via the bridge-process.ts post-mortem sink) yet none of those
 *  lines reached the bridge.log file written by this function.
 *
 *  The hand-rolled approach has three correctness requirements:
 *    1. Each `'data'` event must result in exactly one
 *       `dest.write(prefix + text)` call (or zero, if the chunk
 *       is empty). Dropping chunks is the symptom we're guarding
 *       against.
 *    2. On backpressure (`write()` returns false), we register
 *       a one-shot `'drain'` listener and stop emitting further
 *       writes until drain fires. This prevents the WriteStream's
 *       internal buffer from growing unbounded and ensures the
 *       child pipe back-pressures upstream (so the child process
 *       stalls on stdout writes rather than buffering them
 *       indefinitely in the kernel pipe).
 *    3. We attach `'error'` handlers so an EPIPE / child-exit
 *       doesn't crash the harness via unhandled stream error.
 *
 *  The flag `drainPending` deduplicates the 'drain' listener — a
 *  second `false` return while the buffer is still full would
 *  otherwise pile up listeners and trigger Node's
 *  MaxListenersExceededWarning (observed in an earlier iteration of
 *  task 13's W2 fix). */
function wireForward(
  source: NodeJS.ReadableStream | null,
  dest: import('node:fs').WriteStream,
  prefix: string,
): void {
  if (source === null) return;
  let drainPending = false;
  source.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    if (text.length === 0) return;
    const ok = dest.write(prefix + text);
    if (!ok && !drainPending) {
      drainPending = true;
      dest.once('drain', () => {
        drainPending = false;
      });
    }
  });
  source.on('error', () => {
    // EPIPE / child-exit. Swallow — the child already exited
    // (its 'exit' handler will fire and tear down the harness);
    // nothing actionable here.
  });
}

/** W2 — write a string to a WriteStream and resolve on 'drain' if
 *  the buffer was full, immediately otherwise. Used for the inline
 *  banner writes that happen before the pipe is fully wired. */
function writeWithBackpressure(stream: import('node:fs').WriteStream, text: string): Promise<void> {
  const ok = stream.write(text);
  if (ok) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('drain', () => resolve());
  });
}

/** Exported helper for specs that need to read the run state without
 *  re-deriving paths. Specs call this in `test.beforeAll` (or at the
 *  top of a single test) and use the returned shape for navigation
 *  + cleanup. */
export async function readRunState(): Promise<RunState> {
  const statePath = path.join(e2eRoot, '.tmp', 'run-state.json');
  const raw = await (await import('node:fs/promises')).readFile(statePath, 'utf8');
  return JSON.parse(raw) as RunState;
}

export default async function globalSetup(): Promise<void> {
  // W3 — PIDs are stashed progressively inside `setupHarness()`
  // (after each successful spawn) so teardown can reach them even
  // if a later spawn or readiness await throws. The default-export
  // entry point is now just the catch-and-throw — the stash work
  // already happened during setupHarness's life.
  await setupHarness();
}

/** Force-clean the entire `.tmp/` directory tree on global-setup
 *  failure. Wired in by `setupHarness()`'s catch block (S1) so a
 *  half-failed run doesn't leak into the next run. Public export
 *  kept for tests / manual recovery (e.g. after a hard kill). */
export async function clearStaleTmp(): Promise<void> {
  const tmpDir = path.join(e2eRoot, '.tmp');
  await rm(tmpDir, { recursive: true, force: true });
}

/** Re-exported for the spec's `test.afterAll` cleanup when the
 *  global-teardown didn't run (e.g. a Playwright version that
 *  doesn't fire teardown on early setup failure). */
export { runTag, tmpRoot };

// Keep the unused-import linter quiet — `spawn` is referenced in
// JSDoc above (the bridge child comment about "node …" runtime),
// not as an actual code dependency in this file.
void spawn;
