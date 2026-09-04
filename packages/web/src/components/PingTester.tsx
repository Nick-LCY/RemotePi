// PingTester — manual control/ping button + RTT readout. Every click asks
// WsClient to send a ping with a fresh nonce; the matching pong is
// correlated by nonce inside WsClient and the resulting round-trip lands
// in `pingHistory`. The component is purely a renderer over that buffer
// (with a local "last sent nonce" hint so the user sees something happen
// before the round trip completes).
//
// The ping is also subject to WsClient's "3 strikes" failure policy — if
// the worker drops off, the manual ping will eventually show as
// "timed out" and the underlying socket will be closed for reconnect.

import { useWsClient, usePingHistory } from '../ws/WsClientContext.js';

export function PingTester() {
  const client = useWsClient();
  const history = usePingHistory();

  const onSend = () => {
    if (client.connState !== 'online') {
      // Surface to the user that pings are pointless without a connection,
      // rather than silently dropping. PingTester never auto-sends.
      return;
    }
    client.sendManualPing();
  };

  // Newest first — most recent probe at the top.
  const ordered = [...history].reverse();

  return (
    <section className="card ping-tester" aria-labelledby="ping-tester-title">
      <h2 id="ping-tester-title">Ping tester</h2>
      <p>
        Sends a control/ping with a fresh nonce and reports the round-trip on
        the matching pong.
      </p>
      <button type="button" onClick={onSend} disabled={client.connState !== 'online'}>
        Send ping
      </button>
      <table className="ping-history">
        <thead>
          <tr>
            <th scope="col">Nonce</th>
            <th scope="col">RTT (ms)</th>
          </tr>
        </thead>
        <tbody>
          {ordered.length === 0 ? (
            <tr>
              <td colSpan={2} className="empty">
                No pings yet.
              </td>
            </tr>
          ) : (
            ordered.map((entry) => (
              <tr key={entry.nonce + ':' + entry.sentAt} className={entry.rttMs === null ? 'timed-out' : ''}>
                <td><code>{entry.nonce}</code></td>
                <td>{entry.rttMs === null ? 'timed out' : entry.rttMs}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
