// Bridge pi subprocess lifecycle manager.
//
// Manages a single pi child process (`pi --mode rpc`) and broadcasts
// its lifecycle as `control/session_state` frames ([[prds/m3-single-session.md#§2-3|
// M3 PRD §2.3]] / [[architecture/decisions/0003-session-lifecycle-and-history-source.md|
// ADR-0003]]). The 5-phase state machine is the bridge's local source of
// truth; web clients only ever see the latest `session_state` broadcast.
//
// ## State machine (PRD §2.3)
//
//   exited  ──(spawn 触发集 prompt/steer/follow_up/get_messages)──► spawning
//   spawning ──(get_state 响应)──► ready
//   ready   ──(首个 prompt/steer/follow_up)──► running
//   running ──(agent_settled)──► idle ──(5min 超时,SIGTERM→1s→SIGKILL)──► exited
//   running ──(新 prompt/steer/follow_up)──► running（不迁移）
//   running ──(get_messages)──► running（不迁移；读操作不触发写广播）
//   spawning / running ──(exit≠0, 自主 kill 标记不在)──► exited → spawning（崩溃重启）
//   spawning / running ──(exit=0, 自主 kill 标记不在)──► exited（stdin EOF，不重启）
//   idle / exited ──(exit, 自主 kill 标记在)──► exited（不重启）
//
// Commands arriving during `spawning` are QUEUED — the bridge can't
// write them yet (handshake pending). When the handshake completes,
// queued commands are flushed in arrival order; the phase moves to
// `running` only when at least one flushed command is a write.
//
// ## Exit handling (PRD §2.6)
//
//   - 自主 kill 标记在 (idle kill)  → 清标记 → exited → 不重启
//   - 标记不在 + code !== 0         → exited → 立即 spawn
//   - 标记不在 + code === 0         → exited → 不重启（stdin EOF 等合法关闭）
//
// ## §2.7 exited semantics
//
//   - spawn 触发集 = prompt / steer / follow_up / get_messages；触发时如
//     当前 phase = exited, spawn 一个新进程（带 `--session` 若扫描到）
//   - control `get_state` 永远由内存作答（永不 spawn）
//   - abort 在 exited 时为 no-op（回 command_result{success: true}）
//
// ## Stdio buffering (roadmap §4.2 ⚠)
//
//   Node's built-in line-splitting interface MUST NOT be used for
//   stdout parsing — it splits on U+2028 / U+2029 (both legal JSON
//   characters), corrupting every JSON line that happens to embed
//   either. Instead we use `StringDecoder('utf8')` + `indexOf('\n')`
//   to assemble lines manually; multi-byte UTF-8 sequences that
//   straddle chunk boundaries are reassembled by the decoder.
//
// ## Spawn factory seam
//
//   `spawn` 参数接受 (cmd, args, opts) → PiChild, default 为
//   `node:child_process.spawn`. 测试通过注入 fake child factory 来
//   控制 stdout/stderr/exit, 不真 spawn 外部 pi 二进制。

import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  PROTOCOL_VERSION,
  SESSION_PHASES,
  type BlockedOnEntryPayload,
  type Envelope,
  type ExtensionUIResponsePayload,
  type SessionPhase,
} from '@remotepi/shared';
import {
  ExtensionUIRouter,
  type PiExtensionUIResponse,
  buildExtensionUIRequestEnvelope,
} from './extension-ui.js';
import { listDirectories, mapListDirectoriesDomainCodeToWire } from './list-directories.js';
import { logger } from './logger.js';
import {
  authJsonExists,
  sessionArgv,
  sessionSubdir,
} from './pi-cwd-encoder.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Idle-kill deadline — when `agent_settled` arrives, bridge arms a
 *  timer; if it fires without a new prompt, the child is killed via
 *  SIGTERM → 1s → SIGKILL (PRD §2.3 / 已敲定决策 4 / ADR-0003). */
export const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Grace period between SIGTERM and SIGKILL during the autonomous
 *  kill sequence (PRD §2.3 + roadmap §4.7). 1000ms matches the
 *  graceful shutdown timing pi's rpc-client.js uses. */
export const SIGKILL_DELAY_MS = 1000;

/** The set of web → bridge commands that require a live pi process
 *  and therefore trigger a spawn when received during the `exited`
 *  phase (PRD §2.7). All other commands (`abort`, `get_state`) are
 *  served from memory or are no-ops. */
export const SPAWN_TRIGGERS = ['prompt', 'steer', 'follow_up', 'get_messages'] as const;
export type SpawnTrigger = (typeof SPAWN_TRIGGERS)[number];

/** S5 review follow-up: write-side commands — these mutate the
 *  agent's running state, so they (a) cause the ready → running
 *  transition on first arrival, (b) reset the idle timer, and
 *  (c) trigger a `session_state` broadcast on arrival in any
 *  non-exited phase. Used by `handleSpawnTrigger` to branch on
 *  read vs write without scattering string-literal checks. */
export const WRITES = ['prompt', 'steer', 'follow_up'] as const;
export type WriteCommand = (typeof WRITES)[number];

/** S5 review follow-up: read-side commands — these query the agent
 *  without changing its state. They never cause a phase transition
 *  and never touch the idle timer. The single member today is
 *  `get_messages`; future reads (e.g. history cursors) join this
 *  set rather than growing the spawn-trigger list. */
export const READS = ['get_messages'] as const;
export type ReadCommand = (typeof READS)[number];

/** `true` when a command is a write (mutates running state) rather
 *  than a read (queries without mutation). Mirrors the
 *  PRD §2 "广播原则: get_messages 不触发 session_state 广播" carve
 *  out — only writes drive transitions and broadcasts. */
function isWriteCommand(type: string): type is WriteCommand {
  return (WRITES as readonly string[]).includes(type);
}

/** Shape of the `error` field that the shared `CommandResultPayloadSchema`
 *  accepts (`error: { code: string, message: string }.optional()`).
 *  Re-declared here so the manager doesn't import a private schema
 *  type from `@remotepi/shared`; the wire contract is captured by
 *  the zod schema but every code path that builds the payload uses
 *  this named local type. */
export interface NormalizedCommandError {
  code: string;
  message: string;
}

/** Canonical code we stamp on pi error payloads that arrive as a raw
 *  string (or any other non-`{code,message}` shape). Mirrors the
 *  convention used by the extension UI router for `request_expired`
 *  / `invalid_response` — a stable, machine-readable code lets the
 *  web layer branch on failure modes without sniffing free-form
 *  message text. */
export const PI_ERROR_CODE = 'pi_error';

/** Normalize the `error` field from a pi `response` frame into the
 *  `{ code, message }` shape the shared protocol requires.
 *
 *  Pi's RPC contract (verified against
 *  `@earendil-works/pi-coding-agent@0.85.1`'s `dist/modes/rpc/
 *  rpc-mode.js:38` — `error = (id, command, message: string)` →
 *  `{ success: false, error: message }`) emits `error` as a raw
 *  string (e.g. `"Model not found: openai/gpt-5"`,
 *  `"Failed to parse command: ..."`, `e.message` from a thrown
 *  promise). The shared `CommandResultPayloadSchema` requires the
 *  field to be `{ code: string, message: string }` when present;
 *  passing a string through verbatim caused `Envelope.safeParse`
 *  to fail with `payload.error expected object, received string`
 *  and worker refused every command_result the bridge forwarded.
 *
 *  Branching rules (deliberately lenient — pi's wire shape is open):
 *    - `undefined` / `null` → `undefined` (caller omits the field).
 *    - `string` → `{ code: PI_ERROR_CODE, message: <raw> }` (the
 *      dominant pi case: error.message / string literals).
 *    - object with string `code` + string `message` → pass through
 *      verbatim (defensive: future pi builds could converge on
 *      `{code, message}` without a bridge change).
 *    - object with non-string fields → fall back per-field: a
 *      non-string `code` becomes `PI_ERROR_CODE` (so we never
 *      stamp a number/null/undefined into the protocol's typed
 *      string slot); a non-string `message` becomes
 *      `JSON.stringify(...)` (rather than `String(...)`) to avoid
 *      `[object Object]` on plain objects and to keep arrays /
 *      nested values intact in the web UI.
 *    - everything else (number, boolean, array, etc.) → wrap as
 *      `{ code: PI_ERROR_CODE, message: JSON.stringify(raw) }`
 *      so nothing is lost in the conversion (web can still see
 *      the original shape in the message field). The `bigint` /
 *      `symbol` branches are purely defensive: pi's RPC payload
 *      reaches us via `JSON.parse` upstream, so those types are
 *      unreachable in practice — `JSON.stringify` on a symbol
 *      yields `undefined` which would then be stringified to
 *      `undefined`, but the branch is kept so the type narrowing
 *      is total for the `unknown` input.
 *
 *  Exported for unit-test direct coverage; production callers go
 *  through `handlePiResponse` which applies the result when
 *  constructing the `command_result` payload. */
export function normalizePiError(raw: unknown): NormalizedCommandError | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    return { code: PI_ERROR_CODE, message: raw };
  }
  if (Array.isArray(raw)) {
    // Arrays are typeof === 'object' in JS but not `{code, message}`
    // shaped — JSON-stringify so the original elements survive the
    // conversion. Web renders the message verbatim, so `[1,2,3]`
    // becomes `[1,2,3]` in the UI rather than an empty string.
    return { code: PI_ERROR_CODE, message: JSON.stringify(raw) };
  }
  if (typeof raw === 'object') {
    const obj = raw as { code?: unknown; message?: unknown };
    if (typeof obj.code === 'string' && typeof obj.message === 'string') {
      return { code: obj.code, message: obj.message };
    }
    // Defensive coercion for partial object shapes (pi could emit
    // a numeric code, null message, etc. — see upstream tolerance
    // for unknown JSON shapes). We use JSON.stringify for the
    // non-string message fallback rather than String() to avoid the
    // eslint `no-base-to-string` rule (String() on a plain object
    // would yield `[object Object]`, losing the original value).
    const coercedCode = typeof obj.code === 'string' ? obj.code : PI_ERROR_CODE;
    const coercedMessage =
      typeof obj.message === 'string'
        ? obj.message
        : obj.message === undefined || obj.message === null
          ? ''
          : JSON.stringify(obj.message);
    return { code: coercedCode, message: coercedMessage };
  }
  // Primitive non-string (number / boolean / bigint / symbol) →
  // JSON-stringify so the original value survives the conversion.
  return { code: PI_ERROR_CODE, message: JSON.stringify(raw) };
}

