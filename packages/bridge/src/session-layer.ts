// Bridge session layer — multi-session management for `pi` subprocesses.
//
// ## Overview (M4 task 06)
//
// `BridgeSessionLayer` is the bridge's per-session router and the
// owner of every control-command path that doesn't need a live pi
// subprocess. It holds a `Map<sessionKey, PiProcessManager>` keyed by
// either:
//
//   - the **real sessionKey stem** (`<timestamp>_<uuid>`, derived from
//     pi's on-disk jsonl filename), once the manager has spawned and
//     pi has produced its first post-spawn stdout frame; or
//   - a **pending key** of shape `'new:' + workDir` (钉子 2), used for
//     a manager spawned from a `session: 'new'` + `payload.work_dir`
//     envelope that hasn't yet had its stem derived.
//
// During the pending phase, the manager's outbound envelopes do NOT
// carry a `session` field (web is implicitly tracking the session as
// the literal string `'new'` it sent). On the first non-handshake
// stdout event (probe-validated: `agent_start` for pi 0.85.1, see
// `tests/integration/probes/sessionkey-probe.ts`), the layer scans
// the per-workDir session subdirectory, derives the stem, atomically
// migrates the map key, and broadcasts `session_state{session:
// <stem>, work_dir: <workDir>}` so web can repaint its hash.
//
// ## Routing rules (PRD §2.7)
//
// Inbound envelopes arrive via `handleEnvelope(env)`:
//
//   - `session: <stem>` (not `'new'`) + map hit → forward to that
//     manager.
//   - `session: <stem>` (not `'new'`) + map miss → look up the jsonl
//     path for that stem under the manager's agent-dir, spawn a
//     fresh `PiProcessManager` keyed under the stem (carrying
//     `--session <path>`), register it, forward.
//   - `session: 'new'` + `payload.work_dir` → pending key control
//     (钉子 2): hit on the pending key reuses the in-flight manager;
//     miss spawns a fresh one (no `--session`, pi will create a new
//     jsonl). The pending → stem migration follows as described above.
//   - `session: 'new'` + payload missing `work_dir` → reject with
//     `result{ok:false, error.code:'invalid_envelope'}`.
//   - no `session` field + exactly one manager in the map (M3 compat)
//     → forward to that manager.
//   - no `session` field + zero or >1 managers → reject with
//     `invalid_envelope` (no ambiguity in M4 multi-session mode).
//
// ## Control commands handled at the layer (not the manager)
//
// `list_directories`, `work_dir_list`, `work_dir_add`,
// `work_dir_remove`, `session_list`, `get_state` (per-session) all
// route here. Each is pure fs / in-memory state with no pi subprocess
// dependency. `get_state` per-session reads from the matching manager;
// `session_list` scans `<agentDir>/sessions/--<encoded-workDir>--/`
// and maps each `manager.phase` to one of the wire `status` literals
// (`'spawning' | 'ready' | 'running' | 'idle' | 'exited' | 'unknown'`).
//
// ## 钉子 4 — SPAWN_TIMEOUT_MS (inherited from PiProcessManager)
//
// The `spawnTimeoutMs` option is forwarded to every manager the layer
// constructs. If a manager's spawning phase exceeds the timeout (and
// the manager self-kills → broadcasts `session_state{phase:'exited'}`),
// the layer listens for the broadcast and removes the map key
// (including the pending `new:WORK_DIR` key). The bookkeeping is
// driven by the broadcast itself rather than a per-manager timer at
// the layer — single source of truth (the manager), no dual cleanup
// paths.
//
// ## 裁定 C — ready-phase idle timer (inherited from PiProcessManager)
//
// `idleTimeoutMs` is forwarded to every manager. The manager arms
// its own 5-min timer on `ready` (no write command queued) and on
// `running → idle` (`agent_settled`); both fire through the same
// `killIdleChild` path. The layer doesn't track the timer — same
// rationale as 钉子 4 (single source of truth in the manager).
//
// ## Cross-manager broadcast isolation
//
// Each manager's outbound sink is wrapped with a closure that
// captures the manager's current map key. The wrapper injects
// `session: <key>` on every `session_state` envelope so web can
// route the broadcast to the correct per-session bucket. Two
// managers A and B never see each other's envelopes — there is no
// shared `session_state` fan-out path inside the layer (each
// manager calls `this.onOutbound` with its own wrapped envelope),
// so cross-talk is impossible by construction.
//
// ## 测试 seams
//
// The constructor accepts an optional `makeManager` factory so
// unit tests can substitute a manager that doesn't spawn real `pi`
// processes (FakeChild pattern, see `__tests__/pi-process.test.ts`).
// Production wires `PiProcessManager` directly.

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  PROTOCOL_VERSION,
  type Envelope,
  type SessionPhase,
  type SessionStatePayload,
} from '@remotepi/shared';
import { listDirectories, mapListDirectoriesDomainCodeToWire } from './list-directories.js';
import { logger } from './logger.js';
import {
  PiProcessManager,
  type PiProcessOptions,
  type SessionStatePayload as ManagerSessionStatePayload,
} from './pi-process.js';
import {
  encodeCwdForPi,
  sessionSubdir,
} from './pi-cwd-encoder.js';
import {
  StateError,
  WorkDirStore,
  type WorkDirStore as WorkDirStoreType,
} from './state.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Sentinel map key for the M3-compat manager auto-spawned when a
 *  session-less command arrives and the map is empty (legacy M3
 *  token-only URL hash behaviour — `index.ts` wires
 *  `config.work_dir` into `defaultWorkDir` so the M3-era web URL
 *  `#<token>` keeps working without a work_dir / session field).
 *
 *  ## 过渡性设计 (M4 任务 06 review C2 文档化)
 *
 *  This constant is a **transitional** compatibility seam intended
 *  to be **evaluated for retirement** after M4 task 08 lands: once
 *  the web multi-session store ships and all web envelopes carry
 *  the `session` field (裁定 A: every M4 web envelope tags itself
 *  with the current session), there is no longer any inbound that
 *  could trigger the M3-compat auto-spawn path. The pre-M3 e2e
 *  suite is the only thing that still relies on session-less
 *  command arrival today; once task 08 wires its per-session
 *  routing, the e2e suite should be migrated to pass an explicit
 *  `session` field and this branch should be removed.
 *
 *  ## 已知限制 (M4 任务 06 review C2 文档化)
 *
 *  The M3-compat path has an **order-dependent** semantic: when a
 *  second session is created (user opens a new ChatView after the
 *  first), subsequent session-less commands will be routed to the
 *  first spawned manager because `getOrCreateManagerForSession`
 *  checks `this.managers.size === 1` and returns the only manager.
 *  If the auto-spawned M3-legacy manager is the only one in the
 *  map, that path is fine (one manager → one manager). The
 *  problem surfaces when an explicit session manager coexists with
 *  the M3-legacy one: a session-less command will pick whichever
 *  manager happens to be at `map.values().next().value` (insertion
 *  order). M4 doesn't fix this — the web multi-session store
 *  (task 08) makes this a non-issue by always tagging envelopes
 *  with the session field.
 *
 *  The exported constant is used in three places in this file:
 *    1. `getOrCreateManagerForSession` (Branch 5+6 zero-managers
 *       path)
 *    2. `resolveM3CompatManager` (the same auto-spawn path for
 *       control commands without a session field — currently only
 *       `get_state` uses it)
 *    3. The outbound wrapper's `holder.current` for the auto-spawned
 *       manager — so `session_state` envelopes it emits carry
 *       `session: 'm3-legacy'` (see the JSDoc on
 *       `makeOutboundWrapper` below).
 *
 *  Task 08 will be the evaluation point. Until then, the
 *  `M3_LEGACY_KEY` constant name makes the transition intent
 *  visible at every call site. */
