// DO heartbeat tick — module boundary kept thin so room.ts owns state, and
// this module owns only the loop cadence and the constant numbers from
// control.md §配套常量.
//
// Numbers:
//   PING_INTERVAL_MS       = 20_000   (control.md §2)
//   PONG_TIMEOUT_MS        = 30_000   (control.md §3)
//   MAX_MISSED_PONGS       = 3        (control.md §3)
//   HANDSHAKE_TIMEOUT_MS   = 5_000    (control.md §1)
//
// Heartbeat semantics (control.md §2 备注):
//   - DO sends its own `control/ping` to every open connection every 20s,
//     carrying a fresh nonce.
//   - DO waits up to 30s for a matching `control/pong` with the same nonce.
//   - Three consecutive timeouts → close the connection (code 1000, reason
//     "stale"). If the closed connection was the bridge, broadcast
//     `bridge_status{online:false, reason:"stale"}`.
//
// Note: only pongs carrying the DO's nonce count toward liveness. A pong
// that responds to a peer's forwarded ping is forwarded on; the DO does
// not count it as the heartbeat being satisfied (otherwise a bridge that
// forwards a web's ping/pong pair would never be detected as stale).
import type { Room } from './room.js';

export const PING_INTERVAL_MS = 20_000;
export const PONG_TIMEOUT_MS = 30_000;
export const MAX_MISSED_PONGS = 3;
/** Handshake window — 5s per control.md §1. Lives here so all per-connection
 *  timing constants are grep-able from one place; room.ts re-uses this for
 *  the handshake-timer setup in `fetch()`. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** Start the heartbeat loop inside `blockConcurrencyWhile` so the timer is
 *  registered before the DO begins serving requests. The Room re-runs this
 *  on every cold start, but `setInterval` ids are per-instance so this is
 *  safe — the runtime tears the timer down when the DO evicts. */
export function startHeartbeat(room: Room): void {
  // Trigger one immediate tick after the first interval — there is nothing to
  // ping on a freshly-bootstrapped DO, so we wait for the first interval
  // before doing any work. The loop is self-sustaining.
  setInterval(() => {
    // Fire-and-forget: tickHeartbeat owns its own try/catch and will surface
    // failures via `error(internal)` to the offending connections.
    void room.tickHeartbeat();
  }, PING_INTERVAL_MS);
}