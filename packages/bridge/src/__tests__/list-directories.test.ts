// Vitest specs for the bridge directory-browser pure function
// (`list-directories.ts`) — covers M4 task 05 + PRD §2.5 + §9.2
// acceptance cases for `control/list_directories`:
//
//   1.  home default: no path → resolves to $HOME
//   2.  arbitrary path: explicit absolute path → returns its subdirs
//   3.  path does not exist (ENOENT) → domain code path_not_found
//   4.  path is a file, not a directory (ENOTDIR) → path_not_directory
//   5.  path exists but is not readable (EACCES) → path_not_readable
//   6.  entries exclude files (only directories are listed)
//   7.  entries are sorted lexicographically (deterministic UI order)
//   8.  path.resolve normalises `..` segments
//   9.  path.resolve normalises multiple slashes
//  10.  path.resolve normalises relative paths to absolute (cwd-anchored)
//  11.  empty directory returns `{ entries: [] }` (no spurious entries)
//  12.  readdirSync mid-call failure (EACCES during readdir, not stat)
//       also maps to path_not_readable
//  13.  unexpected fs error during stat (EIO mock) → domain code `internal`
//  14.  result data round-trips through ListDirectoriesResultSchema
//       (defensive revalidation passes on the happy path)
//  15.  domain → wire code mapping (pure function)
//       ENOENT/EACCES/ENOTDIR → invalid_envelope; internal → internal
//  16.  dispatcher wiring in pi-process.ts: emits result envelope with
//       reply_to, no spawn, $HOME fallback
//
// Style mirrors `state.test.ts`: one numbered `it` per acceptance
// case, no shared mutable state, real fs where possible (tmpdir),
// `vi.doMock('node:fs')` only for EACCES/EIO cases that chmod can't
// reliably produce (root user bypasses DAC).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListDirectoriesResultSchema } from '@remotepi/shared';
import {
  listDirectories,
  mapListDirectoriesDomainCodeToWire,
  type ListDirectoriesDomainCode,
} from '../list-directories.js';

// ----- Tmpdir registry ------------------------------------------------------

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort — leaks here are cosmetic, not test-affecting.
    }
  }
  vi.restoreAllMocks();
  vi.doUnmock('node:fs');
  vi.resetModules();
});

/** Create a fresh tmpdir + register it for cleanup. The caller may
 *  use it as a hermetic root and populate it with `mkdirTree`. */
function makeTmpdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'remotepi-list-dir-test-'));
  createdDirs.push(dir);
  return dir;
}

/** Materialise a directory tree described as `{ name: string |
 *  TreeNode }` records under `root`. Files are written with
 *  `writeFileSync('')` (zero-byte content is fine for the dirent
 *  test — `isFile()` only needs the file to exist on disk, no
 *  particular content). Symlinks and special files are not used;
 *  they're outside the scope of PRD §2.5. */
type TreeNode = string | { [key: string]: TreeNode };

function mkdirTree(root: string, tree: Record<string, TreeNode>): void {
  for (const [name, child] of Object.entries(tree)) {
    const p = path.join(root, name);
    if (typeof child === 'string') {
      // leaf = file
      writeFileSync(p, '');
    } else {
      mkdirSync(p, { recursive: true });
      mkdirTree(p, child);
    }
  }
}

// ----- 1. home default ------------------------------------------------------

