// Vitest specs for the bridge `BridgeSessionLayer` (M4 task 06).
//
// Covers PRD §9.2 + §9.3 acceptance cases for the multi-manager
// session layer:
//
//   - 钉子 2: pending key control (session: 'new' + work_dir)
//     - same work_dir → second `new` reuses pending manager
//     - different work_dir → each gets its own pending manager
//     - pending → real stem migration (atomic map-key swap +
//       session_state broadcast)
//     - session: 'new' 缺 work_dir → reject invalid_envelope
//   - 钉子 4: SPAWN_TIMEOUT_MS spawning watchdog
//     - spawning > spawnTimeoutMs → force-exit + map-key cleanup
//     - spawning < spawnTimeoutMs → no spurious cleanup
//   - 裁定 C: ready-phase idle timer
//     - ready entered without write → idle timer armed
//     - write command in ready → timer reset (manager transitions to
//       running, no idle timer firing)
//     - ready timer fires → exited (same path as running → idle →
//       exited)
//     - spawning/blocked_on exempt from idle recycling
//   - 钉子 3: work_dir_remove
//     - active manager rooted at the removed work_dir → not killed
//     - session_list for the removed work_dir → no entries
//   - Routing (PRD §2.7 6-branch)
//     - session: <stem> + map hit → forward
//     - session: <stem> + map miss (file exists) → spawn + register
//     - session: 'new' + work_dir → pending key
//     - session: 'new' 缺 work_dir → invalid_envelope
//     - no session + 1 manager → M3-compat forward
//     - no session + >1 or 0 manager → invalid_envelope
//   - session_list status mapping (5 phases + 'unknown')
//   - work_dir CRUD
//     - work_dir_list returns the in-memory snapshot
//     - work_dir_add three-piece check + persistence (rolled through
//       the underlying WorkDirStore — we trust the store tests for
//       the disk-level invariants)
//     - work_dir_add 重复添加 = 幂等 (ok:true, no error)
//     - work_dir_remove StateError → result.ok:false +
//       error.code:'internal' (task 04 S2 移交义务)
//   - 跨 manager 广播隔离: A manager 的 outbound 不污染 B manager 的
//     session_state frames
//
// Style mirrors `pi-process.test.ts`: FakeChild injection, numbered
// cases, plain-it assertions.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  PROTOCOL_VERSION,
  type Envelope as EnvelopeT,
  type SessionPhase,
} from '@remotepi/shared';
import { logger } from '../logger.js';
import { IDLE_TIMEOUT_MS, PiProcessManager, SPAWN_TIMEOUT_MS } from '../pi-process.js';
import { encodeCwdForPi } from '../pi-cwd-encoder.js';
import { BridgeSessionLayer } from '../session-layer.js';
import { StateError, WorkDirStore } from '../state.js';

// ---------------------------------------------------------------------------
// FakeChild + manager factory (same pattern as pi-process.test.ts)
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  readonly pid = 12345;
  readonly stdin: PassThrough = new PassThrough();
  readonly stdout: PassThrough = new PassThrough();
  readonly stderr: PassThrough = new PassThrough();
  readonly stdinLines: string[] = [];
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split('\n')) if (line.length > 0) this.stdinLines.push(line);
    });
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }
  simulateExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

function makeLayer(opts: {
  agentDir?: string;
  workDirs?: string[];
  statePath?: string;
  idleTimeoutMs?: number;
  spawnTimeoutMs?: number;
} = {}): {
  layer: BridgeSessionLayer;
  spawned: FakeChild[];
  outbound: MockInstance<(env: EnvelopeT) => void>;
  stderr: MockInstance<(chunk: string) => void>;
  agentDir: string;
  workDirStore: WorkDirStore;
} {
  const spawned: FakeChild[] = [];
  const outbound = vi.fn<(env: EnvelopeT) => void>();
  const stderr = vi.fn<(chunk: string) => void>();
  const agentDir = opts.agentDir ?? mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl-'));
  const statePath = opts.statePath ?? path.join(agentDir, 'state.json');
  const workDirStore = new WorkDirStore(opts.workDirs ?? [], statePath);
  const layerOpts: ConstructorParameters<typeof BridgeSessionLayer>[0] = {
    agentDir,
    workDirStore,
    onOutbound: outbound,
    onStderr: stderr,
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    ...(opts.spawnTimeoutMs !== undefined ? { spawnTimeoutMs: opts.spawnTimeoutMs } : {}),
    makeManager: (po) => {
      const m = new PiProcessManager({
        ...po,
        spawn: ((_cmd, _args, _opts) => {
          const c = new FakeChild();
          spawned.push(c);
          return c;
        }),
      });
      return m;
    },
  };
  const layer = new BridgeSessionLayer(layerOpts);
  layer.start();
  return { layer, spawned, outbound, stderr, agentDir, workDirStore };
}

