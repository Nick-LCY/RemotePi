// Vitest specs for `SessionStatePayloadSchema` — the bridge-broadcast
// envelope payload carrying the pi subprocess lifecycle phase + the
// optional `blocked_on` queue of pending extension UI requests.
//
// PRD mapping — each `it` block is numbered to match the M3 PRD
// [[prds/m3-single-session.md#6.1-sharedvitest]] §6.1 checklist:
//
//   5 phases legal (cases 1–5):
//     1. spawning
//     2. ready
//     3. running
//     4. idle
//     5. exited
//
//   `blocked_on` shape (cases 6–11):
//     6. `blocked_on` omitted      → passes (default = empty array per
//        envelope evolution rule (a); see SessionStatePayloadSchema JSDoc)
//     7. `blocked_on: []`          → passes (explicit empty)
//     8. `blocked_on` contains all 4 blocking methods (sweep) → passes
//     9. `blocked_on` element missing `id` → reject (correlation key
//        required — see block-on.test.ts case 9 for the per-method detail)
//    10. `blocked_on` contains a fire-and-forget method → reject
//        (notify / setStatus / setWidget / setTitle / set_editor_text
//        are digested locally and must never enter the queue)
//    11. `phase` is not in SESSION_PHASES (illegal enum) → reject
//
// Style: every assertion goes through `Envelope.safeParse(...)` (for the
// envelope-level cases) and `SessionStatePayloadSchema.safeParse(...)` (for
// the per-payload spot checks). Mirrors the M2 envelope.test.ts pattern.

import { describe, expect, it } from 'vitest';
import { BLOCK_ON_METHODS, BlockedOnEntryPayloadSchema } from '../block-on.js';
import { SessionStatePayloadSchema } from '../control.js';
import { Envelope, PROTOCOL_VERSION, SESSION_PHASES } from '../envelope.js';
import type { SessionStateEnvelope } from '../control.js';

// ----- helpers -----

function parseEnvelope(value: unknown) {
  return Envelope.safeParse(value);
}

function narrow<T extends { type: string; kind: string; payload: unknown }>(
  data: { type: string; kind: string; payload: unknown },
  type: T['type'],
): T {
  if (data.type !== type) {
    throw new Error(`expected type ${String(type)}, got ${String(data.type)}`);
  }
  return data as T;
}

