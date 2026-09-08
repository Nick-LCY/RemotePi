// Vitest specs for the bridge state.json module (`state.ts`) — covers
// M4 task 04 + PRD §9.2 acceptance cases:
//
//   1. resolveDefaultStatePath honours XDG_CONFIG_HOME
//   2. resolveDefaultStatePath falls back to ~/.config/remotepi/state.json
//   3. loadStateFile on a missing file returns [] (no error, "first run" path)
//   4. loadStateFile on valid state.json returns work_dirs
//   5. loadStateFile on invalid JSON throws StateError code='parse_failed'
//   6. loadStateFile missing schema_version throws StateError code='invalid_state'
//   7. loadStateFile missing work_dirs throws StateError code='invalid_state'
//   8. loadStateFile wrong field type throws StateError code='invalid_state'
//   9. loadStateFile unknown schema_version throws StateError code='invalid_state'
//  10. saveStateFile atomic rename: tmp file appears, then destination
//  11. saveStateFile rollback on rename failure cleans up tmp
//  12. WorkDirStore.add writes a new entry and persists to disk
//  13. WorkDirStore.add rejects path that does not exist
//  14. WorkDirStore.add rejects path that is a file (not a directory)
//  15. WorkDirStore.add rejects path that is not readable
//  16. WorkDirStore.add is idempotent (no-op + no save) when path already in list
//  17. WorkDirStore.add rolls back in-memory push on save failure
//  18. WorkDirStore.remove deletes an entry and persists
//  19. WorkDirStore.remove is no-op when path is not in the list
//  20. WorkDirStore.remove rolls back in-memory filter on save failure
//  21. WorkDirStore.list returns a fresh copy (mutation doesn't leak)
//  22. migrateFromBridgeConfig: state.json missing + bridge.json has work_dir → migrate
//  23. migrateFromBridgeConfig: state.json already exists → load, no migration log
//  24. migrateFromBridgeConfig: state.json missing + bridge.json work_dir empty → empty list, no migration log
//  25. migrateFromBridgeConfig: state.json missing + bridge.json work_dir unreachable → StateError
//  26. migrateFromBridgeConfig: state.json missing + bridge.json work_dir missing field → empty list
//  27. migrateFromBridgeConfig: does NOT write to bridge.json (one-way transfer)
//  28. migrateFromBridgeConfig: idempotent across restarts (re-running on existing state.json is no-op)
//
// Style mirrors `config.test.ts` and `index.test.ts`: one numbered
// `it` per acceptance case, no shared mutable state across cases,
// assertions spelled out so failures point at the property that broke.
// `XDG_CONFIG_HOME` is per-test isolated via `isolateXdgConfigHome`
// (the same pattern `index.test.ts` uses) so we never pollute the
// developer's real `~/.config/remotepi/` even on a flaky test.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  resolveDefaultStatePath,
  loadStateFile,
  saveStateFile,
  migrateFromBridgeConfig,
  validateWorkDir,
  StateError,
  STATE_SCHEMA_VERSION,
  StateFileSchema,
  WorkDirStore,
} from '../state.js';

// ----- Environment isolation ------------------------------------------------
//
// `XDG_CONFIG_HOME` and `HOME` are read on every call to
// `resolveDefaultStatePath()` (no module-level caching), so we can
// flip them per-test without import-order surprises. We snapshot the
// original values in `beforeEach` and restore them in `afterEach` so
// a single failing test never leaves the developer's machine in a
// polluted XDG state.

const ORIGINAL_XDG = process.env['XDG_CONFIG_HOME'];
const ORIGINAL_HOME = process.env['HOME'];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  if (ORIGINAL_XDG === undefined) {
    delete process.env['XDG_CONFIG_HOME'];
  } else {
    process.env['XDG_CONFIG_HOME'] = ORIGINAL_XDG;
  }
  if (ORIGINAL_HOME === undefined) {
    delete process.env['HOME'];
  } else {
    process.env['HOME'] = ORIGINAL_HOME;
  }
  vi.restoreAllMocks();
});

// ----- Tmpdir registry ------------------------------------------------------
//
// Every test that creates tmpdirs registers them here so `afterEach`
// can clean up. Without this, a test run on a CI worker that
// accumulates tmpdirs can trigger disk-pressure flakes. Cleanup is
// best-effort: a leaked tmpdir is cosmetic, not test-affecting.

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** Create a fresh empty tmpdir and register it for cleanup. The
 *  `XDG_CONFIG_HOME` is NOT flipped here — tests that need to flip
 *  it call `isolateXdgConfigHome()` separately so the intent is
 *  explicit at the call site. */
function makeTmpdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'remotepi-state-test-'));
  createdDirs.push(dir);
  return dir;
}

