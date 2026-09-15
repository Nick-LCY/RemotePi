// tokenStorage — the web-side cache for the room access token.
//
// ## Why localStorage (not URL hash)
//
// M3 carried the token in the URL fragment. That made the token
// visible in browser history, share dialogs, and any path-logging
// analytics. M5 §D9 moved it to localStorage — bound to the web
// origin, survives F5 / back / forward, and never appears in any
// link-sharing surface by accident. The token still flows to the
// bridge via the WSS subprotocol + `?token=<t>` query at handshake
// time; localStorage is the web-side source of truth.
//
// ## Module-load laziness
//
// NOTHING here reads `window.localStorage` at import time. The
// reasons:
//   1. React StrictMode (dev) mounts every component twice — a
//      top-level `localStorage.getItem` would run twice per import
//      in dev and once per process in tests.
//   2. SSR safety — a future SSR pre-render or `vite preview`
//      harness must not crash on `typeof localStorage === 'undefined'`.
//   3. Test ergonomics — importing this module to assert on `KEY`
//      should not fire a `localStorage.getItem` (which would either
//      hit a `localStorage`-less node env or pollute a jsdom mock).
//
// All I/O happens inside `read()` / `write()` / `clear()`.
//
// ## SecurityError tolerance
//
// Privacy mode and cross-origin iframes throw `SecurityError` on
// `localStorage.getItem` / `setItem`. Failures map to "no token"
// so the user lands on `<TokenModal required>` and re-pastes —
// same UX as the empty-storage case. A programmer error like
// `localStorage.getItem is not a function` is still swallowed by
// the same try/catch (storage failure must not crash the render
// path).
//
// ## No migration
//
// D9 forbids any kind of legacy-token migration. The module has no
// version field, no `legacyToken` reads, and no warning for old
// hashes. Old bookmarks parse to `{workDir: null, session: null}`
// and route to `<TokenModal required>` via the App-level
// `auth.token === null` branch.
//
// ## API surface
//
//   - `read(): string | null`
//       The cached token, or `null` when storage is empty / key
//       absent / access is denied. No module-level cache — the
//       WsClient / App-level subscriber pattern handles fan-out
//       and the actual read is a single in-process
//       `localStorage.getItem` (~µs).
//
//   - `write(token: string): boolean`
//       Persists the token. Empty / whitespace-only tokens are
//       REJECTED — `write('')` returns `false` as a silent no-op
//       (this is "tokenStorage refused the empty input", NOT a
//       `clear()`; an empty token is an invalid input, not a
//       "remove the cached one" signal — callers wanting to clear
//       call `clear()` explicitly). The boolean return value
//       distinguishes persisted from rejected so the App flow can
//       surface an inline error UX ("浏览器禁用了本地存储，无法
//       保存 token") instead of silently reloading onto the same
//       TokenModal flash.
//
//   - `clear(): void`
//       Forgets the token. Idempotent — calling on an empty cache
//       is a no-op. Errors swallowed.
//
//   - `KEY`
//       The localStorage key name (literal `'remotepi.token'`).
//       Exported so tests can grep the source.

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
 * Read a localStorage key. Returns `null` on missing key or any
 * storage access exception (SecurityError, etc.).
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
 * any failure (SecurityError, quota exceeded, etc.).
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

/** Remove a localStorage key. Errors swallowed. */
function removeRaw(key: string): void {
  if (!hasStorage()) return;
  try {
    const storage = (globalThis as { localStorage: Storage }).localStorage;
    storage.removeItem(key);
  } catch (_err) {
    // Storage failure must never crash the render path. The next
    // `read()` will surface a missing key (= null token) and the
    // UI takes it from there.
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
 * Empty / whitespace-only tokens are REJECTED — `write('')` returns
 * `false` as a silent no-op (we deliberately do NOT call `clear()`
 * here; an empty token is an invalid input, not a "remove the
 * cached one" signal — the caller is responsible for `clear()`
 * when that's the intent). Whitespace is trimmed before the
 * empty-check so a trailing newline from a paste action doesn't
 * silently pass.
 *
 * Other write failures (SecurityError, quota) are also returned as
 * `false`. The `boolean` return value lets the App-level flow
 * distinguish "persisted" from "rejected / swallowed" and surface
 * the inline error UX ("浏览器禁用了本地存储，无法保存 token")
 * instead of silently reloading onto the same TokenModal.
 */
export function write(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length === 0) return false;
  return writeRaw(KEY, trimmed);
}

/**
 * Forget the cached token. Errors swallowed. Idempotent — calling
 * `clear()` when nothing is cached is a no-op.
 */
export function clear(): void {
  removeRaw(KEY);
}
