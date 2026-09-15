// Vitest specs for `SessionListEntrySchema` and `SessionListResultSchema` —
// the M4 `session_list.result.data.sessions[]` revalidation surface.
//
// PRD mapping — each `it` block below is numbered to match the M4 PRD
// [[prds/m4-multi-session.md#9.1-shared-vitest-30-条]] §9.1 checklist:
//
//   `session_list.result.data.sessions[]` per-entry shape (cases 1–11):
//     1. entry with `status: 'exited'`        → parses
//     2. entry with `status: 'idle'`         → parses
//     3. entry with `status: 'running'`      → parses
//     4. entry with `status: 'spawning'`     → parses
//     5. entry with `status: 'unknown'`      → parses (the "no manager
//        in map" sentinel — see session-list.ts JSDoc)
//     6. entry with illegal `status`         → REJECT (status is a 5-enum)
//     7. entry carries the full M3 field set (id / name / cwd / created /
//        modified / message_count / first_message / running) → parses
//     8. entry with `running: false` AND `status: 'exited'` → parses
//        (M3 boolean + M4 enum co-exist; boolean is preserved)
//     9. entry missing one of the required M3 fields → REJECT (the M3
//        contract was: all 8 fields are required; the M4 unlock adds
//        `status` alongside, not in place of, the M3 surface)
//    10. `result` envelope replying with `{ ok: true, data: { sessions: [...] } }`
//        → parses (outer envelope) AND the inner revalidation shape
//        accepts the per-entry status field (full round-trip)
//    11. result with an entry whose status is illegal → REVALIDATION
//        rejects (mirrors the get-state.test.ts case 5 pattern)
//
// ## Why this lives in its own file (not session-state.test.ts)
//
// The `session_state.payload` and `session_list.result.data.sessions[]`
// shapes are independent surfaces — the former is the per-session
// lifecycle broadcast and the latter is the per-row metadata snapshot
// the web reads on ChoicePage (level=2). Both share the 5-phase enum
// but neither re-exports the other's schema. Following the M3 module
// split (block-on.ts owns `BlockedOnEntryPayloadSchema`,
// `session-list.ts` owns `SessionListEntrySchema`) keeps each
// revalidation surface in its own focused module — see session-list.ts
// header for the full rationale.
//
// Style: every assertion goes through `schema.safeParse(...)` (for the
// payload-only shape) and `Envelope.safeParse(...)` (for the outer
// envelope), mirroring the M2 envelope.test.ts pattern.

import { describe, expect, it } from 'vitest';
import { Envelope, PROTOCOL_VERSION } from '../envelope.js';
import { SessionListEnvelope, SessionListPayloadSchema, type ResultEnvelope } from '../control.js';
import { SessionListEntrySchema, SessionListResultSchema } from '../session-list.js';

// ----- helpers -----

function parseEnvelope(value: unknown) {
  return Envelope.safeParse(value);
}

function narrow<T extends { type: string; payload: unknown }>(
  data: { type: string; payload: unknown },
  type: T['type'],
): T {
  if (data.type !== type) {
    throw new Error(`expected type ${String(type)}, got ${String(data.type)}`);
  }
  return data as T;
}

/** Build a legal M3-field-set fixture for one `SessionListEntry`. Status
 *  is supplied by the caller so each case can pin its own value. */
function makeEntry(status: 'exited' | 'idle' | 'running' | 'spawning' | 'unknown') {
  return {
    id: 'sess-1',
    name: 'My Session',
    cwd: '/home/user/proj',
    created: '2026-09-01T00:00:00.000Z',
    modified: '2026-09-08T00:00:00.000Z',
    message_count: 42,
    first_message: 'hello world',
    running: status !== 'exited',
    status,
  };
}