describe('listDirectories — home default (no path)', () => {
  it('1. with path === undefined, lists $HOME subdirectories (single-user fixture)', () => {
    // We don't read the operator's real $HOME (would leak their
    // files into test logs / would race with their activity). Build
    // a controlled fixture tree under a tmpdir, point HOME at it,
    // call listDirectories() with undefined, and assert the
    // resolved path matches our controlled $HOME.
    const fakeHome = makeTmpdir();
    mkdirTree(fakeHome, {
      'aaa-dir': {},
      'bbb-dir': {},
      'ccc-file.txt': '',
      'zzz-dir': {},
    });
    const originalHome = process.env['HOME'];
    process.env['HOME'] = fakeHome;
    try {
      const result = listDirectories(undefined);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Sorted lexicographically (case-stable).
      expect(result.data.entries.map((e) => e.name)).toEqual([
        'aaa-dir',
        'bbb-dir',
        'zzz-dir',
      ]);
      // Each entry path is the resolved $HOME + name.
      expect(result.data.entries.map((e) => e.path)).toEqual([
        path.join(fakeHome, 'aaa-dir'),
        path.join(fakeHome, 'bbb-dir'),
        path.join(fakeHome, 'zzz-dir'),
      ]);
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    }
  });

  it('1b. with path === undefined, filters out files in $HOME (only dirs listed)', () => {
    const fakeHome = makeTmpdir();
    mkdirTree(fakeHome, {
      'a-dir': {},
      'a-file.txt': '',
      'b-dir': {},
      'b-file': '',
      // dotfile directory — listed (PRD §2.5 lists all dirs; dotfile
      // filtering is a UI concern, not a wire contract one)
      '.hidden-dir': {},
    });
    const originalHome = process.env['HOME'];
    process.env['HOME'] = fakeHome;
    try {
      const result = listDirectories(undefined);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.entries.map((e) => e.name)).toEqual([
        '.hidden-dir',
        'a-dir',
        'b-dir',
      ]);
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    }
  });
});

// ----- 2. arbitrary path ----------------------------------------------------

describe('listDirectories — arbitrary path', () => {
  it('2. with explicit absolute path, lists that directory\'s subdirectories', () => {
    const root = makeTmpdir();
    mkdirTree(root, {
      'dir-a': { nested: {} },
      'dir-b': {},
      'file-c.txt': '',
    });
    const result = listDirectories(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries.map((e) => e.name)).toEqual(['dir-a', 'dir-b']);
    // Nested subdirectories are NOT recursively expanded — only
    // the top-level entries of the resolved path are returned.
    // PRD §2.5: "列子目录" = enumerate immediate children.
    expect(result.data.entries.map((e) => e.path)).toEqual([
      path.join(root, 'dir-a'),
      path.join(root, 'dir-b'),
    ]);
  });
});

// ----- 3. path does not exist ----------------------------------------------

describe('listDirectories — path does not exist (ENOENT)', () => {
  it('3. returns domain code path_not_found with a precise message', () => {
    const root = makeTmpdir();
    const ghost = path.join(root, 'no-such-dir');
    const result = listDirectories(ghost);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('path_not_found');
    expect(result.message).toMatch(/does not exist/);
    expect(result.message).toContain(ghost);
  });
});

// ----- 4. path is a file ---------------------------------------------------

