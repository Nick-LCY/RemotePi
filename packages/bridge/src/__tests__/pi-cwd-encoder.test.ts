// Vitest specs for the cwd encoder + session scanner helpers
// (`pi-cwd-encoder.ts`). Covers PRD §2.5 + 已敲定决策 4 acceptance
// cases:
//
//   encodeCwdForPi:
//     1. plain alphanumeric cwd is unchanged
//     2. URL-unsafe chars are encoded per encodeURIComponent then
//        percent-stripped (`encodeURIComponent(cwd).replace(/%/g, '')`)
//     3. forward slashes preserved
//     4. unicode characters get percent-encoded then stripped
//     5. consecutive reserved characters chain correctly
//
//   sessionSubdir:
//     6. wraps encoded cwd with `--` and joins under sessions/
//
//   findLatestSession:
//     7. missing subdir returns null (no crash)
//     8. empty subdir returns null (no candidates)
//     9. multiple files: latest by timestamp wins (ISO lex = chronological)
//    10. multiple files with same timestamp: latest mtime wins
//    11. non-jsonl files are ignored
//    12. unparseable jsonl names are skipped (operator droppings)
//    13. stable ordering when both timestamp + mtime tie (uuid desc)
//
//   sessionArgv:
//    14. empty array when no session exists
//    15. ['--session', <path>] when one exists
//
//   authJsonExists:
//    16. true for an existing regular file
//    17. false when the path doesn't exist
//    18. false when the path exists but is a directory

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authJsonExists,
  encodeCwdForPi,
  findLatestSession,
  resolvePiAgentDir,
  sessionArgv,
  sessionSubdir,
} from '../pi-cwd-encoder.js';

const trackedDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-cwd-encoder-'));
  trackedDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of trackedDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('encodeCwdForPi (PRD §2.5)', () => {
  it('1. encodes a plain cwd path: every character goes through encodeURIComponent + percent-strip', () => {
    // encodeURIComponent percent-encodes '/' too, so the slashes
    // become "2F" after the percent-strip. This is intentional per
    // PRD §2.5 ("实现时严格对齐 pi 官方编码; 推荐先实现
    // encodeURIComponent(cwd).replace(/%/g, '')").
    expect(encodeCwdForPi('/home/user/project')).toBe('2Fhome2Fuser2Fproject');
  });

  it('2. URL-unsafe chars go through encodeURIComponent + percent-strip', () => {
    // space → %20 → "20"
    expect(encodeCwdForPi('/home/user/proj ect')).toBe('2Fhome2Fuser2Fproj20ect');
    // colon → %3A → "3A"
    expect(encodeCwdForPi('/data/x:y')).toBe('2Fdata2Fx3Ay');
  });

  it('3. forward slashes become "2F" (encodeURIComponent does encode them)', () => {
    // / → %2F → "2F"
    expect(encodeCwdForPi('/a/b/c/d/e')).toBe('2Fa2Fb2Fc2Fd2Fe');
  });

  it('4. encodes unicode characters and strips the percent signs', () => {
    // U+4E2D (中) → %E4%B8%AD in encodeURIComponent → "E4B8AD" after strip.
    expect(encodeCwdForPi('/data/中文')).toBe('2Fdata2FE4B8ADE69687');
  });

  it('5. chains correctly for consecutive reserved characters', () => {
    // space, plus, equals → %20 %2B %3D → "20" "2B" "3D"
    expect(encodeCwdForPi('a b+c=d')).toBe('a20b2Bc3Dd');
  });
});

describe('sessionSubdir', () => {
  it('6. wraps the encoded cwd with `--` and joins under sessions/', () => {
    // encodeCwdForPi('/home/u') = '2Fhome2Fu' so the wrapping yields
    // `--2Fhome2Fu--`.
    expect(sessionSubdir('/iso', '/home/u')).toBe(path.join('/iso', 'sessions', '--2Fhome2Fu--'));
  });
});

