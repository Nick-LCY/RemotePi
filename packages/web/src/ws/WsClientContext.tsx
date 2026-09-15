// React glue around the framework-free `WsClient`. The client itself is a
// plain class (kept pure for easy reasoning); this module owns the React
// Context + the `useSyncExternalStore`-based subscription helper.
//
// One client per `<App />` mount — the App memoizes the instance so React
// StrictMode's dev double-mount doesn't create two parallel sockets.
// Components subscribe to a *slice* of state via `useWsState` or the
// per-session hooks; the selector approach lets each component pin the
// exact bucket it cares about and only re-render when that bucket's slice
// changes identity.

import { useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createContext } from 'react';
import type { SessionListEntry, SessionPhase } from '@remotepi/shared';

import {
  WsClient,
  type BlockedOnEntry,
  type BridgeStatusInfo,
  type CommandErrorHandler,
  type CommandErrorNotice,
  type ConnState,
  type DialogExpiredHandler,
  type DialogExpiredNotice,
  type EnvelopeHandler,
  type QueueState,
  type SessionBucket,
  type StreamingDraft,
} from './WsClient.js';

const WsClientContext = createContext<WsClient | null>(null);

export interface WsClientProviderProps {
  client: WsClient;
  children: ReactNode;
}

export function WsClientProvider({ client, children }: WsClientProviderProps) {
  return <WsClientContext.Provider value={client}>{children}</WsClientContext.Provider>;
}

export function useWsClient(): WsClient {
  const client = useContext(WsClientContext);
  if (!client) {
    throw new Error('useWsClient must be used inside <WsClientProvider>');
  }
  return client;
}

/**
 * Subscribe to a derived slice of the WsClient state. Re-renders only
 * when the slice's identity changes (`useSyncExternalStore` handles
 * the equality check).
 *
 * `getSnapshot` is intentionally NOT memoised via `useCallback`. The
 * selector often closes over external variables (e.g.
 * `useBucketField(sessionKey, ...)` captures `sessionKey`); freezing
 * the closure at the first render would return stale data after
 * `sessionKey` changes (e.g. after stem-refilled migration:
 * `bucketFor('new')` keeps returning the post-migration empty bucket
 * even though the same ChatView instance now reads via
 * `bucketFor(<stem>)`). `useSyncExternalStore` tolerates a fresh
 * getSnapshot per render — it just re-validates / re-subscribes.
 *
 * The WsClient selectors return store field references directly, so
 * the snapshot identity is stable as long as the underlying field
 * hasn't been reassigned — see WsClient's replace-on-change setters.
 *
 * The third argument to `useSyncExternalStore` is the server snapshot
 * for SSR-render tests via `renderToStaticMarkup`. The server
 * snapshot is identical to the client snapshot because the WsClient
 * state is process-local — there is no separate server-side store.
 */
export function useWsState<T>(selector: (client: WsClient) => T): T {
  const client = useWsClient();
  return useSyncExternalStore(
    client.subscribe,
    () => selector(client),
    () => selector(client),
  );
}

// ---- Convenience hooks -----------------------------------------------------
//
// Each one is a thin wrapper so call sites read like a regular React hook
// instead of `useWsState((c) => c.connState)`.

export function useConnState(): ConnState {
  return useWsState((c) => c.connState);
}

export function useBridgeStatus(): BridgeStatusInfo | null {
  return useWsState((c) => c.bridgeStatus);
}

/** Mirror of the URL hash's `session` component. `null` when the
 *  hash has no session (level=1 / level=2 / M3 token-only legacy). */
export function useCurrentSessionKey(): string | null {
  return useWsState((c) => c.currentSessionKey);
}

/** Pi subprocess lifecycle phase for the **current** session. `null`
 *  until the first `session_state` (or `get_state` reply) for the
 *  current bucket lands — PhaseIndicator renders a placeholder
 *  while null. For per-session access, prefer
 *  `useSessionPhaseFor(currentSessionKey)`. */
export function useSessionPhase(): SessionPhase | null {
  return useWsState((c) => c.sessionPhase);
}

/** Pending extension UI requests for the **current** session. Each
 *  element is a `BlockedOnEntry` (entry + enqueuedAt) — DialogHost
 *  unwraps the entry and reads `enqueuedAt` for the countdown math.
 *  For per-session access, prefer `useBlockedOnFor(currentSessionKey)`. */
export function useBlockedOn(): readonly BlockedOnEntry[] {
  return useWsState((c) => c.blockedOn);
}

/** Steering / follow-up queue snapshot for the current session. */
export function useQueue(): QueueState {
  return useWsState((c) => c.queue);
}

/** Streaming draft for the current session — accumulates text_delta
 *  events. `null` when no draft is in flight. */