// ---------------------------------------------------------------------------
// Child abstraction — keeps tests off the real spawn
// ---------------------------------------------------------------------------

/** Subset of `node:child_process.ChildProcess` this manager actually
 *  touches. Production code casts the real ChildProcess to this type;
 *  tests construct a fake child that satisfies it (PassThrough streams
 *  + EventEmitter for 'exit'). Keeping the surface narrow makes the
 *  fake-child contract trivial to satisfy. */
export interface PiChild {
  pid: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

/** Spawn-factory shape. Production: `(cmd, args, opts) => real spawn(...)`;
 *  tests: `(cmd, args, opts) => new FakeChild()`. */
export type SpawnFn = (cmd: string, args: readonly string[], opts: PiSpawnOptions) => PiChild;

export interface PiSpawnOptions {
  env: Record<string, string | undefined>;
  stdio: ['pipe', 'pipe', 'pipe'];
  /** Working directory the spawned pi process inherits (PRD §2.5
   *  spawn cwd). Bridge passes `workDir` from the operator
   *  configuration so any CWD-relative file ops pi performs (cwd
   *  resolution, log paths, etc.) line up with what web expects.
   *  Without this, the child runs in the bridge's own CWD and
   *  diverges from the session directory computed by the bridge
   *  via `sessionSubdir(agentDir, workDir)`. */
  cwd: string;
}

// ---------------------------------------------------------------------------
// Manager options + outbound types
// ---------------------------------------------------------------------------

export interface SessionStatePayload {
  phase: SessionPhase;
  blocked_on?: BlockedOnEntryPayload[];
}

/** Commands that need to be deferred until the handshake completes.
 *  We only queue spawn triggers + abort; get_state goes to memory
 *  without writing, and extension_ui_response is task-05 territory.
 *
 *  ## Web-wire vs pi-wire shape (translation layer)
 *
 *  `DeferredCommand` mirrors the **web wire** (what the web client
 *  sent), NOT pi's native stdin frame. The fields below carry
 *  `content: string` for prompt / steer / follow_up because that's
 *  what the shared `PromptPayloadSchema` / `SteerPayloadSchema` /
 *  `FollowUpPayloadSchema` declare. When the bridge actually writes
 *  to pi stdin (via `writeCommand` → `translateToPiWire`), the
 *  payload field gets renamed `content` → `message` because pi's
 *  RPC contract uses `message` (verified against pi
 *  `dist/modes/rpc/rpc-types.d.ts`, `RpcCommand`'s `prompt` /
 *  `steer` / `follow_up` variants — all three require
 *  `message: string`). Writing `content` instead caused pi to read
 *  `command.message` as `undefined` and crash with `TypeError:
 *  Cannot read properties of undefined (reading 'startsWith')` on
 *  the first content-bearing command.
 *
 *  Same caveat applies to `get_messages.since`: the field is
 *  retained here as a web-wire passthrough (forward-compat for M+
 *  incremental recovery per PRD §非目标), but `translateToPiWire`
 *  drops it — pi's `get_messages` does NOT accept `since` (that's
 *  pi's `get_entries` command); passing an unknown field is harmless
 *  but bloats the wire, so we strip it at the bridge boundary.
 *
 *  The translation step is centralized in `translateToPiWire` so
 *  the wire-shape difference is reviewable in one place and
 *  directly unit-testable without spinning up a manager.
 */
type DeferredCommand =
  | { type: 'prompt'; id: string; content: string }
  | { type: 'steer'; id: string; content: string }
  | { type: 'follow_up'; id: string; content: string }
  | { type: 'get_messages'; id: string; since?: string }
  | { type: 'abort'; id: string };

/** Pi's native stdin command frame for the 7 commands bridge writes.
 *  Verified against `@earendil-works/pi-coding-agent@0.85.1`
 *  `dist/modes/rpc/rpc-types.d.ts` — see `RpcCommand` and
 *  `RpcExtensionUIResponse` discriminated unions. The `prompt` /
 *  `steer` / `follow_up` variants require `message: string` (NOT
 *  `content`); `abort` / `get_state` / `get_messages` carry just
 *  the optional `id` for reply correlation.
 *
 *  Exported so unit tests can assert on the exact wire shape
 *  without constructing a full manager; production code receives
 *  a concrete `PiStdinCommand` value from `translateToPiWire` (the
 *  `extension_ui_response` variants live in `extension-ui.ts` and
 *  already match this contract by construction). */
export type PiStdinCommand =
  | { type: 'prompt'; id: string; message: string }
  | { type: 'steer'; id: string; message: string }
  | { type: 'follow_up'; id: string; message: string }
  | { type: 'abort'; id: string }
  | { type: 'get_state'; id: string }
  | { type: 'get_messages'; id: string };

/** Translate a bridge-internal `DeferredCommand` (web wire shape)
 *  into pi's native stdin frame (RPC contract shape). The function
 *  is the single source of truth for bridge → pi wire translation
 *  on the spawn-trigger path; if a future pi release adds or
 *  renames fields, this is the one place to update.
 *
 *  Translation rules (each rule is a verified mismatch between the
 *  shared web wire and pi's RPC contract — see `DeferredCommand`
 *  JSDoc for the matching rationale):
 *
 *  - `prompt` / `steer` / `follow_up`:
 *      bridge `{content}` → pi `{message}`. Without this rename
 *      pi reads `command.message` as `undefined` and crashes with
 *      `TypeError: Cannot read properties of undefined (reading
 *      'startsWith')` on the first content-bearing command
 *      (regression observed in M3 task 06 dev; root-caused against
 *      `rpc-types.d.ts` `RpcCommand` prompt / steer / follow_up
 *      variants).
 *
 *  - `abort`:
 *      identity translation (no fields to rename); the bridge's
 *      internal shape already matches pi's contract.
 *
 *  - `get_messages`:
 *      bridge carries an optional `since` cursor (M3 doesn't use
 *      it — PRD §非目标 defers to M+ — but the passthrough was
 *      retained for forward compat); pi's `get_messages` does NOT
 *      accept `since` (that's `get_entries`'s field), so we drop
 *      it. The cursor survives in the `DeferredCommand` queue so
 *      a future M+ build that switches to `get_entries` won't
 *      need to re-touch the queue type.
 *
 *  - `get_state`:
 *      only constructed by the bridge handshake writer; included
 *      in the `PiStdinCommand` union for completeness but not
 *      reachable through `DeferredCommand` (which holds web-
 *      originated commands only).
 *
 *  Exported for direct unit-test coverage. Production code path:
 *  `writeCommand` → `translateToPiWire` → JSON.stringify → stdin.
 *  `extension-ui.ts` writes its own three-state shape directly
 *  (no translation needed — see `PiExtensionUIResponse` JSDoc). */
export function translateToPiWire(cmd: DeferredCommand): PiStdinCommand {
  switch (cmd.type) {
    case 'prompt':
      return { type: 'prompt', id: cmd.id, message: cmd.content };
    case 'steer':
      return { type: 'steer', id: cmd.id, message: cmd.content };
    case 'follow_up':
      return { type: 'follow_up', id: cmd.id, message: cmd.content };
    case 'abort':
      return { type: 'abort', id: cmd.id };
    case 'get_messages':
      // Drop `since`: pi's `get_messages` doesn't accept it (that's
      // `get_entries`); unknown fields are harmless but the bridge
      // shouldn't forward them.
      return { type: 'get_messages', id: cmd.id };
  }
}

export interface PiProcessOptions {
  /** Pi's agent directory (where sessions / auth.json live). The
   *  bridge does NOT inject `PI_CODING_AGENT_DIR` into spawn env —
   *  pi sees the operator's own environment through
   *  `{...process.env}` passthrough, so the same path is used
   *  whether the operator set the var explicitly or pi falls back
   *  to its `~/.pi/agent` default. The bridge also scans this
   *  directory for the latest session to feed `--session <path>` on
   *  restart, so its location must match what pi itself uses (see
   *  `resolvePiAgentDir` in `pi-cwd-encoder.ts` for the exact
   *  resolution semantics). */
  agentDir: string;
  /** Working directory for the session (passed as cwd to spawn). */
  workDir: string;

  /** Override the spawn factory (test seam). Defaults to `node:child_process.spawn`. */
  spawn?: SpawnFn;
  /** Override timer functions (test seam — vitest fake timers). */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  /** Override idle timeout (test seam — keep prod value realistic). */
  idleTimeoutMs?: number;
  /** Override SIGKILL grace delay (test seam). */
  sigkillDelayMs?: number;
  /** Override the env override passed to spawn (test seam — defaults to process.env).
   *  Test seam: override baseEnv to seal against host env state (see test 10.3a).
   *  When asserting "spawn env does NOT carry X", pass a baseEnv built from
   *  `process.env` minus that key (e.g. `const { X: _, ...rest } = process.env`)
   *  so the test is hermetic regardless of the operator's shell. */
  baseEnv?: NodeJS.ProcessEnv;

  /** Outbound envelope sink. The manager constructs ready-to-send
   *  envelopes (matching the shared wire schema); the caller is
   *  responsible for sending them via the WSS client. Test spies
   *  capture the envelopes for assertion. */
  onOutboundEnvelope?: (env: Envelope) => void;

