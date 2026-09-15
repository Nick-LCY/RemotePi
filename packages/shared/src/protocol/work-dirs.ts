// RemotePi tunnel protocol v1 — work-directory + directory-browsing
// payload & result schemas (M4 unlock).
//
// Wire layout (see docs/architecture/protocol/control.md §6.5–§6.8):
//   { v: 1, kind: "control", type, id, payload }
//
// Four control-family request payload schemas and two result-shape schemas
// for the M4 unlock (ADR-0010):
//
//   - `ListDirectoriesPayloadSchema` — `list_directories` request payload
//     (`{ path?: string }`; path defaults to `$HOME` when absent — see
//     docs/architecture/protocol/control.md §6.5).
//   - `ListDirectoriesResultSchema`   — `result.data` revalidation shape
//     for `list_directories` reply (`{ entries: { name, path }[] }`).
//   - `WorkDirListPayloadSchema`      — `work_dir_list` request payload
//     (always the empty object — see docs/architecture/protocol/control.md §6.6).
//   - `WorkDirListResultSchema`       — `result.data` revalidation shape
//     for `work_dir_list` reply (`{ work_dirs: string[] }`).
//   - `WorkDirAddPayloadSchema`       — `work_dir_add` request payload
//     (`{ path: string }` — see docs/architecture/protocol/control.md §6.7).
//   - `WorkDirRemovePayloadSchema`    — `work_dir_remove` request payload
//     (`{ path: string }` — see docs/architecture/protocol/control.md §6.8).
//
// The corresponding envelope wrappers (`ListDirectoriesEnvelope` etc.) live
// in `control.ts` so the `ControlBranch` discriminated union stays in one
// file — this module owns payload + result shapes only.
//
// Each request shares the same minimal wire footprint as a typical
// control-family message (`{ path?: string }` or `{}`). Future M4+ work
// dir additions (e.g. a `work_dir_rename`) belong in this file too.
//
// Naming contract (M1): payload Zod schema uses the `Schema` suffix;
// payload derived type has no suffix. Result schemas follow the same
// convention so the result-data revalidation surface is uniformly named.
import { z } from 'zod';

// ---------------------------------------------------------------------------
// `list_directories` — request + result
// ---------------------------------------------------------------------------

/** `list_directories` request payload — optional `path` for the directory
 *  to enumerate. Absent `path` → bridge falls back to `$HOME` per
 *  control.md §6.5. */
export const ListDirectoriesPayloadSchema = z.object({
  path: z.string().optional(),
});
export type ListDirectoriesPayload = z.infer<typeof ListDirectoriesPayloadSchema>;

/** `list_directories` reply `result.data` revalidation shape — array of
 *  `{ name, path }` entries. The outer `result` envelope parses with
 *  `data: z.unknown()` (control.ts) so the consumer narrows on
 *  `reply_to` and revalidates `data` against this schema before reading
 *  any field. */
export const ListDirectoriesResultSchema = z.object({
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
    }),
  ),
});
export type ListDirectoriesResult = z.infer<typeof ListDirectoriesResultSchema>;

// ---------------------------------------------------------------------------
// `work_dir_list` — request + result
// ---------------------------------------------------------------------------

/** `work_dir_list` request payload — always the empty object. The web
 *  queries the bridge for the user's saved work directory list with no
 *  parameters; future filter fields would be added as optional under
 *  envelope evolution rule (a). */
export const WorkDirListPayloadSchema = z.object({});
export type WorkDirListPayload = z.infer<typeof WorkDirListPayloadSchema>;

/** `work_dir_list` reply `result.data` revalidation shape — the bridge's
 *  in-memory snapshot of the user's saved work directory list (also
 *  persisted to `state.json` on the bridge side). The web mirrors this
 *  in `WebState.workDirs`. */
export const WorkDirListResultSchema = z.object({
  work_dirs: z.array(z.string()),
});
export type WorkDirListResult = z.infer<typeof WorkDirListResultSchema>;

// ---------------------------------------------------------------------------
// `work_dir_add` / `work_dir_remove` — request payloads
// ---------------------------------------------------------------------------
//
// Both responses are `result.ok: true | false`; failure carries an
// `error.code` from the 6-value lock-versioned `ERROR_CODES` set (no new
// codes introduced by the M4 unlock — see ADR-0010 §决策.4). The success
// shape carries no `data` — the web re-fetches the canonical list via
// `work_dir_list` after the mutation, which keeps the cache invalidation
// logic simple and lets both add and remove share the same result
// envelope wrapper (`ResultEnvelope`).

/** `work_dir_add` request payload — absolute path to add to the user's
 *  saved work directory list. The bridge performs the canonical M3
 *  three-piece check (exists + is directory + readable) before persisting
 *  to `state.json` (control.md §6.7). */
export const WorkDirAddPayloadSchema = z.object({
  path: z.string(),
});
export type WorkDirAddPayload = z.infer<typeof WorkDirAddPayloadSchema>;

/** `work_dir_remove` request payload — absolute path to remove from the
 *  user's saved work directory list. The bridge does NOT kill any
 *  active `PiProcessManager` rooted in this work directory (PRD §钉子 3
 *  "work_dir_remove 与活会话自然回收"); removal simply makes the
 *  directory unreachable from `ChoicePage level=2`. */
export const WorkDirRemovePayloadSchema = z.object({
  path: z.string(),
});
export type WorkDirRemovePayload = z.infer<typeof WorkDirRemovePayloadSchema>;