export const M3_LEGACY_KEY = 'm3-legacy';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Wire-level `status` enum for `session_list` rows (PRD §1.3 +
 *  ADR-0010 §决策.2). Bridges `PiProcessManager.phase` to the
 *  5-enum + `unknown` surface; `unknown` means no live manager in
 *  the layer's map for that session id (the session exists on disk
 *  but the bridge has not spawned it in this bridge process). */
export type SessionListStatus =
  | 'exited'
  | 'idle'
  | 'running'
  | 'spawning'
  | 'unknown';

/** `session_list` per-row shape. Mirrors
 *  `SessionListEntrySchema` from `@remotepi/shared/protocol/session-list`,
 *  but the bridge builds the value locally (rather than parsing a
 *  shared envelope) so we use this local type. The shared schema is
 *  used downstream by web to revalidate the outbound payload — see
 *  `SessionListEntrySchema.safeParse` in `__tests__/session-layer.test.ts`. */
export interface SessionListEntry {
  /** session file stem (the `<timestamp>_<uuid>` portion of the
   *  filename). Identical to `sessionKey` in this layer. */
  id: string;
  /** Pi may not have assigned a session name; `null` is the M3
   *  convention. The bridge never reads pi's session metadata today
   *  (no `--metadata` access); the field is `null` always and may
   *  be populated in M+ when web needs a friendlier display name. */
  name: string | null;
  /** Work directory the session was created under. */
  cwd: string;
  /** ISO-8601 created timestamp from the file mtime (bridge fills
   *  in this from the on-disk jsonl stat — pi's wire surface doesn't
   *  carry it). */
  created: string;
  /** ISO-8601 modified timestamp (file mtime). */
  modified: string;
  /** Message count — bridge does not currently parse jsonl entries
   *  for this (would require reading the file); defaults to 0. The
   *  field is included in the wire shape for forward compatibility
   *  with a future M+ bridge that pre-counts entries. */
  message_count: number;
  /** First message text — same caveat as `message_count`, defaults
   *  to `null`. */
  first_message: string | null;
  /** M3 field — boolean for "the session's pi process is alive (any
   *  non-exited phase)". Preserved alongside `status` so M3 consumers
   *  keep working. */
  running: boolean;
  /** M4 field — bridge-mapped phase summary (see SessionListStatus). */
  status: SessionListStatus;
}

/** BridgeSessionLayer construction options. */
export interface BridgeSessionLayerOptions {
  /** Pi's agent directory (where sessions / auth.json live). The
   *  layer scans this directory's `sessions/` tree for the
   *  `session_list` work_dir lookup and the pending → stem migration
   *  file scan. */
  agentDir: string;
  /** Override idle timeout (default: 5 min). Forwarded to every
   *  manager the layer constructs (裁定 C: applies to ready phase
   *  too). */
  idleTimeoutMs?: number;
  /** Override SIGKILL grace delay (default: 1s). Forwarded to
   *  every manager. */
  sigkillDelayMs?: number;
  /** Override spawn watchdog (钉子 4; default: 60s). Forwarded to
   *  every manager. */
  spawnTimeoutMs?: number;

  /** Outbound envelope sink. The layer forwards every outbound
   *  envelope (manager-wrapped + control-reply) through this
   *  single callback. Production wires `client.sendEnvelope`. */
  onOutbound: (env: Envelope) => void;
  /** Optional stderr sink forwarded to every manager the layer
   *  constructs. Production: bridge logger. */
  onStderr?: (chunk: string) => void;

  /** Persistence seam for `work_dir_*` commands. The layer does not
   *  own the store — `index.ts` constructs it during startup and
   *  hands it in here. */
  workDirStore: WorkDirStoreType;

  /** Optional env override forwarded to every manager the layer
   *  constructs. Defaults to `process.env`. Tests inject a hermetic
   *  env (see `tests/integration/helpers/build-hermetic-env.ts`)
   *  so the spawned pi subprocess points at a fixture agent dir
   *  rather than the host's `~/.pi/agent`. */
  baseEnv?: NodeJS.ProcessEnv;

  /** Optional default work directory. When a session-less command
   *  arrives and the layer has zero managers, this workDir is used
   *  to spawn an implicit M3-compat manager (auto-spawn on first
   *  command, same as the M3 single-manager behaviour). When
   *  absent, session-less commands with zero managers are rejected
   *  as `invalid_envelope` (M4 multi-session strict mode).
   *  index.ts sets this to the legacy `config.work_dir` so the
   *  M3-era token-only URL hash keeps working.
   *
   *  ## 过渡性设计 (M4 任务 06 review C2 文档化)
   *
   *  This option is the **user-facing knob** for the same
   *  transitional behaviour that `M3_LEGACY_KEY` describes. The
   *  two together gate the M3-compat auto-spawn path; remove
   *  both (and the corresponding branches in
   *  `getOrCreateManagerForSession` + `resolveM3CompatManager`)
   *  once M4 task 08 wires explicit per-session routing and the
   *  e2e suite migrates to passing `session` fields. See
   *  `M3_LEGACY_KEY` JSDoc for the full transition plan and
   *  known limitations (order-dependent routing once a second
   *  session is created). */
  defaultWorkDir?: string;

  /** Optional manager factory for unit tests. Defaults to
   *  `PiProcessManager`. Tests inject a wrapper that swaps the
   *  `spawn` factory so the FakeChild pattern (see
   *  `__tests__/pi-process.test.ts`) can drive stdout without
   *  spawning real pi processes. */
  makeManager?: (opts: PiProcessOptions) => PiProcessManager;
}

// ---------------------------------------------------------------------------
// Internal: per-manager outbound wrapper
// ---------------------------------------------------------------------------

/** Mutable holder for the map key currently associated with a given
 *  manager. Starts at the manager's initial map key (real stem or
 *  pending `new:WORK_DIR`); flips to the real stem on pending
 *  migration. The outbound wrapper reads `current` on every frame
 *  so the session field is always the up-to-date map key. */
interface SessionKeyHolder {
  current: string;
}

