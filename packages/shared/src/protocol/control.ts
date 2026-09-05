// RemotePi tunnel protocol v1 — control-family payload schemas + envelope
// schemas.
//
// Wire layout (see docs/architecture/protocol/control.md):
//   { v: 1, kind: "control", type, id, session?, reply_to?, payload }
//
// ## File contents
//
// Every control-family payload schema and its envelope wrapper live here:
//   - 5 carried-over payloads (Handshake / Ping / Pong / BridgeStatus /
//     Error) — previously in `envelope.ts`; moved here in M3 to free the
//     top-level `envelope.ts` for envelope-only cross-cutting state.
//   - 3 new payloads (SessionState / Result / GetState) added in M3 to
//     support web-side session-state queries and the unified `result`
//     reply shape, plus the `session_state.blocked_on` field.
//
// The 9 envelope schemas (`HandshakeEnvelope` … `ErrorEnvelope`) form a
// `discriminatedUnion('type', …)` exported as `ControlBranch` and
// consumed by `envelope.ts` to build the top-level `Envelope`. This
// file owns the per-schema definitions; `envelope.ts` owns the union
// that ties `ControlBranch` / `PiBranch` / `Envelope` together.
//
// Naming contract (M1): envelope Zod schema + derived type share the
// same name (XxxEnvelope); payload Zod schema uses the `Schema` suffix
// (XxxPayloadSchema); payload derived type has no suffix (XxxPayload).
import { z } from 'zod';
import { BlockedOnEntryPayloadSchema } from './block-on.js';
import { EnvelopeBaseControl } from './envelope-base.js';
import { BRIDGE_STATUS_REASONS, ERROR_CODES, ROLES, SESSION_PHASES } from './literals.js';

// ---------------------------------------------------------------------------
// M2 control payloads (carried over from envelope.ts)
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
// SessionList payload (carried over from M2; session_state was renamed in M3)
// ---------------------------------------------------------------------------

/** SessionList payload — currently always the empty object. Future filter
 *  fields (e.g. `cwd` for directory scoping) will be added as optional
 *  fields under envelope evolution rule (a). */
export const SessionListPayloadSchema = z.object({});
export type SessionListPayload = z.infer<typeof SessionListPayloadSchema>;

// ---------------------------------------------------------------------------
// M3 control payloads (new in this milestone)
// ---------------------------------------------------------------------------

/** SessionState payload — pi subprocess lifecycle phase plus optional
 *  array of currently-pending extension UI requests.
 *
 *  `phase` enumerates the 5 lock-versioned states (see
 *  [[architecture/protocol/control.md#5-session_state]] and
 *  `SESSION_PHASES` in `literals.ts`): spawning / ready / running /
 *  idle / exited. No new phases are added in M3 — the 5-value enum is
 *  carried over verbatim from the v1 lock.
 *
 *  `blocked_on` is an additive optional array (envelope evolution
 *  rule (a)): absence is equivalent to an empty array. Each element is
 *  a `BlockedOnEntryPayload` — see `block-on.ts` for the 4-method
 *  discriminated union. The bridge is the source of truth for this
 *  queue; the worker forwards `session_state` frames verbatim without
 *  inspecting the array. */
export const SessionStatePayloadSchema = z.object({
  phase: z.enum(SESSION_PHASES),
  blocked_on: z.array(BlockedOnEntryPayloadSchema).optional(),
});
export type SessionStatePayload = z.infer<typeof SessionStatePayloadSchema>;

/** GetState payload — always empty `{}`. The session-state query is a
 *  presence-style RPC ("what is the current phase + blocked_on set?")
 *  with no client-supplied parameters; future filter fields would be
 *  added here without breaking the lock-version (envelope evolution
 *  rule (a) — additive optional fields only). */
export const GetStatePayloadSchema = z.object({});
export type GetStatePayload = z.infer<typeof GetStatePayloadSchema>;

/** Result payload — unified reply shape for `session_list` (M2) and
 *  `get_state` (M3). Successful replies carry `ok: true` + optional
 *  `data`; failed replies carry `ok: false` + optional `error` with a
 *  `code` from the 6-value lock-versioned `ERROR_CODES` set.
 *
 *  `code` is constrained to the lock-versioned `ERROR_CODES` set —
 *  the M3 unlock deliberately does NOT extend the error vocabulary
 *  (see ADR-0006). New failure modes reuse the closest existing code.
 *
 *  `data` is `z.unknown()` — the field shape varies per requesting
 *  type (`session_list.data.sessions` vs `get_state.data.{phase,
 *  blocked_on?}`) and the shared package does not constrain it. The
 *  caller narrows on `reply_to` (or the original request `type`) and
 *  re-validates the inner shape against the appropriate payload
 *  schema before consuming it. */
export const ResultPayloadSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
    })
    .optional(),
});
export type ResultPayload = z.infer<typeof ResultPayloadSchema>;