export function useStreamingDraft(): StreamingDraft | null {
  return useWsState((c) => c.streamingDraft);
}

/** Authoritative message list (history) for the current session. */
export function useMessages(): readonly unknown[] {
  return useWsState((c) => c.messages);
}

// ---- Per-session hooks -----------------------------------------------------
//
// Each `useXxxFor(sessionKey)` hook pins the bucket to a specific
// session. The selector returns a stable reference (the bucket's
// field) for the given session — when the bucket hasn't changed, the
// reference is identical and React skips the re-render. When
// `sessionKey` is `null` (ChoicePage level=2 / M3 legacy), the
// hook reads from the M3_LEGACY bucket.

/** Read a single field from a session bucket. Used internally by
 *  the `useXxxFor` hooks; exported for any future per-session
 *  read that doesn't have a dedicated hook (e.g. a debug
 *  inspector). */
export function useBucketField<T>(
  sessionKey: string | null,
  selector: (bucket: SessionBucket) => T,
): T {
  return useWsState((c) => selector(c.bucketFor(sessionKey)));
}

export function useMessagesFor(sessionKey: string | null): readonly unknown[] {
  return useBucketField(sessionKey, (b) => b.messages);
}

export function useSessionPhaseFor(sessionKey: string | null): SessionPhase | null {
  return useBucketField(sessionKey, (b) => b.sessionPhase);
}

export function useBlockedOnFor(sessionKey: string | null): readonly BlockedOnEntry[] {
  return useBucketField(sessionKey, (b) => b.blockedOn);
}

export function useQueueFor(sessionKey: string | null): QueueState {
  return useBucketField(sessionKey, (b) => b.queue);
}

export function useStreamingDraftFor(sessionKey: string | null): StreamingDraft | null {
  return useBucketField(sessionKey, (b) => b.streamingDraft);
}

export function useSessionListFor(sessionKey: string | null): readonly SessionListEntry[] | null {
  return useBucketField(sessionKey, (b) => b.sessionList);
}

// ---- Choice-page hooks ----------------------------------------------------

/** User-saved work directories — mirror of `bridge/state.json`
 *  `work_dirs[]`. Empty array until the first `work_dir_list` reply
 *  lands (ChoicePage level=1 fires the initial query on mount). */
export function useWorkDirs(): readonly string[] {
  return useWsState((c) => c.workDirs);
}

/** Current URL hash `work_dir`. Mirrors the hash so the ChoicePage's
 *  outbound commands can read it off the store instead of re-parsing
 *  the URL. `null` when the hash has no `work_dir`. */
export function useCurrentWorkDir(): string | null {
  return useWsState((c) => c.currentWorkDir);
}

/** Sessions under the current session's `work_dir` (ChoicePage
 *  level=2 list — but since level=2 is reached when there's no
 *  session in the URL, this effectively reads from the M3_LEGACY
 *  bucket's sessionList mirror). `null` until the first
 *  `session_list` reply arrives (so the ChoicePage can show a
 *  loading state vs an empty list). The array is replaced
 *  wholesale on every reply. */
export function useSessionList(): readonly SessionListEntry[] | null {
  return useWsState((c) => c.sessionList);
}

/** Subscribe to dialog-expired notices (command_result with
 *  `error.code === 'request_expired'`). Used by DialogHost to map
 *  late submissions back to the originating dialog. */
export function useDialogExpiredSubscription(handler: DialogExpiredHandler): void {
  const client = useWsClient();
  useEffect(() => {
    const unsub = client.onDialogExpired(handler);
    return unsub;
    // handler intentionally omitted from deps — handlers are
    // typically defined inline; re-subscribing every render would
    // multiply notifications. Callers that need a fresh handler
    // can wrap in useCallback.
  }, [client]);
}

/** Subscribe to ordinary-command error notices — prompt / steer /
 *  follow_up with `command_result{success:false}`. Used by the
 *  InputBar to surface the temporary error banner. The hook only
 *  fires for failures whose `reply_to` matches an envelope id THIS
 *  tab issued — failures with foreign reply_to are silently dropped
 *  at the WsClient layer. */
export function useCommandErrorSubscription(handler: CommandErrorHandler): void {
  const client = useWsClient();
  useEffect(() => {
    const unsub = client.onCommandError(handler);
    return unsub;
    // Same rationale as useDialogExpiredSubscription — handler is
    // intentionally omitted from the dep array.
  }, [client]);
}

// Re-exported for components that want to bind `client.on(type, handler)`
// inside their own useEffect (rather than going through `useWsState`).
export type {
  EnvelopeHandler,
  DialogExpiredHandler,
  DialogExpiredNotice,
  CommandErrorHandler,
  CommandErrorNotice,
  BlockedOnEntry,
  SessionBucket,
};