/** Build the outbound wrapper for one manager. Reads the current map
 *  key from `holder` on every frame and injects `session: <key>` on
 *  outbound session_state envelopes. The injection covers session_state
 *  only — every other envelope type (event, command_result, snapshot)
 *  passes through unchanged (web dispatches by session field on
 *  session_state frames; per-message events get routed by `reply_to`
 *  correlation or by pi's own envelope session field if present).
 *
 *  Note: we deliberately inject on session_state only, not on every
 *  envelope. The M3 manager emitted session_state without a session
 *  field; web at that time had a single bucket. In M4 each manager
 *  has its own session, so every session_state carries the manager's
 *  key as `session`. Events/commands that pi emits are forwarded
 *  verbatim — pi 0.85.1 doesn't put a session field on them, so
 *  the session layer can't help here; web correlates via the
 *  session field on the manager's session_state broadcasts (the
 *  "first frame is the anchor" pattern).
 *
 *  ## M3_LEGACY_KEY 注 (M4 任务 06 review C2 文档化)
 *
 *  For the M3-compat auto-spawned manager (see `M3_LEGACY_KEY`
 *  JSDoc), `holder.current === M3_LEGACY_KEY` ('m3-legacy').
 *  Result: the auto-spawned manager's outbound session_state
 *  envelopes carry `session: 'm3-legacy'`. This is intentional —
 *  web stores this as a real bucket ID so subsequent commands can
 *  reference it via `session: 'm3-legacy'` for the lifetime of the
 *  bridge process. Task 08 (web multi-session store) will retire
 *  this behaviour entirely. */
function makeOutboundWrapper(
  holder: SessionKeyHolder,
  layer: BridgeSessionLayer,
): (env: Envelope) => void {
  return (env: Envelope): void => {
    if (env.kind === 'control' && env.type === 'session_state') {
      // Inject the current map key as the session field. We rebuild
      // the envelope so the structural type matches
      // SessionStateEnvelope; spreading preserves v/kind/type/id and
      // payload, adds `session` if not already present (it's the
      // manager's job to carry it from now on).
      const withSession: Envelope = {
        ...env,
        ...(env.session === undefined ? { session: holder.current } : {}),
      };
      layer.broadcast(withSession);
      return;
    }
    layer.broadcast(env);
  };
}

// ---------------------------------------------------------------------------
// BridgeSessionLayer
// ---------------------------------------------------------------------------

export class BridgeSessionLayer {
  // ---- configuration ----
  private readonly agentDir: string;
  private readonly idleTimeoutMs: number | undefined;
  private readonly sigkillDelayMs: number | undefined;
  private readonly spawnTimeoutMs: number | undefined;
  private readonly onOutbound: (env: Envelope) => void;
  private readonly onStderr: (chunk: string) => void;
  private readonly workDirStore: WorkDirStoreType;
  private readonly baseEnv: NodeJS.ProcessEnv | undefined;
  private readonly defaultWorkDir: string | undefined;
  private readonly makeManager: (opts: PiProcessOptions) => PiProcessManager;

  // ---- runtime state ----
  /** Per-session managers. Keys are either real sessionKey stems or
   *  pending `new:WORK_DIR` keys (钉子 2). Pending → stem migration
   *  is atomic (delete + set under the same JS tick) so a concurrent
   *  command arrival cannot observe a half-migrated state. */
  private readonly managers = new Map<string, PiProcessManager>();

  /** Per-manager sessionKey holders — lets the outbound wrapper
   *  inject the *current* key on every session_state, which matters
   *  for pending managers that have just migrated (the first
   *  post-migration broadcast carries the real stem, not the
   *  pending key). */
  private readonly managerKeys = new Map<PiProcessManager, SessionKeyHolder>();

  // ---- lifecycle ----
  private started = false;
  private stopped = false;

  constructor(options: BridgeSessionLayerOptions) {
    this.agentDir = options.agentDir;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.sigkillDelayMs = options.sigkillDelayMs;
    this.spawnTimeoutMs = options.spawnTimeoutMs;
    this.onOutbound = options.onOutbound;
    this.onStderr = options.onStderr ?? ((chunk) => logger.warn(`pi stderr: ${chunk.trimEnd()}`));
    this.workDirStore = options.workDirStore;
    this.baseEnv = options.baseEnv;
    this.defaultWorkDir = options.defaultWorkDir;
    this.makeManager = options.makeManager ?? ((opts) => new PiProcessManager(opts));
  }

  /** Layer-level startup. Idempotent. Currently a no-op (each manager
   *  manages its own state and spawns lazily on first spawn-trigger
   *  command); kept for symmetry with `stop()` and to give a
   *  future implementation a place to warm caches, etc. */
  start(): void {
    if (this.started) return;
    this.started = true;
    logger.info(`bridge session layer started (agentDir=${this.agentDir})`);
  }

  /** Layer-level shutdown. Stops every manager (each emits an
   *  `exited` broadcast on its own) and clears the maps. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const m of this.managers.values()) {
      m.stop();
    }
    this.managers.clear();
    this.managerKeys.clear();
  }

  // ----------------------------------------------------------------
  // Public: per-session hooks called by the manager (the manager
  // doesn't know about the layer; it calls these via the constructor
  // closures injected at spawn time).
  // ----------------------------------------------------------------

  /** Outbound sink target used by `makeOutboundWrapper`. We expose
   *  this as a public method rather than passing `this.onOutbound`
   *  directly so the wrapper closure has a stable reference even
   *  if `onOutbound` is later swapped (currently it isn't, but the
   *  layer API is conservative about that). */
  broadcast(env: Envelope): void {
    this.onOutbound(env);
  }

  /** Hook called from each manager's outbound wrapper when it sees
   *  a `session_state` envelope. The layer uses it to:
   *
   *  1. Migrate the map key from `new:WORK_DIR` → real stem on the
   *     first non-handshake stdout event (probe-validated: the
   *     `agent_start` event is the canonical "session initialized"
   *     signal for pi 0.85.1).
   *  2. Clean up the map key on `phase === 'exited'` broadcasts
   *     (钉子 4 spawn-timeout + 钉子 3 work_dir_remove natural
   *     recycling).
   *
   *  Returns `true` when the wrapper's subsequent passthrough
   *  should be SKIPPED — currently this only happens on the
   *  pending → stem migration (W3 review fix; before this, the
   *  layer broadcast a session_state AND the wrapper passed
   *  through the manager's session_state, producing two frames
   *  on the wire). All other branches return `false` (normal
   *  passthrough). */
  onManagerSessionState(
    manager: PiProcessManager,
    sessionState: SessionStatePayload,
  ): { migrated: boolean; broadcastedPhase: boolean } {
    // Locate the manager's current map key.
    const mapKey = this.findMapKeyForManager(manager);
    if (mapKey === null) return { migrated: false, broadcastedPhase: false };

    // 钉子 4 / 钉子 3 cleanup path — exited broadcast removes the
    // map key. This covers both the SPAWN_TIMEOUT_MS self-kill
    // (钉子 4) and the natural idle-recycle / work_dir_remove
    // recycling (钉子 3 + 裁定 C). After removal, future commands
    // addressed to the old key are rejected as `invalid_envelope`
    // (the manager isn't in the map), matching the "M4 multi
    // manager 后歧义" guard.
    if (sessionState.phase === 'exited') {
      // The manager already broadcast its own exited session_state;
      // we just clean the map key. The wrapper does NOT inject a
      // session field on this frame (the manager's broadcast
      // happens through the wrapper, which would normally inject;
      // for exited cleanup we let the wrapper's normal flow emit
      // the broadcast — but then we drop the map key so future
      // commands referencing this stem get rejected).
      this.managers.delete(mapKey);
      this.managerKeys.delete(manager);
      return { migrated: false, broadcastedPhase: false };
    }

    // Pending → stem migration. We trigger off any non-exited
    // phase (not just `ready`): in pi 0.85.1 the manager reaches
    // `running` quickly if a write command was queued during
    // spawning, but a no-write queue leaves it in `ready` and we
    // still need to migrate so web can stop tracking the pending
    // `'new'` hash placeholder. Migration on the FIRST non-exited
    // session_state broadcast is correct because the manager has
    // by definition produced a stdout frame (otherwise we wouldn't
    // be here).
    if (mapKey.startsWith('new:')) {
      // Returns `{migrated, broadcastedPhase}`; the wrapper uses
      // `broadcastedPhase` to short-circuit the duplicate
      // broadcast when the layer just broadcast a session_state
      // (W3 fix). On the non-session_state path the layer does
      // NOT broadcast a session_state — the manager's NEXT
      // session_state (e.g. on a phase transition) carries the
      // real stem via `holder.current`, so the wrapper must
      // forward the current event (e.g. agent_start /
      // agent_settled) for web's per-event routing.
      return this.attemptPendingMigration(manager, mapKey, sessionState.phase);
    }
    return { migrated: false, broadcastedPhase: false };
  }

