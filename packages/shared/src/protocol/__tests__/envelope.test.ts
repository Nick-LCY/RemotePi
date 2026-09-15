// Vitest specs for the v1 envelope + 5 control-family payload schemas.
//
// 17 cases mapped 1-to-1 against [[prds/m2-tunnel.md#6-测试]] §6. Each `it`
// block is numbered to match the PRD list — keep them in lock-step if the PRD
// ever reorganises.
//
// Cases 18–19 were added during the v1 review to pin the `changed_at`
// precision contract (see `BridgeStatusPayloadSchema` JSDoc). Cases
// 20–25 are the M4 lock-version guard + envelope round-trip sweeps.
//
// Style: every assertion goes through `Envelope.safeParse(...)` and inspects
// `.success`. We avoid `.toThrow(ZodError)` because `.safeParse` gives richer
// error context for failure cases (and a single `expect(...).toBe(true|false)`
// is easier to grep than `.toThrow`).

import { describe, expect, it } from 'vitest';
import {
  BRIDGE_STATUS_REASONS,
  CONTROL_TYPES,
  Envelope,
  ERROR_CODES,
  PROTOCOL_VERSION,
  ROLES,
} from '../envelope.js';
import {
  BridgeStatusPayloadSchema,
  ErrorPayloadSchema,
  HandshakePayloadSchema,
  PingPayloadSchema,
  PongPayloadSchema,
  type BridgeStatusEnvelope,
  type ErrorEnvelope,
  type HandshakeEnvelope,
  type PingEnvelope,
} from '../control.js';

// ----- helpers -----

/** Run `Envelope.parse` on an unknown shape and assert the outcome.
 *  Centralises the parse-then-narrow dance so each case stays focused
 *  on the payload it cares about. */
function parseEnvelope(value: unknown) {
  return Envelope.safeParse(value);
}

/** Narrow `result.data` to a specific envelope variant by its `type`
 *  discriminator. Throws if the parse succeeded but with an unexpected
 *  type — that would mean a test bug (we constructed a frame we thought
 *  was type X but got Y back). */
function narrow<T extends { type: string; payload: unknown }>(
  data: { type: string; payload: unknown },
  type: T['type'],
): T {
  if (data.type !== type) {
    throw new Error(`expected type ${String(type)}, got ${String(data.type)}`);
  }
  return data as T;
}

