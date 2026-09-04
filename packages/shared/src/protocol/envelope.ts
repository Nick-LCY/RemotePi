// RemotePi tunnel protocol v1 — envelope + control-family payload schemas.
//
// Wire layout (see docs/architecture/protocol/envelope.md):
//   { v: 1, kind: "control"|"pi", type, id, session?, reply_to?, payload }
//
// Three runtime peers (web / worker / bridge) import from this module so the
// wire shape stays in lock-step across the monorepo. All schema ↔ type pairs
// follow the M1 naming contract:
//   - envelope Zod schema and derived type share the same name (XxxEnvelope);
//   - payload Zod schema uses the `Schema` suffix (XxxPayloadSchema);
//   - payload derived type has no suffix (XxxPayload).
//
// ## Top-level structure
//
// The top-level `Envelope` is a `z.union([ControlBranch, PiBranch])`, not
// `z.discriminatedUnion('kind', [...])`. zod's discriminatedUnion walks each
// option's `.shape[discriminator]` to build the literal → branch lookup, and
// only plain ZodObjects expose `.shape` — a nested `discriminatedUnion` (the
// `ControlBranch`) does not. z.union preserves the same kind-gating: the
// ControlBranch validates `kind === 'control'`; PiBranch (`z.never()`) rejects
// `kind === 'pi'` and every other kind with a single ZodError.
//
// ### Kind gating across milestones
//
// Today (M2) every successful parse has `kind === 'control'` because the pi
// branch is the always-reject `z.never()` placeholder. From M3 onward a
// successful parse will have `kind ∈ {'control', 'pi'}` once `PiBranch` is
// swapped for a real `z.discriminatedUnion('type', [...9 pi schemas...])`.
// Consumers MUST narrow on `kind` before switching on `type` (or use the
// discriminatedUnion on the appropriate branch) — an outer
// `discriminatedUnion('kind', ...)` is not used here for the reason given
// above, so the kind branch happens at parse time, not type-narrowing time.
import { z } from 'zod';

/** Single source of truth for the protocol version. Bumping it is a wire
 *  breaking change — every consumer must opt in (see envelope.md §版本化). */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

const VersionLiteral = z.literal(PROTOCOL_VERSION);

/** Enum literal collections — `as const` tuples so consumers can derive both
 *  the runtime array (`KINDS`) and the union type (`Kind`). Exported for
 *  exhaustive `switch` narrowing and for test assertions that need to enumerate
 *  every legal value without re-listing it in the test file. */

export const KINDS = ['control', 'pi'] as const;
export type Kind = (typeof KINDS)[number];

export const CONTROL_TYPES = ['handshake', 'ping', 'pong', 'bridge_status', 'error'] as const;
export type ControlType = (typeof CONTROL_TYPES)[number];

/** Role a peer assumes on the tunnel. `web` is a browser-originated session;
 *  `bridge` is a Node daemon in front of a local pi process. */
export const ROLES = ['web', 'bridge'] as const;
export type Role = (typeof ROLES)[number];

/** Bridge status reasons — emitted by the worker DO (control.md §4). */
export const BRIDGE_STATUS_REASONS = ['connected', 'closed', 'stale'] as const;
export type BridgeStatusReason = (typeof BRIDGE_STATUS_REASONS)[number];

/** Wire-level error codes — the set is additive-only and never reused
 *  (control.md §8). `terminal: true` means the connection is dropped after
 *  delivery (WebSocket close code 1008). */
