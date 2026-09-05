// App root — owns:
//   1. The single WsClient instance (memoized for StrictMode safety).
//   2. The hash → token derivation. URL convention is `#<token>`; when no
//      token is present we render the TokenPrompt, otherwise the live UI.
//   3. The connect/disconnect lifecycle tied to token presence.
//   4. The M3 dual-query recovery gate between token-present and the
//      chat surface (task 07 — PRD §4.4).
//
// The URL hash is the single source of truth for the token. The TokenPrompt
// writes `window.location.hash` and triggers a `hashchange` event which
// re-derives `token`. On token change we call `client.connect(newToken)`,
// which internally closes the existing socket and opens a fresh one — so
// swapping tokens (or pasting a wrong one and then the right one) Just
// Works without leaking two parallel sockets.
//
// M3 routing (task 06 + task 07):
//   - token absent → TokenPrompt.
//   - token present → RecoveryView → ChatView (only after the
//     dual-query ceremony's `get_state` + `get_messages` replies
//     have both landed; the gate is the single source of truth
//     for the render decision).
//   - On the gate flipping to `error`, RecoveryView shows a
//     "恢复失败" card with a retry button that re-fires the
//     dual queries. F5 takes the same path — a fresh mount
//     builds a fresh gate, runs the ceremony once, and only
//     renders ChatView on success.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';

import { ChatView } from './components/ChatView.js';
import { StatusBar } from './components/StatusBar.js';
import { TokenPrompt } from './components/TokenPrompt.js';
import { WsClient, type ConnState } from './ws/WsClient.js';
import { useConnState, useWsClient, WsClientProvider } from './ws/WsClientContext.js';
import { initiateRecovery, type RecoveryError, type RecoveryGate } from './ws/recovery.js';
import { resolveWssUrl } from './ws/config.js';

function readTokenFromHash(): string | null {
  const raw = window.location.hash;
  if (!raw) return null;
  // Strip the leading '#' and any whitespace the user might have pasted.
  const stripped = raw.startsWith('#') ? raw.slice(1) : raw;
  const token = stripped.trim();
  return token.length > 0 ? token : null;
}

