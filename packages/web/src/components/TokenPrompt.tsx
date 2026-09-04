// TokenPrompt — first screen when no `#<token>` is present in `location.hash`.
// The web URL convention is `https://web.remote-pi.sankabox.com/#<token>`:
// the hash carries the access token so it never lands in a server access log
// or browser history (only `history.pushState`-style navigations across
// pages with the same hash would surface it; here we use a direct write).
//
// Submission flow:
//   1. User pastes the token.
//   2. We write it into `location.hash`.
//   3. App's `hashchange` listener picks it up and asks WsClient to connect.

import { useState } from 'react';

export function TokenPrompt() {
  const [value, setValue] = useState('');

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = value.trim();
    if (!token) return;
    // Writing the hash triggers a `hashchange` event on `window` which the
    // App-level effect listens to. We deliberately do NOT call the WsClient
    // directly here — keeping the URL the single source of truth makes the
    // back button and link-sharing behave consistently.
    window.location.hash = token;
  };

  return (
    <section className="card token-prompt" aria-labelledby="token-prompt-title">
      <h2 id="token-prompt-title">Connect to your bridge</h2>
      <p>
        Paste the access token printed by your bridge. The token lives in the
        URL fragment so it never reaches the server in a request body.
      </p>
      <form onSubmit={onSubmit}>
        <label htmlFor="token-input">Access token</label>
        <input
          id="token-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="paste token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" disabled={value.trim().length === 0}>
          Connect
        </button>
      </form>
    </section>
  );
}
