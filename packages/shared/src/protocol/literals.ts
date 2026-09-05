// RemotePi tunnel protocol v1 — top-level enum literals.
//
// All `as const` tuples and their derived union types live here, in their
// own module with no imports. Extracting these to a leaf module breaks the
// circular-import chain that the M3 split introduces:
//
//   envelope.ts  →  control.ts  →  envelope.ts   (cycle)
//
// If envelope.ts owned these literals and control.ts needed them at module
// evaluation time (e.g. `z.enum(SESSION_PHASES)` for `SessionStatePayload
// Schema`), the cycle would surface as `SESSION_PHASES === undefined` when
// control.ts is loaded as a transitive dependency of envelope.ts. Pulling
// the literals out lets every other protocol module import from this file
// without forming a cycle.
//
// Naming contract (M1): literal arrays are `Xxx` / `XxxS` (no `Schema`
// suffix — they aren't Zod schemas, they're plain tuple sources for
// `z.enum(...)` and `z.literal(...)`).
//
// Naming convention rationale (envelope / control / pi do not have `Schema`
// suffix): they are not standalone Zod schemas, they are literal tuple
// sources that feed the `z.enum` / `z.literal` schemas declared in the
// owning module. Adding the `Schema` suffix here would conflict with the
// existing pattern (`BridgeStatusPayloadSchema` is the schema, not the
// `(connected|closed|stale)` tuple that feeds it).

/** Single source of truth for the protocol version. Bumping it is a wire
 *  breaking change — every consumer must opt in (see envelope.md §版本化). */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Two protocol families — every envelope has exactly one `kind`
 *  discriminator. */
export const KINDS = ['control', 'pi'] as const;
export type Kind = (typeof KINDS)[number];

/** All legal control-family `type` values. M3 adds `get_state` (8 → 9) as
 *  a deliberate unlock of the v1 control-family `no new types` commitment —
 *  see [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]]
 *  for the rationale. The remaining 8 (`handshake`, `ping`, `pong`,
 *  `bridge_status`, `session_state`, `session_list`, `result`, `error`)
 *  are carried over verbatim from the M2 lock. */
export const CONTROL_TYPES = [
  'handshake',
  'ping',
  'pong',
  'bridge_status',
  'session_state',
  'session_list',
  'get_state',
  'result',
  'error',
] as const;
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

/** Pi subprocess lifecycle phases. Enumerated in control.md §5 and consumed
 *  by `session_state.payload.phase` and `get_state` reply `data.phase`.
 *  M3 does NOT introduce new phases — the 5-value enum is carried over
 *  verbatim from the M2 lock. Order is significant for monotonic state
 *  machine assertions in bridge tests; do not reorder without updating
 *  those assertions. */
export const SESSION_PHASES = ['spawning', 'ready', 'running', 'idle', 'exited'] as const;
export type SessionPhase = (typeof SESSION_PHASES)[number];
