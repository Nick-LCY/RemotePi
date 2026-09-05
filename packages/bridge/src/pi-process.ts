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
// queued commands are flushed in arrival order, then the phase moves
// to `running`.
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
import { logger } from './logger.js';
import { authJsonExists, sessionArgv, sessionSubdir } from './pi-cwd-encoder.js';

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
 *  W1 review follow-up: `get_messages.since` is an optional cursor
 *  forwarded verbatim to pi — the cost is one optional field plus a
 *  JSON.stringify passthrough, so we don't add a TODO comment and
 *  leave the field disabled. PRD §非目标 defers incremental
 *  recovery to M+; the field is here so a future build can flip
 *  without a DeferredCommand migration. */
type DeferredCommand =
  | { type: 'prompt'; id: string; content: string }
  | { type: 'steer'; id: string; content: string }
  | { type: 'follow_up'; id: string; content: string }
  | { type: 'get_messages'; id: string; since?: string }
  | { type: 'abort'; id: string };

export interface PiProcessOptions {
  /** Bridge-owned pi agent dir; the value passed to PI_CODING_AGENT_DIR
   *  env var. Also where auth.json is expected (PRD §2.3 + decision 4). */
  isolationDir: string;
  /** Working directory for the session (passed as cwd to spawn). */
  workDir: string;
  /** Path to `<isolationDir>/auth.json`; existence checked at startup. */
  authJsonPath: string;

  /** Override the spawn factory (test seam). Defaults to `node:child_process.spawn`. */
  spawn?: SpawnFn;
  /** Override timer functions (test seam — vitest fake timers). */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  /** Override idle timeout (test seam — keep prod value realistic). */
  idleTimeoutMs?: number;
  /** Override SIGKILL grace delay (test seam). */
  sigkillDelayMs?: number;
  /** Override the env override passed to spawn (test seam — defaults to process.env). */
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
  | { type: 'event'; event: string; id?: string; data?: unknown }
  | { type: string; [k: string]: unknown };

export class PiProcessManager {
  // ---- configuration (immutable after construction) ----
  private readonly isolationDir: string;
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
    this.isolationDir = options.isolationDir;
    this.workDir = options.workDir;
    this.authJsonPath = options.authJsonPath;
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

