// Bridge helper: encode cwd for pi's session directory layout.
//
// pi v0.85.1 stores session files at:
//   <agentDir>/sessions/--<cwd encoding>--/<timestamp>_<uuid>.jsonl
// where `<agentDir>` is the directory pi treats as its `$PI_CODING_AGENT_DIR`
// (or, when unset, its compiled-in default of `~/.pi/agent`). `<cwd encoding>`
// is derived from the cwd string. PRD §2.5 pins the encoding as
// `encodeURIComponent(cwd).replace(/%/g, '')`:
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
// The path-building helper (`sessionSubdir`), the agent-dir resolver
// (`resolvePiAgentDir`), and the latest-session scanner
// (`findLatestSession`) live alongside the encoder because they all
// consume the same `--<encoded>--` token and the test suite wants to
// exercise them as a single shape.

import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Resolve the directory pi treats as its agent root.
 *
 *  Mirrors pi's own `config.js getAgentDir()` semantics:
 *    1. If `process.env.PI_CODING_AGENT_DIR` is set, expand a leading
 *       `~` (or `~/...`) to the corresponding home directory and use
 *       the result verbatim. pi does the same expansion; honouring it
 *       here means the bridge scan + pi's session writes always point
 *       at the same directory regardless of whether the env var was
 *       set as `~/work/agent` or `/abs/work/agent`.
 *    2. Otherwise, fall back to `<homedir()>/.pi/agent` — pi's
 *       compiled-in default.
 *
 *  The bridge does NOT inject `PI_CODING_AGENT_DIR` into spawn env
 *  (decision 2026-09-05: "bridge 去隔离, 复用宿主机 pi 环境"). If the
 *  operator wants the bridge to use a non-default location, they set
 *  the env var in the bridge's own process environment — `pi` will
 *  see it through the inherited env and `resolvePiAgentDir` will see
 *  it here. The two paths agree because both consult `process.env`
 *  with the same priority.
 *
 *  Tilde expansion is intentionally minimal: only a leading `~/...`
 *  (or bare `~`) is rewritten, via `os.homedir()`. A leading `~user`
 *  form is not supported — pi itself does not expand arbitrary
 *  `~user` either, and the bridge never sets the env var in a way
 *  that would surface that case. Backslash separators are
 *  intentionally NOT handled — the bridge targets POSIX paths
 *  only, and `path.join` would normalise any `\\` we forwarded
 *  anyway, hiding the difference in the returned string.
 *
 *  Known limitations — this resolver mirrors only the OFFICIAL `pi`
 *  distribution's default layout (`PI_CODING_AGENT_DIR` env var +
 *  `~/.pi/agent` fallback + `<agentDir>/auth.json` + sessions under
 *  `<agentDir>/sessions/--<encoded>--/`). Two upstream knobs are
 *  NOT modelled here:
 *    1. pi's package-level config can rename the config dir from
 *       `.pi` to something else (e.g. `.tau`). The fallback path
 *       here is hard-coded to `.pi/agent`; on a renamed install the
 *       bridge will scan the wrong directory.
 *    2. A pi fork / repackaged distribution may rename the env var
 *       itself (e.g. `TAU_CODING_AGENT_DIR`). The bridge only reads
 *       `PI_CODING_AGENT_DIR`.
 *  Operators running a renamed config or a fork must point the
 *  bridge at the right directory by exporting
 *  `PI_CODING_AGENT_DIR=<their-agent-dir>` in the bridge's own
 *  process environment before launch — both `resolvePiAgentDir`
 *  (here) and `pi` itself (via the inherited env) will then agree
 *  on the same path. The bridge does not auto-detect these cases.
 */
export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['PI_CODING_AGENT_DIR'];
  if (raw !== undefined && raw.length > 0) {
    if (raw === '~' || raw.startsWith('~/')) {
      return path.join(os.homedir(), raw.slice(1));
    }
    return raw;
  }
  return path.normalize(path.join(os.homedir(), '.pi', 'agent'));
}

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

/** Build the per-cwd session subdirectory inside pi's agent root:
 *  `<agentDir>/sessions/--<encoded>--/`.
 *
 *  The leading + trailing `--` are part of pi's convention (see
 *  roadmap §4.6) — they make the directory name unambiguous when
 *  scanned alphabetically and easy to recognise in `ls` output.
 *
 *  Parameter name was previously `isolationDir`; semantics are
 *  identical — it's just the directory the bridge + pi agree to
 *  share. Tests still pass a tmp dir here, the production caller
 *  passes `resolvePiAgentDir()`. */
export function sessionSubdir(agentDir: string, cwd: string): string {
  return path.join(agentDir, 'sessions', `--${encodeCwdForPi(cwd)}--`);
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
 *  for pi's agent directory tree. Returns true iff the file exists
 *  and is a regular file (or symlink to one) — a directory or broken
 *  symlink at this path is treated as missing.
 *
 *  Caller is expected to pass `<agentDir>/auth.json`; the helper
 *  itself is path-agnostic (it just stats whatever it's handed) so
 *  tests can drive it against arbitrary fixtures. */
export function authJsonExists(authJsonPath: string): boolean {
  if (!existsSync(authJsonPath)) return false;
  try {
    return statSync(authJsonPath).isFile();
  } catch {
    return false;
  }
}
