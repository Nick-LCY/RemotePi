// RemotePi tunnel protocol v1 — pi-family payload schemas + envelope schemas.
//
// Wire layout (see docs/architecture/protocol/pi.md):
//   { v: 1, kind: "pi", type, id, session?, reply_to?, payload }
//
// ## File contents
//
// The 9 pi-family envelopes split into two groups:
//
//   **Commands (6, web → bridge):**
//   - `prompt` / `steer` / `follow_up` — user-typed content payloads
//     (`{ content: string }`). Same shape across all three; the type
//     discriminator selects the pi-side semantics.
//   - `abort` — empty payload.
//   - `get_messages` — optional `since` cursor; absence means full snapshot.
//   - `extension_ui_response` — web wire shape for dialog acknowledgements
//     (see `block-on.ts` for the payload schema; deliberately NOT pi's
//     native three-state shape — see `extension_ui_response` JSDoc below).
//
//   **Replies & events (3, bridge → web):**
//   - `command_result` — generic reply for any command; `command` echoes
//     the originating type, `success` is boolean, `data` is command-specific
//     and open at the wire level.
//   - `snapshot` — `get_messages` reply; `messages` is an array of pi
//     messages in their native shape (intentionally `z.array(z.unknown())`
//     — the shared package does NOT constrain the element schema).
//   - `event` — forwarder for pi lifecycle events (`message_update`,
//     `agent_settled`, `extension_ui_request`, etc.). `event` name and
//     `data` payload are an open set — pi upgrades that add new event
//     names do not require a shared-package change (envelope evolution
//     rule (c)).
//
// The 9 envelope schemas form a `discriminatedUnion('type', …)` exported
// as `PiBranch` and consumed by `envelope.ts` to build the top-level
// `Envelope`. This file owns the per-schema definitions; `envelope.ts`
// owns the union that ties `ControlBranch` / `PiBranch` / `Envelope`
// together.
//
// Naming contract (M1): envelope Zod schema + derived type share the
// same name (XxxEnvelope); payload Zod schema uses the `Schema` suffix
// (XxxPayloadSchema); payload derived type has no suffix (XxxPayload).
import { z } from 'zod';
import { ExtensionUIResponsePayloadSchema } from './block-on.js';
import { EnvelopeBasePi } from './envelope-base.js';

// ---------------------------------------------------------------------------
// Command payloads (6, web → bridge)
// ---------------------------------------------------------------------------

/** Prompt payload — normal user-typed message. The bridge receives
 *  `content` from web and translates it to pi's native `message`
 *  field at the bridge→pi boundary (see `translateToPiWire` in
 *  `packages/bridge/src/pi-process.ts`). The shared web wire keeps
 *  `content` for cross-transport stability (web sends `content`,
 *  bridge translates to `message` before writing to pi stdin).
 *
 *  `work_dir` is the M4 additive optional field (ADR-0010 §演进规则
 *  (a)). **Wire contract**: it MUST only be carried by prompts whose
 *  envelope `session` is the literal string `'new'` — the
 *  "create a new session under this directory" entry point. For any
 *  other `session` value (real sessionKey stem, omitted) the bridge
 *  ignores `work_dir` even when present. The shared schema enforces
 *  the optional side of the contract only (presence is allowed; absence
 *  is allowed); the "new only" rule is a bridge-side convention that
 *  the web is responsible for honouring. See PRD §裁定 A 方案 A and
 *  `pi.md` §多会话扩展. */
export const PromptPayloadSchema = z.object({
  content: z.string(),
  work_dir: z.string().optional(),
});
export type PromptPayload = z.infer<typeof PromptPayloadSchema>;

/** Steer payload — mid-run insert. The bridge translates `content`
 *  to pi's `message` field at the bridge→pi boundary (see
 *  `translateToPiWire`). Same cross-transport rationale as
 *  `PromptPayload`. */
export const SteerPayloadSchema = z.object({
  content: z.string(),
});
export type SteerPayload = z.infer<typeof SteerPayloadSchema>;

/** FollowUp payload — queued message. The bridge translates
 *  `content` to pi's `message` field at the bridge→pi boundary
 *  (see `translateToPiWire`). Same cross-transport rationale as
 *  `PromptPayload`. */
export const FollowUpPayloadSchema = z.object({
  content: z.string(),
});
export type FollowUpPayload = z.infer<typeof FollowUpPayloadSchema>;

/** Abort payload — empty `{}`. The bridge forwards the abort to pi and
 *  marks the current turn as cancelled. */
export const AbortPayloadSchema = z.object({});
export type AbortPayload = z.infer<typeof AbortPayloadSchema>;

/** GetMessages payload — `since` cursor (optional). The web wire
 *  retains `since` for an M+ look-ahead (where it will switch to
 *  pi's `get_entries` command, the only RPC that accepts `since`
 *  — pi's `get_messages` does NOT carry this field); today
 *  `translateToPiWire` drops it at the bridge→pi boundary so the
 *  shared schema stays forward-compatible without forcing a wire
 *  break before that switchover. Absence means full snapshot. */
export const GetMessagesPayloadSchema = z.object({
  since: z.string().optional(),
});
export type GetMessagesPayload = z.infer<typeof GetMessagesPayloadSchema>;

/** ExtensionUIResponse payload — re-exported from `block-on.ts` so the
 *  pi family owns the wire-shape responsibility but `block-on.ts`
 *  continues to own the refinement logic (which is shared between the
 *  pi envelope and any future web-side validator). See
 *  `ExtensionUIResponsePayloadSchema` JSDoc in `block-on.ts` for the
 *  full semantics of the web wire shape. */
