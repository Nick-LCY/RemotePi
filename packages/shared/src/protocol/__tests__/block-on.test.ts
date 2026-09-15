// Vitest specs for `BlockedOnEntryPayloadSchema` (4-method discriminated
// union for `session_state.payload.blocked_on[]`) and
// `ExtensionUIResponsePayloadSchema` (web wire shape for dialog acks).
//
// PRD mapping — each `it` block is numbered to match the M3 PRD
// [[prds/m3-single-session.md#6.1-sharedvitest]] §6.1 checklist:
//
//   4-method `BlockedOnEntry` legal parsing (cases 1–4):
//     1. select  — `options: string[]` required
//     2. confirm — `message: string` required
//     3. input   — `placeholder?: string` optional (covers both forms)
//     4. editor  — no `timeout` per ADR-0004 (editor is the known-accepted
//                  infinite-block case)
//
//   Optional `timeout` boundary (cases 5–7):
//     5. select with `timeout`             → passes
//     6. confirm with `timeout`            → passes
//     7. input with `timeout`              → passes
//
//   Required-field rejects (cases 8–10):
//     8.  select missing `options`         → reject
//     9.  blocked_on entry missing `id`    → reject (correlation key required)
//     10. fire-and-forget method (sweep of 5) → reject (notify / setStatus /
//         setWidget / setTitle / set_editor_text — bridge digests locally;
//         none of them enter `blocked_on`)
//
//   `editor` timeout boundary (case 11):
//    11. editor + `timeout` field — passes (zod strips unknown keys).
//        The `editor` schema deliberately omits `timeout` (ADR-0004:
//        editor blocks indefinitely, agent only emits `agent_settled`
//        after the user submits). The schema has no `.strict()` modifier,
//        so zod's default policy silently strips any unknown `timeout`
//        key rather than rejecting — PRD §1.3 enumerates `editor`'s
//        fields as `id` / `title` / `prefill?` and never pins a
//        "reject unknown keys" behaviour, so the schema matches PRD as
//        written. Adding `.strict()` later would be a wire breaking
//        change requiring an envelope evolution rule (d) revision; the
//        test here asserts actual schema behaviour, which is permissive.
//
//   `ExtensionUIResponsePayloadSchema` — web wire shape (cases 12–19):
//    12. `cancelled: true` (no `value`)                 → passes
//    13. `cancelled: false` + missing `value`           → refine rejects
//    14. `cancelled: false` + string `value`            → passes (select /
//         input / editor shape)
//    15. `cancelled: false` + boolean `value: true`     → passes (confirm
//         "yes" — independent case per PRD §6.1 emphasis)
//    16. `cancelled: false` + boolean `value: false`    → passes (confirm
//         "no" — independent case per PRD §6.1 emphasis)
//    17. missing `request_id`                           → reject (`min(1)`)
//    18. `value` neither string nor boolean (number)    → reject
//    19. `value` neither string nor boolean (object)    → reject (sweep)
//
// Style: every assertion goes through `Envelope.safeParse(...)` for the
// envelope-level cases and the payload schema directly for the
// shape/refine cases. The M2 envelope.test.ts pattern is mirrored
// throughout.

import { describe, expect, it } from 'vitest';
import {
  BLOCK_ON_METHODS,
  BlockedOnEntryPayloadSchema,
  ExtensionUIResponsePayloadSchema,
} from '../block-on.js';
import { Envelope, PROTOCOL_VERSION } from '../envelope.js';
import type { ExtensionUIResponseEnvelope } from '../pi.js';

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

