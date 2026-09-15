// Public surface of `@remotepi/shared`.
//
// Consumers (bridge / web / worker) should import from this barrel only —
// nothing under `./protocol/*` is part of the supported API directly.
// The four protocol modules each own one slice of the v1 wire surface:
//
//   - `./protocol/envelope.js`    — top-level `Envelope` + all enum literals
//                                   (re-exported from `./protocol/literals.js`);
//   - `./protocol/control.js`     — control envelopes + their payload schemas
//                                   + `ControlBranch` (M3 unlocked `get_state`;
//                                   M4 added four work-directory types);
//   - `./protocol/pi.js`          — pi envelopes + their payload schemas +
//                                   `PiBranch` (no new types added in M4;
//                                   envelope (a) extends `prompt.payload.work_dir`
//                                   for `session:'new'`);
//   - `./protocol/block-on.js`    — `BlockedOnEntryPayloadSchema` +
//                                   `ExtensionUIResponsePayloadSchema` +
//                                   `BLOCK_ON_METHODS` (shared by both
//                                   `session_state.payload.blocked_on[]`
//                                   elements and the `extension_ui_response`
//                                   envelope payload);
//   - `./protocol/work-dirs.js`   — M4 result schemas for `list_directories`
//                                   and `work_dir_list` replies +
//                                   request payload schemas for all four new
//                                   control types (re-imported by `control.js`
//                                   for the envelope wrappers);
//   - `./protocol/session-list.js` — M4 `session_list.result.data.sessions[]`
//                                   revalidation schemas (`SessionListEntrySchema`
//                                   carries the new `status` 5-enum field).
//
// To add a new control-family message: keep the payload shape and any
// result revalidation schema in a dedicated submodule (for example,
// `protocol/work-dirs.ts` / `protocol/session-list.ts`) so `control.ts`
// stays compact; keep the envelope wrapper and `ControlBranch`
// registration in `./protocol/control.ts`. For pi additions: same
// pattern in `./protocol/pi.ts` / `PiBranch`.
export * from './protocol/envelope.js';
export * from './protocol/control.js';
export * from './protocol/pi.js';
export * from './protocol/block-on.js';
export * from './protocol/work-dirs.js';
export * from './protocol/session-list.js';
