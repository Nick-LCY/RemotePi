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
    // W3 (M4 任务 06 review) 钉桩：迁移时的 session_state 恰好一份。
    // 修复前：迁移时 layer 广播 + wrapper 透传 → 网上双份。修复后：
    // wrapper 在 attemptPendingMigration 返回 true 时短路，manager
    // 的 ready session_state 被 drop，只留 layer 的迁移广播。
    const readyMigratedStates = states.filter(
      (s) => s.session === stem && s.work_dir === workDir && s.phase === 'ready',
    );
    expect(readyMigratedStates.length).toBe(1);
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
  it('3.1 running → idle 5min recycle (existing M3 behaviour; running → idle via driveToRunning + agent_settled)', () => {
    // [M4 任务 06 review C1 修复] 名实核对：本测试实际走的是
    // `running → idle` 路径（driveToRunning + agent_settled）——
    // 不是 ready 阶段的 idle 计时。ready 阶段的直接测试在
    // 3.4 / 3.5（注入短 idleTimeoutMs）/ 3.6（写命令清计时器）。
    vi.useFakeTimers();
    try {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-c1-'));
      trackTmp(workDir);
      const { layer, spawned, outbound } = makeLayer({
        workDirs: [workDir],
        idleTimeoutMs: IDLE_TIMEOUT_MS,
      });
      // Drive to running via a prompt. The manager is in spawning
      // after spawnNow, transitions to ready after the handshake,
      // and to running once the queued prompt is flushed. Then we
      // emit agent_settled which transitions to idle and arms the
      // idle timer. The running → idle path is the M3 behaviour;
      // ready → idle (裁定 C) is the new path covered by 3.4 below.
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
      // Manager is in idle; the idle timer is armed.
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

  it('3.4 裁定 C — ready phase 直接 idle 回收: stem-keyed spawn + get_messages leaves manager in ready, IDLE_TIMEOUT_MS triggers exited + map 键清理', () => {
    // [M4 任务 06 review C1 新增] 直接测试 ready 阶段的 idle 回收
    // （裁定 C）—— 预写 jsonl 让 stem 路由命中（钉子 2 Branch 1+2 的
    // “session stem 命中 jsonl” 路径），发读命令（get_messages），
    // handshake 完成后 manager 留在 ready 阶段，5min idle 计时器
    // 自动启动，到点后回收。映射实际场景：“web 回到一个老会话，
    // 只读取消息不写”。
    vi.useFakeTimers();
    try {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-c4-'));
      trackTmp(workDir);
      const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-c4-ad-'));
      trackTmp(agentDir);
      // 预写 jsonl 以触发 stem 路由命中（与 test 5.2 / 6.3 同模式）。
      const stem = '2026-09-08T16-00-00-000Z_c4-readonly';
      const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(workDir)}--`);
      mkdirSync(subdir, { recursive: true });
      writeFileSync(path.join(subdir, `${stem}.jsonl`), '', 'utf8');

      const { layer, spawned, outbound } = makeLayer({
        agentDir,
        workDirs: [workDir],
        idleTimeoutMs: IDLE_TIMEOUT_MS,
      });
      // 发 get_messages，读命令。层路由：session=stem 命中 jsonl → spawn
      // manager with --session。该读命令会在 spawning 阶段被入队，
      // handshake 完成后 flush；flush 后不转 ready → running（读不会）。
      layer.handleEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'get_messages',
        id: 'gm-1',
        session: stem,
        payload: {},
      });
      const child = spawned[0]!;
      // handshake: 写 get_state response。
      child.stdout.write(
        JSON.stringify({ type: 'response', command: 'get_state', success: true }) + '\n',
      );
      const mgr = layer.getManagerForKey(stem)!;
      // 关键断言：ready 阶段（非 running/idle）—— 这正是裁定 C 覆盖的范围。
      expect(mgr.getPhase()).toBe<SessionPhase>('ready');

      // Fast-forward 5min — ready 计时器到期 → killIdleChild → exited。
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS);
      child.simulateExit(null, 'SIGTERM');
      // exited 广播 + map 键清理（钉子 4 / 裁定 C 回收路径）。
      expect(mgr.getPhase()).toBe<SessionPhase>('exited');
      expect(layer.getManagerForKey(stem)).toBeUndefined();
      const states = sessionStates(outbound);
      expect(states.some((s) => s.phase === 'exited')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('3.5 裁定 C — ready 阶段注入短 idleTimeoutMs (3000ms) 的回收变体', () => {
    // [M4 任务 06 review C1 新增] 短 timeout 变体：避免 5min wall-clock，
    // 验证计时器逻辑而非真实 5min。与 3.4 对称（短 idleTimeoutMs 但同样
    // 测 ready → exited + map 键清理）。
    vi.useFakeTimers();
    try {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-c5-'));
      trackTmp(workDir);
      const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-c5-ad-'));
      trackTmp(agentDir);
      const stem = '2026-09-08T16-00-00-000Z_c5-short';
      const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(workDir)}--`);
      mkdirSync(subdir, { recursive: true });
      writeFileSync(path.join(subdir, `${stem}.jsonl`), '', 'utf8');

      const { layer, spawned, outbound } = makeLayer({
        agentDir,
        workDirs: [workDir],
        idleTimeoutMs: 3000,
      });
      layer.handleEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'get_messages',
        id: 'gm-1',
        session: stem,
        payload: {},
      });
      const child = spawned[0]!;
      child.stdout.write(
        JSON.stringify({ type: 'response', command: 'get_state', success: true }) + '\n',
      );
      const mgr = layer.getManagerForKey(stem)!;
      expect(mgr.getPhase()).toBe<SessionPhase>('ready');
      vi.advanceTimersByTime(3000);
      child.simulateExit(null, 'SIGTERM');
      expect(mgr.getPhase()).toBe<SessionPhase>('exited');
      expect(layer.getManagerForKey(stem)).toBeUndefined();
      const states = sessionStates(outbound);
      expect(states.some((s) => s.phase === 'exited')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('3.6 裁定 C — ready 阶段收到写命令 → 计时器重置（不回收），对称于 3.3 的 running → idle → running 路径', () => {
    // [M4 任务 06 review C1 新增] 与 3.3 (running → idle → running) 对称：
    // ready 阶段收到写命令（prompt）→ handleSpawnTrigger 清 idle 计时器
    // （W5 coverall）→ transitionTo('running')，不再走 ready-idle 回收路径。
    vi.useFakeTimers();
    try {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-c6-'));
      trackTmp(workDir);
      const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-c6-ad-'));
      trackTmp(agentDir);
      const stem = '2026-09-08T16-00-00-000Z_c6-write';
      const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(workDir)}--`);
      mkdirSync(subdir, { recursive: true });
      writeFileSync(path.join(subdir, `${stem}.jsonl`), '', 'utf8');

      const { layer, spawned } = makeLayer({
        agentDir,
        workDirs: [workDir],
        idleTimeoutMs: 3000,
      });
      // 先发读命令让 manager 进入 ready 阶段（无写命令 → ready 计时器启动）。
      layer.handleEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'get_messages',
        id: 'gm-1',
        session: stem,
        payload: {},
      });
      const child = spawned[0]!;
      child.stdout.write(
        JSON.stringify({ type: 'response', command: 'get_state', success: true }) + '\n',
      );
      const mgr = layer.getManagerForKey(stem)!;
      expect(mgr.getPhase()).toBe<SessionPhase>('ready');

      // 2s 后（3s 计时器尚未到期）发写命令 —— 应触发 ready → running，
      // 清掉 ready 计时器（handleSpawnTrigger 顶部的 clearIdleTimer coverall）。
      vi.advanceTimersByTime(2000);
      layer.handleEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'prompt',
        id: 'p-w',
        session: stem,
        payload: { content: 'continue' },
      });
      // layer 转发到 manager 的写命令应让 phase 转 running。
      // （manager 在 ready 阶段收到 write 时由 handleSpawnTrigger 转 running，
      // 但这需要 writeCommand 完成；mock manager 同步 writeCommand 因此立刻转。）
      expect(mgr.getPhase()).toBe<SessionPhase>('running');

      // 再过 2s — 如果 ready 计时器没被清，3s 时会触发 ready 回收；
      // 现在应该仍处于 running（写命令清掉了 ready 计时器）。
      vi.advanceTimersByTime(2000);
      expect(mgr.getPhase()).toBe<SessionPhase>('running');
      expect(layer.getManagerForKey(stem)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('3.2 running → idle short idleTimeoutMs (3000ms) variant via driveToRunning + agent_settled', () => {
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
    // We can't manipulate the layer's internal Map from outside, so
    // use the routing layer to "find the file" path: pre-create the
    // jsonl under the expected name, then use stem-keyed envelope.
    // [M4 任务 06 review S16 清理] 删去“seam 渔用”废代码
    // （`sessionDir` 占位 + `layer['managers']` 类型强转换 +
    // `void sessionDir`）——原注释说“appease TS”但实际计算后从未
    // 被使用；下面用 `agentDir` 抽出 + 直接 subdir 路径创建实现。
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

  it('5.3a W5 — same stem in two work_dirs → first-match-wins by workDirStore.list() insertion order (deterministic)', () => {
    // [M4 任务 06 review W5] 钉桩测：同一 stem 放进两个 work_dirs 的
    // session 子目录 → 行为确定性（按 workDirStore.list() 插入序首个
    // 命中）。`encodeCwdForPi` 是有损映射（current-state `cc00a3f`
    // 教训），两个不同 work_dir 可能编码到同一 session 子目录；M4
    // 接受首匹配语义，不扫重复。
    const wdA = mkdtempSync(path.join(os.tmpdir(), 'remotepi-w5-a-'));
    const wdB = mkdtempSync(path.join(os.tmpdir(), 'remotepi-w5-b-'));
    trackTmp(wdA);
    trackTmp(wdB);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-w5-ad-'));
    trackTmp(agentDir);
    const stem = '2026-09-08T16-00-00-000Z_w5-dup';
    // 在两个 work_dir 的 session 子目录下都放同一 stem 的 jsonl。
    for (const wd of [wdA, wdB]) {
      const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(wd)}--`);
      mkdirSync(subdir, { recursive: true });
      writeFileSync(path.join(subdir, `${stem}.jsonl`), '', 'utf8');
    }
    // workDirs 顺序：先 wdA 后 wdB —— 这是 insertKey 顺序。
    const { layer, spawned } = makeLayer({
      agentDir,
      workDirs: [wdA, wdB],
    });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p-w5',
      session: stem,
      payload: { content: 'go' },
    });
    expect(spawned).toHaveLength(1);
    const m = layer.getManagerForKey(stem)!;
    // 首匹配语义：wdA 排在前面，路由到 wdA。
    expect(m.getWorkDir()).toBe(wdA);
  });

  it('5.3b W5 — workDirs 顺序调换（B 在前） → 路由到 B（行为仍确定性）', () => {
    // 对称钉桩：仅交换 workDirStore 插入顺序，首匹配应随之到 B。
    // 这是同一语义的另一面，防未来“修复”不经意打破顺序依赖。
    const wdA = mkdtempSync(path.join(os.tmpdir(), 'remotepi-w5b-a-'));
    const wdB = mkdtempSync(path.join(os.tmpdir(), 'remotepi-w5b-b-'));
    trackTmp(wdA);
    trackTmp(wdB);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-w5b-ad-'));
    trackTmp(agentDir);
    const stem = '2026-09-08T16-00-00-000Z_w5-dup-b';
    for (const wd of [wdA, wdB]) {
      const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(wd)}--`);
      mkdirSync(subdir, { recursive: true });
      writeFileSync(path.join(subdir, `${stem}.jsonl`), '', 'utf8');
    }
    const { layer, spawned } = makeLayer({
      agentDir,
      workDirs: [wdB, wdA], // B 在前
    });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p-w5b',
      session: stem,
      payload: { content: 'go' },
    });
    expect(spawned).toHaveLength(1);
    const m = layer.getManagerForKey(stem)!;
    expect(m.getWorkDir()).toBe(wdB);
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

  it('6.5 real-shape jsonl: message_count + first_message populated by readSessionSummary', () => {
    // [M4 验收期缺口修复 — task brief] bridge session_list
    // 6.x 既有断言只钉死 id/status，未钉三字段。本任务修复后，
    // 真实 pi jsonl 内容应让 message_count / first_message 真
    // 解析：首条 user message 文本 + 全部 message 条目数（含
    // user/assistant/toolResult）。name 维持 null（pi jsonl 无
    // name 字段）。
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl5-'));
    trackTmp(workDir);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl5-ad-'));
    trackTmp(agentDir);
    const stem = '2026-09-08T10-00-00-000Z_sl5-real';
    const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(workDir)}--`);
    mkdirSync(subdir, { recursive: true });
    // 写一个与真实 fixture 同形状的 jsonl：session + model +
    // thinking + 5 条 message（user/assistant/assistant toolCall/
    // toolResult/再 user）。
    writeFileSync(
      path.join(subdir, `${stem}.jsonl`),
      [
        '{"type":"session","version":3,"id":"x","cwd":"/work"}',
        '{"type":"model_change","id":"m","provider":"anthropic","modelId":"claude"}',
        '{"type":"thinking_level_change","id":"t","thinkingLevel":"off"}',
        '{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"hello-from-test"}]}}',
        '{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"reply"}]}}',
        '{"type":"message","id":"a2","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"x","arguments":{}}]}}',
        '{"type":"message","id":"tr1","message":{"role":"toolResult","toolCallId":"t1","content":[{"type":"text","text":"done"}]}}',
        '{"type":"message","id":"u2","message":{"role":"user","content":[{"type":"text","text":"next"}]}}',
      ].join('\n') + '\n',
      'utf8',
    );

    const { layer, outbound } = makeLayer({ agentDir, workDirs: [workDir] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_list',
      id: 'sl-5',
      payload: { work_dir: workDir },
    });
    const result = findResult(outbound, 'sl-5')!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    if (!result.payload.ok) throw new Error('expected ok');
    const data = result.payload.data as {
      sessions: {
        id: string;
        name: string | null;
        message_count: number;
        first_message: string | null;
        status: string;
      }[];
    };
    expect(data.sessions.length).toBe(1);
    const row = data.sessions[0]!;
    expect(row.id).toBe(stem);
    expect(row.name).toBeNull(); // pi jsonl 无 name 字段
    expect(row.status).toBe('unknown');
    expect(row.message_count).toBe(5); // 5 条 type:"message"（user + assistant + assistant toolCall + toolResult + 再 user）
    expect(row.first_message).toBe('hello-from-test');
  });

  it('6.6 jsonl with assistant-only (no user message) → message_count 精确 + first_message null (语义: 首条 user 消息)', () => {
    // 钉桩 6.5 的对称：没 user 消息时 first_message = null。
    // PRD §4.2 设计意图是让用户认出会话，语义 = 首条 user 消息。
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl6-'));
    trackTmp(workDir);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl6-ad-'));
    trackTmp(agentDir);
    const stem = '2026-09-08T10-00-00-000Z_sl6-assist';
    const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(workDir)}--`);
    mkdirSync(subdir, { recursive: true });
    writeFileSync(
      path.join(subdir, `${stem}.jsonl`),
      [
        '{"type":"session","version":3,"id":"x","cwd":"/work"}',
        '{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"only-assistant"}]}}',
        '{"type":"message","id":"tr1","message":{"role":"toolResult","content":[{"type":"text","text":"ok"}]}}',
      ].join('\n') + '\n',
      'utf8',
    );
    const { layer, outbound } = makeLayer({ agentDir, workDirs: [workDir] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_list',
      id: 'sl-6',
      payload: { work_dir: workDir },
    });
    const result = findResult(outbound, 'sl-6')!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    if (!result.payload.ok) throw new Error('expected ok');
    const data = result.payload.data as {
      sessions: { message_count: number; first_message: string | null }[];
    };
    expect(data.sessions[0]!.message_count).toBe(2);
    expect(data.sessions[0]!.first_message).toBeNull();
  });

  it('6.7 unreadable / empty jsonl → message_count 0 + first_message null (graceful degradation per-file)', () => {
    // 钉桩: 一条会话的 jsonl 不可读（这里是空文件）→ 该 row 的
    // message_count=0 + first_message=null，但不抛、不影响其他 row。
    // 这是 readSessionSummary 的容忍语义钉桩：session_list 不
    // 因单个坏文件失败。
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl7-'));
    trackTmp(workDir);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-sl7-ad-'));
    trackTmp(agentDir);
    const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(workDir)}--`);
    mkdirSync(subdir, { recursive: true });
    // 空文件 (size=0)
    writeFileSync(path.join(subdir, '2026-09-08T10-00-00-000Z_sl7-empty.jsonl'), '', 'utf8');
    // 正常 jsonl
    const goodStem = '2026-09-08T10-00-00-000Z_sl7-good';
    writeFileSync(
      path.join(subdir, `${goodStem}.jsonl`),
      [
        '{"type":"session","version":3,"id":"y"}',
        '{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"real-user"}]}}',
      ].join('\n') + '\n',
      'utf8',
    );

    const { layer, outbound } = makeLayer({ agentDir, workDirs: [workDir] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_list',
      id: 'sl-7',
      payload: { work_dir: workDir },
    });
    const result = findResult(outbound, 'sl-7')!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('expected result');
    if (!result.payload.ok) throw new Error('expected ok');
    const data = result.payload.data as {
      sessions: { id: string; message_count: number; first_message: string | null }[];
    };
    expect(data.sessions.length).toBe(2);
    const byId = new Map(data.sessions.map((s) => [s.id, s]));
    expect(byId.get('2026-09-08T10-00-00-000Z_sl7-empty')!.message_count).toBe(0);
    expect(byId.get('2026-09-08T10-00-00-000Z_sl7-empty')!.first_message).toBeNull();
    expect(byId.get(goodStem)!.message_count).toBe(1);
    expect(byId.get(goodStem)!.first_message).toBe('real-user');
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

