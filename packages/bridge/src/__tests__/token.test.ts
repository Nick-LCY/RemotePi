// Vitest specs for the token helpers (`token.ts`) — covers PRD §6 / task
// cases 1, 2, 3. The remaining cases (4–8) live in `client.test.ts` and
// `index.test.ts` alongside the module they exercise.
//
// Style mirrors `packages/shared/src/protocol/__tests__/envelope.test.ts`:
// one numbered `it` per PRD case, no shared mutable state across cases,
// assertions spelled out so failures point at the property that broke.

import { describe, expect, it } from 'vitest';
import { BASE64URL_PATTERN, generateToken, shareUrl } from '../token.js';

// Exactly 32 chars (24 random bytes → 32 base64url chars, no padding).
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

describe('token (3 cases per M2 PRD §6)', () => {
  it('1. generateToken() returns a 32-char base64url string', () => {
    // Run the helper a handful of times — the property must hold for
    // every draw, not just one lucky one.
    for (let i = 0; i < 8; i++) {
      const token = generateToken();
      expect(token).toMatch(TOKEN_PATTERN);
      // Length check is redundant with the regex but reads clearer in
      // failure output, so we keep it.
      expect(token).toHaveLength(32);
      // Charset is also redundant with the regex but serves as a tripwire
      // if someone ever weakens the regex without thinking.
      expect(BASE64URL_PATTERN.test(token)).toBe(true);
    }
  });

  it('2. two generateToken() calls produce different strings', () => {
    // 192 bits of entropy makes a collision astronomically unlikely;
    // failure here would mean the RNG is broken or seeded deterministically.
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });

  it('3. shareUrl(token) builds the expected URL with the default base', () => {
    // The default base points at production; PRD §2 specifies it exactly.
    // 2026-09-05: host flipped from web.remote-pi.sankabox.com to the main
    // domain — the web SPA now lives at remote-pi.sankabox.com (Static
    // Assets merged with the worker) so the share URL points at the
    // single canonical host.
    expect(shareUrl('abc')).toBe('https://remote-pi.sankabox.com/#abc');

    // The `base` arg lets dev callers point at the local Vite server
    // (PRD §2 + task completion criterion: "dev 默认 `http://localhost:5173`").
    expect(shareUrl('abc', 'http://localhost:5173')).toBe('http://localhost:5173/#abc');

    // Defensive: a trailing slash on the base must NOT produce `//#`.
    expect(shareUrl('abc', 'https://remote-pi.sankabox.com/')).toBe(
      'https://remote-pi.sankabox.com/#abc',
    );

    // The full token (not just the prefix) is appended verbatim.
    const full = generateToken();
    const url = shareUrl(full);
    expect(url).toBe(`https://remote-pi.sankabox.com/#${full}`);
  });
});
