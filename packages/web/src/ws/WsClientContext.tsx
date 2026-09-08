// React glue around the framework-free `WsClient`. The client itself is a
// plain class (kept pure for easy reasoning); this module owns the React
// Context + the `useSyncExternalStore`-based subscription helper.
//
// Design notes:
//   - One client per `<App />` mount. The provider just passes the instance
//     through; the App memoizes the instance so React StrictMode's
//     double-mount in dev doesn't create two parallel sockets (each WsClient
//     owns a single WebSocket).
//   - Components subscribe to a *slice* of state via `useWsState`. The
//     helper returns `useSyncExternalStore(subscribe, () => selector(client))`,
//     so each component only re-renders when its slice changes identity.

import { useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createContext } from 'react';
import type { BlockedOnEntryPayload, SessionListEntry, SessionPhase } from '@remotepi/shared';

import {
  WsClient,
  type BridgeStatusInfo,
  type CommandErrorHandler,
  type CommandErrorNotice,
  type ConnState,
  type DialogExpiredHandler,
  type DialogExpiredNotice,
  type EnvelopeHandler,
  type QueueState,
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
 * Subscribe to a derived slice of the WsClient state. Re-renders only when
 * the slice's identity changes (useSyncExternalStore handles the equality
 * check). For primitives like `ConnState` the identity check is trivial; for
 * arrays/objects WsClient emits a new reference on every mutation.
 *
 * Subscribe / getSnapshot stability: `client.subscribe` is an arrow class
 * field on `WsClient` (stable per instance). `getSnapshot` here is wrapped
 * in `useCallback` so its identity is also stable across renders — the
 * selector is captured fresh each render via the inline arrow, but that
 * is harmless because the selector body only reads from its `client`
 * argument (no stale-closure concerns; the `client` instance is itself
 * stable). React's `useSyncExternalStore` doesn't *crash* on a fresh
 * getSnapshot ref each render, but it does re-validate and re-subscribe,
 * so memoising is a free win. The WsClient selectors return store field
 * references directly (e.g. `c.sessionPhase`), so the snapshot identity
 * check is stable as long as the underlying field hasn't been reassigned
 * — see WsClient.setSessionPhase / setBlockedOn / setQueue for the
 * replace-on-change guards that keep no-op updates from re-rendering.
 */
export function useWsState<T>(selector: (client: WsClient) => T): T {
  const client = useWsClient();
  const getSnapshot = useCallback(() => selector(client), [client]);
  return useSyncExternalStore(client.subscribe, getSnapshot);
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

/** Pi subprocess lifecycle phase. `null` until the first `session_state`
 *  or `get_state` reply arrives — PhaseIndicator renders a placeholder
 *  while null (M3 PRD §4.3). */
export function useSessionPhase(): SessionPhase | null {
  return useWsState((c) => c.sessionPhase);
}

/** Pending extension UI requests (dialog queue). Each element is a
 *  full `BlockedOnEntryPayload` discriminated union — dialog components
 *  switch on `entry.method` to pick the matching renderer. The
 *  component re-renders only when the array's identity changes
 *  (WsClient emits a fresh array on every `session_state` broadcast). */
export function useBlockedOn(): readonly BlockedOnEntryPayload[] {
  return useWsState((c) => c.blockedOn);
}

/** Steering / follow-up queue snapshot. */
export function useQueue(): QueueState {
  return useWsState((c) => c.queue);
}

/** Streaming draft — accumulates text_delta events. `null` when no
 *  draft is in flight. */
export function useStreamingDraft(): StreamingDraft | null {
  return useWsState((c) => c.streamingDraft);
}

/** Authoritative message list (history). */
export function useMessages(): readonly unknown[] {
  return useWsState((c) => c.messages);
}

// ---- M4 choice-page hooks (tasks/m4/07) ------------------------------------

/** User-saved work directories — mirror of `bridge/state.json`
 *  `work_dirs[]`. Empty array until the first `work_dir_list` reply
 *  lands (ChoicePage level=1 fires the initial query on mount). */
export function useWorkDirs(): readonly string[] {
  return useWsState((c) => c.workDirs);
}

/** Current URL hash `work_dir` (钉子 1). Mirrors the hash so the
 *  ChoicePage's outbound commands can read it off the store instead
 *  of re-parsing the URL. `null` when the hash has no `work_dir`. */
export function useCurrentWorkDir(): string | null {
  return useWsState((c) => c.currentWorkDir);
}

/** Sessions under the current `work_dir` (ChoicePage level=2 list).
 *  `null` until the first `session_list` reply arrives (so the
 *  ChoicePage can show a loading state vs an empty list). The
 *  array is replaced wholesale on every reply. */
export function useSessionList(): readonly SessionListEntry[] | null {
  return useWsState((c) => c.sessionList);
}

/** Subscribe to dialog-expired notices (command_result with
 *  error.code === 'request_expired'). Used by DialogHost to map late
 *  submissions back to the originating dialog. The hook attaches the
 *  listener for the lifetime of the calling component; callers
 *  typically pass an inline handler that filters on `replyTo` to
 *  locate the right dialog. */
export function useDialogExpiredSubscription(handler: DialogExpiredHandler): void {
  const client = useWsClient();
  useEffect(() => {
    const unsub = client.onDialogExpired(handler);
    return unsub;
    // handler is intentionally not in the dep array — handlers are
    // typically defined inline by callers; re-subscribing every
    // render would multiply notifications. Callers that need a
    // fresh handler can wrap in useCallback.
  }, [client]);
}

/** Subscribe to ordinary-command error notices (PRD §4.5 — prompt /
 *  steer / follow_up with `command_result{success:false}`). Used by
 *  the InputBar to surface the temporary error banner. The hook only
 *  fires for failures whose `reply_to` matches a prompt / steer /
 *  follow_up envelope id THIS tab issued — failures with foreign
 *  reply_to are silently dropped at the WsClient layer. */
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
};
