// RemotePi tunnel protocol v1 — extension UI block-on entry + web wire shape.
//
// Two related concepts share this file because they are the bridge between
// pi's `extension_ui_request` events (forwarded as `pi/event` envelopes) and
// the web-side dialog UX (driven by `session_state.blocked_on` state frames
// and the `extension_ui_response` wire shape the web emits).
//
//   1. `BlockedOnEntryPayloadSchema` — the per-element shape of
//      `session_state.payload.blocked_on[]` and of the bridge-internal
//      pending-request map. Mirrors pi v0.85.1's `extension_ui_request` for
//      the 4 BLOCKING methods (select / confirm / input / editor); the 5
//      fire-and-forget methods (notify / setStatus / setWidget / setTitle /
//      set_editor_text) intentionally do NOT enter blocked_on — they are
//      digested locally by the bridge and have no remote equivalent.
//
//   2. `ExtensionUIResponsePayloadSchema` — the web-side wire shape the
//      browser sends back to acknowledge a dialog. The bridge translates
//      this into pi's native three-state response (cancelled / confirmed /
//      value) at the bridge boundary, so the web component layer never
//      touches pi's native schema directly.
//
// Naming contract (M1): payload Zod schema uses the `Schema` suffix;
// payload derived type has no suffix. Envelope-level definitions (which
// wrap a payload with envelope headers) live alongside the payload schema
// in `pi.ts`, not here — this file holds payload-only shapes that are
// *composed* into other schemas (`session_state.payload.blocked_on[]` and
// the `extension_ui_response` envelope payload).
import { z } from 'zod';

/** Methods that can block on a user response and therefore enter the
 *  `session_state.payload.blocked_on` queue. The four values mirror pi
 *  v0.85.1's `extension_ui_request` blocking methods one-for-one; `id`
 *  is the stable UUID that pi assigns per request and is the correlation
 *  key between request and `extension_ui_response`. Fire-and-forget
 *  methods (notify / setStatus / setWidget / setTitle / set_editor_text)
 *  are deliberately omitted — they have no remote equivalent and are
 *  digested locally by the bridge. */
export const BLOCK_ON_METHODS = ['select', 'confirm', 'input', 'editor'] as const;
export type BlockOnMethod = (typeof BLOCK_ON_METHODS)[number];

/** Per-element shape of `session_state.payload.blocked_on[]` and the
 *  bridge-internal pending-request map. Discriminated by `method` so the
 *  pi v0.85.1 4-blocking-method shape is preserved on the wire and the
 *  web UI can switch on `entry.method` to pick the dialog component.
 *
 *  Per-method field notes:
 *   - `select`   — `options` is the list of choices the user picks from.
 *   - `confirm`  — `message` is the confirm prompt body; `value: true`
 *                  accepts, `value: false` declines.
 *   - `input`    — `placeholder` is the input field hint; absence means
 *                  no hint.
 *   - `editor`   — multi-line editor; `prefill` is the initial body.
 *                  No `timeout` (known accepted behaviour, see ADR-0004):
 *                  the editor blocks indefinitely and the agent only
 *                  emits `agent_settled` after the user submits.
 *
 *  `timeout` is optional on every method except `editor`; it is a
 *  duration in milliseconds. The bridge mirrors it with a local
 *  `setTimeout` and atomically races with web submissions. */
export const BlockedOnEntryPayloadSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('select'),
    id: z.string(),
    title: z.string(),
    options: z.array(z.string()),
    timeout: z.number().optional(),
  }),
  z.object({
    method: z.literal('confirm'),
    id: z.string(),
    title: z.string(),
    message: z.string(),
    timeout: z.number().optional(),
  }),
  z.object({
    method: z.literal('input'),
    id: z.string(),
    title: z.string(),
    placeholder: z.string().optional(),
    timeout: z.number().optional(),
  }),
  z.object({
    method: z.literal('editor'),
    id: z.string(),
    title: z.string(),
    prefill: z.string().optional(),
  }),
]);
export type BlockedOnEntryPayload = z.infer<typeof BlockedOnEntryPayloadSchema>;

/** Web-side wire shape of an `extension_ui_response` payload — what the
 *  browser sends back to acknowledge (or cancel) a pending dialog.
 *
 *  The shape is deliberately unified across all 4 methods: `cancelled` is
 *  always a boolean, and `value` (when present) is either a string or a
 *  boolean. `confirm` uses `value: boolean` (`true` = confirm,
 *  `value: false` = decline — the only way to express "no" on a confirm
 *  dialog); `select` / `input` / `editor` use `value: string`.
 *
 *  Refinement rules:
 *   - `cancelled: true` must omit `value` (no point carrying one);
 *   - `cancelled: false` must include `value` (otherwise the agent has
 *     no answer to act on). The refinement reports a path-tagged error
 *     pointing at `value` so test failures and bridge diagnostics can
 *     localise the missing field without scanning the whole payload.
 *
 *  The bridge translates this web wire shape into pi's native three-state
 *  response (`cancelled` / `confirmed` / `value`) at the boundary — see
 *  [[architecture/protocol/pi.md#extension_ui_response]] and the bridge
 *  translator in M3 PRD §1.6 / §2.4. The shared package deliberately
 *  does NOT expose pi's native schema to the web. */
export const ExtensionUIResponsePayloadSchema = z
  .object({
    request_id: z.string().min(1),
    cancelled: z.boolean(),
    value: z.union([z.string(), z.boolean()]).optional(),
  })
  .refine((v) => v.cancelled === true || v.value !== undefined, {
    message: 'value is required when cancelled=false (string 或 boolean)',
    path: ['value'],
  });
export type ExtensionUIResponsePayload = z.infer<typeof ExtensionUIResponsePayloadSchema>;
