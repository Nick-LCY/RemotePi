// Vitest specs for `control/get_state` (request + reply envelope) and the
// M3 `result.data.{phase, blocked_on?}` revalidation contract.
//
// PRD mapping — each `it` block is numbered to match the M3 PRD
// [[prds/m3-single-session.md#6.1-sharedvitest]] §6.1 checklist:
//
//   `get_state` request + reply envelopes (cases 1–9):
//     1. `get_state` request envelope with empty payload  → parses
//     2. `result` envelope replying `{ ok: true, data: { phase: 'ready' } }`
//        → parses (the web-end of the bridge handshake uses this exact
//        shape)
//     3. `result.data.blocked_on` omitted                 → ok
//        (default empty per envelope evolution rule (a))
//     4. `result.data.blocked_on` is a populated array     → ok
//     5. `result.data.phase` is illegal (`'foo'`)         → REVALIDATION
//        rejects (outer envelope parses because `data` is `z.unknown()`;
//        the web must revalidate against `SessionStatePayloadSchema`)
//     6. `result.data.blocked_on` contains an illegal method (fire-and-
//        forget `notify`) → REVALIDATION rejects (same revalidation rule)
//     7. `result` envelope with `ok: false` + `error: { code, message }`
//        → parses (uses a legal ERROR_CODE; `error.code` is constrained
//        to the lock-versioned 6-code set)
//     8. `result` envelope with `ok: false` + every legal `error.code`
//        sweep → all parse
//     9. `result` envelope with `ok: false` but no `error` field —
//        passes. `ResultPayloadSchema` declares both `data` and
//        `error` as optional, so `{ ok: false }` is a legal (if
//        diagnostics-less) failure reply. PRD §1.1 + the `Result`
//        envelope JSDoc describe "failed replies carry ok: false +
//        optional error" — the schema matches PRD as written.
//        Tightening (e.g. switching to `z.discriminatedUnion('ok', ...)`
//        to require `error` on the `ok: false` branch) would be a wire
//        breaking change requiring an envelope evolution rule
//        revision; this test asserts actual schema behaviour, which
//        accepts the minimal shape.
//
// Style: every assertion goes through `Envelope.safeParse(...)` for the
// outer envelope parse + `SessionStatePayloadSchema.safeParse(...)` for
// the `data` revalidation (cases 5 / 6). Mirrors the M2 envelope.test.ts
// pattern + the `Envelope.safeParse(...)` + payload-schema spot-check
// pattern already used in the M3 case-by-case envelopes.
import { describe, expect, it } from 'vitest';
import {
  BlockedOnEntryPayloadSchema,
} from '../block-on.js';
import { SessionStatePayloadSchema } from '../control.js';
import { Envelope, ERROR_CODES, PROTOCOL_VERSION } from '../envelope.js';
import type { GetStateEnvelope, ResultEnvelope } from '../control.js';

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

