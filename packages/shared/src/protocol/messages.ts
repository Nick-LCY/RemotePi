// Payload schemas for the RemotePi tunnel envelope.
//
// M1 ships the minimal triple (Hello / Ping / Echo) needed for end-to-end
// smoke testing. New message payloads land here as additional `z.object(...)`
// exports; their containing envelopes are then appended to the discriminated
// union in `./envelope.ts`.
import { z } from 'zod';

/**
 * Role a peer assumes on the tunnel. `web` is a browser-originated session;
 * `bridge` is a Node daemon sitting in front of a local pi process.
 */
export const RoleSchema = z.enum(['web', 'bridge']);
export type Role = z.infer<typeof RoleSchema>;

/** First frame sent after the tunnel is established. `token` is optional in M1
 *  and becomes mandatory in M2 once the auth handshake lands. */
export const HelloPayloadSchema = z.object({
  role: RoleSchema,
  token: z.string().optional(),
});
export type HelloPayload = z.infer<typeof HelloPayloadSchema>;

/** Liveness probe — empty payload (or an optional nonce for echo correlation). */
export const PingPayloadSchema = z.object({
  nonce: z.string().optional(),
});
export type PingPayload = z.infer<typeof PingPayloadSchema>;

/** Liveness reply; carries the nonce the peer sent in its Ping. */
export const EchoPayloadSchema = z.object({
  nonce: z.string(),
});
export type EchoPayload = z.infer<typeof EchoPayloadSchema>;
