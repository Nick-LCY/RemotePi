// App root — owns:
//   1. The single WsClient instance (memoized for StrictMode safety).
//   2. The hash → token derivation. URL convention is `#<token>`; when no
//      token is present we render the TokenPrompt, otherwise the live UI.
//   3. The connect/disconnect lifecycle tied to token presence.
//
// The URL hash is the single source of truth for the token. The TokenPrompt
// writes `window.location.hash` and triggers a `hashchange` event which
// re-derives `token`. On token change we call `client.connect(newToken)`,
// which internally closes the existing socket and opens a fresh one — so
// swapping tokens (or pasting a wrong one and then the right one) Just
// Works without leaking two parallel sockets.
//
// M3 routing (task 06 + task 07):
//   - token absent → TokenPrompt (existing).
//   - token present → ChatView (M3 main surface) — task 06.
//   - task 07 introduces a RecoveryView wrapper between token-present
//     and ChatView; it runs the dual-query recovery ceremony (PRD §4.4)
//     and only mounts ChatView once both `get_state` and `get_messages`
//     have landed. Until task 07 lands, ChatView mounts directly (with
//     a brief "awaiting first session_state…" PhaseIndicator hint
//     while the WsClient is warming up).

import { useEffect, useMemo, useState } from 'react';

import { ChatView } from './components/ChatView.js';
import { StatusBar } from './components/StatusBar.js';
import { TokenPrompt } from './components/TokenPrompt.js';
import { WsClient } from './ws/WsClient.js';
import { WsClientProvider } from './ws/WsClientContext.js';
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

  // Token present → render the M3 chat surface directly. Task 07 will
  // wrap ChatView in a RecoveryView that gates on the dual-query
  // ceremony; until then, ChatView's PhaseIndicator handles the
  // "awaiting first session_state" wait state.
  return (
    <WsClientProvider client={client}>
      <main className="app-shell">
        <h1>RemotePi</h1>
        <StatusBar />
        <ChatView />
      </main>
    </WsClientProvider>
  );
}
