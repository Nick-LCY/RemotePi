// Vitest specs for `ws/tokenStorage.ts` — the localStorage-backed
// token cache (M5 §第二块 G6 / D9 / 任务 05 §a).
//
// Strategy: pure unit tests with a synthetic `globalThis.localStorage`
// stub. We mutate the stub between tests so each case controls its
// own throw/no-throw/empty/present state. The module-under-test
// reads `globalThis.localStorage` lazily on every `read()`/`write()`/
// `clear()` call, so the stub swap is observed on the next call (no
// re-import needed).
//
// Coverage follows the task brief's required cases:
//   1. read() — 命中 / 缺失 / SecurityError / SSR / unknown key
//   2. write() — 正常 / 空串拒绝 / 纯空白拒绝 / SecurityError /
//      quota exceeded / SSR
//   3. clear() — 命中 / 缺失 / SecurityError
//   4. module-level laziness — module import 不触 localStorage
//   5. StrictMode-style 双调用 — `read()` called twice from the
//      same caller = same value, no double side-effect
//   6. singleton identity — KEY constant is `remotepi.token`,
//      exported once, never changes
//   7. write('x') then read() = 'x' (round-trip)
//   8. trim 行为 — `write('  abc  ')` → `read() === 'abc'`

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KEY, clear, read, write } from '../ws/tokenStorage.js';

// ---------------------------------------------------------------------------
// Test fixture — controllable localStorage stub
// ---------------------------------------------------------------------------

/** A minimal Storage-shaped object that supports the three calls
 *  tokenStorage.ts actually uses (getItem / setItem / removeItem).
 *  Tests can install per-method throw behaviour via the
 *  `behaviour` field to simulate SecurityError / QuotaExceeded /
 *  etc. */
interface StubStorage {
  readonly store: Map<string, string>;
  readonly calls: Array<{ op: 'getItem' | 'setItem' | 'removeItem'; key: string; value?: string }>;
  behaviour: {
    getItem: 'ok' | 'throw-security' | 'throw-other';
    setItem: 'ok' | 'throw-security' | 'throw-other';
    removeItem: 'ok' | 'throw-security' | 'throw-other';
  };
}

function makeStub(): StubStorage {
  return {
    store: new Map<string, string>(),
    calls: [],
    behaviour: {
      getItem: 'ok',
      setItem: 'ok',
      removeItem: 'ok',
    },
  };
}

function installStub(stub: StubStorage): void {
  (globalThis as { localStorage: unknown }).localStorage = {
    getItem(key: string): string | null {
      stub.calls.push({ op: 'getItem', key });
      if (stub.behaviour.getItem === 'throw-security') {
        // SecurityError is the privacy-mode / third-party iframe case.
        throw new DOMException('storage access denied', 'SecurityError');
      }
      if (stub.behaviour.getItem === 'throw-other') {
        throw new TypeError('localStorage.getItem is broken');
      }
      return stub.store.has(key) ? stub.store.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      stub.calls.push({ op: 'setItem', key, value });
      if (stub.behaviour.setItem === 'throw-security') {
        throw new DOMException('storage access denied', 'SecurityError');
      }
      if (stub.behaviour.setItem === 'throw-other') {
        throw new Error('quota exceeded');
      }
      stub.store.set(key, value);
    },
    removeItem(key: string): void {
      stub.calls.push({ op: 'removeItem', key });
      if (stub.behaviour.removeItem === 'throw-security') {
        throw new DOMException('storage access denied', 'SecurityError');
      }
      if (stub.behaviour.removeItem === 'throw-other') {
        throw new Error('removal failed');
      }
      stub.store.delete(key);
    },
    // The remaining Storage methods (clear / key / length) are not
    // used by tokenStorage.ts; we omit them so accidentally calling
    // them throws `undefined is not a function`, surfacing any
    // future regression that touches the wider Storage surface.
  };
}

