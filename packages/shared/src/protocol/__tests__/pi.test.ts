// Vitest specs for the 9 pi-family envelope schemas added in M3.
//
// PRD mapping — each `it` block below is numbered to match the M3 PRD
// [[prds/m3-single-session.md#6.1-sharedvitest]] §6.1 checklist:
//
//   9 type legal parsing (cases 1–10 — `get_messages` is split into two
//   sub-cases per the "含与缺 since 都通过" requirement):
//     1. prompt     — `content` required
//     2. steer      — `content` required
//     3. follow_up  — `content` required
//     4. abort      — empty payload
//     5. get_messages — `{}` (no `since`, full snapshot)
//     6. get_messages — `{ since }` (incremental)
//     7. extension_ui_response — web wire shape (see block-on.ts)
//     8. command_result — generic reply, `success` required
//     9. snapshot  — `messages` array required
//    10. event     — `data` is `z.unknown()` (open shape — covered further
//                    in cases 17–18)
//
//   Required-field rejects (cases 11–15):
//    11. prompt missing `content`         → reject
//    12. steer missing `content`          → reject
//    13. follow_up missing `content`      → reject
//    14. command_result missing `success` → reject
//    15. snapshot missing `messages`      → reject
//
//   Behavioural coverage (cases 16–18):
//    16. abort with extra payload fields → passes (zod default strips unknowns;
//        same precedent as `Envelope.safeParse` M2 coverage)
//    17. event with scalar `data`         → passes (`data: z.unknown()`)
//    18. event with deeply nested `data`  → passes (`data: z.unknown()`)
//
//   Illegal type (case 19):
//    19. kind=pi with a non-pi `type`     → reject (PiBranch only accepts
//        the 9 pi types; control-family + arbitrary types are refused at the
//        boundary)
//
// Style: every assertion goes through `Envelope.safeParse(...)` and inspects
// `.success`, mirroring the M2 envelope.test.ts pattern.

import { describe, expect, it } from 'vitest';
import { Envelope, PROTOCOL_VERSION } from '../envelope.js';
import type {
  AbortEnvelope,
  CommandResultEnvelope,
  EventEnvelope,
  ExtensionUIResponseEnvelope,
  FollowUpEnvelope,
  GetMessagesEnvelope,
  PromptEnvelope,
  SnapshotEnvelope,
  SteerEnvelope,
} from '../pi.js';

// ----- helpers (same shape as envelope.test.ts) -----

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

