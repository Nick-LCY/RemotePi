// stem-refilled watcher — extracted from App.tsx for unit-testability.
//
// ## What this watches
//
// The bridge's pending-key path lets the web commit a `pi/prompt`
// with `session: 'new'` + `payload.work_dir` BEFORE the manager
// has spawned (the bridge stashes under `new:<work_dir>` and
// spawns on first outbound). Once the manager's first stdout
// event lands, the bridge broadcasts `session_state{session:
// <realStem>}` — that's the anchor frame.
//
// The web's URL hash is currently
// `#work_dir=...&session=new`. The user is in ChatView with
// currentSessionKey='new'. Once the stem lands, the hash should
// refill to `&session=<realStem>` so:
//   - F5 / share-link preserves the real session key;
//   - ChoicePage level=2's session_list mirror gets a fresh query.
//
// ## M4 4th gap fix — streaming typewriter regression
//
// The naive refill path unmounted ChatView and remounted it after
// `RecoveryInFlight`, collapsing all `message_update` deltas into
// a single render. Two coordinated fixes prevent that:
//
//   1. `onRefill` callback — rekeys the App-level gate map
//      (take-and-set: `gateMap.set(stem, gateMap.get('new'))`
//      + `gateMap.delete('new')`). The freshly migrated session
//      has empty history by definition — same justification as
//      `session === 'new'` → `createReadyGate()`. After the hash
//      flip, `gateForSession(<stem>)` hits the existing ready
//      gate and ChatView never unmounts.
//   2. Deferred `sendSessionList` — the immediate post-refill
//      query blocks the turn start with ~309ms of full directory
//      scanning. Defer to `agent_settled` (`phase → idle / exited`)
//      with a 3s debounce fallback (whichever fires first).
//
// ## Trigger conditions
//
// The watcher fires the refill only when:
//   1. URL hash's `session === 'new'` (pending placeholder);
//   2. bridge `session_state` carries a non-`'new'`,
//      non-`undefined`, non-`M3_LEGACY` `envelope.session`
//      matching the URL's `work_dir`.
//
// Skip cases:
//   - `envelope.session === 'new'` — still pending.
//   - `envelope.session === undefined` — defensive (bridge
//     shouldn't omit it but be tolerant).
//   - `envelope.session === M3_LEGACY_KEY` — M3-compat fallback,
//     must not become the URL hash.
//   - `envelope.session` starts with `new:` — the bridge's
//     pre-migration internal key; refilling the hash with this
//     would break recovery (the bridge map misses, the agent-dir
//     scan finds no jsonl, subsequent queries get rejected).
//     Only the migration broadcast (with the real stem) acts.
//   - URL hash's `session` is no longer `'new'` — user has left
//     the pending flow.
//
// ## Side effects (fixed order)
//
//   1. `onRefill(newSession, workDir)` — gate rekey (see above).
//   2. `window.location.hash = selectSessionHash(workDir, stem)`
//      → triggers the App's `hashchange` listener → re-derives
//      auth + WsClient mirror.
//   3. `wsClient.setCurrentSessionKey(stem)` — synchronously
//      before any deferred sendSessionList reads the mirror, so
//      the query carries `session: <stem>` instead of `session:
//      'new'`. Without this ordering the bridge would spawn a fresh
//     pending manager and the test would see two jsonls.
//   4. Deferred `sendSessionList(workDir)` — fires on
//      `agent_settled` (phase → idle/exited) or 3s debounce
//      fallback.
//
// ## Test surface
//
// `watchStemRefilled` is a framework-free helper: it takes a
// `wsClient`, a few options, and an optional `onRefill` callback,
// and returns an unsub closure. App.tsx calls it from a `useEffect`
// and cleans up on dep change / unmount. When the gate at the top
// of the function fails (`currentSession !== 'new'` / empty token /
// empty workDir) the function returns a no-op unsub so the
// `useEffect` cleanup is uniform.

import { PROTOCOL_VERSION, type Envelope } from '@remotepi/shared';

import { SESSION_NEW, selectSessionHash } from '../hash.js';
import { M3_LEGACY_KEY, type WsClient } from './WsClient.js';

/** The return value of `watchStemRefilled` — an unsub closure.
 *  Calling it tears down the session_state listener immediately.
 *  Calling twice is safe (second call is a no-op). */
export type Unsubscribe = () => void;

