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
}

export interface GlobalHarness {
  fakeServer: FakeLlmProcess;
  fixture: MakeAgentDirResult;
  wrangler: Awaited<ReturnType<typeof startWranglerProcess>>;
  bridge: Awaited<ReturnType<typeof startBridgeProcess>>;
  state: RunState;
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
  assertDistArtifacts();
  await mkdir(tmpRoot, { recursive: true });
  await cleanWranglerPersist();
  await assertPortFree();

  const fakeServer = await startFakeLlmProcess();

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

  // Forward wrangler stdout/stderr to a debug log for post-mortem.
  // Helps triage "why did the test fail" without rerunning.
  const debugLogPath = path.join(tmpRoot, 'debug.log');
  const debugStream = (await import('node:fs')).createWriteStream(debugLogPath, { flags: 'a' });
  debugStream.write('=== wrangler dev ===\n');
  wrangler.child.stdout?.on('data', (c: Buffer | string) => debugStream.write(`[wrangler stdout] ${typeof c === "string" ? c : c.toString()}`));
  wrangler.child.stderr?.on('data', (c: Buffer | string) => debugStream.write(`[wrangler stderr] ${typeof c === "string" ? c : c.toString()}`));

  // First readiness leg: /healthz 200. ADR-0009 §7.5.
  await wrangler.waitForReady();

  const bridge = await startBridgeProcess({
    bridgeEntry: path.join(repoRoot, 'packages', 'bridge', 'src', 'index.ts'),
    configPath: bridgeConfigPath,
    cwd: repoRoot,
    env: bridgeEnv,
    readyTimeoutMs: 30_000,
  });
  debugStream.write('=== bridge ===\n');
  bridge.child.stdout?.on('data', (c: Buffer | string) => debugStream.write(`[bridge stdout] ${typeof c === "string" ? c : c.toString()}`));
  bridge.child.stderr?.on('data', (c: Buffer | string) => debugStream.write(`[bridge stderr] ${typeof c === "string" ? c : c.toString()}`));

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
  };
  // Write the run state so the specs can read it without depending
  // on Playwright's `use()` fixture (which doesn't work across
  // globalSetup ↔ spec boundaries in a typed way without a custom
  // fixture module). The harness also re-uses `tmpRoot` for the
  // teardown bookkeeping (fixture cleanup), so the teardown entry
  // discovers it via the same JSON.
  await writeFile(path.join(e2eRoot, '.tmp', 'run-state.json'), JSON.stringify(state, null, 2), 'utf8');

  return { fakeServer, fixture, wrangler, bridge, state };
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
  const harness = await setupHarness();
  // Stash on globalThis for the global-teardown entry point.
  // Playwright runs globalSetup and globalTeardown in separate
  // worker processes, so we also serialize the handles into the
  // `.tmp/run-state.json` (state) plus separate files for the
  // child PIDs (we can't JSON-serialize a ChildProcess).
  //
  // The PID files live alongside `run-state.json`. teardown reads
  // them and re-acquires handle references via `process.kill(pid, 0)`
  // liveness checks + `child_process.spawn` re-creation if needed.
  // In practice teardown sees the same PIDs and uses SIGKILL on the
  // process groups, which is sufficient.
  (globalThis as Record<string, unknown>)['__e2eHarness__'] = {
    bridgePid: harness.bridge.child.pid,
    wranglerPid: harness.wrangler.child.pid,
    fakeServerPid: harness.fakeServer.child.pid,
    fakeServerPort: harness.fakeServer.port,
    runTag,
    tmpRoot,
  };
}

/** Force-clean the entire `.tmp/` directory tree on global-setup
 *  failure. We do this so a half-failed run doesn't leak the next
 *  run's run-state.json. The teardown ALSO runs on setup failure
 *  (per Playwright contract), but it's keyed off the in-memory
 *  harness handle which may already be partial. */
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
