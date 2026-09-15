// Dual-query recovery ceremony (PRD §4.4).
//
// On every (re)connect the web fires a parallel pair of queries
// the moment the WebSocket is open and the handshake has been
// sent:
//
//   pi/get_messages     { id: m1 }       — pull authoritative history
//   control/get_state   { id: g1 }       — pull session state
//                                          (phase + blocked_on?)
//
// Both replies must arrive before the chat surface mounts. The
// handshake itself is fire-and-forget (no ack) — its only purpose
// is to authenticate the connection; the bridge may take a few
// ticks before it forwards a session_list, so the recovery must
// start as soon as the socket opens, not after the handshake is
// acked.
//
// Failure handling: either reply missing for `RECOVERY_TIMEOUT_MS`
// (or arriving with `ok: false` / `success: false` / a malformed
// data payload) flips the gate to a failure state and the UI shows
// a "恢复失败" card with a manual retry button.
//
// Timeout semantics:
//   - Snapshot timer starts at `RECOVERY_TIMEOUT_MS` (no-progress
//     safety net) and is reset to `PHASE_PROGRESS_TIMEOUT_MS` on
//     every observed `sessionPhase` change. `blocked_on`-only
//     broadcasts do not reset (only `envelope.payload.phase`
//     changes count).
//   - `bridgeStatus.online === false` flips the gate to
//     `bridge_offline` immediately (a `null` bridgeStatus does
//     NOT trigger — that just means cold-start hasn't received
//     the first broadcast yet).
//
// The gate is framework-free (plain object + subscribe), so the
// React layer in `App.tsx` can plug it into `useSyncExternalStore`
// without coupling the ceremony to React's lifecycle. The
// WsClient reference is held for the gate's lifetime — disconnect
// the WsClient and the gate's pending timers will simply expire
// to `both_failed` and the user retries.

import { PROTOCOL_VERSION, type Envelope, type SessionPhase } from '@remotepi/shared';

import type { BridgeStatusInfo, WsClient } from './WsClient.js';
import { tryDecodeGetStateData } from './WsClient.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-reply baseline deadline for the dual-query ceremony.
 *  Generous because a `get_messages` arriving during `exited`
 *  phase has to wake a pi subprocess before it can produce a
 *  snapshot. On a healthy machine the round-trip is well under
 *  one second; 5s is the safety net for cold-start + slow disks.
 *  Semantically the snapshot timer starts here and is reset to
 *  `PHASE_PROGRESS_TIMEOUT_MS` once a `sessionPhase` change is
 *  observed; the state timer keeps this 5s ceiling. */
export const RECOVERY_TIMEOUT_MS = 5_000;

/** Snapshot "with-progress" deadline — the snapshot timer is
 *  reset to this value on every observed `sessionPhase` change.
 *  15s covers pi cold-start + bridge → worker → pi handshake +
 *  spawn → snapshot landing with comfortable headroom. */
export const PHASE_PROGRESS_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Recovery failure discriminator. `bridge_offline` is set the
 *  moment `bridgeStatus.online === false` is observed (a `null`
 *  bridgeStatus does not trigger — cold-start guard). UI
 *  priority: `bridge_offline` > `both_failed` > `snapshot_failed`
 *  > `state_failed`. */
export type RecoveryError =
  | 'snapshot_failed'
  | 'state_failed'
  | 'both_failed'
  | 'bridge_offline';

/** Snapshot of the gate's externally-visible state. `ready` and
 *  `error` are mutually exclusive in steady state (ready=true
 *  implies error=null, error!==null implies ready=false); during
 *  the in-flight window both are false / null. */
export interface RecoveryState {
  ready: boolean;
  error: RecoveryError | null;
}

