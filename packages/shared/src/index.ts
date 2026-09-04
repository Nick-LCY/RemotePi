// Public surface of `@remotepi/shared`.
//
// Consumers (bridge / web / worker) should import from this barrel only —
// nothing under `./protocol/*` is part of the supported API. To add a new
// control-family message: define its payload schema + envelope schema in
// `./protocol/envelope.ts` (and append the envelope to the `ControlBranch`
// discriminated union there).
export * from './protocol/envelope.js';
