// Bridge state.json loader + WorkDirStore — M4 task 04.
//
// ## File separation (PRD §2.1)
//
// The bridge keeps two files under `~/.config/remotepi/`:
//
//   - `bridge.json` — user-edited config (worker_url / web_base_url /
//     work_dir / token). Read once on startup, never written by the
//     bridge.
//   - `state.json`  — bridge-runtime state (`work_dirs: string[]`).
//     Written by the bridge on every `work_dir_add` / `work_dir_remove`.
//     Users who edit it by hand are opting into "anything I write here
//     may be overwritten" — the file is the bridge's, not the
//     operator's.
//
// ## Wire surface
//
// `state.json` JSON shape (PRD §2.1):
//   { "schema_version": 1, "work_dirs": ["/abs/path/a", "/abs/path/b"] }
//
// `schema_version: z.literal(1)` is the lock-version guard — a future
// bump to v2 would expand the schema (e.g. add a `default_work_dir`
// or a per-directory metadata object) and the loader would refuse to
// read a v1 file without an explicit migration.
//
// ## Failure modes (PRD §2.1 + task 04 spec)
//
// - File missing → empty list (no error). This is the "first run" /
//   "fresh install" path and is the *expected* state, not an error.
//   We treat it identically to "the user has never added a work
//   directory" — both surface as `work_dirs: []` to the rest of the
//   bridge.
// - File present but malformed (JSON parse failure / missing
//   `schema_version` / missing `work_dirs` / wrong field types) →
//   throw `StateError`. The bridge startup fails fast and the
//   operator sees a friendly line + `process.exitCode = 1` (the same
//   pattern `ConfigError` uses for `bridge.json`). We deliberately
//   do NOT silently drop the file and start with an empty list —
//   "your state file is broken but the bridge pretends nothing
//   happened" is the kind of corruption that takes days to notice
//   and is impossible to debug after the fact. The atomic write
//   (tmp + rename) and the on-disk existence of the previous good
//   file mean an operator in this state can recover by hand-editing
//   the JSON or deleting it (the latter is acceptable because the
//   file is the bridge's, not the user's — see §"File separation"
//   above).
//
// ## Atomic writes
//
// Every `saveStateFile` call writes to a `.tmp` sibling first, then
// `rename`s over the destination. POSIX `rename` is atomic for files
// on the same filesystem; the tmp + destination always share a parent
// directory, so this holds by construction.
//
// Concurrency boundary: atomicity is a single-writer, single-process
// guarantee. The bridge assumes one bridge process writes a given
// XDG state file; the fixed `.tmp` sibling is not protected against
// two bridge processes sharing the same XDG root. Inter-process
// locking is deliberately outside this task's scope. This prevents
// a crash mid-write from leaving the file in a half-written state —
// the next read either sees the previous good copy or the complete
// new copy, never a torn frame.
//
// ## WorkDirStore rollback semantics
//
// `WorkDirStore.add` / `remove` mutate the in-memory list first,
// then attempt the on-disk save. If the save throws, the in-memory
// mutation is rolled back (`add` pops what it just pushed, `remove`
// re-pushes what it just filtered) and the error is re-thrown to
// the caller. This means a `work_dir_add` that the disk refused is
// invisible to subsequent `work_dir_list` queries — the bridge
// either succeeds atomically on both sides, or fails atomically on
// both sides.
//
// `migrateFromBridgeConfig` runs at startup, AFTER `loadBridgeConfig`
// has already validated `bridge.json`. `bridge.json` is NEVER written
// by the migration — the user's hand-edited config stays untouched
// (PRD §2.1: "不回写 bridge.json （用户手编配置不被运行时污染）").
// Operators can delete `work_dir` from their `bridge.json` after a
// successful migration; the next startup will see the state file
// and skip the migration (idempotent — `migrateFromBridgeConfig`
// only fires when `state.json` is missing).

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { BridgeConfig } from './config.js';
import { logger, type Logger } from './logger.js';

