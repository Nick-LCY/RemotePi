// Public surface of `@remotepi/shared`.
//
// Consumers (bridge / web / worker) should import from this barrel only —
// nothing under `./protocol/*` is part of the supported API. Add a new
// message by extending the discriminated union in `./protocol/envelope.ts`
// and re-exporting any new payload types below.
export * from './protocol/messages.js';
export * from './protocol/envelope.js';