// ---------------------------------------------------------------------------
// 9. W4 (M4 任务 06 review) — wrapper 不向非 session_state 信封注入 session
// ---------------------------------------------------------------------------

describe('BridgeSessionLayer W4 — wrapper 不注入 session 到非 session_state 信封', () => {
  // [M4 任务 06 review W4] 钉桩测：原层 wrap 设计明确
  // “session 注入只发生于 session_state 帧”，其他信封透传——这是
  // per-session 路由语义的依赖（web 依赖 session_state 作为第一个
  // “该 session 是谁” 镖点，后续事件走 reply_to 或 pi 自带 session
  // 字段）。任何“忠惢改进”——例如给事件信封也注入 session——都会
  // 破坏 M4 web 多会话路由语义。补 2 条钉桩测保护这个不变量。

  it('9.1 多事件场景：两个 session_state 之间夹 message_update/command_result — 事件透传无 session 字段注入', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-w4-1-'));
    trackTmp(workDir);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-w4-1-ad-'));
    trackTmp(agentDir);
    const stem = '2026-09-08T16-00-00-000Z_w4-1';
    const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(workDir)}--`);
    mkdirSync(subdir, { recursive: true });
    writeFileSync(path.join(subdir, `${stem}.jsonl`), '', 'utf8');

    const { layer, spawned, outbound } = makeLayer({ agentDir, workDirs: [workDir] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: stem,
      payload: { content: 'go' },
    });
    const child = spawned[0]!;
    driveToReady(child);

    // 之后手动推送一些非 session_state 帧
    child.stdout.write(JSON.stringify({ type: 'message_update', content: 'hello' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'message_end' }) + '\n');
    child.stdout.write(
      JSON.stringify({ type: 'response', command: 'prompt', id: 'p1', success: true }) + '\n',
    );

    const events = outbound.mock.calls.map((c) => c[0]);
    // session_state 帧必须带 session: stem（wrapper 注入）
    const sessionStates = events.filter(
      (e) => e.kind === 'control' && e.type === 'session_state',
    );
    expect(sessionStates.length).toBeGreaterThan(0);
    for (const s of sessionStates) {
      expect(s.session).toBe(stem);
    }
    // 非 session_state 帧（message_update/message_end/agent_start/command_result/...）
    // 透传 — 不带 session 字段（wrapper 不注入）。
    const nonSessionStateEvents = events.filter(
      (e) => !(e.kind === 'control' && e.type === 'session_state'),
    );
    expect(nonSessionStateEvents.length).toBeGreaterThan(0);
    for (const e of nonSessionStateEvents) {
      // pi 0.85.1 原始事件本就不带 session 字段。如果以后该层包装
      // “好心” 给事件也加 session，下面断言会捕提回归。
      expect(e.session).toBeUndefined();
    }
  });

  it('9.2 wrapper 对非 session_state 信封不注入 session 的回归断言（防未来“好心改进”）', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-w4-2-'));
    trackTmp(workDir);
    const agentDir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-w4-2-ad-'));
    trackTmp(agentDir);
    const stem = '2026-09-08T16-00-00-000Z_w4-2';
    const subdir = path.join(agentDir, 'sessions', `--${encodeCwdForPi(workDir)}--`);
    mkdirSync(subdir, { recursive: true });
    writeFileSync(path.join(subdir, `${stem}.jsonl`), '', 'utf8');

    const { layer, spawned, outbound } = makeLayer({ agentDir, workDirs: [workDir] });
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'p1',
      session: stem,
      payload: { content: 'go' },
    });
    const child = spawned[0]!;
    driveToReady(child);

    // 推送几帧非 session_state 事件：agent_start/message_update/command_result。
    child.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'message_update', delta: 'a' }) + '\n');
    child.stdout.write(
      JSON.stringify({ type: 'response', command: 'prompt', id: 'p1', success: true }) + '\n',
    );

    // 逐帧断言：每条非 session_state 出站都不携带 session 字段。
    const out = outbound.mock.calls.map((c) => c[0]);
    const nonSessionState = out.filter(
      (e) => !(e.kind === 'control' && e.type === 'session_state'),
    );
    // 有 agent_start / message_update / command_result 三条事件
    expect(nonSessionState.length).toBeGreaterThanOrEqual(3);
    for (const e of nonSessionState) {
      // session 字段必须为 undefined；不是 undefined 也不算错
      // （8a.1 路由示例中可能有些是带 session 的），但本测试场景下
      // wrapper 不会注入；现状下都是 undefined。
      expect(e.session).toBeUndefined();
    }
  });
});