/** Current state.json schema version. Bumping this is a wire-breaking
 *  change for operators who hand-edit the file — the loader will
 *  reject unknown schema versions. */
export const STATE_SCHEMA_VERSION = 1 as const;

/** zod schema for the on-disk `state.json` shape. `.strict()` so
 *  unknown keys surface as parse failures (e.g. a typo'd
 *  `work_dirS` field is caught at load, not silently dropped). */
export const StateFileSchema = z
  .object({
    schema_version: z.literal(STATE_SCHEMA_VERSION),
    work_dirs: z.array(z.string()),
  })
  .strict();
export type StateFile = z.infer<typeof StateFileSchema>;

/** Error class for every recoverable failure in the state.json
 *  loading pipeline. Mirrors the `ConfigError` shape: a stable
 *  machine-readable `code` plus a human-friendly `message`. The
 *  `cause` carries the underlying error (SyntaxError, ZodError, fs
 *  exception) for diagnostics. */
export class StateError extends Error {
  readonly code: 'parse_failed' | 'invalid_state';
  constructor(
    code: 'parse_failed' | 'invalid_state',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

/** Resolve the default state.json path. XDG-aware per the XDG Base
 *  Directory specification, mirroring `resolveDefaultConfigPath`:
 *   - `process.env.XDG_CONFIG_HOME` if set (and non-empty) → that
 *     directory + `/remotepi/state.json`.
 *   - Otherwise → `~/.config/remotepi/state.json`.
 *  Read on every call (not cached at module load) so tests can flip
 *  the env var per-case. */
export function resolveDefaultStatePath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg !== '') {
    return path.join(xdg, 'remotepi', 'state.json');
  }
  return path.join(os.homedir(), '.config', 'remotepi', 'state.json');
}

/** Load + validate `state.json` from the given path. Behaviour:
 *   - File missing → returns `[]` (no error, "first run" path).
 *   - File present but unreadable / not valid JSON / fails zod
 *     validation → throws `StateError` with the appropriate code.
 *  The returned array is a *fresh copy* of the on-disk work_dirs —
 *  callers can mutate it without touching the file. The on-disk file
 *  is only touched by `saveStateFile` (atomic rename) and by
 *  `migrateFromBridgeConfig` (which goes through the same atomic
 *  write). */
export function loadStateFile(statePath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch (err) {
    // ENOENT = "first run" — return empty list. EACCES / EISDIR /
    // other read errors are operational failures: the file exists
    // and is broken in a way that needs operator attention.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new StateError(
      'parse_failed',
      `cannot read state file: ${statePath} (${(err as Error).message})`,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateError(
      'parse_failed',
      `state file is not valid JSON: ${statePath} (${(err as Error).message})`,
      err,
    );
  }

  const result = StateFileSchema.safeParse(parsed);
  if (!result.success) {
    // Format the zod issues into a compact, operator-friendly summary.
    // Same shape as `loadBridgeConfig` — a zod "unrecognized_keys"
    // issue points at a typo'd field; a "missing_field" issue points
    // at an absent required field. Both are "your state file is
    // broken", which collapses onto `invalid_state`.
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new StateError(
      'invalid_state',
      `state file failed validation: ${issues}`,
      result.error,
    );
  }

  // Fresh copy so the caller can mutate the result without touching
  // a shared backing array. (Currently no caller mutates, but the
  // contract is "you own what we return" — same as the M3
  // `BridgeConfig` shape.)
  return [...result.data.work_dirs];
}

