// Vitest specs for the v1 envelope + 5 control-family payload schemas.
//
// 17 cases mapped 1-to-1 against [[prds/m2-tunnel.md#6-测试]] §6. Each `it`
// block is numbered to match the PRD list — keep them in lock-step if the PRD
// ever reorganises.
//
// Style: every assertion goes through `Envelope.safeParse(...)` and inspects
// `.success`. We avoid `.toThrow(ZodError)` because `.safeParse` gives richer
// error context for failure cases (and a single `expect(...).toBe(true|false)`
// is easier to grep than `.toThrow`).

import { describe, expect, it } from 'vitest';
import {
  BRIDGE_STATUS_REASONS,
  BridgeStatusPayloadSchema,
  CONTROL_TYPES,
  Envelope,
  ErrorPayloadSchema,
  HandshakePayloadSchema,
  PingPayloadSchema,
  PongPayloadSchema,
  PROTOCOL_VERSION,
  ROLES,
  type BridgeStatusEnvelope,
  type ErrorCode,
  type ErrorEnvelope,
  type HandshakeEnvelope,
  type PingEnvelope,
} from '../envelope.js';

// ----- helpers -----

/** Run `Envelope.parse` on an unknown shape and assert the outcome.
 *  Centralises the parse-then-narrow dance so each case stays focused on the
 *  payload it cares about. */
function parseEnvelope(value: unknown) {
  return Envelope.safeParse(value);
}

/** Narrow `result.data` to a specific envelope variant by its `type`
 *  discriminator. Throws if the parse succeeded but with an unexpected type —
 *  that would mean a test bug (we constructed a frame we thought was type X
 *  but got Y back). */
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

    // Discriminator narrowing — the inner `discriminatedUnion('type', ...)` on
    // ControlBranch collapses Envelope down to HandshakeEnvelope (kind stays
    // 'control' since pi is the always-reject placeholder), which lets us
    // access handshake-only payload fields without further casts.
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

    // Independent payload-schema check — same expectation, narrower surface.
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

    // Payload-schema spot check — same outcome.
    expect(PingPayloadSchema.safeParse({ nonce: 'a1b2' }).success).toBe(true);
    expect(PingPayloadSchema.safeParse({}).success).toBe(true);
  });

  // ----- pong (case 6) -----
  it('6. rejects a pong envelope whose payload omits the required `nonce`', () => {
    // Pong's `nonce` is mandatory (control.md §3 — the nonce is the pairing
    // key). A pong frame without it must be refused.
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

    // Schema-level spot check that all three reasons parse on their own.
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
        reason: 'foo', // not in BRIDGE_STATUS_REASONS
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
    const codes: ErrorCode[] = [
      'auth_failed',
      'duplicate_bridge',
      'invalid_envelope',
      'unsupported_version',
      'unsupported_type',
      'internal',
    ];
    for (const code of codes) {
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

    for (const code of codes) {
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

  it('13. rejects any envelope whose `kind` is `pi` (pi placeholder semantics)', () => {
    // Pi is the M2 placeholder — every pi-shaped frame must fail. We sweep
    // through both legal and illegal types to confirm the rejection is on
    // `kind`, not on `type` content.
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
      // `session` is intentionally not populated by any M2 message but stays
      // on the schema surface for v1 lock-version (envelope.md §锁版承诺).
      expect(result.data.session).toBeUndefined();
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
  });
});

// Sanity sweep: every legal role / reason / error code parses at the payload
// schema level. These are not numbered PRD cases but guard against future enum
// drift between CONTROL_TYPES / ROLES / BRIDGE_STATUS_REASONS / ERROR_CODES and
// the payload schemas that consume them.
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
    for (const code of [
      'auth_failed',
      'duplicate_bridge',
      'invalid_envelope',
      'unsupported_version',
      'unsupported_type',
      'internal',
    ] as const) {
      expect(ErrorPayloadSchema.safeParse({ code, message: 'x' }).success).toBe(true);
    }
  });
});
