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

import { useEffect, useMemo, useState } from 'react';

import { BroadcastLog } from './components/BroadcastLog.js';
import { PingTester } from './components/PingTester.js';
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

  return (
    <WsClientProvider client={client}>
      <main className="app-shell">
        <h1>RemotePi</h1>
        <StatusBar />
        <PingTester />
        <BroadcastLog />
      </main>
    </WsClientProvider>
  );
}