/** Recovery ceremony handle. Lives across React re-renders
 *  (caller keeps one per component instance via useRef). The gate's
 *  lifetime follows its owning component instance; active ceremony
 *  timers and listeners are cancelled by retry or naturally become
 *  inert when no listeners remain.
 *
 *  `getSnapshot` and `subscribe` are exposed as **arrow field
 *  references** (bound at gate-construction time, not methods
 *  re-bound per access) so React's `useSyncExternalStore` sees a
 *  stable function identity across renders. `getSnapshot` must
 *  also return a stable reference when the underlying state hasn't
 *  changed (see the cached `snapshot` field in `initiateRecovery`)
 *  — returning a fresh `{ ready, error }` object on every call
 *  would trip React's referential-equality check and trigger an
 *  infinite re-render loop (`Maximum update depth exceeded`). */
export interface RecoveryGate {
  /** Read the current `ready` / `error` pair. Returns the
   *  cached snapshot reference verbatim — identity is preserved
   *  across calls when the gate hasn't transitioned, so
   *  `useSyncExternalStore` skips re-render. Stable per gate
   *  instance (arrow field, not a method). */
  getSnapshot: () => RecoveryState;
  /** Subscribe to gate state changes. Fires on every transition
   *  (in-flight → ready, in-flight → error, error → in-flight on
   *  retry, etc.). Returns an unsubscribe function. Stable per
   *  gate instance (arrow field). */
  subscribe: (listener: () => void) => () => void;
  /** Trigger a fresh ceremony. Idempotent in the sense that a
   *  call from the UI's "retry" button always restarts from
   *  scratch — any in-flight ceremony is cancelled (its timers
   *  cleared, its reply-resolvers unsubscribed) and a new pair
   *  of dual queries goes out.
   *
   *  The gate intentionally exposes no `dispose()` entry point —
   *  the host component owns the gate for its lifetime via
   *  `useRef`. Inert timers and reply-resolvers either fire into
   *  an empty listener set or no-op on `stale`, so an unmounted
   *  gate holds no live state worth actively cleaning up. */
  retry(): void;
}

// ---------------------------------------------------------------------------
// Initiator
// ---------------------------------------------------------------------------

/** Test seams — production callers use the default. The options
 *  bag lets unit tests inject deterministic ids + a custom timeout
 *  without monkey-patching globals. */
export interface InitiateRecoveryOptions {
  /** Override the baseline 5s per-reply timeout (state side +
   *  initial snapshot timer — semantically the no-progress
   *  safety net). */
  timeoutMs?: number;
  /** Override the 15s "with-progress" snapshot timeout. The
   *  snapshot timer is reset to this value on every observed
   *  `sessionPhase` change. */
  phaseProgressTimeoutMs?: number;
  /** Override the id generator. Production uses `crypto.randomUUID`
   *  so each ceremony's m1 / g1 ids are unique even across
   *  retries in the same session. Tests inject a deterministic
   *  sequence to assert on the wire shape. */
  makeId?: () => string;
  /** Optional notification hook fired on every gate transition.
   *  Production callers don't need this (the React layer observes
   *  via `subscribe`) — tests use it to assert on the transition
   *  order without juggling the subscribe dance. The hook receives
   *  the post-transition `RecoveryState` snapshot. */
  onTransition?: (state: RecoveryState) => void;
  /** Session identifier mirrored from the URL hash session field.
   *  - `undefined` / `null` → M3-compat fallback, ceremony keeps
   *    the session-less envelope and the bridge's M3_LEGACY
   *    manager auto-spawns.
   *  - String → M4 normal flow, the envelopes carry `session`
   *    and the bridge routes to the matching manager (or
   *    pending-key path for `'new'`). */
  sessionKey?: string | null;
  /** Work directory mirrored from the URL hash. Only used when
   *  `sessionKey === 'new'` — the bridge pending-key route needs
   *  `payload.work_dir` to satisfy `钉子 2`. */
  workDir?: string | null;
}

