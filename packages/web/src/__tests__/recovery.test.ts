// Vitest specs for the web recovery ceremony (`recovery.ts`) —
// covers M3 task 07 + M4 task 01 5s 修复 (PRD §6 / tasks/m4/01
// B+C 合体方案).
//
// Strategy: build a `FakeWsClient` that satisfies the ceremony's
// surface (send / registerReplyResolver / on / bridgeStatus /
// sessionPhase) without opening a real socket. Tests drive the
// ceremony by:
//   - reading `fake.sentFrames` to assert the wire shape,
//   - calling `fake.simulateEnvelope(envelope)` to fire registered
//     listeners (type listeners + reply resolvers fan out from one
//     helper to mirror WsClient.handleMessage's dispatch path),
//   - toggling `fake.bridgeStatus` / `fake.sessionPhase` to
//     simulate inbound session_state / bridge_status broadcasts.
//
// Style mirrors `client.test.ts` (numbered cases + spelled-out
// assertions) and `pi-process.test.ts` (fake seams replacing real
// collaborators) so reviewers can navigate by section heading.

import {
  PROTOCOL_VERSION,
  type BlockedOnEntryPayload,
  type Envelope,
  type SessionPhase,
} from '@remotepi/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PHASE_PROGRESS_TIMEOUT_MS,
  RECOVERY_TIMEOUT_MS,
  initiateRecovery,
  subscribeToBridgeStatus,
  subscribeToSessionState,
  type RecoveryError,
  type RecoveryGate,
  type RecoveryState,
} from '../ws/recovery.js';
import type {
  BridgeStatusInfo,
  EnvelopeHandler,
  ReplyResolver,
} from '../ws/WsClient.js';

// ---------------------------------------------------------------------------
// FakeWsClient — minimal WsClient-shaped test double
// ---------------------------------------------------------------------------

/** Captures every call the ceremony makes against the WsClient
 *  surface it actually uses (`send` / `registerReplyResolver` /
 *  `on`). Tracks `bridgeStatus` / `sessionPhase` as plain fields
 *  that the ceremony reads via the `bridgeStatus` / `sessionPhase`
 *  getters. `simulateEnvelope` mirrors WsClient's inbound dispatch
 *  path — type listeners fire first, then reply resolvers fan out
 *  via `dispatchReplyResolvers` semantics (one-shot delete on
 *  match). */
class FakeWsClient {
  bridgeStatus: BridgeStatusInfo | null = null;
  sessionPhase: SessionPhase | null = null;

  /** All envelopes passed through `send()`. The ceremony uses
   *  this to assert the wire shape (get_messages / get_state
   *  parallel send). */
  readonly sentFrames: Envelope[] = [];

  /** Active type-scoped listeners keyed by envelope type. Mirrors
   *  WsClient's `typeListeners` map. */
  private readonly typeListeners = new Map<string, Set<EnvelopeHandler>>();
  /** Active reply resolvers keyed by outbound envelope id. Mirrors
   *  WsClient's `replyResolvers` map. One-shot semantics match the
   *  real client (auto-removed on first match). */
  private readonly replyResolvers = new Map<string, Set<ReplyResolver>>();

  send(envelope: Envelope): void {
    this.sentFrames.push(envelope);
  }

