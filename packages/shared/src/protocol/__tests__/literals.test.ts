// Vitest specs for the M4-unlock updates to `CONTROL_TYPES` — the
// lock-versioned enum of every legal control-family `type` value.
//
// PRD mapping — each `it` block below is numbered to match the M4 PRD
// [[prds/m4-multi-session.md#9.1-shared-vitest-30-条]] §9.1 checklist:
//
//   CONTROL_TYPES literal (cases 1–4):
//     1. CONTROL_TYPES has exactly 13 entries (M2 8 → M3 9 → M4 13)
//     2. CONTROL_TYPES preserves the M3 9-entry baseline (none dropped
//        or renamed by the M4 unlock)
//     3. CONTROL_TYPES includes the 4 new M4 work-directory types
//        (list_directories / work_dir_list / work_dir_add / work_dir_remove)
//     4. CONTROL_TYPES contains no duplicate entries (each literal appears
//        exactly once — guards against accidental insertion of an
//        existing name during future unlocks)
//
// ## Background
//
// `CONTROL_TYPES` lives in [[protocol/literals.ts]] and is the single
// source of truth for every legal control `type` value. The M4 unlock
// appended four new work-directory / directory-browsing types
// (ADR-0010 `§决策.1` — control 9 → 13 type). The cases below pin the
// resulting literal surface so a future unlock that drops or renames a
// name shows up as a literal-shape failure, not as a silent contract
// drift that only manifests at parse time.
//
// Style: assertions inspect the exported `CONTROL_TYPES` array directly.
// We deliberately avoid schema-level sweeps (those live in
// `envelope.test.ts` cases 12 / 13) — this file pins the literal
// surface only.

import { describe, expect, it } from 'vitest';
import { CONTROL_TYPES } from '../literals.js';

describe('CONTROL_TYPES (M4 PRD §9.1 — 4 cases)', () => {
  it('1. CONTROL_TYPES has exactly 13 entries (M2 8 + M3 1 + M4 4)', () => {
    // History (literals.ts JSDoc):
    //   M2 lock: 8 types
    //   M3 unlock: +1 (`get_state`) → 9
    //   M4 unlock: +4 (list_directories, work_dir_list, work_dir_add,
    //     work_dir_remove) → 13
    // Any future unlock MUST bump this test alongside the literal — the
    // test is intentionally hard-coded to 13 so a stale literal cannot
    // quietly drift.
    expect(CONTROL_TYPES).toHaveLength(13);
  });

  it('2. CONTROL_TYPES preserves the M3 9-entry baseline (none dropped or renamed by the M4 unlock)', () => {
    // The M4 unlock is purely additive — every M3 type name must still
    // be present, in the same casing. This case guards the additive-only
    // commitment: a future unlock that accidentally renames or removes
    // an M3 type shows up as a literal-membership failure here.
    const m3Baseline = [
      'handshake',
      'ping',
      'pong',
      'bridge_status',
      'session_state',
      'session_list',
      'get_state',
      'result',
      'error',
    ];
    for (const name of m3Baseline) {
      expect(
        CONTROL_TYPES.includes(name as (typeof CONTROL_TYPES)[number]),
        `M3 type \`${name}\` must still be present after the M4 unlock`,
      ).toBe(true);
    }
  });

  it('3. CONTROL_TYPES includes the 4 new M4 work-directory / directory-browsing types', () => {
    // The M4 unlock added exactly these four names (ADR-0010 `§决策.1`).
    // Each must be present in the literal so `ControlBranch` will accept
    // matching envelopes (the envelope schemas derive their `type` from
    // `z.literal(...)` matches against `CONTROL_TYPES` indirectly via
    // the discriminated-union membership).
    const m4Additions = ['list_directories', 'work_dir_list', 'work_dir_add', 'work_dir_remove'];
    for (const name of m4Additions) {
      expect(
        CONTROL_TYPES.includes(name as (typeof CONTROL_TYPES)[number]),
        `M4 type \`${name}\` must be present in CONTROL_TYPES`,
      ).toBe(true);
    }
  });

  it('4. CONTROL_TYPES contains no duplicate entries (each literal appears exactly once)', () => {
    // Duplicate literals would silently shadow each other in any
    // `Array.includes` check without breaking the parse path — a typo
    // like `work_dir_remove` appearing twice would be invisible in
    // `envelope.test.ts` case 12 because both copies are valid M4 names.
    // Pin the invariant explicitly.
    const seen = new Set<string>();
    for (const name of CONTROL_TYPES) {
      expect(
        seen.has(name),
        `duplicate literal entry: \`${name}\` appears more than once in CONTROL_TYPES`,
      ).toBe(false);
      seen.add(name);
    }
    // And the dedup'd length must equal the total length (sanity belt
    // alongside the per-iteration check above).
    expect(new Set(CONTROL_TYPES).size).toBe(CONTROL_TYPES.length);
  });
});

// Sanity sweep — every CONTROL_TYPES entry is a non-empty string (guards
// against accidental insertion of an empty literal or a non-string entry).
describe('CONTROL_TYPES (sanity sweep)', () => {
  it('every CONTROL_TYPES entry is a non-empty lowercase string', () => {
    for (const name of CONTROL_TYPES) {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
      // Protocol naming convention: snake_case (ADR-0006 + ADR-0010).
      expect(name, `\`${name}\` should be lowercase`).toMatch(/^[a-z_]+$/);
    }
  });
});