describe('get_state request + result reply (M3 PRD §6.1 — 9 cases)', () => {
  // ----- 1. get_state request (case 1) -----

  it('1. parses a legal `get_state` request envelope with empty payload `{}`', () => {
    // The web → bridge session-state query is a presence-style RPC with
    // no client-supplied parameters. `GetStatePayloadSchema` is
    // `z.object({})` — payload is exactly the empty object today.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'get_state',
      id: 'gs-001',
      payload: {},
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<GetStateEnvelope>(result.data, 'get_state');
    expect(env.kind).toBe('control');
    expect(env.type).toBe('get_state');
    expect(env.payload).toEqual({});
  });

  // ----- 2. result envelope with simple session state (case 2) -----

  it('2. parses a legal `result` envelope replying with `{ ok: true, data: { phase: \"ready\" } }`', () => {
    // This is the canonical reply shape from bridge → web after a
    // `get_state` round-trip; the web-end of the recovery ritual
    // (M3 PRD §4.4) consumes exactly this form.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'gs-002',
      reply_to: 'gs-001',
      payload: { ok: true, data: { phase: 'ready' } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<ResultEnvelope>(result.data, 'result');
    expect(env.type).toBe('result');
    expect(env.reply_to).toBe('gs-001');
    expect(env.payload.ok).toBe(true);
    expect(env.payload.data).toEqual({ phase: 'ready' });

    // The web is responsible for revalidating `data` against
    // SessionStatePayloadSchema — confirm the inner revalidation also
    // succeeds here.
    expect(
      SessionStatePayloadSchema.safeParse(env.payload.data).success,
    ).toBe(true);
  });

  // ----- 3. data.blocked_on omitted (case 3) -----

  it('3. accepts a `result` envelope whose `data.blocked_on` is omitted (default empty)', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'gs-003',
      reply_to: 'gs-001',
      payload: { ok: true, data: { phase: 'ready' } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<ResultEnvelope>(result.data, 'result');

    // Inner revalidation succeeds — `blocked_on` is optional.
    const inner = SessionStatePayloadSchema.safeParse(env.payload.data);
    expect(inner.success).toBe(true);
    if (inner.success) {
      expect(inner.data.blocked_on).toBeUndefined();
    }
  });

  // ----- 4. data.blocked_on is a populated array (case 4) -----

  it('4. accepts a `result` envelope whose `data.blocked_on` is a populated array', () => {
    const blocked_on = [
      { method: 'confirm' as const, id: 'r1', title: 'Continue?', message: '?' },
      { method: 'select' as const, id: 'r2', title: 'Pick', options: ['a', 'b'] },
    ];
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'gs-004',
      reply_to: 'gs-001',
      payload: { ok: true, data: { phase: 'running', blocked_on } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<ResultEnvelope>(result.data, 'result');

    // Inner revalidation succeeds with both elements preserved.
    const inner = SessionStatePayloadSchema.safeParse(env.payload.data);
    expect(inner.success).toBe(true);
    if (inner.success) {
      expect(inner.data.blocked_on).toHaveLength(2);
      expect(inner.data.phase).toBe('running');
    }
  });

  // ----- 5. data.phase illegal (case 5) -----

  it('5. rejects a `result` envelope replying with illegal `data.phase` (string `foo`)', () => {
    // The outer envelope parses (ResultPayloadSchema.data is
    // `z.unknown()`) — the gate that fires is the inner revalidation
    // against SessionStatePayloadSchema. Mirrors the
    // bridge.ts / web.ts contract where the consumer narrows and
    // revalidates the inner shape.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'gs-005',
      reply_to: 'gs-001',
      payload: { ok: true, data: { phase: 'foo' } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<ResultEnvelope>(result.data, 'result');

    // Outer payload.data is preserved verbatim — no schema coercion.
    expect(env.payload.data).toEqual({ phase: 'foo' });

    // Inner revalidation fails because 'foo' is not in SESSION_PHASES.
    const inner = SessionStatePayloadSchema.safeParse(env.payload.data);
    expect(inner.success).toBe(false);
  });

  // ----- 6. data.blocked_on contains illegal method (case 6) -----

  it('6. rejects a `result` envelope whose `data.blocked_on` contains a fire-and-forget method', () => {
    // Same shape as session-state.test.ts case 10 — illegal `method`
    // discriminator poisons the array. The 4-method
    // BlockedOnEntryPayloadSchema refuses `notify` / `setStatus` / etc.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'gs-006',
      reply_to: 'gs-001',
      payload: {
        ok: true,
        data: {
          phase: 'running',
          blocked_on: [
            { method: 'notify', id: 'ff', title: 'should-not-enter-queue' },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<ResultEnvelope>(result.data, 'result');

    // Inner revalidation fails on the illegal `method` discriminator.
    const inner = SessionStatePayloadSchema.safeParse(env.payload.data);
    expect(inner.success).toBe(false);
    // Schema-level spot check — same outcome on the per-element schema.
    expect(
      BlockedOnEntryPayloadSchema.safeParse({
        method: 'notify',
        id: 'ff',
        title: 't',
      }).success,
    ).toBe(false);
  });

  // ----- 7. ok:false with error.code from ERROR_CODES (case 7) -----

  it('7. accepts a `result` envelope with `ok: false` + `error: { code, message }` (one legal code)', () => {
    // `error.code` is constrained to the 6-value lock-versioned
    // ERROR_CODES set — pick `internal` here; the full sweep follows in
    // case 8.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'gs-007',
      reply_to: 'gs-001',
      payload: {
        ok: false,
        error: { code: 'internal', message: 'pi subprocess died' },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<ResultEnvelope>(result.data, 'result');
    expect(env.payload.ok).toBe(false);
    expect(env.payload.error?.code).toBe('internal');
    expect(env.payload.error?.message).toBe('pi subprocess died');
  });

  // ----- 8. every legal error.code parses (case 8) -----

  it('8. accepts a `result` envelope with `ok: false` + every legal `error.code` (sweep)', () => {
    for (const code of ERROR_CODES) {
      const result = parseEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'result',
        id: `gs-008-${code}`,
        reply_to: 'gs-001',
        payload: { ok: false, error: { code, message: `synthetic ${code}` } },
      });
      expect(result.success, `code=${code} should parse`).toBe(true);
      if (result.success) {
        const env = narrow<ResultEnvelope>(result.data, 'result');
        expect(env.payload.error?.code).toBe(code);
      }
    }
  });

  // ----- 9. ok:false but no error (case 9) -----

  it('9. accepts a `result` envelope with `ok: false` but no `error` field (schema matches PRD §1.1 — see header)', () => {
    // `ResultPayloadSchema` declares both `data` and `error` as
    // optional, so `{ ok: false }` parses successfully. PRD §1.1 +
    // the `ResultEnvelope` JSDoc describe "failed replies carry
    // ok: false + optional error" — the permissive schema matches PRD
    // as written. Tightening (e.g. switching to
    // `z.discriminatedUnion('ok', ...)` to require `error` on the
    // `ok: false` branch) would be a wire breaking change requiring
    // an envelope evolution rule revision; this test asserts actual
    // schema behaviour, which accepts the minimal shape.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: 'gs-009',
      reply_to: 'gs-001',
      payload: { ok: false },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<ResultEnvelope>(result.data, 'result');
    expect(env.payload.ok).toBe(false);
    expect(env.payload.error).toBeUndefined();
    expect(env.payload.data).toBeUndefined();
  });
});