  /** Optional stderr sink (logs by default; tests inject spies). */
  onStderr?: (chunk: string) => void;
}

// ---------------------------------------------------------------------------
// PiProcessManager
// ---------------------------------------------------------------------------

/** Internal frame kinds we recognise on stdout. These are pi's native
 *  JSONL shapes — see [[architecture/protocol/pi.md]] for the full
 *  surface. We only narrow on the fields we actually act on.
 *
 *  **pi 0.85.1 wire shape** (verified against
 *  `@earendil-works/pi-coding-agent@0.85.1`'s
 *  `dist/modes/rpc/rpc-mode.js`, see comment on `handleStdoutFrame`):
 *  - commands are `{type:"<command>", id?, ...payload}` on stdin;
 *  - **responses** are `{type:"response", command, success, id?, data?, error?}`
 *    on stdout (only the `response` discriminator wraps a payload +
 *    correlation id in a sub-shape);
 *  - **events** stream as their raw session-emitter objects —
 *    e.g. `{type:"agent_settled"}`, `{type:"message_update", ...}`,
 *    `{type:"message_end", message:{...}}`, `{type:"extension_ui_request", id, method, ...}`.
 *    There is NO `{type:"event", event:"...", data:...}` envelope
 *    wrapping — that shape was incorrectly assumed by the earlier
 *    bridge code and silently dropped every event pi sent, leaving
 *    `agent_settled` (idle timer trigger) and `extension_ui_request`
 *    (popup router) dead. See `handleStdoutFrame` for the fix.
 *
 *  W3 review follow-up: `response.id` is the id of the command the
 *  bridge sent to pi — pi echoes it back so the bridge can correlate
 *  the reply with the originating web envelope. We mark it optional
 *  so a pi build that omits it (or a stale reply from a crashed
 *  previous child) still parses; the lookup in `handlePiResponse`
 *  falls back to a fresh UUID when the id isn't in our outstanding
 *  table. */
type StdoutFrame =
  | {
      type: 'response';
      command: string;
      success: boolean;
      id?: string;
      data?: unknown;
      error?: unknown;
    }
  // All pi event types — raw session-emitter objects. The discriminator
  // IS the event name; there is no `event` sub-field. We accept any
  // string type so future pi releases that add new event names are
  // forwarded verbatim (envelope evolution rule (c)).
  | { type: string; [k: string]: unknown };

export class PiProcessManager {
  // ---- configuration (immutable after construction) ----
  private readonly agentDir: string;
  private readonly workDir: string;
  private readonly authJsonPath: string;
  private readonly spawnFn: SpawnFn;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly idleTimeoutMs: number;
  private readonly sigkillDelayMs: number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly onOutbound: (env: Envelope) => void;
  private readonly onStderr: (chunk: string) => void;

  // ---- runtime state ----
  /** Current lifecycle phase. Defaults to `exited` (no child has been
   *  spawned yet). The bridge never auto-spawns — pi is started lazily
   *  on the first spawn-trigger command (ADR-0003 + PRD §2.3). */
  private phase: SessionPhase = 'exited';
  /** Live pi child, or null when no process is running. */
  private child: PiChild | null = null;
  /** Partial UTF-8 carry-over between stdout chunks. Reset on every
   *  full line; retained only across chunk boundaries (UTF-8 multi-byte
   *  sequences that straddle a chunk). See `feedStdout` below. */
  private stdoutDecoder = new StringDecoder('utf8');
  /** In-progress line being assembled from `indexOf('\n')` chunks. */
  private stdoutBuffer = '';
  /** Stderr decoder mirrors stdout (we don't parse stderr content —
   *  it goes straight to the operator log — but UTF-8 must still be
   *  reassembled across chunk boundaries). */
  private stderrDecoder = new StringDecoder('utf8');
  private stderrBuffer = '';

  /** `true` if the bridge intentionally killed the child (idle timer
   *  SIGTERM path). Read by the 'exit' handler to decide between the
   *  "no restart" path and the crash-restart path. MUST be set BEFORE
   *  `child.kill(...)` is called — see the rationale comment on the
   *  `killIdleChild` method. */
  private selfKillFlag = false;
  /** Handle for the SIGTERM → SIGKILL grace timer; null when no kill
   *  is in progress. Cleared once the child actually exits. */
  private sigkillTimer: ReturnType<typeof setTimeout> | null = null;

  /** Handle for the idle timeout started when `agent_settled` arrives.
   *  Cleared whenever a new command is sent (we transition back to
   *  running) or the child exits. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Commands received during `spawning` — held until the handshake
   *  completes. Drained in arrival order on `ready` transition. */
  private deferredCommands: DeferredCommand[] = [];

  /** W3 review follow-up: outstanding-commands table that maps the
   *  id we sent to pi → the web envelope id (or a `bridgeInitiated`
   *  flag for handshake `get_state`).
   *
   *  pi's RPC protocol echoes the command `id` on every response,
   *  which is what lets web correlate `command_result.reply_to`
   *  with the original prompt/steer/follow_up/abort/get_messages
   *  envelope (envelope.md 锁版: `reply_to` 是回执配对键;
   *  task 07 恢复仪式需要 `snapshot{reply_to: <get_messages 的 id>}`).
   *  Since the bridge passes the web envelope id straight through
   *  to pi as the command id (`handlePrompt`/`handleSteer`/...
   *  construct `cmd.id = env.id`), the pi-side key equals the
   *  web-side key — we only need to flag which entries were
   *  bridge-initiated (no corresponding web envelope, so a
   *  matching pi response is consumed by the bridge itself rather
   *  than forwarded). Entries are inserted on command accept and
   *  removed on matching response, child exit, or `stop()`. */
  private outstandingCommands: Map<
    string,
    { webEnvelopeId: string; command: string; bridgeInitiated: boolean }
  > = new Map();

  /** Pending extension UI requests live on the `ExtensionUIRouter`
   *  (task 05 split). The router owns the Map, the timeout handles,
   *  and the wire translation; the manager queries
   *  `extensionUIRouter.getBlockedOn()` whenever it needs to
   *  build a `session_state` payload. The router is constructed
   *  in `buildExtensionUIRouter()` (lazy because it closes over
   *  the manager instance via callbacks). */
  private extensionUIRouter!: ExtensionUIRouter;

  /** Monotonic counter of spawn attempts (the first spawn counts as
   *  1; subsequent crash-restarts increment). Tests use this to
   *  verify §2.7 spawn-trigger semantics ("spawn 计数 +1"). */
  private spawnCount = 0;

  /** Whether `start()` has been called. Guards against double-start
   *  (mirrors BridgeClient's idempotent start()). */
  private started = false;
  /** Whether `stop()` has been called. Once set, the manager stops
   *  scheduling new work and tears down the child (used by index.ts
   *  during uncaughtException cleanup — the bridge doesn't currently
   *  call this but the seam is there for completeness). */
  private stopped = false;

  constructor(options: PiProcessOptions) {
    this.agentDir = options.agentDir;
    this.workDir = options.workDir;
    // auth.json lives directly under the agent dir. Derived here so
    // the caller only has to know the one `agentDir` knob; the
    // bridge does not own a separate config file (per decision
    // 2026-09-05: bridge no longer maintains an isolated pi profile).
    this.authJsonPath = path.join(this.agentDir, 'auth.json');
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.sigkillDelayMs = options.sigkillDelayMs ?? SIGKILL_DELAY_MS;
    this.baseEnv = options.baseEnv ?? process.env;
    this.onOutbound = options.onOutboundEnvelope ?? (() => undefined);
    this.onStderr = options.onStderr ?? ((chunk) => logger.warn(`pi stderr: ${chunk.trimEnd()}`));
    this.extensionUIRouter = this.buildExtensionUIRouter(options);
  }

  /** Construct the extension UI router, wiring it to the manager's
   *  callbacks. The router owns the `pending` Map, the timeout
   *  handles, the wire translation, and the multi-web first-answer-
   *  wins semantics; the manager owns the phase state machine, the
   *  outbound sink, and the stdin writer. The split keeps the router
   *  testable in isolation (no manager instance needed) and the
   *  manager testable without instantiating a router.
   *
   *  We initialise the router AFTER the field assignments because the
   *  closures reference `this.broadcastSessionState` (private) and
   *  `this.writeToPiCommand` etc. — those methods don't read `this`
   *  until invocation time, so constructor ordering is safe. */
  private buildExtensionUIRouter(options: PiProcessOptions): ExtensionUIRouter {
    return new ExtensionUIRouter({
      broadcastSessionState: () => this.broadcastSessionState(),
      emitEventEnvelope: (eventName, data) => {
        if (eventName === 'extension_ui_request') {
          this.onOutbound(buildExtensionUIRequestEnvelope(data as BlockedOnEntryPayload));
        } else {
          this.onOutbound({
            v: PROTOCOL_VERSION,
            kind: 'pi',
            type: 'event',
            id: randomUUID(),
            payload: { event: eventName, data: data ?? null },
          });
        }
      },
      emitCommandResult: (replyTo, success, error) => {
        const payload: {
          command: 'extension_ui_response';
          success: boolean;
          error?: { code: string; message: string };
        } = {
          command: 'extension_ui_response',
          success,
          ...(error !== undefined ? { error } : {}),
        };
        this.onOutbound({
          v: PROTOCOL_VERSION,
          kind: 'pi',
          type: 'command_result',
          id: randomUUID(),
          reply_to: replyTo,
          payload,
        });
      },
      writeToPi: (cmd) => this.writeExtensionUIResponseToPi(cmd),
      forceExited: (reason) => this.forceExitedForExtensionUIFailure(reason),
      setTimeout: options.setTimeout,
      clearTimeout: options.clearTimeout,
    });
  }