export function initiateRecovery(
  wsClient: WsClient,
  options: InitiateRecoveryOptions = {},
): RecoveryGate {
  const timeoutMs = options.timeoutMs ?? RECOVERY_TIMEOUT_MS;
  const phaseProgressTimeoutMs = options.phaseProgressTimeoutMs ?? PHASE_PROGRESS_TIMEOUT_MS;
  const makeId = options.makeId ?? defaultMakeId;
  const onTransition = options.onTransition;
  const sessionKey = options.sessionKey ?? null;
  const workDir = options.workDir ?? null;

  // ---- state ---------------------------------------------------------------
  // Cached snapshot — replace-on-change semantics. `useSyncExternalStore`
  // calls `getSnapshot` on every render and compares the result to the
  // previous call's return with `Object.is`. Returning a freshly
  // constructed `{ ready, error }` on every call always trips that
  // check and triggers an infinite re-render loop. `snapshot` is
  // replaced ONLY when one of its fields actually changes
  // (`setState` does the equality guard). `getSnapshot` returns the
  // cached reference verbatim, so React sees identity-stable output
  // across re-renders that don't transition the gate.
  let snapshot: RecoveryState = { ready: false, error: null };
  const listeners = new Set<() => void>();
  let active: ActiveCeremony | null = null;

  const setState = (next: { ready: boolean; error: RecoveryError | null }): void => {
    // Replace-on-change: equal in both fields → no-op (preserves the
    // current snapshot reference AND suppresses the listener fan-out).
    if (snapshot.ready === next.ready && snapshot.error === next.error) return;
    snapshot = { ready: next.ready, error: next.error };
    if (onTransition !== undefined) {
      try {
        onTransition(snapshot);
      } catch (err) {
        // Logged-and-swallowed so a buggy hook does not disrupt the
        // React-side subscribers. The ceremony's invariants keep
        // going regardless.
        // eslint-disable-next-line no-console
        console.warn('[recovery] onTransition hook threw:', err);
      }
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        // Logged-and-swallowed — mirrors WsClient's listener
        // isolation policy. One bad subscriber doesn't break the
        // rest of the chain.
        // eslint-disable-next-line no-console
        console.warn('[recovery] gate subscriber threw:', err);
      }
    }
  };

  // ---- per-attempt ceremony ------------------------------------------------

  /** Internal mutable record of an in-flight attempt. The
   *  resolver callbacks close over the instance so the right
   *  attempt's outcome is recorded (a stale attempt is dropped
   *  by setting `stale = true` on disposal / retry). */
  const startCeremony = (): void => {
    cancelActive();
    setState({ ready: false, error: null });
    const messagesId = makeId();
    const stateId = makeId();
    const ceremony: ActiveCeremony = {
      messagesId,
      stateId,
      snapshotOutcome: 'pending',
      stateOutcome: 'pending',
      lastSeenPhase: wsClient.sessionPhase,
      bridgeOfflineDetected: false,
      snapshotTimerHandle: null,
      stale: false,
      timers: new Set(),
      unsubs: [],
    };
    active = ceremony;

    // Register reply resolvers BEFORE sending — the WebSocket send
    // is synchronous (writes to the open socket) so a reply can only
    // arrive via the event loop after this function returns.
    // Registering after the send would leave a window where the reply
    // arrives before the resolver is installed and is silently dropped.
    ceremony.unsubs.push(
      wsClient.registerReplyResolver(messagesId, (env) => {
        ceremony.snapshotOutcome = evaluateSnapshotOutcome(env) ? 'ok' : 'fail';
        checkComplete(ceremony);
      }),
    );
    ceremony.unsubs.push(
      wsClient.registerReplyResolver(stateId, (env) => {
        ceremony.stateOutcome = evaluateStateOutcome(env) ? 'ok' : 'fail';
        checkComplete(ceremony);
      }),
    );

    armSnapshotTimer(ceremony, timeoutMs);

    ceremony.timers.add(
      setTimeout(() => {
        if (ceremony.stale) return;
        if (ceremony.stateOutcome === 'pending') {
          ceremony.stateOutcome = 'fail';
        }
        checkComplete(ceremony);
      }, timeoutMs),
    );

    // Session-phase listener: on every observed change to
    // `envelope.payload.phase` (not `blocked_on`), reset the
    // snapshot timer to the longer with-progress window.
    // `lastSeenPhase === newPhase` short-circuits `blocked_on`-
    // only broadcasts.
    ceremony.unsubs.push(
      subscribeToSessionState(wsClient, (newPhase) => {
        if (ceremony.stale) return;
        if (newPhase === ceremony.lastSeenPhase) return;
        ceremony.lastSeenPhase = newPhase;
        armSnapshotTimer(ceremony, phaseProgressTimeoutMs);
      }),
    );

    // Bridge-status listener: `online === false` flips the gate to
    // `bridge_offline` immediately. `null` does not trigger (cold
    // start guard).
    const initialBridgeStatus = wsClient.bridgeStatus;
    if (initialBridgeStatus !== null && initialBridgeStatus.online === false) {
      ceremony.bridgeOfflineDetected = true;
    }
    ceremony.unsubs.push(
      subscribeToBridgeStatus(wsClient, (status) => {
        if (ceremony.stale) return;
        if (status.online === false) {
          ceremony.bridgeOfflineDetected = true;
          checkComplete(ceremony);
        }
      }),
    );

    // Parallel send — handshake has no ack (PRD §4.4), so the
    // queries are legal the moment the socket is open. The
    // WsClient.send() path silently drops if the socket isn't
    // open yet; in that case both replies time out at `timeoutMs`
    // and the gate flips to `both_failed`. The RecoveryView
    // defers the first start until `connState === 'online'`
    // precisely to avoid this drop.
    //
    // `envelope.session` is set when `sessionKey !== null` so the
    // bridge can route to the matching manager (or pending-key
    // path for `'new'`). `null` keeps the M3-compat fallback.
    const sessionField = sessionKey !== null ? { session: sessionKey } : {};
    // `work_dir` is only carried when `sessionKey === 'new'`. The
    // bridge's pending-key route needs it on the envelope to
    // satisfy 钉子 2; the shared payload schema strips extras so
    // adding it here is non-breaking.
    const needsWorkDir = sessionKey === 'new' && workDir !== null;
    const messagesPayload: Record<string, unknown> = {};
    const statePayload: Record<string, unknown> = {};
    if (needsWorkDir) {
      messagesPayload['work_dir'] = workDir;
      statePayload['work_dir'] = workDir;
    }
    // TODO: lift `work_dir` into the explicit GetMessagesPayloadSchema /
    // GetStatePayloadSchema fields. Today it rides on the payload as an
    // unknown extra — bridge reads it via dynamic narrowing while the
    // shared schema lets it through (strip mode).
    const getMessagesEnvelope = {
      v: PROTOCOL_VERSION,
      kind: 'pi' as const,
      type: 'get_messages' as const,
      id: messagesId,
      ...sessionField,
      payload: messagesPayload,
    };
    const getStateEnvelope = {
      v: PROTOCOL_VERSION,
      kind: 'control' as const,
      type: 'get_state' as const,
      id: stateId,
      ...sessionField,
      payload: statePayload,
    };
    wsClient.send(getMessagesEnvelope);
    wsClient.send(getStateEnvelope);
  };

  /** Per-reply outcome: `pi/snapshot` with the matching reply_to
   *  is the only success path. Any other envelope (including
   *  a `control/result` that happens to carry the snapshot's
   *  id) is treated as failure — defensive against a future
   *  bridge that mistakenly cross-routes. */
  const evaluateSnapshotOutcome = (env: Envelope): boolean => {
    return env.kind === 'pi' && env.type === 'snapshot';
  };

  /** Per-reply outcome for the `control/get_state` reply.
   *  Delegates to `tryDecodeGetStateData` (shared with the
   *  WsClient's central `case 'result':` handler) so the
   *  `SessionStatePayloadSchema` check lives in one place —
   *  the ceremony's verdict stays consistent with the WsClient's
   *  "would this have mutated store state?" answer. */
  const evaluateStateOutcome = (env: Envelope): boolean => {
    return tryDecodeGetStateData(env) !== null;
  };

  /** Arm / re-arm the snapshot timer. The previous handle is
   *  cleared before the new one is installed so re-arms don't
   *  leak. Timer firing marks the snapshot outcome as 'fail'
   *  (when still pending) and runs `checkComplete`. */
  const armSnapshotTimer = (ceremony: ActiveCeremony, delayMs: number): void => {
    if (ceremony.stale) return;
    if (ceremony.snapshotTimerHandle !== null) {
      clearTimeout(ceremony.snapshotTimerHandle);
      ceremony.snapshotTimerHandle = null;
    }
    const handle = setTimeout(() => {
      // Drop the handle so a future arm() doesn't try to clearTimeout
      // a stale id.
      if (ceremony.snapshotTimerHandle === handle) {
        ceremony.snapshotTimerHandle = null;
      }
      if (ceremony.stale) return;
      if (ceremony.snapshotOutcome === 'pending') {
        ceremony.snapshotOutcome = 'fail';
      }
      checkComplete(ceremony);
    }, delayMs);
    ceremony.snapshotTimerHandle = handle;
  };

  /** Per-reply outcome resolution: when BOTH replies have
   *  resolved (or timed out), tear down the active ceremony
   *  and update the gate's externally-visible state. The
   *  active-pointer check guards against the (admittedly
   *  unreachable-in-practice) case where a stale attempt's
   *  late timer fires after a fresh attempt has taken over.
   *
   *  `bridgeOfflineDetected` wins: the ceremony flips to
   *  `bridge_offline` the moment bridge offline is observed,
   *  regardless of the snapshot/state outcome. */
  const checkComplete = (ceremony: ActiveCeremony): void => {
    if (ceremony.stale) return;
    if (active !== ceremony) return;
    if (ceremony.bridgeOfflineDetected) {
      cancelActive();
      setState({ ready: false, error: 'bridge_offline' });
      return;
    }
    if (ceremony.snapshotOutcome === 'pending' || ceremony.stateOutcome === 'pending') return;
    cancelActive();
    if (ceremony.snapshotOutcome === 'ok' && ceremony.stateOutcome === 'ok') {
      setState({ ready: true, error: null });
      return;
    }
    const snapshotOk = ceremony.snapshotOutcome === 'ok';
    const stateOk = ceremony.stateOutcome === 'ok';
    let nextError: RecoveryError;
    if (!snapshotOk && !stateOk) {
      nextError = 'both_failed';
    } else if (!snapshotOk) {
      nextError = 'snapshot_failed';
    } else {
      nextError = 'state_failed';
    }
    setState({ ready: false, error: nextError });
  };

  /** Tear down the active ceremony: clear timers (incl. snapshot
   *  timer handle), unsubscribe reply resolvers + session_state /
   *  bridge_status listeners, mark stale so a late callback is a
   *  no-op. Idempotent. */
  const cancelActive = (): void => {
    const current = active;
    if (current === null) return;
    current.stale = true;
    if (current.snapshotTimerHandle !== null) {
      clearTimeout(current.snapshotTimerHandle);
      current.snapshotTimerHandle = null;
    }
    for (const timer of current.timers) {
      clearTimeout(timer);
    }
    current.timers.clear();
    for (const unsub of current.unsubs) {
      try {
        unsub();
      } catch (err) {
        // Logged-and-swallowed — a buggy unsubscribe must not break
        // the rest of the cancel-active sequence.
        // eslint-disable-next-line no-console
        console.warn('[recovery] cancelActive unsubscribe threw:', err);
      }
    }
    current.unsubs.length = 0;
    active = null;
  };

  // ---- public surface ------------------------------------------------------

  // `getSnapshot` and `subscribe` are arrow fields (not shorthand
  // methods) so the references are stable per gate instance. React's
  // `useSyncExternalStore` would re-validate and re-subscribe on every
  // identity change — bound arrow fields make that cost zero.
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry: startCeremony,
  };
}