describe('SessionState envelopes (M3 PRD §6.1 — 11 cases)', () => {
  // ----- 5 phases legal (cases 1–5) -----

  it('1. parses a legal `session_state` envelope with phase `spawning`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-001',
      payload: { phase: 'spawning' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<SessionStateEnvelope>(result.data, 'session_state');
    expect(env.payload.phase).toBe('spawning');
    expect(env.payload.blocked_on).toBeUndefined();
  });

  it('2. parses a legal `session_state` envelope with phase `ready`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-002',
      payload: { phase: 'ready' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<SessionStateEnvelope>(result.data, 'session_state');
    expect(env.payload.phase).toBe('ready');
  });

  it('3. parses a legal `session_state` envelope with phase `running`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-003',
      payload: { phase: 'running' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<SessionStateEnvelope>(result.data, 'session_state');
    expect(env.payload.phase).toBe('running');
  });

  it('4. parses a legal `session_state` envelope with phase `idle`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-004',
      payload: { phase: 'idle' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<SessionStateEnvelope>(result.data, 'session_state');
    expect(env.payload.phase).toBe('idle');
  });

  it('5. parses a legal `session_state` envelope with phase `exited`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-005',
      payload: { phase: 'exited' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<SessionStateEnvelope>(result.data, 'session_state');
    expect(env.payload.phase).toBe('exited');
  });

  // ----- blocked_on shape (cases 6–11) -----

  it('6. accepts a `session_state` envelope that omits `blocked_on` (default empty)', () => {
    // Envelope evolution rule (a) — absence is equivalent to an empty
    // array. The bridge always sends `blocked_on: []` in practice,
    // but a state frame with no field at all must still parse (older
    // broadcasts, or future phases where blocked_on is meaningless
    // e.g. spawning).
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-006',
      payload: { phase: 'ready' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<SessionStateEnvelope>(result.data, 'session_state');
    expect(env.payload.blocked_on).toBeUndefined();

    expect(SessionStatePayloadSchema.safeParse({ phase: 'ready' }).success).toBe(true);
  });

  it('7. accepts a `session_state` envelope with an explicit empty `blocked_on: []`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-007',
      payload: { phase: 'running', blocked_on: [] },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<SessionStateEnvelope>(result.data, 'session_state');
    expect(env.payload.blocked_on).toEqual([]);
  });

  it('8. accepts a `session_state` envelope whose `blocked_on` covers all 4 blocking methods', () => {
    // Pin the on-the-wire shape with one entry per blocking method.
    // Each entry must satisfy the discriminated union member that
    // matches its `method` literal. The 4 methods are exercised
    // end-to-end through the envelope parse + a per-element schema
    // spot check.
    const blocked_on = [
      {
        method: 'select' as const,
        id: 'b1',
        title: 'Pick',
        options: ['a', 'b'],
      },
      {
        method: 'confirm' as const,
        id: 'b2',
        title: 'Continue?',
        message: 'Are you sure?',
      },
      { method: 'input' as const, id: 'b3', title: 'Name' },
      { method: 'editor' as const, id: 'b4', title: 'Edit', prefill: 'hi' },
    ];

    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-008',
      payload: { phase: 'running', blocked_on },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<SessionStateEnvelope>(result.data, 'session_state');
    expect(env.payload.blocked_on).toHaveLength(4);

    // Schema-level spot check — every entry also parses in isolation.
    for (const entry of blocked_on) {
      expect(BlockedOnEntryPayloadSchema.safeParse(entry).success).toBe(true);
    }
    // And every method in BLOCK_ON_METHODS is represented at least once.
    const methods = new Set(blocked_on.map((e) => e.method));
    for (const method of BLOCK_ON_METHODS) {
      expect(methods.has(method), `method=${method} missing from sweep`).toBe(true);
    }
  });

  it('9. rejects a `session_state` envelope whose `blocked_on` element is missing `id`', () => {
    // Correlation key is required per element — see block-on.test.ts
    // case 9. A single missing-id entry poisons the whole array.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-009',
      payload: {
        phase: 'running',
        blocked_on: [
          { method: 'select', title: 'Pick', options: ['a'] }, // no id
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it('10. rejects a `session_state` envelope whose `blocked_on` contains a fire-and-forget method', () => {
    // The 4-method discriminated union refuses any non-union `method`
    // discriminator. Pick `notify` here — same outcome for the other
    // 4 (sweep covered by block-on.test.ts case 10).
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-010',
      payload: {
        phase: 'running',
        blocked_on: [{ method: 'notify', id: 'ff-1', title: 'should-not-enter-queue' }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('11. rejects a `session_state` envelope with an illegal `phase` value', () => {
    // 5-phase enum is lock-versioned — `foo` is outside SESSION_PHASES.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-011',
      payload: { phase: 'foo' },
    });
    expect(result.success).toBe(false);

    expect(SessionStatePayloadSchema.safeParse({ phase: 'foo' }).success).toBe(false);
  });
});

// ----- M4 envelope (a) extension: `payload.work_dir?` (cases 12–14) -----
//
// ADR-0010 §决策.2 adds `work_dir?` to `session_state.payload` as an
// additive optional field — every broadcast carries its session's
// work_dir so the web ChoicePage (任务 07) can render work_dir per row
// without an extra `session_list` query. Absence is legal (M3 single-
// session mode never set it; M4 broadcasts that have not yet learned a
// work_dir are still honoured). Presence must round-trip verbatim.
//
// The schema is intentionally additive-only — no lock bump.

describe('SessionState envelopes (M4 work_dir envelope (a) extension — 3 cases)', () => {
  it('12. accepts a `session_state` envelope that omits `work_dir` (M3 compatibility)', () => {
    // M3 single-session mode never set `work_dir`. Absence is the
    // "default empty" form under envelope evolution rule (a) and must
    // parse through both the envelope and the payload schema.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-012',
      payload: { phase: 'ready' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<SessionStateEnvelope>(result.data, 'session_state');
    expect(env.payload.phase).toBe('ready');
    expect(env.payload.work_dir).toBeUndefined();

    expect(SessionStatePayloadSchema.safeParse({ phase: 'ready' }).success).toBe(true);
  });

  it('13. accepts a `session_state` envelope with explicit `work_dir` (M4 multi-session mode)', () => {
    // M4 broadcasts always carry their session's work_dir so the web
    // `ChoicePage level=2` can render work_dir per row without an
    // extra `session_list` query. Presence must round-trip verbatim.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-013',
      payload: { phase: 'running', work_dir: '/home/user/proj' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<SessionStateEnvelope>(result.data, 'session_state');
    expect(env.payload.phase).toBe('running');
    expect(env.payload.work_dir).toBe('/home/user/proj');

    expect(
      SessionStatePayloadSchema.safeParse({
        phase: 'running',
        work_dir: '/home/user/proj',
      }).success,
    ).toBe(true);
  });

  it('14. rejects a `session_state` envelope whose `work_dir` is not a string', () => {
    // Optional but typed — non-string values trip the type guard. The
    // `phase` field is also required (existing behaviour), so a bare
    // `{ phase: 'ready', work_dir: <bad> }` must be refused.
    for (const work_dir of [42, true, { absolute: true }, null]) {
      const result = SessionStatePayloadSchema.safeParse({
        phase: 'ready',
        work_dir,
      });
      expect(result.success, `work_dir=${JSON.stringify(work_dir)} should be rejected`).toBe(false);
    }
  });
});

// Sanity sweep: every legal SESSION_PHASE parses through the full envelope
// + schema levels. Mirrors the M2 envelope.test.ts enum-literal guard.
describe('SessionState envelopes (sanity sweep)', () => {
  it('every SESSION_PHASE parses through SessionStatePayloadSchema and the full Envelope', () => {
    for (const phase of SESSION_PHASES) {
      // Schema-level
      expect(SessionStatePayloadSchema.safeParse({ phase }).success).toBe(true);

      // Envelope-level — round-trips through `Envelope.safeParse` so the
      // ControlBranch discriminated union is exercised too.
      const result = parseEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'session_state',
        id: `ss-sweep-${phase}`,
        payload: { phase },
      });
      expect(result.success, `phase=${phase} envelope should parse`).toBe(true);
    }
  });
});