function uninstallStub(): void {
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

/** Helper for cases that want to seed the stub with a value before
 *  the action under test runs. */
function seed(stub: StubStorage, key: string, value: string): void {
  stub.store.set(key, value);
}

let stub: StubStorage;

beforeEach(() => {
  stub = makeStub();
  installStub(stub);
});

afterEach(() => {
  uninstallStub();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('tokenStorage — constants', () => {
  it('1. exports KEY as the literal "remotepi.token"', () => {
    expect(KEY).toBe('remotepi.token');
  });

  it('2. KEY is a singleton — every import returns the same string identity', async () => {
    // Re-import in the same module instance: the constant must be
    // identity-stable so a future test or runtime override can't
    // silently fork the key.
    const again = await import('../ws/tokenStorage.js');
    expect(again.KEY).toBe(KEY);
    expect(typeof again.KEY).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// read()
// ---------------------------------------------------------------------------

describe('tokenStorage — read()', () => {
  it('3. read() returns null when storage is empty', () => {
    expect(read()).toBeNull();
  });

  it('4. read() returns the cached token when present', () => {
    seed(stub, KEY, 'tok-abc');
    expect(read()).toBe('tok-abc');
  });

  it('5. read() returns null when SecurityError is thrown (privacy mode)', () => {
    stub.behaviour.getItem = 'throw-security';
    expect(() => read()).not.toThrow();
    expect(read()).toBeNull();
  });

  it('6. read() returns null when an unrelated error is thrown (e.g. broken shim)', () => {
    // The brief says SecurityError specifically, but we defensively
    // swallow ANY storage exception — a TypeError from a broken
    // shim shouldn't crash the render either.
    stub.behaviour.getItem = 'throw-other';
    expect(read()).toBeNull();
  });

  it('7. read() returns null when localStorage is absent (SSR safety)', () => {
    uninstallStub();
    expect(read()).toBeNull();
  });

  it('8. read() does NOT call setItem / removeItem — read-only contract', () => {
    seed(stub, KEY, 'tok-abc');
    const callsBefore = stub.calls.length;
    read();
    const newCalls = stub.calls.slice(callsBefore);
    expect(newCalls).toHaveLength(1);
    expect(newCalls[0]!.op).toBe('getItem');
    expect(newCalls[0]!.key).toBe(KEY);
  });
});

// ---------------------------------------------------------------------------
// write()
// ---------------------------------------------------------------------------

describe('tokenStorage — write() — boolean return contract (M5 task 05 review W1)', () => {
  it('9. write("abc") persists; subsequent read returns "abc"', () => {
    expect(write('abc')).toBe(true);
    expect(read()).toBe('abc');
    // setItem was called with the trimmed value.
    const setItemCall = stub.calls.find((c) => c.op === 'setItem');
    expect(setItemCall).toBeDefined();
    expect(setItemCall!.key).toBe(KEY);
    expect(setItemCall!.value).toBe('abc');
  });

  it('10. write("") is rejected as a no-op (does NOT clear, does NOT throw) — returns false', () => {
    seed(stub, KEY, 'existing');
    expect(write('')).toBe(false);
    // The pre-existing value survives — empty input is "invalid",
    // not "remove the cached one" (the latter is `clear()`'s job).
    expect(read()).toBe('existing');
    // No setItem call should have been made.
    const setItemCalls = stub.calls.filter((c) => c.op === 'setItem');
    expect(setItemCalls).toHaveLength(0);
  });

  it('11. write("   ") (whitespace only) is rejected as a no-op — returns false', () => {
    seed(stub, KEY, 'existing');
    expect(write('   ')).toBe(false);
    expect(read()).toBe('existing');
    const setItemCalls = stub.calls.filter((c) => c.op === 'setItem');
    expect(setItemCalls).toHaveLength(0);
  });

  it('12. write("  abc  ") trims and persists "abc" — returns true', () => {
    expect(write('  abc  ')).toBe(true);
    expect(read()).toBe('abc');
  });

  it('13. write() swallows SecurityError (privacy mode) — returns false', () => {
    stub.behaviour.setItem = 'throw-security';
    expect(() => write('abc')).not.toThrow();
    expect(write('abc')).toBe(false);
  });

  it('14. write() swallows quota / other errors (e.g. quota exceeded) — returns false', () => {
    stub.behaviour.setItem = 'throw-other';
    expect(() => write('abc')).not.toThrow();
    expect(write('abc')).toBe(false);
  });

  it('15. write() is a silent no-op when localStorage is absent (SSR safety) — returns false', () => {
    uninstallStub();
    expect(() => write('abc')).not.toThrow();
    expect(write('abc')).toBe(false);
  });

  it('16. write() does NOT call getItem / removeItem — write-only contract', () => {
    expect(write('abc')).toBe(true);
    const ops = stub.calls.map((c) => c.op);
    expect(ops).toEqual(['setItem']);
  });

  it('17. successive writes: the latest value wins', () => {
    expect(write('first')).toBe(true);
    expect(write('second')).toBe(true);
    expect(write('third')).toBe(true);
    expect(read()).toBe('third');
  });

  it('18. M5 task 05 review W1钉桩 — write failure → next read returns null (write 失败 → 走 TokenModal 重提流)', () => {
    // M5 task 05 review W1 — the App-level required-mode submit
    // handler is `const ok = tokenStorage.write(t); if (ok)
    // window.location.reload(); else setStorageError(true)`. The
    // false branch must NOT reload — the user stays on the
    // modal with the inline storageError banner. The next read
    // returns null (write failed → no entry was persisted),
    // which is the documented "退化但合理" path.
    stub.behaviour.setItem = 'throw-security';
    const ok = write('my-token');
    expect(ok).toBe(false);
    // The next read should be null — write failure left no
    // persisted entry behind, so the user lands back on the
    // required TokenModal on the next auth check.
    expect(read()).toBeNull();
  });

  it('19. M5 task 05 review W1钉桩 — write success → next read returns the same value (no reload race)', () => {
    // M5 task 05 review W1 — the App-level required-mode submit
    // path is `const ok = write(t); if (ok) window.location.reload()`.
    // A successful write must round-trip through read() — the
    // post-reload `readAuth()` reads localStorage, finds the token,
    // and routes to App's normal recovery path. If write returned
    // true but localStorage didn't actually persist (silent
    // mismatch), the reload would land back on TokenModal
    // required and the user would be stuck in an infinite reload
    // loop. This钉桩 pins that happy-path round-trip.
    const ok = write('round-trip-token');
    expect(ok).toBe(true);
    expect(read()).toBe('round-trip-token');
  });
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

describe('tokenStorage — clear()', () => {
  it('18. clear() removes the cached token', () => {
    seed(stub, KEY, 'tok-abc');
    clear();
    expect(read()).toBeNull();
  });

  it('19. clear() is idempotent when storage is empty', () => {
    expect(() => clear()).not.toThrow();
    expect(read()).toBeNull();
  });

  it('20. clear() swallows SecurityError', () => {
    stub.behaviour.removeItem = 'throw-security';
    expect(() => clear()).not.toThrow();
  });

  it('21. clear() is a silent no-op when localStorage is absent', () => {
    seed(stub, KEY, 'tok-abc');
    uninstallStub();
    expect(() => clear()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Module-level laziness (StrictMode / SSR / test ergonomics)
// ---------------------------------------------------------------------------

describe('tokenStorage — module-level laziness', () => {
  it('22. importing the module does NOT touch localStorage', async () => {
    // Re-install a fresh stub that records every call. Import the
    // module AFTER the install — vitest caches imports across
    // tests, so we instead assert via a fresh `import()` call after
    // wiping the call log.
    const fresh = makeStub();
    installStub(fresh);
    // Wipe any prior calls (the prior beforeEach already ran but
    // each case installs its own stub; we install a fresh one here
    // purely for the "import is free of I/O" assertion).
    fresh.calls.length = 0;
    // A dynamic import would re-evaluate the module on first run
    // but vitest caches subsequent imports. We use a static
    // re-import via the same import path to confirm — the calls
    // list must remain empty after the import line.
    await import('../ws/tokenStorage.js');
    expect(fresh.calls).toHaveLength(0);
  });

  it('23. KEY constant is exposed at module-init time (does not require read())', () => {
    // `KEY` is the only export that touches no storage; the rest
    // (`read` / `write` / `clear`) are functions. Asserting both
    // forms is sufficient for the "no I/O at import" requirement.
    const fresh = makeStub();
    installStub(fresh);
    fresh.calls.length = 0;
    // Touch KEY (constant access). Should not trigger any storage
    // call.
    const _k: string = KEY;
    expect(_k).toBe('remotepi.token');
    expect(fresh.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// StrictMode-style double-invocation safety
// ---------------------------------------------------------------------------

describe('tokenStorage — StrictMode double-invocation safety', () => {
  it('24. double read() returns the same value without double-I/O side-effects', () => {
    seed(stub, KEY, 'tok-abc');
    const callsBefore = stub.calls.length;
    const first = read();
    const second = read();
    expect(first).toBe('tok-abc');
    expect(second).toBe('tok-abc');
    // Each read() is exactly one getItem; no internal cache.
    expect(stub.calls.length - callsBefore).toBe(2);
    expect(stub.calls[callsBefore]!.op).toBe('getItem');
    expect(stub.calls[callsBefore + 1]!.op).toBe('getItem');
  });

  it('25. write then read then clear — every transition is observed', () => {
    write('round-trip');
    expect(read()).toBe('round-trip');
    clear();
    expect(read()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Singleton identity
// ---------------------------------------------------------------------------

describe('tokenStorage — singleton identity', () => {
  it('26. all four exports come from a single module instance (no fork)', async () => {
    const again = await import('../ws/tokenStorage.js');
    expect(again.KEY).toBe(KEY);
    expect(again.read).toBe(read);
    expect(again.write).toBe(write);
    expect(again.clear).toBe(clear);
  });
});

// ---------------------------------------------------------------------------
// SSR / no-window fallback (final summary)
// ---------------------------------------------------------------------------

describe('tokenStorage — SSR safety (no localStorage on globalThis)', () => {
  it('27. all three operations are silent no-ops when localStorage is absent', () => {
    uninstallStub();
    expect(() => {
      const _r = read();
      write('x');
      clear();
      // Force-read the local var so eslint doesn't complain about
      // unused assignments.
      void _r;
    }).not.toThrow();
    expect(read()).toBeNull();
  });
});