/** Build a no-op gate that is ALREADY in the `ready: true` state
 *  — used when the recovery ceremony cannot meaningfully run.
 *  Primary use case: `session: 'new'` (the bridge has no manager
 *  for the 'new' key until the first pi/prompt creates the pending
 *  manager; running `get_messages` / `get_state` against it returns
 *  `invalid_envelope` / `no manager`). The new session has empty
 *  history by definition — there's nothing to recover. ChatView
 *  renders immediately; the user's first prompt triggers the
 *  bridge pending-key spawn, then the App-level stem-refilled
 *  watcher refills the hash with the real stem and the next
 *  session change gets a real ceremony.
 *
 *  `retry()` is a no-op (the gate never enters the error state, so
 *  the menu item isn't shown; the implementation is defensive). */
export function createReadyGate(): RecoveryGate {
  const snapshot: RecoveryState = { ready: true, error: null };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {
      // no listeners — no-op
    },
    retry: () => {
      // no-op — already ready
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ActiveCeremony {
  readonly messagesId: string;
  readonly stateId: string;
  snapshotOutcome: 'pending' | 'ok' | 'fail';
  stateOutcome: 'pending' | 'ok' | 'fail';
  /** Snapshot of `wsClient.sessionPhase` at ceremony start. A
   *  subsequent different phase (incl. `null` → `'spawning'`)
   *  resets the snapshot timer. */
  lastSeenPhase: SessionPhase | null;
  /** Set when `bridgeStatus.online === false` is observed (or
   *  already-true at ceremony start). `checkComplete` flips the
   *  gate to `bridge_offline` the moment this is true. */
  bridgeOfflineDetected: boolean;
  /** Snapshot timer handle — held outside the `timers` Set
   *  because the snapshot timer is re-armed (not just added)
   *  and needs `clearTimeout` on the previous handle. */
  snapshotTimerHandle: ReturnType<typeof setTimeout> | null;
  /** Set true on retry-cancellation. Late timer firings +
   *  late reply-resolver callbacks observe this and
   *  short-circuit instead of mutating the (now-cancelled)
   *  attempt's outcome. */
  stale: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  unsubs: Array<() => void>;
}

function defaultMakeId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Ceremony-internal subscribers
// ---------------------------------------------------------------------------

/** Subscribe to `control/session_state` envelopes and yield the
 *  authoritative `phase` value on every broadcast. The returned
 *  unsub must be pushed to `ceremony.unsubs` so `cancelActive`
 *  tears it down. Equality-by-phase is the caller's job (so
 *  `blocked_on`-only broadcasts don't re-trigger). */
export function subscribeToSessionState(
  wsClient: WsClient,
  onPhaseChange: (phase: SessionPhase) => void,
): () => void {
  return wsClient.on('session_state', (envelope) => {
    if (envelope.kind !== 'control' || envelope.type !== 'session_state') return;
    onPhaseChange(envelope.payload.phase);
  });
}

/** Subscribe to `control/bridge_status` envelopes and yield a
 *  fully-formed `BridgeStatusInfo` (with `receivedAt = Date.now()`)
 *  on every broadcast. The returned unsub must be pushed to
 *  `ceremony.unsubs` so `cancelActive` tears it down. The caller
 *  is responsible for interpreting `status.online === false` and
 *  marking the ceremony failed; this helper does not set error
 *  state directly. */
export function subscribeToBridgeStatus(
  wsClient: WsClient,
  onBridgeStatusChange: (status: BridgeStatusInfo) => void,
): () => void {
  return wsClient.on('bridge_status', (envelope) => {
    if (envelope.kind !== 'control' || envelope.type !== 'bridge_status') return;
    onBridgeStatusChange({
      online: envelope.payload.online,
      changedAt: envelope.payload.changed_at,
      reason: envelope.payload.reason,
      receivedAt: Date.now(),
    });
  });
}