  /** Attempt the pending → stem migration for a manager. Idempotent:
   *  once the map key has been swapped from `new:<work_dir>` to the
   *  real stem, subsequent calls become no-ops (the early-return
   *  on `!mapKey.startsWith('new:')` short-circuits). Called from
   *  the spawnManager outbound wrapper on EVERY outbound envelope
   *  (so even non-session_state frames like the first `agent_start`
   *  event trigger migration; the session_state call path is the
   *  primary one, the other is a defensive fallback for the rare
   *  case where pi writes the jsonl AFTER the first session_state).
   *
   *  Returns `{migrated, broadcastedPhase}`. The wrapper uses
   *  `broadcastedPhase === true` to short-circuit the
   *  duplicate broadcast on the session_state path (W3 review
   *  fix). On the non-session_state path (phase === null) the
   *  layer doesn't broadcast, so `broadcastedPhase` is `false`
   *  and the wrapper FORWARDS the original event — important
   *  because events like `agent_settled` carry no session field
   *  and web relies on them for lifecycle routing. */
  private tryPendingMigration(
    manager: PiProcessManager,
    mapKey: string,
  ): { migrated: boolean; broadcastedPhase: boolean } {
    if (!mapKey.startsWith('new:')) return { migrated: false, broadcastedPhase: false };
    return this.attemptPendingMigration(manager, mapKey, null);
  }

  private attemptPendingMigration(
    manager: PiProcessManager,
    mapKey: string,
    phase: SessionPhase | null,
  ): { migrated: boolean; broadcastedPhase: boolean } {
    if (!mapKey.startsWith('new:')) return { migrated: false, broadcastedPhase: false };
    const workDir = mapKey.slice('new:'.length);
    const stem = this.deriveStemForWorkDir(workDir);
    if (stem === null) {
      // File not present yet. The probe showed the jsonl appears
      // synchronously with the agent_start event (~50ms latency in
      // our watcher); if the file is still missing, the next
      // outbound frame will retry. Log warn so a long-running gap is
      // observable but doesn't spam the log.
      logger.warn(
        `pending manager: session file not found in ${this.agentDir}/sessions/--${encodeCwdForPi(workDir)}--/ yet; will retry on next frame`,
      );
      return { migrated: false, broadcastedPhase: false };
    }
    // Atomic migration (PRD §钉子 2: 三步原子 = 删旧键 + 设新键 + 广播，期间命令不误路由). JS single-threadedness makes
    // this naturally atomic — no command can be processed between
    // the delete and the set.
    this.managers.delete(mapKey);
    this.managers.set(stem, manager);
    const holder = this.managerKeys.get(manager);
    if (holder !== undefined) {
      holder.current = stem;
    }
    // Broadcast the session_state with the real session field when
    // invoked from a session_state envelope (so the inbound and
    // outbound session_states carry the same payload shape, just
    // with the real session key). When invoked from a non-state
    // outbound (e.g. the first agent_start event), the manager
    // will emit its own session_state on the next phase transition
    // carrying the holder.current (now the real stem) — so we
    // don't double-broadcast.
    //
    // W3 (M4 任务 06 review): the wrapper that called us also
    // broadcasts the original envelope via `wrapper(env)`. Before
    // this fix, the session_state emitted by the manager during
    // the migration tick reached web TWICE — once as the layer's
    // migration broadcast and once as the wrapper's normal
    // passthrough. We now return `{migrated:true, broadcastedPhase:true}`
    // on a session_state-path migration so the wrapper's outbound
    // step short-circuits (see the `onOutboundEnvelope` closure in
    // `spawnManager`). For the non-state path (e.g. agent_start),
    // we return `{migrated:true, broadcastedPhase:false}` so the
    // wrapper FORWARDS the event — events like `agent_settled`
    // carry no session field and web relies on them for the
    // lifecycle; dropping them would break the multi-event
    // fixture and the agent_settled wait pattern in
    // `tests/integration/05-multi-session.test.ts`.
    if (phase !== null) {
      this.onOutbound({
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'session_state',
        id: randomUUID(),
        session: stem,
        payload: {
          phase,
          work_dir: workDir,
        },
      });
      return { migrated: true, broadcastedPhase: true };
    }
    return { migrated: true, broadcastedPhase: false };
  }

  // ----------------------------------------------------------------
  // Inbound: handleEnvelope
  // ----------------------------------------------------------------

  /** Top-level dispatcher. Mirrors the M3 manager's
   *  `PiProcessManager.handleEnvelope` shape but routes by session
   *  and intercepts the control commands the layer owns. */
  handleEnvelope(env: Envelope): void {
    if (this.stopped) return;
    if (env.kind === 'control') {
      this.handleControl(env);
      return;
    }
    // env.kind === 'pi'
    this.handlePi(env);
  }

  private handleControl(env: Envelope): void {
    switch (env.type) {
      case 'get_state':
        // Per-session get_state: route to the matching manager.
        // If no session → reject invalid_envelope (M4 multi-session
        // — there's no default session anymore; web must always
        // pass the session it cares about).
        this.handleGetState(env.id, env.session);
        break;
      case 'session_list':
        this.handleSessionList(env.id, env.payload.work_dir, env.session);
        break;
      case 'list_directories':
        this.handleListDirectories(env.id, env.payload.path, env.session);
        break;
      case 'work_dir_list':
        this.handleWorkDirList(env.id, env.session);
        break;
      case 'work_dir_add':
        this.handleWorkDirAdd(env.id, env.payload.path, env.session);
        break;
      case 'work_dir_remove':
        this.handleWorkDirRemove(env.id, env.payload.path, env.session);
        break;
      // Other control types (`handshake`, `ping`, `pong`,
      // `bridge_status`, `session_state`, `result`, `error`) are
      // handled by BridgeClient — the layer does not act on them.
      default:
        break;
    }
  }

