// RemotePi web — M3 dual-query recovery ceremony (PRD §4.4).
//
// On every (re)connect the web fires a parallel pair of queries the
// moment the WebSocket is open and the handshake has been sent:
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
// acked. The handshake-replies bridge_status is the bridge-online
// signal (carried over from M2), not the recovery gate.
//
// Failure handling (PRD §4.4): either reply missing for 5 seconds
// (or arriving with `ok: false` / `success: false` / a malformed
// data payload) flips the gate to a failure state and the UI
// shows a "恢复失败" card with a manual retry button. The
// ceremony is never silent — every timeout is observed, every
// failure state is surfaced, every successful run mounts the
// chat surface exactly once.
//
// The gate is framework-free (plain object + subscribe), so the
// React layer in `App.tsx` can plug it into `useSyncExternalStore`
// without coupling the ceremony to React's lifecycle. The
// WsClient reference is held for the gate's lifetime — disconnect
// the WsClient and the gate's pending timers will simply expire
// to `both_failed` and the user retries.

import { PROTOCOL_VERSION, type Envelope } from '@remotepi/shared';

import type { WsClient } from './WsClient.js';
import { tryDecodeGetStateData } from './WsClient.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-reply deadline for the dual-query ceremony. The PRD §4.4
 *  quotes "5s" and calls it adjustable; the value is intentionally
 *  generous because a `get_messages` arriving during `exited` phase
 *  has to wake a pi subprocess (PRD §2.7) before it can produce
 *  a snapshot. On a healthy machine the round-trip is well under
 *  one second; 5s is the safety net for cold-start + slow disks. */
export const RECOVERY_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Recovery failure discriminator. The three values let the UI
 *  surface a more specific hint than "everything failed" — the
 *  snapshot side can fail because bridge is dead; the state side
 *  can fail because the bridge's memory view is corrupt; both
 *  can fail because the WebSocket itself died. The PRD only
 *  requires the user-visible "恢复失败" + retry affordance; the
 *  three-way split is local diagnostic detail logged for the
 *  operator. */
export type RecoveryError = 'snapshot_failed' | 'state_failed' | 'both_failed';

/** Snapshot of the gate's externally-visible state. `ready` and
 *  `error` are mutually exclusive in steady state (ready=true
 *  implies error=null, error!==null implies ready=false); during
 *  the in-flight window both are false / null. */
export interface RecoveryState {
  ready: boolean;
  error: RecoveryError | null;
}

/** Recovery ceremony handle. Lives across React re-renders
 *  (caller memoizes via useMemo / useRef). The gate's lifetime follows
 *  its owning component instance; active ceremony timers and listeners
 *  are cancelled by retry or naturally become inert when no listeners
 *  remain.
 *
 *  `getSnapshot` and `subscribe` are exposed as **arrow field
 *  references** (bound at gate-construction time, not methods
 *  re-bound per access) so React's `useSyncExternalStore` sees a
 *  stable function identity across renders. This is the contract
 *  useSyncExternalStore wants — `getSnapshot` must also return a
 *  stable reference when the underlying state hasn't changed (see
 *  the cached `snapshot` field in `initiateRecovery`). Returning
 *  a fresh `{ ready, error }` object on every call would trip
 *  React's referential-equality check and trigger an infinite
 *  re-render loop (PRD §-bug-2026-09-07 — `Maximum update depth
 *  exceeded`). */
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
   *  of dual queries goes out. */
  retry(): void;
  retry(): void;
}

// ---------------------------------------------------------------------------
// Initiator
// ---------------------------------------------------------------------------

/** Test seams — production callers use the default. The options
 *  bag lets unit tests inject deterministic ids + a custom timeout
 *  without monkey-patching globals. */
export interface InitiateRecoveryOptions {
  /** Override the 5s per-reply timeout. */
  timeoutMs?: number;
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
}