// ---------------------------------------------------------------------------
// Control envelope schemas (one per payload above)
// ---------------------------------------------------------------------------
//
// Each envelope carries the full wire surface: `v` / `kind: 'control'` / `type`
// / `id` / optional `session` + `reply_to` / `payload`. `session` and
// `reply_to` are v1-lock-version envelope fields — every consumer must
// ignore unknown envelope keys without surprise.
//
// The shared header shape (`EnvelopeBaseControl`) lives in
// `envelope-base.ts` so control.ts, pi.ts and envelope.ts can all
// spread it without forming an import cycle.

export const HandshakeEnvelope = z.object({
  ...EnvelopeBaseControl,
  type: z.literal('handshake'),
  payload: HandshakePayloadSchema,
});
export type HandshakeEnvelope = z.infer<typeof HandshakeEnvelope>;

export const PingEnvelope = z.object({
  ...EnvelopeBaseControl,
  type: z.literal('ping'),
  payload: PingPayloadSchema,
});
export type PingEnvelope = z.infer<typeof PingEnvelope>;

export const PongEnvelope = z.object({
  ...EnvelopeBaseControl,
  type: z.literal('pong'),
  payload: PongPayloadSchema,
});
export type PongEnvelope = z.infer<typeof PongEnvelope>;

export const BridgeStatusEnvelope = z.object({
  ...EnvelopeBaseControl,
  type: z.literal('bridge_status'),
  payload: BridgeStatusPayloadSchema,
});
export type BridgeStatusEnvelope = z.infer<typeof BridgeStatusEnvelope>;

/** SessionState envelope — broadcast by the bridge whenever the
 *  pi subprocess phase changes or `blocked_on` membership changes.
 *  The `session` envelope field disambiguates which conversation the
 *  state belongs to (relevant once M4 introduces multi-session); in M3
 *  single-session mode it is typically absent but is part of the v1
 *  wire surface. */
export const SessionStateEnvelope = z.object({
  ...EnvelopeBaseControl,
  type: z.literal('session_state'),
  payload: SessionStatePayloadSchema,
});
export type SessionStateEnvelope = z.infer<typeof SessionStateEnvelope>;

/** SessionList envelope — web → bridge query, reply comes back as
 *  `result` (see `ResultEnvelope`). Payload is the empty object
 *  today; future filter fields (e.g. `cwd` for directory scoping)
 *  will be added as optional fields under envelope evolution rule (a). */
export const SessionListEnvelope = z.object({
  ...EnvelopeBaseControl,
  type: z.literal('session_list'),
  payload: SessionListPayloadSchema,
});
export type SessionListEnvelope = z.infer<typeof SessionListEnvelope>;

/** GetState envelope — web → bridge query for the current session
 *  state. Reply comes back as `result` with
 *  `data = { phase, blocked_on? }` (see `GetStatePayloadSchema` /
 *  `SessionStatePayloadSchema`). Payload is empty `{}`; the type was
 *  added in M3 as a deliberate unlock of the v1 control-family
 *  `no new types` commitment — see ADR-0006 for the rationale. */
export const GetStateEnvelope = z.object({
  ...EnvelopeBaseControl,
  type: z.literal('get_state'),
  payload: GetStatePayloadSchema,
});
export type GetStateEnvelope = z.infer<typeof GetStateEnvelope>;

/** Result envelope — unified reply for `session_list` (M2) and
 *  `get_state` (M3). `reply_to` MUST be set to the request's `id`.
 *  Successful replies carry `ok: true` + optional `data`; failed
 *  replies carry `ok: false` + `error` (with `code` from the 6-value
 *  lock-versioned `ERROR_CODES` set — no new codes allowed in M3). */
export const ResultEnvelope = z.object({
  ...EnvelopeBaseControl,
  type: z.literal('result'),
  payload: ResultPayloadSchema,
});
export type ResultEnvelope = z.infer<typeof ResultEnvelope>;

export const ErrorEnvelope = z.object({
  ...EnvelopeBaseControl,
  type: z.literal('error'),
  payload: ErrorPayloadSchema,
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

// ---------------------------------------------------------------------------
// ControlBranch — the discriminated union of all control-family envelopes
// ---------------------------------------------------------------------------

/** Control family — inner `discriminatedUnion('type', [...])`. Consumers
 *  who have narrowed a parsed envelope on `kind === 'control'` can
 *  `switch (env.type)` on this union to access per-type payload fields. */
export const ControlBranch = z.discriminatedUnion('type', [
  HandshakeEnvelope,
  PingEnvelope,
  PongEnvelope,
  BridgeStatusEnvelope,
  SessionStateEnvelope,
  SessionListEnvelope,
  GetStateEnvelope,
  ResultEnvelope,
  ErrorEnvelope,
]);
export type ControlBranch = z.infer<typeof ControlBranch>;
