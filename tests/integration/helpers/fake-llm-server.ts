// Fake Anthropic Messages API server for integration tests
// (see ADR-0008 §1 进程内假 LLM server 段).
//
// Spawns a Node `http.createServer` bound to `127.0.0.1:0` (random
// free port) and serves a scripted sequence of SSE responses. The
// server is hermetic — it rejects any request whose model name does
// NOT start with `fake-claude-` (fail-fast guard against the host's
// real provider keys accidentally landing in the spawn env and
// silently routing to a real provider) and refuses connections from
// non-loopback addresses (defense in depth against any future change
// that swaps `127.0.0.1` for `0.0.0.0`).
//
// ## Wire shape (verified against pi 0.85.1 / Anthropic SDK)
//
// Request:
//   POST /v1/messages
//   headers: content-type:application/json, x-api-key, anthropic-version
//   body: { model, max_tokens, messages: [...] }
//
// Response (success): SSE stream with `event: <name>\ndata: <json>\n\n`
// frames. Required first frame is `message_start`; required last is
// `message_stop`. See `sseEvent` + the `textReply`/`toolUseReply`
// factories for the canonical sequences.
//
// Response (error): JSON `{type:"error",error:{type,message}}` with
// a non-200 status. Pi normalises this into an `error: string` on
// its `response` frame; the bridge's `normalizePiError` then maps
// that into `{code:'pi_error', message}` on the outbound
// `command_result`. See `scriptError` for the helper.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnthropicRequest {
  /** Parsed JSON body of the request. */
  body: {
    model?: string;
    max_tokens?: number;
    messages?: Array<{ role?: string; content?: unknown }>;
    [k: string]: unknown;
  };
  /** Raw body text (for assertions on exact wire bytes if needed). */
  raw: string;
  /** Client-supplied headers we care about for assertions. */
  headers: { 'x-api-key'?: string; 'anthropic-version'?: string };
}

export interface SseEvent {
  /** The SSE event name (becomes the `event:` line on the wire). */
  event: string;
  /** JSON-encoded data payload (becomes the `data: <json>\n\n` line). */
  data: unknown;
}

/**
 * Scripted response entry. The four kinds compose:
 *   - `reply`: full SSE stream to send as the body of the HTTP response.
 *   - `error`: JSON error body + non-200 status (Anthropic error shape).
 *   - `pause`: sleep N ms before responding (realistic latency model).
 *
 * Test code commonly calls the shorthand factories (`textReply`,
 * `toolUseReply`) which return a `SseEvent[]`; the `script()` method
 * accepts that form directly and wraps it as `{ kind: 'reply', reply }`.
 */
export type ScriptEntry =
  | { kind: 'reply'; reply: SseEvent[] }
  | {
      kind: 'error';
      status: number;
      body: { type: 'error'; error: { type: string; message: string } };
    }
  | { kind: 'pause'; ms: number };

/** Function form: return the next entry based on the incoming request. */
export type ScriptFn = (req: AnthropicRequest) => ScriptEntry | SseEvent[];

export interface FakeLlmServerOptions {
  /**
   * If set, the server replies 401 to requests whose `x-api-key` header
   * does NOT match this value. Default: unset (no auth check). The
   * bridge fixture injects a known fake key via `auth.json` so most
   * tests don't need this; set it when verifying auth wiring.
   */
  expectedApiKey?: string;
  /**
   * If `true` (default), the server rejects connections from any
   * non-loopback address with ECONNRESET. This guards against
   * accidental binding to `0.0.0.0` in a future refactor.
   */
  enforceLoopback?: boolean;
  /**
   * When `true`, the server awaits a `setImmediate` between each SSE
   * event within a single reply. Default: `false` — all events are
   * flushed in one TCP write so a fast WsClient (and React's
   * batching) sees the final state without intermediate renders.
   *
   * The E2E suite enables this so scenario (a)'s multi-delta
   * streaming assertion can actually OBSERVE intermediate draft
   * lengths (each event gets its own microtask, giving React a
   * chance to commit between events). The integration suite leaves
   * it off — its assertions are about end-state behavior, not
   * observable streaming, and the latency is wasted budget.
   */
  flushEachEvent?: boolean;
}

