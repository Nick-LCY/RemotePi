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
import {
  BLOCK_ON_METHODS,
  BlockedOnEntryPayloadSchema,
} from '../block-on.js';
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
    // Envelope evolution rule (a) — absence is equivalent to an empty array.
    // The bridge always sends `blocked_on: []` in practice, but a state
    // frame with no field at all must still parse (older broadcasts, or
    // future phases where blocked_on is meaningless e.g. spawning).
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

    // Schema-level spot check — same outcome.
    expect(SessionStatePayloadSchema.safeParse({ phase: 'ready' }).success).toBe(
      true,
    );
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
    // Pin the on-the-wire shape with one entry per blocking method. Each
    // entry must satisfy the discriminated union member that matches its
    // `method` literal. The 4 methods are exercised end-to-end through
    // the envelope parse + a per-element schema spot check.
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
      expect(methods.has(method), `method=${method} missing from sweep`).toBe(
        true,
      );
    }
  });

  it('9. rejects a `session_state` envelope whose `blocked_on` element is missing `id`', () => {
    // Correlation key is required per element — see block-on.test.ts case 9.
    // A single missing-id entry poisons the whole array.
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
    // discriminator. Pick `notify` here — same outcome for the other 4
    // (sweep covered by block-on.test.ts case 10).
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 'ss-010',
      payload: {
        phase: 'running',
        blocked_on: [
          { method: 'notify', id: 'ff-1', title: 'should-not-enter-queue' },
        ],
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

    // Schema-level spot check — same outcome.
    expect(SessionStatePayloadSchema.safeParse({ phase: 'foo' }).success).toBe(
      false,
    );
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
