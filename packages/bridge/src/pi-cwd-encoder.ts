// Bridge helper: encode cwd for pi's session directory layout.
//
// pi v0.85.1 stores session files at:
//   <PI_CODING_AGENT_DIR>/sessions/--<cwd encoding>--/<timestamp>_<uuid>.jsonl
// where `<cwd encoding>` is derived from the cwd string. PRD §2.5 pins the
// encoding as `encodeURIComponent(cwd).replace(/%/g, '')`:
//
//   - `encodeURIComponent` percent-encodes everything that isn't URL-safe
//     (e.g. space → `%20`, `:` → `%3A`).
//   - `.replace(/%/g, '')` strips every percent sign — the remaining
//     ASCII letters are kept verbatim. So a space becomes the literal
//     string `20`, a colon becomes `3A`, and the resulting folder name
//     is a doubled-dash-delimited token like `--homeuserproject--`.
//
// Real-pi validation (spinning up a real `pi --mode rpc` against a real
// tmpdir and diffing the directory it creates against the path this
// encoder predicts) is a regression item scheduled for M3 task 08
// (联调手测验收) — if the encoding does not match pi's output, the
// session scanner will point at the wrong directory and bridge restart
// cannot recover the latest session. The encoder here is a deterministic
// pure function so the diff step is one `mkdir` + one `spawn` away.
//
// The path-building helper (`sessionSubdir`) and the latest-session
// scanner (`findLatestSession`) live alongside the encoder because they
// all consume the same `--<encoded>--` token and the test suite wants to
// exercise them as a single shape.

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Encode a cwd string into pi's `<cwd encoding>` token (PRD §2.5).
 *
 *  The transformation is `encodeURIComponent` followed by stripping
 *  every percent sign — this is intentionally NOT a generic
 *  "URL-safe" encoding; it's a one-line approximation of what pi
 *  v0.85.1 does internally. If real-pi validation in task 08 reveals
 *  the encoding is wrong (e.g. pi uses a different strategy for
 *  unicode / special chars), this function is the single edit site —
 *  every consumer goes through `encodeCwdForPi`, and the test suite
 *  asserts the exact token shape so a regression is caught. */
export function encodeCwdForPi(cwd: string): string {
  return encodeURIComponent(cwd).replace(/%/g, '');
}

/** Build the per-cwd session subdirectory inside the bridge's
 *  isolation root: `<isolationDir>/sessions/--<encoded>--/`.
 *
 *  The leading + trailing `--` are part of pi's convention (see
 *  roadmap §4.6) — they make the directory name unambiguous when
 *  scanned alphabetically and easy to recognise in `ls` output. */
export function sessionSubdir(isolationDir: string, cwd: string): string {
  return path.join(isolationDir, 'sessions', `--${encodeCwdForPi(cwd)}--`);
}

/** Strip the `.jsonl` extension + extract the timestamp prefix from a
 *  pi session filename. Returns `null` when the filename doesn't match
 *  the `<timestamp>_<uuid>.jsonl` shape — those files are skipped by
 *  the scanner rather than silently treated as "oldest".
 *
 *  We anchor on the `.jsonl` suffix (the stable shape) and split at
 *  the LAST `_` in the stem, so timestamps that happen to contain
 *  underscores (a real-pi regression / future format change) still
 *  parse cleanly and yield a sane uuid tiebreaker.
 *
 *  S7 review follow-up: the timestamp prefix must look like an
 *  ISO date (`YYYY-MM-DD...`) before we trust it. Files like
 *  `strayname.jsonl` or `notadate_uuid.jsonl` previously parsed
 *  with `timestamp = "strayname"` / `"notadate"`, which then
 *  sorted lexicographically against real ISO timestamps — the
 *  non-ISO prefix could win the "latest" race and poison the
 *  session scanner with a garbage file. We now require the
 *  prefix to match `/^\d{4}-\d{2}-\d{2}/`; anything else is
 *  treated as unparseable and dropped from the ranking. The
 *  shape is intentionally narrow (digits + hyphens, no
 *  timezone letters) — real pi timestamps always start
 *  `YYYY-MM-DDTHH-MM-SS` and we only need to weed out operator
 *  droppings. */