export interface FakeLlmServer {
  /** Full URL the server is listening on (e.g. `http://127.0.0.1:34567`). */
  url: string;
  /** Port the server is bound to. */
  port: number;
  /** Recorded requests in arrival order. Each entry captures parsed body + headers. */
  requests: AnthropicRequest[];
  /**
   * Install a scripted sequence of responses. The script is consumed
   * FIFO: each request consumes the next entry. When the script runs
   * out, subsequent requests receive a default `textReply("ok")`.
   *
   * Accepted entry shapes:
   *   - `SseEvent[]` (e.g. `textReply(...)` output) — auto-wrapped as
   *     a single reply entry.
   *   - `ScriptEntry` — explicit wrapper form.
   *   - Array of either — FIFO queue.
   *   - Function `(req) => ...` — per-request dispatch.
   */
  script: (
    entries: SseEvent[] | ScriptEntry | SseEvent[][] | ScriptEntry[] | ScriptFn,
  ) => void;
  /** Inject a one-shot error response (consumed by the next request, then cleared). */
  scriptError: (status: number, body: { type: 'error'; error: { type: string; message: string } }) => void;
  /** Reset the script + recorded requests to empty. */
  reset: () => void;
  /** Close the server. Idempotent. */
  close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// SSE event builders (verified against Anthropic Messages API contract)
// ---------------------------------------------------------------------------

/** Emit a `message_start` event with the required top-level fields. */
export function sseMessageStart(opts: {
  messageId: string;
  model: string;
  inputTokens: number;
}): SseEvent {
  return {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: opts.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: opts.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: opts.inputTokens, output_tokens: 0 },
      },
    },
  };
}

export function sseContentBlockStart(opts: { index: number; block: unknown }): SseEvent {
  return {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: opts.index, content_block: opts.block },
  };
}

export function sseContentBlockDelta(opts: { index: number; delta: unknown }): SseEvent {
  return {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: opts.index, delta: opts.delta },
  };
}

export function sseContentBlockStop(opts: { index: number }): SseEvent {
  return { event: 'content_block_stop', data: { type: 'content_block_stop', index: opts.index } };
}

export function sseMessageDelta(opts: {
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  outputTokens: number;
}): SseEvent {
  return {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: opts.stopReason, stop_sequence: null },
      usage: { output_tokens: opts.outputTokens },
    },
  };
}

export function sseMessageStop(): SseEvent {
  return { event: 'message_stop', data: { type: 'message_stop' } };
}

/** Convenience: full 6-event sequence for a plain text reply.
 *  Matches the SSE shape pinned in ADR-0008 §1 SSE 事件序列铁律:
 *    message_start → content_block_start → content_block_delta
 *    → content_block_stop → message_delta → message_stop.
 */
export function textReply(
  text: string,
  opts: { messageId?: string; model?: string; inputTokens?: number } = {},
): SseEvent[] {
  const messageId = opts.messageId ?? `msg_${Math.random().toString(36).slice(2, 10)}`;
  const model = opts.model ?? 'fake-claude-haiku-4-5';
  const inputTokens = opts.inputTokens ?? 10;
  return [
    sseMessageStart({ messageId, model, inputTokens }),
    sseContentBlockStart({ index: 0, block: { type: 'text', text: '' } }),
    sseContentBlockDelta({ index: 0, delta: { type: 'text_delta', text } }),
    sseContentBlockStop({ index: 0 }),
    sseMessageDelta({ stopReason: 'end_turn', outputTokens: 1 }),
    sseMessageStop(),
  ];
}

/** Convenience: tool_use block reply with the given input. */
export function toolUseReply(opts: {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  messageId?: string;
  model?: string;
  inputTokens?: number;
}): SseEvent[] {
  const messageId = opts.messageId ?? `msg_${Math.random().toString(36).slice(2, 10)}`;
  const model = opts.model ?? 'fake-claude-haiku-4-5';
  const inputTokens = opts.inputTokens ?? 10;
  return [
    sseMessageStart({ messageId, model, inputTokens }),
    sseContentBlockStart({
      index: 0,
      block: { type: 'tool_use', id: opts.toolId, name: opts.toolName, input: {} },
    }),
    sseContentBlockDelta({
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(opts.input) },
    }),
    sseContentBlockStop({ index: 0 }),
    sseMessageDelta({ stopReason: 'tool_use', outputTokens: 1 }),
    sseMessageStop(),
  ];
}

// ---------------------------------------------------------------------------
// Server implementation
// ---------------------------------------------------------------------------

