// Envelope: the wire-level message shape that every RemotePi peer emits and
// accepts. Every message on the tunnel — handshake, keepalive, business — is
// a single `Envelope` value with a discriminator `kind`.
//
// M1 ships three kinds (hello / ping / echo) per `docs/prds/m1-infrastructure.md` §2.
// To add a kind in M2+:
//   1. Define its payload schema in `./messages.ts`.
//   2. Define a `XxxEnvelope` z.object below (must keep the `kind` literal so
//      `discriminatedUnion` keeps working).
//   3. Append it to `Envelope` below.
import { z } from 'zod';
import { EchoPayloadSchema, HelloPayloadSchema, PingPayloadSchema } from './messages.js';

/** Single source of truth for the protocol version. Bumping it is a wire
 *  breaking change — every consumer must opt in. */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

const VersionLiteral = z.literal(PROTOCOL_VERSION);

/** A Hello envelope — the opening frame on a fresh tunnel. */
export const HelloEnvelope = z.object({
  v: VersionLiteral,
  kind: z.literal('hello'),
  id: z.string(),
  payload: HelloPayloadSchema,
});
export type HelloEnvelope = z.infer<typeof HelloEnvelope>;

/** A Ping envelope — outbound liveness probe (optionally carrying a nonce). */
export const PingEnvelope = z.object({
  v: VersionLiteral,
  kind: z.literal('ping'),
  id: z.string(),
  payload: PingPayloadSchema,
});
export type PingEnvelope = z.infer<typeof PingEnvelope>;

/** An Echo envelope — liveness reply, echoes the peer's Ping nonce. */
export const EchoEnvelope = z.object({
  v: VersionLiteral,
  kind: z.literal('echo'),
  id: z.string(),
  payload: EchoPayloadSchema,
});
export type EchoEnvelope = z.infer<typeof EchoEnvelope>;

/** Discriminated union of every message the tunnel understands. */
export const Envelope = z.discriminatedUnion('kind', [HelloEnvelope, PingEnvelope, EchoEnvelope]);
export type Envelope = z.infer<typeof Envelope>;

/*
 * Payload types (`EchoPayload`, `HelloPayload`, `PingPayload`) live in
 * `messages.ts` and reach consumers via the barrel's `export * from
 * './protocol/messages.js'`. They are not re-exported from this module to
 * avoid a parallel alias layer.
 */
