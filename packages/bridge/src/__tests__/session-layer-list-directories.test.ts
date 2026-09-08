// Vitest specs for the migrated `list_directories` dispatcher in
// `BridgeSessionLayer` — M4 task 06 moved the handler from
// `PiProcessManager.handleEnvelope` (where it lived as a temporary
// host per task 05) to `BridgeSessionLayer.handleEnvelope` (where it
// belongs semantically — it's a pure fs operation with no pi
// subprocess dependency).
//
// These tests are the direct continuation of the M4 task 05 15a-15e
// set; the dispatcher contract is unchanged (PRD §2.5 / ADR-0010
// §决策.4). The pure-function tests (cases 1-14) live in
// `__tests__/list-directories.test.ts` and are not duplicated here.
//
// Style mirrors the existing `pi-process.test.ts` FakeChild pattern;
// the fake manager factory lets us drive the layer's outbound without
// spawning a real pi subprocess.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  PROTOCOL_VERSION,
  type Envelope as EnvelopeT,
} from '@remotepi/shared';
import { logger } from '../logger.js';
import { PiProcessManager } from '../pi-process.js';
import { BridgeSessionLayer } from '../session-layer.js';
import { WorkDirStore } from '../state.js';

// ---------------------------------------------------------------------------
// FakeChild — minimal PiProcessManager stand-in
// ---------------------------------------------------------------------------

/** FakeChild — enough surface to satisfy the manager's spawn factory.
 *  We don't exercise PiProcessManager's child surface here directly;
 *  instead we hand a real PiProcessManager a fake spawn factory so
 *  every stdin/stdout/exit interaction is observable. */
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

/** Build a fresh BridgeSessionLayer with a fake-spawn manager factory.
 *  Returns the layer, the spawned FakeChildren (in spawn order), the
 *  outbound spy, the stderr spy, and the agentDir so tests can write
 *  to the sessions tree (needed for the pending → stem migration
 *  paths). */
function makeLayer(opts: {
  agentDir?: string;
  workDirs?: string[];
  statePath?: string;
  idleTimeoutMs?: number;
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
  const layer = new BridgeSessionLayer({
    agentDir,
    workDirStore,
    onOutbound: outbound,
    onStderr: stderr,
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
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
  });
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

// ---------------------------------------------------------------------------
// 15. dispatcher wiring in BridgeSessionLayer (migrated from pi-process.ts)
// ---------------------------------------------------------------------------

describe('BridgeSessionLayer.list_directories dispatcher (M4 task 06 migration)', () => {
  it('15a. successful request emits result{ok:true, data} with reply_to=requestId', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'remotepi-ld-a-'));
    trackTmp(tmp);
    const { layer, outbound } = makeLayer();
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'list_directories',
      id: 'ld-req-1',
      payload: { path: tmp },
    });
    const resultEnvs = outbound.mock.calls
      .map((c) => c[0])
      .filter(
        (e): e is EnvelopeT =>
          e.kind === 'control' && e.type === 'result' && e.reply_to === 'ld-req-1',
      );
    expect(resultEnvs.length).toBe(1);
    const result = resultEnvs[0]!;
    expect(result.kind).toBe('control');
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('unreachable');
    const payload = result.payload;
    if (!payload.ok) throw new Error('expected ok');
    const data = payload.data as { entries: { name: string; path: string }[] };
    // The empty tmp has no subdirectories; entries should be empty.
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it('15b. ENOENT request emits result{ok:false, error.code:"invalid_envelope"}', () => {
    const { layer, outbound } = makeLayer();
    const ghost = path.join(mkdtempSync(path.join(os.tmpdir(), 'remotepi-ld-ghost-')), 'never-existed');
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'list_directories',
      id: 'ld-req-2',
      payload: { path: ghost },
    });
    const resultEnvs = outbound.mock.calls
      .map((c) => c[0])
      .filter(
        (e): e is EnvelopeT =>
          e.kind === 'control' && e.type === 'result' && e.reply_to === 'ld-req-2',
      );
    expect(resultEnvs.length).toBe(1);
    const result = resultEnvs[0]!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('unreachable');
    expect(result.payload.ok).toBe(false);
    if (result.payload.ok) throw new Error('expected not ok');
    expect(result.payload.error?.code).toBe('invalid_envelope');
    expect(result.payload.error?.message).toMatch(/does not exist/);
    expect(result.payload.error?.message).toContain(ghost);
  });

  it('15c. list_directories does NOT trigger a spawn (pure fs, no pi involvement)', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'remotepi-ld-c-'));
    trackTmp(tmp);
    const { layer, spawned } = makeLayer();
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'list_directories',
      id: 'ld-req-3',
      payload: { path: tmp },
    });
    expect(spawned).toHaveLength(0);
    // Map should still be empty — list_directories doesn't create a manager.
    expect(layer.getManagerCount()).toBe(0);
  });

  it('15d. list_directories with no path uses $HOME (HOME fixture check)', () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'remotepi-ld-home-'));
    trackTmp(fakeHome);
    const originalHome = process.env['HOME'];
    process.env['HOME'] = fakeHome;
    try {
      const { layer, outbound } = makeLayer();
      layer.handleEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'list_directories',
        id: 'ld-req-4',
        payload: {}, // no path
      });
      const resultEnvs = outbound.mock.calls
        .map((c) => c[0])
        .filter(
          (e): e is EnvelopeT =>
            e.kind === 'control' && e.type === 'result' && e.reply_to === 'ld-req-4',
        );
      expect(resultEnvs.length).toBe(1);
      const result = resultEnvs[0]!;
      if (result.kind !== 'control' || result.type !== 'result') throw new Error('unreachable');
      expect(result.payload.ok).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    }
  });

  it('15e. list_directories passes through `session` envelope field unchanged on reply', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'remotepi-ld-e-'));
    trackTmp(tmp);
    const { layer, outbound } = makeLayer();
    layer.handleEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'list_directories',
      id: 'ld-req-5',
      session: 'sess-abc-123',
      payload: { path: tmp },
    });
    const resultEnvs = outbound.mock.calls
      .map((c) => c[0])
      .filter(
        (e): e is EnvelopeT =>
          e.kind === 'control' && e.type === 'result' && e.reply_to === 'ld-req-5',
      );
    expect(resultEnvs.length).toBe(1);
    const result = resultEnvs[0]!;
    if (result.kind !== 'control' || result.type !== 'result') throw new Error('unreachable');
    expect(result.session).toBe('sess-abc-123');
    expect(result.reply_to).toBe('ld-req-5');
  });
});