/** Read the request body as a UTF-8 string. Reuses the chunk-
 *  accumulation pattern from the main /v1/messages handler so any
 *  future tweaks (max body size, encoding) live in one place. */
async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf: Buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk)
        : Buffer.from(chunk as ArrayBufferLike);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Validate a single SSE event shape: `{ event: string, data: any }`.
 *  Returns the validated event or null. We deliberately accept any
 *  JSON-serializable `data` — the LLM client (pi) only reads the
 *  JSON, not its runtime shape. */
function parseSseEvent(raw: unknown): SseEvent | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.event !== 'string' || obj.event.length === 0) return null;
  // `data` may be any JSON value (object, array, primitive, string).
  // We pass through verbatim — SseEvent's data is `unknown`.
  return { event: obj.event, data: obj.data };
}

/** Validate one ScriptEntry from the admin endpoint body. Returns
 *  the entry or null. Three valid shapes:
 *    - `{kind:'reply',  reply: SseEvent[]}`
 *    - `{kind:'error',  status:number, body:{type:'error', error:{type,message}}}`
 *    - `{kind:'pause',  ms:number}`
 *  Anything else returns null; the caller rejects the whole body. */
function parseScriptEntry(raw: unknown): ScriptEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'reply') {
    if (!Array.isArray(obj.reply)) return null;
    const reply: SseEvent[] = [];
    for (const ev of obj.reply) {
      const parsed = parseSseEvent(ev);
      if (parsed === null) return null;
      reply.push(parsed);
    }
    return { kind: 'reply', reply };
  }
  if (obj.kind === 'error') {
    if (typeof obj.status !== 'number' || obj.status < 100 || obj.status > 599) return null;
    const body = obj.body as Record<string, unknown> | undefined;
    if (body === undefined) return null;
    if (body.type !== 'error') return null;
    const errorObj = body.error as Record<string, unknown> | undefined;
    if (errorObj === undefined) return null;
    if (typeof errorObj.type !== 'string' || typeof errorObj.message !== 'string') return null;
    return {
      kind: 'error',
      status: obj.status,
      body: {
        type: 'error',
        error: { type: errorObj.type, message: errorObj.message },
      },
    };
  }
  if (obj.kind === 'pause') {
    if (typeof obj.ms !== 'number' || obj.ms < 0 || !Number.isFinite(obj.ms)) return null;
    return { kind: 'pause', ms: obj.ms };
  }
  return null;
}

/** POST /__e2e/script — inject a scripted sequence of responses.
 *  Body: `{ entries: ScriptEntry[] }`. Validates each entry;
 *  rejects the whole body if any entry is malformed. On success,
 *  REPLACES the current script queue (NOT appends — explicit
 *  semantics so a spec that runs twice doesn't get stale entries
 *  from the first run). Returns `{ok:true, count:N}` or a 4xx
 *  with the failure reason.
 *
 *  Takes a getter+setter pair for the script ref because the
 *  `script` closure variable lives inside `startFakeLlmServer` —
 *  this helper is module-scope so it can be reused, but it must
 *  not capture a stale reference (re-assignment via `script = …`
 *  inside this function would shadow the outer variable). */
async function handleScriptInjection(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  setScript: (next: ScriptEntry[]) => void,
): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'body must be an object' }));
    return;
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.entries)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'body.entries must be an array' }));
    return;
  }
  const entries: ScriptEntry[] = [];
  for (let i = 0; i < obj.entries.length; i += 1) {
    const entry = parseScriptEntry(obj.entries[i]);
    if (entry === null) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: `entry[${i}] is malformed (expected {kind:'reply'|'error'|'pause', ...})`,
        }),
      );
      return;
    }
    entries.push(entry);
  }
  // REPLACE the script queue. Existing queued entries are
  // discarded — the spec's intent is "the next N LLM calls get
  // these responses", and accumulating across spec invocations
  // would cause cross-spec bleed (scenario b reload sees scenario
  // a's queued entries, etc.).
  setScript(entries);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, count: entries.length }));
}

/** GET /__e2e/requests — return a JSON snapshot of every request
 *  the server has received (across all spec invocations during the
 *  server's lifetime; not reset on script replacement). Used for
 *  post-mortem assertion — the spec can grab the recorded requests
 *  via fetch() rather than rely on the parent's local closure
 *  state (which the spec doesn't have). */
