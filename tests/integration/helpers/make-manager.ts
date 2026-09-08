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

import { spawnSync } from 'node:child_process';
import { Envelope, PROTOCOL_VERSION, type Envelope as EnvelopeT } from '@remotepi/shared';
import { PiProcessManager, type PiProcessOptions } from '@remotepi/bridge/pi-process.js';

// Provider-specific env var keys we strip from the inherited env.
// pi's `auth.js getAuth` falls back to `process.env.<PROVIDER>_API_KEY`
// (or AWS / ADC vars for Bedrock / Vertex) if `auth.json` is missing
// for that provider, so leaving a real provider key in the env would
// let pi bypass our fake and route to a real provider.
//
// ## Defense layers (intentional redundancy — don't simplify)
//
// This list is **layer 1 only** — it covers the realistic host-leak
// candidates (Anthropic / OpenAI / Gemini / Google + the most common
// "poly-provider" keys a developer is likely to have set, plus Bedrock
// IAM vars + Vertex ADC). It's NOT exhaustive: pi-ai has 30+
// `envApiKeyAuth`-wired providers with one env var each, and we
// cannot enumerate all of them here without forking the SDK.
//
// The **load-bearing guarantees** are downstream of this list:
//
//   - Layer 2: `makeAgentDir` writes `settings.json` with
//     `defaultProvider: 'fake-anthropic'`, so the resolved provider
//     is hermetic even if some other env var sneaks through.
//   - Layer 3: the fake-llm-server's `fake-claude-*` model-name
//     fail-fast guard rejects any request that would have leaked
//     to a real model (500 with a descriptive error).
//
// Together (1)+(2)+(3) make the fixture safe even when this list
// misses a provider. Layer 1 keeps the most common cases from
// even hitting the network for ambient auth resolution.
const PROVIDER_KEY_ENV_VARS = [
  // Layer 1: the realistic host-leak candidates (originally four;
  // expanded per integration-test review 2026-09-08).
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  // Multi-provider aggregators developers frequently have set.
  'OPENROUTER_API_KEY',
  // European / secondary providers with `envApiKeyAuth`-wired env vars.
  'MISTRAL_API_KEY',
  // Azure OpenAI.
  'AZURE_OPENAI_API_KEY',
  // Amazon Bedrock (IAM-based; the SDK reads these via the AWS
  // standard chain — without stripping, an AWS-profiled host
  // would silently route to Bedrock).
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  // Google Vertex (Application Default Credentials file path).
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

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

  // Strip provider-specific API keys from the host env so the bridge
  // fixture is hermetic against accidental host bleed. `PATH` is kept
  // because the spawn relies on `pi` being on PATH (we invoke `pi`
  // without an absolute path).
  const baseEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if ((PROVIDER_KEY_ENV_VARS as readonly string[]).includes(k)) continue;
    baseEnv[k] = v;
  }
  // Pin pi's agent dir to the test fixture. Without this, pi falls
  // back to the operator's `~/.pi/agent` and reads its real models.json
  // (which has real provider credentials) — defeating the hermetic
  // fixture. Note: the production bridge deliberately does NOT inject
  // `PI_CODING_AGENT_DIR` (decision 2026-09-05: bridge reuses the
  // host's pi agent dir), but the integration suite is a different
  // concern — it needs pi to look ONLY at the fixture.
  baseEnv['PI_CODING_AGENT_DIR'] = opts.agentDir;
  // PI_OFFLINE=1 disables version check / telemetry / model catalogue
  // refresh (see ADR-0008 §1 环境变量三件套) so pi never reaches the
  // network for housekeeping during a fixture run.
  baseEnv['PI_OFFLINE'] = '1';

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
