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

import { Envelope, PROTOCOL_VERSION, type Envelope as EnvelopeT } from '@remotepi/shared';
import { PiProcessManager, type PiProcessOptions } from '@remotepi/bridge/pi-process.js';

// Provider-specific env var keys we strip from the inherited env.
// pi's `auth.js getAuth` falls back to `process.env.<PROVIDER>_API_KEY`
// if `auth.json` is missing for that provider, so leaving a real
// provider key in the env would let pi bypass our fake. The bridge's
// per-provider fallback list is hard to enumerate without reading
// every provider; the four most common ones cover the realistic
// bleed scenarios (the bridge fixture is hermetic, but host leakage
// would silently route to a real provider).
const PROVIDER_KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
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
  // Inject the hermetic fixture marker so any future code that
  // needs to know it's running under the integration suite can
  // branch on this without a separate config knob. (Not used today;
  // reserved for cross-test debugging hooks.)
  baseEnv['REMOTEPI_INT_FIXTURE'] = '1';
  // Pin pi's agent dir to the test fixture. Without this, pi falls
  // back to the operator's `~/.pi/agent` and reads its real models.json
  // (which has real provider credentials) — defeating the hermetic
  // fixture. Note: the production bridge deliberately does NOT inject
  // `PI_CODING_AGENT_DIR` (decision 2026-09-05: bridge reuses the
  // host's pi agent dir), but the integration suite is a different
  // concern — it needs pi to look ONLY at the fixture.
  baseEnv['PI_CODING_AGENT_DIR'] = opts.agentDir;
  // PI_OFFLINE=1 disables version check / telemetry / model catalogue
  // refresh (see docs/testing.md §2.3) so pi never reaches the
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