  private handlePi(env: Envelope): void {
    switch (env.type) {
      case 'prompt':
        this.routePiCommand(env, () => this.getOrCreateManagerForSession(env));
        break;
      case 'steer':
        this.routePiCommand(env, () => this.getOrCreateManagerForSession(env));
        break;
      case 'follow_up':
        this.routePiCommand(env, () => this.getOrCreateManagerForSession(env));
        break;
      case 'abort':
        this.routePiCommand(env, () => this.getOrCreateManagerForSession(env));
        break;
      case 'get_messages':
        this.routePiCommand(env, () => this.getOrCreateManagerForSession(env));
        break;
      case 'extension_ui_response':
        this.routePiCommand(env, () => this.getOrCreateManagerForSession(env));
        break;
      default:
        break;
    }
  }

  /** Common routing logic for pi commands. Validates session /
   *  payload invariants, resolves (or creates) the target manager,
   *  and forwards. Returns `true` on success; the return value is
   *  used internally for test assertions but not exposed. */
  private routePiCommand(
    env: Envelope,
    resolve: () => { ok: true; manager: PiProcessManager } | { ok: false; error: string },
  ): void {
    const result = resolve();
    if (!result.ok) {
      // Reply with invalid_envelope.
      this.replyInvalidEnvelope(env.id, env.session, result.error);
      return;
    }
    result.manager.handleEnvelope(env);
  }

  /** Resolve the manager for an inbound pi envelope. Implements the
   *  5-branch routing rules from PRD §2.7:
   *    1. `session: <stem>` + map hit → return manager.
   *    2. `session: <stem>` + map miss → spawn manager with
   *       `--session <jsonl path>`, register, return.
   *    3. `session: 'new'` + `payload.work_dir` → pending key
   *       (钉子 2): hit reuses, miss spawns without `--session`.
   *    4. `session: 'new'` + no `payload.work_dir` → reject
   *       `invalid_envelope` ("new 必带 work_dir" — M4 操作惯例).
   *    5. No `session` + 1 manager → M3 compat, forward.
   *    6. No `session` + >1 or 0 managers → reject (歧义).
   *
   *  Returns `{ ok: true, manager }` on success or
   *  `{ ok: false, error }` on rejection — the caller wraps the
   *  failure into a `result{ok:false, error.code:'invalid_envelope'}`
   *  envelope.
   *
   *  We use a discriminated union here (rather than throwing) so the
   *  dispatch path is a flat series of branches without try/catch
   *  nesting. */
  private getOrCreateManagerForSession(
    env: Envelope,
  ): { ok: true; manager: PiProcessManager } | { ok: false; error: string } {
    // env is narrowed to pi envelopes by the caller, but TS doesn't
    // know that — narrow on type defensively.
    const sessionField = (env as { session?: string }).session;
    const payloadWorkDir =
      'payload' in env && env.payload !== null && typeof env.payload === 'object'
        ? (env.payload as { work_dir?: unknown }).work_dir
        : undefined;
    const validWorkDir = typeof payloadWorkDir === 'string' ? payloadWorkDir : undefined;

    // Branch 1+2: session is a real stem (not 'new').
    if (typeof sessionField === 'string' && sessionField !== 'new') {
      const hit = this.managers.get(sessionField);
      if (hit !== undefined) {
        return { ok: true, manager: hit };
      }
      // Map miss: scan the agent dir tree for a jsonl with this
      // stem. The scan walks ALL work_dirs in `work_dir_store` and
      // looks for `<agentDir>/sessions/--<encodedWorkDir>--/<stem>.jsonl`.
      // The first match wins. (A truly unique stem could only live
      // in one place — pi's sessionKey encoding is per-workDir — so
      // we don't worry about collisions across work_dirs.)
      const workDir = this.findWorkDirForSessionStem(sessionField);
      if (workDir === null) {
        return {
          ok: false,
          error: `session stem not found in any work_dir's session directory: ${sessionField}`,
        };
      }
      const sessionJsonlPath = path.join(
        sessionSubdir(this.agentDir, workDir),
        `${sessionField}.jsonl`,
      );
      const m = this.spawnManager({
        mapKey: sessionField,
        workDir,
        sessionJsonlPath,
      });
      return { ok: true, manager: m };
    }

    // Branch 3+4: session is 'new' (or omitted, but with work_dir
    // — the web UI may omit `session: 'new'` and rely solely on
    // work_dir to indicate "new"; we accept both forms).
    const isNewIntent =
      sessionField === 'new' || (sessionField === undefined && validWorkDir !== undefined);
    if (isNewIntent) {
      if (validWorkDir === undefined) {
        // Branch 4: new 缺 work_dir → reject.
        return {
          ok: false,
          error: `session:'new' requires payload.work_dir (M4 操作惯例必带)`,
        };
      }
      // Branch 3: pending key control (钉子 2).
      const pendingKey = `new:${validWorkDir}`;
      const hit = this.managers.get(pendingKey);
      if (hit !== undefined) {
        return { ok: true, manager: hit };
      }
      // Miss → spawn fresh, no --session, cwd = workDir. Pi will
      // create the jsonl on first write; we derive the stem later
      // from the agent_dir scan (see onManagerSessionState).
      const m = this.spawnManager({
        mapKey: pendingKey,
        workDir: validWorkDir,
        sessionJsonlPath: null,
      });
      return { ok: true, manager: m };
    }

    // Branch 5+6: no session field, no new intent. M3 compat path:
    // forward to the only manager if there is exactly one. If zero
    // managers exist AND a defaultWorkDir was configured, spawn
    // an implicit M3-compat manager (token-only URL hash from M3
    // keeps working — the e2e suite relies on this behaviour).
    if (sessionField === undefined) {
      if (this.managers.size === 1) {
        const only = this.managers.values().next().value;
        if (only !== undefined) {
          return { ok: true, manager: only };
        }
      }
      if (this.managers.size === 0 && this.defaultWorkDir !== undefined) {
        // M3-compat auto-spawn: synthesise a manager under the
        // legacy `M3_LEGACY_KEY` sentinel key (same key index.ts uses
        // for the back-compat `piProcessManager` injection). The
        // manager handles all subsequent session-less commands.
        // See `M3_LEGACY_KEY` JSDoc for the transition plan and
        // known order-dependent routing limitation.
        const m = this.spawnManager({
          mapKey: M3_LEGACY_KEY,
          workDir: this.defaultWorkDir,
          sessionJsonlPath: null,
        });
        return { ok: true, manager: m };
      }
      return {
        ok: false,
        error: `no session field and ${this.managers.size} managers in map (M4 multi-session mode requires explicit session)`,
      };
    }
    return {
      ok: false,
      error: `unreachable routing branch: session=${String(sessionField)}`,
    };
  }

  // ----------------------------------------------------------------
  // Manager spawning
  // ----------------------------------------------------------------