  /** Write the translated `extension_ui_response` to pi stdin.
   *  Returns `false` when the child is dead (no live process) so
   *  the router can route through `forceExited`. We use the same
   *  try/catch-then-false pattern as `writeCommand` but expose the
   *  boolean to the router so it can trigger the force-exited
   *  broadcast explicitly (otherwise the entry would already be
   *  cleared from pending and the manager would only learn about
   *  the failure via a delayed exit event). */
  private writeExtensionUIResponseToPi(cmd: PiExtensionUIResponse): boolean {
    const child = this.child;
    if (child === null) {
      logger.warn(`dropping ${cmd.type} — no live child`);
      return false;
    }
    try {
      child.stdin.write(JSON.stringify(cmd) + '\n');
      return true;
    } catch (err) {
      logger.warn(`stdin write failed for ${cmd.type}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Force phase = 'exited' on stdin write failure from the
   *  extension UI path. The router invokes this when
   *  `writeToPi` returns false; we log + transitionTo so the
   *  phase state machine records the new phase and broadcasts
   *  `session_state{phase:'exited'}`. The router's own
   *  broadcastSessionState callback then fires the second
   *  broadcast (post-cleared blocked_on); both broadcasts are
   *  idempotent from web's perspective (the second one carries
   *  the cleared blocked_on, the first one carries it too since
   *  the router cleared it before calling forceExited). */
  private forceExitedForExtensionUIFailure(reason: string): void {
    logger.error(`forcing exited due to extension UI stdin failure: ${reason}`);
    this.transitionTo('exited');
  }

  // ----------------------------------------------------------------
  // Lifecycle — start, stop, spawn, internal exit handling
  // ----------------------------------------------------------------

  /** Idempotent. Logs the resolved agent directory + a non-blocking
   *  hint if auth.json is missing (per PRD §2.3 the bridge does NOT
   *  auto-login). Doesn't spawn pi; pi is spawned lazily on the first
   *  spawn-trigger command (ADR-0003 + PRD §2.3: "延迟到首任务触发,
   *  不预热"). */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!authJsonExists(this.authJsonPath)) {
      // W4 review follow-up: route the auth.json hint to stderr
      // directly via `console.error`. We deliberately do NOT use
      // `logger.warn` here — that path goes through the shared
      // logger which is also used for `client.ts` reconnect
      // warnings; switching its sink to stderr would silently flip
      // every other warn in the daemon. The auth.json nudge is
      // a one-shot operator hint at startup, so a direct console
      // call with a [bridge] prefix keeps the format consistent
      // with everything else the bridge prints while restricting
      // the stream change to this single site.
      //
      // Decision 2026-09-05: bridge no longer maintains an isolated
      // pi profile — sessions + auth are shared with the host's
      // ~/.pi/agent. The hint therefore points at the host's
      // pi TUI (`pi` in any terminal) rather than asking the
      // operator to run a one-off `PI_CODING_AGENT_DIR=...` pi
      // instance. If the operator has a custom PI_CODING_AGENT_DIR
      // set in their env, `resolvePiAgentDir` will reflect that
      // here too — the print line is diagnostic, not prescriptive.
      //
      // W3 review follow-up: surface the env-var fallback so operators
      // who deliberately prefer NOT to persist an auth.json (e.g.
      // CI runners, ephemeral containers, air-gapped setups that
      // inject secrets via env) still have a working escape hatch.
      // pi's credential priority is auth.json > provider *_API_KEY
      // env > --api-key; setting e.g. `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
      // (whatever the provider calls it) in the bridge's process
      // environment is sufficient for pi to skip the auth.json check.
      // The provider name varies, so the hint names the convention
      // rather than enumerating keys.
      console.error(
        `[bridge] auth.json not found at ${this.authJsonPath}. Authenticate via the pi TUI (run \`pi\` and type /login) so it writes ${this.authJsonPath}, or set the provider's *_API_KEY env var (pi auth priority: auth.json > env > --api-key).`,
      );
    }
    // Diagnostic banner so operators can confirm the bridge and pi
    // agree on the same agent directory. The line is grep-able + the
    // value comes from `resolvePiAgentDir()` (env first, default
    // ~/.pi/agent) so a mismatch with what the operator expects
    // (e.g. PI_CODING_AGENT_DIR set to a different path) shows up
    // immediately on startup instead of as a confusing
    // session-not-found error on first prompt.
    logger.info(`pi agent dir: ${this.agentDir}`);
    logger.info(`work_dir=${this.workDir}`);
    // Phase starts at `exited`; no spawn yet. The first
    // spawn-trigger command will call spawnNow().
  }

  /** Stop the manager: clear all timers, kill the child, mark
   *  stopped so no further spawns occur. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearIdleTimer();
    this.clearSigkillTimer();
    // W3: clear outstanding commands. Without this, late responses
    // from the dying child (e.g. one that flushes a queued reply
    // right before SIGTERM delivery) could still match a stale
    // entry and emit an envelope after `stop()` has been signalled.
    // Combined with `handleExit`'s own clear, this guarantees no
    // outbound frame is produced after `stop()` returns.
    this.outstandingCommands.clear();
    // Task 05: drop any pending extension UI requests + their
    // timeout mirrors. clearAll() emits a final broadcast so web
    // sees `blocked_on: []` (or absent) before the bridge shuts
    // down — otherwise a stopping bridge could leave stale dialogs
    // pinned in the UI for the duration of the WSS close handshake.
    this.extensionUIRouter.clearAll();
    const child = this.child;
    if (child !== null) {
      // Bridge-initiated stop is a self-kill (we want no restart
      // regardless of exit code). The flag trips the "marked, no
      // restart" path in handleExit.
      this.selfKillFlag = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead
      }
    }
  }

  /** The bridge-internal spawn. Called from two places:
   *   1. §2.7 spawn triggers (handlePrompt / handleSteer /
   *      handleFollowUp / handleGetMessages) when `phase === 'exited'`.
   *   2. Exit-handler crash-restart path when `!selfKillFlag && code !== 0`.
   *
   *  Increments `spawnCount` on every call so tests can verify
   *  §2.7 semantics ("spawn 计数 +1" per triggered spawn).
   *
   *  Env: we pass `{...this.baseEnv}` verbatim — NO
   *  `PI_CODING_AGENT_DIR` injection. Per decision 2026-09-05
   *  the bridge no longer maintains an isolated pi profile; pi
   *  sees the operator's own environment through passthrough, so
   *  the agent dir the bridge scans (via `resolvePiAgentDir`)
   *  and the agent dir pi itself uses are guaranteed to agree
   *  (both consult the same `process.env.PI_CODING_AGENT_DIR`
   *  with the same priority). An operator who wants a non-default
   *  location sets the env var in the bridge's own process env —
   *  no bridge-side configuration knob required. */
  private spawnNow(): void {
    if (this.stopped) return;
    this.spawnCount++;
    const subdir = sessionSubdir(this.agentDir, this.workDir);
    const sessionFlags = sessionArgv(subdir); // ['--session', path] or []
    const args = ['--mode', 'rpc', ...sessionFlags];
    const env: Record<string, string | undefined> = { ...this.baseEnv };
    logger.info(
      `spawning pi (count=${this.spawnCount}): pi ${args.join(' ')} (cwd=${this.workDir})`,
    );
    const child = this.spawnFn('pi', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.workDir,
    });
    this.child = child;
    // Reset stream state — a new child has fresh stdin/stdout, even
    // if we're recovering from a crash (carrying stale partial lines
    // across processes would corrupt the JSONL stream).
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stdoutBuffer = '';
    this.stderrDecoder = new StringDecoder('utf8');
    this.stderrBuffer = '';
    this.attachChild(child);
    this.transitionTo('spawning');
    // Spawn-write handshake (PRD §2.3 step 2). pi is silent until we
    // ask — the bridge must kick off the get_state exchange
    // synchronously after spawn, otherwise both sides wait forever
    // (探针实证: pi stdout 8s 0 字节, bridge 等响应死锁). We write
    // IMMEDIATELY after spawn (do NOT wait for any first stdout
    // output — pi 静默场景下会重新死锁; OS pipe buffer absorbs the
    // handful of bytes we write before pi's reader is ready).
    this.writeHandshakeGetState();
  }

  /** Wire the 'exit' + 'error' + stream listeners onto a fresh child. */
  private attachChild(child: PiChild): void {
    child.on('exit', (code, signal) => this.handleExit(code, signal));
    // 'error' fires when the spawn itself fails (ENOENT / permission
    // denied / etc.) or when the IPC pipe breaks post-spawn. Without
    // a handler, Node surfaces this as an uncaught exception and the
    // bridge dies. We translate it to an explicit exited transition
    // + warn so the operator sees a useful log line and web sees a
    // session_state{phase:'exited'} instead of a phantom zombie.
    //
    // W-1 review follow-up: the 'error' closure captures `child`
    // so the handler can identify whether the error came from the
    // CURRENT child or a stale one. Without this identity check, a
    // late 'error' event from child A arriving AFTER
    // handleExit(code≠0) + spawnNow has replaced `this.child` with
    // child B would tear down B via forceExitedAfterSpawnFailure
    // (the reverse-order race: exit first, then late error). The
    // `child === this.child` guard in `handleChildError` short-
    // circuits that path. The simpler `this.child === null` guard
    // alone is insufficient because by the time the late error
    // arrives, this.child has been replaced with B (not null).
    child.on('error', (err) => this.handleChildError(err, child));
    child.stdout.on('data', (chunk: Buffer | string) => this.feedStdout(chunk));
    child.stderr.on('data', (chunk: Buffer | string) => this.feedStderr(chunk));
  }

  /** Write the bridge-initiated `get_state` handshake to pi's stdin.
   *  Called synchronously after `attachChild + transitionTo('spawning')`
   *  in `spawnNow`. Generates a fresh UUID, JSONL-encodes the frame,
   *  writes it, and registers a `bridgeInitiated: true` entry in the
   *  outstanding-commands table so the matching response drives
   *  `completeHandshake` (which consumes the entry without forwarding).
   *
   *  Failure handling: `stdin.write` may throw synchronously when the
   *  pipe is already broken (EPIPE on a child that died before the
   *  write landed — common with ENOENT / spawn failures). In that
   *  case we route through `forceExitedAfterSpawnFailure`, which
   *  mirrors `extension-ui`'s `forceExited` callback (log + transition
   *  to `exited`). ENOENT in particular is a persistent problem with
   *  no built-in backoff, so we do NOT auto-restart — the next
   *  §2.7 spawn-trigger command (or operator restart) is the right
   *  recovery path.
   *
   *  Note: this method runs synchronously inside `spawnNow`, BEFORE
   *  the OS / Node event loop has had a chance to deliver an `error`
   *  event. So if `child` was passed to `attachChild`, the `error`
   *  handler isn't going to fire and clobber `this.child` underneath
   *  us mid-write. We still defensively bail if `this.child === null`
   *  (shouldn't happen in production, but covers any future
   *  refactor that makes spawnNow async). */
  private writeHandshakeGetState(): void {
    const child = this.child;
    if (child === null) return;
    const id = randomUUID();
    const line = JSON.stringify({ type: 'get_state', id }) + '\n';
    try {
      child.stdin.write(line);
    } catch (err) {
      logger.error(
        `handshake get_state stdin write failed: ${(err as Error).message}`,
      );
      this.forceExitedAfterSpawnFailure('handshake stdin write failed');
      return;
    }
    // Register the entry AFTER the write succeeds — if the write
    // throws we leave the table alone (clearAll inside
    // forceExitedAfterSpawnFailure handles any leftover bookkeeping).
    this.outstandingCommands.set(id, {
      webEnvelopeId: id,
      command: 'get_state',
      bridgeInitiated: true,
    });
    logger.info(`handshake get_state written (id=${id})`);
  }

