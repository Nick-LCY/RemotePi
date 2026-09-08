// Helper: build a real PiProcessManager pointed at a fake-llm-backed
// agent-dir, with the outbound envelope stream captured into an array
// for assertion.
//
// `makeManager({ agentDir, workDir, idleTimeoutMs?, sigkillDelayMs? })`
// returns:
//   - `manager`: PiProcessManager (call .start() to print the
//     diagnostic banner)
//   - `outbound`: mutable array; every outbound envelope is pushed
//     here in arrival order (mirrors what the bridge forwards to web)
//   - `cleanup`: stops the manager, waits for the child to exit, and
//     removes the temp directories
//
// Hermeticity (the env-var-strip + fixture-pinning logic) lives in
// `build-hermetic-env.ts` and is the **shared source of truth** for
// the integration suite AND the `tests/e2e/` harness (see
// ADR-0009 §5 复用策略 + 任务 12 抽取首选). Any future provider
// additions belong in that helper so both suites stay in sync.

import { spawnSync } from 'node:child_process';
import { Envelope, PROTOCOL_VERSION, type Envelope as EnvelopeT } from '@remotepi/shared';
import { PiProcessManager, type PiProcessOptions } from '@remotepi/bridge/pi-process.js';
import { buildHermeticEnv } from './build-hermetic-env.js';

export interface MakeManagerOptions {
  /** Agent-dir from `makeAgentDir`. */
  agentDir: string;
  /** Work-dir from `makeAgentDir`. */
  workDir: string;
  /** Override idle timeout for fast idle-kill tests (default: production 5 min). */
  idleTimeoutMs?: number;
  /** Override SIGKILL grace delay (default: production 1 s). */
  sigkillDelayMs?: number;
}

export interface MakeManagerResult {
  manager: PiProcessManager;
  outbound: EnvelopeT[];
  cleanup: () => Promise<void>;
}

/**
 * Build a PiProcessManager wired against a fake-llm-backed agent-dir.
 *
 * The manager is constructed (not yet started) so callers can perform
 * additional setup (e.g. inspect `manager.getPhase() === 'exited'`)
 * before calling `manager.start()`. The first `handleEnvelope(prompt)`
 * call triggers the lazy spawn.
 */
export function makeManager(opts: MakeManagerOptions): MakeManagerResult {
  // Pre-flight check: the integration suite spawns a real
  // `pi --mode rpc` subprocess, so the binary must be on PATH.
  // Fail fast with a clear message rather than letting every
  // case die with a 30 s spawn-timeout. CI intentionally does
  // not run this suite (see .github/workflows/ci.yml and
  // ADR-0008 §3) — the guard is for local developers
  // who haven't installed `@earendil-works/pi-coding-agent`.
  assertPiAvailable();
  const outbound: EnvelopeT[] = [];

  // Sanitize the env (strip provider keys) + pin pi's agent dir +
  // PI_OFFLINE=1. See build-hermetic-env.ts for the full defense
  // layer rationale; this call is layer 1 only — layers 2 (fixture
  // settings.json default provider) + 3 (fake-llm-server's
  // fake-claude-* guard) live in make-fixture.ts and
  // fake-llm-server.ts respectively.
  const baseEnv = buildHermeticEnv({ agentDir: opts.agentDir });

  const piOpts: PiProcessOptions = {
    agentDir: opts.agentDir,
    workDir: opts.workDir,
    baseEnv,
    onOutboundEnvelope: (env) => {
      outbound.push(env);
    },
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    ...(opts.sigkillDelayMs !== undefined ? { sigkillDelayMs: opts.sigkillDelayMs } : {}),
  };

  const manager = new PiProcessManager(piOpts);

  // Cleanup: stop the manager, wait for the child process to actually
  // exit, then remove the temp dirs. We poll phase + child pointer
  // instead of relying on `manager.stop()` to block — `stop()` is
  // fire-and-forget (it just kills; the 'exit' event handler runs
  // asynchronously). Polling is bounded by a 5 s budget which is
  // plenty for SIGTERM to take effect on `pi --mode rpc`.
  const cleanup = async (): Promise<void> => {
    manager.stop();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (manager.getPhase() === 'exited') {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  return { manager, outbound, cleanup };
}

// Re-export the protocol-version literal so callers (e.g. a helper
// building an inbound envelope) don't need a second import.
export { PROTOCOL_VERSION };
export { Envelope };

/**
 * Verify that the `pi` binary is on PATH and responds to `--version`.
 * Throws an `Error` with a clear remediation hint when it isn't, so a
 * developer without `@earendil-works/pi-coding-agent` installed sees
 * the failure immediately instead of waiting for every test case to
 * time out on its 30 s spawn timeout.
 *
 * `spawnSync` (rather than `which`) so PATH resolution matches the
 * exact behaviour of `PiProcessManager`'s `nodeSpawn('pi', ...)` call
 * downstream.
 */
function assertPiAvailable(): void {
  const probe = spawnSync('pi', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });
  if (probe.error !== undefined || probe.status !== 0) {
    const errno = probe.error as NodeJS.ErrnoException;
    const reason =
      errno !== undefined
        ? errno.code === 'ENOENT'
          ? '`pi` binary not found on PATH'
          : `spawn error: ${errno.message}`
        : `\`pi --version\` exited with status ${probe.status}`;
    throw new Error(
      `RemotePi integration suite requires the \`pi\` binary on PATH — ${reason}.\n` +
        `Install \`@earendil-works/pi-coding-agent\` (e.g. \`npm i -g @earendil-works/pi-coding-agent\`)\n` +
        `or run \`pi --version\` to verify your install. CI intentionally skips this suite\n` +
        `(see ADR-0008 §3); it's meant to be run locally with \`pnpm run test:integration\`.`,
    );
  }
}