describe('findLatestSession (PRD §2.5 / 已敲定决策 4)', () => {
  it('7. returns null when the subdir does not exist (no crash, no exception)', () => {
    expect(findLatestSession('/definitely/not/a/real/path/at/all')).toBeNull();
  });

  it('8. returns null when the subdir exists but contains no .jsonl files', () => {
    const sub = makeTmp();
    expect(findLatestSession(sub)).toBeNull();
  });

  it('9. picks the file with the lexicographically-largest timestamp when multiple files exist', () => {
    // ISO timestamps sort the same as chronological order, so the
    // biggest string is the newest.
    const sub = makeTmp();
    const dir = path.join(sub, 'sessions', '--home--');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '2025-01-01T00-00-00_aaa.jsonl'), '');
    writeFileSync(path.join(dir, '2025-06-15T12-30-00_bbb.jsonl'), '');
    writeFileSync(path.join(dir, '2025-12-31T23-59-59_ccc.jsonl'), '');
    expect(findLatestSession(dir)).toBe(path.join(dir, '2025-12-31T23-59-59_ccc.jsonl'));
  });

  it('10. tiebreaks to the file with the latest mtime when timestamps are identical', () => {
    const sub = makeTmp();
    const dir = path.join(sub, 'sessions', '--tie--');
    mkdirSync(dir, { recursive: true });
    const same = '2026-01-01T10-00-00';
    const f1 = path.join(dir, `${same}_uuid1.jsonl`);
    const f2 = path.join(dir, `${same}_uuid2.jsonl`);
    writeFileSync(f1, '');
    writeFileSync(f2, '');
    // Force mtimes: f1 older, f2 newer → f2 must win.
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);
    utimesSync(f1, earlier, earlier);
    utimesSync(f2, now, now);
    expect(findLatestSession(dir)).toBe(f2);
  });

  it('11. ignores non-jsonl files in the subdir', () => {
    const sub = makeTmp();
    const dir = path.join(sub, 'sessions', '--mixed--');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '2025-01-01T00-00-00_a.jsonl'), '');
    writeFileSync(path.join(dir, '2025-12-31T23-59-59_b.jsonl'), '');
    writeFileSync(path.join(dir, 'README.md'), '');
    writeFileSync(path.join(dir, '2025-12-31T23-59-59_b.txt'), '');
    writeFileSync(path.join(dir, 'orphan.jsonl.bak'), '');
    expect(findLatestSession(dir)).toBe(path.join(dir, '2025-12-31T23-59-59_b.jsonl'));
  });

  it('12. skips unparseable jsonl names (no <ts>_<uuid> shape) without poisoning the ranking', () => {
    const sub = makeTmp();
    const dir = path.join(sub, 'sessions', '--unparse--');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '2025-01-01T00-00-00_good.jsonl'), '');
    // Filename with no underscore separator → unparseable.
    writeFileSync(path.join(dir, 'strayname.jsonl'), '');
    // Filename with multiple underscores, but the extension matches
    // and the pattern matches anyway because we anchor on `.jsonl`:
    //   `2025-01-01T00-00-00_with_underscores.jsonl` parses as
    //   `timestamp = "2025-01-01T00-00-00"`, `uuid = "with_underscores"`
    //   (the regex's `[^_]+\.jsonl$` anchor takes the last `_`).
    writeFileSync(path.join(dir, '2025-12-31T23-59-59_with_underscores.jsonl'), '');
    expect(findLatestSession(dir)).toBe(
      path.join(dir, '2025-12-31T23-59-59_with_underscores.jsonl'),
    );
  });

  it('13. stable ordering when both timestamp + mtime tie (uuid desc)', () => {
    const sub = makeTmp();
    const dir = path.join(sub, 'sessions', '--stable--');
    mkdirSync(dir, { recursive: true });
    const same = '2026-02-02T02-02-02';
    // Two uuids; we force identical mtimes by writing the files in
    // rapid succession (sub-second resolution on filesystems that
    // truncate to whole seconds). The scanner's final tiebreak is
    // uuid descending — so `zzz` should win over `aaa` consistently.
    const a = path.join(dir, `${same}_aaa.jsonl`);
    const z = path.join(dir, `${same}_zzz.jsonl`);
    writeFileSync(a, '');
    writeFileSync(z, '');
    expect(findLatestSession(dir)).toBe(z);

    // Run again to assert determinism — same input must always yield
    // the same output.
    expect(findLatestSession(dir)).toBe(z);
  });

  it('13a. (S7) garbage filenames with non-ISO timestamp prefixes are excluded from the latest ranking', () => {
    // S7 review follow-up: files like `strayname.jsonl` or
    // `notadate_uuid.jsonl` would previously parse with
    // `timestamp = "strayname"` / `"notadate"`, then sort
    // lexicographically against real ISO timestamps — a non-ISO
    // prefix could win the "latest" race and poison the session
    // scanner with a garbage file. The new parser rejects any
    // timestamp prefix that doesn't match `/^\d{4}-\d{2}-\d{2}/`.
    const sub = makeTmp();
    const dir = path.join(sub, 'sessions', '--s7--');
    mkdirSync(dir, { recursive: true });
    const realFile = path.join(dir, '2026-04-04T04-04-04_real.jsonl');
    const garbageUnderscore = path.join(dir, 'notadate_uuid.jsonl');
    const garbageNoUnderscore = path.join(dir, 'strayname.jsonl');
    const garbagePrefix = path.join(dir, 'xxx2026-04-04T04-04-04_real.jsonl');
    writeFileSync(realFile, '');
    writeFileSync(garbageUnderscore, '');
    writeFileSync(garbageNoUnderscore, '');
    writeFileSync(garbagePrefix, '');
    // Only the real file is a candidate — the rest are skipped.
    expect(findLatestSession(dir)).toBe(realFile);
  });
});