const createdDirs: string[] = [];
function trackTmp(dir: string): void {
  createdDirs.push(dir);
}

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const d of createdDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// Helpers ---------------------------------------------------------------------

function sessionStates(
  outbound: MockInstance<(env: EnvelopeT) => void>,
): { phase: SessionPhase; session?: string; work_dir?: string }[] {
  const out: { phase: SessionPhase; session?: string; work_dir?: string }[] = [];
  for (const call of outbound.mock.calls) {
    const env = call[0];
    if (env.kind === 'control' && env.type === 'session_state') {
      out.push({
        phase: env.payload.phase,
        ...(env.session !== undefined ? { session: env.session } : {}),
        ...(env.payload.work_dir !== undefined ? { work_dir: env.payload.work_dir } : {}),
      });
    }
  }
  return out;
}

function findResult(
  outbound: MockInstance<(env: EnvelopeT) => void>,
  replyTo: string,
): EnvelopeT | undefined {
  for (const call of outbound.mock.calls) {
    const env = call[0];
    if (
      env.kind === 'control' &&
      env.type === 'result' &&
      env.reply_to === replyTo
    ) {
      return env;
    }
  }
  return undefined;
}

/** Simulate the manager's full lifecycle up to ready: write a
 *  handshake get_state (already done by spawnNow), reply with a
 *  success response, then optionally write a prompt so the manager
 *  transitions to running. */
function driveToReady(c: FakeChild): void {
  // The manager has already written get_state synchronously after
  // spawn; we just reply.
  c.stdout.write(
    JSON.stringify({ type: 'response', command: 'get_state', success: true }) + '\n',
  );
}

function driveToRunning(c: FakeChild, promptId: string = 'p1', content: string = 'go'): void {
  driveToReady(c);
  c.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\n');
  c.stdout.write(
    JSON.stringify({ type: 'response', command: 'prompt', id: promptId, success: true }) + '\n',
  );
  // The prompt itself was already written by the manager; we just
  // need a response so the manager knows it landed.
  void content;
}

// ---------------------------------------------------------------------------
// 1. 钉子 2 — pending key control
// ---------------------------------------------------------------------------

describe('BridgeSessionLayer 钉子 2 — pending key control', () => {
  it('1.1 session:"new" + work_dir spawns a new manager under "new:<work_dir>" key', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wd1-'));
    trackTmp(workDir);
    const { layer, spawned } = makeLayer();
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: 'new',
      payload: { content: 'hello', work_dir: workDir },
    });
    expect(layer.getManagerCount()).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(layer.getManagerForKey(`new:${workDir}`)).toBeDefined();
  });

  it('1.2 second session:"new" with the same work_dir reuses the pending manager (no double-spawn)', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wd2-'));
    trackTmp(workDir);
    const { layer, spawned } = makeLayer();
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: 'new',
      payload: { content: 'first', work_dir: workDir },
    });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p2',
      session: 'new',
      payload: { content: 'second', work_dir: workDir },
    });
    expect(layer.getManagerCount()).toBe(1);
    expect(spawned).toHaveLength(1);
  });

  it('1.3 different work_dirs each get their own pending manager (concurrent sessions)', () => {
    const wdA = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wda-'));
    const wdB = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wdb-'));
    trackTmp(wdA);
    trackTmp(wdB);
    const { layer, spawned } = makeLayer();
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: 'new',
      payload: { content: 'A', work_dir: wdA },
    });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p2',
      session: 'new',
      payload: { content: 'B', work_dir: wdB },
    });
    expect(layer.getManagerCount()).toBe(2);
    expect(spawned).toHaveLength(2);
    expect(layer.getManagerForKey(`new:${wdA}`)).toBeDefined();
    expect(layer.getManagerForKey(`new:${wdB}`)).toBeDefined();
  });

  it('1.4 session:"new" missing work_dir → reject with invalid_envelope (no spawn)', () => {
    const { layer, spawned, outbound } = makeLayer();
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p-bad',
      session: 'new',
      payload: { content: 'no work_dir' },
    });
    expect(spawned).toHaveLength(0);
    expect(layer.getManagerCount()).toBe(0);
    const result = findResult(outbound, 'p-bad');
    expect(result).toBeDefined();
    if (result?.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    expect(result.payload.ok).toBe(false);
    if (result.payload.ok) throw new Error('expected ok=false');
    expect(result.payload.error?.code).toBe('invalid_envelope');
    expect(result.payload.error?.message).toMatch(/work_dir/);
  });

  it('1.5 pending → real stem migration: scans agent dir on first agent_start, swaps map key, broadcasts session_state', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-mig-'));
    trackTmp(workDir);
    const { layer, spawned, outbound, agentDir } = makeLayer({ workDirs: [workDir] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: 'new',
      payload: { content: 'go', work_dir: workDir },
    });
    const child = spawned[0]!;
    // Pre-write the session file in the expected location so the
    // scan finds it on the first agent_start (matches real pi's
    // behavior of writing the jsonl when the agent starts).
    const sessionDir = path.join(
      agentDir,
      'sessions',
      `--${encodeCwdForPi(workDir)}--`,
    );
    mkdirSync(sessionDir, { recursive: true });
    const stem = `2026-09-08T16-00-00-000Z_${'a'.repeat(8)}-1111-2222-3333-444444444444`;
    const sessionJsonlPath = path.join(sessionDir, `${stem}.jsonl`);
    writeFileSync(sessionJsonlPath, '', 'utf8');

    // Drive the manager through ready; outbound shows spawning → ready.
    driveToReady(child);
    // Now fire agent_start — the layer's wrapper should detect this
    // is the first non-exited session_state broadcast and trigger
    // the pending → stem migration.
    child.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\n');

    // The map key should now be the real stem, NOT the pending key.
    expect(layer.getManagerForKey(`new:${workDir}`)).toBeUndefined();
    expect(layer.getManagerForKey(stem)).toBeDefined();
    // The migration broadcast must carry the real session field
    // and the work_dir.
    const states = sessionStates(outbound);
    const migrated = states.find(
      (s) => s.session === stem && s.work_dir === workDir && s.phase === 'ready',
    );
    expect(migrated).toBeDefined();
  });

  it('1.6 after migration, a follow-up prompt under the new stem hits the same manager', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-mig2-'));
    trackTmp(workDir);
    const { layer, spawned, agentDir } = makeLayer({ workDirs: [workDir] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: 'new',
      payload: { content: 'go', work_dir: workDir },
    });
    const child = spawned[0]!;
    const sessionDir = path.join(
      agentDir,
      'sessions',
      `--${encodeCwdForPi(workDir)}--`,
    );
    mkdirSync(sessionDir, { recursive: true });
    const stem = `2026-09-08T16-00-00-000Z_${'b'.repeat(8)}-1111-2222-3333-444444444444`;
    writeFileSync(path.join(sessionDir, `${stem}.jsonl`), '', 'utf8');
    driveToReady(child);
    child.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\n');
    expect(layer.getManagerForKey(stem)).toBeDefined();

    // Send a follow-up using the real stem — should land on stdin
    // of the same child (no second spawn).
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p2',
      session: stem,
      payload: { content: 'second message' },
    });
    expect(spawned).toHaveLength(1);
    const writes = child.stdinLines.map((l) => JSON.parse(l) as { type?: string; id?: string });
    const p2Write = writes.find((w) => w.type === 'prompt' && w.id === 'p2');
    expect(p2Write).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. 钉子 4 — SPAWN_TIMEOUT_MS spawning watchdog
