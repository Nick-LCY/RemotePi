// Public surface of `@remotepi/shared`.
//
// Consumers (bridge / web / worker) should import from this barrel only —
// nothing under `./protocol/*` is part of the supported API directly.
// The four protocol modules each own one slice of the v1 wire surface:
//
//   - `./protocol/envelope.js`  — top-level `Envelope` + all enum literals
//                                 (re-exported from `./protocol/literals.js`);
//   - `./protocol/control.js`   — 9 control envelopes + their payload schemas
//                                 + `ControlBranch`;
//   - `./protocol/pi.js`        — 9 pi envelopes + their payload schemas +
//                                 `PiBranch`;
//   - `./protocol/block-on.js`  — `BlockedOnEntryPayloadSchema` +
//                                 `ExtensionUIResponsePayloadSchema` +
//                                 `BLOCK_ON_METHODS` (shared by both
//                                 `session_state.payload.blocked_on[]`
//                                 elements and the `extension_ui_response`
//                                 envelope payload).
//
// The split mirrors the M3 family split — each family owns its own
// envelope schemas, and the top-level `Envelope` union lives in
// `envelope.ts`. To add a new control-family message: define its payload
// schema + envelope schema in `./protocol/control.ts` and append the
// envelope to the `ControlBranch` discriminated union there. For pi
// additions: same pattern in `./protocol/pi.ts` / `PiBranch`.
export * from './protocol/envelope.js';
export * from './protocol/control.js';
export * from './protocol/pi.js';
export * from './protocol/block-on.js';