  on(type: string, handler: EnvelopeHandler): () => void {
    let set = this.typeListeners.get(type);
    if (!set) {
      set = new Set();
      this.typeListeners.set(type, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  registerReplyResolver(replyToId: string, resolver: ReplyResolver): () => void {
    let set = this.replyResolvers.get(replyToId);
    if (!set) {
      set = new Set();
      this.replyResolvers.set(replyToId, set);
    }
    set.add(resolver);
    return () => {
      const current = this.replyResolvers.get(replyToId);
      if (current === undefined) return;
      current.delete(resolver);
      if (current.size === 0) {
        this.replyResolvers.delete(replyToId);
      }
    };
  }

  /** Test seam — number of active type-scoped listeners for `type`.
   *  Used by the StrictMode / retry leak assertions to verify the
   *  ceremony registers exactly ONE listener per type and tears it
   *  down on cancellation. Mirrors the shape of `WsClient`'s
   *  internal `typeListeners` map (which is `private`). */
  listenerCount(type: string): number {
    return this.typeListeners.get(type)?.size ?? 0;
  }

  /** Test seam — number of pending reply resolvers (snapshot +
   *  state, two total per active ceremony). Used to verify both
   *  reply resolvers are unregistered on cancellation. */
  pendingReplyResolverCount(): number {
    return this.replyResolvers.size;
  }

  /** Simulate WsClient.handleMessage dispatch path: type listeners
   *  fire first, then reply resolvers fan out (one-shot semantics
   *  — entry removed on match, matches WsClient's
   *  `dispatchReplyResolvers`). */
  simulateEnvelope(envelope: Envelope): void {
    const typeSet = this.typeListeners.get(envelope.type);
    if (typeSet) {
      // Snapshot so a listener that unsubscribes during dispatch
      // doesn't shift the iteration.
      for (const handler of Array.from(typeSet)) {
        handler(envelope);
      }
    }
    const replyTo = envelope.reply_to;
    if (replyTo !== undefined && replyTo.length > 0) {
      const resolverSet = this.replyResolvers.get(replyTo);
      if (resolverSet !== undefined) {
        this.replyResolvers.delete(replyTo);
        for (const resolver of Array.from(resolverSet)) {
          resolver(envelope);
        }
      }
    }
  }

  /** Convenience: stamp a fresh bridgeStatus + fire `bridge_status`
   *  listeners (mirrors WsClient's `setBridgeStatus` + central
   *  `case 'bridge_status'` dispatch). */
  setBridgeStatus(info: BridgeStatusInfo): void {
    this.bridgeStatus = info;
    this.simulateEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'bridge_status',
      id: 'b-' + Math.random().toString(36).slice(2, 10),
      payload: {
        online: info.online,
        changed_at: info.changedAt,
        reason: info.reason,
      },
    });
  }

  /** Convenience: stamp a fresh sessionPhase + fire `session_state`
   *  listeners (mirrors WsClient's `setSessionPhase` + central
   *  `case 'session_state'` dispatch). blocked_on omitted (the
   *  ceremony doesn't read it; we only test the phase field
   *  change tracking). */
  setSessionPhase(phase: SessionPhase, blockedOn?: BlockedOnEntryPayload[]): void {
    this.sessionPhase = phase;
    const payload: { phase: SessionPhase; blocked_on?: BlockedOnEntryPayload[] } = { phase };
    if (blockedOn !== undefined) {
      payload.blocked_on = blockedOn;
    }
    this.simulateEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'session_state',
      id: 's-' + Math.random().toString(36).slice(2, 10),
      payload,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a `pi/snapshot` reply envelope targeting `replyTo`. Mirrors
 *  the bridge's snapshot reply shape — a few message entries
 *  irrelevant to the ceremony; the ceremony only inspects the
 *  kind/type to mark `snapshotOutcome = 'ok'`. */
function snapshotReply(replyTo: string, messageCount = 0): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: 'pi',
    type: 'snapshot',
    id: 'snap-' + Math.random().toString(36).slice(2, 10),
    reply_to: replyTo,
    payload: {
      messages: new Array(messageCount).fill({ role: 'user', content: 'x' }),
    },
  };
}

/** Build a `control/result` reply carrying a get_state payload —
 *  the ceremony uses `tryDecodeGetStateData` to verify the shape
 *  before marking `stateOutcome = 'ok'`. */
function stateReply(replyTo: string, phase: SessionPhase): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: 'control',
    type: 'result',
    id: 'res-' + Math.random().toString(36).slice(2, 10),
    reply_to: replyTo,
    payload: {
      ok: true,
      data: { phase },
    },
  };
}

/** Read the ids the ceremony issued for the parallel queries so
 *  tests can match the `reply_to` field on simulated replies.
 *  Defaults to the LATEST pair (most recent `retry()` call) — tests
 *  that care about an earlier ceremony can pass `{ fromIndex: 0 }`
 *  to slice from a specific offset. */
function ceremonyIds(
  fake: FakeWsClient,
  opts: { fromIndex?: number } = {},
): { messagesId: string; stateId: string } {
  const start = opts.fromIndex ?? 0;
  const messagesFrame = fake.sentFrames
    .slice(start)
    .reverse()
    .find((e) => e.kind === 'pi' && e.type === 'get_messages');
  const stateFrame = fake.sentFrames
    .slice(start)
    .reverse()
    .find((e) => e.kind === 'control' && e.type === 'get_state');
  if (!messagesFrame || !stateFrame) {
    throw new Error('expected ceremony to send both get_messages + get_state on retry()');
  }
  return { messagesId: messagesFrame.id, stateId: stateFrame.id };
}