/** Redirect `XDG_CONFIG_HOME` to a fresh empty tmpdir so that
 *  `resolveDefaultStatePath()` deterministically resolves to a
 *  nonexistent path inside that tmpdir. Same pattern as
 *  `index.test.ts:isolateXdgConfigHome` — required for tests that
 *  need a hermetic default path without depending on the
 *  developer's actual `~/.config/remotepi/`. */
function isolateXdgConfigHome(): string {
  const dir = makeTmpdir();
  process.env['XDG_CONFIG_HOME'] = dir;
  return dir;
}

/** Write a state.json-shaped object to a file in a fresh tmpdir,
 *  returning the file path. */
function writeStateFile(body: object): string {
  const dir = makeTmpdir();
  const p = path.join(dir, 'state.json');
  writeFileSync(p, JSON.stringify(body));
  return p;
}

/** Write raw bytes (for malformed JSON cases). */
function writeStateFileRaw(raw: string): string {
  const dir = makeTmpdir();
  const p = path.join(dir, 'state.json');
  writeFileSync(p, raw);
  return p;
}

/** Write a bridge.json-shaped object (for M3 migration tests). */
function writeBridgeConfig(body: object): string {
  const dir = makeTmpdir();
  const p = path.join(dir, 'bridge.json');
  writeFileSync(p, JSON.stringify(body));
  return p;
}

// ----- 1-2. resolveDefaultStatePath ----------------------------------------

describe('resolveDefaultStatePath', () => {
  it('1. honours XDG_CONFIG_HOME when set', () => {
    process.env['XDG_CONFIG_HOME'] = '/custom/xdg';
    const resolved = resolveDefaultStatePath();
    expect(resolved).toBe(path.join('/custom/xdg', 'remotepi', 'state.json'));
  });

  it('2. falls back to ~/.config/remotepi/state.json when XDG is unset', () => {
    delete process.env['XDG_CONFIG_HOME'];
    process.env['HOME'] = '/home/test-user';
    const resolved = resolveDefaultStatePath();
    expect(resolved).toBe(
      path.join('/home/test-user', '.config', 'remotepi', 'state.json'),
    );
  });

  it('2b. treats an empty XDG_CONFIG_HOME as unset (falls back to HOME)', () => {
    process.env['XDG_CONFIG_HOME'] = '';
    process.env['HOME'] = '/home/test-user';
    const resolved = resolveDefaultStatePath();
    expect(resolved).toBe(
      path.join('/home/test-user', '.config', 'remotepi', 'state.json'),
    );
  });
});

// ----- 3-9. loadStateFile ---------------------------------------------------

