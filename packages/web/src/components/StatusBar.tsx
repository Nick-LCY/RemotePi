// StatusBar — the persistent header showing connection state and the most
// recent `bridge_status` snapshot. Three connection states map to three
// color-coded badges (PRD §4 / docs/tasks/m2/05-web-components.md):
//
//   connecting → grey  (WebSocket is opening or handshake in flight)
//   online     → green (handshake accepted + heartbeat alive)
//   offline    → red   (close/error → reconnect scheduled)
//
// `bridge_status.changed_at` is the worker-side ISO timestamp from the most
// recent status broadcast (control.md §4). `reason` is also surfaced so the
// user can distinguish a clean close from a heartbeat-induced stale trip.

import { useBridgeStatus, useConnState } from '../ws/WsClientContext.js';

const STATE_LABEL: Record<ReturnType<typeof useConnState>, string> = {
  connecting: 'Connecting',
  online: 'Online',
  offline: 'Offline',
};

export function StatusBar() {
  const state = useConnState();
  const bridge = useBridgeStatus();

  return (
    <header className="status-bar" aria-label="Connection status">
      <span className={`badge badge-${state}`} data-state={state}>
        {STATE_LABEL[state]}
      </span>
      <div className="status-meta">
        {bridge ? (
          <span>
            Bridge <strong>{bridge.online ? 'reachable' : 'gone'}</strong>
            {' · '}
            {bridge.reason}
            {' · '}
            <time dateTime={bridge.changedAt}>{formatTimestamp(bridge.changedAt)}</time>
          </span>
        ) : (
          <span>Awaiting first bridge_status broadcast…</span>
        )}
      </div>
      <p className="status-warning">
        此 URL 含访问令牌，请勿外传
      </p>
    </header>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Use the user's locale for display only; the underlying value stays ISO
  // so screen readers can read it back correctly via the `time` element.
  return d.toLocaleTimeString();
}