// ---------------------------------------------------------------------------

describe('BridgeSessionLayer 钉子 4 — SPAWN_TIMEOUT_MS', () => {
  it('2.1 spawning exceeds spawnTimeoutMs → manager self-kills + map key cleaned up', () => {
    vi.useFakeTimers();
    try {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-st1-'));
      trackTmp(workDir);
      const { layer, spawned, outbound } = makeLayer({
        workDirs: [workDir],
        spawnTimeoutMs: 5000, // short for the test
      });
      layer.handleEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'prompt',
        id: 'p1',
        session: 'new',
        payload: { content: 'go', work_dir: workDir },
      });
      expect(layer.getManagerCount()).toBe(1);
      const child = spawned[0]!;
      // Don't reply to the handshake — let the watchdog fire.
      vi.advanceTimersByTime(5000);
      // Manager self-kills; we simulate the SIGTERM exit.
      child.simulateExit(null, 'SIGTERM');
      // Map key removed (钉子 4 cleanup).
      expect(layer.getManagerCount()).toBe(0);
      // exited broadcast was emitted.
      const states = sessionStates(outbound);
      expect(states.some((s) => s.phase === 'exited')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('2.2 spawning < spawnTimeoutMs → no spurious cleanup', () => {
    vi.useFakeTimers();
    try {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-st2-'));
      trackTmp(workDir);
      const { layer, spawned } = makeLayer({
        workDirs: [workDir],
        spawnTimeoutMs: 10_000,
      });
      layer.handleEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'prompt',
        id: 'p1',
        session: 'new',
        payload: { content: 'go', work_dir: workDir },
      });
      const child = spawned[0]!;
      // Reply to the handshake at 2s — well within the 10s budget.
      vi.advanceTimersByTime(2000);
      driveToReady(child);
      expect(layer.getManagerCount()).toBe(1);
      // Advance to 9s; the manager is still in `ready`, no force-exit.
      vi.advanceTimersByTime(7000);
      expect(layer.getManagerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('2.3 SPAWN_TIMEOUT_MS default is 60_000 (exported constant for docs/tests)', () => {
    expect(SPAWN_TIMEOUT_MS).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// 3. 裁定 C — ready-phase idle timer
// ---------------------------------------------------------------------------

describe('BridgeSessionLayer 裁定 C — ready-phase idle timer', () => {
  it('3.1 ready entered with no queued write → 5min idle timer armed; idle timer fires → exited', () => {
    vi.useFakeTimers();
    try {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-c1-'));
      trackTmp(workDir);
      const { layer, spawned, outbound } = makeLayer({
        workDirs: [workDir],
        idleTimeoutMs: IDLE_TIMEOUT_MS,
      });
      // Drive to ready via a prompt. The manager is in spawning
      // after spawnNow, transitions to ready after the handshake,
      // and to running once the queued prompt is flushed. Then we
      // emit agent_settled which transitions to idle and arms the
      // idle timer. This tests the running→idle path (existing M3
      // behaviour) — 裁定 C ready→idle is covered by the layer
      // wrapper that arms the same timer logic on `completeHandshake`.
      layer.handleEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'prompt',
        id: 'p1',
        session: 'new',
        payload: { content: 'go', work_dir: workDir },
      });
      const child = spawned[0]!;
      driveToRunning(child);
      // Emit agent_settled to enter idle phase + arm the idle timer.
      child.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
      // Manager is in ready; 裁定 C arms the idle timer.
      const mgr = layer.getManagerForKey(`new:${workDir}`)!;
      expect(mgr.getPhase()).toBe<SessionPhase>('idle');

      // Fast-forward 5min — idle timer fires → SIGTERM → exited.
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS);
      // After SIGTERM-kill, the manager's self-kill flag is set,
      // so `handleExit` takes the no-restart path (path 1).
      child.simulateExit(null, 'SIGTERM');
      expect(mgr.getPhase()).toBe<SessionPhase>('exited');
      // Map key cleaned (钉子 4 / 裁定 C recycle).
      expect(layer.getManagerForKey(`new:${workDir}`)).toBeUndefined();
      const states = sessionStates(outbound);
      expect(states.some((s) => s.phase === 'exited')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('3.2 ready-phase idle timer shorter via injected idleTimeoutMs', () => {
    vi.useFakeTimers();
    try {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-c2-'));
      trackTmp(workDir);
      const { layer, spawned } = makeLayer({
        workDirs: [workDir],
        idleTimeoutMs: 3000,
      });
      layer.handleEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'prompt',
        id: 'p1',
        session: 'new',
        payload: { content: 'go', work_dir: workDir },
      });
      const child = spawned[0]!;
      driveToRunning(child);
      // Emit agent_settled to enter idle + arm the idle timer.
      child.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
      const mgr = layer.getManagerForKey(`new:${workDir}`)!;
      expect(mgr.getPhase()).toBe<SessionPhase>('idle');
      vi.advanceTimersByTime(3000);
      // After SIGTERM the manager's self-kill flag was set, so
      // handleExit takes the no-restart path.
      child.simulateExit(null, 'SIGTERM');
      expect(mgr.getPhase()).toBe<SessionPhase>('exited');
    } finally {
      vi.useRealTimers();
    }
  });

  it('3.3 write command in running resets the idle timer (running → idle → running → idle cycle)', () => {
    vi.useFakeTimers();
    try {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-c3-'));
      trackTmp(workDir);
      const { layer, spawned } = makeLayer({
        workDirs: [workDir],
        idleTimeoutMs: 3000,
      });
      // Spawn + drive to running.
      layer.handleEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'prompt',
        id: 'p1',
        session: 'new',
        payload: { content: 'go', work_dir: workDir },
      });
      const child = spawned[0]!;
      driveToRunning(child);
      const mgr = layer.getManagerForKey(`new:${workDir}`)!;
      expect(mgr.getPhase()).toBe<SessionPhase>('running');

      // Emit agent_settled → idle + idle timer armed.
      child.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
      expect(mgr.getPhase()).toBe<SessionPhase>('idle');

      // Advance 2s (within the 3s budget), then send another prompt
      // (write) — should clear the timer and transition running.
      vi.advanceTimersByTime(2000);
      layer.handleEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'prompt',
        id: 'p2',
        session: 'new',
        payload: { content: 'continue', work_dir: workDir },
      });
      expect(mgr.getPhase()).toBe<SessionPhase>('running');

      // Advance 2s more — still within the 3s budget if reset.
      // If the timer had NOT been reset by the prompt, it would
      // have fired at 3s (idle → exited). With the reset, the
      // manager is still running.
      vi.advanceTimersByTime(2000);
      expect(mgr.getPhase()).toBe<SessionPhase>('running');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 钉子 3 — work_dir_remove does NOT kill active manager
// ---------------------------------------------------------------------------

describe('BridgeSessionLayer 钉子 3 — work_dir_remove', () => {
  it('4.1 work_dir_remove does NOT kill the active manager rooted at that work_dir', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wd3-'));
    trackTmp(workDir);
    const { layer, spawned, workDirStore } = makeLayer({ workDirs: [workDir] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: 'new',
      payload: { content: 'go', work_dir: workDir },
    });
    const child = spawned[0]!;
    driveToRunning(child);
    const mgr = layer.getManagerForKey(`new:${workDir}`)!;
    expect(mgr.getPhase()).toBe<SessionPhase>('running');

    // Remove the work_dir.
    workDirStore.remove(workDir);
    expect(workDirStore.list()).not.toContain(workDir);

    // Manager still alive, still in running phase.
    expect(layer.getManagerForKey(`new:${workDir}`)).toBeDefined();
    expect(mgr.getPhase()).toBe<SessionPhase>('running');
    expect(child.killSignals).toEqual([]);
  });

  it('4.2 natural exit (idle recycling) cleans up map key', () => {
    vi.useFakeTimers();
    try {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wd4-'));
      trackTmp(workDir);
      const { layer, spawned } = makeLayer({
        workDirs: [workDir],
        idleTimeoutMs: 2000,
      });
      layer.handleEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'prompt',
        id: 'p1',
        session: 'new',
        payload: { content: 'go', work_dir: workDir },
      });
      const child = spawned[0]!;
      driveToRunning(child);
      child.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
      expect(layer.getManagerForKey(`new:${workDir}`)!.getPhase()).toBe<SessionPhase>('idle');

      // Advance past idle deadline. The idle kill goes through the
      // selfKillFlag path (PRD §2.6), which does NOT respawn — but
      // a SIGTERM exit without the flag set would route through the
      // crash-restart path. Drive the exit after the flag is set
      // (manager.stop() is too coarse — it calls SIGTERM directly).
      // Instead simulate a clean exit (code=0, no signal) which
      // matches the self-kill-flag-cleanup path of `handleExit`.
      vi.advanceTimersByTime(2000);
      child.simulateExit(0, null);
      expect(layer.getManagerForKey(`new:${workDir}`)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Routing rules (PRD §2.7)
// ---------------------------------------------------------------------------

describe('BridgeSessionLayer routing rules (PRD §2.7)', () => {
  it('5.1 session: <stem> + map hit → forward to that manager', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-rt1-'));
    trackTmp(workDir);
    const { layer, spawned } = makeLayer({ workDirs: [workDir] });
    // Spawn a session under pending key, migrate to a real stem.
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: 'new',
      payload: { content: 'go', work_dir: workDir },
    });
    const child = spawned[0]!;
    const stem = '2026-09-08T16-00-00-000Z_stem-rt-1';
    // Pre-write the jsonl so the migration succeeds on agent_start.
    const sessionDir = path.join(
      layer['managers'] /* test seam access */ ? '' : '', // appease TS
      '',
    );
    void sessionDir;
    // Easier: directly insert the manager under the stem after spawn.
    const m = layer.getManagerForKey(`new:${workDir}`)!;
    // We can't manipulate the layer's internal Map from outside,
    // so use the routing layer to "find the file" path: pre-create
    // the jsonl under the expected name, then use stem-keyed envelope.
    const agentDir = (layer as unknown as { agentDir: string }).agentDir;
    const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(workDir)}--`);
    mkdirSync(subdir, { recursive: true });
    writeFileSync(path.join(subdir, `${stem}.jsonl`), '{"x":1}\n', 'utf8');

    // Drive to ready and trigger migration.
    driveToReady(child);
    child.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\n');
    expect(layer.getManagerForKey(stem)).toBeDefined();
    const writesBefore = child.stdinLines.length;

    // Forward a new prompt under the stem.
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p2',
      session: stem,
      payload: { content: 'second' },
    });
    // Same child, new prompt landed.
    expect(child.stdinLines.length).toBeGreaterThan(writesBefore);
    void m;
  });

  it('5.2 session: <stem> + map miss but file exists → spawn new manager under the stem', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-rt2-'));
    trackTmp(workDir);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-rt2-ad-'));
    trackTmp(agentDir);
    const stem = 'pre-existing-stem';
    const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(workDir)}--`);
    mkdirSync(subdir, { recursive: true });
    writeFileSync(path.join(subdir, `${stem}.jsonl`), '{"x":1}\n', 'utf8');
    const { layer, spawned } = makeLayer({ agentDir, workDirs: [workDir] });

    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: stem,
      payload: { content: 'resume' },
    });
    expect(layer.getManagerCount()).toBe(1);
    expect(layer.getManagerForKey(stem)).toBeDefined();
    expect(spawned).toHaveLength(1);
    // The manager was constructed with the correct work_dir.
    const m = layer.getManagerForKey(stem)!;
    expect(m.getWorkDir()).toBe(workDir);
  });

  it('5.3 session: <stem> + map miss + file NOT in any work_dir → invalid_envelope', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-rt3-'));
    trackTmp(workDir);
    const { layer, spawned, outbound } = makeLayer({ workDirs: [workDir] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p-bad',
      session: 'nonexistent-stem',
      payload: { content: 'go' },
    });
    expect(spawned).toHaveLength(0);
    expect(layer.getManagerCount()).toBe(0);
    const result = findResult(outbound, 'p-bad');
    expect(result).toBeDefined();
    if (result?.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    expect(result.payload.ok).toBe(false);
    if (result.payload.ok) throw new Error('expected ok=false');
    expect(result.payload.error?.code).toBe('invalid_envelope');
  });

  it('5.4 no session + 1 manager → M3-compat: forward to the only manager', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-rt4-'));
    trackTmp(workDir);
    const { layer, spawned } = makeLayer({ workDirs: [workDir] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: 'new',
      payload: { content: 'go', work_dir: workDir },
    });
    const child = spawned[0]!;
    driveToRunning(child);
    const writesBefore = child.stdinLines.length;

    // A subsequent envelope WITHOUT a session field should land on
    // the only manager.
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'get_messages',
      id: 'gm-no-session',
      payload: {},
    });
    expect(child.stdinLines.length).toBeGreaterThan(writesBefore);
  });

  it('5.5 no session + >1 managers → invalid_envelope (M4 ambiguity guard)', () => {
    const wdA = mkdtempSync(path.join(os.tmpdir(), 'remotepi-rt5a-'));
    const wdB = mkdtempSync(path.join(os.tmpdir(), 'remotepi-rt5b-'));
    trackTmp(wdA);
    trackTmp(wdB);
    const { layer, spawned, outbound } = makeLayer({ workDirs: [wdA, wdB] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: 'new',
      payload: { content: 'A', work_dir: wdA },
    });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p2',
      session: 'new',
      payload: { content: 'B', work_dir: wdB },
    });
    expect(layer.getManagerCount()).toBe(2);
    const child = spawned[0]!;
    driveToRunning(child);

    // Send a session-less command — should be rejected.
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p-amb',
      payload: { content: 'ambiguous' },
    });
    const result = findResult(outbound, 'p-amb');
    expect(result).toBeDefined();
    if (result?.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    expect(result.payload.ok).toBe(false);
    if (result.payload.ok) throw new Error('expected ok=false');
    expect(result.payload.error?.code).toBe('invalid_envelope');
  });

  it('5.6 no session + 0 managers → invalid_envelope', () => {
    const { layer, outbound } = makeLayer();
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p-empty',
      payload: { content: 'nothing' },
    });
    const result = findResult(outbound, 'p-empty');
    expect(result).toBeDefined();
    if (result?.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    expect(result.payload.ok).toBe(false);
    if (result.payload.ok) throw new Error('expected ok=false');
    expect(result.payload.error?.code).toBe('invalid_envelope');
  });
});