/** Atomic write: `fs.writeFileSync(statePath + '.tmp', json)` then
 *  `fs.renameSync(statePath + '.tmp', statePath)`. POSIX guarantees
 *  `rename` is atomic for files on the same filesystem; the tmp +
 *  destination always share a parent directory, so this holds by
 *  construction.
 *
 *  The parent directory of `statePath` is created with
 *  `mkdirSync({ recursive: true })` if it does not exist. This
 *  covers the "fresh install" path: a developer who has never run
 *  the bridge before will have no `~/.config/remotepi/` directory.
 *  We deliberately do NOT create the directory during a load
 *  attempt — the loader is read-only and a missing file is the
 *  "first run" path (returns `[]`). Directory creation happens
 *  here, on the write side, which is the operation that actually
 *  needs it.
 *
 *  The payload is built from the provided work_dirs + a literal
 *  `schema_version: STATE_SCHEMA_VERSION` field. The JSON is
 *  pretty-printed with 2-space indentation so an operator who opens
 *  the file in an editor can read it without jq.
 *
 *  Atomicity is a single-writer, single-process guarantee: the bridge
 *  assumes one bridge process writes this state file. The fixed `.tmp`
 *  sibling is not protected against two bridge processes sharing an XDG
 *  root; inter-process locking is outside this task's scope. */
export function saveStateFile(statePath: string, workDirs: readonly string[]): void {
  const payload: StateFile = {
    schema_version: STATE_SCHEMA_VERSION,
    work_dirs: [...workDirs],
  };
  // Two-space indentation matches the existing `bridge.json` examples
  // in the docs; keeps the on-disk look consistent across the two
  // config files.
  const json = JSON.stringify(payload, null, 2);
  const tmpPath = `${statePath}.tmp`;
  // Ensure the parent directory exists. `recursive: true` makes
  // this a no-op when the directory already exists, and creates
  // the full intermediate path (e.g. `~/.config/remotepi/` on a
  // first install where neither directory exists yet) when it
  // does not. We do this BEFORE the tmp write so the rename's
  // "same filesystem" precondition holds — a tmp file written
  // into a freshly-created parent directory and then renamed
  // across that same directory is always atomic.
  mkdirSync(path.dirname(statePath), { recursive: true });
  // Keep both phases inside one cleanup guard. A write can create a
  // partial tmp file and then throw (ENOSPC, quota, or a short write),
  // so protecting only rename would leak that file.
  try {
    writeFileSync(tmpPath, json, 'utf8');
    renameSync(tmpPath, statePath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Swallow cleanup errors — the primary error is more
        // actionable. A leaked tmp file is recoverable on the
        // next save.
      }
    }
    throw err;
  }
}

/** Three-piece check for a candidate work directory. Mirrors the M3
 *  config.ts validation pattern (PRD §2.1: "存在 + 是目录 + 可读"):
 *   1. `statSync(path)` — path exists at all.
 *   2. `stat.isDirectory()` — it's a directory, not a file/symlink-to-file/etc.
 *   3. `accessSync(path, R_OK)` — current user can read it.
 *  Throws `StateError` with `code: 'invalid_state'` on any failure.
 *  Used by `WorkDirStore.add` to gate the mutation; the message names
 *  the precise problem (missing vs. not-a-directory vs. not-readable)
 *  so the caller can surface it to the web via `error.message`. */
export function validateWorkDir(workDir: string): void {
  let stat: import('node:fs').Stats;
  try {
    stat = statSync(workDir);
  } catch (err) {
    throw new StateError(
      'invalid_state',
      `work_dir is not accessible: ${workDir} (${(err as Error).message})`,
      err,
    );
  }
  if (!stat.isDirectory()) {
    throw new StateError(
      'invalid_state',
      `work_dir is not a directory: ${workDir}`,
    );
  }
  try {
    accessSync(workDir, constants.R_OK);
  } catch (err) {
    throw new StateError(
      'invalid_state',
      `work_dir is not readable: ${workDir} (${(err as Error).message})`,
      err,
    );
  }
}