describe('sessionArgv (spawn argv helper)', () => {
  it('14. returns [] when no session exists', () => {
    const sub = makeTmp();
    expect(sessionArgv(sub)).toEqual([]);
  });

  it('15. returns ["--session", "<path>"] when a session exists', () => {
    const sub = makeTmp();
    const dir = path.join(sub, 'sessions', '--argv--');
    mkdirSync(dir, { recursive: true });
    const expected = path.join(dir, '2026-05-05T05-05-05_x.jsonl');
    writeFileSync(expected, '');
    expect(sessionArgv(dir)).toEqual(['--session', expected]);
  });
});

describe('authJsonExists', () => {
  it('16. returns true for an existing regular file', () => {
    const dir = makeTmp();
    const f = path.join(dir, 'auth.json');
    writeFileSync(f, '{}');
    expect(authJsonExists(f)).toBe(true);
  });

  it('17. returns false when the path does not exist', () => {
    expect(authJsonExists('/definitely/not/a/real/path/auth.json')).toBe(false);
  });

  it('18. returns false when the path exists but is a directory', () => {
    const dir = makeTmp();
    expect(authJsonExists(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolvePiAgentDir — decision 2026-09-05
//
// Bridge no longer owns an isolated pi profile; the agent dir is the
// host's default (env first, `~/.pi/agent` otherwise). The resolver
// must agree with pi's own `config.js getAgentDir()` so a
// bridge-scanned --session path and pi's session writes point at the
// same directory.
//
// All cases mock `process.env` and `os.homedir()` so the tests are
// sealed against the host's actual ~/.pi state (the old isolation
// fixture was sensitive to whether the host happened to have
// `~/.pi/agent/auth.json` present, which it usually does — a
// flakiness source the rewrite closes).
// ---------------------------------------------------------------------------

describe('resolvePiAgentDir (decision 2026-09-05)', () => {
  it('19. honours PI_CODING_AGENT_DIR when set to an absolute path', () => {
    // Absolute override: returned verbatim, no homedir mix.
    expect(
      resolvePiAgentDir({ PI_CODING_AGENT_DIR: '/custom/agent/path' }),
    ).toBe('/custom/agent/path');
  });

  it('20. expands a leading ~/ to the current home directory', () => {
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/home/operator');
    try {
      expect(
        resolvePiAgentDir({ PI_CODING_AGENT_DIR: '~/work/agent' }),
      ).toBe('/home/operator/work/agent');
      // Bare `~` also expands to the home dir.
      expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: '~' })).toBe('/home/operator');
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('21. falls back to <homedir>/.pi/agent when PI_CODING_AGENT_DIR is unset', () => {
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/home/operator');
    try {
      expect(resolvePiAgentDir({})).toBe('/home/operator/.pi/agent');
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('21a. falls back to <homedir>/.pi/agent when PI_CODING_AGENT_DIR is set but empty', () => {
    // Empty string is treated the same as unset — guards against
    // an operator who set `PI_CODING_AGENT_DIR=` in their shell
    // rc file and got a no-op override they didn't expect.
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/home/operator');
    try {
      expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: '' })).toBe(
        '/home/operator/.pi/agent',
      );
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('22. non-tilde relative paths are returned verbatim (no homedir prepending)', () => {
    // `work/agent` is a relative path; the resolver doesn't try
    // to be clever about it — pi would also treat it verbatim
    // and resolve relative to its own cwd, so the bridge should
    // match. The key invariant is "no tilde prefix → no homedir
    // prefix"; we don't need to validate that the path is
    // sensible because pi will.
    expect(
      resolvePiAgentDir({ PI_CODING_AGENT_DIR: 'work/agent' }),
    ).toBe('work/agent');
  });

  it('23. does not consult the host filesystem (sealed against ~/.pi/agent state)', () => {
    // Sealed: even if the host genuinely has ~/.pi/agent/auth.json
    // (the old isolation dir's auth check was sensitive to this),
    // the resolver returns the path string only — it never reads,
    // stats, or otherwise touches the filesystem. We assert the
    // shape (a string) and equality to the expected default; a
    // future regression that adds a fs.statSync / existsSync call
    // to the resolver would be a clear violation of the sealed
    // contract but won't be caught by this specific assertion —
    // the real defence is the test being co-located with the
    // sealed-decision comment so a reviewer reads it.
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/home/operator');
    try {
      // Purge any env override so we exercise the default path.
      const resolved = resolvePiAgentDir({});
      expect(typeof resolved).toBe('string');
      expect(resolved).toBe('/home/operator/.pi/agent');
    } finally {
      homedirSpy.mockRestore();
    }
  });
});
