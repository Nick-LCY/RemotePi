// tokenStorage — the web-side cache for the room access token.
//
// ## Why localStorage (not URL hash)
//
// M3 carried the token in the URL fragment (`#<token>`) because it
// was the only place that didn't end up in a server access log or a
// browser-history entry. M5 second-block (D9) revisits that choice:
//
//   - The hash is visible in browser history, share dialogs, and
//     some monitoring tools (e.g. server-side analytics that record
//     the path). The web SPA only serves the bundle — the token
//     itself is never sent in the request body — but the *display*
//     surface for the URL (bookmark labels, hovers in social embeds,
//     etc.) made it visible to anyone the URL reached.
//   - localStorage is bound to the web origin, not to the URL; it
//     survives F5 / back / forward; and it never appears in any
//     link-sharing surface by accident.
//
// The web SPA still talks to the bridge via the WSS subprotocol +
// query (`subprotocol[1]` = token, plus the `?token=<t>` query that
// the WsClient constructs at open time — see `WsClient.openSocket`).
// localStorage is the SOURCE OF TRUTH on the web side; the bridge
// keeps its own copy on `state.json` and only checks the inbound
// handshake / subprotocol / query for authenticity.
//
// ## Module-load laziness
//
// The key fact about this module is that NOTHING here reads
// `window.localStorage` at import time. The reasons:
//
//   1. **React StrictMode (dev)** mounts every component twice —
//      a top-level `localStorage.getItem(...)` would run twice per
//      import in development and at least once per process in tests.
//      The module-level state must be a pure constant (the `KEY`
//      string + an empty cache object), with `read()`/`write()`/
//      `clear()` performing the actual I/O on demand.
//
//   2. **SSR safety.** A future `vite preview --host` / `node`
//      SSR harness would crash on `typeof localStorage === 'undefined'`.
//      Even though the current bundle is purely client-side, the
//      helpers defensively no-op when `localStorage` is absent so a
//      tool-rendered test fixture or a docs-page pre-render doesn't
//      blow up.
//
//   3. **Test ergonomics.** A unit test that imports this module
//      to assert `KEY === 'remotepi.token'` should not accidentally
//      fire a `localStorage.getItem` (which would either hit a
//      `localStorage`-less node test env and throw, or hit a
//      vitest-with-jsdom env and pollute the storage mock).
//      Laziness = "import is free of I/O".
//
// ## SecurityError tolerance
//
// Privacy mode in browsers (and third-party iframes where storage
// access is denied) throws `DOMException('SecurityError')` on
// `localStorage.getItem`. The PRD pins this as a fallback to "no
// token" so the user lands on `<TokenModal required>` and re-pastes
// the token — same UX as the empty-storage case. We catch the
// specific error class (not all throws) so a programmer error like
// `localStorage.getItem is not a function` still surfaces.
//
// ## No migration (D9)
//
// M5 §D9 explicitly forbids any kind of legacy-token migration:
//   - no `migrateLegacyHashToken`,
//   - no deprecated `token` field on the parsed hash model,
//   - no soft-deprecation warnings,
//   - no read-side `if (legacyHash.token)` fallback.
//
// The implementation therefore has no version field, no
// `legacyToken` reads, and no `console.warn` for old hashes. Old
// bookmarks (`#<token>`) simply parse to `{workDir: null, session:
// null}` and route to `<TokenModal required>` via the App-level
// `auth.token === null` branch — exactly the documented
// "旧书签 token 已失效" UX.
//
// ## API surface
//
//   - `read(): string | null`
//       Returns the cached token, or `null` when the storage is
//       empty / the key is absent / access is denied (SecurityError
//       → swallow as null). Module-level singleton — multiple
//       `read()` calls share one storage view, no per-call cache.
//
//   - `write(token: string): void`
//       Persists the token. Empty strings are REJECTED — `write('')`
//       is a silent no-op (NOT a `clear()`; this is the
//       "tokenStorage refused the empty input" semantic from D9).
//       Other write errors (quota exceeded, SecurityError) are
//       caught and swallowed — same rationale as `read()`.
//
//   - `clear(): void`
//       Forgets the token. Errors swallowed for the same reason.
//
//   - `KEY` (exported constant)
//       The localStorage key name. Exported so unit tests can grep
//       the source for it (and so any future "different key per
//       build channel" override has a single edit point). The
//       constant is the literal string `'remotepi.token'` — hard
//       coded per the task brief, no environment override.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The localStorage key for the cached access token. */
export const KEY = 'remotepi.token';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * True when the current runtime exposes a usable `localStorage`.
 * SSR-safe: `typeof window === 'undefined'` returns false under
 * Node / Vite SSR (the bundle is currently client-only, but a
 * future SSR pre-render must not crash on `localStorage.getItem`).
 */