  /** Idempotent. Logs auth.json status (warn if missing — per PRD
   *  §2.3 the bridge does NOT auto-login). Doesn't spawn pi; pi is
   *  spawned lazily on the first spawn-trigger command (ADR-0003 +
   *  PRD §2.3: "延迟到首任务触发, 不预热"). */
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
      // PRD §2.3 + 已敲定决策: bridge does NOT auto-login; it just
      // nudges the operator to run `pi login`.
      console.error(
        `[bridge] auth.json missing at ${this.authJsonPath} — run 'pi login' to authenticate`,
      );
    }
    logger.info(`PI_CODING_AGENT_DIR=${this.isolationDir}`);
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
   *  §2.7 semantics ("spawn 计数 +1" per triggered spawn). */
  private spawnNow(): void {
    if (this.stopped) return;
    this.spawnCount++;
    const subdir = sessionSubdir(this.isolationDir, this.workDir);
    const sessionFlags = sessionArgv(subdir); // ['--session', path] or []
    const args = ['--mode', 'rpc', ...sessionFlags];
    const env: Record<string, string | undefined> = {
      ...this.baseEnv,
      PI_CODING_AGENT_DIR: this.isolationDir,
    };
    logger.info(
      `spawning pi (count=${this.spawnCount}): pi ${args.join(' ')} (cwd=${this.workDir})`,
    );
    const child = this.spawnFn('pi', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
  }

  /** Wire the 'exit' + stream listeners onto a fresh child. */
  private attachChild(child: PiChild): void {
    child.on('exit', (code, signal) => this.handleExit(code, signal));
    child.stdout.on('data', (chunk: Buffer | string) => this.feedStdout(chunk));
    child.stderr.on('data', (chunk: Buffer | string) => this.feedStderr(chunk));
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

  /** Parse one JSONL line from pi stdout and dispatch. We accept a
   *  few different frame shapes:
   *    - `{ type: 'response', command, success, ... }` — reply to a
   *      command we sent. The `get_state` reply drives the ready
   *      transition (handshake completion); other replies are forwarded
   *      to the caller as `command_result` envelopes.
   *    - `{ type: 'event', event, data }` — lifecycle events we act on
   *      (`agent_settled` → start idle timer; extension UI requests
   *      are forwarded but task 05 wires up the actual handling). Other
   *      events are forwarded as-is.
   *    - Anything else (e.g. startup `setStatus` batch pi emits before
   *      the handshake) — ignored per roadmap §4.1 ⚠. */
  private handleStdoutFrame(line: string): void {
    let parsed: StdoutFrame;
    try {
      parsed = JSON.parse(line) as StdoutFrame;
    } catch {
      logger.warn(`dropping non-JSON pi stdout line: ${line.slice(0, 200)}`);
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const t = (parsed as { type?: unknown }).type;
    if (t === 'response') {
      this.handlePiResponse(parsed as Extract<StdoutFrame, { type: 'response' }>);
    } else if (t === 'event') {
      this.handlePiEvent(parsed as Extract<StdoutFrame, { type: 'event' }>);
    }
    // Other pi frame types (setStatus / setWidget / etc. — see PRD §6
    // "fire-and-forget 5 类本地消化") are dropped here; task 05 will
    // route the relevant ones through `onStderr` / local logs.
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

    if (frame.command === 'get_state' && frame.success) {
      // Handshake completion (PRD §2.3 + roadmap §4.1 ⚠). The
      // outstanding entry (if any) is for the bridge-initiated
      // get_state we sent in `spawnNow` — it has no web envelope
      // counterpart, so nothing is forwarded.
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
    const replyTo = matched?.webEnvelopeId ?? randomUUID();
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
        ...(frame.error !== undefined
          ? { error: frame.error as { code: string; message: string } }
          : {}),
      },
    });
  }

  /** Move spawning → ready + drain the deferred command queue. If the
   *  queue is non-empty, the first command causes ready → running
   *  (per PRD §2.3: "首个 prompt / steer / follow_up" drives the
   *  transition). */
  private completeHandshake(): void {
    this.transitionTo('ready');
    const queued = this.deferredCommands;
    this.deferredCommands = [];
    for (const cmd of queued) {
      this.writeCommand(cmd);
    }
    if (queued.length > 0) {
      this.transitionTo('running');
    }
  }

  /** `event` frame from pi. Currently we react to three event names:
   *    - `agent_settled` → start idle timer (PRD §2.3 + ADR-0003).
   *    - `extension_ui_request` → route to the `ExtensionUIRouter`
   *      (4-class blocking or 5-class fire-and-forget, per PRD §2.4).
   *    - any other event → forwarded to caller as `pi/event` envelope.
   */
  private handlePiEvent(frame: Extract<StdoutFrame, { type: 'event' }>): void {
    const eventName = frame.event;
    const data = frame.data;
    if (eventName === 'agent_settled') {
      // PRD §2.3 + roadmap §4.3 ⚠: use agent_settled, not agent_end
      // (auto-retry would re-fire agent_end and the idle timer would
      // never settle). Start the idle timer; transition to idle.
      this.startIdleTimer();
      return;
    }
    if (eventName === 'extension_ui_request') {
      // Task 05: route to the dedicated router. The router handles
      // the 4-class blocking flow (add to pending → broadcast → forward
      // to web → arm timeout mirror) and the 5-class fire-and-forget
      // digest path (logger.info + drop, no blocked_on entry, no
      // web forward). The router also owns the wire translation for
      // web → pi on `extension_ui_response`.
      this.extensionUIRouter.handleEventFromPi({
        event: eventName,
        data,
      });
      return;
    }
    // Forward every other event verbatim — web layer routes by
    // `event` name (envelope evolution rule (c): `event.data` is open).
    this.onOutbound({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'event',
      id: randomUUID(),
      payload: { event: eventName, data: data ?? null },
    });
  }

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

  /** Start the idle countdown. Called from `handlePiEvent` when an
   *  `agent_settled` event arrives. Calling this twice replaces the
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
   *  NOT queue writes for a dead child. */
  private writeCommand(cmd: DeferredCommand): void {
    const child = this.child;
    if (child === null) {
      logger.warn(`dropping ${cmd.type} — no live child`);
      return;
    }
    try {
      child.stdin.write(JSON.stringify(cmd) + '\n');
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
  });
  return child as unknown as PiChild;
}
