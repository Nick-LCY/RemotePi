// Helper: re-export `buildHermeticEnv` from the integration suite.
//
// The hermeticity-layer-1 logic (strip 11 provider key env vars + pin
// `PI_CODING_AGENT_DIR` + set `PI_OFFLINE=1`) is the SINGLE source of
// truth across `tests/integration/` and `tests/e2e/` — see
// `tests/integration/helpers/build-hermetic-env.ts` for the
// rationale + the 11-key list (expanded per integration-test review
// 2026-09-08 from the original 4).
//
// ADR-0009 §决策 5 designates the integration helper as the canonical
// home for this function; the E2E harness imports it directly. If a
// future refactor moves the helper, update both imports at once —
// the JSDoc on the shared module is the contract.
//
// We deliberately do NOT duplicate the implementation here: drift
// between two copies of an 11-element denylist is the exact failure
// mode (review-扩过一次-漂移-即-bug) this re-export is meant to
// prevent.

export {
  PROVIDER_KEY_ENV_VARS,
  buildHermeticEnv,
  type BuildHermeticEnvOptions,
} from '../../integration/helpers/build-hermetic-env.js';
