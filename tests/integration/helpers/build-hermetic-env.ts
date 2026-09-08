// Helper: build a hermetic env object for spawning the bridge's pi
// child (integration tests) or the bridge itself (E2E harness).
//
// `buildHermeticEnv({ agentDir, baseEnv })` strips the
// `PROVIDER_KEY_ENV_VARS` keys from the supplied base env and injects
// the test-fixture hooks `PI_CODING_AGENT_DIR` + `PI_OFFLINE=1` so pi
// can never reach a real provider even when the host shell has e.g.
// `ANTHROPIC_API_KEY` set. Shared between `tests/integration/` (where
// the helper was first extracted) and `tests/e2e/` (where the harness
// spawns a real bridge subprocess). See ADR-0008 §2.6 for the
// hermeticity defense layers; this function is **layer 1 only** —
// layers 2 + 3 live in `make-fixture.ts` and `fake-llm-server.ts`
// respectively.
//
// Defense layers (intentional redundancy — don't simplify):
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

/** Provider-specific env var keys we strip from the inherited env.
 *
 *  pi's `auth.js getAuth` falls back to `process.env.<PROVIDER>_API_KEY`
 *  (or AWS / ADC vars for Bedrock / Vertex) if `auth.json` is missing
 *  for that provider, so leaving a real provider key in the env would
 *  let pi bypass our fake and route to a real provider.
 *
 *  Originally four entries; expanded to eleven per integration-test
 *  review 2026-09-08. Future additions belong here too — every other
 *  helper that builds a pi-spawn env (E2E harness, future ad-hoc
 *  scripts) imports this list so the layers stay in sync. */
export const PROVIDER_KEY_ENV_VARS = [
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

export interface BuildHermeticEnvOptions {
  /** Pi agent directory. Pinned via `PI_CODING_AGENT_DIR` so pi's
   *  sessions / auth.json resolve to the fixture (the integration
   *  suite always supplies a per-run tmp path; the E2E harness
   *  supplies the same). */
  agentDir: string;
  /** The starting env to copy + sanitize. Defaults to `process.env`
   *  but callers may override (e.g. tests that want to inject
   *  fixtures without depending on host shell state). */
  baseEnv?: NodeJS.ProcessEnv;
}

/** Build a sanitized env object suitable for spawning `pi` (or the
 *  bridge that will spawn `pi`). The returned object is a plain
 *  `NodeJS.ProcessEnv` — callers can pass it straight to
 *  `child_process.spawn`'s `env` option or use it as the
 *  `PiProcessOptions.baseEnv` override. */
export function buildHermeticEnv(opts: BuildHermeticEnvOptions): NodeJS.ProcessEnv {
  const base = opts.baseEnv ?? process.env;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if ((PROVIDER_KEY_ENV_VARS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  // Pin pi's agent dir to the test fixture. Without this, pi falls
  // back to the operator's `~/.pi/agent` and reads its real models.json
  // (which has real provider credentials) — defeating the hermetic
  // fixture. Note: the production bridge deliberately does NOT inject
  // `PI_CODING_AGENT_DIR` (decision 2026-09-05: bridge reuses the
  // host's pi agent dir), but the integration suite is a different
  // concern — it needs pi to look ONLY at the fixture.
  out['PI_CODING_AGENT_DIR'] = opts.agentDir;
  // PI_OFFLINE=1 disables version check / telemetry / model catalogue
  // refresh (see ADR-0008 §1 环境变量三件套) so pi never reaches the
  // network for housekeeping during a fixture run.
  out['PI_OFFLINE'] = '1';
  return out;
}