describe('Pi envelopes (M3 PRD §6.1 — 19 cases)', () => {
  // ----- 9 type legal parsing (cases 1–10) -----

  it('1. parses a legal `prompt` envelope (web → bridge, `content` required)', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'pi-001',
      payload: { content: 'sample prompt content' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<PromptEnvelope>(result.data, 'prompt');
    expect(env.kind).toBe('pi');
    expect(env.type).toBe('prompt');
    expect(env.v).toBe(PROTOCOL_VERSION);
    expect(env.id).toBe('pi-001');
    expect(env.payload.content).toBe('sample prompt content');
  });

  it('2. parses a legal `steer` envelope (web → bridge, `content` required)', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'steer',
      id: 'pi-002',
      payload: { content: 'do this instead' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<SteerEnvelope>(result.data, 'steer');
    expect(env.type).toBe('steer');
    expect(env.payload.content).toBe('do this instead');
  });

  it('3. parses a legal `follow_up` envelope (web → bridge, `content` required)', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'follow_up',
      id: 'pi-003',
      payload: { content: 'queued follow-up' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<FollowUpEnvelope>(result.data, 'follow_up');
    expect(env.type).toBe('follow_up');
    expect(env.payload.content).toBe('queued follow-up');
  });

  it('4. parses a legal `abort` envelope (web → bridge, empty payload)', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'abort',
      id: 'pi-004',
      payload: {},
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<AbortEnvelope>(result.data, 'abort');
    expect(env.type).toBe('abort');
    expect(env.payload).toEqual({});
  });

  it('5. parses a legal `get_messages` envelope with empty payload (full snapshot)', () => {
    // PRD §1.5: "absence means full snapshot". `since` is optional.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'get_messages',
      id: 'pi-005',
      payload: {},
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<GetMessagesEnvelope>(result.data, 'get_messages');
    expect(env.type).toBe('get_messages');
    expect(env.payload.since).toBeUndefined();
  });

  it('6. parses a legal `get_messages` envelope with `since` cursor (incremental)', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'get_messages',
      id: 'pi-006',
      payload: { since: 'msg-7' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<GetMessagesEnvelope>(result.data, 'get_messages');
    expect(env.payload.since).toBe('msg-7');
  });

  it('7. parses a legal `extension_ui_response` envelope (web wire shape)', () => {
    // Shape is owned by `block-on.ts`; the envelope simply wraps it. Use a
    // `select`-style string value here so we exercise the string branch of
    // the union — the boolean branch (confirm) is covered separately by the
    // `block-on.test.ts` cases 16 / 17.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'extension_ui_response',
      id: 'pi-007',
      payload: { request_id: 'req-1', cancelled: false, value: 'option-A' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<ExtensionUIResponseEnvelope>(result.data, 'extension_ui_response');
    expect(env.type).toBe('extension_ui_response');
    expect(env.payload.request_id).toBe('req-1');
    expect(env.payload.cancelled).toBe(false);
    expect(env.payload.value).toBe('option-A');
  });

  it('8. parses a legal `command_result` envelope (bridge → web, `success` required)', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'command_result',
      id: 'pi-008',
      payload: { command: 'prompt', success: true, data: { ok: 1 } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<CommandResultEnvelope>(result.data, 'command_result');
    expect(env.payload.command).toBe('prompt');
    expect(env.payload.success).toBe(true);
    expect(env.payload.data).toEqual({ ok: 1 });
  });

  it('9. parses a legal `snapshot` envelope (bridge → web, `messages` required)', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'snapshot',
      id: 'pi-009',
      reply_to: 'pi-005',
      payload: { messages: [{ id: 'm1' }, { id: 'm2' }] },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<SnapshotEnvelope>(result.data, 'snapshot');
    expect(env.payload.messages).toHaveLength(2);
    expect(env.reply_to).toBe('pi-005');
  });

  it('10. parses a legal `event` envelope (bridge → web, `data` is `z.unknown()`)', () => {
    // Event `data` is an open shape by design (envelope evolution rule (c);
    // see M3 PRD §1.5). This case uses a plain object to lock the basic
    // shape; cases 15 / 16 cover scalar and deeply nested data.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'event',
      id: 'pi-010',
      payload: { event: 'agent_settled', data: { phase: 'idle' } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<EventEnvelope>(result.data, 'event');
    expect(env.payload.event).toBe('agent_settled');
    expect(env.payload.data).toEqual({ phase: 'idle' });
  });

  // ----- required-field rejects (cases 11–13) -----

  it('11. rejects a `prompt` envelope whose payload omits `content`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'pi-011',
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it('12. rejects a `steer` envelope whose payload omits `content`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'steer',
      id: 'pi-012',
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it('13. rejects a `follow_up` envelope whose payload omits `content`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'follow_up',
      id: 'pi-013',
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it('14. rejects a `command_result` envelope whose payload omits `success`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'command_result',
      id: 'pi-014',
      payload: { command: 'prompt' },
    });
    expect(result.success).toBe(false);
  });

  it('15. rejects a `snapshot` envelope whose payload omits `messages`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'snapshot',
      id: 'pi-015',
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  // ----- behavioural coverage (cases 16–18) -----

  it('16. accepts an `abort` envelope with extra payload fields (zod strips unknowns)', () => {
    // `AbortPayloadSchema` is `z.object({})`. zod's default policy strips
    // unknown keys, so extras do not surface on the parsed result but the
    // envelope still parses. This mirrors the M2 envelope.test.ts "abort
    // with extra fields passes" precedent (see also envelope.test.ts cases
    // 16 / 17 for the optional-field + unknown-key round-trip pattern).
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'abort',
      id: 'pi-016',
      payload: { reason: 'user-clicked-abort', grace_ms: 200 },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<AbortEnvelope>(result.data, 'abort');
    expect(env.payload).toEqual({});
  });

  it('17. accepts an `event` envelope with a scalar `data` value (number)', () => {
    // `data: z.unknown()` accepts any JSON-serialisable value. Queue-length
    // events and similar small payloads use a number — must round-trip.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'event',
      id: 'pi-017',
      payload: { event: 'queue_update', data: 42 },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<EventEnvelope>(result.data, 'event');
    expect(env.payload.data).toBe(42);
  });

  it('18. accepts an `event` envelope with a deeply nested `data` object', () => {
    // Mirrors `message_update` text_delta style payloads — anything that
    // survives JSON serialisation must round-trip without schema interference.
    const nested = { delta: { text: 'hi', tokens: [{ t: 1 }, { t: 2 }] } };
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'event',
      id: 'pi-018',
      payload: { event: 'message_update', data: nested },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = narrow<EventEnvelope>(result.data, 'event');
    expect(env.payload.data).toEqual(nested);
  });

  // ----- illegal type (case 19) -----

  it('19. rejects a `kind: pi` envelope whose `type` is not in the 9 pi types', () => {
    // `PiBranch` is `z.discriminatedUnion('type', [...9 pi schemas...])`.
    // Sweep control-family types + an arbitrary string + a typo — all must
    // fail. This proves rejection happens on the type-discriminator gate, not
    // on payload semantics.
    for (const type of [
      'handshake',
      'result',
      'error',
      'get_state',
      'session_state',
      'promptt', // typo — not a real type
    ]) {
      const result = parseEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type,
        id: 'pi-019',
        payload: {},
      });
      expect(result.success, `kind=pi, type=${type} must fail`).toBe(false);
    }
  });
});
