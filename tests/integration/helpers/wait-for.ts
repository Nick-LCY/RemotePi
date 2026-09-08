// Polling helpers for waiting on async conditions during integration tests.
//
// We deliberately use REAL setTimeout (not vi.useFakeTimers) so that
// the spawned pi subprocess keeps ticking — fake timers freeze the
// entire Node event loop and the child process would never receive
// the JSONL frames we write to its stdin. The polling pattern below
// yields to the event loop on each tick so stdout parsing + child
// IO keep progressing while we wait.
//
// On timeout the helpers throw a descriptive Error that includes a
// snapshot of the last envelopes seen, so a test failure points
// immediately at "what actually happened" instead of a bare
// `TimeoutError`.

import type {
  BlockedOnEntryPayload,
  Envelope as EnvelopeT,
  SessionPhase,
} from '@remotepi/shared';
import type { PiProcessManager } from '@remotepi/bridge/pi-process.js';

export interface WaitForOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

/** Tail of the outbound array as a one-line summary for error messages. */
function summarise(outbound: EnvelopeT[]): string {
  const tail = outbound.slice(-8);
  return tail
    .map((env) => {
      if (env.kind === 'control' && env.type === 'session_state') {
        return `control/session_state phase=${env.payload.phase}${
          env.payload.blocked_on ? ` blocked=${env.payload.blocked_on.length}` : ''
        }`;
      }
      if (env.kind === 'control' && env.type === 'result') {
        return `control/result reply_to=${env.reply_to ?? '-'}`;
      }
      if (env.kind === 'pi' && env.type === 'event') {
        return `pi/event ${env.payload.event}`;
      }
      if (env.kind === 'pi' && env.type === 'command_result') {
        return `pi/command_result reply_to=${env.reply_to ?? '-'} cmd=${env.payload.command} ok=${env.payload.success}`;
      }
      if (env.kind === 'pi' && env.type === 'snapshot') {
        return `pi/snapshot reply_to=${env.reply_to ?? '-'} messages=${env.payload.messages.length}`;
      }
      return `${env.kind}/${env.type}`;
    })
    .join(' | ');
}

/**
 * Wait until the predicate returns a truthy value when applied to the
 * outbound envelope list. Returns the first truthy value.
 */
export async function waitForEnvelope(
  outbound: EnvelopeT[],
  predicate: (env: EnvelopeT) => boolean,
  options: WaitForOptions = {},
): Promise<EnvelopeT> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const env of outbound) {
      if (predicate(env)) return env;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `waitForEnvelope: timed out after ${timeoutMs}ms. last envelopes: ${summarise(outbound)}`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

/**
 * Wait until `outbound` contains a session_state envelope whose
 * phase matches `phase`. Returns the matching session_state payload.
 */
export async function waitForPhase(
  outbound: EnvelopeT[],
  phase: SessionPhase,
  options: WaitForOptions = {},
): Promise<{ phase: SessionPhase; blocked_on?: ReadonlyArray<BlockedOnEntryPayload> }> {
  const env = await waitForEnvelope(
    outbound,
    (e) => e.kind === 'control' && e.type === 'session_state' && e.payload.phase === phase,
    options,
  );
  if (env.kind !== 'control' || env.type !== 'session_state') {
    throw new Error('waitForPhase: internal — predicate matched non-session_state envelope');
  }
  return env.payload;
}

/**
 * Wait until the manager's spawnCount reaches `n`.
 */
export async function waitForSpawnCount(
  manager: PiProcessManager,
  n: number,
  options: WaitForOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (manager.getSpawnCount() >= n) return;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForSpawnCount: timed out waiting for spawnCount >= ${n} (current=${manager.getSpawnCount()})`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

/**
 * Wait until a session_state envelope with `blocked_on` containing an
 * entry with `method === methodName` is emitted. Returns the blocked_on
 * entry, so the caller can use its `id` for an extension_ui_response.
 */
export async function waitForBlockedOn(
  outbound: EnvelopeT[],
  methodName: 'select' | 'confirm' | 'input' | 'editor',
  options: WaitForOptions = {},
): Promise<BlockedOnEntryPayload> {
  const env = await waitForEnvelope(
    outbound,
    (e) =>
      e.kind === 'control' &&
      e.type === 'session_state' &&
      Array.isArray(e.payload.blocked_on) &&
      e.payload.blocked_on.some((b) => b.method === methodName),
    options,
  );
  if (env.kind !== 'control' || env.type !== 'session_state' || !env.payload.blocked_on) {
    throw new Error('waitForBlockedOn: internal — predicate matched an envelope without blocked_on');
  }
  const entry = env.payload.blocked_on.find((b) => b.method === methodName);
  if (entry === undefined) {
    throw new Error(`waitForBlockedOn: no ${methodName} entry in latest session_state`);
  }
  return entry;
}

/**
 * Wait until `blocked_on` is empty or absent on the latest
 * session_state envelope (i.e. the dialog has been answered or timed
 * out and the entry has been removed).
 *
 * Implementation note: we scan the WHOLE outbound history for each
 * poll tick and return as soon as we see "blocked_on appeared at
 * some point AND the latest session_state has none". This is robust
 * against fast paths where the dialog was answered between the
 * prior helper's return and this helper's first tick (the test
 * might not have observed the with-entry state at all from this
 * helper's vantage point — only from the prior waitForBlockedOn's).
 *
 * If NO session_state with blocked_on has ever been emitted, this
 * helper times out — callers must have observed the dialog appear
 * first via `waitForBlockedOn`.
 */
export async function waitForBlockedOnCleared(
  outbound: EnvelopeT[],
  options: WaitForOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let sawBlockedOn = false;
    let latestPhase: SessionPhase | null = null;
    let latestHasBlockedOn = false;
    for (const e of outbound) {
      if (e.kind === 'control' && e.type === 'session_state') {
        const blocked = e.payload.blocked_on;
        if (Array.isArray(blocked) && blocked.length > 0) {
          sawBlockedOn = true;
          latestHasBlockedOn = true;
        } else {
          latestHasBlockedOn = false;
        }
        latestPhase = e.payload.phase;
      }
    }
    if (sawBlockedOn && !latestHasBlockedOn) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `waitForBlockedOnCleared: timed out after ${timeoutMs}ms. sawBlockedOn=${sawBlockedOn} latestPhase=${latestPhase} latestHasBlockedOn=${latestHasBlockedOn}. last envelopes: ${summarise(outbound)}`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