describe('Envelope (v1 — 17 cases per M2 PRD §6)', () => {
  // ----- handshake (cases 1–4) -----
  it('1. parses a legal handshake envelope and narrows to HandshakeEnvelope', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'handshake',
      id: 'msg-001',
      payload: { role: 'web', token: 't0k' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const handshake = narrow<HandshakeEnvelope>(result.data, 'handshake');
    expect(handshake.kind).toBe('control');
    expect(handshake.type).toBe('handshake');
    expect(handshake.v).toBe(PROTOCOL_VERSION);
    expect(handshake.id).toBe('msg-001');
    expect(handshake.payload.role).toBe('web');
    expect(handshake.payload.token).toBe('t0k');
  });

  it('2. rejects a handshake envelope whose payload omits `role`', () => {
    const result = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'handshake',
      id: 'msg-002',
      payload: { token: 't0k' },
    });
    expect(result.success).toBe(false);

    expect(HandshakePayloadSchema.safeParse({ token: 't0k' }).success).toBe(false);
  });

  it('3. rejects a handshake envelope whose payload `role` is not in the enum', () => {
    // `admin` is intentionally outside the protocol role vocabulary. A wire
    // frame claiming an unsupported role must be refused at the boundary
    // (this is what the worker maps to `error(auth_failed)`).
    const result = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'handshake',
      id: 'msg-003',
      payload: { role: 'admin', token: 't0k' },
    });
    expect(result.success).toBe(false);

    expect(HandshakePayloadSchema.safeParse({ role: 'admin', token: 't0k' }).success).toBe(false);
  });

  it('4. rejects a handshake envelope whose payload omits `token`', () => {
    const result = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'handshake',
      id: 'msg-004',
      payload: { role: 'bridge' },
    });
    expect(result.success).toBe(false);

    expect(HandshakePayloadSchema.safeParse({ role: 'bridge' }).success).toBe(false);

    // `token: ''` is also rejected — `min(1)` forbids empty strings.
    expect(HandshakePayloadSchema.safeParse({ role: 'bridge', token: '' }).success).toBe(false);
  });

  // ----- ping (case 5) -----
  it('5. accepts a ping envelope with or without `nonce` (optional)', () => {
    const withNonce = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'ping',
      id: 'msg-005a',
      payload: { nonce: 'a1b2' },
    });
    expect(withNonce.success).toBe(true);
    if (withNonce.success) {
      const env = narrow<PingEnvelope>(withNonce.data, 'ping');
      expect(env.type).toBe('ping');
      expect(env.payload.nonce).toBe('a1b2');
    }

    const withoutNonce = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'ping',
      id: 'msg-005b',
      payload: {},
    });
    expect(withoutNonce.success).toBe(true);
    if (withoutNonce.success) {
      const env = narrow<PingEnvelope>(withoutNonce.data, 'ping');
      expect(env.payload.nonce).toBeUndefined();
    }

    expect(PingPayloadSchema.safeParse({ nonce: 'a1b2' }).success).toBe(true);
    expect(PingPayloadSchema.safeParse({}).success).toBe(true);
  });

  // ----- pong (case 6) -----
  it('6. rejects a pong envelope whose payload omits the required `nonce`', () => {
    // Pong's `nonce` is mandatory (control.md §3 — the nonce is the
    // pairing key). A pong frame without it must be refused.
    const result = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'pong',
      id: 'msg-006',
      payload: {},
    });
    expect(result.success).toBe(false);

    expect(PongPayloadSchema.safeParse({}).success).toBe(false);
  });

  // ----- bridge_status (cases 7–8) -----
  it('7. accepts a bridge_status envelope for every legal reason', () => {
    for (const reason of BRIDGE_STATUS_REASONS) {
      const result = parseEnvelope({
        v: 1,
        kind: 'control',
        type: 'bridge_status',
        id: `msg-007-${reason}`,
        payload: {
          online: reason !== 'closed' && reason !== 'stale',
          changed_at: '2026-09-05T10:00:00Z',
          reason,
        },
      });
      expect(result.success, `reason=${reason} should parse`).toBe(true);
      if (result.success) {
        const env = narrow<BridgeStatusEnvelope>(result.data, 'bridge_status');
        expect(env.payload.reason).toBe(reason);
      }
    }

    for (const reason of BRIDGE_STATUS_REASONS) {
      expect(
        BridgeStatusPayloadSchema.safeParse({
          online: true,
          changed_at: '2026-09-05T10:00:00Z',
          reason,
        }).success,
      ).toBe(true);
    }
  });

  it('8. rejects a bridge_status envelope with an illegal `reason`', () => {
    const result = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'bridge_status',
      id: 'msg-008',
      payload: {
        online: true,
        changed_at: '2026-09-05T10:00:00Z',
        reason: 'foo',
      },
    });
    expect(result.success).toBe(false);

    expect(
      BridgeStatusPayloadSchema.safeParse({
        online: true,
        changed_at: '2026-09-05T10:00:00Z',
        reason: 'foo',
      }).success,
    ).toBe(false);
  });

  // ----- error (cases 9–10) -----
  it('9. accepts an error envelope for every legal ErrorCode', () => {
    for (const code of ERROR_CODES) {
      const result = parseEnvelope({
        v: 1,
        kind: 'control',
        type: 'error',
        id: `msg-009-${code}`,
        payload: { code, message: 'synthetic error' },
      });
      expect(result.success, `code=${code} should parse`).toBe(true);
      if (result.success) {
        const env = narrow<ErrorEnvelope>(result.data, 'error');
        expect(env.payload.code).toBe(code);
      }
    }

    for (const code of ERROR_CODES) {
      expect(ErrorPayloadSchema.safeParse({ code, message: 'x' }).success).toBe(true);
    }
  });

  it('10. accepts an error envelope whether `terminal` is absent or boolean', () => {
    // `terminal` is optional (control.md §8) — absence must not break parsing.
    const omitted = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'error',
      id: 'msg-010a',
      payload: { code: 'internal', message: 'oops' },
    });
    expect(omitted.success).toBe(true);
    if (omitted.success) {
      const env = narrow<ErrorEnvelope>(omitted.data, 'error');
      expect(env.payload.terminal).toBeUndefined();
    }

    for (const terminal of [true, false]) {
      const result = parseEnvelope({
        v: 1,
        kind: 'control',
        type: 'error',
        id: `msg-010b-${terminal}`,
        payload: { code: 'internal', message: 'oops', terminal },
      });
      expect(result.success, `terminal=${terminal} should parse`).toBe(true);
      if (result.success) {
        const env = narrow<ErrorEnvelope>(result.data, 'error');
        expect(env.payload.terminal).toBe(terminal);
      }
    }
  });

  // ----- envelope-level guards (cases 11–17) -----
  it('11. rejects an envelope whose `v` is not 1 (unsupported_version scenario)', () => {
    const result = parseEnvelope({
      v: 2,
      kind: 'control',
      type: 'handshake',
      id: 'msg-011',
      payload: { role: 'web', token: 't0k' },
    });
    expect(result.success).toBe(false);
  });

  it('12. rejects a control envelope whose `type` is not in CONTROL_TYPES', () => {
    const result = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'unknown_type',
      id: 'msg-012',
      payload: { role: 'web', token: 't0k' },
    });
    expect(result.success).toBe(false);
  });

  it('13. rejects any envelope whose `kind` is `pi` but `type` is a control-family or arbitrary type', () => {
    // From M3 onward `PiBranch` is a real `z.discriminatedUnion('type',
    // [...9 pi schemas...])` — see `pi.ts`. The pi discriminator union
    // only accepts the 9 pi types (`prompt`, `steer`, `follow_up`,
    // `abort`, `get_messages`, `extension_ui_response`,
    // `command_result`, `snapshot`, `event`), so control-family and
    // arbitrary `type` values must be rejected at the boundary.
    for (const type of [...CONTROL_TYPES, 'something_arbitrary']) {
      const result = parseEnvelope({
        v: 1,
        kind: 'pi',
        type,
        id: 'msg-013',
        payload: {},
      });
      expect(result.success, `kind=pi, type=${type} must fail`).toBe(false);
    }

    // Even a payload that is *legal* for the control kind (a real
    // handshake payload) must still be refused when `kind` is `pi`.
    // Proves the rejection happens on the kind / type gate and not on
    // payload semantics.
    const legalControlPayloadWithPiKind = parseEnvelope({
      v: 1,
      kind: 'pi',
      type: 'handshake',
      id: 'msg-013-payload-legit',
      payload: { role: 'web', token: 't' },
    });
    expect(
      legalControlPayloadWithPiKind.success,
      'kind=pi with a legal control payload must still fail (pi branch only accepts the 9 pi types)',
    ).toBe(false);
  });

  it('14. rejects an envelope whose `kind` is neither `control` nor `pi`', () => {
    const result = parseEnvelope({
      v: 1,
      kind: 'mystery',
      type: 'handshake',
      id: 'msg-014',
      payload: { role: 'web', token: 't0k' },
    });
    expect(result.success).toBe(false);
  });

  it('15. rejects an envelope that omits the top-level `id` (min 1)', () => {
    // `id` is the per-message correlation key every handler relies on, so a
    // frame without it cannot be routed and must be rejected at the boundary.
    const missing = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'handshake',
      payload: { role: 'web', token: 't0k' },
    });
    expect(missing.success).toBe(false);

    // `min(1)` also forbids empty strings.
    const empty = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'handshake',
      id: '',
      payload: { role: 'web', token: 't0k' },
    });
    expect(empty.success).toBe(false);
  });

  it('16. accepts an envelope that omits the optional `session`', () => {
    const result = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'handshake',
      id: 'msg-016',
      payload: { role: 'web', token: 't0k' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // `session` is intentionally not populated by any M2 message but
      // stays on the schema surface for v1 lock-version
      // (envelope.md §锁版承诺).
      expect(result.data.session).toBeUndefined();
    }

    // Positive case: when `session` is provided, parsing still succeeds
    // and the value is preserved verbatim. The schema is round-trippable
    // for both fields even though M2 has no emitter that sets them.
    const withSession = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'handshake',
      id: 'msg-016b',
      session: 'sess-x',
      payload: { role: 'web', token: 't0k' },
    });
    expect(withSession.success).toBe(true);
    if (withSession.success) {
      expect(withSession.data.session).toBe('sess-x');
    }
  });

  it('17. accepts an envelope that omits the optional `reply_to`', () => {
    // Only reply-class messages (control `result`; pi `command_result` /
    // `snapshot`) populate `reply_to` — every other M2 message leaves it off.
    const result = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'ping',
      id: 'msg-017',
      payload: { nonce: 'r2' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reply_to).toBeUndefined();
    }

    const withReplyTo = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'ping',
      id: 'msg-017b',
      reply_to: 'msg-006',
      payload: { nonce: 'r2' },
    });
    expect(withReplyTo.success).toBe(true);
    if (withReplyTo.success) {
      expect(withReplyTo.data.reply_to).toBe('msg-006');
    }
  });

  // ----- bridge_status `changed_at` precision (post-PRD additions) -----
  // The M2 PRD §6 lists 17 cases; cases 18 / 19 below were added during
  // the v1 review to pin down the `changed_at` precision contract — see
  // `BridgeStatusPayloadSchema` JSDoc.

  it('18. accepts a bridge_status envelope whose `changed_at` has millisecond precision (toISOString format)', () => {
    // `new Date().toISOString()` always emits `.123Z`-style timestamps
    // with three fractional digits. The schema must accept that or
    // every bridge status emitted by JS runtimes would be refused at
    // the boundary.
    const result = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'bridge_status',
      id: 'msg-018',
      payload: {
        online: true,
        changed_at: '2026-09-05T10:00:00.123Z',
        reason: 'connected',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const env = narrow<BridgeStatusEnvelope>(result.data, 'bridge_status');
      expect(env.payload.changed_at).toBe('2026-09-05T10:00:00.123Z');
    }

    expect(
      BridgeStatusPayloadSchema.safeParse({
        online: true,
        changed_at: '2026-09-05T10:00:00.123Z',
        reason: 'connected',
      }).success,
    ).toBe(true);
  });

  it('19. accepts a bridge_status envelope whose `changed_at` is second-precision (no fractional part)', () => {
    // Tests, SDKs and humans frequently emit second-precision ISO strings
    // without the `.000` suffix. The schema must accept those too —
    // both precisions are legal under `datetime({ precision: null })`.
    const result = parseEnvelope({
      v: 1,
      kind: 'control',
      type: 'bridge_status',
      id: 'msg-019',
      payload: {
        online: true,
        changed_at: '2026-09-05T10:00:00Z',
        reason: 'connected',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const env = narrow<BridgeStatusEnvelope>(result.data, 'bridge_status');
      expect(env.payload.changed_at).toBe('2026-09-05T10:00:00Z');
    }

    expect(
      BridgeStatusPayloadSchema.safeParse({
        online: true,
        changed_at: '2026-09-05T10:00:00Z',
        reason: 'connected',
      }).success,
    ).toBe(true);
  });
});

