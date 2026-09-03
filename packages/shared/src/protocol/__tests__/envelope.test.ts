// Vitest specs for the M1 envelope prototype. Five scenarios:
//   1. A well-formed Hello envelope parses and narrows to the Hello variant.
//   2. A version mismatch (v: 2) is rejected with a ZodError.
//   3. An unknown kind discriminator is rejected with a ZodError.
//   4. An unsupported Hello `role` value is rejected with a ZodError.
//   5. A missing top-level `id` is rejected with a ZodError.
//
// These cases are the smoke test that the discriminated union + literal
// version gate + payload enums wire up correctly. New message kinds added
// in M2 should grow matching cases here.
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { Envelope, type HelloEnvelope } from '../envelope.js';

describe('Envelope (M1 prototype)', () => {
  it('parses a legal hello envelope and narrows to the Hello variant', () => {
    const parsed = Envelope.parse({
      v: 1,
      kind: 'hello',
      id: 'msg-001',
      payload: { role: 'web' },
    });

    // Discriminator narrowing — the `kind` check collapses `Envelope` down to
    // `HelloEnvelope`, which lets us assign to that type and access the
    // Hello-only payload fields without further casts.
    if (parsed.kind !== 'hello') {
      throw new Error(`expected hello variant, got ${parsed.kind}`);
    }
    const hello: HelloEnvelope = parsed;
    expect(hello.kind).toBe('hello');
    expect(hello.id).toBe('msg-001');
    expect(hello.v).toBe(1);
    expect(hello.payload.role).toBe('web');
    expect(hello.payload.token).toBeUndefined();
  });

  it('rejects an envelope whose version does not match PROTOCOL_VERSION', () => {
    expect(() =>
      Envelope.parse({
        v: 2,
        kind: 'hello',
        id: 'msg-002',
        payload: { role: 'bridge' },
      }),
    ).toThrow(ZodError);
  });

  it('rejects an envelope whose `kind` is not a known discriminator', () => {
    expect(() =>
      Envelope.parse({
        v: 1,
        kind: 'unknown',
        id: 'msg-003',
        payload: {},
      }),
    ).toThrow(ZodError);
  });

  it('rejects a hello envelope whose `role` is not in the RoleSchema enum', () => {
    // `admin` is intentionally not part of the protocol's role vocabulary
    // (`RoleSchema` enumerates only `web` / `bridge`). A wire frame that
    // claims an unsupported role must be refused before any state mutation.
    expect(() =>
      Envelope.parse({
        v: 1,
        kind: 'hello',
        id: 'msg-004',
        payload: { role: 'admin' },
      }),
    ).toThrow(ZodError);
  });

  it('rejects a hello envelope that omits the top-level `id`', () => {
    // `id` is the per-message correlation key every handler relies on, so a
    // frame without it cannot be routed and must be rejected at the boundary.
    expect(() =>
      Envelope.parse({
        v: 1,
        kind: 'hello',
        payload: { role: 'web' },
      }),
    ).toThrow(ZodError);
  });
});