function handleRequestsDump(
  res: http.ServerResponse,
  recorded: AnthropicRequest[],
): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, requests: recorded }));
}

/**
 * Start a fake LLM server bound to `127.0.0.1:0`.
 *
 * The returned `FakeLlmServer` exposes `url` / `port` for fixture
 * assembly (the agent-dir's `models.json` references the server's URL)
 * and a `script(...)` helper to install scripted responses.
 */
export async function startFakeLlmServer(
  options: FakeLlmServerOptions = {},
): Promise<FakeLlmServer> {
  const enforceLoopback = options.enforceLoopback ?? true;
  const flushEachEvent = options.flushEachEvent ?? false;
  const requests: AnthropicRequest[] = [];
  // The script queue is always a `ScriptEntry[]` after normalization.
  // The function form is wrapped on storage to apply the same
  // normalization on each invocation.
  type StoredScript = ScriptEntry[] | ((req: AnthropicRequest) => ScriptEntry | SseEvent[]);
  let script: StoredScript | null = null;
  let oneShotError: { status: number; body: { type: 'error'; error: { type: string; message: string } } } | null = null;

  /** Normalize a single script-function return value into a `ScriptEntry`. */
  function toEntry(raw: ScriptEntry | SseEvent[]): ScriptEntry {
    if (Array.isArray(raw)) return { kind: 'reply', reply: raw };
    return raw;
  }

  const server = http.createServer((req, res) => {
    void (async (): Promise<void> => {
      // Loopback guard: drop non-127.0.0.0/8 connections immediately.
      if (enforceLoopback) {
        const remote = req.socket.remoteAddress ?? '';
        const isLoopback =
          remote === '127.0.0.1' ||
          remote === '::1' ||
          remote === '::ffff:127.0.0.1';
        if (!isLoopback) {
          req.socket.destroy();
          return;
        }
      }

      const url = req.url ?? '';
      // E2E admin endpoints — loopback-only, separate path namespace
      // so they can't collide with the /v1/messages contract. These
      // exist so the E2E harness (which can't import the in-process
      // `script()` / `requests` state) can inject scripted replies +
      // read recorded requests via HTTP. The integration suite
      // (in-process driver) doesn't need them but they're harmless
      // when unused — every request still passes the loopback guard.
      //
      // Path namespacing note (`/__e2e/script` etc.): the spec MUST
      // not start the prompt with `__e2e` because the fake server's
      // URL is `http://127.0.0.1:<port>` and a path collision would
      // mean a future admin endpoint accidentally consumes an LLM
      // call. The path-namespace convention keeps the two surfaces
      // disjoint.
      //
      // Exact-path matching (after stripping the `?query` suffix):
      // we used to do `startsWith('/__e2e/script')` which would
      // happily swallow `/__e2e/scripts` (note the trailing `s`) or
      // `/__e2e/script/foo`, then forward that to the script-
      // injection handler as if it were the canonical path. Split
      // on `?` to peel the query string, then compare the pathname
      // for equality so only the documented endpoints reach the
      // admin handlers. Anything else falls through to the 404
      // branch.
      const pathname = url.split('?', 1)[0] ?? '';
      if (req.method === 'POST' && pathname === '/__e2e/script') {
        await handleScriptInjection(req, res, (next) => {
          script = next;
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/__e2e/requests') {
        handleRequestsDump(res, requests);
        return;
      }
      if (req.method !== 'POST' || !url.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ type: 'error', error: { type: 'not_found', message: `unknown path: ${url}` } }),
        );
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const buf: Buffer =
          typeof chunk === 'string'
            ? Buffer.from(chunk)
            : Buffer.from(chunk as ArrayBufferLike);
        chunks.push(buf);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: AnthropicRequest['body'];
      try {
        parsed = JSON.parse(raw) as AnthropicRequest['body'];
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'invalid JSON' },
          }),
        );
        return;
      }
      const recorded: AnthropicRequest = {
        body: parsed,
        raw,
        headers: {
          'x-api-key': (req.headers['x-api-key'] as string | undefined) ?? undefined,
          'anthropic-version': (req.headers['anthropic-version'] as string | undefined) ?? undefined,
        },
      };
      requests.push(recorded);

      // Fail-fast guard: reject requests whose model is not in our
      // fake-claude-* namespace. This catches the failure mode where
      // the test fixture accidentally lets the host's real provider
      // key bleed into pi's env, which would route to a real LLM.
      const model = typeof parsed.model === 'string' ? parsed.model : '';
      if (!model.startsWith('fake-claude-')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: `fake-llm-server: refusing to handle model "${model}" (expected fake-claude-* prefix) — likely the host's real provider key leaked into the spawn env`,
            },
          }),
        );
        return;
      }

      // Auth check (only when configured).
      if (options.expectedApiKey !== undefined && recorded.headers['x-api-key'] !== options.expectedApiKey) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'invalid x-api-key' },
          }),
        );
        return;
      }

      // One-shot error takes priority over script.
      if (oneShotError !== null) {
        const err = oneShotError;
        oneShotError = null;
        res.writeHead(err.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(err.body));
        return;
      }

      // Compute the next entry. Function form returns one entry per
      // call; array form is FIFO. The function form may return either
      // a `ScriptEntry` or a raw `SseEvent[]` (auto-wrap).
      let entry: ScriptEntry | null = null;
      if (typeof script === 'function') {
        entry = toEntry(script(recorded));
      } else if (script !== null && script.length > 0) {
        entry = script.shift() ?? null;
      }

      // Collapse any pause + first reply/error into the response.
      // Pause entries before the first reply/error delay the response
      // by their cumulative ms; pause entries after the first
      // reply/error are ignored (we only have one HTTP response per
      // request).
      let pendingReply: SseEvent[] | null = null;
      let pendingError: { status: number; body: { type: 'error'; error: { type: string; message: string } } } | null = null;
      let pendingPauseMs = 0;
      if (entry !== null) {
        if (entry.kind === 'reply') {
          pendingReply = entry.reply;
        } else if (entry.kind === 'error') {
          pendingError = { status: entry.status, body: entry.body };
        } else {
          // A lone pause — honour it and fall through to default reply.
          pendingPauseMs = entry.ms;
        }
      }
      const applyPause = (): Promise<void> =>
        pendingPauseMs > 0
          ? new Promise((r) => setTimeout(r, pendingPauseMs))
          : Promise.resolve();

      if (pendingError !== null) {
        await applyPause();
        res.writeHead(pendingError.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(pendingError.body));
        return;
      }
      if (pendingReply === null) {
        // Default fallback — keeps the test progressing instead of
        // hanging on an under-scripted run.
        await applyPause();
        pendingReply = textReply('ok');
      } else {
        await applyPause();
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      for (const ev of pendingReply) {
        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
        // Per-event flush — opt-in via `flushEachEvent: true`.
        // Each `setImmediate` yields one event-loop tick so the
        // WsClient's `onmessage` handler fires once per event and
        // React can commit intermediate states. Without this, a
        // fast local server writes all 5 deltas to the socket in
        // one syscall, the fetch API reads them in one chunk, and
        // `appendStreamingDraft` is called 5x in a single sync tick
        // — React 18's auto-batching then commits only the final
        // state, so the test never observes an intermediate draft
        // length.
        if (flushEachEvent) {
          await new Promise<void>((r) => setImmediate(r));
        }
      }
      res.end();
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return {
    url,
    port,
    requests,
    script: (entries) => {
      if (typeof entries === 'function') {
        script = entries;
        return;
      }
      // Accept: single `SseEvent[]`, single `ScriptEntry`, or an array
      // of either. Normalize to a flat `ScriptEntry[]` queue.
      if (!Array.isArray(entries)) {
        script = [entries];
        return;
      }
      // If the first item is a plain object with `event`+`data`
      // (i.e. an `SseEvent`), the whole array is a single reply's
      // stream. Otherwise treat each item as a separate entry.
      if (entries.length === 0) {
        script = [];
        return;
      }
      const first = entries[0];
      if (
        typeof first === 'object' &&
        first !== null &&
        !Array.isArray(first) &&
        'event' in first &&
        'data' in first &&
        !('kind' in first)
      ) {
        script = [{ kind: 'reply', reply: entries as SseEvent[] }];
      } else {
        script = entries.map((e) => toEntry(e as ScriptEntry | SseEvent[]));
      }
    },
    scriptError: (status, body) => {
      oneShotError = { status, body };
    },
    reset: () => {
      script = null;
      oneShotError = null;
      requests.length = 0;
    },
    close,
  };
}