  /** Translate a child 'error' event (spawn failure / broken pipe /
   *  EPIPE) into an explicit exited transition. Without this handler
   *  Node would emit `uncaughtException` and the bridge process
   *  would exit. We surface the error to the operator log, drop the
   *  outstanding / deferred state, and broadcast `session_state{
   *  phase: 'exited'}` so web sees the bridge is offline.
   *
   *  Idempotency (W-1 review follow-up): two cases must short-circuit
   *  without disturbing state:
   *    1. After `handleExit` clears `this.child`, subsequent `error`
   *       events from the SAME dying child see `this.child === null`
   *       and return. (Original guard.)
   *    2. After `handleExit(code≠0)` triggered a crash-restart and
   *       `spawnNow` replaced `this.child` with the new child B, a
   *       late `error` event from the OLD child A must NOT tear down
   *       B. The identity check `sourceChild !== this.child` catches
   *       this reverse-order race; without it, the late error would
   *       route through `forceExitedAfterSpawnFailure` and kill B
   *       even though B is alive and well. The simpler phase check
   *       (`this.phase === 'exited'`) cannot catch this scenario
   *       because after crash-restart the phase is `'spawning'`. */
  private handleChildError(err: Error, sourceChild?: PiChild): void {
    // W-1: stale error from a previous child (e.g., late 'error'
    // from child A after exit+crash-restart spawned child B).
    if (sourceChild !== undefined && sourceChild !== this.child) {
      return;
    }
    if (this.child === null) return;
    logger.error(`pi child error: ${err.message}`);
    this.forceExitedAfterSpawnFailure(`child error: ${err.message}`);
  }

  /** Force `exited` for spawn-failure paths (ENOENT, EPIPE during
   *  handshake, child 'error' events). Distinct from `handleExit`:
   *    - Always takes the "no restart" path (ENOENT is persistent;
   *      auto-restart without backoff would loop forever).
   *    - Drops the deferred queue with a warn (S6 alignment: web
   *      will retry on the next §2.7 spawn trigger, but operators
   *      need a sentinel to correlate "I sent X, then nothing").
   *    - Runs the same bookkeeping as the exit path (clear
   *      outstanding + router + sigkill timer) so a subsequent
   *      `exit` event sees `this.child === null` and short-circuits
   *      via the idempotency guard in `handleChildError`.
   *
   *  The `transitionTo('exited')` call emits a `session_state`
   *  broadcast; the preceding `extensionUIRouter.clearAll()` emits
   *  a second one (idempotent — both carry `blocked_on: []` /
   *  omitted when nothing was pending). This mirrors the dual-
   *  broadcast pattern in `handleExit`. */
  private forceExitedAfterSpawnFailure(reason: string): void {
    if (this.child === null && this.phase === 'exited') {
      // handleExit already ran and transitioned to exited; nothing
      // left to do (the error / write-fail landed AFTER exit).
      return;
    }
    logger.error(`forcing exited due to spawn failure: ${reason}`);
    const droppedDeferred = this.deferredCommands.length;
    this.deferredCommands = [];
    this.flushStdout();
    this.flushStderr();
    this.child = null;
    this.clearSigkillTimer();
    this.outstandingCommands.clear();
    this.extensionUIRouter.clearAll();
    if (droppedDeferred > 0) {
      logger.warn(
        `queued commands dropped due to spawn failure, web should retry (${droppedDeferred} command(s))`,
      );
    }
    this.transitionTo('exited');
  }

  /** Push a chunk of stdout bytes through the UTF-8 decoder + newline
   *  splitter. Each complete JSONL line is dispatched to
   *  `handleStdoutFrame`. Partial lines accumulate in
   *  `stdoutBuffer` and the trailing partial UTF-8 in `stdoutDecoder`. */
  private feedStdout(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.stdoutDecoder.write(chunk);
    let buf = this.stdoutBuffer + text;
    let nlIdx = buf.indexOf('\n');
    while (nlIdx !== -1) {
      const line = buf.slice(0, nlIdx);
      this.handleStdoutFrame(line);
      buf = buf.slice(nlIdx + 1);
      nlIdx = buf.indexOf('\n');
    }
    this.stdoutBuffer = buf;
  }

  /** End-of-stream flush. Drains the decoder to convert any trailing
   *  partial UTF-8 sequence to U+FFFD, then flushes any line content
   *  left in the buffer (treated as a complete frame — pi always
   *  closes with a newline, but a truncated stream is still logged). */
  private flushStdout(): void {
    const tail = this.stdoutDecoder.end();
    const remaining = this.stdoutBuffer + tail;
    this.stdoutBuffer = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    if (remaining.length > 0) {
      this.handleStdoutFrame(remaining);
    }
  }

  /** Stderr mirror — we don't parse stderr, just log. Same UTF-8
   *  carry-over treatment as stdout so multi-byte sequences don't
   *  split mid-character in the log. */
  private feedStderr(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.stderrDecoder.write(chunk);
    let buf = this.stderrBuffer + text;
    let nlIdx = buf.indexOf('\n');
    while (nlIdx !== -1) {
      const line = buf.slice(0, nlIdx);
      this.onStderr(line);
      buf = buf.slice(nlIdx + 1);
      nlIdx = buf.indexOf('\n');
    }
    this.stderrBuffer = buf;
  }

  private flushStderr(): void {
    const tail = this.stderrDecoder.end();
    const remaining = this.stderrBuffer + tail;
    this.stderrBuffer = '';
    this.stderrDecoder = new StringDecoder('utf8');
    if (remaining.length > 0) {
      this.onStderr(remaining);
    }
  }

  /** Parse one JSONL line from pi stdout and dispatch. We accept the
   *  frame shapes pi 0.85.1 actually emits in `--mode rpc`:
   *
   *  **Verified wire shape** (see `dist/modes/rpc/rpc-mode.js:27-29`
   *  in `@earendil-works/pi-coding-agent@0.85.1`):
   *    - `{type:"response", command, success, id?, data?, error?}` —
   *      reply to a command we sent. The `get_state` reply drives the
   *      ready transition (handshake completion); `get_messages`
   *      becomes a `snapshot` envelope; every other reply becomes a
   *      `command_result` envelope (forwarded to web).
   *    - **Events** stream as raw session-emitter objects whose
   *      `type` IS the event name — e.g.
   *      `{type:"agent_settled"}`,
   *      `{type:"message_update", usage, assistantMessageEvent}`,
   *      `{type:"message_end", message:{...}}`,
   *      `{type:"extension_ui_request", id, method, ...}`,
   *      `{type:"queue_update", steering, followUp}`, etc.
   *      There is NO `{type:"event", event:"...", data:...}`
   *      wrapping. The earlier code dropped everything that didn't
   *      carry `type === 'response'` or `type === 'event'` (wrapped),
   *      which meant `agent_settled` never armed the idle timer and
   *      `extension_ui_request` never reached the popup router.
   *
   *  Two events get internal handling; every other pi event is
   *  forwarded verbatim as a `pi/event` envelope so the web layer
   *  (which dispatches by `payload.event` name) can route
   *  `message_update` streaming, `message_end` convergence,
   *  `queue_update`, `extension_ui_request` info-only updates, etc.
   *  Forwarding ALL events (rather than only a curated list) is
   *  intentional: pi keeps adding event types across releases and
   *  the web layer's open-ended `payload.event` is the single
   *  extension point (envelope evolution rule (c)). */
  private handleStdoutFrame(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      logger.warn(`dropping non-JSON pi stdout line: ${line.slice(0, 200)}`);
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const t = (parsed as { type?: unknown }).type;
    if (typeof t !== 'string') return; // unknown shape — drop silently

    if (t === 'response') {
      this.handlePiResponse(parsed as Extract<StdoutFrame, { type: 'response' }>);
      return;
    }

    // Build the `data` payload = the entire event minus its `type`
    // discriminator. Web layer's `extractTextDelta` / `extractMessage*`
    // helpers in WsClient hunt the open data shape for fields like
    // `text_delta`, `delta`, `message`, `messageId`, etc., so we keep
    // the full payload intact.
    const data: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    delete data.type;

    // Internal handling: `agent_settled` arms the idle timer (the
    // one signal that means "this turn is done, no more work queued";
    // `agent_end` fires on auto-retry too — see ADR-0003 §3). The
    // gate lives in `startIdleTimer` (only `running → idle` is
    // in-spec; ready/spawning/idle/exited are logged + ignored).
    if (t === 'agent_settled') {
      this.startIdleTimer();
      // Forward verbatim as a `pi/event` envelope so the web layer
      // can render the "agent 已就绪（5 分钟后自动休眠）" hint per
      // PRD §4.3 (InputBar subscribes via `client.on('event', …)`
      // and matches on `payload.event === 'agent_settled'`). The
      // forward is unconditional — out-of-spec arrivals (e.g.
      // duplicate settle while `idle`) reach web regardless; the
      // hint UI's own `phase !== 'idle'` guard in ChatView.tsx
      // prevents re-showing once phase has moved on, so a stale
      // duplicate is harmless. The wire shape matches the general
      // event forwarder below (`type` stripped into `payload.data`,
      // `agent_settled` carries no payload → `data: {}`).
      this.onOutbound({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'event',
        id: randomUUID(),
        payload: { event: t, data },
      });
      return;
    }

    // Internal handling: `extension_ui_request` goes through the
    // ExtensionUIRouter (4-class blocking or 5-class fire-and-forget,
    // per PRD §2.4). The router's `handleEventFromPi` keeps its old
    // `{event, data}` shape — we just pass the raw event (minus
    // `type`) as `data` so `data.method` / `data.id` line up with
    // pi's native shape.
    if (t === 'extension_ui_request') {
      this.extensionUIRouter.handleEventFromPi({
        event: 'extension_ui_request',
        data,
      });
      return;
    }

    // Every other event — `message_start`, `message_update`,
    // `message_end`, `agent_start`, `agent_end`, `turn_start`,
    // `turn_end`, `queue_update`, etc. — forwards verbatim as a
    // `pi/event` envelope. The web layer dispatches by
    // `payload.event` name (WsClient.handlePiEvent).
    this.onOutbound({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'event',
      id: randomUUID(),
      payload: { event: t, data },
    });
  }

