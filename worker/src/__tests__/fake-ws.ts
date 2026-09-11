// Test helper: an in-memory `WebSocket` substitute used by the worker
// Room specs. The Room DO operates on the *server side* of a pair
// (`new WebSocketPair()`) and reaches into the WebSocket via the
// runtime event API (`addEventListener('message' | 'close' | 'error')`)
// plus `send()` and `close()`. None of those touch the network — we
// need an object that lets the test trigger events and capture
// outbound frames.
//
// This file deliberately keeps its scope tight: just enough surface
// for the Room specs to drive every code path (handshake, ping/pong,
// bridge_status broadcasts, stale trips, challenge probes). Anything
// beyond that (binary frames, subprotocol negotiation, etc.) is out
// of scope — the Room never reads those from the server side.
//
// Usage:
//
//   const oldSock = new FakeWebSocket();
//   const newSock = new FakeWebSocket();
//   const oldWs = oldSock.accept();              // returns a WebSocket-typed ref
//   const newWs = newSock.accept();
//   room.fetch(...);                              // use oldWs as the server side
//   newSock.fireMessage({ ... });                 // simulates an inbound frame
//   expect(newSock.sentFrames).toEqual([...]);
//
// We don't construct `WebSocketPair` here (that's a runtime
// primitive only available on the Workers runtime); instead the
// Room is exercised by calling its `fetch` / `webSocketMessage` /
// `webSocketClose` / `webSocketError` methods directly with the
// FakeWebSocket's `accept()`-returned handle.

import type { Role } from '@remotepi/shared';

/** Minimal WebSocket surface needed by Room + tests. Mirrors the
 *  `globalThis.WebSocket` properties Room touches — `accept` /
 *  `addEventListener` / `removeEventListener` / `send` / `close` —
 *  plus test-only fields (`sentFrames`, `closeCalls`, helpers). The
 *  interface is structural enough that `accept()` returns a plain
 *  `WebSocket`-typed reference via a type assertion: Room's type
 *  signatures use the global `WebSocket`, and the FakeWebSocket
 *  implements the full surface that path exercises. */
export class FakeWebSocket {
  /** Frames the Room has sent on this socket, in order. Each entry
   *  is the raw JSON string the Room passed to `ws.send()`. Tests
   *  parse the last entry (or a specific index) to assert on the
   *  Room's outbound behaviour. */
  readonly sentFrames: string[] = [];
  /** `close()` calls captured separately from `fireClose()` (which
   *  fires the registered handlers) so tests can distinguish
   *  "Room asked us to close" from "we told the Room we're closing".
   *  Each entry carries the code + reason the Room passed. */
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  /** Handlers Room registers via `addEventListener`. We use a
   *  typed `Map` keyed by event name so `removeEventListener` works
   *  for symmetry (Room doesn't currently call it, but the real
   *  type signature includes it). */
  private readonly handlers = new Map<string, Set<EventListenerLike>>();

  /** Inbound data — the Room only consumes `string` payloads (the
   *  `webSocketMessage` path rejects binary frames immediately), so
   *  we don't model binary. */
  readyState: 0 | 1 | 2 | 3 = 0;

  /** Optional annotation used by some tests to track the role the
   *  Room is expected to assign to this socket. Doesn't affect
   *  Room behaviour — the real role comes from the
   *  `X-RemotePi-Role` header on the upgrade Request — but it
   *  helps test setup assertions stay readable. */
  role: Role | null = null;

  /** If set, the next `send()` call throws the supplied error
   *  (then resets to null). Used by the "tick send throws" spec to
   *  exercise the per-connection exception isolation in
   *  `tickHeartbeat`. The one-shot shape mirrors how a real socket
   *  would behave under transient I/O failure: the first send
   *  fails, subsequent sends succeed (the underlying transport
   *  recovers). */
  sendThrow: Error | null = null;

  // -------------------------------------------------------------------
  // Room-side surface
  // -------------------------------------------------------------------

  /** Mimic `WebSocketPair`'s server-side `accept()`. Room calls
   *  `server.accept()` immediately after constructing the pair to
   *  register the socket with the runtime; on the FakeWebSocket
   *  it's a no-op marker. Returns a `WebSocket`-typed reference
   *  for callers (Room's `fetch`) that pass it straight through. */
  accept(): WebSocket {
    this.readyState = 1; // OPEN — Room doesn't check, but realism helps.
    // The cast is the seam: the FakeWebSocket implements the full
    // surface Room actually exercises, but TypeScript's `WebSocket`
    // lib type carries dozens of methods we don't need (and would
    // make this file balloon). Cast at the boundary, not at every
    // call site.
    return this as unknown as WebSocket;
  }

  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: EventListenerLike,
  ): void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(
    type: 'message' | 'close' | 'error',
    listener: EventListenerLike,
  ): void {
    this.handlers.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.sendThrow !== null) {
      const err = this.sendThrow;
      this.sendThrow = null;
      throw err;
    }
    this.sentFrames.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    // Mirror the real WebSocket: calling close() flips state and
    // fires the close event synchronously. The runtime path in the
    // Room goes handleDisconnect → standard cleanup, which is what
    // most tests want; for tests that need to assert on the
    // non-close-initiated path (server-side drop) they call
    // `fireClose({ code, reason })` directly without recording a
    // close call.
    this.dispatch('close', { code, reason, wasClean: code === 1000 });
  }

  // -------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------

  /** Fire a message event with a JSON-serialisable payload. The Room
   *  only consumes string frames, so we serialise here — tests
   *  that need raw frame control can pass `__raw` and a string. */
  fireMessage(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.dispatch('message', { data });
  }

  /** Fire a close event WITHOUT recording a close() call — used to
   *  simulate the runtime telling us the socket died (vs. us
   *  calling close() ourselves). */
  fireClose(payload: { code?: number; reason?: string; wasClean?: boolean } = {}): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch('close', payload);
  }

  /** Fire an error event (followed by a close in real life; tests
   *  that need the close must call `fireClose` separately). */
  fireError(): void {
    this.dispatch('error', { message: 'fake ws error' });
  }

  /** Reset all captured state — useful between tests in a shared
   *  setup helper. Doesn't reset `role` / `sendThrow` (those are
   *  per-test configuration). */
  resetCapture(): void {
    this.sentFrames.length = 0;
    this.closeCalls.length = 0;
    this.handlers.clear();
  }

  private dispatch(type: 'message' | 'close' | 'error', payload: unknown): void {
    const set = this.handlers.get(type);
    if (set === undefined) return;
    for (const handler of set) {
      handler(payload);
    }
  }
}

/** Minimal event-listener shape — the Room registers handlers with
 *  `(event) => { ... }`, so we type the handler as a single-arg
 *  callback. We don't model `Event` / `MessageEvent` / `CloseEvent`
 *  formally — Room never reads any field other than `event.data`
 *  for messages and `event.code` / `event.reason` / `event.wasClean`
 *  for closes, and the test helper dispatches those fields
 *  directly. */
type EventListenerLike = (event: unknown) => void;

/** Build a pair of FakeWebSockets and return their Room-usable
 *  `WebSocket`-typed references. Mirrors `new WebSocketPair()` from
 *  the runtime: the first element is the "client" side (test
 *  observation), the second is the "server" side (what the Room
 *  drives). Tests typically only use the server side, but exposing
 *  both keeps the seam uniform with the runtime API. */
export function fakeWebSocketPair(): {
  client: FakeWebSocket;
  server: WebSocket;
} {
  const client = new FakeWebSocket();
  const server = client.accept();
  return { client, server };
}