/** Fallback debounce (ms) for the deferred `sendSessionList` —
 *  fires when the agent never settles to `idle` / `exited` within
 *  this window. Chosen well below the typical multi-delta turn
 *  (~5s) so the user's return to level=2 always finds a refreshed
 *  list, and well above the synchronous-refill blocking cost
 *  (~309ms full directory scan) so streaming is unaffected. */
export const SESSION_LIST_DEFER_MS = 3_000;

export interface WatchStemRefilledOptions {
  /** URL hash's session component (the watcher fires only when this
   *  is the literal `'new'`). */
  currentSession: string | null;
  /** URL hash's work_dir component (used to compose the new hash
   *  via `selectSessionHash` and as the `session_list` query arg). */
  workDir: string;
  /** Token sourced from localStorage. Used as a gate (the watcher
   *  short-circuits when the user has explicitly cleared the token
   *  via the settings button before the stem refill lands). Not
   *  used for hash composition — the new hash is `work_dir +
   *  session` only. */
  token: string;
  /** Override the side-effect writer — production uses the default
   *  (writes `window.location.hash = ...`); tests inject a recorder
   *  to assert on the URL the watcher would have written without
   *  touching a real `window` (the web test environment runs in
   *  node, no jsdom). */
  writeHash?: (hash: string) => void;
  /** Stem-rekey callback. The App-level gate map takes the
   *  `'new'` ready gate and re-keys it under the real stem
   *  (`gateMap.set(stem, gateMap.get('new'))` +
   *  `gateMap.delete('new')`), so after the hash flip
   *  `gateForSession(<stem>)` hits the existing ready gate and
   *  ChatView never unmounts (preserves streaming typewriter
   *  effect).
   *
   *  Edge cases:
   *    - `'new'` gate missing (user retreated to level=2 before
   *      the stem landed) → callback should no-op; the fallback
   *      `initiateRecovery` path runs.
   *    - Callback throws → log warn, watcher continues with the
   *      remaining side effects. */
  onRefill?: (stem: string, workDir: string) => void;
  /** Override the deferred `sendSessionList` delay. Production uses
   *  `SESSION_LIST_DEFER_MS`; tests inject a shorter window to
   *  speed assertions. */
  deferMs?: number;
}

/** Subscribe to `control/session_state` envelopes and refill the URL
 *  hash when the bridge broadcasts a real stem for the pending
 *  `'new'` session.
 *
 *  Returns an unsub function the caller MUST invoke on cleanup
 *  (StrictMode / dep-change / unmount). The function is a no-op
 *  when `currentSession !== 'new'` or `workDir === ''` or
 *  `token === ''` — callers don't need to gate the call site, but
 *  doing so avoids an unused listener attachment. */