  /** `response` frame from pi. The handshake reply (command ===
   *  `get_state` + success) drives the spawning → ready transition
   *  AND flushes any deferred commands; `get_messages` replies are
   *  wrapped in a `snapshot` envelope (PRD §1.5); every other reply
   *  is forwarded to the caller as a `command_result` envelope.
   *
   *  W2 review follow-up: the snapshot envelope uses
   *  `{ command 不存在, payload: { messages } }` per
   *  `SnapshotEnvelope` in `protocol/pi.ts`. The `messages` array
   *  is whatever pi sent in `frame.data.messages` (pi's native
   *  `get_messages` returns the array directly; we don't reshape).
   *
   *  W3 review follow-up: the reply's `reply_to` field comes from
   *  the outstanding-commands table keyed by pi's echoed `id`. When
   *  the id matches a bridge-initiated entry (handshake get_state)
   *  we consume the response locally; when it matches a web-initiated
   *  entry we forward with `reply_to = webEnvelopeId`; when it
   *  doesn't match (stale reply, or pi omitted the id) we fall back
   *  to a fresh UUID so the envelope shape is still valid. */
  private handlePiResponse(frame: Extract<StdoutFrame, { type: 'response' }>): void {
    // Look up the originating command before any branch decision —
    // the handshake-get_state case consumes the entry without
    // forwarding, every other branch reads the same entry for
    // its `reply_to`.
    const matched = frame.id !== undefined ? this.outstandingCommands.get(frame.id) : undefined;
    if (matched !== undefined) {
      this.outstandingCommands.delete(frame.id as string);
    }

    // S-7 review follow-up: bridge-initiated entries (the handshake
    // `get_state` we sent in `writeHandshakeGetState`) MUST be
    // consumed locally regardless of `frame.success`. The previous
    // code only matched `frame.command === 'get_state' && frame.success`
    // — a failure reply (success=false) fell through to the
    // command_result forwarder below, which used `matched.webEnvelopeId`
    // (a bridge-internal UUID generated in `writeHandshakeGetState`)
    // as `reply_to`. Web could never match that — the reply was
    // leaked as a phantom command_result pointing at a UUID nobody
    // sent. The fix: if the matched entry is bridge-initiated, the
    // reply is ours to consume — success drives the handshake
    // completion, failure (the child couldn't answer a basic
    // get_state request) forces the bridge into exited because
    // such a child is effectively unusable.
    if (matched?.bridgeInitiated === true) {
      if (frame.command === 'get_state' && frame.success) {
        // Handshake completion (PRD §2.3 + roadmap §4.1 ⚠).
        this.completeHandshake();
      } else {
        // Bridge-initiated failure: child can't even answer get_state,
        // so the spawn is effectively dead. Force exited (no restart
        // — ENOENT-style spawn failures don't auto-restart).
        logger.warn(
          `bridge-initiated ${frame.command} failed (success=${String(frame.success)}); forcing exited`,
        );
        this.forceExitedAfterSpawnFailure(
          `bridge-initiated ${frame.command} failed`,
        );
      }
      return;
    }

    if (frame.command === 'get_state' && frame.success) {
      // Handshake completion (PRD §2.3 + roadmap §4.1 ⚠). Reachable
      // only when `matched` is undefined (stale get_state reply with
      // no outstanding entry) — the bridge-initiated path above
      // covers the live outstanding case. Keeping the check defensive:
      // a stray success get_state from a previous child still
      // completes the handshake rather than forwarding as
      // command_result.
      this.completeHandshake();
      return;
    }
    if (frame.command === 'get_messages') {
      // W2: `get_messages` carries messages in `frame.data.messages`
      // per pi's native shape; the bridge wraps it in a snapshot
      // envelope (no `command` field, just `{ messages: [...] }`).
      // When the id isn't in our outstanding table we still emit a
      // snapshot — the wire shape is fixed by `SnapshotEnvelope`,
      // only the `reply_to` correlation becomes best-effort.
      const messages =
        frame.data !== null && typeof frame.data === 'object' && 'messages' in frame.data
          ? (frame.data as { messages: unknown[] }).messages
          : [];
      const replyTo = matched?.webEnvelopeId ?? randomUUID();
      this.onOutbound({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'snapshot',
        id: randomUUID(),
        reply_to: replyTo,
        payload: { messages },
      });
      return;
    }
    // Forward all other replies as `command_result` envelopes. The
    // shared module's zod schema validates the shape (the bridge is
    // allowed to pass through any string for `command`).
    //
    // error normalization: pi's RPC contract emits `error` as a raw
    // string (verified against `@earendil-works/pi-coding-agent@
    // 0.85.1` `dist/modes/rpc/rpc-mode.js:38`), but the shared
    // `CommandResultPayloadSchema` requires `error: { code: string,
    // message: string }`. Passing the raw string through verbatim
    // caused worker to refuse the envelope with `payload.error
    // expected object, received string`. `normalizePiError` handles
    // all four shapes (undefined / string / `{code,message}` /
    // other) and returns `undefined` so the field is omitted when
    // the reply was actually successful.
    const replyTo = matched?.webEnvelopeId ?? randomUUID();
    const normalizedError = normalizePiError(frame.error);
    this.onOutbound({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'command_result',
      id: randomUUID(),
      reply_to: replyTo,
      payload: {
        command: frame.command,
        success: frame.success,
        ...(frame.data !== undefined ? { data: frame.data } : {}),
        ...(normalizedError !== undefined ? { error: normalizedError } : {}),
      },
    });
  }

  /** Move spawning → ready + drain the deferred command queue. A queued
   *  write command (prompt / steer / follow_up) causes ready → running;
   *  read-only commands such as get_messages leave the manager in ready
   *  and must not emit a running broadcast. */
  private completeHandshake(): void {
    this.transitionTo('ready');
    const queued = this.deferredCommands;
    this.deferredCommands = [];
    for (const cmd of queued) {
      this.writeCommand(cmd);
    }
    if (queued.some((cmd) => isWriteCommand(cmd.type))) {
      this.transitionTo('running');
    }
  }

  /** (Removed — the old `handlePiEvent` assumed pi 0.85.1 wrapped events
   *  as `{type:"event", event:"...", data:...}`, which it does NOT.
   *  Events stream as raw session-emitter objects with `type` being
   *  the event name. The dispatch is now in `handleStdoutFrame`
   *  directly. See the comment on `StdoutFrame` for the wire-shape
   *  evidence + the upstream source citation.) */

  /** Exit handler — the heart of §2.6 / exit handling. Three paths:
   *
   *    - 自主 kill 标记在 → 清标记 → exited → 不重启
   *    - 标记不在 + code !== 0 → exited → 立即 spawn
   *    - 标记不在 + code === 0 → exited → 不重启
   *
   *  The self-kill flag MUST be set BEFORE child.kill() (see
   *  killIdleChild below) so the race window between "signal sent"
   *  and "exit fires" always observes the flag set. */
  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    // Drain stdout/stderr so any tail content (e.g. a final agent
    // event that landed after the SIGTERM) gets logged before we
    // tear down child references.
    this.flushStdout();
    this.flushStderr();
    const previousPhase = this.phase;
    const wasSelfKill = this.selfKillFlag;
    if (wasSelfKill) this.selfKillFlag = false;
    // The child pointer must be cleared BEFORE the transition so
    // the broadcast reflects the post-exit state.
    this.child = null;
    // Clear any pending SIGKILL escalation — the child is already
    // exiting, the timer is now moot.
    this.clearSigkillTimer();
    // W3: drop the outstanding-commands table — every entry it held
    // pointed at a command written to (or queued for) the now-dead
    // child. Carrying them across a crash-restart would let a future
    // pi response for a DIFFERENT id accidentally match a stale key
    // (e.g. the next session reuses the same uuid). Commands that
    // are still meaningful to web are recovered via §2.7 spawn
    // triggers on the next request, not via phantom replies.
    this.outstandingCommands.clear();
    // Task 05: drop any pending extension UI requests + their
    // timeout mirrors. Without this, a crash-restarted child would
    // inherit a stale blocked_on set (pointers to a dead child's
    // request ids) and web would see ghost dialogs in the next
    // session_state broadcast. clearAll() emits one final broadcast
    // so web sees the cleared state immediately (the
    // transitionTo('exited') below emits a SECOND broadcast — both
    // are valid; the first carries `blocked_on: []`, the second
    // carries `phase: 'exited'` + cleared blocked_on).
    this.extensionUIRouter.clearAll();
    // Drop the deferred queue (its commands never landed; web may
    // retry on the next spawn-trigger).
    const droppedDeferred = this.deferredCommands.length;
    this.deferredCommands = [];
    if (wasSelfKill) {
      // Path 1: autonomous kill (idle timer or stop()) — no restart.
      logger.info(`pi exited after self-kill (code=${code}, signal=${signal}) — no restart`);
      this.transitionTo('exited');
      return;
    }
    if (code !== 0) {
      // Path 2: crash (exit !== 0, flag not set) — spawn immediately.
      // PRD §2.6: "广播 exited → 立即 spawn 新子进程". Broadcast first
      // so web sees the transition before the new process reports
      // `spawning`; otherwise the brief `exited` blip is invisible.
      //
      // S6 review follow-up: if a crash happened while spawn-trigger
      // commands were queued, web has no way to know those commands
      // never landed — the bridge went exited → spawning → (crash)
      // and the queue was silently cleared. Log a warn so operators
      // can correlate "I sent X, then nothing" with a child crash,
      // and so a future web retry logic has a sentinel to surface.
      if (previousPhase === 'spawning' && droppedDeferred > 0) {
        logger.warn(
          `queued commands dropped during spawn crash, web should retry (${droppedDeferred} command(s))`,
        );
      }
      logger.warn(`pi exited unexpectedly (code=${code}, signal=${signal}) — restarting`);
      this.transitionTo('exited');
      if (!this.stopped && previousPhase !== 'exited') {
        this.spawnNow();
      }
      return;
    }
    // Path 3: clean exit (code === 0, flag not set) — no restart.
    // PRD §2.6: "stdin EOF 等合法关闭路径". Web may re-wake via
    // §2.7 spawn triggers.
    logger.info(`pi exited cleanly (code=0) — no restart`);
    this.transitionTo('exited');
  }

  // ----------------------------------------------------------------
  // State machine — phase transitions + session_state broadcasts
  // ----------------------------------------------------------------

  /** Move to `next` phase and broadcast a `session_state` envelope.
   *  Caller is responsible for any side effects (spawning the child,
   *  arming timers, etc.) — this method only handles the bookkeeping. */
  private transitionTo(next: SessionPhase): void {
    const previous = this.phase;
    if (previous === next) return;
    this.phase = next;
    logger.info(`phase transition: ${previous} → ${next}`);
    this.broadcastSessionState();
  }