export { ExtensionUIResponsePayloadSchema } from './block-on.js';
export type { ExtensionUIResponsePayload } from './block-on.js';

// ---------------------------------------------------------------------------
// Reply & event payloads (3, bridge → web)
// ---------------------------------------------------------------------------

/** CommandResult payload — unified reply for every pi command.
 *  `command` echoes the originating command `type` so the caller can
 *  dispatch without `reply_to`-matching; `success` is the boolean
 *  outcome; `data` is optional and intentionally `z.unknown()` —
 *  per-command data shapes are not pinned by the shared package.
 *
 *  `error.code` is a plain string, intentionally not constrained to
 *  the control-family `ERROR_CODES` lock set (unlike control `result`
 *  payloads). Pi-side failures may surface any string; PRD §1.5 does
 *  not require pi `command_result` codes to converge on ERROR_CODES. */
export const CommandResultPayloadSchema = z.object({
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type CommandResultPayload = z.infer<typeof CommandResultPayloadSchema>;

/** Snapshot payload — `get_messages` reply. `messages` is an array of
 *  pi messages in their native shape; the element schema is
 *  intentionally `z.unknown()` — the shared package does NOT pin
 *  per-message shapes, and the web layer is responsible for any
 *  downstream rendering / validation.
 *
 *  `reply_to` on the envelope MUST equal the original `get_messages`
 *  command's `id`. */
export const SnapshotPayloadSchema = z.object({
  messages: z.array(z.unknown()),
});
export type SnapshotPayload = z.infer<typeof SnapshotPayloadSchema>;

/** Event payload — forwarder for pi lifecycle events. `event` is the
 *  pi event name (open set — `agent_settled`, `message_update`,
 *  `extension_ui_request`, `queue_update`, etc., plus any new event
 *  pi introduces in a future release); `data` is the event payload,
 *  deliberately `z.unknown()` because the event-name → data-shape
 *  mapping is not pinned by the shared package (envelope evolution
 *  rule (c)). */
export const EventPayloadSchema = z.object({
  event: z.string(),
  data: z.unknown(),
});
export type EventPayload = z.infer<typeof EventPayloadSchema>;

// ---------------------------------------------------------------------------
// Pi envelope schemas (one per payload above)
// ---------------------------------------------------------------------------
//
// Each envelope carries the full wire surface: `v` / `kind: 'pi'` / `type`
// / `id` / optional `session` + `reply_to` / `payload`. `session` is
// more relevant here than in the control family because every pi
// message is conversation-scoped (M4 multi-session mode will require it);
// M3 single-session mode typically omits it but the field is part of
// the v1 wire surface.

export const PromptEnvelope = z.object({
  ...EnvelopeBasePi,
  type: z.literal('prompt'),
  payload: PromptPayloadSchema,
});
export type PromptEnvelope = z.infer<typeof PromptEnvelope>;

export const SteerEnvelope = z.object({
  ...EnvelopeBasePi,
  type: z.literal('steer'),
  payload: SteerPayloadSchema,
});
export type SteerEnvelope = z.infer<typeof SteerEnvelope>;

export const FollowUpEnvelope = z.object({
  ...EnvelopeBasePi,
  type: z.literal('follow_up'),
  payload: FollowUpPayloadSchema,
});
export type FollowUpEnvelope = z.infer<typeof FollowUpEnvelope>;

export const AbortEnvelope = z.object({
  ...EnvelopeBasePi,
  type: z.literal('abort'),
  payload: AbortPayloadSchema,
});
export type AbortEnvelope = z.infer<typeof AbortEnvelope>;

export const GetMessagesEnvelope = z.object({
  ...EnvelopeBasePi,
  type: z.literal('get_messages'),
  payload: GetMessagesPayloadSchema,
});
export type GetMessagesEnvelope = z.infer<typeof GetMessagesEnvelope>;

export const ExtensionUIResponseEnvelope = z.object({
  ...EnvelopeBasePi,
  type: z.literal('extension_ui_response'),
  payload: ExtensionUIResponsePayloadSchema,
});
export type ExtensionUIResponseEnvelope = z.infer<typeof ExtensionUIResponseEnvelope>;

export const CommandResultEnvelope = z.object({
  ...EnvelopeBasePi,
  type: z.literal('command_result'),
  payload: CommandResultPayloadSchema,
});
export type CommandResultEnvelope = z.infer<typeof CommandResultEnvelope>;

export const SnapshotEnvelope = z.object({
  ...EnvelopeBasePi,
  type: z.literal('snapshot'),
  payload: SnapshotPayloadSchema,
});
export type SnapshotEnvelope = z.infer<typeof SnapshotEnvelope>;

export const EventEnvelope = z.object({
  ...EnvelopeBasePi,
  type: z.literal('event'),
  payload: EventPayloadSchema,
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

// ---------------------------------------------------------------------------
// PiBranch — the discriminated union of all pi-family envelopes
// ---------------------------------------------------------------------------

/** Pi family — inner `discriminatedUnion('type', [...])`. Pairs with
 *  `ControlBranch` from `control.ts` to form the top-level `Envelope`
 *  union in `envelope.ts`. Replaces the M2 `z.never()` placeholder
 *  that rejected every pi-shaped frame — see ADR-0006 / M3 PRD §1.5
 *  for the design rationale. */
export const PiBranch = z.discriminatedUnion('type', [
  PromptEnvelope,
  SteerEnvelope,
  FollowUpEnvelope,
  AbortEnvelope,
  GetMessagesEnvelope,
  ExtensionUIResponseEnvelope,
  CommandResultEnvelope,
  SnapshotEnvelope,
  EventEnvelope,
]);
export type PiBranch = z.infer<typeof PiBranch>;