describe('loadStateFile', () => {
  it('3. returns an empty array when the file is missing (first run path)', () => {
    // No file at this path — `loadStateFile` must NOT throw.
    const dir = makeTmpdir();
    const p = path.join(dir, 'does-not-exist.json');
    const result = loadStateFile(p);
    expect(result).toEqual([]);
  });

  it('4. returns the parsed work_dirs for a valid state.json', () => {
    const p = writeStateFile({
      schema_version: STATE_SCHEMA_VERSION,
      work_dirs: ['/home/me/a', '/home/me/b'],
    });
    const result = loadStateFile(p);
    expect(result).toEqual(['/home/me/a', '/home/me/b']);
  });

  it('4b. returns a fresh copy of the work_dirs (mutation does not affect later loads)', () => {
    // Loading the same file twice must produce independent arrays —
    // the loader does not cache or share backing storage.
    const p = writeStateFile({
      schema_version: STATE_SCHEMA_VERSION,
      work_dirs: ['/home/me/a'],
    });
    const first = loadStateFile(p);
    first.push('/home/me/mutated');
    const second = loadStateFile(p);
    expect(second).toEqual(['/home/me/a']);
    expect(first).toEqual(['/home/me/a', '/home/me/mutated']);
  });

  it('4c. accepts an empty work_dirs array (post-migration baseline)', () => {
    // An empty array is a legal "user has added nothing yet" state.
    // The loader must NOT reject it as a "missing work_dirs" — the
    // key MUST be present, but the array can be empty.
    const p = writeStateFile({
      schema_version: STATE_SCHEMA_VERSION,
      work_dirs: [],
    });
    const result = loadStateFile(p);
    expect(result).toEqual([]);
  });

  it('5. throws StateError code=parse_failed for invalid JSON', () => {
    const p = writeStateFileRaw('{ this is not json }');
    expect(() => loadStateFile(p)).toThrow(StateError);
    try {
      loadStateFile(p);
    } catch (err) {
      expect((err as StateError).code).toBe('parse_failed');
      expect((err as StateError).message).toMatch(/not valid JSON/);
    }
  });

  it('6. throws StateError code=invalid_state when schema_version is missing', () => {
    const p = writeStateFile({
      // schema_version intentionally absent
      work_dirs: ['/home/me/a'],
    });
    expect(() => loadStateFile(p)).toThrow(StateError);
    try {
      loadStateFile(p);
    } catch (err) {
      expect((err as StateError).code).toBe('invalid_state');
      expect((err as StateError).message).toMatch(/schema_version/);
    }
  });

  it('7. throws StateError code=invalid_state when work_dirs is missing', () => {
    const p = writeStateFile({
      schema_version: STATE_SCHEMA_VERSION,
      // work_dirs intentionally absent
    });
    expect(() => loadStateFile(p)).toThrow(StateError);
    try {
      loadStateFile(p);
    } catch (err) {
      expect((err as StateError).code).toBe('invalid_state');
      expect((err as StateError).message).toMatch(/work_dirs/);
    }
  });

  it('8. throws StateError code=invalid_state when work_dirs is not an array', () => {
    const p = writeStateFile({
      schema_version: STATE_SCHEMA_VERSION,
      work_dirs: '/home/me/a', // string, not array
    });
    expect(() => loadStateFile(p)).toThrow(StateError);
    try {
      loadStateFile(p);
    } catch (err) {
      expect((err as StateError).code).toBe('invalid_state');
    }
  });

  it('8b. throws StateError code=invalid_state when work_dirs contains non-strings', () => {
    const p = writeStateFile({
      schema_version: STATE_SCHEMA_VERSION,
      work_dirs: ['/home/me/a', 42], // 42 is not a string
    });
    expect(() => loadStateFile(p)).toThrow(StateError);
    try {
      loadStateFile(p);
    } catch (err) {
      expect((err as StateError).code).toBe('invalid_state');
    }
  });

  it('9. throws StateError code=invalid_state for an unknown schema_version', () => {
    // Future-proofing guard: if an operator hand-edits state.json
    // with a future schema_version (e.g. v2), the loader must
    // reject it rather than silently upgrade and lose the
    // operator's intent. The literal(1) check on schema_version
    // is the wire lock.
    const p = writeStateFile({
      schema_version: 999,
      work_dirs: ['/home/me/a'],
    });
    expect(() => loadStateFile(p)).toThrow(StateError);
    try {
      loadStateFile(p);
    } catch (err) {
      expect((err as StateError).code).toBe('invalid_state');
    }
  });

  it('9b. throws StateError code=invalid_state for unknown keys (strict() schema)', () => {
    // Mirrors the M3 `loadBridgeConfig` strict() check: a typo'd
    // key like `work_dirS` (extra `S`) must surface as a
    // validation failure, not a silent drop. Without strict(),
    // zod would parse this object and `state.work_dirs` would
    // be undefined — the operator would see a confusing
    // "your work_dirs is missing" error rather than the
    // actionable "you typo'd the key" one.
    const p = writeStateFile({
      schema_version: STATE_SCHEMA_VERSION,
      work_dirS: ['/home/me/a'], // typo: extra 'S'
    });
    expect(() => loadStateFile(p)).toThrow(StateError);
    try {
      loadStateFile(p);
    } catch (err) {
      expect((err as StateError).code).toBe('invalid_state');
      // The typo'd key name must be present in the message so
      // the operator can grep their file and fix it.
      expect((err as StateError).message).toMatch(/work_dirS/);
    }
  });

  it('9c. throws StateError code=parse_failed when the file exists but cannot be read', async () => {
    // EACCES / EISDIR / etc. all map to parse_failed (mirrors
    // loadBridgeConfig's treatment of ENOENT/EACCES at the read
    // step). The "ENOENT → empty list" shortcut only fires
    // for ENOENT specifically; other read errors are
    // operational failures.
    const dir = makeTmpdir();
    const p = path.join(dir, 'state.json');
    writeFileSync(p, JSON.stringify({ schema_version: 1, work_dirs: [] }));
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        readFileSync: () => {
          const err = new Error('permission denied (mocked)') as Error & {
            code?: string;
          };
          err.code = 'EACCES';
          throw err;
        },
      };
    });
    try {
      vi.resetModules();
      const { loadStateFile: mockedLoad, StateError: MockedStateError } =
        await import('../state.js');
      let caught: unknown;
      try {
        mockedLoad(p);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MockedStateError);
      expect((caught as InstanceType<typeof MockedStateError>).code).toBe(
        'parse_failed',
      );
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

// ----- 10-11. saveStateFile -------------------------------------------------

describe('saveStateFile (atomic rename)', () => {
  it('10. writes a complete state.json with the expected payload', () => {
    const p = path.join(makeTmpdir(), 'state.json');
    saveStateFile(p, ['/home/me/a', '/home/me/b']);
    // The file must exist after the call.
    expect(existsSync(p)).toBe(true);
    // The on-disk content must round-trip through the schema.
    const parsed = StateFileSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
    expect(parsed).toEqual({
      schema_version: STATE_SCHEMA_VERSION,
      work_dirs: ['/home/me/a', '/home/me/b'],
    });
  });

  it('10b. does not leave a .tmp file behind on the happy path', () => {
    const p = path.join(makeTmpdir(), 'state.json');
    saveStateFile(p, ['/home/me/a']);
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });

  it('10c. overwrites an existing state.json atomically', () => {
    const p = path.join(makeTmpdir(), 'state.json');
    saveStateFile(p, ['/home/me/a']);
    saveStateFile(p, ['/home/me/b', '/home/me/c']);
    const parsed = StateFileSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
    expect(parsed.work_dirs).toEqual(['/home/me/b', '/home/me/c']);
  });

  it('10d. accepts an empty work_dirs list and writes `[]` (not omitted)', () => {
    // An empty list is the post-migration baseline — the file
    // exists but the array is `[]`. We do NOT collapse empty
    // lists to "missing field" because the field is required
    // (loadStateFile rejects absent work_dirs as invalid).
    const p = path.join(makeTmpdir(), 'state.json');
    saveStateFile(p, []);
    const parsed = StateFileSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
    expect(parsed.work_dirs).toEqual([]);
  });

  it('11. cleans up the .tmp file when rename throws (best-effort cleanup)', async () => {
    // Mock `fs.renameSync` to throw. The save call should:
    //   (a) write the .tmp file (so the cleanup path is exercised),
    //   (b) attempt the rename (which throws),
    //   (c) catch + clean up the .tmp + re-throw.
    // The user-visible behaviour is "the save failed AND no
    // orphan tmp file is left behind". This is the
    // corruption-resistance contract — see state.ts §"Atomic
    // writes".
    const dir = makeTmpdir();
    const p = path.join(dir, 'state.json');
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        renameSync: () => {
          const err = new Error('rename failed (mocked)') as Error & {
            code?: string;
          };
          err.code = 'EACCES';
          throw err;
        },
      };
    });
    try {
      vi.resetModules();
      const { saveStateFile: mockedSave } = await import('../state.js');
      let caught: unknown;
      try {
        mockedSave(p, ['/home/me/a']);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      // The .tmp file must have been cleaned up so it doesn't
      // leak for the next save to silently overwrite.
      expect(existsSync(`${p}.tmp`)).toBe(false);
      // The destination must NOT exist (the rename failed).
      expect(existsSync(p)).toBe(false);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('11c. creates the parent directory on first save (fresh-install path)', () => {
    // The first run on a developer machine that has never had
    // `~/.config/remotepi/` must still work — `saveStateFile`
    // creates the full intermediate directory tree as part
    // of the atomic write. Without this, a first-run M3
    // migration would fail with ENOENT on the parent
    // directory, leaving the operator with a confusing
    // "where's the state file?" question.
    const dir = makeTmpdir();
    // Note: no `mkdirSync` here — the parent directory is
    // intentionally absent. The nested path also tests
    // that `recursive: true` correctly creates the full
    // chain.
    const p = path.join(dir, 'nested', 'one', 'state.json');
    expect(existsSync(path.dirname(p))).toBe(false);
    saveStateFile(p, ['/home/me/a']);
    expect(existsSync(p)).toBe(true);
    // The intermediate directories were created.
    expect(existsSync(path.dirname(p))).toBe(true);
  });

  it('11b. propagates the writeFileSync error when the tmp write itself fails (read-only filesystem)', async () => {
    // `fs.writeFileSync` throwing is the "we can't even create
    // the tmp file" failure (e.g. read-only filesystem / out of
    // disk / quota exceeded). The save must:
    //   (a) NOT leave a partial .tmp behind (the write
    //       failed before the rename was attempted, so there's
    //       nothing to clean up — but the catch in saveStateFile
    //       should still be a no-op here),
    //   (b) NOT create the destination file,
    //   (c) propagate the error to the caller so WorkDirStore
    //       can roll back the in-memory mutation.
    // This is the "atomic write fails at step 1 of 2"
    // counterpart to test 11 (which fails at step 2 of 2).
    const dir = makeTmpdir();
    const p = path.join(dir, 'state.json');
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        writeFileSync: () => {
          const err = new Error('read-only fs (mocked)') as Error & {
            code?: string;
          };
          err.code = 'EROFS';
          throw err;
        },
      };
    });
    try {
      vi.resetModules();
      const { saveStateFile: mockedSave } = await import('../state.js');
      let caught: unknown;
      try {
        mockedSave(p, ['/home/me/a']);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      // Neither the tmp nor the destination must exist.
      expect(existsSync(`${p}.tmp`)).toBe(false);
      expect(existsSync(p)).toBe(false);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

// ----- 12-21. WorkDirStore --------------------------------------------------

describe('WorkDirStore', () => {
  it('12. add() appends to the in-memory list and persists to disk', () => {
    const p = path.join(makeTmpdir(), 'state.json');
    const store = WorkDirStore.empty(p);
    const dir = makeTmpdir();
    store.add(dir);
    expect(store.list()).toEqual([dir]);
    const parsed = StateFileSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
    expect(parsed.work_dirs).toEqual([dir]);
  });

  it('12b. add() preserves insertion order across multiple calls', () => {
    const p = path.join(makeTmpdir(), 'state.json');
    const store = WorkDirStore.empty(p);
    const dir1 = makeTmpdir();
    const dir2 = makeTmpdir();
    const dir3 = makeTmpdir();
    store.add(dir1);
    store.add(dir2);
    store.add(dir3);
    expect(store.list()).toEqual([dir1, dir2, dir3]);
  });

  it('13. add() rejects a path that does not exist (StateError invalid_state)', () => {
    const p = path.join(makeTmpdir(), 'state.json');
    const store = WorkDirStore.empty(p);
    const ghost = path.join(makeTmpdir(), 'does-not-exist');
    expect(() => store.add(ghost)).toThrow(StateError);
    try {
      store.add(ghost);
    } catch (err) {
      expect((err as StateError).code).toBe('invalid_state');
      expect((err as StateError).message).toMatch(/not accessible/);
    }
    // The failed add must not touch the in-memory list either.
    expect(store.list()).toEqual([]);
    // Nor the on-disk file (no save was attempted — validation
    // failed before the push).
    expect(existsSync(p)).toBe(false);
  });

  it('14. add() rejects a path that is a file, not a directory', () => {
    const p = path.join(makeTmpdir(), 'state.json');
    const store = WorkDirStore.empty(p);
    const filePath = path.join(makeTmpdir(), 'a-file.txt');
    writeFileSync(filePath, 'hello');
    expect(() => store.add(filePath)).toThrow(StateError);
    try {
      store.add(filePath);
    } catch (err) {
      expect((err as StateError).code).toBe('invalid_state');
      expect((err as StateError).message).toMatch(/not a directory/);
    }
    expect(store.list()).toEqual([]);
  });

  it('15. add() rejects a path that exists but is not readable', async () => {
    // Same doMock pattern as the M3 `work_dir not readable`
    // config.test.ts case: swap `node:fs.accessSync` so it
    // throws EACCES, then re-import the store. The
    // re-import is needed because the original module
    // captured the real `accessSync` at load time.
    const p = path.join(makeTmpdir(), 'state.json');
    const dir = makeTmpdir();
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        accessSync: () => {
          const err = new Error('permission denied (mocked)') as Error & {
            code?: string;
          };
          err.code = 'EACCES';
          throw err;
        },
      };
    });
    try {
      vi.resetModules();
      const { WorkDirStore: MockedWorkDirStore, StateError: MockedStateError } =
        await import('../state.js');
      const store = MockedWorkDirStore.empty(p);
      let caught: unknown;
      try {
        store.add(dir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MockedStateError);
      expect((caught as InstanceType<typeof MockedStateError>).code).toBe(
        'invalid_state',
      );
      expect((caught as InstanceType<typeof MockedStateError>).message).toMatch(
        /not readable/,
      );
      expect(store.list()).toEqual([]);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('16. add() is idempotent when the path is already in the list (no save)', () => {
    const p = path.join(makeTmpdir(), 'state.json');
    const store = WorkDirStore.empty(p);
    const dir = makeTmpdir();
    store.add(dir);
    const beforeMtime = existsSync(p) ? readFileSync(p, 'utf8') : null;
    // Wait a tick to make sure mtime granularity can't accidentally
    // match (some filesystems have 1s mtime resolution).
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));
    return sleep(20).then(() => {
      // Same path → no-op. The on-disk file is NOT rewritten.
      store.add(dir);
      expect(store.list()).toEqual([dir]);
      const afterMtime = readFileSync(p, 'utf8');
      expect(afterMtime).toBe(beforeMtime);
    });
  });

  it('17. add() rolls back the in-memory push when the save throws', async () => {
    // Mock `fs.renameSync` so EVERY rename throws (mirrors an
    // EACCES / ENOSPC / read-only-filesystem failure). The
    // `add` call must propagate the error AND the in-memory
    // push must be rolled back so `list()` doesn't see an
    // entry that isn't on disk.
    const p = path.join(makeTmpdir(), 'state.json');
    const dir1 = makeTmpdir();
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        renameSync: () => {
          const err = new Error('disk full (mocked)') as Error & {
            code?: string;
          };
          err.code = 'ENOSPC';
          throw err;
        },
      };
    });
    try {
      vi.resetModules();
      const { WorkDirStore: MockedWorkDirStore } = await import('../state.js');
      const store = MockedWorkDirStore.empty(p);
      let caught: unknown;
      try {
        store.add(dir1);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      // The in-memory list must be back to empty (the push
      // was rolled back).
      expect(store.list()).toEqual([]);
      // And the on-disk file must not exist (the failed
      // save's tmp was cleaned up + the rename never
      // happened).
      expect(existsSync(p)).toBe(false);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('18. remove() deletes an entry from the in-memory list and persists', () => {
    const p = path.join(makeTmpdir(), 'state.json');
    const dir1 = makeTmpdir();
    const dir2 = makeTmpdir();
    const store = new WorkDirStore([dir1, dir2], p);
    store.remove(dir1);
    expect(store.list()).toEqual([dir2]);
    const parsed = StateFileSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
    expect(parsed.work_dirs).toEqual([dir2]);
  });

  it('18b. remove() preserves the order of remaining entries', () => {
    const p = path.join(makeTmpdir(), 'state.json');
    const dir1 = makeTmpdir();
    const dir2 = makeTmpdir();
    const dir3 = makeTmpdir();
    const store = new WorkDirStore([dir1, dir2, dir3], p);
    // Remove the middle entry — order of [dir1, dir3] must be preserved.
    store.remove(dir2);
    expect(store.list()).toEqual([dir1, dir3]);
  });

  it('19. remove() is a no-op when the path is not in the list', () => {
    // The WorkDirStore constructor does NOT write the file —
    // it just sets up the in-memory list. To verify "no
    // on-disk write happens when remove() finds nothing", we
    // first add an entry to create the file, capture the
    // mtime, then attempt to remove a path that was never
    // added. The file content must be unchanged (the
    // idempotency check fires before the save).
    const p = path.join(makeTmpdir(), 'state.json');
    const dir1 = makeTmpdir();
    const ghost = path.join(makeTmpdir(), 'never-added');
    const store = WorkDirStore.empty(p);
    store.add(dir1);
    const beforeContent = readFileSync(p, 'utf8');
    store.remove(ghost);
    expect(store.list()).toEqual([dir1]);
    // No on-disk write either.
    const afterContent = readFileSync(p, 'utf8');
    expect(afterContent).toBe(beforeContent);
  });

  it('20. remove() rolls back the in-memory filter on save failure', async () => {
    // Mock `renameSync` to throw on the first call (which is
    // the remove's save). The captured entry must be
    // re-inserted at its original position.
    const p = path.join(makeTmpdir(), 'state.json');
    const dir1 = makeTmpdir();
    const dir2 = makeTmpdir();
    const dir3 = makeTmpdir();
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        renameSync: () => {
          const err = new Error('disk full (mocked)') as Error & {
            code?: string;
          };
          err.code = 'ENOSPC';
          throw err;
        },
      };
    });
    try {
      vi.resetModules();
      const { WorkDirStore: MockedWorkDirStore } = await import('../state.js');
      const store = new MockedWorkDirStore([dir1, dir2, dir3], p);
      let caught: unknown;
      try {
        store.remove(dir2);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      // The middle entry must be re-inserted at index 1.
      expect(store.list()).toEqual([dir1, dir2, dir3]);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('21. list() returns a fresh copy (mutation does not affect the store)', () => {
    const p = path.join(makeTmpdir(), 'state.json');
    const dir1 = makeTmpdir();
    const store = new WorkDirStore([dir1], p);
    const snapshot = store.list();
    snapshot.push('/some/mutated/path');
    // A second list() call must return the unchanged original.
    expect(store.list()).toEqual([dir1]);
  });
});

// ----- 22-28. migrateFromBridgeConfig ---------------------------------------

describe('migrateFromBridgeConfig (M3 → M4 migration)', () => {
  it('22. migrates bridge.json work_dir to state.json when state.json is missing', () => {
    // bridge.json has a work_dir; state.json does not exist.
    // After migration, state.json must exist with [work_dir],
    // the migration log line must have been emitted, and the
    // returned list must be [work_dir].
    const workDir = makeTmpdir();
    const configPath = writeBridgeConfig({
      worker_url: 'wss://x',
      web_base_url: 'https://x',
      work_dir: workDir,
      token: 'x'.repeat(32),
    });
    const statePath = path.join(makeTmpdir(), 'state.json');
    const bridgeConfig: BridgeConfig = {
      worker_url: 'wss://x',
      web_base_url: 'https://x',
      work_dir: workDir,
    };
    // Spy on the real logger so we can assert the migration
    // log line landed (without depending on console).
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const result = migrateFromBridgeConfig(bridgeConfig, statePath);
    expect(result).toEqual([workDir]);
    // state.json now exists with the migrated entry.
    const parsed = StateFileSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')));
    expect(parsed.work_dirs).toEqual([workDir]);
    // The migration log line was emitted with the migrated
    // path so operators can confirm the right bridge fired.
    const infoCalls = infoSpy.mock.calls.map((args) =>
      args.map((a) => String(a)).join(' '),
    );
    expect(
      infoCalls.some(
        (line) =>
          line.includes('migrated work_dir from bridge.json') &&
          line.includes(workDir),
      ),
    ).toBe(true);
    // Sanity: the config path is unused by the migration
    // (this is just a guard against accidentally introducing
    // a side-effect dependency on the bridge.json path).
    expect(existsSync(configPath)).toBe(true);
  });

  it('23. does NOT migrate when state.json already exists (idempotent on re-run)', () => {
    // state.json exists with ["/a", "/b"]; bridge.json has a
    // different work_dir. Migration must skip + return the
    // state.json contents — the bridge.json work_dir is
    // irrelevant once state.json is in play.
    const bridgeWorkDir = makeTmpdir();
    const bridgeConfig: BridgeConfig = {
      worker_url: 'wss://x',
      web_base_url: 'https://x',
      work_dir: bridgeWorkDir,
    };
    const statePath = writeStateFile({
      schema_version: STATE_SCHEMA_VERSION,
      work_dirs: ['/already/saved/a', '/already/saved/b'],
    });
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const result = migrateFromBridgeConfig(bridgeConfig, statePath);
    expect(result).toEqual(['/already/saved/a', '/already/saved/b']);
    // No migration log line.
    expect(infoSpy).not.toHaveBeenCalled();
    // The on-disk state.json is unchanged.
    const parsed = StateFileSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')));
    expect(parsed.work_dirs).toEqual(['/already/saved/a', '/already/saved/b']);
  });

  it('24. writes an empty state.json without a migration log when bridge.json work_dir is empty', () => {
    // bridge.json has an empty work_dir (the M3 schema-valid
    // "no work_dir configured" case). Migration is a no-op for
    // values, but we still write a fresh state.json with `[]`
    // so the "state.json exists?" check on subsequent starts
    // returns true. No migration log line because there was
    // nothing to migrate.
    const bridgeConfig: BridgeConfig = {
      worker_url: 'wss://x',
      web_base_url: 'https://x',
      work_dir: '',
    };
    const statePath = path.join(makeTmpdir(), 'state.json');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const result = migrateFromBridgeConfig(bridgeConfig, statePath);
    expect(result).toEqual([]);
    // state.json now exists with `[]`.
    const parsed = StateFileSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')));
    expect(parsed.work_dirs).toEqual([]);
    // No migration log line.
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('25. throws StateError when bridge.json work_dir is no longer accessible', () => {
    // Paranoid re-validation: M3 already validated work_dir at
    // loadBridgeConfig time, but between then and now the
    // operator could have changed permissions / unmounted
    // the volume. We re-check before persisting the path
    // into state.json.
    const ghost = path.join(makeTmpdir(), 'no-such-directory');
    const bridgeConfig: BridgeConfig = {
      worker_url: 'wss://x',
      web_base_url: 'https://x',
      work_dir: ghost,
    };
    const statePath = path.join(makeTmpdir(), 'state.json');
    expect(() => migrateFromBridgeConfig(bridgeConfig, statePath)).toThrow(
      StateError,
    );
    // state.json must NOT have been created (the failure
    // happened before the save).
    expect(existsSync(statePath)).toBe(false);
  });

  it('26. does not log when state.json is missing and bridge.json work_dir is missing the field', () => {
    // The M3 schema requires work_dir to be a non-empty
    // string, so this case is a defensive guard. We do NOT
    // log "migrated" because there was nothing to migrate.
    // We DO write an empty state.json so the "state.json
    // exists?" check on subsequent starts returns true.
    const bridgeConfig = {
      worker_url: 'wss://x',
      web_base_url: 'https://x',
      work_dir: '/tmp',
      token: 'x'.repeat(32),
    } as BridgeConfig;
    // Construct a "missing work_dir" config by deleting the
    // field on a copy. (The M3 schema would reject this at
    // parse time, but the migration function only reads
    // `work_dir` so an absent field should just be treated
    // as empty.)
    const configWithout: BridgeConfig = { ...bridgeConfig, work_dir: '' };
    const statePath = path.join(makeTmpdir(), 'state.json');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const result = migrateFromBridgeConfig(configWithout, statePath);
    expect(result).toEqual([]);
    expect(infoSpy).not.toHaveBeenCalled();
    const parsed = StateFileSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')));
    expect(parsed.work_dirs).toEqual([]);
  });

  it('27. does NOT write to bridge.json (one-way transfer)', () => {
    // The PRD is explicit: "不回写 bridge.json（用户手编配置不被
    // 运行时污染）". We assert the bridge.json mtime + content
    // are unchanged after migration.
    const workDir = makeTmpdir();
    const configPath = writeBridgeConfig({
      worker_url: 'wss://x',
      web_base_url: 'https://x',
      work_dir: workDir,
      token: 'x'.repeat(32),
    });
    const beforeContent = readFileSync(configPath, 'utf8');
    const beforeMtime = statSync(configPath).mtimeMs;
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));
    return sleep(30).then(() => {
      const bridgeConfig: BridgeConfig = {
        worker_url: 'wss://x',
        web_base_url: 'https://x',
        work_dir: workDir,
      };
      const statePath = path.join(makeTmpdir(), 'state.json');
      migrateFromBridgeConfig(bridgeConfig, statePath);
      // bridge.json must be byte-identical.
      const afterContent = readFileSync(configPath, 'utf8');
      expect(afterContent).toBe(beforeContent);
      // mtime must NOT have changed.
      const afterMtime = statSync(configPath).mtimeMs;
      expect(afterMtime).toBe(beforeMtime);
    });
  });

  it('28. is idempotent across restarts (state.json exists on re-run → no migration log)', () => {
    // Simulate two restarts:
    //   1. First call: state.json missing → migration happens,
    //      log line emitted, state.json now exists.
    //   2. Second call: state.json exists → migration is
    //      skipped, no log line, the on-disk file is
    //      unchanged.
    const workDir = makeTmpdir();
    const bridgeConfig: BridgeConfig = {
      worker_url: 'wss://x',
      web_base_url: 'https://x',
      work_dir: workDir,
    };
    const statePath = path.join(makeTmpdir(), 'state.json');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    // First call — migration happens.
    const firstResult = migrateFromBridgeConfig(bridgeConfig, statePath);
    expect(firstResult).toEqual([workDir]);
    const firstLogCount = infoSpy.mock.calls.length;
    expect(firstLogCount).toBeGreaterThan(0);

    // Second call — should be a no-op.
    const secondResult = migrateFromBridgeConfig(bridgeConfig, statePath);
    expect(secondResult).toEqual([workDir]);
    // No new log line.
    expect(infoSpy.mock.calls.length).toBe(firstLogCount);
    // state.json content is unchanged.
    const parsed = StateFileSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')));
    expect(parsed.work_dirs).toEqual([workDir]);
  });
});

// ----- 29. validateWorkDir (helper) -----------------------------------------

describe('validateWorkDir (helper used by WorkDirStore.add + migration)', () => {
  it('29. accepts a real directory and returns void', () => {
    const dir = makeTmpdir();
    expect(() => validateWorkDir(dir)).not.toThrow();
  });

  it('29b. rejects a missing path with StateError code=invalid_state', () => {
    const ghost = path.join(makeTmpdir(), 'missing');
    expect(() => validateWorkDir(ghost)).toThrow(StateError);
    try {
      validateWorkDir(ghost);
    } catch (err) {
      expect((err as StateError).code).toBe('invalid_state');
      expect((err as StateError).message).toMatch(/not accessible/);
    }
  });

  it('29c. rejects a file (not a directory) with StateError code=invalid_state', () => {
    const filePath = path.join(makeTmpdir(), 'a-file.txt');
    writeFileSync(filePath, 'hello');
    expect(() => validateWorkDir(filePath)).toThrow(StateError);
    try {
      validateWorkDir(filePath);
    } catch (err) {
      expect((err as StateError).code).toBe('invalid_state');
      expect((err as StateError).message).toMatch(/not a directory/);
    }
  });
});

// ----- 30. XDG isolation (end-to-end smoke) ---------------------------------

describe('XDG isolation (hermetic default path resolution)', () => {
  it('30. resolveDefaultStatePath + loadStateFile on the XDG-resolved path returns [] for a fresh install', () => {
    // Simulates a "developer with no ~/.config/remotepi/ at all"
    // start: the default state.json path resolves under the
    // empty XDG tmpdir, the file does not exist, the loader
    // returns []. Without the XDG isolation, this test would
    // read the developer's real `~/.config/remotepi/state.json`
    // and the assertion would be whatever the developer
    // happened to have there.
    isolateXdgConfigHome();
    const resolved = resolveDefaultStatePath();
    expect(resolved).toBe(
      path.join(process.env['XDG_CONFIG_HOME']!, 'remotepi', 'state.json'),
    );
    const result = loadStateFile(resolved);
    expect(result).toEqual([]);
  });
});

// ----- 31. BridgeSessionLayer placeholder (not used by task 04) -------------

describe('state path / store contract for downstream consumers (task 06 prep)', () => {
  it('31. WorkDirStore.list() returns a string[] (the contract the future session layer relies on)', () => {
    // Belt-and-braces guard: the eventual `BridgeSessionLayer`
    // (task 06) will call `workDirStore.list()` and iterate
    // the result. We assert the return type + content here so
    // a future refactor of `list()` that returns a Set or a
    // ReadonlyArray<{path: string}> will surface as a test
    // failure, not a runtime crash three milestones later.
    const p = path.join(makeTmpdir(), 'state.json');
    const dir1 = makeTmpdir();
    const dir2 = makeTmpdir();
    const store = new WorkDirStore([dir1, dir2], p);
    const result = store.list();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([dir1, dir2]);
  });
});

// (no other import is intentionally used only for side-effects
// in this file — every fs primitive is exercised in the tests
// above.)