// ----- M4 lock-version guard (cases 20–21) -----
//
// The M4 unlock touches 4 control types and 3 envelope (a) fields but
// MUST NOT change the lock-version surface: the envelope `session`
// field must remain optional, and M2 envelope-level guard cases (12
// for `type` validity, 13 for `kind: pi` rejection, 14 for `kind`
// gating, 15 for `id: min(1)`) must continue to pass unchanged.
//
// Cases 20 / 21 lock the `session` lockdown contract. Case 16 already
// proves `session` is optional for a control `handshake`; cases 20 /
// 21 sweep one M3 + one M4 envelope variant to confirm the M4 unlock
// did not silently make `session` required on any family member.

describe('Envelope session lock-version guard (M4 PRD §9.1 — 2 cases)', () => {
  it('20. M3 `session_list` envelope still parses whether `session` is present or omitted', () => {
    // M4 `session_list.payload` gains `work_dir?` (envelope evolution
    // rule (a) — additive optional). The envelope-level `session`
    // field is a separate concern: it MUST stay optional across the
    // M4 unlock (multi-session mode under envelope evolution rule (b)
    // populates it, single-session mode does not; the schema does not
    // flip the wire contract).

    // M3 compatibility — `session` omitted:
    const omitted = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_list',
      id: 'lvg-020a',
      payload: {},
    });
    expect(omitted.success).toBe(true);
    if (omitted.success) {
      expect(omitted.data.session).toBeUndefined();
    }

    // M4 multi-session — `session` populated, work_dir set:
    const present = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_list',
      id: 'lvg-020b',
      session: 'sess-A',
      payload: { work_dir: '/home/user/proj' },
    });
    expect(present.success).toBe(true);
    if (present.success) {
      expect(present.data.session).toBe('sess-A');
    }
  });

  it('21. M4 `list_directories` envelope still parses whether `session` is present or omitted', () => {
    // Pin the same lock-version contract on a newly added M4 control
    // type. The M4 unlock is additive — even the 4 new control types
    // must keep `session` optional so the schema does not silently
    // force multi-session semantics on any single-session peer.
    const omitted = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'list_directories',
      id: 'lvg-021a',
      payload: {},
    });
    expect(omitted.success).toBe(true);
    if (omitted.success) {
      expect(omitted.data.session).toBeUndefined();
    }

    const present = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'list_directories',
      id: 'lvg-021b',
      session: 'sess-X',
      payload: { path: '/home/user' },
    });
    expect(present.success).toBe(true);
    if (present.success) {
      expect(present.data.session).toBe('sess-X');
      expect(present.data.payload).toEqual({ path: '/home/user' });
    }
  });
});