function parseSessionFilename(name: string): { timestamp: string; uuid: string } | null {
  if (!name.endsWith('.jsonl')) return null;
  const stem = name.slice(0, -'.jsonl'.length);
  const idx = stem.lastIndexOf('_');
  // idx <= 0 means no separator (or separator at index 0 — empty
  // timestamp). Either way the file doesn't fit the `<ts>_<uuid>`
  // shape and gets skipped.
  if (idx <= 0) return null;
  const timestamp = stem.slice(0, idx);
  // S7: ISO-prefix guard. Anything that doesn't look like an
  // ISO date is operator droppings, not a session file.
  if (!/^\d{4}-\d{2}-\d{2}/.test(timestamp)) return null;
  return { timestamp, uuid: stem.slice(idx + 1) };
}

/** Pick the most-recent session file inside `subdir`, or `null` when
 *  there are no candidates (subdir doesn't exist or has no `.jsonl`).
 *
 *  "Most recent" = (1) latest timestamp prefix by lexicographic order
 *  (ISO timestamps sort the same as chronological), then (2) tiebreak
 *  by latest mtime, then (3) tiebreak by uuid descending (stable,
 *  deterministic, no random tiebreak). This matches PRD §2.5 / 已敲定
 *  决策 4 verbatim.
 *
 *  We use synchronous `fs` calls because the bridge only ever runs
 *  this once at spawn time and we want the spawn to wait until the
 *  scan completes (so the first command after restart lands on the
 *  right session). Async would introduce a window where the spawn
 *  fires before the path is known. */
export function findLatestSession(subdir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(subdir).filter((n) => n.endsWith('.jsonl'));
  } catch (err) {
    // ENOENT = no sessions yet (bridge's first run, or a fresh work_dir
    // never used). Any other error is unexpected — propagate so the
    // operator sees the real cause in the log.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (entries.length === 0) return null;

  // Parse + enrich with mtime. Skip unparseable names so a stray
  // file (e.g. operator droppings) doesn't poison the ranking.
  const enriched = entries
    .map((name) => {
      const parsed = parseSessionFilename(name);
      if (parsed === null) return null;
      const stat = statSync(path.join(subdir, name));
      return { name, timestamp: parsed.timestamp, uuid: parsed.uuid, mtime: stat.mtimeMs };
    })
    .filter(
      (e): e is { name: string; timestamp: string; uuid: string; mtime: number } => e !== null,
    );
  if (enriched.length === 0) return null;

  // Sort: newest timestamp first; tiebreak by latest mtime; final
  // tiebreak by uuid descending (deterministic across runs — without
  // it, two files with the same timestamp + same mtime would pick
  // based on the underlying sort's stability, which JS Array#sort
  // doesn't guarantee).
  enriched.sort((a, b) => {
    if (a.timestamp < b.timestamp) return 1;
    if (a.timestamp > b.timestamp) return -1;
    if (a.mtime !== b.mtime) return b.mtime - a.mtime;
    if (a.uuid > b.uuid) return -1;
    if (a.uuid < b.uuid) return 1;
    return 0;
  });

  // `enriched` was non-empty before the sort, so the head survives.
  const head = enriched[0];
  if (head === undefined) return null;
  return path.join(subdir, head.name);
}

/** Build the full `--session <path>` argv slice, or an empty array when
 *  no latest session exists. Convenience for the spawn site — keeps
 *  the "spread or nothing" decision in one place. */
export function sessionArgv(subdir: string): string[] {
  const latest = findLatestSession(subdir);
  return latest === null ? [] : ['--session', latest];
}

/** Convenience for the auth.json check at startup. Kept here (next to
 *  the other fs-based helpers) so the bridge has one fs touch-point
 *  for the pi-agent directory tree. Returns true iff the file exists
 *  and is a regular file (or symlink to one) — a directory or broken
 *  symlink at this path is treated as missing. */
export function authJsonExists(authJsonPath: string): boolean {
  if (!existsSync(authJsonPath)) return false;
  try {
    return statSync(authJsonPath).isFile();
  } catch {
    return false;
  }
}