/** Pull the gate's latest snapshot via `getSnapshot()`. */
function snapshot(gate: RecoveryGate): RecoveryState {
  return gate.getSnapshot();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recovery — M3 baseline (PRD §4.4 dual-query ceremony)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('1.1 fresh ceremony sends parallel get_messages + get_state', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0]);
    gate.retry();

    expect(fake.sentFrames).toHaveLength(2);
    const kinds = fake.sentFrames.map((e) => `${e.kind}/${e.type}`).sort();
    expect(kinds).toEqual(['control/get_state', 'pi/get_messages']);
    expect(snapshot(gate)).toEqual({ ready: false, error: null });
  });

  it('1.2 both replies arrive → ready', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0]);
    gate.retry();
    const { messagesId, stateId } = ceremonyIds(fake);

    fake.simulateEnvelope(snapshotReply(messagesId));
    // First reply alone should NOT flip to ready (ceremony waits
    // for both — guards against the tearing window where the
    // chat would mount with one half populated).
    expect(snapshot(gate).ready).toBe(false);

    fake.simulateEnvelope(stateReply(stateId, 'ready'));
    expect(snapshot(gate)).toEqual({ ready: true, error: null });
  });

  it('1.3 snapshot reply missing → snapshot_failed', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0], {
      timeoutMs: 1_000,
    });
    gate.retry();
    const { stateId } = ceremonyIds(fake);
    fake.simulateEnvelope(stateReply(stateId, 'ready'));

    // 1s elapses — snapshot timer fires → snapshot failed.
    vi.advanceTimersByTime(1_000);

    expect(snapshot(gate)).toEqual({ ready: false, error: 'snapshot_failed' });
  });

  it('1.4 state reply missing → state_failed', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0], {
      timeoutMs: 1_000,
    });
    gate.retry();
    const { messagesId } = ceremonyIds(fake);
    fake.simulateEnvelope(snapshotReply(messagesId));

    vi.advanceTimersByTime(1_000);

    expect(snapshot(gate)).toEqual({ ready: false, error: 'state_failed' });
  });

  it('1.5 both replies missing → both_failed', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0], {
      timeoutMs: 1_000,
    });
    gate.retry();

    vi.advanceTimersByTime(1_000);

    expect(snapshot(gate)).toEqual({ ready: false, error: 'both_failed' });
  });

  it('1.6 retry() cancels the in-flight ceremony — no listener leak, no zombie timer', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0], {
      timeoutMs: 1_000,
    });
    gate.retry();
    const first = ceremonyIds(fake);

    // Simulate a stale reply that lands AFTER retry — must be ignored.
    fake.simulateEnvelope(snapshotReply(first.messagesId));
    expect(snapshot(gate).ready).toBe(false);

    gate.retry();
    // 1s elapses on the OLD timers but the ceremony is cancelled —
    // the new ceremony is what owns the deadline. Sanity check:
    // the new ceremony must still be in-flight.
    const second = ceremonyIds(fake);
    expect(second.messagesId).not.toBe(first.messagesId);
    expect(snapshot(gate)).toEqual({ ready: false, error: null });

    // Drive the new ceremony to success.
    fake.simulateEnvelope(snapshotReply(second.messagesId));
    fake.simulateEnvelope(stateReply(second.stateId, 'idle'));
    expect(snapshot(gate)).toEqual({ ready: true, error: null });

    // 1s after the retry, the stale timers (now owned by a stale
    // ceremony) must not transition the gate.
    vi.advanceTimersByTime(2_000);
    expect(snapshot(gate)).toEqual({ ready: true, error: null });
  });
});

// ---------------------------------------------------------------------------
// M4 §6.3 — B+C 合体方案测试
// ---------------------------------------------------------------------------

