// Token generation + share-URL helpers for the bridge daemon.
//
// `generateToken()` produces a 192-bit (24-byte) random secret encoded as
// base64url — that's 32 characters drawn from [A-Za-z0-9_-], matching the
// URL-fragment + WebSocket-subprotocol usage without escaping. We use
// Node's built-in `crypto.randomBytes` rather than pulling in nanoid or
// similar — the bridge has no other runtime deps (envelope.md §锁版承诺
// specifies base64url chars are a strict subset of what subprotocols and
// URL fragments accept).
//
// `shareUrl(token, base?)` builds the human-facing link users paste into
// the web UI. The default base points at the production worker domain —
// the web SPA is served from the same origin via Worker Static Assets
// (see [[prds/m2-tunnel.md|M2 PRD §方案 / §5 infra]]); dev callers can
// override (e.g. `http://localhost:5173` for the Vite server). The token
// is appended as a URL fragment so it never reaches the server in a
// referer header (cf. M2 PRD §2: token only travels via subprotocol on
// the bridge side; on the web side the equivalent is the URL hash).
//
// 2026-09-05: base flipped from `https://web.remote-pi.sankabox.com` to
// `https://remote-pi.sankabox.com` after the web app was merged into the
// main domain (the `web.` subdomain + Pages project were retired). The
// token URL hash convention is unchanged; only the host changed.
import { randomBytes } from 'node:crypto';

const DEFAULT_WEB_BASE = 'https://remote-pi.sankabox.com';

/** Base64url alphabet — `[A-Za-z0-9_-]`. Exported so the token-shape unit
 *  test can assert against it without re-listing the 64 chars. */
export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 24 bytes of entropy → 32 base64url characters (24 * 4 / 3 = 32, no
 *  padding needed). The 32-character length is part of the test contract. */
const TOKEN_BYTES = 24;

/** Generate a fresh 32-char base64url token. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Build the share URL for the given token. The token is appended as a URL
 *  fragment so the receiving page can read it client-side without it
 *  appearing in any server-side log. */
export function shareUrl(token: string, base: string = DEFAULT_WEB_BASE): string {
  // Strip any trailing slash on the base so the output always has exactly
  // one `/` before the fragment — defensive against callers that pass
  // either form.
  const normalized = base.replace(/\/+$/, '');
  return `${normalized}/#${token}`;
}