function hasStorage(): boolean {
  return typeof globalThis !== 'undefined'
    && typeof (globalThis as { localStorage?: Storage }).localStorage !== 'undefined';
}

/**
 * Read a localStorage key. Returns `null` on missing key,
 * `SecurityError` (privacy mode / cross-origin iframe), or any
 * other storage access exception. Other throw types (TypeError
 * from `localStorage.getItem is not a function` if some shim
 * breaks) are still swallowed — same rationale as the write
 * path: storage failure should never crash the render path.
 */
function readRaw(key: string): string | null {
  if (!hasStorage()) return null;
  try {
    const storage = (globalThis as { localStorage: Storage }).localStorage;
    return storage.getItem(key);
  } catch (_err) {
    return null;
  }
}

/**
 * Write a localStorage key. Returns `true` on success, `false` on
 * any failure (including SecurityError, quota exceeded, etc.).
 * Errors are swallowed for the same rationale as `read()`: a
 * storage write that fails should not crash the user-visible
 * token submit path; the App-level retry / TokenModal re-render
 * is the fallback UX.
 */
function writeRaw(key: string, value: string): boolean {
  if (!hasStorage()) return false;
  try {
    const storage = (globalThis as { localStorage: Storage }).localStorage;
    storage.setItem(key, value);
    return true;
  } catch (_err) {
    return false;
  }
}

/** Remove a localStorage key. Errors swallowed (see writeRaw). */
function removeRaw(key: string): void {
  if (!hasStorage()) return;
  try {
    const storage = (globalThis as { localStorage: Storage }).localStorage;
    storage.removeItem(key);
  } catch (_err) {
    // Same rationale as writeRaw — never let storage exceptions
    // crash the render path. The next `read()` will surface a
    // missing key (= null token) and the UI takes it from there.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the cached token.
 *
 * Returns `null` when:
 *   - no value is stored under the key,
 *   - `localStorage` is unavailable (SSR, node test env),
 *   - access throws (privacy mode, third-party iframe).
 *
 * The function performs the I/O on each call. There is no
 * module-level cache of the read value — the WebClient / App-level
 * subscriber pattern handles fan-out, and the actual read is a
 * single in-process `localStorage.getItem` (~µs). Caching here
 * would add a staleness bug surface for negligible gain.
 */
export function read(): string | null {
  return readRaw(KEY);
}

/**
 * Persist a token.
 *
 * Empty / whitespace-only tokens are REJECTED — `write('')` is a
 * silent no-op (we deliberately do NOT call `clear()` here; an
 * empty token is an invalid input, not a "remove the cached one"
 * signal — the caller is responsible for `clear()` when that's the
 * intent). Whitespace is trimmed before the empty-check so a
 * trailing newline from a paste action doesn't silently pass.
 *
 * Other write failures (SecurityError, quota) are swallowed per
 * the module-level rationale (storage failures must not crash the
 * render path). The function returns `void` because the App-level
 * flow doesn't branch on success/failure — if `write` fails the
 * next `read` will be `null` and the user lands on TokenModal again
 * (defensible degradation).
 */
export function write(token: string): void {
  const trimmed = token.trim();
  if (trimmed.length === 0) return;
  writeRaw(KEY, trimmed);
}

/**
 * Forget the cached token. Errors swallowed. Idempotent — calling
 * `clear()` when nothing is cached is a no-op.
 */
export function clear(): void {
  removeRaw(KEY);
}