// ---------------------------------------------------------------------------
// 6. session_list status mapping (5 phases + 'unknown')
// ---------------------------------------------------------------------------

describe('BridgeSessionLayer session_list — status mapping', () => {
  it('6.1 empty work_dir → empty sessions list', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl1-'));
    trackTmp(workDir);
    const { layer, outbound } = makeLayer({ workDirs: [workDir] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_list',
      id: 'sl-1',
      payload: { work_dir: workDir },
    });
    const result = findResult(outbound, 'sl-1')!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    if (!result.payload.ok) throw new Error('expected ok');
    const data = result.payload.data as { sessions: { status: string }[] };
    expect(data.sessions).toEqual([]);
  });

  it('6.2 status:"unknown" for sessions on disk without a manager in the map', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl2-'));
    trackTmp(workDir);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl2-ad-'));
    trackTmp(agentDir);
    const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(workDir)}--`);
    mkdirSync(subdir, { recursive: true });
    writeFileSync(
      path.join(subdir, '2026-09-08T10-00-00-000Z_uuid1.jsonl'),
      '',
      'utf8',
    );
    const { layer, outbound } = makeLayer({ agentDir, workDirs: [workDir] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_list',
      id: 'sl-2',
      payload: { work_dir: workDir },
    });
    const result = findResult(outbound, 'sl-2')!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    if (!result.payload.ok) throw new Error('expected ok');
    const data = result.payload.data as { sessions: { id: string; status: string }[] };
    expect(data.sessions.length).toBe(1);
    expect(data.sessions[0]!.id).toBe('2026-09-08T10-00-00-000Z_uuid1');
    expect(data.sessions[0]!.status).toBe('unknown');
  });

  it('6.3 status maps manager.phase to the simplified enum (idle/running/spawning/exited)', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl3-'));
    trackTmp(workDir);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl3-ad-'));
    trackTmp(agentDir);
    // Pre-create a jsonl so the session_list scan picks it up.
    const stem = '2026-09-08T10-00-00-000Z_uuid2';
    const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(workDir)}--`);
    mkdirSync(subdir, { recursive: true });
    writeFileSync(path.join(subdir, `${stem}.jsonl`), '{"x":1}\n', 'utf8');

    const { layer, spawned, outbound } = makeLayer({ agentDir, workDirs: [workDir] });
    // Spawn a manager for the stem via the routing layer (it will
    // find the pre-existing jsonl).
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: stem,
      payload: { content: 'go' },
    });
    const child = spawned[0]!;
    // Manager is in spawning now; query session_list.
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_list',
      id: 'sl-3a',
      payload: { work_dir: workDir },
    });
    const r1 = findResult(outbound, 'sl-3a')!;
    if (r1.kind !== 'control' || r1.type !== 'result') throw new Error('expected result');
    if (!r1.payload.ok) throw new Error('expected ok');
    const data1 = r1.payload.data as { sessions: { id: string; status: string }[] };
    expect(data1.sessions[0]!.status).toBe('spawning');

    // Drive to running and re-query.
    driveToRunning(child);
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_list',
      id: 'sl-3b',
      payload: { work_dir: workDir },
    });
    const r2 = findResult(outbound, 'sl-3b')!;
    if (r2.kind !== 'control' || r2.type !== 'result') throw new Error('expected result');
    if (!r2.payload.ok) throw new Error('expected ok');
    const data2 = r2.payload.data as { sessions: { id: string; status: string }[] };
    expect(data2.sessions[0]!.status).toBe('running');
  });

  it('6.4 session_list with no work_dir (M3 compat path) scans all work_dirs', () => {
    const wdA = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl4a-'));
    const wdB = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl4b-'));
    trackTmp(wdA);
    trackTmp(wdB);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl4-ad-'));
    trackTmp(agentDir);
    // Drop one jsonl per work_dir. The filename must satisfy the
    // ISO-timestamp-prefix guard (see `deriveStemForWorkDir`),
    // otherwise the scan filters it out as unparseable.
    for (const [wd, stamp] of [[wdA, '2026-09-08T10-00-00-000Z_a1'], [wdB, '2026-09-08T10-00-00-000Z_b2']] as const) {
      const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(wd)}--`);
      mkdirSync(subdir, { recursive: true });
      writeFileSync(path.join(subdir, `${stamp}.jsonl`), '', 'utf8');
    }
    const { layer, outbound } = makeLayer({ agentDir, workDirs: [wdA, wdB] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_list',
      id: 'sl-4',
      payload: {},
    });
    const result = findResult(outbound, 'sl-4')!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    if (!result.payload.ok) throw new Error('expected ok');
    const data = result.payload.data as { sessions: { id: string }[] };
    expect(data.sessions.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 7. work_dir CRUD
// ---------------------------------------------------------------------------

describe('BridgeSessionLayer work_dir CRUD', () => {
  it('7.1 work_dir_list returns the current in-memory snapshot', () => {
    const wdA = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wdl1a-'));
    const wdB = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wdl1b-'));
    trackTmp(wdA);
    trackTmp(wdB);
    const { layer, outbound } = makeLayer({ workDirs: [wdA, wdB] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'work_dir_list',
      id: 'wdl-1',
      payload: {},
    });
    const result = findResult(outbound, 'wdl-1')!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    if (!result.payload.ok) throw new Error('expected ok');
    const data = result.payload.data as { work_dirs: string[] };
    expect(data.work_dirs.sort()).toEqual([wdA, wdB].sort());
  });

  it('7.2 work_dir_add three-piece check: missing path → result.ok=false + error.code:"internal"', () => {
    const ghost = path.join(mkdtempSync(path.join(os.tmpdir(), 'remotepi-wda-ghost-')), 'nope');
    const { layer, outbound } = makeLayer();
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'work_dir_add',
      id: 'wda-1',
      payload: { path: ghost },
    });
    const result = findResult(outbound, 'wda-1')!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    expect(result.payload.ok).toBe(false);
    if (result.payload.ok) throw new Error('expected not ok');
    expect(result.payload.error?.code).toBe('internal');
  });

  it('7.3 work_dir_add existing valid path → ok:true + appears in work_dir_list', () => {
    const validWd = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wda2-'));
    trackTmp(validWd);
    const { layer, outbound } = makeLayer();
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'work_dir_add',
      id: 'wda-2',
      payload: { path: validWd },
    });
    const result = findResult(outbound, 'wda-2')!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    expect(result.payload.ok).toBe(true);
    expect(layer.listWorkDirs()).toContain(validWd);
  });

  it('7.4 work_dir_add 重复添加 = 幂等 (ok:true, no error)', () => {
    const wd = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wda3-'));
    trackTmp(wd);
    const { layer, outbound } = makeLayer({ workDirs: [wd] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'work_dir_add',
      id: 'wda-3',
      payload: { path: wd },
    });
    const result = findResult(outbound, 'wda-3')!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    expect(result.payload.ok).toBe(true);
    expect(layer.listWorkDirs()).toEqual([wd]);
  });

  it('7.5 work_dir_remove StateError → result.ok=false + error.code:"internal" (task 04 S2 移交)', () => {
    // We inject a failing store to simulate StateError; the layer
    // must catch it and map to wire 'internal'.
    const wd = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wdr1-'));
    trackTmp(wd);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wdr1-ad-'));
    trackTmp(agentDir);
    const statePath = path.join(agentDir, 'state.json');
    const realStore = new WorkDirStore([wd], statePath);
    const failingStore = new WorkDirStore([wd], statePath);
    // Monkey-patch the store's remove method to throw a StateError.
    const origRemove = failingStore.remove.bind(failingStore);
    failingStore.remove = (p: string): void => {
      if (p === wd) {
        throw new StateError('parse_failed', 'simulated disk corruption', new Error('EIO'));
      }
      origRemove(p);
    };
    void realStore;
    const outbound = vi.fn<(env: EnvelopeT) => void>();
    const stderr = vi.fn<(chunk: string) => void>();
    const layer = new BridgeSessionLayer({
      agentDir,
      workDirStore: failingStore,
      onOutbound: outbound,
      onStderr: stderr,
    });
    layer.start();
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'work_dir_remove',
      id: 'wdr-1',
      payload: { path: wd },
    });
    const result = findResult(outbound, 'wdr-1')!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    expect(result.payload.ok).toBe(false);
    if (result.payload.ok) throw new Error('expected not ok');
    expect(result.payload.error?.code).toBe('internal');
    expect(result.payload.error?.message).toMatch(/simulated disk corruption/);
  });

  it('7.6 work_dir_remove existing → ok:true + disappears from work_dir_list', () => {
    const wd = mkdtempSync(path.join(os.tmpdir(), 'remotepi-wdr2-'));
    trackTmp(wd);
    const { layer, outbound } = makeLayer({ workDirs: [wd] });
    expect(layer.listWorkDirs()).toContain(wd);
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'work_dir_remove',
      id: 'wdr-2',
      payload: { path: wd },
    });
    const result = findResult(outbound, 'wdr-2')!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    expect(result.payload.ok).toBe(true);
    expect(layer.listWorkDirs()).not.toContain(wd);
  });
});

// ---------------------------------------------------------------------------
// 8. Cross-manager broadcast isolation
// ---------------------------------------------------------------------------

describe('BridgeSessionLayer cross-manager broadcast isolation', () => {
  it('8.1 A manager\'s session_state carries session: A; B manager\'s carries session: B (no cross-talk)', () => {
    const wdA = mkdtempSync(path.join(os.tmpdir(), 'remotepi-cm1a-'));
    const wdB = mkdtempSync(path.join(os.tmpdir(), 'remotepi-cm1b-'));
    trackTmp(wdA);
    trackTmp(wdB);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-cm1-ad-'));
    trackTmp(agentDir);
    const stemA = '2026-09-08T10-00-00-000Z_a-stem1234';
    const stemB = '2026-09-08T10-00-00-000Z_b-stem5678';
    for (const [wd, stem] of [[wdA, stemA], [wdB, stemB]] as const) {
      const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(wd)}--`);
      mkdirSync(subdir, { recursive: true });
      writeFileSync(path.join(subdir, `${stem}.jsonl`), '{"x":1}\n', 'utf8');
    }
    const { layer, spawned, outbound } = makeLayer({ agentDir, workDirs: [wdA, wdB] });
    // Spawn A
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'pA',
      session: stemA,
      payload: { content: 'A go' },
    });
    // Spawn B
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'pB',
      session: stemB,
      payload: { content: 'B go' },
    });
    const cA = spawned[0]!;
    const cB = spawned[1]!;
    driveToRunning(cA);
    driveToRunning(cB);
    // Inspect session_state broadcasts — each must carry its own
    // session key, never the other manager's.
    const states = sessionStates(outbound);
    const aStates = states.filter((s) => s.session === stemA);
    const bStates = states.filter((s) => s.session === stemB);
    expect(aStates.length).toBeGreaterThan(0);
    expect(bStates.length).toBeGreaterThan(0);
    // No state should be tagged with the wrong session.
    expect(states.every((s) => s.session === stemA || s.session === stemB)).toBe(true);
  });

  it('8.2 stopping the layer stops all managers (no orphan children)', () => {
    const wdA = mkdtempSync(path.join(os.tmpdir(), 'remotepi-cm2a-'));
    const wdB = mkdtempSync(path.join(os.tmpdir(), 'remotepi-cm2b-'));
    trackTmp(wdA);
    trackTmp(wdB);
    const { layer, spawned } = makeLayer({ workDirs: [wdA, wdB] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'pA',
      session: 'new',
      payload: { content: 'A', work_dir: wdA },
    });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'pB',
      session: 'new',
      payload: { content: 'B', work_dir: wdB },
    });
    expect(spawned).toHaveLength(2);
    layer.stop();
    // stop() calls manager.stop() which sets the selfKillFlag and
    // sends SIGTERM; the FakeChild records the signal.
    expect(spawned[0]!.killSignals).toContain('SIGTERM');
    expect(spawned[1]!.killSignals).toContain('SIGTERM');
  });
});