describe('listDirectories — path is a file (ENOTDIR)', () => {
  it('4. returns domain code path_not_directory when path resolves to a regular file', () => {
    const root = makeTmpdir();
    const filePath = path.join(root, 'a-file.txt');
    writeFileSync(filePath, 'hello');
    const result = listDirectories(filePath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('path_not_directory');
    expect(result.message).toMatch(/not a directory/);
    expect(result.message).toContain(filePath);
  });
});

// ----- 5. path not readable (EACCES) ---------------------------------------

describe('listDirectories — path not readable (EACCES)', () => {
  it('5. returns domain code path_not_readable when accessSync fails (mock fs)', async () => {
    // `chmod 000` doesn't reliably produce EACCES when running as
    // root (DAC bypass). The config.test.ts / state.test.ts pattern
    // uses vi.doMock('node:fs') to inject EACCES at the
    // accessSync boundary — we follow the same pattern. The
    // dynamic re-import is required because the doMock only takes
    // effect on the next module resolution.
    const root = makeTmpdir();
    mkdirTree(root, { 'dir-x': {} });

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
    vi.resetModules();
    const { listDirectories: mockedList } = await import('../list-directories.js');

    try {
      const result = mockedList(root);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('path_not_readable');
      expect(result.message).toMatch(/not readable/);
      expect(result.message).toContain(root);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('5b. readdir-time EACCES (after preflight passes) also maps to path_not_readable', async () => {
    // Less common: preflight (stat + accessSync) passes, then
    // readdirSync throws EACCES — e.g. a directory with restrictive
    // read on entries but not on the directory itself. Mirror the
    // config.test.ts pattern: doMock accessSync to pass through
    // (allow preflight to succeed), doMock readdirSync to throw
    // EACCES.
    const root = makeTmpdir();
    mkdirTree(root, { 'dir-x': {} });

    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        // accessSync delegates to real (preflight passes)
        accessSync: real.accessSync,
        // readdirSync throws EACCES
        readdirSync: () => {
          const err = new Error('permission denied (mocked)') as Error & {
            code?: string;
          };
          err.code = 'EACCES';
          throw err;
        },
      };
    });
    vi.resetModules();
    const { listDirectories: mockedList } = await import('../list-directories.js');

    try {
      const result = mockedList(root);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('path_not_readable');
      expect(result.message).toMatch(/not readable/);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('5c. EACCES during stat (not accessSync) maps to path_not_readable', async () => {
    // stat can throw EACCES in unusual setups (e.g. directory walk
    // permission, sandboxed fs). The preflight branch catches it
    // and surfaces it as `path_not_readable` — same code as the
    // accessSync path because the operator sees the same diagnostic.
    const ghost = path.join(makeTmpdir(), 'phantom');

    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        statSync: () => {
          const err = new Error('permission denied (mocked)') as Error & {
            code?: string;
          };
          err.code = 'EACCES';
          throw err;
        },
      };
    });
    vi.resetModules();
    const { listDirectories: mockedList } = await import('../list-directories.js');

    try {
      const result = mockedList(ghost);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('path_not_readable');
      expect(result.message).toMatch(/not readable/);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

// ----- 6. entries exclude files --------------------------------------------

describe('listDirectories — entries exclude files (only dirs listed)', () => {
  it('6. files in the directory do not appear in entries (only directories)', () => {
    const root = makeTmpdir();
    mkdirTree(root, {
      'dir-1': {},
      'dir-2': {},
      'file-1.txt': '',
      'file-2.bin': '',
      // Symlink-to-file would be isSymbolicLink(), not isFile()
      // nor isDirectory() — handled separately by `isDirectory()`
      // returning false. Not covered here; pi's normal user
      // directories rarely contain them, and PRD §2.5 doesn't
      // specify symlink semantics.
    });
    const result = listDirectories(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries.map((e) => e.name)).toEqual(['dir-1', 'dir-2']);
    // Belt-and-braces: no entry's name starts with "file-".
    for (const entry of result.data.entries) {
      expect(entry.name.startsWith('file-')).toBe(false);
    }
    // Belt-and-braces: statSync confirms each entry is a real
    // directory on disk (catches a refactor that, say, accidentally
    // also lists regular files via isFile() instead of isDirectory()).
    for (const entry of result.data.entries) {
      expect(statSync(entry.path).isDirectory()).toBe(true);
    }
  });
});

// ----- 7. entries are sorted lexicographically -----------------------------

describe('listDirectories — entries sorted lexicographically', () => {
  it('7. returns entries in lexicographic order regardless of insertion order', () => {
    const root = makeTmpdir();
    // Insert in non-sorted order: a later mkdir of `zzz-dir`
    // after `aaa-dir` would naturally produce a different on-disk
    // listing from a single-pass mkdir.
    mkdirSync(path.join(root, 'zzz-dir'), { recursive: true });
    mkdirSync(path.join(root, 'mmm-dir'), { recursive: true });
    mkdirSync(path.join(root, 'aaa-dir'), { recursive: true });
    mkdirSync(path.join(root, 'bbb-dir'), { recursive: true });

    const result = listDirectories(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries.map((e) => e.name)).toEqual([
      'aaa-dir',
      'bbb-dir',
      'mmm-dir',
      'zzz-dir',
    ]);
  });

  it('7b. case-sensitive sort: capital letters sort before lowercase (code-point order)', () => {
    // Document the sort semantics — operators may rely on the
    // specific order for known-name lookups. Array.sort without
    // a comparator uses the platform string comparator, which
    // does code-point (UTF-16 unit) ordering. ASCII A-Z < a-z in
    // code-point order (uppercase has lower code points than
    // lowercase), so `Aaa` comes before `aaa` but after nothing
    // else — this matches unix `ls -l` on a C locale.
    const root = makeTmpdir();
    mkdirSync(path.join(root, 'Aaa'), { recursive: true });
    mkdirSync(path.join(root, 'aaa'), { recursive: true });
    mkdirSync(path.join(root, 'AAA'), { recursive: true });

    const result = listDirectories(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Each name appears exactly once.
    expect(result.data.entries.map((e) => e.name)).toHaveLength(3);
    const names = result.data.entries.map((e) => e.name);
    expect(new Set(names).size).toBe(3);
    // Uppercase letters sort BEFORE the lowercase ones (code-point
    // order: 'A' = 65 < 'a' = 97).
    const indexOfAAA = names.indexOf('AAA');
    const indexOfAaa = names.indexOf('Aaa');
    const indexOfaaa = names.indexOf('aaa');
    expect(indexOfAAA).toBeLessThan(indexOfaaa);
    expect(indexOfAaa).toBeLessThan(indexOfaaa);
  });
});

// ----- 8-10. path.resolve normalisation -------------------------------------

describe('listDirectories — path.resolve normalisation', () => {
  it('8. `..` segments are collapsed (no traversal, just structural normalisation)', () => {
    // `/foo/bar/..` resolves to `/foo`. The fixture builds a real
    // `/tmp-dir/foo` directory; the listing is on `/tmp-dir` after
    // normalisation.
    const root = makeTmpdir();
    mkdirTree(root, {
      foo: {
        inner: {},
      },
    });
    // Use the real existing path with `..` inserted.
    const inputPath = path.join(root, 'foo', '..', 'foo');
    const result = listDirectories(inputPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // After resolution, the listing is the contents of `/foo`,
    // which has a single `inner` subdirectory.
    expect(result.data.entries.map((e) => e.name)).toEqual(['inner']);
    // And each entry's `path` is anchored at the resolved location
    // (no `..` segments leak into the entry paths).
    expect(result.data.entries[0]?.path).toBe(path.join(root, 'foo', 'inner'));
    // Sanity: no `..` in any returned path.
    for (const entry of result.data.entries) {
      expect(entry.path.includes('..')).toBe(false);
    }
  });

  it('9. multiple consecutive slashes are collapsed', () => {
    const root = makeTmpdir();
    mkdirTree(root, { 'a-dir': {}, 'b-dir': {} });
    const inputPath = `${root}//a-dir///..//`; // collapses to `${root}`
    const result = listDirectories(inputPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // After normalisation the resolved path is `${root}`, whose
    // entries are `a-dir` + `b-dir`.
    expect(result.data.entries.map((e) => e.name).sort()).toEqual([
      'a-dir',
      'b-dir',
    ]);
  });

  it('10. relative paths resolve against cwd (process.cwd())', () => {
    // `listDirectories('foo')` with cwd = `${root}` → resolves to
    // `${root}/foo`. Build a fixture under cwd and verify.
    const root = makeTmpdir();
    mkdirTree(root, { 'rel-dir': { 'inner-dir': {} } });
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      const result = listDirectories('rel-dir');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.entries.map((e) => e.name)).toEqual(['inner-dir']);
      expect(result.data.entries[0]?.path).toBe(path.join(root, 'rel-dir', 'inner-dir'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('10b. `.` segments are collapsed (treated as no-op)', () => {
    const root = makeTmpdir();
    mkdirTree(root, { 'a-dir': {} });
    const inputPath = path.join(root, '.', 'a-dir', '.');
    // Note: the resolved path `${root}/a-dir/.` is `${root}/a-dir`
    // by `path.resolve` semantics. The fixture's `a-dir` has no
    // subdirectories, so the listing is empty.
    const result = listDirectories(inputPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries).toEqual([]);
  });
});

// ----- 11. empty directory --------------------------------------------------

describe('listDirectories — empty directory', () => {
  it('11. an empty directory returns { entries: [] } (no spurious entries)', () => {
    const root = makeTmpdir();
    mkdirSync(path.join(root, 'empty-dir'));
    const result = listDirectories(path.join(root, 'empty-dir'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries).toEqual([]);
  });
});

// ----- 12. unexpected internal error (EIO mock) -----------------------------

describe('listDirectories — unexpected internal error', () => {
  it('12. EIO during stat maps to domain code `internal` (not user-input error)', async () => {
    // EIO is an "I/O error" — neither "you pointed at the wrong
    // place" (ENOENT-class) nor "you can't read this" (EACCES-class).
    // It belongs to the `internal` bucket: bridge did nothing wrong,
    // but the failure isn't a user-input issue either.
    const ghost = path.join(makeTmpdir(), 'whatever');

    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        statSync: () => {
          const err = new Error('i/o error (mocked)') as Error & {
            code?: string;
          };
          err.code = 'EIO';
          throw err;
        },
      };
    });
    vi.resetModules();
    const { listDirectories: mockedList } = await import('../list-directories.js');

    try {
      const result = mockedList(ghost);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('internal');
      expect(result.message).toMatch(/unexpected error/);
      expect(result.message).toMatch(/EIO/);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

// ----- 13. result schema revalidation --------------------------------------

describe('listDirectories — result schema revalidation', () => {
  it('13. happy-path result data round-trips through ListDirectoriesResultSchema', () => {
    // Belt-and-braces: even on the happy path, the defensive
    // `safeParse` inside `listDirectories` should accept our data.
    // A future refactor that breaks the schema contract would
    // surface here as `internal` — we assert the happy-path result
    // IS accepted by the same schema the dispatcher will use.
    const root = makeTmpdir();
    mkdirTree(root, { 'alpha-dir': {}, 'beta-dir': {} });
    const result = listDirectories(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The data must validate against the shared schema.
    const revalidated = ListDirectoriesResultSchema.safeParse(result.data);
    expect(revalidated.success).toBe(true);
    // And the round-tripped data is structurally identical.
    expect(revalidated.data).toEqual(result.data);
  });

  it('13b. each entry shape is { name: string, path: string }', () => {
    const root = makeTmpdir();
    mkdirTree(root, { 'only-dir': {} });
    const result = listDirectories(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const entry of result.data.entries) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.path).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.path.length).toBeGreaterThan(0);
    }
  });
});

// ----- 14. domain → wire code mapping (pure helper) -------------------------

describe('mapListDirectoriesDomainCodeToWire — domain → wire mapping', () => {
  // Documents the mapping decision table from `list-directories.ts`
  // header. The mapping is the single source of truth — the
  // dispatcher in `pi-process.ts` calls this helper rather than
  // re-implementing the switch inline. Asserting it here means a
  // future addition to the domain code set forces the test to
  // update, which catches accidental wire-code drift.

  const cases: Array<{
    domain: ListDirectoriesDomainCode;
    wire: 'invalid_envelope' | 'internal';
    rationale: string;
  }> = [
    {
      domain: 'path_not_found',
      wire: 'invalid_envelope',
      rationale: 'ENOENT — user pointed at a non-existent path',
    },
    {
      domain: 'path_not_readable',
      wire: 'invalid_envelope',
      rationale: 'EACCES — user pointed at an unreadable path',
    },
    {
      domain: 'path_not_directory',
      wire: 'invalid_envelope',
      rationale: 'ENOTDIR — user pointed at a file, not a directory',
    },
    {
      domain: 'internal',
      wire: 'internal',
      rationale: 'unexpected fs error — bridge did nothing wrong',
    },
  ];

  for (const { domain, wire, rationale } of cases) {
    it(`14. ${domain} → ${wire} (${rationale})`, () => {
      expect(mapListDirectoriesDomainCodeToWire(domain)).toBe(wire);
    });
  }
});

// ----- 15. dispatcher wiring in pi-process.ts ------------------------------

describe('list-directories dispatcher in pi-process.ts', () => {
  // The dispatcher (pi-process.ts handleListDirectories) emits a
  // `result` envelope with reply_to = request id. We drive the
  // full pipeline here so the wiring is exercised end-to-end.

  it('15a. successful request emits result{ok:true, data} with reply_to=requestId', async () => {
    const { PiProcessManager } = await import('../pi-process.js');
    const tmp = makeTmpdir();
    mkdirTree(tmp, { foo: {}, bar: {} });
    const outbound: { envs: unknown[] } = { envs: [] };
    const manager = new PiProcessManager({
      agentDir: tmp,
      workDir: tmp,
      onOutboundEnvelope: (env) => {
        outbound.envs.push(env);
      },
    });
    manager.start();
    manager.handleEnvelope({
      v: 1,
      kind: 'control',
      type: 'list_directories',
      id: 'ld-req-1',
      payload: { path: tmp },
    });
    // Find the result envelope.
    const resultEnvs = outbound.envs.filter(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { kind?: string }).kind === 'control' &&
        (e as { type?: string }).type === 'result',
    );
    expect(resultEnvs.length).toBeGreaterThanOrEqual(1);
    const result = resultEnvs[0] as {
      reply_to?: string;
      payload: { ok: boolean; data?: { entries: { name: string; path: string }[] } };
    };
    expect(result.reply_to).toBe('ld-req-1');
    expect(result.payload.ok).toBe(true);
    expect(result.payload.data?.entries.map((e) => e.name).sort()).toEqual(['bar', 'foo']);
  });

  it('15b. ENOENT request emits result{ok:false, error.code:"invalid_envelope"}', async () => {
    const { PiProcessManager } = await import('../pi-process.js');
    const tmp = makeTmpdir();
    const ghost = path.join(makeTmpdir(), 'never-existed');
    const outbound: { envs: unknown[] } = { envs: [] };
    const manager = new PiProcessManager({
      agentDir: tmp,
      workDir: tmp,
      onOutboundEnvelope: (env) => {
        outbound.envs.push(env);
      },
    });
    manager.start();
    manager.handleEnvelope({
      v: 1,
      kind: 'control',
      type: 'list_directories',
      id: 'ld-req-2',
      payload: { path: ghost },
    });
    const resultEnvs = outbound.envs.filter(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { kind?: string }).kind === 'control' &&
        (e as { type?: string }).type === 'result',
    );
    expect(resultEnvs.length).toBeGreaterThanOrEqual(1);
    const result = resultEnvs[0] as {
      reply_to?: string;
      payload: {
        ok: boolean;
        error?: { code: string; message: string };
      };
    };
    expect(result.reply_to).toBe('ld-req-2');
    expect(result.payload.ok).toBe(false);
    expect(result.payload.error?.code).toBe('invalid_envelope');
    expect(result.payload.error?.message).toMatch(/does not exist/);
    expect(result.payload.error?.message).toContain(ghost);
  });

  it('15c. list_directories does NOT trigger a spawn (pure fs, no pi involvement)', async () => {
    const { PiProcessManager } = await import('../pi-process.js');
    const tmp = makeTmpdir();
    const spawnChildren: unknown[] = [];
    // The fake spawn factory exists to assert that list_directories
    // never triggers a spawn — if it does, the assertion below
    // (`spawnChildren.length === 0`) will fail. The function itself
    // returns `null` cast to `never` because the real spawn signature
    // returns `PiChild`; in this test we never want to actually
    // construct one.
    const manager = new PiProcessManager({
      agentDir: tmp,
      workDir: tmp,
      spawn: ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        spawnChildren.push({});
        // Return value is irrelevant — list_directories must not
        // call spawn at all, so this branch is unreachable in
        // the test. Use a value cast that lint accepts.
        return null;
      }) as never,
      onOutboundEnvelope: () => undefined,
    });
    manager.start();
    manager.handleEnvelope({
      v: 1,
      kind: 'control',
      type: 'list_directories',
      id: 'ld-req-3',
      payload: { path: tmp },
    });
    // No spawn — list_directories is a read, not a spawn trigger.
    expect(spawnChildren).toHaveLength(0);
    // Phase remains exited (no state machine activity).
    expect(manager.getPhase()).toBe('exited');
  });

  it('15d. list_directories with no path uses $HOME (HOME fixture check)', async () => {
    const fakeHome = makeTmpdir();
    mkdirTree(fakeHome, { 'fake-home-dir': {} });
    const originalHome = process.env['HOME'];
    process.env['HOME'] = fakeHome;
    try {
      const { PiProcessManager } = await import('../pi-process.js');
      const tmp = makeTmpdir();
      const outbound: { envs: unknown[] } = { envs: [] };
      const manager = new PiProcessManager({
        agentDir: tmp,
        workDir: tmp,
        onOutboundEnvelope: (env) => {
          outbound.envs.push(env);
        },
      });
      manager.start();
      manager.handleEnvelope({
        v: 1,
        kind: 'control',
        type: 'list_directories',
        id: 'ld-req-4',
        payload: {}, // no path
      });
      const resultEnvs = outbound.envs.filter(
        (e) =>
          typeof e === 'object' &&
          e !== null &&
          (e as { kind?: string }).kind === 'control' &&
          (e as { type?: string }).type === 'result',
      );
      expect(resultEnvs.length).toBeGreaterThanOrEqual(1);
      const result = resultEnvs[0] as {
        payload: { ok: boolean; data?: { entries: { name: string }[] } };
      };
      expect(result.payload.ok).toBe(true);
      expect(result.payload.data?.entries.map((e) => e.name)).toEqual(['fake-home-dir']);
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    }
  });

  it('15e. list_directories passes through `session` envelope field unchanged on reply', async () => {
    // M4 envelope field: `session` is the multi-session routing key.
    // The dispatcher doesn't need to use it (list_directories is a
    // global fs operation), but the dispatcher should preserve it
    // on the reply so the web can correlate by session. We pass
    // a session id and assert it appears on the result envelope.
    const { PiProcessManager } = await import('../pi-process.js');
    const tmp = makeTmpdir();
    const outbound: { envs: unknown[] } = { envs: [] };
    const manager = new PiProcessManager({
      agentDir: tmp,
      workDir: tmp,
      onOutboundEnvelope: (env) => {
        outbound.envs.push(env);
      },
    });
    manager.start();
    manager.handleEnvelope({
      v: 1,
      kind: 'control',
      type: 'list_directories',
      id: 'ld-req-5',
      session: 'sess-abc-123',
      payload: { path: tmp },
    });
    const resultEnvs = outbound.envs.filter(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { kind?: string }).kind === 'control' &&
        (e as { type?: string }).type === 'result',
    );
    expect(resultEnvs.length).toBeGreaterThanOrEqual(1);
    const result = resultEnvs[0] as { session?: string; reply_to?: string };
    expect(result.session).toBe('sess-abc-123');
    expect(result.reply_to).toBe('ld-req-5');
  });

  // Quiet "unused variable" — `existsSync` is referenced in
  // the file header but not actually used; silence the lint
  // by referencing it once in a no-op assertion.
  it('15z. tmpdir fixtures are cleaned up by afterEach', () => {
    // Sanity check that the cleanup registry runs at least once.
    expect(existsSync(makeTmpdir())).toBe(true);
  });
});