describe('recovery — M4 §6.3 C 方案 (snapshot 腿无进度超时)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('2.1 phase change in 5s resets snapshot timer to 15s window', () => {
    const fake = new FakeWsClient();
    // Pin both constants so the test runs in a deterministic timeline
    // regardless of the production values.
    const TIMEOUT_MS = 5_000;
    const PHASE_MS = 15_000;
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0], {
      timeoutMs: TIMEOUT_MS,
      phaseProgressTimeoutMs: PHASE_MS,
    });
    gate.retry();
    const { messagesId, stateId } = ceremonyIds(fake);

    // Send the state reply BEFORE the 5s state timer fires — we
    // want to isolate the snapshot side, so state must be 'ok'
    // throughout. (state timer is not affected by phase changes.)
    fake.simulateEnvelope(stateReply(stateId, 'running'));

    // 4s elapses without progress — still in-flight (snapshot timer
    // would fire at 5s but we're at 4s).
    vi.advanceTimersByTime(4_000);
    expect(snapshot(gate)).toEqual({ ready: false, error: null });

    // SessionState arrives with a NEW phase (null → 'spawning') —
    // snapshot timer must reset to 15s from THIS moment (so the
    // ceremony still has 15s after the phase change to receive
    // snapshot).
    fake.setSessionPhase('spawning');
    vi.advanceTimersByTime(4_000); // 4s after the phase change (8s total)
    // Snapshot timer hasn't fired yet — must still be in-flight.
    expect(snapshot(gate)).toEqual({ ready: false, error: null });

    // 11s after the phase change (15s timer + a bit) — snapshot
    // timer fires → snapshot failed.
    vi.advanceTimersByTime(11_001);
    fake.simulateEnvelope(snapshotReply(messagesId)); // late, doesn't help
    // Snapshot timer fired at 15s (no progress) → snapshot failed;
    // state was already 'ok' from the early reply.
    expect(snapshot(gate)).toEqual({ ready: false, error: 'snapshot_failed' });
  });

  it('2.2 no phase change within 5s → snapshot_failed (M4 baseline fallback)', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0], {
      timeoutMs: 5_000,
      phaseProgressTimeoutMs: 15_000,
    });
    gate.retry();
    const { stateId } = ceremonyIds(fake);

    // Send the state reply BEFORE the 5s state timer fires — we
    // want to isolate the snapshot side. stateOutcome = 'ok'
    // from t=0 onwards.
    fake.simulateEnvelope(stateReply(stateId, 'ready'));
    vi.advanceTimersByTime(5_000); // 5s without any phase change
    fake.simulateEnvelope(snapshotReply('m1')); // snapshot is already late
    // snapshot timer fired at 5s (no phase change) → snapshot failed.
    expect(snapshot(gate)).toEqual({ ready: false, error: 'snapshot_failed' });
  });

  it('2.3 blocked_on-only broadcast (same phase) does NOT reset snapshot timer', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0], {
      timeoutMs: 5_000,
      phaseProgressTimeoutMs: 15_000,
    });
    gate.retry();
    const { messagesId, stateId } = ceremonyIds(fake);

    // Send the state reply BEFORE the 5s state timer fires — we
    // want to isolate the snapshot side, so state must be 'ok'.
    fake.simulateEnvelope(stateReply(stateId, 'ready'));

    // First phase change — snapshot timer resets to 15s from now.
    fake.setSessionPhase('spawning');

    // A session_state broadcast with the SAME phase but different
    // blocked_on — must NOT reset the snapshot timer. The ceremony
    // only inspects payload.phase; shallow equality rejects
    // no-change frames.
    fake.setSessionPhase('spawning', [
      { method: 'select', id: 'r1', title: 'test', options: [] },
    ]);

    // Advance 15s — if the blocked_on broadcast incorrectly reset
    // the timer, the snapshot would NOT have fired (would be at
    // ~15s reset point). If the broadcast correctly did NOT reset,
    // the snapshot timer fires here at 15s since the FIRST phase
    // change.
    vi.advanceTimersByTime(15_000);
    fake.simulateEnvelope(snapshotReply(messagesId)); // late, doesn't help
    // Snapshot timer fired at 15s (no progress) → snapshot failed;
    // state was already 'ok' from the early reply.
    expect(snapshot(gate)).toEqual({ ready: false, error: 'snapshot_failed' });
  });

  it('2.4 multiple sequential phase changes — each one resets the snapshot timer', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0], {
      timeoutMs: 5_000,
      phaseProgressTimeoutMs: 15_000,
    });
    gate.retry();
    const { messagesId, stateId } = ceremonyIds(fake);

    // Send the state reply BEFORE the 5s state timer fires (so
    // state is 'ok' throughout — we only want to test the
    // snapshot timer reset semantics).
    fake.simulateEnvelope(stateReply(stateId, 'running'));

    // Phase 1: spawning (at t=0).
    fake.setSessionPhase('spawning');
    vi.advanceTimersByTime(14_000); // 14s after first phase change

    // Phase 2: ready (at t=14s) — snapshot timer resets.
    fake.setSessionPhase('ready');
    vi.advanceTimersByTime(14_000); // 14s after second phase change (28s total)

    // Phase 3: running (at t=28s) — snapshot timer resets AGAIN.
    fake.setSessionPhase('running');
    vi.advanceTimersByTime(10_000); // 10s after third phase change (38s total)

    // Snapshot finally arrives (well within the 15s window since
    // the third phase change).
    fake.simulateEnvelope(snapshotReply(messagesId));
    expect(snapshot(gate)).toEqual({ ready: true, error: null });
  });

  it('2.5 production constants reflect M4 spec (5_000 baseline + 15_000 with-progress)', () => {
    expect(RECOVERY_TIMEOUT_MS).toBe(5_000);
    expect(PHASE_PROGRESS_TIMEOUT_MS).toBe(15_000);
  });
});

