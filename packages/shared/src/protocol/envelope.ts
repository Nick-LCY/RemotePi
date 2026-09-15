// RemotePi tunnel protocol v1 — top-level envelope structure.
//
// Wire layout (see docs/architecture/protocol/envelope.md):
//   { v: 1, kind: "control"|"pi", type, id, session?, reply_to?, payload }
//
// ## File contents
//
// This file is the assembly point: it re-exports the literal constants
// (so `@remotepi/shared` consumers continue to import them from a
// stable surface) and defines the top-level `Envelope = z.union([ControlBranch,
// PiBranch])`. Per-family schemas live in:
//
//   - `./literals.ts`        — enum literals + `PROTOCOL_VERSION` (leaf module).
//   - `./envelope-base.ts`   — `VersionLiteral` + `EnvelopeBaseControl` /
//                              `EnvelopeBasePi` shared header shapes.
//   - `./block-on.ts`        — `BLOCK_ON_METHODS` + `BlockedOnEntryPayloadSchema`
//                              (4-method discriminated union) +
//                              `ExtensionUIResponsePayloadSchema`.
//   - `./work-dirs.ts`       — M4 work-dir-related request payloads +
//                              result-data revalidation schemas.
//   - `./session-list.ts`    — M4 `SessionListEntrySchema` + `SessionListResultSchema`.
//   - `./control.ts`         — control envelopes + `ControlBranch` discriminated union.
//   - `./pi.ts`              — pi envelopes + `PiBranch` discriminated union.
//
// ## Naming contract
//
//   - envelope Zod schema and derived type share the same name (XxxEnvelope);
//   - payload Zod schema uses the `Schema` suffix (XxxPayloadSchema);
//   - payload derived type has no suffix (XxxPayload).
//
// ## Top-level structure
//
// The top-level `Envelope` is a `z.union([ControlBranch, PiBranch])`, not
// `z.discriminatedUnion('kind', [...])`. zod's discriminatedUnion walks
// each option's `.shape[discriminator]` to build the literal → branch
// lookup, and only plain ZodObjects expose `.shape` — a nested
// `discriminatedUnion` (the `ControlBranch` / `PiBranch` themselves)
// does not. z.union preserves the same kind-gating: `ControlBranch`
// validates `kind === 'control'`; `PiBranch` validates `kind === 'pi'`.
// Every successful parse therefore has `kind ∈ {'control', 'pi'}`.
//
// Consumers MUST narrow on `kind` before switching on `type` (or use the
// discriminatedUnion on the appropriate branch) — the outer kind branch
// happens at parse time, not at type-narrowing time.

import { z } from 'zod';
import { ControlBranch } from './control.js';
import { PiBranch } from './pi.js';

// Re-export every literal so `@remotepi/shared` consumers (worker /
// bridge / web) continue to import them from a single stable module path.
export {
  BRIDGE_STATUS_REASONS,
  CONTROL_TYPES,
  ERROR_CODES,
  KINDS,
  PROTOCOL_VERSION,
  ROLES,
  SESSION_PHASES,
} from './literals.js';
export type {
  BridgeStatusReason,
  ControlType,
  ErrorCode,
  Kind,
  ProtocolVersion,
  Role,
  SessionPhase,
} from './literals.js';

/** Top-level Envelope. Every successful parse has
 *  `kind ∈ {'control', 'pi'}`. See module-level note for why this is a
 *  `z.union` rather than a `z.discriminatedUnion('kind', ...)`. */
export const Envelope = z.union([ControlBranch, PiBranch]);
export type Envelope = z.infer<typeof Envelope>;