/** M3 → M4 migration. Runs at bridge startup, AFTER `loadBridgeConfig`
 *  has validated `bridge.json` (so `bridgeConfig.work_dir` is
 *  guaranteed to pass the M3 three-piece check at the moment the
 *  bridge was last started).
 *
 *  Behaviour:
 *   - If `state.json` already exists → returns its work_dirs list
 *     (no migration needed, idempotent across restarts).
 *   - If `state.json` is missing AND `bridgeConfig.work_dir` is
 *     non-empty:
 *       1. Re-validate `work_dir` (paranoid — could be unreadable
 *          now even if it was readable at config-load time; e.g.
 *          NFS went away, permissions changed).
 *       2. Atomically write a fresh `state.json` with
 *          `[work_dir]` as the only entry.
 *       3. Log a one-time info line so operators can see the
 *          migration happened.
 *       4. Return `[work_dir]`.
 *   - If `state.json` is missing AND `bridgeConfig.work_dir` is
 *     absent / empty → return `[]` and write a fresh `state.json`
 *     containing `[]`. The empty state is the
 *     "post-migration, user-hasn't-added-anything-yet" baseline;
 *     writing it to disk means subsequent starts don't have to
 *     re-evaluate the "should I migrate?" question.
 *
 *  `bridge.json` is NEVER written. PRD §2.1: "不回写 bridge.json
 *  （用户手编配置不被运行时污染）". The migration is a one-way
 *  transfer: the value lives in `state.json` after this runs, and
 *  the user is free to clean it out of `bridge.json` on their own
 *  time. */
export function migrateFromBridgeConfig(
  bridgeConfig: BridgeConfig,
  statePath: string,
  log: Logger = logger,
): string[] {
  // Fast path: state.json already exists → no migration, just load.
  if (existsSync(statePath)) {
    const workDirs = loadStateFile(statePath);
    // A persisted state file may have been hand-edited or may point
    // at a directory that disappeared since the previous run. Apply
    // the same M3 three-piece check before starting the bridge.
    for (const workDir of workDirs) {
      validateWorkDir(workDir);
    }
    return workDirs;
  }

  // Migration path: state.json missing, bridge.json has a work_dir.
  const workDir = bridgeConfig.work_dir;
  // Empty strings cannot pass M3's `BridgeConfigSchema.work_dir`
  // `min(1)` check. This is defensive input handling for callers that
  // construct a BridgeConfig-like value programmatically (or for a
  // future schema relaxation), not an M3 schema-valid case.
  if (workDir === undefined || workDir === '') {
    // No migration to do, but write an empty state file so the
    // "state.json exists?" check on subsequent starts returns
    // true and skips this branch entirely. Operators who inspect
    // the XDG dir won't find a missing file + wonder why.
    saveStateFile(statePath, []);
    return [];
  }

  // Re-validate the candidate work_dir before persisting it. M3
  // already did this at `loadBridgeConfig` time, but power-cycled
  // disks / permission flips between bridge invocations could leave
  // a previously-valid path unreadable. Catching it here gives the
  // operator a clean "your M3 work_dir is no longer valid, fix the
  // path" message instead of a silent state.json pointing at a
  // dead directory.
  validateWorkDir(workDir);

  // Persist + log + return. The log line is the operator's only
  // signal that the migration happened — without it, a
  // state.json appearing in their XDG dir out of nowhere is
  // confusing. The line intentionally includes the migrated path
  // so an operator who manages multiple bridges / multiple
  // machines can confirm the right one fired.
  saveStateFile(statePath, [workDir]);
  log.info(
    `migrated work_dir from bridge.json → state.json: ${workDir}`,
  );
  return [workDir];
}

/** In-memory store for the work_dirs list. Owns the atomic write +
 *  rollback semantics so callers can fire-and-forget `add` / `remove`
 *  and trust that the on-disk state matches the in-memory state on
 *  success, or neither is touched on failure.
 *
 *  Construction:
 *   - `new WorkDirStore(initialWorkDirs, statePath)` — caller has
 *     already loaded + migrated the list. This is the production
 *     path (`index.ts` calls `loadStateFile` + `migrateFromBridgeConfig`
 *     then hands the result here).
 *   - `WorkDirStore.empty(statePath)` — convenience for "fresh
 *     install" / tests.
 *
 *  Mutation methods:
 *   - `add(path)` — three-piece check → push to in-memory list →
 *     save. If the save throws, the in-memory push is rolled back
 *     and the error re-thrown. Idempotent: adding an existing
 *     directory is a no-op (no write).
 *   - `remove(path)` — filter from in-memory list → save. If the
 *     save throws, the in-memory filter is rolled back and the
 *     error re-thrown. Removing a non-existent path is a no-op
 *     (no write).
 *
 *  Read method:
 *   - `list()` — returns a *fresh copy* of the in-memory list. The
 *     store's internal array is never exposed; callers cannot
 *     accidentally mutate it. */