describe('recovery — M4 §6.3 B 方案 (bridgeStatus 离线秒失败)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('3.1 bridgeStatus.online=false during ceremony → immediate bridge_offline', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0], {
      timeoutMs: 5_000,
      phaseProgressTimeoutMs: 15_000,
    });
    gate.retry();
    const { messagesId, stateId } = ceremonyIds(fake);

    // bridge_status arrives BEFORE both replies — ceremony is
    // still active (not cancelled). The bridge_offline path must
    // short-circuit regardless of the still-pending snapshot /
    // state replies.
    fake.setBridgeStatus({
      online: false,
      changedAt: '2026-09-08T10:00:00.000Z',
      reason: 'closed',
      receivedAt: Date.now(),
    });

    // Late replies — already too late (ceremony was cancelled).
    fake.simulateEnvelope(snapshotReply(messagesId));
    fake.simulateEnvelope(stateReply(stateId, 'ready'));
    expect(snapshot(gate).error).toBe('bridge_offline');
  });

  it('3.2 bridgeStatus.online=true → not failed', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0]);
    gate.retry();
    const { messagesId, stateId } = ceremonyIds(fake);

    fake.setBridgeStatus({
      online: true,
      changedAt: '2026-09-08T10:00:00.000Z',
      reason: 'connected',
      receivedAt: Date.now(),
    });
    fake.simulateEnvelope(snapshotReply(messagesId));
    fake.simulateEnvelope(stateReply(stateId, 'idle'));
    expect(snapshot(gate)).toEqual({ ready: true, error: null });
  });

  it('3.3 null bridgeStatus at start → not failed (cold-start false-positive guard)', () => {
    const fake = new FakeWsClient();
    // No bridgeStatus set — ceremony starts with `bridgeStatus === null`.
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0]);
    gate.retry();
    const { messagesId, stateId } = ceremonyIds(fake);

    fake.simulateEnvelope(snapshotReply(messagesId));
    fake.simulateEnvelope(stateReply(stateId, 'ready'));
    expect(snapshot(gate)).toEqual({ ready: true, error: null });
  });

  it('3.4 bridgeStatus.online=false BEFORE retry() → immediate bridge_offline on first checkComplete', () => {
    const fake = new FakeWsClient();
    // Stamp bridgeStatus as offline BEFORE the ceremony starts —
    // mirrors "auto-start guard was skipped (e.g. user pressed
    // retry while bridge was already offline)".
    fake.setBridgeStatus({
      online: false,
      changedAt: '2026-09-08T10:00:00.000Z',
      reason: 'closed',
      receivedAt: Date.now(),
    });

    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0], {
      timeoutMs: 5_000,
    });
    gate.retry();
    // Both replies arrive but bridge was offline BEFORE the
    // ceremony subscribed → initialBridgeStatus check inside
    // startCeremony marks bridgeOfflineDetected immediately.
    const { messagesId, stateId } = ceremonyIds(fake);
    fake.simulateEnvelope(snapshotReply(messagesId));
    fake.simulateEnvelope(stateReply(stateId, 'ready'));
    expect(snapshot(gate).error).toBe('bridge_offline');
  });

  it('3.5 bridgeStatus.online=false arrives mid-ceremony with pending replies → bridge_offline wins (no wait)', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0]);
    gate.retry();
    const { stateId } = ceremonyIds(fake);

    // State reply arrives (ok), snapshot still pending.
    fake.simulateEnvelope(stateReply(stateId, 'ready'));
    // Bridge goes offline — must short-circuit regardless of the
    // still-pending snapshot.
    fake.setBridgeStatus({
      online: false,
      changedAt: '2026-09-08T10:00:00.000Z',
      reason: 'closed',
      receivedAt: Date.now(),
    });
    expect(snapshot(gate).error).toBe('bridge_offline');
  });
});