export function initiateRecovery(
  wsClient: WsClient,
  options: InitiateRecoveryOptions = {},
): RecoveryGate {
  const timeoutMs = options.timeoutMs ?? RECOVERY_TIMEOUT_MS;
  const makeId = options.makeId ?? defaultMakeId;
  const onTransition = options.onTransition;

  // ---- state ---------------------------------------------------------------
  // Cached snapshot — replace-on-change semantics. `useSyncExternalStore`
  // calls `getSnapshot` on every render and compares the result to the
  // previous call's return with `Object.is`. Returning a freshly
  // constructed `{ ready, error }` on every call (the bug we are fixing)
  // always trips that check and triggers an infinite re-render loop —
  // the previous version of this file was the cause of the
  // `Maximum update depth exceeded` crash at RecoveryView mount.
  //
  // The contract enforced below: `snapshot` is replaced ONLY when one
  // of its fields actually changes (`setState` does the equality guard).
  // `getSnapshot` returns the cached reference verbatim, so React sees
  // identity-stable output across re-renders that don't transition the
  // gate and skips the re-render. The arrow-field binding on the gate
  // object further guarantees the getSnapshot *function* is identity
  // stable too — passing a fresh `() => snapshot` inline would not
  // cause a loop by itself, but the spec asks for it and it lets the
  // App.tsx call site drop its wrapping arrow.
  let snapshot: RecoveryState = { ready: false, error: null };
  const listeners = new Set<() => void>();
  let active: ActiveCeremony | null = null;

  const setState = (next: { ready: boolean; error: RecoveryError | null }): void => {
    // Replace-on-change: equal in both fields → no-op (preserves the
    // current snapshot reference AND suppresses the listener fan-out).
    // This is the second half of the snapshot-stability contract —
    // without it, an idempotent transition (e.g. retry() while the
    // gate is already in `error`) would emit a state-change event
    // and force consumers to re-render on no information.
    if (snapshot.ready === next.ready && snapshot.error === next.error) return;
    snapshot = { ready: next.ready, error: next.error };
    if (onTransition !== undefined) {
      try {
        onTransition(snapshot);
      } catch (err) {
        // Tests should not throw, but a buggy hook must not
        // disrupt the React-side subscribers. Logged-and-swallowed
        // (matches the WsClient dispatchReplyResolvers policy) so
        // a test bug surfaces in the operator console instead of
        // being silently lost — the ceremony's invariants (timer
        // firing, gate transitions) keep going regardless.
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
        // rest of the chain; the throw itself is operator-visible.
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
    // Cancel any in-flight attempt first — its timers must not
    // fire after a new attempt's state has been set, and its
    // resolvers must not see this attempt's replies. We cancel
    // the active ceremony which clears timers + unsubscribes.
    cancelActive();
    setState({ ready: false, error: null });
    const messagesId = makeId();
    const stateId = makeId();
    const ceremony: ActiveCeremony = {
      messagesId,
      stateId,
      snapshotOutcome: 'pending',
      stateOutcome: 'pending',
      stale: false,
      timers: new Set(),
      unsubs: [],
    };
    active = ceremony;

    // Register reply resolvers BEFORE sending — the WebSocket
    // send is synchronous (writes to the open socket) so a
    // reply can only arrive via the event loop after this
    // function returns. Registering after the send would leave
    // a window where the reply arrives before the resolver is
    // installed and is silently dropped.
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

    // Arm the per-reply timeout. Two independent timers (not one
    // shared deadline) so a late snapshot on a slow bridge
    // doesn't get punished by the state timer already having
    // fired. Each timer only marks its own outcome.
    ceremony.timers.add(
      setTimeout(() => {
        if (ceremony.stale) return;
        if (ceremony.snapshotOutcome === 'pending') {
          ceremony.snapshotOutcome = 'fail';
        }
        checkComplete(ceremony);
      }, timeoutMs),
    );
    ceremony.timers.add(
      setTimeout(() => {
        if (ceremony.stale) return;
        if (ceremony.stateOutcome === 'pending') {
          ceremony.stateOutcome = 'fail';
        }
        checkComplete(ceremony);
      }, timeoutMs),
    );

    // Parallel send — handshake has no ack (PRD §4.4), so the
    // queries are legal the moment the socket is open. The
    // WsClient.send() path silently drops if the socket isn't
    // open yet; in that case both replies time out at `timeoutMs`
    // and the gate flips to `both_failed`. The RecoveryView
    // defers the first start until `connState === 'online'`
    // precisely to avoid this drop — the `getSnapshot` /
    // `subscribe` shape above supports that without coupling
    // the ceremony to connection state.
    wsClient.send({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'get_messages',
      id: messagesId,
      payload: {},
    });
    wsClient.send({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'get_state',
      id: stateId,
      payload: {},
    });
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

  /** Per-reply outcome resolution: when BOTH replies have
   *  resolved (or timed out), tear down the active ceremony
   *  and update the gate's externally-visible state. The
   *  active-pointer check guards against the (admittedly
   *  unreachable-in-practice) case where a stale attempt's
   *  late timer fires after a fresh attempt has taken over. */
  const checkComplete = (ceremony: ActiveCeremony): void => {
    if (ceremony.stale) return;
    if (ceremony.snapshotOutcome === 'pending' || ceremony.stateOutcome === 'pending') return;
    if (active !== ceremony) return;
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

  /** Tear down the active ceremony: clear timers, unsubscribe
   *  reply resolvers, mark stale so a late callback is a no-op.
   *  Idempotent. */
  const cancelActive = (): void => {
    const current = active;
    if (current === null) return;
    current.stale = true;
    for (const timer of current.timers) {
      clearTimeout(timer);
    }
    current.timers.clear();
    for (const unsub of current.unsubs) {
      try {
        unsub();
      } catch (err) {
        // Logged-and-swallowed — mirrors the WsClient dispatch
        // path. A buggy unsubscribe (e.g. a thrown cleanup
        // closure) must not break the rest of the cancel-active
        // sequence (we still want to clear the remaining unsubs
        // + the timer set, even if the first unsubscribe throws).
        // The throw itself is operator-visible so a programming
        // error in the resolver-cleanup path doesn't go silent.
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
  // `useSyncExternalStore` doesn't crash on a fresh function ref each
  // render, but it does re-validate and re-subscribe on every identity
  // change — keeping these as bound arrow fields makes that cost zero
  // AND satisfies `@typescript-eslint/unbound-method` without the
  // consumer having to wrap each call site in another arrow. The
  // App.tsx RecoveryView can now write `useSyncExternalStore(gate
  // .subscribe, gate.getSnapshot)` directly.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ActiveCeremony {
  readonly messagesId: string;
  readonly stateId: string;
  snapshotOutcome: 'pending' | 'ok' | 'fail';
  stateOutcome: 'pending' | 'ok' | 'fail';
  /** Set true on retry-cancellation. Late timer
   *  firings + late reply-resolver callbacks observe this and
   *  short-circuit instead of mutating the (now-cancelled)
   *  attempt's outcome. */
  stale: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  unsubs: Array<() => void>;
}

function defaultMakeId(): string {
  return crypto.randomUUID();
}