// ----- M4 new types envelope safeParse round-trip (4 cases) -----
//
// Each of the 4 new control types added by the M4 unlock (ADR-0010)
// gets one full envelope-level round-trip here: `kind: 'control'` +
// `type` + `id` + `payload` (and `reply_to` for the result-only flow
// when relevant). These complement the per-payload cases in
// `work-dirs.test.ts` by exercising the full `Envelope` union path.

describe('M4 new control envelopes round-trip (4 cases)', () => {
  it('22. `list_directories` envelope round-trips through `Envelope.safeParse`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'list_directories',
      id: 'rt-022',
      payload: { path: '/home/user' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Narrowing — the inner ControlBranch discriminated union collapses
    // the union to ListDirectoriesEnvelope. We assert the discriminator
    // and the round-tripped payload shape here without importing the
    // specific envelope type (mirrors the M2 case 1 pattern).
    expect(result.data.type).toBe('list_directories');
    expect(result.data.kind).toBe('control');
    expect(result.data.id).toBe('rt-022');
    expect(result.data.payload).toEqual({ path: '/home/user' });
  });

  it('23. `work_dir_list` envelope round-trips through `Envelope.safeParse`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'work_dir_list',
      id: 'rt-023',
      payload: {},
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.type).toBe('work_dir_list');
    expect(result.data.kind).toBe('control');
    expect(result.data.id).toBe('rt-023');
    expect(result.data.payload).toEqual({});
  });

  it('24. `work_dir_add` envelope round-trips through `Envelope.safeParse`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'work_dir_add',
      id: 'rt-024',
      payload: { path: '/home/user/proj-new' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.type).toBe('work_dir_add');
    expect(result.data.kind).toBe('control');
    expect(result.data.id).toBe('rt-024');
    expect(result.data.payload).toEqual({ path: '/home/user/proj-new' });
  });

  it('25. `work_dir_remove` envelope round-trips through `Envelope.safeParse`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'work_dir_remove',
      id: 'rt-025',
      payload: { path: '/tmp/old-proj' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.type).toBe('work_dir_remove');
    expect(result.data.kind).toBe('control');
    expect(result.data.id).toBe('rt-025');
    expect(result.data.payload).toEqual({ path: '/tmp/old-proj' });
  });
});

// Sanity sweep — every legal role / reason / error code parses at the
// payload schema level. Guards against future enum drift between
// CONTROL_TYPES / ROLES / BRIDGE_STATUS_REASONS / ERROR_CODES and the
// payload schemas that consume them.
describe('Enum literals ↔ payload schemas (sanity)', () => {
  it('every legal role parses HandshakePayloadSchema', () => {
    for (const role of ROLES) {
      expect(HandshakePayloadSchema.safeParse({ role, token: 't' }).success).toBe(true);
    }
  });

  it('every legal reason parses BridgeStatusPayloadSchema', () => {
    for (const reason of BRIDGE_STATUS_REASONS) {
      expect(
        BridgeStatusPayloadSchema.safeParse({
          online: true,
          changed_at: '2026-09-05T10:00:00Z',
          reason,
        }).success,
      ).toBe(true);
    }
  });

  it('every ErrorCode parses ErrorPayloadSchema', () => {
    for (const code of ERROR_CODES) {
      expect(ErrorPayloadSchema.safeParse({ code, message: 'x' }).success).toBe(true);
    }
  });
});