describe('recovery — M4 §6.3 StrictMode / retry 不泄漏监听器', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('4.1 retry() cancels previous ceremony.unsubs — no double-fire', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0], {
      timeoutMs: 5_000,
      phaseProgressTimeoutMs: 15_000,
    });
    gate.retry();

    // Record how many session_state listeners the fake carries —
    // ceremony should add exactly ONE for session_state and ONE
    // for bridge_status per active ceremony.
    const firstSessionListeners = countListeners(fake, 'session_state');
    const firstBridgeListeners = countListeners(fake, 'bridge_status');
    expect(firstSessionListeners).toBe(1);
    expect(firstBridgeListeners).toBe(1);

    gate.retry();
    expect(countListeners(fake, 'session_state')).toBe(1);
    expect(countListeners(fake, 'bridge_status')).toBe(1);

    gate.retry();
    expect(countListeners(fake, 'session_state')).toBe(1);
    expect(countListeners(fake, 'bridge_status')).toBe(1);
  });

  it('4.2 successful ceremony cleans up all listeners (no leak)', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0]);
    gate.retry();
    expect(countListeners(fake, 'session_state')).toBe(1);
    expect(countListeners(fake, 'bridge_status')).toBe(1);
    // reply resolvers live too.
    expect(fake.pendingReplyResolverCount()).toBe(2);

    const { messagesId, stateId } = ceremonyIds(fake);
    fake.simulateEnvelope(snapshotReply(messagesId));
    fake.simulateEnvelope(stateReply(stateId, 'ready'));
    expect(snapshot(gate)).toEqual({ ready: true, error: null });

    expect(countListeners(fake, 'session_state')).toBe(0);
    expect(countListeners(fake, 'bridge_status')).toBe(0);
    expect(fake.pendingReplyResolverCount()).toBe(0);
  });

  it('4.3 failed ceremony cleans up all listeners (no leak)', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0], {
      timeoutMs: 1_000,
    });
    gate.retry();
    expect(countListeners(fake, 'session_state')).toBe(1);
    expect(countListeners(fake, 'bridge_status')).toBe(1);

    vi.advanceTimersByTime(1_000);
    expect(snapshot(gate).error).toBe('both_failed');

    expect(countListeners(fake, 'session_state')).toBe(0);
    expect(countListeners(fake, 'bridge_status')).toBe(0);
    expect(fake.pendingReplyResolverCount()).toBe(0);
  });

  it('4.4 bridge_offline path cleans up all listeners', () => {
    const fake = new FakeWsClient();
    const gate = initiateRecovery(fake as unknown as Parameters<typeof initiateRecovery>[0]);
    gate.retry();
    expect(countListeners(fake, 'session_state')).toBe(1);
    expect(countListeners(fake, 'bridge_status')).toBe(1);

    fake.setBridgeStatus({
      online: false,
      changedAt: '2026-09-08T10:00:00.000Z',
      reason: 'closed',
      receivedAt: Date.now(),
    });
    expect(snapshot(gate).error).toBe('bridge_offline');

    expect(countListeners(fake, 'session_state')).toBe(0);
    expect(countListeners(fake, 'bridge_status')).toBe(0);
    expect(fake.pendingReplyResolverCount()).toBe(0);
  });
});