describe('BlockedOnEntry (M3 PRD §6.1 — 4 methods + boundaries)', () => {
  // ----- 4-method legal parsing (cases 1–4) -----

  it('1. parses a legal `select` BlockedOnEntry (with `options` array)', () => {
    const result = BlockedOnEntryPayloadSchema.safeParse({
      method: 'select',
      id: 'req-1',
      title: 'Pick a flavour',
      options: ['vanilla', 'chocolate', 'strawberry'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.method).toBe('select');
    if (result.data.method === 'select') {
      expect(result.data.options).toEqual(['vanilla', 'chocolate', 'strawberry']);
      expect(result.data.title).toBe('Pick a flavour');
      expect(result.data.id).toBe('req-1');
    }
  });

  it('2. parses a legal `confirm` BlockedOnEntry (with `message` body)', () => {
    const result = BlockedOnEntryPayloadSchema.safeParse({
      method: 'confirm',
      id: 'req-2',
      title: 'Proceed?',
      message: 'This will delete the file permanently.',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.method).toBe('confirm');
    if (result.data.method === 'confirm') {
      expect(result.data.message).toBe('This will delete the file permanently.');
      expect(result.data.title).toBe('Proceed?');
    }
  });

  it('3. parses a legal `input` BlockedOnEntry with and without `placeholder`', () => {
    const withPlaceholder = BlockedOnEntryPayloadSchema.safeParse({
      method: 'input',
      id: 'req-3a',
      title: 'Branch name',
      placeholder: 'e.g. feat/login',
    });
    expect(withPlaceholder.success).toBe(true);
    if (withPlaceholder.success && withPlaceholder.data.method === 'input') {
      expect(withPlaceholder.data.placeholder).toBe('e.g. feat/login');
    }

    const withoutPlaceholder = BlockedOnEntryPayloadSchema.safeParse({
      method: 'input',
      id: 'req-3b',
      title: 'Branch name',
    });
    expect(withoutPlaceholder.success).toBe(true);
    if (withoutPlaceholder.success && withoutPlaceholder.data.method === 'input') {
      expect(withoutPlaceholder.data.placeholder).toBeUndefined();
    }
  });

  it('4. parses a legal `editor` BlockedOnEntry (no `timeout` per ADR-0004)', () => {
    // Editor deliberately has no `timeout` field — it blocks
    // indefinitely and the agent only emits `agent_settled` after the
    // user submits.
    const result = BlockedOnEntryPayloadSchema.safeParse({
      method: 'editor',
      id: 'req-4',
      title: 'Edit PR description',
      prefill: 'Initial draft...',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.method === 'editor') {
      expect(result.data.prefill).toBe('Initial draft...');
      expect('timeout' in result.data).toBe(false);
    }
  });

  // ----- optional `timeout` boundary (cases 5–7) -----

  it('5. accepts a `select` BlockedOnEntry with `timeout` (milliseconds)', () => {
    const result = BlockedOnEntryPayloadSchema.safeParse({
      method: 'select',
      id: 'req-5',
      title: 'Pick one',
      options: ['a', 'b'],
      timeout: 30000,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.method === 'select') {
      expect(result.data.timeout).toBe(30000);
    }
  });

  it('6. accepts a `confirm` BlockedOnEntry with `timeout`', () => {
    const result = BlockedOnEntryPayloadSchema.safeParse({
      method: 'confirm',
      id: 'req-6',
      title: 'Continue?',
      message: 'Are you sure?',
      timeout: 10000,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.method === 'confirm') {
      expect(result.data.timeout).toBe(10000);
    }
  });

  it('7. accepts an `input` BlockedOnEntry with `timeout`', () => {
    const result = BlockedOnEntryPayloadSchema.safeParse({
      method: 'input',
      id: 'req-7',
      title: 'Search query',
      placeholder: 'type to search',
      timeout: 60000,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.method === 'input') {
      expect(result.data.timeout).toBe(60000);
    }
  });

  // ----- required-field rejects (cases 8–10) -----

  it('8. rejects a `select` BlockedOnEntry missing `options`', () => {
    const result = BlockedOnEntryPayloadSchema.safeParse({
      method: 'select',
      id: 'req-8',
      title: 'Pick one',
    });
    expect(result.success).toBe(false);
  });

  it('9. rejects a BlockedOnEntry missing the `id` correlation key', () => {
    // `id` is the correlation key between `extension_ui_request`
    // (forwarded to web) and the eventual `extension_ui_response`. Any
    // entry without an `id` cannot be routed and must be refused at
    // the schema boundary.
    for (const method of BLOCK_ON_METHODS) {
      const base: Record<string, unknown> = { method, title: 't' };
      if (method === 'select') base.options = ['a'];
      if (method === 'confirm') base.message = 'm';
      // deliberately no `id`
      const result = BlockedOnEntryPayloadSchema.safeParse(base);
      expect(result.success, `method=${method} without id must fail`).toBe(false);
    }
  });

  it('10. rejects fire-and-forget methods (notify / setStatus / setWidget / setTitle / set_editor_text)', () => {
    // These 5 methods are pi's `extension_ui_request` non-blocking
    // variants. They have no remote equivalent (TUI-only concepts);
    // the bridge digests them locally and they must NOT enter
    // `blocked_on`. The 4-method discriminated union refuses any
    // non-union `method` discriminator.
    const fireAndForget = [
      'notify',
      'setStatus',
      'setWidget',
      'setTitle',
      'set_editor_text',
    ] as const;

    for (const method of fireAndForget) {
      const result = BlockedOnEntryPayloadSchema.safeParse({
        method,
        id: 'req-ff',
        title: 'should-not-enter-blocked-on',
      });
      expect(result.success, `fire-and-forget ${method} must be rejected`).toBe(
        false,
      );
    }
  });

  // ----- editor + timeout boundary (case 11) -----

  it('11. accepts an `editor` BlockedOnEntry that carries a `timeout` field (zod strips it)', () => {
    // `editor` deliberately omits `timeout` per ADR-0004 (editor
    // blocks indefinitely; only `agent_settled` after the user
    // submits resolves it). The schema has no `.strict()` modifier,
    // so zod's default policy silently strips any unknown `timeout`
    // key rather than rejecting. PRD §1.3 enumerates `editor`'s
    // fields as `id` / `title` / `prefill?` and never pins a
    // "reject unknown keys" behaviour — so the permissive parse
    // matches PRD as written. Tightening (e.g. adding `.strict()`)
    // would be a wire breaking change requiring an envelope
    // evolution rule (d) revision; this test asserts actual schema
    // behaviour, which is permissive.
    const result = BlockedOnEntryPayloadSchema.safeParse({
      method: 'editor',
      id: 'req-11',
      title: 'Edit',
      timeout: 30000,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.method === 'editor') {
      expect('timeout' in result.data).toBe(false);
    }
  });
});

describe('ExtensionUIResponse (M3 PRD §6.1 — web wire shape, 8 cases)', () => {
  // ----- cancelled: true (case 12) -----

  it('12. accepts an ExtensionUIResponse with `cancelled: true` (no `value` attached)', () => {
    // When the user dismisses the dialog, the web emits only
    // `cancelled: true` and no `value` (the agent has no answer to act
    // on). The refinement allows this:
    // `cancelled === true || value !== undefined`.
    const result = ExtensionUIResponsePayloadSchema.safeParse({
      request_id: 'req-12',
      cancelled: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.cancelled).toBe(true);
    expect(result.data.value).toBeUndefined();
  });

  // ----- cancelled: false but no value (case 13) -----

  it('13. rejects an ExtensionUIResponse with `cancelled: false` and missing `value` (refine fires)', () => {
    // The refine path emits a path-tagged error pointing at `value`
    // so bridge diagnostics / test failures can localise the missing
    // field.
    const result = ExtensionUIResponsePayloadSchema.safeParse({
      request_id: 'req-13',
      cancelled: false,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const valuePath = result.error.issues.find(
      (i) => i.path.join('.') === 'value',
    );
    expect(valuePath, 'refinement error must tag the `value` path').toBeDefined();
  });

  // ----- cancelled: false + string value (case 14) -----

  it('14. accepts an ExtensionUIResponse with `cancelled: false` + string `value` (select / input / editor shape)', () => {
    const result = ExtensionUIResponsePayloadSchema.safeParse({
      request_id: 'req-14',
      cancelled: false,
      value: 'option-A',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.value).toBe('option-A');
  });

  // ----- cancelled: false + boolean value, two independent cases (15 / 16) -----

  it('15. accepts an ExtensionUIResponse with `cancelled: false` + boolean `value: true` (confirm "yes")', () => {
    // PRD §6.1 explicitly calls out the confirm boolean `value` as two
    // independent cases — `value: true` is confirm, `value: false` is
    // the only way to express "no" on a confirm dialog.
    const result = ExtensionUIResponsePayloadSchema.safeParse({
      request_id: 'req-15',
      cancelled: false,
      value: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.value).toBe(true);
  });

  it('16. accepts an ExtensionUIResponse with `cancelled: false` + boolean `value: false` (confirm "no")', () => {
    // Independent case per PRD §6.1 — the web wire shape requires
    // confirm answers to be boolean, with `false` meaning decline.
    const result = ExtensionUIResponsePayloadSchema.safeParse({
      request_id: 'req-16',
      cancelled: false,
      value: false,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.value).toBe(false);
  });

  // ----- missing request_id (case 17) -----

  it('17. rejects an ExtensionUIResponse missing `request_id`', () => {
    const omitted = ExtensionUIResponsePayloadSchema.safeParse({
      cancelled: false,
      value: 'x',
    });
    expect(omitted.success).toBe(false);

    const empty = ExtensionUIResponsePayloadSchema.safeParse({
      request_id: '',
      cancelled: false,
      value: 'x',
    });
    expect(empty.success).toBe(false);
  });

  // ----- value non-string non-boolean (case 18 / 19) -----

  it('18. rejects an ExtensionUIResponse whose `value` is a number', () => {
    // `value` is constrained to `z.union([z.string(), z.boolean()])
    // .optional()`. Numbers, arrays, objects, null all fall outside
    // the union and must be refused.
    const result = ExtensionUIResponsePayloadSchema.safeParse({
      request_id: 'req-18',
      cancelled: false,
      value: 42,
    });
    expect(result.success).toBe(false);
  });

  it('19. rejects an ExtensionUIResponse whose `value` is a non-string/non-boolean (object)', () => {
    const result = ExtensionUIResponsePayloadSchema.safeParse({
      request_id: 'req-19',
      cancelled: false,
      value: { picked: 'option-A' },
    });
    expect(result.success).toBe(false);
  });
});

// Sanity sweep: the 4 blocking methods parse at the payload schema level.
// Mirrors the M2 envelope.test.ts "Enum literals ↔ payload schemas" sanity
// block — guards against future method-set drift.
describe('BlockedOnEntry (sanity sweep)', () => {
  it('every method in BLOCK_ON_METHODS parses with its method-specific field', () => {
    // The 4-method set must always parse without `timeout` (which is
    // optional). `editor` deliberately omits `prefill` here.
    const fixtures: Record<(typeof BLOCK_ON_METHODS)[number], object> = {
      select: { id: 'x', title: 't', options: ['a'] },
      confirm: { id: 'x', title: 't', message: 'm' },
      input: { id: 'x', title: 't' },
      editor: { id: 'x', title: 't' },
    };
    for (const method of BLOCK_ON_METHODS) {
      const result = BlockedOnEntryPayloadSchema.safeParse({
        method,
        ...fixtures[method],
      });
      expect(result.success, `method=${method} should parse`).toBe(true);
    }
  });

  it('ExtensionUIResponseEnvelope round-trips a `cancelled: true` ack through `Envelope`', () => {
    const result = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'extension_ui_response',
      id: 'pi-eu-1',
      payload: { request_id: 'req-rt', cancelled: true },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const env = narrow<ExtensionUIResponseEnvelope>(
      result.data,
      'extension_ui_response',
    );
    expect(env.payload.cancelled).toBe(true);
    expect(env.payload.value).toBeUndefined();
  });
});
