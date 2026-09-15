// BridgeStatusBar — compact bridge status indicator for the sidebar footer.
//
// Companion to `SessionStatusBar` (the chat surface's per-session
// row). Two narrower components replaced the previous
// `<StatusBar>` to fit the AppShell double-column layout.
//
// Three conn states map to three colour-coded badges:
//
//   connecting → grey  (WebSocket is opening or handshake in flight)
//   online     → green (handshake accepted + heartbeat alive)
//   offline    → red   (close/error → reconnect scheduled)
//
// `data-testid="bridge-status"` + `data-state` are e2e anchors
// (the spec polls `[data-testid="bridge-status"][data-state=
// "online"]` to wait for the WebSocket to be open before sending
// prompts).

import { useBridgeStatus, useConnState } from '../ws/WsClientContext.js';

const STATE_LABEL: Record<ReturnType<typeof useConnState>, string> = {
  connecting: 'Connecting',
  online: 'Online',
  offline: 'Offline',
};

/** Compact bridge status indicator for the sidebar footer.
 *  Stateless — all data flows from the WsClient store via
 *  `useConnState()` / `useBridgeStatus()`. */
export function BridgeStatusBar(): JSX.Element {
  const state = useConnState();
  const bridge = useBridgeStatus();

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface px-3 py-1.5 text-xs"
      aria-label="Bridge status"
      data-testid="bridge-status"
    >
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.7rem] font-semibold text-white ${
          state === 'online'
            ? 'bg-state-online'
            : state === 'offline'
              ? 'bg-state-offline'
              : 'bg-state-connecting'
        }`}
        data-state={state}
      >
        {STATE_LABEL[state]}
      </span>
      <span className="text-muted">
        {bridge ? (
          <>
            Bridge <strong className="text-text">{bridge.online ? 'reachable' : 'gone'}</strong>
            {' · '}
            {bridge.reason}
          </>
        ) : (
          'Awaiting first bridge_status'
        )}
      </span>
    </div>
  );
}