describe('recovery — subscribeToSessionState / subscribeToBridgeStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('5.1 subscribeToSessionState fires only on session_state envelopes', () => {
    const fake = new FakeWsClient();
    const phases: SessionPhase[] = [];
    const unsub = subscribeToSessionState(
      fake as unknown as Parameters<typeof subscribeToSessionState>[0],
      (phase) => phases.push(phase),
    );

    fake.simulateEnvelope(snapshotReply('x')); // wrong type — must be ignored
    fake.setSessionPhase('spawning');
    fake.setSessionPhase('ready');
    fake.simulateEnvelope(stateReply('y', 'running')); // wrong type — must be ignored
    fake.setSessionPhase('idle');

    expect(phases).toEqual(['spawning', 'ready', 'idle']);
    unsub();
  });

  it('5.2 subscribeToBridgeStatus fires only on bridge_status envelopes', () => {
    const fake = new FakeWsClient();
    const statuses: boolean[] = [];
    const unsub = subscribeToBridgeStatus(
      fake as unknown as Parameters<typeof subscribeToBridgeStatus>[0],
      (status) => statuses.push(status.online),
    );

    fake.simulateEnvelope(snapshotReply('x')); // wrong type — must be ignored
    fake.setBridgeStatus({
      online: true,
      changedAt: '2026-09-08T10:00:00.000Z',
      reason: 'connected',
      receivedAt: 0,
    });
    fake.setBridgeStatus({
      online: false,
      changedAt: '2026-09-08T10:00:00.000Z',
      reason: 'closed',
      receivedAt: 0,
    });

    expect(statuses).toEqual([true, false]);
    unsub();
  });
});

// ---------------------------------------------------------------------------
// Internal helpers — counting listener slots for the StrictMode / retry
// leak assertions. The ceremony stores listeners in the WsClient's
// `typeListeners` map; we read it via the fake's own shape (declared
// via `private` with TS escape — see the cast below).
// ---------------------------------------------------------------------------

function countListeners(fake: FakeWsClient, type: string): number {
  return fake.listenerCount(type);
}

// ---------------------------------------------------------------------------
// Type-only assertion: the RecoveryError union must include bridge_offline
// (the M4 discriminator widening).
// ---------------------------------------------------------------------------

describe('recovery — RecoveryError union (M4 widening)', () => {
  it('6.1 type-level inclusion of bridge_offline', () => {
    // Compile-time check — the test runner just needs this to
    // typecheck. Runtime assertion uses an exhaustiveness switch
    // (each member of the union must be handled).
    const allErrors: RecoveryError[] = [
      'snapshot_failed',
      'state_failed',
      'both_failed',
      'bridge_offline',
    ];
    for (const e of allErrors) {
      // If `bridge_offline` were missing from the union, this
      // assignment would fail to compile.
      expect(e).toBe(e);
    }
    // exhaustiveness probe — `Record<RecoveryError, true>` requires
    // every member of the union; an omission would fail to compile.
    const map: Record<RecoveryError, true> = {
      snapshot_failed: true,
      state_failed: true,
      both_failed: true,
      bridge_offline: true,
    };
    expect(map.bridge_offline).toBe(true);
  });

  it('6.2 errorHint text branches (M4 §新错误文案)', async () => {
    // Dynamic import to defer loading App.tsx's JSX dependencies
    // (vitest's node env doesn't need them for pure-function tests).
    const { errorHint } = await import('../components/error-hint.js');
    // PRD §6.2 / tasks/m4/01 §关键要点 锁定的文案：
    expect(errorHint('bridge_offline')).toBe(
      'bridge 当前离线。请检查 bridge 进程是否运行后重试。',
    );
    expect(errorHint('snapshot_failed')).toBe(
      '无法拉取历史消息（超时或返回失败）。请检查网络后重试。',
    );
    expect(errorHint('state_failed')).toBe(
      '无法拉取会话状态（超时或返回失败）。请检查网络后重试。',
    );
    // M4 修订文案——明示 bridge 离线可能。
    expect(errorHint('both_failed')).toBe(
      'bridge 离线或无法拉取会话状态与历史消息。请刷新页面或检查 bridge 状态后重试。',
    );
  });

  it('6.3 errorHint discriminates bridge_offline vs both_failed — user-facing copy differs', async () => {
    // (d) errorHint 文案分支独立验证：bridge_offline 文案与
    // both_failed 文案**必须不同**（独立区分"bridge 离线"与
    // snapshot/state 失败）。
    const { errorHint } = await import('../components/error-hint.js');
    expect(errorHint('bridge_offline')).not.toBe(errorHint('both_failed'));
    expect(errorHint('snapshot_failed')).not.toBe(errorHint('state_failed'));
  });
});