  /** Emit `session_state` with the current phase + blocked_on. Called
   *  on every transition AND on demand when blocked_on changes (the
   *  ExtensionUIRouter triggers this via the broadcastSessionState
   *  callback when entries are added or removed). The envelope
   *  is a real `Envelope` value matching `SessionStateEnvelope` —
   *  the shared zod schema will accept it downstream.
   *
   *  `blocked_on` is read from the router, which is the single
   *  source of truth for the pending set (task 05 split). When the
   *  router has no pending entries we OMIT the field entirely so
   *  the wire stays compact (PRD §1.2: "缺省视为空数组"). */
  private broadcastSessionState(): void {
    const blockedOn = this.extensionUIRouter.getBlockedOn();
    const payload: SessionStatePayload = {
      phase: this.phase,
      ...(blockedOn.length > 0 ? { blocked_on: blockedOn } : {}),
    };
    this.onOutbound({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: randomUUID(),
      payload,
    });
  }

  // ----------------------------------------------------------------
  // Idle timer — 5 min after agent_settled → SIGTERM → 1s → SIGKILL
  // ----------------------------------------------------------------

  /** Start the idle countdown. Called from `handleStdoutFrame` when
   *  an `agent_settled` event arrives from pi (raw shape
   *  `{type:"agent_settled"}` — see `StdoutFrame` for the wire-
   *  shape evidence + the upstream source citation). Calling this
   *  twice replaces the previous timer (only one idle timer should
   *  be active at a time — PRD §2.3 says "计时窗口内收到新任务则重置").
   *  previous timer (only one idle timer should be active at a time —
   *  PRD §2.3 says "计时窗口内收到新任务则重置").
   *
   *  W5/W6: gated on `phase === 'running'` only. Per PRD §2.3 the
   *  state machine enumerates ONLY `running →(agent_settled)→ idle`;
   *  receiving `agent_settled` in `ready` is out-of-spec — `ready`
   *  means "no work has been done yet" (the first prompt hasn't been
   *  sent), so the idle-kill semantic ("we finished work, no one's
   *  around") doesn't apply. We still log a debug line + transition
   *  if it somehow arrives in `ready`, but no timer is armed: a
   *  stale ready phase must not silently SIGTERM a perfectly idle
   *  pi child. In `spawning` / `exited` / `idle` the event is also
   *  ignored — there's no child to kill (exited), the timer is
   *  already running and a second arm would double-fire (idle), or
   *  we're mid-spawn and any SIGTERM would race the handshake
   *  (spawning). Critically we must NOT call `clearIdleTimer`
   *  before this gate: doing so would tear down a still-valid
   *  timer (e.g. the first agent_settled armed it, the second
   *  arrives while we're still `idle` and should be ignored). */
  private startIdleTimer(): void {
    if (this.phase !== 'running') {
      // Out-of-spec arrival — log once + bail without touching
      // any active timer. The original code would have armed a
      // timer anyway, which could SIGTERM a freshly-spawned
      // child that hasn't accepted its first prompt yet (PRD §2.3
      // R1 修正: spawn 期到达的 agent_settled 误杀合法 running
      // 进程) — OR cancel a still-valid idle timer when a duplicate
      // `agent_settled` lands while we're already in `idle`.
      logger.info(
        `agent_settled ignored — phase=${this.phase} (only armed in 'running' per PRD §2.3)`,
      );
      return;
    }
    // Only now is it safe to clear: a fresh timer will replace it
    // and we're guaranteed there's nothing to preserve.
    this.clearIdleTimer();
    this.idleTimer = this.setTimer(() => this.killIdleChild(), this.idleTimeoutMs);
    // Transition to idle (only from running — ready / exited /
    // spawning / idle are explicitly out-of-spec above).
    this.transitionTo('idle');
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** SIGTERM → 1s → SIGKILL grace path. CRITICAL: `selfKillFlag = true`
   *  MUST be set BEFORE `child.kill('SIGTERM')` — the OS can deliver
   *  the SIGTERM and the child's exit handler can fire before our
   *  synchronous `kill()` call returns, especially under load. If
   *  the flag isn't set first, `handleExit` sees the bare exit and
   *  takes the crash-restart path (PRD §2.6 R1 修正). */
  private killIdleChild(): void {
    const child = this.child;
    if (child === null) return;
    this.selfKillFlag = true;
    this.clearIdleTimer();
    logger.info(`idle timeout (${this.idleTimeoutMs}ms) reached — sending SIGTERM`);
    try {
      child.kill('SIGTERM');
    } catch {
      // already dead — the exit handler will still run with the flag
      // set, taking the no-restart path.
    }
    // Schedule the SIGKILL escalation in case the child doesn't exit
    // cleanly. The timer is cleared either when the child actually
    // exits (handleExit sees the flag, takes the no-restart path) or
    // when stop() is called.
    this.sigkillTimer = this.setTimer(() => {
      this.sigkillTimer = null;
      const stillAlive = this.child;
      if (stillAlive !== null) {
        logger.warn('SIGTERM did not exit child within grace — escalating to SIGKILL');
        try {
          stillAlive.kill('SIGKILL');
        } catch {
          // already dead
        }
      }
    }, this.sigkillDelayMs);
  }

  private clearSigkillTimer(): void {
    if (this.sigkillTimer !== null) {
      this.clearTimer(this.sigkillTimer);
      this.sigkillTimer = null;
    }
  }

  // ----------------------------------------------------------------
  // Inbound envelopes — handleEnvelope is the public entry point
  // ----------------------------------------------------------------

  /** Top-level dispatcher for web → bridge envelopes. The BridgeClient
   *  forwards every non-internally-handled envelope here. We narrow
   *  on `kind` + `type` to route to the right internal handler. */
  handleEnvelope(env: Envelope): void {
    if (env.kind === 'control') {
      switch (env.type) {
        case 'get_state':
          this.handleGetState(env.id);
          break;
        case 'list_directories':
          // M4 task 05: directory-browser control command. Pure fs
          // operation — does NOT need a pi process, NEVER triggers a
          // spawn. Lives in the manager temporarily until task 06
          // moves control-family commands into the dedicated
          // BridgeSessionLayer (the same refactor will move
          // work_dir_* and session_list). For now, it sits next to
          // get_state because both are "answer without spawn" control
          // types whose semantics are independent of the pi state
          // machine.
          this.handleListDirectories(env.id, env.payload.path, env.session);
          break;
        // Other control types (`handshake`, `ping`, `pong`,
        // `session_state`, `session_list`, `result`, `error`) are
        // handled by BridgeClient — this manager does not act on
        // them. `session_state` arriving FROM web would be a wire
        // violation (only the bridge produces it).
        default:
          break;
      }
      return;
    }
    // env.kind === 'pi'
    switch (env.type) {
      case 'prompt':
        this.handlePrompt(env.id, env.payload.content);
        break;
      case 'steer':
        this.handleSteer(env.id, env.payload.content);
        break;
      case 'follow_up':
        this.handleFollowUp(env.id, env.payload.content);
        break;
      case 'abort':
        this.handleAbort(env.id);
        break;
      case 'get_messages':
        this.handleGetMessages(env.id, env.payload.since ?? undefined);
        break;
      case 'extension_ui_response':
        this.handleExtensionUIResponse(env.id, env.payload);
        break;
      // bridge → web types arriving here would be a wire violation
      // (`command_result`, `snapshot`, `event`).
      default:
        break;
    }
  }

  /** `control/get_state` — answer from memory (PRD §2.7: 永远由 bridge
   *  内存作答，永不 spawn). The reply is a `result` envelope with
   *  `data = { phase, blocked_on? }`. The blocked_on set comes from
   *  the extension UI router (task 05 split). */
  private handleGetState(requestId: string): void {
    const blockedOn = this.extensionUIRouter.getBlockedOn();
    const data: SessionStatePayload = {
      phase: this.phase,
      ...(blockedOn.length > 0 ? { blocked_on: blockedOn } : {}),
    };
    this.onOutbound({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'result',
      id: randomUUID(),
      reply_to: requestId,
      payload: { ok: true, data },
    });
  }

  /** `control/list_directories` — M4 task 05 directory browser.
   *  Pure fs operation; answer without spawn (PRD §2.7: never
   *  trigger spawn for a read). Delegates to the pure function
   *  in `list-directories.ts` and maps its domain-level outcome
   *  to the wire-level `result` envelope.
   *
   *  ## Wire-level error code mapping (PRD §2.5 + ADR-0010 §决策.4)
   *
   *  All three "user-path-is-bad" cases (ENOENT / EACCES / ENOTDIR)
   *  collapse to wire-level `invalid_envelope` — the path provided
   *  in the envelope payload is invalid in the fs-semantic sense
   *  even though its type-level shape is valid (schema accepts any
   *  string). `internal` is reserved for non-fs-classified errors
   *  (EIO / ELOOP / revalidation-failure).
   *
   *  See `list-directories.ts` header for the full mapping table
   *  + rationale (each branch carries a domain-specific message so
   *  the operator can grep their filesystem, while the wire-level
   *  code is the closest existing 6-value set member). */
  private handleListDirectories(requestId: string, path: string | undefined, session: string | undefined): void {
    const outcome = listDirectories(path);
    // M4 envelope field: `session` is the multi-session routing
    // key. We propagate it verbatim on the reply envelope so the
    // web can correlate by session — the dispatcher doesn't *use*
    // it (list_directories is a global fs operation), but the
    // reply still needs to carry it for the web to route the
    // response into the correct session bucket.
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
    // Domain-level → wire-level mapping via the pure helper in
    // list-directories.ts (single source of truth for the mapping
    // table — see list-directories.ts header for rationale).
    const wireCode = mapListDirectoriesDomainCodeToWire(outcome.code);
    this.onOutbound({
      ...baseEnvelope,
      payload: {
        ok: false,
        error: { code: wireCode, message: outcome.message },
      },
    });
  }

  // ----------------------------------------------------------------
  // Inbound pi commands — spawn trigger handling
  // ----------------------------------------------------------------

  /** `pi/prompt` — §2.7 spawn trigger.
   *
   *  State semantics:
   *    - exited: spawn + queue prompt + transition to spawning (the
   *      prompt will be flushed when the handshake completes)
   *    - spawning: queue prompt (waiting on handshake)
   *    - ready: write prompt + transition to running (first prompt)
   *    - running: write prompt, no transition (PRD §2.3: 不迁移)
   *    - idle: write prompt + transition to running (wake from idle)
   *
   *  The idle timer is always cleared when we write a prompt — a
   *  fresh prompt in any non-exited phase resets the 5-min clock. */
  private handlePrompt(id: string, content: string): void {
    const cmd: DeferredCommand = { type: 'prompt', id, content };
    this.handleSpawnTrigger(cmd);
  }

  /** `pi/steer` — same trigger semantics as prompt. */
  private handleSteer(id: string, content: string): void {
    const cmd: DeferredCommand = { type: 'steer', id, content };
    this.handleSpawnTrigger(cmd);
  }

  /** `pi/follow_up` — same trigger semantics as prompt. */
  private handleFollowUp(id: string, content: string): void {
    const cmd: DeferredCommand = { type: 'follow_up', id, content };
    this.handleSpawnTrigger(cmd);
  }

  /** `pi/get_messages` — §2.7 spawn trigger. Same routing as prompt
   *  except we don't transition to running on first arrival (it's a
   *  read — per PRD §2.3 broadcasts are triggered by writes + state
   *  changes; get_messages is neither).
   *
   *  W1 review follow-up: the optional `since` cursor is now passed
   *  through to the pi-side command verbatim. The wire cost is one
   *  optional field — `JSON.stringify` already drops `undefined`,
   *  so the absence case is identical to before. M3 recovery
   *  protocol stays at "full snapshot" (PRD §非目标 lists
   *  incremental recovery as deferred to M+); this is just a
   *  passthrough so a future build can flip on `since` without
   *  re-touching the manager.
   *  // TODO(M+): since 增量同步，见 PRD §非目标 */
  private handleGetMessages(id: string, since: string | undefined): void {
    const cmd: DeferredCommand =
      since !== undefined ? { type: 'get_messages', id, since } : { type: 'get_messages', id };
    this.handleSpawnTrigger(cmd);
  }

  /** Common spawn-trigger handler. Differentiates "first arrival in
   *  ready" (causes running transition) from "arrival in any other
   *  phase" (no transition). Spawn triggers in `exited` always queue
   *  and force a `spawning` transition; triggers in `spawning` are
   *  already queued and don't transition again; triggers in
   *  `ready` / `running` / `idle` write immediately.
   *
   *  Only WRITES (prompt / steer / follow_up) cause the ready →
   *  running transition. `get_messages` is a read — per PRD §2.3
   *  the state machine enumerates "首个 prompt / steer / follow_up"
   *  as the transition trigger; reads stay in whatever phase they
   *  arrived in. The bridge-side broadcast principle (PRD §2
   *  "广播原则: get_messages 不触发 session_state 广播") reinforces
   *  this — a read should never cause a phase transition.
   *
   *  W5 review follow-up: `clearIdleTimer()` runs at the top of
   *  this handler as a defensive coverall. The `idle` branch below
   *  also clears explicitly via `transitionTo('running')`'s
   *  preconditions, but the early coverall catches any future
   *  spawn-migration path that bypasses the transition (e.g. a
   *  future "force respawn from idle" admin command). It is a
   *  no-op when the timer is null. The `spawnNow()` path inside
   *  the `exited` branch also benefits: even though the timer
   *  is normally null at exited time, an admin-triggered path
   *  (not implemented today) could leave it dangling across the
   *  spawn transition — the coverall makes that class of bug
   *  impossible. */
  private handleSpawnTrigger(cmd: DeferredCommand): void {
    // W3: every web-initiated command gets an outstanding entry
    // BEFORE we write to pi, so a pi response echoing the id can
    // always find its webEnvelopeId. The entry persists across
    // the spawning → ready transition (the command may be
    // deferred and written later; we still need its web id to
    // survive).
    this.outstandingCommands.set(cmd.id, {
      webEnvelopeId: cmd.id,
      command: cmd.type,
      bridgeInitiated: false,
    });

    const isWrite = isWriteCommand(cmd.type);

    // W5 coverall: clear any active idle timer before any
    // spawning-side effect. Idle-side writes do this explicitly
    // via the transition below; this is a safety net for the
    // exited/spawning paths and any future spawn-migration
    // branches.
    if (isWrite) this.clearIdleTimer();

    if (this.phase === 'exited') {
      // Spawn and queue — handshake completion will flush.
      this.spawnNow();
      this.deferredCommands.push(cmd);
      return;
    }
    if (this.phase === 'spawning') {
      // Handshake in progress — queue.
      this.deferredCommands.push(cmd);
      return;
    }
    // ready / running / idle — write directly. Idle timer is always
    // cleared for writes (a fresh prompt resets the 5-min clock);
    // reads don't touch it.
    this.writeCommand(cmd);
    if (this.phase === 'ready' && isWrite) {
      // First write command after handshake → running. Reads in
      // ready leave us in ready.
      this.transitionTo('running');
    } else if (this.phase === 'idle' && isWrite) {
      // Wake from idle → running.
      this.transitionTo('running');
    }
    // running: no transition (PRD §2.3 explicit).
  }

  /** `pi/abort` — in any non-exited phase, write abort to pi. In
   *  `exited` it's a no-op per PRD §2.7 (回 command_result{success:
   *  true}). The reply is the only outbound signal — we don't move
   *  phase on abort (pi handles the actual transition via its
   *  internal abort handling + subsequent agent_settled).
   *
   *  W3: the non-exited branch registers the abort id in the
   *  outstanding table so the pi response (when it arrives) can
   *  correlate `reply_to = webEnvelopeId`. The exited branch
   *  emits its own command_result synchronously with the right
   *  reply_to, so it doesn't need an outstanding entry. */
  private handleAbort(id: string): void {
    if (this.phase === 'exited') {
      // No-op per PRD §2.7 — but still emit command_result so web
      // gets the contract closure. success: true because there's
      // nothing to abort (matches "abort did its job vacuously").
      this.onOutbound({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'command_result',
        id: randomUUID(),
        reply_to: id,
        payload: { command: 'abort', success: true },
      });
      return;
    }
    // running / idle / ready / spawning — write abort. Phase is
    // updated when pi emits its settlement events.
    this.outstandingCommands.set(id, {
      webEnvelopeId: id,
      command: 'abort',
      bridgeInitiated: false,
    });
    this.writeCommand({ type: 'abort', id });
  }

  /** `pi/extension_ui_response` — task 05 router delegation.
   *  The router owns the wire translation (web shape → pi native
   *  three-state), the pending Map lookup with atomic-clear, the
   *  timeout cancellation, and the broadcast. The manager's only
   *  responsibility is to forward the envelope to the router.
   *
   *  `env.id` is the web envelope id — the router uses it for the
   *  `command_result.reply_to` field on the late-submission
   *  (request_expired) path so web can correlate the error with the
   *  original response attempt. */
  private handleExtensionUIResponse(id: string, payload: ExtensionUIResponsePayload): void {
    this.extensionUIRouter.handleWebResponse({ id, payload });
  }

  // ----------------------------------------------------------------
  // Internal — stdin write helper
  // ----------------------------------------------------------------

  /** JSON-line encode + write to pi's stdin. If the child is dead
   *  (race between command arrival and exit) we just log and drop —
   *  §2.7 spawn triggers will re-spawn on the next command. We do
   *  NOT queue writes for a dead child.
   *
   *  Translation step: `DeferredCommand` carries the web-wire field
   *  names (`content`, optional `since`), but pi's stdin expects
   *  pi-native names (`message`, no `since`). `translateToPiWire`
   *  performs the rename + drop before JSON.stringify — see that
   *  function's JSDoc for the exact rules and the regression
   *  rationale (writing `content` directly here was the M3 task
   *  06 root cause of pi's `TypeError: Cannot read properties of
   *  undefined (reading 'startsWith')` on first prompt). */
  private writeCommand(cmd: DeferredCommand): void {
    const child = this.child;
    if (child === null) {
      logger.warn(`dropping ${cmd.type} — no live child`);
      return;
    }
    const piCmd = translateToPiWire(cmd);
    try {
      child.stdin.write(JSON.stringify(piCmd) + '\n');
    } catch (err) {
      logger.warn(`stdin write failed for ${cmd.type}: ${(err as Error).message}`);
    }
  }

  // ----------------------------------------------------------------
  // Test seam accessors
  // ----------------------------------------------------------------

  /** Current phase — primarily for tests verifying state transitions
   *  without having to parse `onOutboundEnvelope` outputs. */
  getPhase(): SessionPhase {
    return this.phase;
  }

  /** Number of `spawnNow()` calls. The first spawn counts as 1;
   *  subsequent crash-restarts increment. Tests verify §2.7 semantics
   *  ("exited 时发 prompt → spawn 计数 +1"). */
  getSpawnCount(): number {
    return this.spawnCount;
  }

  /** True when the self-kill flag is currently raised. Used by tests
   *  to verify the "先置位再发信号" contract (PRD §2.3 R1 修正). */
  isSelfKillFlagSet(): boolean {
    return this.selfKillFlag;
  }

  /** Currently blocked-on entries (snapshot, not a live reference).
   *  Reads from the router — the router is the single source of
   *  truth for the pending set (task 05 split). */
  getBlockedOn(): BlockedOnEntryPayload[] {
    return this.extensionUIRouter.getBlockedOn();
  }

  /** Read an outstanding-commands entry by its pi-side id (test
   *  seam). Lets the new handshake-write test verify that the
   *  bridge-initiated `get_state` carries the expected flags
   *  without exposing the underlying Map. */
  getOutstandingCommand(
    id: string,
  ): { webEnvelopeId: string; command: string; bridgeInitiated: boolean } | undefined {
    return this.outstandingCommands.get(id);
  }

  /** Quick assertion helper — every phase must be one of the lock-
   *  versioned enum values. Exposed for tests so they can verify
   *  transitions are constrained. */
  static readonly PHASES = SESSION_PHASES;
}

// ---------------------------------------------------------------------------
// Default spawn factory — wraps node:child_process.spawn
// ---------------------------------------------------------------------------

/** Cast a real ChildProcess into our narrow PiChild. The cast is safe
 *  because production code never relies on ChildProcess methods beyond
 *  what PiChild exposes; tests construct their own fake child that
 *  implements PiChild directly. */
function defaultSpawn(cmd: string, args: readonly string[], opts: PiSpawnOptions): PiChild {
  const child: ChildProcess = nodeSpawn(cmd, [...args], {
    env: opts.env,
    stdio: opts.stdio,
    cwd: opts.cwd,
  });
  return child as unknown as PiChild;
}