export class WorkDirStore {
  private readonly statePath: string;
  private workDirs: string[];

  constructor(initialWorkDirs: string[], statePath: string) {
    this.workDirs = [...initialWorkDirs];
    this.statePath = statePath;
  }

  /** Convenience constructor for the "fresh install / tests" case
   *  where the initial list is empty. */
  static empty(statePath: string): WorkDirStore {
    return new WorkDirStore([], statePath);
  }

  /** Returns a fresh copy of the current work_dirs list. The store
   *  never exposes its internal array; callers cannot mutate it
   *  by accident. */
  list(): string[] {
    return [...this.workDirs];
  }

  /** Add a work directory. Three-piece check (exists + is dir +
   *  readable) gates the mutation; on success the in-memory list
   *  is appended to and the state file is rewritten atomically.
   *  On save failure, the in-memory push is rolled back (the new
   *  entry is popped) and the underlying error is re-thrown.
   *
   *  Idempotent: if `path` is already in the list, this is a
   *  no-op (no save, no error). The web's `work_dir_add` reply
   *  shape is `{ ok: true }` either way — see
   *  control.md §6.7 + task 04 "重复添加幂等 (no-op + ok:true)". */
  add(path: string): void {
    if (this.workDirs.includes(path)) {
      // Idempotent no-op — the path is already saved.
      return;
    }
    validateWorkDir(path);
    this.workDirs.push(path);
    try {
      saveStateFile(this.statePath, this.workDirs);
    } catch (err) {
      // Roll back the in-memory push so the next `list()` call
      // doesn't see an entry that's not on disk. Without the
      // rollback, a successful add followed by a failed save
      // would leave the bridge in an inconsistent state: the
      // in-memory list would claim the directory is saved, but
      // a restart would load the pre-add list from disk.
      this.workDirs.pop();
      throw err;
    }
  }

  /** Remove a work directory. The path is filtered out of the
   *  in-memory list and the state file is rewritten atomically.
   *  On save failure, the in-memory filter is rolled back (the
   *  removed entry is re-pushed at its original position) and
   *  the underlying error is re-thrown.
   *
   *  No-op when the path isn't in the list (no save, no error) —
   *  matches the `add` idempotency contract.
   *
   *  Per PRD §钉子 3: this method does NOT touch any active
   *  `PiProcessManager` rooted at the removed work directory.
   *  That's the BridgeSessionLayer's responsibility (task 06) —
   *  WorkDirStore is purely a persistence concern, not a session
   *  lifecycle concern. */
  remove(path: string): void {
    const index = this.workDirs.indexOf(path);
    if (index === -1) {
      // Idempotent no-op — the path isn't in the list to begin
      // with, so there's nothing to remove and nothing to write.
      return;
    }
    // Capture the original state for rollback before mutating, so
    // the splice is symmetric (re-insert at the same position, not
    // appended to the end). Position matters: the work_dirs list
    // has a stable order on disk.
    const removed = this.workDirs.splice(index, 1)[0]!;
    try {
      saveStateFile(this.statePath, this.workDirs);
    } catch (err) {
      // Re-insert at the original position. The captured
      // `removed` is a string (workDirs is `string[]`); re-insert
      // at the captured index so the order is preserved across a
      // rollback.
      this.workDirs.splice(index, 0, removed);
      throw err;
    }
  }
}
