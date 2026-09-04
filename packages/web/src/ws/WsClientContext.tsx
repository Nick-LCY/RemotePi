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

import { useContext, useSyncExternalStore, type ReactNode } from 'react';
import { createContext } from 'react';

import {
  WsClient,
  type BridgeStatusInfo,
  type ConnState,
  type EnvelopeHandler,
  type LogEntry,
  type PingHistoryEntry,
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
 */
export function useWsState<T>(selector: (client: WsClient) => T): T {
  const client = useWsClient();
  return useSyncExternalStore(
    client.subscribe,
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

export function useBroadcastLog(): readonly LogEntry[] {
  return useWsState((c) => c.logs);
}

export function usePingHistory(): readonly PingHistoryEntry[] {
  return useWsState((c) => c.pingHistory);
}

// Re-exported for components that want to bind `client.on(type, handler)`
// inside their own useEffect (rather than going through `useWsState`).
export type { EnvelopeHandler };
