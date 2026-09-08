// E2E-only helper: drive the standalone fake LLM server's admin
// endpoints via fetch(). The spec doesn't have direct access to
// the in-process `script()` / `requests` state (the fake server
// runs as a separate child of globalSetup), so the admin
// endpoints at `/__e2e/script` (POST) and `/__e2e/requests`
// (GET) are the typed channel for scripted-response injection
// and request-recording assertions.
//
// The server is bound to 127.0.0.1 only (loopback guard) — every
// admin call here goes through the same node-fetch / undici
// transport the harness uses for the worker. The endpoints are
// deliberately not exposed on the production `/v1/messages`
// namespace (admin path is `/__e2e/*` — see fake-llm-server.ts
// file JSDoc on the namespacing rationale).
//
// Failure semantics: a non-OK HTTP response (4xx/5xx) is treated
// as a spec-setup error (the script wasn't installed, so the next
// LLM call would hit the default fallback and the test would
// silently drift). We throw immediately so the test fails loudly
// rather than producing a misleading "draft never appeared" /
// "request_expired toast missing" failure later in the run.

import type { ScriptEntry } from '../../integration/helpers/fake-llm-server.js';

/** POST /__e2e/script with the given entries. The server REPLACES
 *  its current script queue (NOT appends) — see fake-llm-server.ts
 *  handleScriptInjection JSDoc for the cross-spec-bleed rationale.
 *  Returns the count of entries the server accepted. */
export async function injectScript(
  fakeLlmUrl: string,
  entries: ScriptEntry[],
): Promise<number> {
  const url = `${fakeLlmUrl}/__e2e/script`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(
      `injectScript: server returned ${res.status} ${res.statusText} — ${errBody}`,
    );
  }
  const body = (await res.json()) as { ok: boolean; count: number };
  if (!body.ok) {
    throw new Error(`injectScript: server rejected script (ok=false)`);
  }
  return body.count;
}

/** GET /__e2e/requests — returns the full recorded-request log.
 *  Note: this is a snapshot at fetch-time; the spec shouldn't
 *  expect a stable ordering beyond FIFO (the server pushes in
 *  arrival order). */
export async function fetchRequests(
  fakeLlmUrl: string,
): Promise<Array<{ body: unknown; raw: string; headers: Record<string, string | undefined> }>> {
  const url = `${fakeLlmUrl}/__e2e/requests`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(
      `fetchRequests: server returned ${res.status} ${res.statusText} — ${errBody}`,
    );
  }
  const body = (await res.json()) as {
    ok: boolean;
    requests: Array<{ body: unknown; raw: string; headers: Record<string, string | undefined> }>;
  };
  if (!body.ok) {
    throw new Error(`fetchRequests: server returned ok=false`);
  }
  return body.requests;
}

/** Convenience helper: wait until the fake server has recorded at
 *  least `expected` requests. Useful for "wait for the prompt to
 *  reach the LLM" assertions in scenario (a) multi-delta — the
 *  multi-delta draft only appears AFTER the first LLM request
 *  lands. The poll is bounded by `timeoutMs`; on timeout the
 *  helper throws so the test fails loudly. */
export async function waitForRequestCount(
  fakeLlmUrl: string,
  expected: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requests = await fetchRequests(fakeLlmUrl);
    if (requests.length >= expected) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `waitForRequestCount: expected >= ${expected} requests within ${timeoutMs}ms ` +
      `(last count was ${(await fetchRequests(fakeLlmUrl)).length})`,
  );
}
