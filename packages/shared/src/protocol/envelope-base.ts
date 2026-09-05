// RemotePi tunnel protocol v1 — envelope base shapes shared by both
// `control` and `pi` families.
//
// Two `EnvelopeBase` variants live here:
//   - `EnvelopeBaseControl` — for control-family envelopes
//     (`kind: 'control'`);
//   - `EnvelopeBasePi`     — for pi-family envelopes (`kind: 'pi'`).
//
// Both share `v` / `id` / `session` / `reply_to`; only the `kind` literal
// differs. Splitting the two families into separate shapes (rather than
// one `kind: z.union([z.literal('control'), z.literal('pi')])`) keeps each
// envelope schema a discriminated union member — `EnvelopeBaseControl`
// flows into every `XxxEnvelope` in `control.ts`, `EnvelopeBasePi` flows
// into every `YyyEnvelope` in `pi.ts`.
//
// ## Why this lives in its own module
//
// The M3 split puts control-family and pi-family envelope schemas into
// separate files (`control.ts` / `pi.ts`), and the top-level `Envelope`
// union in `envelope.ts` references both via their `ControlBranch` /
// `PiBranch` aliases. If `EnvelopeBase` lived in any of those three
// modules, the other two would have to import from it — a cycle that
// would surface as `EnvelopeBase === undefined` at module evaluation
// time (see the `literals.ts` header for the same reasoning). Pulling
// the base shape into a leaf module with no protocol-internal imports
// breaks the cycle cleanly.
//
// ## Why we don't import `PROTOCOL_VERSION` from `literals.ts`
//
// We do — `VersionLiteral` is initialised from `PROTOCOL_VERSION` so the
// numeric wire value stays single-sourced. The cycle-free path works
// because `literals.ts` is itself a leaf (no protocol-internal imports),
// so importing from it here is safe.
import { z } from 'zod';
import { PROTOCOL_VERSION } from './literals.js';

/** `v` field validator — a literal Zod schema that matches exactly
 *  `PROTOCOL_VERSION`. Bumping `PROTOCOL_VERSION` here automatically
 *  bumps every envelope schema (control + pi). */
export const VersionLiteral = z.literal(PROTOCOL_VERSION);

/** Cross-family envelope header fields shared by every envelope in the v1
 *  wire. The `kind` literal is added per family (see `EnvelopeBaseControl`
 *  / `EnvelopeBasePi`). */
const EnvelopeBaseCommon = {
  v: VersionLiteral,
  id: z.string().min(1),
  session: z.string().optional(),
  reply_to: z.string().optional(),
};

/** Base shape for control-family envelopes (`kind: 'control'`). Spread
 *  into each `XxxEnvelope` in `control.ts`; the discriminator (`type`)
 *  is set by the per-envelope schema that consumes this base. */
export const EnvelopeBaseControl = {
  ...EnvelopeBaseCommon,
  kind: z.literal('control'),
};

/** Base shape for pi-family envelopes (`kind: 'pi'`). Spread into each
 *  `XxxEnvelope` in `pi.ts`; the discriminator (`type`) is set by the
 *  per-envelope schema that consumes this base. */
export const EnvelopeBasePi = {
  ...EnvelopeBaseCommon,
  kind: z.literal('pi'),
};