export function App() {
  const [token, setToken] = useState<string | null>(() => readTokenFromHash());

  // Hash is the source of truth — listen for both programmatic writes
  // (TokenPrompt submitting) and back/forward navigation. The listener is
  // stable and only depends on `setToken`, which is itself stable.
  useEffect(() => {
    const onHashChange = () => setToken(readTokenFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // One WsClient per mount. Memoized so React StrictMode's double-invoke
  // in dev returns the same instance and we don't end up with two parallel
  // sockets during the probe render.
  const client = useMemo(() => new WsClient(resolveWssUrl()), []);

  // Drive connect/disconnect from token presence. Cleanup also disconnects
  // so StrictMode's mount → unmount → mount cycle doesn't leak an orphan
  // socket between the two mounts.
  useEffect(() => {
    if (token) {
      client.connect(token);
    } else {
      client.disconnect();
    }
    return () => {
      client.disconnect();
    };
  }, [client, token]);

  if (!token) {
    return (
      <WsClientProvider client={client}>
        <TokenPrompt />
      </WsClientProvider>
    );
  }

  // Token present → render the M3 chat surface via the dual-query
  // recovery gate (task 07). The gate is created once per mount and
  // torn down on unmount; its lifecycle is independent of the
  // WsClient's connection state (reconnects are WsClient-internal;
  // a mid-recovery drop shows up as a `both_failed` after the
  // 5s timer fires, and the user can retry).
  return (
    <WsClientProvider client={client}>
      <main className="app-shell">
        <h1>RemotePi</h1>
        <StatusBar />
        <RecoveryShell token={token} />
      </main>
    </WsClientProvider>
  );
}

// ---------------------------------------------------------------------------
// RecoveryShell — owns the single RecoveryGate per mount and renders the
// appropriate view based on its state.
// ---------------------------------------------------------------------------

/** Wire-level entry: one `RecoveryGate` per mount, disposed on
 *  unmount. Pulled out of `<App />` so the gate instance survives
 *  any future re-renders triggered by hash changes / context
 *  consumers below it. The component is intentionally small —
 *  the real gating logic lives in the gate object (`recovery.ts`)
 *  and the renderer (`RecoveryView`) below. */
function RecoveryShell({ token }: { token: string }) {
  const client = useWsClient();
  // `useMemo` is the wrong tool here in StrictMode dev: the factory
  // runs on every mount, so a dev-mode double-invoke would create
  // two gates. The first one is disposed via the cleanup below;
  // the second one is the live one. We pair the `useRef`-backed
  // instance with a `useEffect` cleanup to keep StrictMode honest.
  const gateRef = useGateRef(client);
  useEffect(() => {
    return () => {
      // Dispose on unmount (StrictMode first-mount teardown +
      // real unmount on token revocation). The gate's timers +
      // reply-resolver subscriptions are released; subsequent
      // `retry()` calls become no-ops.
      gateRef.dispose();
    };
  }, [gateRef]);
  return <RecoveryView gate={gateRef} token={token} />;
}

/** Stable-per-mount gate factory: a real `useRef` (not `useMemo`)
 *  avoids the StrictMode-double-invoke trap — `useMemo`'s factory
 *  re-runs on every render, which would create two gates under
 *  StrictMode dev. `useRef`'s initial value is computed once and
 *  reused for the lifetime of the component instance. The factory
 *  closes over the client from the current render; token changes
 *  don't re-create the gate — see `RecoveryView` for the auto-start
 *  contract that re-fires the ceremony on token change. */
function useGateRef(client: WsClient): RecoveryGate {
  const ref = useRef<RecoveryGate | null>(null);
  if (ref.current === null) {
    ref.current = initiateRecovery(client);
  }
  return ref.current;
}

// ---------------------------------------------------------------------------
// RecoveryView — the visible surface for the gate's three states.
// ---------------------------------------------------------------------------

/** Three render paths driven by the gate's `ready` / `error` pair:
 *    - ready=true  → mount the chat surface (ChatView + DialogHost etc.)
 *    - error!==null → "恢复失败" card with a retry button
 *    - otherwise (in-flight) → "恢复中…" placeholder
 *
 *  The first start is gated on `connState === 'online'` so the
 *  dual queries don't fire before the WebSocket is open (the
 *  WsClient's `send` silently drops when the socket isn't open;
 *  deferring avoids an immediate 5s timer-fail on cold start).
 *
 *  `autoStartConsumedRef` records the token under which the
 *  auto-start has already fired. Token changes are a re-connect
 *  signal (the worker rooms are keyed by token; see architecture
 *  note below), so the effect re-fires the ceremony on each
 *  fresh-token → online transition — matching PRD §4.4's
 *  "every (re)connect fires the dual-query ceremony" contract.
 *  WsClient-internal reconnects (offline → connecting → online
 *  for the SAME token) are intentionally NOT re-fired: only a
 *  token change (or the user pressing retry / F5) restarts the
 *  ceremony. F5 is still the way to fully reset (which re-mounts
 *  everything and gets a fresh `autoStartConsumedRef`).
 *
 *  Architecture note: the worker DO rooms are keyed by token, so
 *  a token swap in the same tab logically hands off to a fresh
 *  bridge session — the old `get_messages` / `get_state` replies
 *  (if any were in flight from the previous session) belong to a
 *  different room and would never arrive on this socket anyway.
 *  Re-firing the ceremony on token change is the only correct
 *  behaviour; otherwise the gate would latch onto `error` from a
 *  stale 5s timer firing against a socket that's now serving a
 *  different room. `gate.retry()` itself calls `cancelActive()`,
 *  so any in-flight ceremony's timers + reply-resolvers are
 *  torn down before the fresh pair of dual queries goes out. */
function RecoveryView({ gate, token }: { gate: RecoveryGate; token: string }) {
  const connState = useConnState();
  // `useSyncExternalStore` expects subscribe/getSnapshot to be free
  // of `this` binding (React calls them as bare functions). The gate
  // is a plain object — its methods are technically unbound — so we
  // wrap them in arrows to satisfy `@typescript-eslint/unbound-method`
  // and to make the React contract explicit at the call site.
  const view = useSyncExternalStore(
    (listener) => gate.subscribe(listener),
    () => gate.getSnapshot(),
  );
  // Render-stable ref so the auto-start effect doesn't re-run on
  // every gate transition (the gate instance is stable for the
  // mount lifetime).
  const gateRef = useMemo(() => ({ current: gate }), [gate]);
  // Records the token under which the auto-start ceremony has
  // already fired. `null` on first render (no ceremony yet); set
  // to the token string once we fire. On token change the effect
  // detects the mismatch and re-fires — the gate's `retry()`
  // handles the cancel-and-restart of any in-flight ceremony.
  const autoStartConsumedRef = useRef<string | null>(null);

  // First attempt per token: wait for the WebSocket to be open so
  // the dual queries actually go out. Token changes re-arm the
  // guard so a fresh token → online transition starts a new
  // ceremony. The retry button (and F5) drive subsequent
  // attempts manually — the WsClient drops `send()` if the
  // socket is closed and the 5s timer will catch the no-reply
  // case.
  useEffect(() => {
    if (connState !== 'online') return;
    if (autoStartConsumedRef.current === token) return;
    autoStartConsumedRef.current = token;
    gateRef.current.retry();
  }, [connState, gateRef, token]);

  if (view.ready) {
    return <ChatView />;
  }
  if (view.error !== null) {
    return <RecoveryErrorCard error={view.error} onRetry={() => gate.retry()} />;
  }
  return <RecoveryInFlight connState={connState} />;
}

// ---------------------------------------------------------------------------
// RecoveryInFlight — the placeholder shown while the dual-query ceremony
// is in flight. Pure presentational; no client state beyond what the
// StatusBar already surfaces.
// ---------------------------------------------------------------------------

function RecoveryInFlight({ connState }: { connState: ConnState }) {
  return (
    <section className="card recovery-in-flight" aria-busy="true" aria-live="polite">
      <h2>恢复中…</h2>
      <p>
        正在拉取会话状态与历史消息（5 秒超时）。
        {connState !== 'online' ? <span>（等待 WebSocket 连接…）</span> : null}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// RecoveryErrorCard — "恢复失败" surface with a manual retry button. The
// three-way error discriminator maps to a short user-visible hint; the
// longer operator-facing detail (PRD §6.4验收) lives in the per-error
// JSDoc on `RecoveryError`.
// ---------------------------------------------------------------------------

function RecoveryErrorCard({ error, onRetry }: { error: RecoveryError; onRetry: () => void }) {
  return (
    <section className="card recovery-error" role="alert" data-error={error}>
      <h2>恢复失败</h2>
      <p>{errorHint(error)}</p>
      <button type="button" onClick={onRetry}>
        重试
      </button>
    </section>
  );
}

function errorHint(error: RecoveryError): string {
  switch (error) {
    case 'snapshot_failed':
      return '无法拉取历史消息（snapshot 超时或返回失败）。请检查网络后重试。';
    case 'state_failed':
      return '无法拉取会话状态（get_state 超时或返回失败）。请检查网络后重试。';
    case 'both_failed':
      return '无法拉取会话状态与历史消息。请检查网络后重试，或刷新页面重连。';
    default:
      return '恢复失败，请重试。';
  }
}