  /** Construct a fresh `PiProcessManager`, wire its outbound sink
   *  to a session-aware wrapper, register it under `mapKey`, and
   *  call `.start()` (which prints the diagnostic banner; spawn is
   *  lazy on first spawn-trigger command per M3 §2.3). */
  private spawnManager(opts: {
    mapKey: string;
    workDir: string;
    sessionJsonlPath: string | null;
  }): PiProcessManager {
    const holder: SessionKeyHolder = { current: opts.mapKey };
    const wrapper = makeOutboundWrapper(holder, this);
    const baseEnv = this.baseEnv ?? process.env;
    // We can't capture `manager` inside the `onOutboundEnvelope`
    // closure (TDZ), so we declare the helper below and let the
    // closure call it. The helper closes over the manager by
    // reassigning once the manager is constructed.
    const piOpts: PiProcessOptions = {
      agentDir: this.agentDir,
      workDir: opts.workDir,
      baseEnv,
      onOutboundEnvelope: (env) => {
        // 钉子 2 + 钉子 4 + 裁定 C cleanup: react on EVERY outbound
        // envelope (not just session_state). Probe-validated trigger
        // (tests/integration/probes/sessionkey-probe.ts): in pi
        // 0.85.1 the jsonl file is created synchronously with the
        // agent_start event — the most reliable signal we can act on
        // without polling the filesystem. The agent_start frame is
        // an outbound `pi/event` envelope (the manager forwards it
        // verbatim per `handleStdoutFrame`); by attempting migration
        // on every outbound we catch agent_start as well as the
        // session_state broadcasts the manager emits on every phase
        // transition. The migration is idempotent: once migrated,
        // subsequent attempts find no pending key and become no-ops.
        //
        // W3 (M4 任务 06 review): when the manager emits a
        // session_state during the migration tick, the layer
        // itself broadcasts a session_state with the new stem
        // (see `attemptPendingMigration`) AND the wrapper would
        // also forward the original session_state — producing
        // two session_state frames on the wire for the same phase
        // tick. We now skip the wrapper's passthrough ONLY when
        // the layer just broadcast a session_state (the
        // `broadcastedPhase` flag). On the non-session_state path
        // (agent_start, agent_settled, message_update, etc.) the
        // wrapper MUST forward the event — web routes those by
        // their own fields and dropping agent_settled would break
        // the integration test wait predicate.
        let skipWrapperPassthrough = false;
        if (env.kind === 'control' && env.type === 'session_state') {
          skipWrapperPassthrough = onSessionState(env.payload).broadcastedPhase;
        } else {
          // Any non-session_state outbound (event / command_result /
          // snapshot / result from the manager) also triggers a
          // migration attempt. The pending-key check inside
          // `onManagerSessionState` short-circuits on subsequent
          // attempts once the map key has been swapped. The
          // wrapper forwards the event regardless of migration
          // outcome (broadcastedPhase is always false here).
          onAnyOutbound();
        }
        if (skipWrapperPassthrough) {
          // session_state was already broadcast by the layer;
          // don't double-broadcast.
          return;
        }
        wrapper(env);
      },
      onStderr: this.onStderr,
      ...(this.idleTimeoutMs !== undefined ? { idleTimeoutMs: this.idleTimeoutMs } : {}),
      ...(this.sigkillDelayMs !== undefined ? { sigkillDelayMs: this.sigkillDelayMs } : {}),
      ...(this.spawnTimeoutMs !== undefined ? { spawnTimeoutMs: this.spawnTimeoutMs } : {}),
    };
    const manager = this.makeManager(piOpts);
    // Define helpers after construction; they close over `manager`.
    const onSessionState = (
      payload: SessionStatePayload,
    ): { migrated: boolean; broadcastedPhase: boolean } => {
      return this.onManagerSessionState(manager, payload);
    };
    const onAnyOutbound = (): { migrated: boolean; broadcastedPhase: boolean } => {
      return this.tryPendingMigration(manager, opts.mapKey);
    };
    this.managers.set(opts.mapKey, manager);
    this.managerKeys.set(manager, holder);
    manager.start();
    return manager;
  }

  // ----------------------------------------------------------------
  // Internal: pending migration + stem derivation
  // ----------------------------------------------------------------

