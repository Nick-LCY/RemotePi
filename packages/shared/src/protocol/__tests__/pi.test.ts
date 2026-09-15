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
// Cases 20–22 pin the M4 envelope (a) extension on `prompt.payload.work_dir`.
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
    // Shape is owned by `block-on.ts`; the envelope simply wraps it.
    // Use a `select`-style string value here so we exercise the string
    // branch of the union — the boolean branch (confirm) is covered
    // separately by the `block-on.test.ts` cases 16 / 17.
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
    // Event `data` is an open shape by design (envelope evolution rule
    // (c); see M3 PRD §1.5). This case uses a plain object to lock the
    // basic shape; cases 15 / 16 cover scalar and deeply nested data.
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
    // `AbortPayloadSchema` is `z.object({})`. zod's default policy
    // strips unknown keys, so extras do not surface on the parsed
    // result but the envelope still parses. Mirrors the M2
    // envelope.test.ts "abort with extra fields passes" precedent
    // (see also envelope.test.ts cases 16 / 17 for the
    // optional-field + unknown-key round-trip pattern).
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
    // `data: z.unknown()` accepts any JSON-serialisable value.
    // Queue-length events and similar small payloads use a number —
    // must round-trip.
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
    // Mirrors `message_update` text_delta style payloads — anything
    // that survives JSON serialisation must round-trip without schema
    // interference.
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
    // Sweep control-family types + an arbitrary string + a typo — all
    // must fail. This proves rejection happens on the type-discriminator
    // gate, not on payload semantics.
    for (const type of [
      'handshake',
      'result',
      'error',
      'get_state',
      'session_state',
      'promptt',
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

  // ----- M4 envelope (a) extension: `prompt.payload.work_dir?` (cases 20–22) -----
  //
  // ADR-0010 §决策.2 + pi.ts JSDoc on `PromptPayloadSchema`: the M4 unlock
  // adds `work_dir?` to the `prompt` payload so the bridge knows which
  // directory to spawn under when the web emits a `session: 'new'` prompt.
  // The schema is intentionally additive-only (no lock bump) and the
  // "session:'new' only" rule is a bridge-side convention — the schema
  // does NOT enforce the `session` correlation. See PRD §裁定 A 方案 A.
  //
  // Note: payload-shape-only checks live in `work-dirs.test.ts` cases 18 /
  // 19. Cases 20 / 21 here focus on the envelope-level round-trip and the
  // comment-mandated semantics, plus a steer / follow_up contrast (case 22)
  // to pin down that the `work_dir?` field is unique to `prompt`.

  it('20. accepts a `prompt` envelope with `work_dir` omitted (default empty under envelope evolution rule (a))', () => {
    // Envelope evolution rule (a) — absence is equivalent to the default
    // empty value. M3 single-session mode never set `work_dir`; absence
    // is the wire-compatible form that M4 sends whenever the prompt is
    // targeting an existing session (not `session: 'new'`).
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'pi-020',
      payload: { content: 'continue the conversation' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<PromptEnvelope>(result.data, 'prompt');
    expect(env.payload.content).toBe('continue the conversation');
    expect(env.payload.work_dir).toBeUndefined();
  });

  it('21. accepts a `prompt` envelope with `work_dir` set (the `session:"new"` path — schema does NOT enforce correlation)', () => {
    // Wire contract (ADR-0010 §决策.2 + pi.ts JSDoc): `work_dir` MAY
    // only be carried by prompts whose envelope `session === 'new'`.
    // The shared schema enforces ONLY the optional-side of the
    // contract (presence is allowed; absence is allowed). The "new
    // only" rule is a bridge-side convention that the web is
    // responsible for honouring — the schema deliberately stays
    // silent on it so the schema stays small and forward-compatible.
    //
    // We assert presence-legality below by emitting the canonical M4
    // `session: 'new'` frame and confirming the schema round-trips it.
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'pi-021',
      session: 'new',
      payload: {
        content: 'start a new session here',
        work_dir: '/home/user/proj-new',
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<PromptEnvelope>(result.data, 'prompt');
    expect(env.session).toBe('new');
    expect(env.payload.work_dir).toBe('/home/user/proj-new');
    expect(env.payload.content).toBe('start a new session here');

    // Comment-mandated semantics check: the schema does NOT reject
    // `work_dir` on a non-`new` session. A future bridge hardening
    // pass could add that gate, but the schema intentionally stays
    // silent. We assert the actual permissive behaviour here so a
    // future tightening is a deliberate wire-breaking change, not a
    // silent drift.
    const nonNewWithWorkDir = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'pi-021-bypass',
      session: 'sess-real-stem',
      payload: {
        content: 'carry on',
        work_dir: '/home/user/proj-ignored-by-bridge',
      },
    });
    expect(
      nonNewWithWorkDir.success,
      'schema does NOT enforce the session correlation — bridge discards work_dir on non-new',
    ).toBe(true);
  });

  it('22. accepts a `steer` / `follow_up` envelope with `work_dir` silently stripped (only `prompt` carries it)', () => {
    // Comment-mandated semantics check: only the `prompt` payload
    // declares `work_dir?` (per pi.ts JSDoc). `steer` and `follow_up`
    // are mid-run inserts that already target an existing session —
    // the bridge translates `content` → `message` at the bridge→pi
    // boundary (see `translateToPiWire`). Adding `work_dir` to those
    // payloads has no wire effect because their schemas do not
    // declare the field; zod's default policy silently strips it.
    //
    // This test pins that contract: an accidental future addition of
    // `work_dir?` to `SteerPayloadSchema` / `FollowUpPayloadSchema`
    // would surface as a `payload.work_dir !== undefined` failure
    // below, not as a silent drift.
    for (const type of ['steer', 'follow_up'] as const) {
      // Build the candidate input as `Record<string, unknown>` so the
      // extra `work_dir` doesn't trip the type checker — the
      // type-level signature of `SteerPayload` / `FollowUpPayload`
      // deliberately does not declare `work_dir` (that's the whole
      // point of this test). The extra key would be stripped by zod's
      // default policy at parse time; this test pins that contract.
      const candidatePayload: Record<string, unknown> = {
        content: 'do this instead',
        work_dir: '/home/user/proj-irrelevant',
      };
      const result = parseEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type,
        id: `pi-022-${type}`,
        payload: candidatePayload,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      // The stripped payload must NOT carry `work_dir` on the parsed
      // result. If a future schema adds the field, this assertion
      // becomes the gate for that wire change. We cast through
      // unknown because the per-type payload types (SteerPayload /
      // FollowUpPayload) do NOT declare `work_dir` — that's the
      // invariant under test.
      const parsed = result.data as unknown as {
        type: string;
        payload: Record<string, unknown>;
      };
      expect(
        parsed.payload.work_dir,
        `\`${type}\` payload must not carry work_dir after parse (zod strips unknown keys)`,
      ).toBeUndefined();
      expect(parsed.payload.content).toBe('do this instead');
    }
  });
});
