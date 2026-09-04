// BroadcastLog — the catch-all envelope inspector. Lists every successfully
// parsed inbound envelope (time / kind / type / id / payload summary),
// capped at 200 rows. Newest at the top so the user sees live activity
// without scrolling.
//
// Payload summary: JSON.stringify, truncated to 200 characters. The
// truncation is purely cosmetic for the table — full payloads stay in
// `WsClient.logs` and can be inspected by attaching a temporary listener
// during debugging.

import { useBroadcastLog } from '../ws/WsClientContext.js';

const PAYLOAD_PREVIEW_CHARS = 200;

export function BroadcastLog() {
  const logs = useBroadcastLog();

  // Newest first.
  const ordered = [...logs].reverse();

  return (
    <section className="card broadcast-log" aria-labelledby="broadcast-log-title">
      <h2 id="broadcast-log-title">Broadcast log</h2>
      <p>
        Inbound envelopes from the worker. Buffer caps at 200 rows — older
        entries roll off as new ones arrive.
      </p>
      <table className="log-table">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Kind</th>
            <th scope="col">Type</th>
            <th scope="col">ID</th>
            <th scope="col">Payload</th>
          </tr>
        </thead>
        <tbody>
          {ordered.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty">
                No inbound envelopes yet.
              </td>
            </tr>
          ) : (
            ordered.map((entry) => (
              <tr key={entry.receivedAt + ':' + entry.envelope.id}>
                <td>{formatTime(entry.receivedAt)}</td>
                <td>{entry.envelope.kind}</td>
                <td>{entry.envelope.type}</td>
                <td><code>{entry.envelope.id}</code></td>
                <td><code>{summarizePayload(entry.envelope)}</code></td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

function summarizePayload(envelope: { payload: unknown }): string {
  try {
    const json = JSON.stringify(envelope.payload);
    if (json.length <= PAYLOAD_PREVIEW_CHARS) return json;
    return json.slice(0, PAYLOAD_PREVIEW_CHARS) + '…';
  } catch {
    return '[unserializable payload]';
  }
}
