// RemotePi tunnel protocol v1 — envelope base shapes shared by both
// `control` and `pi` families.
//
// Two `EnvelopeBase` variants live here:
//   - `EnvelopeBaseControl` — for control-family envelopes
//     (`kind: 'control'`);
//   - `EnvelopeBasePi`     — for pi-family envelopes (`kind: 'pi'`).
//
// Both share `v` / `id` / `session` / `reply_to`; only the `kind` literal
// differs.
//
// ## Why this lives in its own module
//
// `control.ts` and `pi.ts` both spread these base shapes into their
// per-envelope schemas, and `envelope.ts` references both via the
// `ControlBranch` / `PiBranch` aliases. If `EnvelopeBase` lived in any
// of those modules, the other two would have to import from it — a
// cycle that would surface as `EnvelopeBase === undefined` at module
// evaluation time. Pulling the base shape into a leaf module with no
// protocol-internal imports breaks the cycle cleanly.
//
// `literals.ts` is itself a leaf (no protocol-internal imports) and
// provides `PROTOCOL_VERSION`; importing from it here is safe.
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
 *  `YyyEnvelope` in `pi.ts`; the discriminator (`type`) is set by the
 *  per-envelope schema that consumes this base. */
export const EnvelopeBasePi = {
  ...EnvelopeBaseCommon,
  kind: z.literal('pi'),
};