  /** Derive the sessionKey stem for a work_dir's session subdir.
   *  Scans `<agentDir>/sessions/--<encodeCwdForPi(workDir)>--/` and
   *  returns the latest `<timestamp>_<uuid>` filename WITHOUT the
   *  `.jsonl` suffix, or `null` if the dir doesn't exist or has no
   *  jsonl files yet.
   *
   *  We deliberately do NOT import `findLatestSession` here because
   *  that helper returns a full path (which is what `--session`
   *  wants); we want just the stem. The duplication is small and
   *  keeps this method self-contained (the layer is otherwise free
   *  of `pi-cwd-encoder` imports beyond `encodeCwdForPi` and
   *  `sessionSubdir`). */
  private deriveStemForWorkDir(workDir: string): string | null {
    const subdir = sessionSubdir(this.agentDir, workDir);
    let entries: string[];
    try {
      if (!existsSync(subdir)) return null;
      entries = readdirSync(subdir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return null;
    }
    if (entries.length === 0) return null;

    // Latest = highest ISO timestamp prefix, tiebreak mtime, tiebreak
    // uuid desc — matches `findLatestSession` semantics verbatim.
    const enriched = entries
      .map((name) => {
        const stem = name.slice(0, -'.jsonl'.length);
        const idx = stem.lastIndexOf('_');
        if (idx <= 0) return null;
        const timestamp = stem.slice(0, idx);
        if (!/^\d{4}-\d{2}-\d{2}/.test(timestamp)) return null;
        try {
          const stat = statSync(path.join(subdir, name));
          return { stem, timestamp, uuid: stem.slice(idx + 1), mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(
        (e): e is { stem: string; timestamp: string; uuid: string; mtime: number } => e !== null,
      );
    if (enriched.length === 0) return null;

    enriched.sort((a, b) => {
      if (a.timestamp < b.timestamp) return 1;
      if (a.timestamp > b.timestamp) return -1;
      if (a.mtime !== b.mtime) return b.mtime - a.mtime;
      if (a.uuid > b.uuid) return -1;
      if (a.uuid < b.uuid) return 1;
      return 0;
    });
    return enriched[0]?.stem ?? null;
  }

  /** Walk every work_dir in the store and find the one whose
   *  session subdir contains a jsonl file with `stem.jsonl`. Used
   *  for the "session stem hit but map miss" routing branch.
   *
   *  ## 已知限制 (M4 任务 06 review W5 JSDoc)
   *
   *  **`encodeCwdForPi` is a lossy mapping**: it replaces `/`, `\`,
   *  and `:` with `-` to derive the agent-dir session subdirectory
   *  name. Two distinct work_dirs whose encoded names collide
   *  (e.g. `/a/b-c` and `/a/b:c` both encode to `--a-b-c--`) will
   *  write into the SAME session subdirectory and produce jsonl
   *  files with overlapping stems. The current-state `cc00a3f`
   *  lesson (PRD §非目标 / [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]]
   *  §关键 wire 发现) establishes that we must accept pi's
   *  encoding as-is rather than try to outsmart it. M4 inherits
   *  this; user-supplied work_dirs that collide on encoding will
   *  silently share a session subdirectory. The WorkDirStore
   *  doesn't currently detect this collision.
   *
   *  ## 行为确定性 (M4 任务 06 review W5)
   *
   *  When the SAME `<stem>.jsonl` file appears under multiple
   *  work_dirs' session subdirs (the collision case above OR a
   *  user who manually copied a jsonl between work_dirs), this
   *  method returns **the first work_dir in `workDirStore.list()`
   *  insertion order** that has a match. The order is determined
   *  by `Map` insertion order via `workDirStore.list()` — for the
   *  fresh XDG state-file load this is the order the user added
   *  the work_dirs (web ChoicePage level=1 list order, which is
   *  also stable across bridge restarts because WorkDirStore
   *  persists the order in `state.json`). M4 accepts this
   *  first-match-wins semantics; the alternative (scanning every
   *  matching work_dir and picking by some heuristic) adds
   *  complexity without improving the realistic case (zero or
   *  one match). Tests assert this determinism by stubbing two
   *  work_dirs with the same stem file. */
  private findWorkDirForSessionStem(stem: string): string | null {
    for (const workDir of this.workDirStore.list()) {
      const subdir = sessionSubdir(this.agentDir, workDir);
      const candidate = path.join(subdir, `${stem}.jsonl`);
      try {
        if (existsSync(candidate)) return workDir;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** Look up the map key for a manager reference. O(n) scan (the
   *  map has at most a handful of entries in practice — one per
   *  active session). For unit-test friendliness we keep this as
   *  a method rather than a reverse map (avoids two-place bookkeeping
   *  for a never-large map). */
  private findMapKeyForManager(manager: PiProcessManager): string | null {
    for (const [key, m] of this.managers) {
      if (m === manager) return key;
    }
    return null;
  }

  // ----------------------------------------------------------------
  // Control handlers
  // ----------------------------------------------------------------

  /** `control/get_state` — per-session. Replies with the matching
   *  manager's phase + blocked_on (or invalid_envelope if no
   *  manager exists for the given session). The M3 manager had a
   *  get_state handler that emitted from memory; the M4 layer
   *  wraps it because each session is its own manager now.
   *
   *  M3-compat: when no session field is present, route to the
   *  M3-legacy manager (auto-spawn one if the map is empty and a
   *  defaultWorkDir is configured). This preserves the M3 token-
   *  only URL hash behaviour — the e2e suite relies on it. */
  private handleGetState(requestId: string, session: string | undefined): void {
    let m: PiProcessManager | undefined;
    let resolvedSession: string | undefined;
    if (session !== undefined && session !== '') {
      m = this.managers.get(session);
      resolvedSession = session;
      if (m === undefined) {
        this.replyInvalidEnvelope(requestId, session, `no manager for session: ${session}`);
        return;
      }
    } else {
      // M3-compat path: no session field.
      m = this.resolveM3CompatManager();
      resolvedSession = undefined;
      if (m === undefined) {
        this.replyInvalidEnvelope(requestId, undefined, 'get_state requires session field in M4 mode');
        return;
      }
    }
    const blockedOn = m.getBlockedOn();
    const data: ManagerSessionStatePayload = {
      phase: m.getPhase(),
      ...(blockedOn.length > 0 ? { blocked_on: blockedOn } : {}),
    };
    this.onOutbound({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: randomUUID(),
      reply_to: requestId,
      ...(resolvedSession !== undefined ? { session: resolvedSession } : {}),
      payload: { ok: true, data },
    });
  }

  /** Resolve an M3-compat manager for session-less control commands.
   *  Returns the only manager if the map has exactly one; auto-spawns
   *  an implicit manager under the configured `defaultWorkDir` if
   *  the map is empty and the option is set. Returns `undefined`
   *  when no manager can be resolved (caller emits invalid_envelope).
   *
   *  ## 过渡性设计 (M4 任务 06 review C2 文档化)
   *
   *  This is the M3-compat auto-spawn used by `handleGetState`
   *  (the only control command that currently accepts a
   *  session-less request — web's M3 handshake). Same transition
   *  plan and order-dependent routing caveat as `M3_LEGACY_KEY`:
   *  task 08 will retire this branch. See `M3_LEGACY_KEY` JSDoc. */
  private resolveM3CompatManager(): PiProcessManager | undefined {
    if (this.managers.size === 1) {
      return this.managers.values().next().value;
    }
    if (this.managers.size === 0 && this.defaultWorkDir !== undefined) {
      // See M3_LEGACY_KEY JSDoc — same transitional seam.
      return this.spawnManager({
        mapKey: M3_LEGACY_KEY,
        workDir: this.defaultWorkDir,
        sessionJsonlPath: null,
      });
    }
    return undefined;
  }

  /** `control/session_list` — M4 操作惯例必带 work_dir (schema is
   *  optional for M3 compat). Scans `<agentDir>/sessions/--<encoded>--/`
   *  and emits a row per jsonl with the simplified `status` mapped
   *  from `manager.phase` (or `'unknown'` if no manager currently
   *  owns the session).
   *
   *  M3-compat: session-less `session_list` scans the agent-dir
   *  tree (no work_dir filter) — preserves the M3 token-only URL
   *  behaviour. */
  private handleSessionList(
    requestId: string,
    workDir: string | undefined,
    session: string | undefined,
  ): void {
    if (workDir === undefined) {
      // Schema-optional M3 compat path: scan ALL work_dirs. We
      // deliberately don't reject this — M4 web UI never sends it,
      // but a future diagnostic tool might. Emit a unified list.
      const allEntries: SessionListEntry[] = [];
      for (const wd of this.workDirStore.list()) {
        allEntries.push(...this.scanSessionsForWorkDir(wd));
      }
      this.replySessionListResult(requestId, session, allEntries);
      return;
    }
    const entries = this.scanSessionsForWorkDir(workDir);
    this.replySessionListResult(requestId, session, entries);
  }

  private scanSessionsForWorkDir(workDir: string): SessionListEntry[] {
    const subdir = sessionSubdir(this.agentDir, workDir);
    let entries: string[];
    try {
      if (!existsSync(subdir)) return [];
      entries = readdirSync(subdir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return [];
    }
    return entries
      .map((name): SessionListEntry | null => {
        const stem = name.slice(0, -'.jsonl'.length);
        const idx = stem.lastIndexOf('_');
        if (idx <= 0) return null;
        const timestamp = stem.slice(0, idx);
        if (!/^\d{4}-\d{2}-\d{2}/.test(timestamp)) return null;
        let stat;
        try {
          stat = statSync(path.join(subdir, name));
        } catch {
          return null;
        }
        const m = this.managers.get(stem);
        const phase: SessionPhase | null = m !== undefined ? m.getPhase() : null;
        return {
          id: stem,
          name: null,
          cwd: workDir,
          created: new Date(stat.birthtimeMs).toISOString(),
          modified: new Date(stat.mtimeMs).toISOString(),
          message_count: 0,
          first_message: null,
          running: phase !== null && phase !== 'exited',
          status: this.mapPhaseToStatus(phase),
        };
      })
      .filter((e): e is SessionListEntry => e !== null)
      .sort((a, b) => (a.modified > b.modified ? -1 : a.modified < b.modified ? 1 : 0));
  }

  /** Map `manager.phase` (5 phases: spawning/ready/running/idle/exited)
   *  onto the wire-level `status` enum (5 phases + `unknown`) used
   *  by `session_list` rows.
   *
   *  ## ready → idle 收敛 (M4 任务 06 review S14 rationale)
   *
   *  `ready` is an **internal-only** lifecycle phase the bridge
   *  uses to mean "handshake complete, no write command queued"
   *  (M3 §2.3 + 裁定 C: ready is also the phase that arms the
   *  5-min idle timer). It never appears on the wire — pi doesn't
   *  have a `ready` phase in its session_manager surface. Web's
   *  `ChoicePage` level=2 list shows session rows with an `idle`
   *  badge for any session that is sitting "alive but not doing
   *  anything", and a user looking at a freshly created session
   *  (just past handshake) sees the same badge as a session that
   *  has gone through prompt → response → agent_settled. Under
   *  裁定 C, a freshly created session in `ready` phase is ALSO
   *  reaped after 5 min of no write commands, so collapsing
   *  `ready` → `idle` on the wire matches the user's mental model
   *  ("this session is alive but idle, will go away if I don't
   *  use it"). */
  private mapPhaseToStatus(phase: SessionPhase | null): SessionListStatus {
    if (phase === null) return 'unknown';
    if (phase === 'ready') return 'idle'; // see S14 rationale below
    return phase;
  }

  private replySessionListResult(
    requestId: string,
    session: string | undefined,
    entries: SessionListEntry[],
  ): void {
    this.onOutbound({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: randomUUID(),
      reply_to: requestId,
      ...(session !== undefined ? { session } : {}),
      payload: { ok: true, data: { sessions: entries } },
    });
  }

  /** `control/list_directories` — M4 task 05 移交。 Pure fs; no
   *  pi involvement, never spawns. Maps domain outcome to wire
   *  result via the same mapper the M3 dispatcher used. */
  private handleListDirectories(
    requestId: string,
    path: string | undefined,
    session: string | undefined,
  ): void {
    const outcome = listDirectories(path);
    const baseEnvelope = {
      v: PROTOCOL_VERSION,
      kind: 'control' as const,
      type: 'result' as const,
      id: randomUUID(),
      reply_to: requestId,
      ...(session !== undefined ? { session } : {}),
    };
    if (outcome.ok) {
      this.onOutbound({
        ...baseEnvelope,
        payload: { ok: true, data: outcome.data },
      });
      return;
    }
    const wireCode = mapListDirectoriesDomainCodeToWire(outcome.code);
    this.onOutbound({
      ...baseEnvelope,
      payload: {
        ok: false,
        error: { code: wireCode, message: outcome.message },
      },
    });
  }

  /** `control/work_dir_list` — return the current work_dirs list
   *  (in-memory snapshot from `WorkDirStore.list()`). No persistence
   *  operation here. */
  private handleWorkDirList(requestId: string, session: string | undefined): void {
    const workDirs = this.workDirStore.list();
    this.onOutbound({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: randomUUID(),
      reply_to: requestId,
      ...(session !== undefined ? { session } : {}),
      payload: { ok: true, data: { work_dirs: workDirs } },
    });
  }

  /** `control/work_dir_add` — three-piece check (via
   *  `WorkDirStore.add`) → persist → reply. The store handles
   *  StateError → rethrow; we catch here and map to wire `internal`
   *  (per task 04 S2 移交义务 + ADR-0010 §决策.4). */
  private handleWorkDirAdd(
    requestId: string,
    path: string,
    session: string | undefined,
  ): void {
    const baseEnvelope = {
      v: PROTOCOL_VERSION,
      kind: 'control' as const,
      type: 'result' as const,
      id: randomUUID(),
      reply_to: requestId,
      ...(session !== undefined ? { session } : {}),
    };
    try {
      this.workDirStore.add(path);
    } catch (err) {
      if (err instanceof StateError) {
        this.onOutbound({
          ...baseEnvelope,
          payload: {
            ok: false,
            error: { code: 'internal', message: err.message },
          },
        });
        return;
      }
      throw err;
    }
    this.onOutbound({ ...baseEnvelope, payload: { ok: true } });
  }

  /** `control/work_dir_remove` —钉子 3: do NOT kill any active
   *  manager rooted at this work_dir. The store handles persistence
   *  + rollback; we just call it and map errors. Natural recycling
   *  happens via the manager's own idle timer (裁定 C extends this
   *  to ready phase too) — once the manager exits, the layer
   *  removes its map key. */
  private handleWorkDirRemove(
    requestId: string,
    path: string,
    session: string | undefined,
  ): void {
    const baseEnvelope = {
      v: PROTOCOL_VERSION,
      kind: 'control' as const,
      type: 'result' as const,
      id: randomUUID(),
      reply_to: requestId,
      ...(session !== undefined ? { session } : {}),
    };
    try {
      this.workDirStore.remove(path);
    } catch (err) {
      if (err instanceof StateError) {
        this.onOutbound({
          ...baseEnvelope,
          payload: {
            ok: false,
            error: { code: 'internal', message: err.message },
          },
        });
        return;
      }
      throw err;
    }
    this.onOutbound({ ...baseEnvelope, payload: { ok: true } });
  }

  // ----------------------------------------------------------------
  // Reply helpers
  // ----------------------------------------------------------------

  /** Emit a `result{ok:false, error.code:'invalid_envelope'}` reply.
   *  Used by the routing layer for "no manager for session" /
   *  "session:'new' 缺 work_dir" / "歧义 multi-session" cases. */
  private replyInvalidEnvelope(
    requestId: string,
    session: string | undefined,
    message: string,
  ): void {
    this.onOutbound({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: randomUUID(),
      reply_to: requestId,
      ...(session !== undefined ? { session } : {}),
      payload: {
        ok: false,
        error: { code: 'invalid_envelope', message },
      },
    });
  }

  // ----------------------------------------------------------------
  // Test seams
  // ----------------------------------------------------------------

  /** Number of managers currently in the map (test seam). */
  getManagerCount(): number {
    return this.managers.size;
  }

  /** Look up a manager by its current map key (test seam). */
  getManagerForKey(mapKey: string): PiProcessManager | undefined {
    return this.managers.get(mapKey);
  }

  /** Build the pending-key string for a workDir (test seam).
   *  Mirrors the internal convention used by the routing layer. */
  static pendingKeyFor(workDir: string): string {
    return `new:${workDir}`;
  }

  /** Currently-known work_dirs (mirrors the store; test seam).
   *  Returns a fresh copy so callers can't mutate the store. */
  listWorkDirs(): string[] {
    return this.workDirStore.list();
  }

  /** Try to derive the sessionKey stem for a workDir's session
   *  subdirectory (test seam — exposes the internal scan without
   *  requiring a real spawned manager). */
  tryDeriveStem(workDir: string): string | null {
    return this.deriveStemForWorkDir(workDir);
  }
}

// ---------------------------------------------------------------------------
// Convenience exports
// ---------------------------------------------------------------------------

/** Re-export `WorkDirStore` so the consumer (`index.ts`) doesn't
 *  need to know about `./state.js` directly. */
export { WorkDirStore, StateError };

/** Re-export the `encodeCwdForPi` helper for the test suite's
 *  fixture setup. */
export { encodeCwdForPi };