export function watchStemRefilled(
  wsClient: WsClient,
  options: WatchStemRefilledOptions,
): Unsubscribe {
  const { currentSession, workDir, token } = options;
  const writeHash = options.writeHash ?? defaultWriteHash;
  const onRefill = options.onRefill;
  const deferMs = options.deferMs ?? SESSION_LIST_DEFER_MS;
  if (currentSession !== SESSION_NEW) {
    return () => {
      // no-op unsub; allows useEffect cleanup to call without
      // requiring the callsite to check the gate.
    };
  }
  if (token.length === 0 || workDir.length === 0) {
    return () => {
      /* no-op */
    };
  }

  let pendingDeferred: DeferredSend | null = null;

  // Idempotency: once the watcher has fired the real-stem refill,
  // subsequent `session_state` broadcasts for the same stem must
  // not re-trigger the side effects (they would re-schedule the
  // deferred `sendSessionList` on every phase transition).
  let hasRefilled = false;

  const fireOrCancelDeferred = (reason: 'fire' | 'cancel'): void => {
    const deferred = pendingDeferred;
    if (deferred === null) return;
    pendingDeferred = null;
    if (reason === 'fire') {
      wsClient.sendSessionList(workDir);
    }
    clearTimeout(deferred.timerHandle);
    try {
      deferred.phaseUnsub();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[stem-refilled] deferred phase listener unsub threw:', err);
    }
  };

  const startDeferredSessionList = (): void => {
    if (pendingDeferred !== null) return;
    let fired = false;
    const fire = (): void => {
      if (fired) return;
      fired = true;
      fireOrCancelDeferred('fire');
    };
    const timerHandle = setTimeout(fire, deferMs);
    // Fires on `phase → idle / exited` (agent_settled). Repeated
    // broadcasts of the same phase are absorbed by `fired`.
    const phaseUnsub = wsClient.on('session_state', (env: Envelope) => {
      if (env.kind !== 'control' || env.type !== 'session_state') return;
      const phase = env.payload.phase;
      if (phase === 'idle' || phase === 'exited') {
        fire();
      }
    });
    pendingDeferred = { timerHandle, phaseUnsub };
  };

  const handler = (envelope: Envelope): void => {
    if (envelope.kind !== 'control' || envelope.type !== 'session_state') return;
    const newSession = envelope.session;
    // Skip pending / M3_LEGACY / session-less envelopes.
    if (
      newSession === undefined ||
      newSession === SESSION_NEW ||
      newSession === M3_LEGACY_KEY
    ) {
      return;
    }
    // Skip the bridge's internal `pending-key` format
    // (`new:<work_dir>`). The bridge forwards the pending
    // manager's FIRST `session_state` broadcast with
    // `envelope.session === 'new:<work_dir>'` BEFORE the
    // migration (jsonl not yet on disk). Refilling the hash with
    // this pending key would break recovery (the bridge map
    // misses, the agent-dir scan finds no jsonl for that name,
    // subsequent queries get rejected). Only the migration
    // broadcast (with the real stem) acts.
    if (newSession.startsWith('new:')) {
      return;
    }
    if (envelope.payload.work_dir === undefined) {
      return;
    }
    if (envelope.payload.work_dir !== workDir) {
      return;
    }
    if (hasRefilled) return;
    // Side effect 1: gate rekey callback. Runs BEFORE the hash
    // write so the App's `onRefill` can take-and-set the ready
    // gate under the new stem before `gateForSession(<stem>)`
    // is consulted on the next render.
    if (onRefill !== undefined) {
      try {
        onRefill(newSession, workDir);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[stem-refilled] onRefill callback threw:', err);
      }
    }
    // Side effect 2: refill the hash. The `hashchange` listener
    // re-derives auth + updates WsClient mirror.
    writeHash(selectSessionHash(workDir, newSession));
    // Side effect 3: WsClient mirror update.
    //
    // CRITICAL ORDERING: we must update the WsClient's
    // `currentSessionKey` mirror SYNCHRONOUSLY before any
    // `sendSessionList` (now deferred) reads it. The watcher
    // fires inside the session_state dispatch — synchronous,
    // before the queued `hashchange` event flushes the App.tsx
    // mirror update. Without this write the deferred
    // `sendSessionList` would still read `currentSessionKey
    // === 'new'` and emit a `session_list` envelope with
    // `session: 'new'`. The bridge then spawns a FRESH pending
    // manager with no `--session` flag, a SECOND jsonl is
    // created, and the migrated stem ends up on a different
    // file.
    wsClient.setCurrentSessionKey(newSession);
    // Side effect 4: deferred `sendSessionList` (agent_settled or
    // 3s debounce, whichever fires first).
    startDeferredSessionList();
    hasRefilled = true;
  };

  const unsub = wsClient.on('session_state', handler);
  // Wrap so the caller can call unsub() twice without warning
  // (StrictMode double-invoke path).
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    unsub();
    // Cancel any pending deferred fire on cleanup — the user may
    // have retreated to level=2 or switched sessions, and a late
    // sendSessionList would pollute the list mirror.
    fireOrCancelDeferred('cancel');
  };
}

/** Deferred `sendSessionList` state — setTimeout handle + phase
 *  listener unsub. Cleared by `fireOrCancelDeferred` regardless of
 *  which path triggers (fire or cancel), so neither timer nor
 *  listener can leak. */
interface DeferredSend {
  readonly timerHandle: ReturnType<typeof setTimeout>;
  readonly phaseUnsub: () => void;
}

// Re-export PROTOCOL_VERSION so tests can build envelopes with the
// same v tag without importing from @remotepi/shared.
export { PROTOCOL_VERSION };

/** Production hash writer — writes to `window.location.hash` which
 *  triggers App's `hashchange` listener. The window-global write
 *  is feature-detected so the helper stays importable in node test
 *  environments where `window` is undefined. */
function defaultWriteHash(hash: string): void {
  if (typeof window !== 'undefined') {
    window.location.hash = hash;
  }
}
