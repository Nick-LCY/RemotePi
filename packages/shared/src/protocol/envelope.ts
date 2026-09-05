// RemotePi tunnel protocol v1 — top-level envelope structure.
//
// Wire layout (see docs/architecture/protocol/envelope.md):
//   { v: 1, kind: "control"|"pi", type, id, session?, reply_to?, payload }
//
// ## File contents (M3 split)
//
// M2 kept every control-family payload schema + envelope + the top-level
// `Envelope` union in this one file. M3 splits it so each family owns its
// own envelope / payload schemas:
//
//   - `./literals.ts`        — all enum literals (`KINDS`, `CONTROL_TYPES`
//                              including `get_state`, `SESSION_PHASES`,
//                              `ERROR_CODES`, …) and `PROTOCOL_VERSION`.
//                              Leaf module with no protocol-internal
//                              imports.
//   - `./envelope-base.ts`   — `VersionLiteral` + `EnvelopeBaseControl` /
//                              `EnvelopeBasePi` shared header shapes.
//   - `./block-on.ts`        — `BLOCK_ON_METHODS` + `BlockedOnEntryPayload
//                              Schema` (4-method discriminated union) +
//                              `ExtensionUIResponsePayloadSchema` (web wire
//                              shape).
//   - `./control.ts`         — 9 control envelopes + their payload schemas
//                              + `ControlBranch` discriminated union.
//   - `./pi.ts`              — 9 pi envelopes + their payload schemas +
//                              `PiBranch` discriminated union.
//
// This file (`envelope.ts`) is the assembly point: it re-exports the
// literal constants (so `@remotepi/shared` consumers continue to import
// them from a stable surface) and defines the top-level `Envelope = z
// .union([ControlBranch, PiBranch])`.
//
// ## Naming contract (M1)
//
// Reiterated here so future maintainers find it at the top of the
// package's defining file:
//   - envelope Zod schema and derived type share the same name
//     (XxxEnvelope — e.g. `HandshakeEnvelope`, `PromptEnvelope`);
//   - payload Zod schema uses the `Schema` suffix (XxxPayloadSchema —
//     e.g. `HandshakePayloadSchema`);
//   - payload derived type has no suffix (XxxPayload — e.g.
//     `HandshakePayload`).
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
// bridge / web) continue to import them from a single stable module
// path. The barrel at `packages/shared/src/index.ts` further flattens
// this, but having envelope.ts as the canonical re-export keeps any
// direct importer of `./protocol/envelope.js` working unchanged.
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
