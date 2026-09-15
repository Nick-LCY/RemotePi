// RemotePi tunnel protocol v1 — `session_list` reply revalidation
// schemas (M4 extension).
//
// Wire layout (see docs/architecture/protocol/control.md §7):
//   { v: 1, kind: "control", type: "result", id, reply_to, payload }
//   payload.data = SessionListResult
//
// Two schemas that revalidate the `result.data` payload for a `session_list`
// reply:
//
//   - `SessionListEntrySchema` — per-session metadata shape. Extends the
//     M3 field set (`id` / `name` / `cwd` / `created` / `modified` /
//     `message_count` / `first_message` / `running`) with the M4
//     `status` field (5-enum + `unknown`).
//   - `SessionListResultSchema` — `result.data.sessions[]` array
//     revalidation shape.
//
// The `status` field is the M4 unlock's user-visible surface (ADR-0010):
// the bridge maps its `PiProcessManager.phase` to one of
// `exited` / `idle` / `running` / `spawning` for active managers, and
// emits `unknown` when no manager currently owns the session in the
// bridge map. `unknown` is the deliberate "we don't know" sentinel for
// sessions that exist on disk but the bridge has never spawned — clicking
// such a row in `ChoicePage` triggers a fresh spawn through the recovery
// ritual (see PRD §1.3).
//
// ## Why this lives in its own module
//
// The session-list surface is its own concern: it doesn't share schema
// with the other control result shapes (`get_state.data` uses
// `SessionStatePayloadSchema`, `list_directories.data` uses
// `ListDirectoriesResultSchema`, etc.). Mirroring the M3 split
// (`block-on.ts` for the `blocked_on[]` discriminated union + the
// `extension_ui_response` web wire shape) keeps each result-data
// revalidation surface in its own focused module so the `control.ts`
// envelope definitions stay compact and easy to scan.
//
// Naming contract (M1): payload / result Zod schemas use the `Schema`
// suffix; payload / result derived types have no suffix.
import { z } from 'zod';

// ---------------------------------------------------------------------------
// `session_list.result.data.sessions[]` — per-entry shape
// ---------------------------------------------------------------------------

/** `session_list` per-entry revalidation shape. The M3 fields are
 *  carried over verbatim from the lock-versioned `data.sessions[]`
 *  surface; the M4 unlock adds the `status` field (5-enum + `unknown`).
 *
 *  Per-field notes:
 *   - `name` / `first_message` are nullable — pi may not have assigned
 *     a session name or written a first message yet (M3 convention).
 *   - `running` (boolean) is preserved alongside `status` so existing
 *     M3 consumers continue to work — `running === true` is roughly
 *     equivalent to `status ∈ { 'idle', 'running', 'spawning', 'ready' }`
 *     but does NOT capture the phase detail that `status` carries
 *     (e.g. `running` cannot distinguish `spawning` from `running`).
 *     M3 + M4 consumers should prefer `status` for new code.
 *   - `status === 'unknown'` means "no `PiProcessManager` currently
 *     owns this session in the bridge map" — the row exists on disk
 *     but the bridge has not spawned it (yet) in this bridge process.
 *     Picking such a row triggers a fresh spawn via the recovery
 *     ritual. */
export const SessionListEntrySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  cwd: z.string(),
  created: z.string(), // ISO 8601; per-entry schema defers the `.datetime()` check to the bridge's serialiser
  modified: z.string(),
  message_count: z.number(),
  first_message: z.string().nullable(),
  running: z.boolean(),
  // M4 unlock — bridge-mapped phase summary (ADR-0010 §决策.3). `unknown`
  // is the "no manager in map" sentinel; see schema JSDoc above.
  status: z.enum(['exited', 'idle', 'running', 'spawning', 'unknown']),
});
export type SessionListEntry = z.infer<typeof SessionListEntrySchema>;

/** `session_list` reply `result.data` revalidation shape — array of
 *  `SessionListEntry`. The outer `result` envelope parses with
 *  `data: z.unknown()` (control.ts) so the consumer narrows on
 *  `reply_to` (against the originating `session_list` request `id`) and
 *  revalidates `data` against this schema before reading any field. */
export const SessionListResultSchema = z.object({
  sessions: z.array(SessionListEntrySchema),
});
export type SessionListResult = z.infer<typeof SessionListResultSchema>;