export const ERROR_CODES = [
  'auth_failed',
  'duplicate_bridge',
  'invalid_envelope',
  'unsupported_version',
  'unsupported_type',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Control-family payload schemas (control.md §1 / §2 / §3 / §4 / §8)
// ---------------------------------------------------------------------------

/** Handshake payload — `role` (web/bridge) + `token` (auth, min length 1). */
export const HandshakePayloadSchema = z.object({
  role: z.enum(ROLES),
  token: z.string().min(1),
});
export type HandshakePayload = z.infer<typeof HandshakePayloadSchema>;

/** Ping payload — optional `nonce` for pong correlation. */
export const PingPayloadSchema = z.object({
  nonce: z.string().optional(),
});
export type PingPayload = z.infer<typeof PingPayloadSchema>;

/** Pong payload — `nonce` is REQUIRED (vs ping's optional). The nonce is the
 *  pairing key; `reply_to` is NOT used for ping/pong (control.md §3 设计理由). */
export const PongPayloadSchema = z.object({
  nonce: z.string(),
});
export type PongPayload = z.infer<typeof PongPayloadSchema>;

/** BridgeStatus payload — bridge online state + ISO timestamp + reason.
 *  `changed_at` is validated as an ISO 8601 datetime string (control.md §4).
 *  The schema accepts any sub-second precision — including the millisecond
 *  form `2026-09-05T10:00:00.123Z` that `Date.prototype.toISOString()`
 *  always emits — but stays UTC-only (offsets like `+00:00` are rejected).
 *  We pass `{ precision: null }` explicitly so the contract is unambiguous
 *  to readers and survives any future zod default-precision changes; the
 *  current zod default already accepts any precision, but spelling it out
 *  documents intent. Offset forms are out of v1 scope. */
export const BridgeStatusPayloadSchema = z.object({
  online: z.boolean(),
  changed_at: z.string().datetime({ precision: null }),
  reason: z.enum(BRIDGE_STATUS_REASONS),
});
export type BridgeStatusPayload = z.infer<typeof BridgeStatusPayloadSchema>;

/** Error payload — wire-level error code + human message + terminal flag.
 *  `terminal: true` triggers a fatal close (code 1008) after delivery. */
export const ErrorPayloadSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  terminal: z.boolean().optional(),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

// ---------------------------------------------------------------------------
// Envelope schemas (control family) — each is a complete ZodObject
// ---------------------------------------------------------------------------
//
// Each envelope carries the full wire surface: `v` / `kind: 'control'` / `type`
// / `id` / optional `session` + `reply_to` / `payload`. `session` and
// `reply_to` are M2 placeholders kept for the v1 lock-version (envelope.md
// §锁版承诺) — no M2 message populates them, but the fields are part of the
// schema surface so consumers can ignore unknown keys without surprise.

const EnvelopeBase = {
  v: VersionLiteral,
  kind: z.literal('control'),
  id: z.string().min(1),
  session: z.string().optional(),
  reply_to: z.string().optional(),
};

export const HandshakeEnvelope = z.object({
  ...EnvelopeBase,
  type: z.literal('handshake'),
  payload: HandshakePayloadSchema,
});
export type HandshakeEnvelope = z.infer<typeof HandshakeEnvelope>;

export const PingEnvelope = z.object({
  ...EnvelopeBase,
  type: z.literal('ping'),
  payload: PingPayloadSchema,
});
export type PingEnvelope = z.infer<typeof PingEnvelope>;

export const PongEnvelope = z.object({
  ...EnvelopeBase,
  type: z.literal('pong'),
  payload: PongPayloadSchema,
});
export type PongEnvelope = z.infer<typeof PongEnvelope>;

export const BridgeStatusEnvelope = z.object({
  ...EnvelopeBase,
  type: z.literal('bridge_status'),
  payload: BridgeStatusPayloadSchema,
});
export type BridgeStatusEnvelope = z.infer<typeof BridgeStatusEnvelope>;

export const ErrorEnvelope = z.object({
  ...EnvelopeBase,
  type: z.literal('error'),
  payload: ErrorPayloadSchema,
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

// ---------------------------------------------------------------------------
// Top-level Envelope — union of control family and pi placeholder
// ---------------------------------------------------------------------------

/** Control family — inner `discriminatedUnion('type', [...])`. Consumers who
 *  have narrowed a parsed envelope can `switch (env.type)` on this union. */
export const ControlBranch = z.discriminatedUnion('type', [
  HandshakeEnvelope,
  PingEnvelope,
  PongEnvelope,
  BridgeStatusEnvelope,
  ErrorEnvelope,
]);

/** Pi family placeholder. M2 ships no pi messages; the worker passes every
 *  pi-shaped frame to PiBranch which rejects it (rather than silently
 *  dropping). M3 will replace this with a real
 *  `z.discriminatedUnion('type', [...9 pi schemas...])` — the placeholder
 *  exists because zod's `discriminatedUnion` requires at least one entry. */
export const PiBranch = z.never();

/** Top-level Envelope. Successful parses are always `kind === 'control'` in
 *  M2 (the pi branch never validates). See module-level note for why the
 *  outer container is `z.union`, not `z.discriminatedUnion`. */
export const Envelope = z.union([ControlBranch, PiBranch]);
export type Envelope = z.infer<typeof Envelope>;