describe('SessionListEntry (M4 PRD §9.1 — 5 enum + illegal-status + M3 fields)', () => {
  // ----- 5 enum legal (cases 1–5) -----

  it('1. parses a SessionListEntry with `status: "exited"`', () => {
    const result = SessionListEntrySchema.safeParse(makeEntry('exited'));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe('exited');
    expect(result.data.running).toBe(false);
  });

  it('2. parses a SessionListEntry with `status: "idle"`', () => {
    const result = SessionListEntrySchema.safeParse(makeEntry('idle'));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe('idle');
  });

  it('3. parses a SessionListEntry with `status: "running"`', () => {
    const result = SessionListEntrySchema.safeParse(makeEntry('running'));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe('running');
  });

  it('4. parses a SessionListEntry with `status: "spawning"`', () => {
    const result = SessionListEntrySchema.safeParse(makeEntry('spawning'));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe('spawning');
  });

  it('5. parses a SessionListEntry with `status: "unknown"` ("no manager in map" sentinel)', () => {
    // `unknown` is the deliberate "we don't know" sentinel for sessions
    // that exist on disk but the bridge has never spawned — clicking
    // such a row in `ChoicePage` triggers a fresh spawn through the
    // recovery ritual. The schema must accept it so the bridge can
    // serialise the honest answer rather than coercing to `exited`.
    const result = SessionListEntrySchema.safeParse(makeEntry('unknown'));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe('unknown');
  });

  // ----- illegal status (case 6) -----

  it('6. rejects a SessionListEntry whose `status` is not in the 5-value enum', () => {
    // 5-value enum is lock-versioned — `ready` (M2 phase) is NOT a
    // valid session-list status (the entry-level status is the
    // user-facing surface that maps `ready` away; see session-list.ts
    // JSDoc). Strings that look similar but aren't in the enum must
    // be refused.
    for (const status of ['ready', 'paused', 'disconnected', '', 'EXITED']) {
      const result = SessionListEntrySchema.safeParse(makeEntry(status as never));
      expect(result.success, `status=${JSON.stringify(status)} should be rejected`).toBe(false);
    }
  });

  // ----- M3 field set preservation (case 7) -----

  it('7. carries the full M3 field set (id / name / cwd / created / modified / message_count / first_message / running) + status', () => {
    // The M4 unlock adds `status` to the entry shape but does NOT
    // remove any M3 field. Every legacy consumer that reads `id` /
    // `name` / `cwd` / `created` / `modified` / `message_count` /
    // `first_message` / `running` continues to work; new M4 consumers
    // can additionally read `status`.
    const fixture = makeEntry('running');
    const result = SessionListEntrySchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.id).toBe('sess-1');
    expect(result.data.name).toBe('My Session');
    expect(result.data.cwd).toBe('/home/user/proj');
    expect(result.data.created).toBe('2026-09-01T00:00:00.000Z');
    expect(result.data.modified).toBe('2026-09-08T00:00:00.000Z');
    expect(result.data.message_count).toBe(42);
    expect(result.data.first_message).toBe('hello world');
    expect(result.data.running).toBe(true);
    expect(result.data.status).toBe('running');
  });

  // ----- running boolean + status enum coexistence (case 8) -----

  it('8. accepts an entry with `running: false` AND `status: "exited"` (M3 boolean + M4 enum co-exist)', () => {
    // The M4 unlock deliberately preserves the M3 `running` boolean
    // alongside the new `status` field — `running === true` is roughly
    // equivalent to `status ∈ { 'idle', 'running', 'spawning', 'ready' }`
    // but does NOT capture the phase detail that `status` carries.
    // Both fields round-trip together.
    const result = SessionListEntrySchema.safeParse(makeEntry('exited'));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.running).toBe(false);
    expect(result.data.status).toBe('exited');
  });

  // ----- missing M3 field (case 9) -----

  it('9. rejects a SessionListEntry missing one of the required M3 fields', () => {
    // The M3 contract was that all 8 fields are required; the M4
    // unlock adds `status` alongside, not in place of, the M3 surface.
    // Sweep every required field by deleting it from the fixture and
    // confirming the schema refuses.
    const required = [
      'id',
      'name',
      'cwd',
      'created',
      'modified',
      'message_count',
      'first_message',
      'running',
      'status',
    ] as const;

    for (const field of required) {
      const fixture = { ...makeEntry('running') } as Record<string, unknown>;
      delete fixture[field];
      const result = SessionListEntrySchema.safeParse(fixture);
      expect(result.success, `entry without \`${field}\` should be rejected`).toBe(false);
    }

    // Nullable-contract pin — `name` and `first_message` are typed
    // `z.string().nullable()` so a literal `null` value is legal (pi
    // may not have assigned a name / written a first message yet —
    // see `session-list.ts` JSDoc). Missing (undefined) fields remain
    // rejected under the existing required-field contract above; this
    // pins the distinct null-OK / undefined-fail leg of the nullable
    // contract so a future tightening (e.g. switching to
    // `z.string()`) surfaces as a deliberate schema change rather
    // than silent drift.
    const withNullName = { ...makeEntry('running'), name: null };
    expect(
      SessionListEntrySchema.safeParse(withNullName).success,
      '`name: null` must parse (nullable contract)',
    ).toBe(true);

    const withNullFirstMessage = { ...makeEntry('running'), first_message: null };
    expect(
      SessionListEntrySchema.safeParse(withNullFirstMessage).success,
      '`first_message: null` must parse (nullable contract)',
    ).toBe(true);
  });
});

describe('SessionListResult + envelope round-trip (M4 PRD §9.1 — 2 cases)', () => {
  // ----- full envelope + inner revalidation (case 10) -----

  it('10. parses a `result` envelope replying `{ ok: true, data: { sessions: [...] } }` with the new `status` field', () => {
    // The outer envelope parses because `ResultPayloadSchema.data` is
    // `z.unknown()` — the web narrows on `reply_to` and revalidates
    // `data` against `SessionListResultSchema` before reading
    // entries. This case proves the full round-trip: outer envelope +
    // inner schema + per-entry `status` field all line up.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'sl-010',
      reply_to: 'sl-req-010',
      payload: {
        ok: true,
        data: {
          sessions: [
            makeEntry('running'),
            makeEntry('idle'),
            makeEntry('exited'),
            makeEntry('unknown'),
          ],
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<ResultEnvelope>(result.data, 'result');
    expect(env.reply_to).toBe('sl-req-010');
    expect(env.payload.ok).toBe(true);

    // Inner revalidation succeeds — every entry's status field is legal.
    const inner = SessionListResultSchema.safeParse(env.payload.data);
    expect(inner.success).toBe(true);
    if (inner.success) {
      expect(inner.data.sessions).toHaveLength(4);
      expect(inner.data.sessions[0]?.status).toBe('running');
      expect(inner.data.sessions[1]?.status).toBe('idle');
      expect(inner.data.sessions[2]?.status).toBe('exited');
      expect(inner.data.sessions[3]?.status).toBe('unknown');
    }
  });

  // ----- illegal status → revalidation rejects (case 11) -----

  it('11. rejects a `result` envelope whose `data.sessions[]` contains an illegal `status`', () => {
    // Outer envelope parses (data is `z.unknown()`). Inner
    // revalidation fires on the illegal status — the per-entry
    // schema's enum guard is the gate that refuses the frame before
    // the web reads any field. Mirrors the get-state.test.ts case 5
    // pattern.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'sl-011',
      reply_to: 'sl-req-011',
      payload: {
        ok: true,
        data: {
          sessions: [makeEntry('paused' as never)],
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<ResultEnvelope>(result.data, 'result');
    // Outer payload.data is preserved verbatim — no schema coercion.
    expect(env.payload.data).toEqual({
      sessions: [makeEntry('paused' as never)],
    });

    // Inner revalidation fails on the illegal `status` enum value.
    const inner = SessionListResultSchema.safeParse(env.payload.data);
    expect(inner.success).toBe(false);
  });
});

// Sanity sweep — all 5 enum values parse at the entry level. Mirrors the
// `M2 envelope.test.ts` "Enum literals ↔ payload schemas" sanity block.
describe('SessionListEntry (sanity sweep)', () => {
  it('every legal status parses through SessionListEntrySchema', () => {
    for (const status of ['exited', 'idle', 'running', 'spawning', 'unknown'] as const) {
      const result = SessionListEntrySchema.safeParse(makeEntry(status));
      expect(result.success, `status=${status} should parse`).toBe(true);
    }
  });

  it('accepts a SessionListResult with an empty `sessions: []`', () => {
    // A user with no saved sessions is a legitimate edge case (e.g.
    // fresh install before any spawn). The schema must accept `[]`.
    const result = SessionListResultSchema.safeParse({ sessions: [] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sessions).toEqual([]);
  });

  it('rejects a SessionListResult missing `sessions`', () => {
    const result = SessionListResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ----- M4 envelope (a) extension: `session_list.payload.work_dir?` (3 cases) -----
//
// ADR-0010 §决策.2 adds `work_dir?` to `session_list.payload` as an
// additive optional field. M4 操作惯例必带 (the web ChoicePage always
// sets it) but the schema remains optional for M3 compatibility
// ("scan all directories" path). The schema is intentionally additive-
// only — no lock bump.

describe('SessionList envelope work_dir (M4 envelope (a) extension — 3 cases)', () => {
  it('A. accepts a `session_list` envelope that omits `work_dir` (M3 compatibility — scan all directories)', () => {
    // M3 single-session mode never set `work_dir`. Absence is the
    // "scan all directories" form under envelope evolution rule (a)
    // and must parse through both the envelope and the payload
    // schema.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_list',
      id: 'sl-payload-A',
      payload: {},
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<SessionListEnvelope>(result.data, 'session_list');
    expect(env.type).toBe('session_list');
    expect(env.payload.work_dir).toBeUndefined();

    expect(SessionListPayloadSchema.safeParse({}).success).toBe(true);
  });

  it('B. accepts a `session_list` envelope with explicit `work_dir` (M4 操作惯例必带)', () => {
    // M4 ChoicePage (任务 07) always sets `work_dir` so the bridge can
    // scope the session scan to one directory. Presence must round-trip
    // verbatim — no normalisation, no stripping.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_list',
      id: 'sl-payload-B',
      payload: { work_dir: '/home/user/proj' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<SessionListEnvelope>(result.data, 'session_list');
    expect(env.payload.work_dir).toBe('/home/user/proj');

    expect(SessionListPayloadSchema.safeParse({ work_dir: '/home/user/proj' }).success).toBe(true);
  });

  it('C. rejects a `session_list` envelope whose `work_dir` is not a string', () => {
    // Optional but typed — non-string values trip the type guard. The
    // bare `{}` payload parses fine; a non-string `work_dir` does not.
    for (const work_dir of [42, true, { absolute: true }, null]) {
      const result = SessionListPayloadSchema.safeParse({ work_dir });
      expect(result.success, `work_dir=${JSON.stringify(work_dir)} should be rejected`).toBe(false);
    }
  });
});
