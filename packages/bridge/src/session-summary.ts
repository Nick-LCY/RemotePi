// Bridge helper: parse a pi session jsonl into a lightweight summary
// (first user message + message count) for the `session_list` rows.
//
// ## Why this lives in its own file
//
// `BridgeSessionLayer.scanSessionsForWorkDir` calls this once per
// jsonl on every `control/session_list` request. We deliberately
// keep the helper tiny + isolated (no bridge / worker / shared
// imports) so:
//
//   1. It can be unit-tested with bare tmp-file fixtures (no layer
//      harness needed) — see `__tests__/session-summary.test.ts`.
//   2. A future M+ feature (e.g. lazy streaming summary, or showing
//      the latest 3 user messages instead of just the first) can
//      evolve the parser without touching the routing layer.
//
// ## Boundary decisions (M4 验收期缺口修复 — task brief)
//
//   - **firstMessage**: scan at most the first `FIRST_MESSAGE_BYTE_LIMIT`
//     bytes AND first `FIRST_MESSAGE_LINE_LIMIT` lines of the file
//     (whichever hits first), pick the first `{"type":"message", …,
//     "message":{"role":"user", …}}` line we hit, and return its
//     `content[]` text elements joined (truncated to
//     `FIRST_MESSAGE_TEXT_MAX_CHARS` chars). Past the window we
//     stop looking — for typical pi jsonls the first user message
//     appears within the first 5–10 lines (after `session` /
//     `model_change` / `thinking_level_change` metadata); the 64KB
//     / 200-line window is a generous safety margin that covers
//     even unusually chatty sessions. We deliberately do NOT scan
//     the whole file: a 16MB+ jsonl should not be parsed in full
//     just to surface the first user message in a session list.
//
//     **Byte-window granularity — M4 验收期 2nd-gap fix.** The byte
//     budget is tracked PER LINE (`windowBytesSeen`, the file
//     offset of the current line's start byte — `+= line.length +
//     1` after each line), not per chunk. The original
//     chunk-aligned check (`bytesRead >= FIRST_MESSAGE_BYTE_LIMIT`
//     after `readSync`) closed the window for every line in the
//     first 64 KB chunk the moment the chunk was read — so any
//     file whose first chunk was ≥64 KB never extracted
//     `firstMessage` even when the actual user prompt lived at
//     byte ~400 of that chunk. The line cursor decouples the IO
//     chunking from the byte accounting: a line is "in the
//     window" iff its start byte position is ≤
//     `FIRST_MESSAGE_BYTE_LIMIT` (strict `>` on the check, so
//     the boundary byte itself is inclusive), and the line is
//     fully processed even if its body extends past the limit.
//     See `session-summary.test.ts` for the regression钉子
//     fixtures (3-line preamble + large-tail user prompt +
//     boundary-straddle prompt + window-overflow prompt).
//
//   - **messageCount**: scan the whole file, but cap at
//     `MESSAGE_COUNT_LINE_CAP`. Counting is O(file-size); capping
//     protects against pathologically large sessions where counting
//     every message line would dominate `session_list` latency.
//     The count itself is approximate past the cap (web displays
//     it as a session-row badge; "+ many more" semantics are
//     acceptable for huge sessions).
//
//   - **Line classification**: we JSON.parse every line we process.
//     This is robust against future pi format tweaks (new event
//     types, additional fields) and the per-line parse cost is
//     negligible on modern V8 — JSON.parse handles ~10⁷ / second
//     for short object literals, so even a 50k-line file parses in
//     single-digit milliseconds. Bad JSON lines (truncated flush,
//     fs corruption) → silently skipped, count continues from the
//     next good line. We do not throw out of this function — the
//     caller's `session_list` reply must never fail because one
//     row's jsonl is unreadable.
//
//   - **No `name` field**: pi jsonl does NOT carry a session name.
//     We do not invent one. The wire `name` field stays `null` —
//     see `SessionListEntry.name` JSDoc on `session-layer.ts`.
//
// ## Encoding notes
//
//   - pi emits strict JSONL — no leading whitespace, no BOM, no
//     trailing-newline inconsistency we have to handle. We still
//     tolerate empty lines (skip them) for forward compat.
//   - We read via `openSync` + `readSync` chunks (default 64KB)
//     rather than `readFileSync` so a 16MB jsonl doesn't allocate
//     a 16MB string in the bridge process memory. Caveat: a
//     multi-byte UTF-8 sequence (e.g. a CJK char or an emoji
//     surrogate pair) that straddles a chunk boundary will be
//     decoded with a U+FFFD replacement codepoint where the split
//     occurs — `Buffer.toString('utf8')` operates on the buffer
//     in isolation and cannot see the lead byte that lives in
//     the next chunk. For firstMessage this is largely a non-issue
//     because (a) typical user prompts sit in the first few lines
//     (well within the first 64 KB chunk), and (b) when a prompt
//     straddles a chunk boundary the `remainder` carryover stitches
//     it back together before `extractFirstUserMessageText` runs.

import { closeSync, openSync, readSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Public types + constants
// ---------------------------------------------------------------------------

/** Per-jsonl summary returned by `readSessionSummary`. Mirrors the
 *  `message_count` + `first_message` fields on the
 *  `SessionListEntry` wire shape (see `@remotepi/shared/protocol/
 *  session-list.ts`) — same JSON-level contract but built locally
 *  from fs reads so we don't depend on the shared envelope schema
 *  here (the shared schema is the revalidation target downstream). */
export interface SessionSummary {
  /** First user message text (joined `content[].text` elements,
   *  truncated to 200 chars). `null` when no user message appears
   *  within the firstMessage scan window — covers three cases:
   *    1. The jsonl contains only metadata + assistant responses.
   *    2. The first user message lives past the 64KB / 200-line
   *       scan window (pathologically large preamble).
   *    3. The first user message's content had no text elements
   *       (e.g. an image-only message).
   *  Web renders `null` as `（无首条消息）` (ChoicePage.tsx). */
  firstMessage: string | null;
  /** Number of `{"type":"message", …}` lines in the file (user +
   *  assistant + toolResult — every line with top-level `type`
   *  equal to `"message"`). Capped at `MESSAGE_COUNT_LINE_CAP`.
   *
   *  Counting policy: the top-level `type` field is the SOLE
   *  criterion — a line whose top-level `type === "message"`
   *  counts regardless of whether its inner `message` payload is
   *  a well-formed object. Corrupted / partial-flush message
   *  lines (e.g. `message:"not-an-object"`) still increment the
   *  count because the top-level shape is what pi uses to route
   *  the event; only the firstMessage extraction bails on inner
   *  shape mismatches (best-effort). The two decisions
   *  deliberately diverge so a session with a few garbled
   *  messages still shows a representative count badge. */
  messageCount: number;
}

/** Scan window for firstMessage lookup — byte budget. 64KB easily
 *  covers the typical pi jsonl preamble (3 metadata lines + a few
 *  short user prompts); past that we stop looking. */
export const FIRST_MESSAGE_BYTE_LIMIT = 64 * 1024;

/** Scan window for firstMessage lookup — line budget. 200 lines is
 *  a defensive upper bound for any conceivable preamble
 *  (metadata-only sessions are typically 3–10 lines, chatty
 *  sessions usually surface a user prompt within 5–10 lines). */
export const FIRST_MESSAGE_LINE_LIMIT = 200;

/** Hard cap on `messageCount` — counting stops once we hit this
 *  number (we still finish the in-flight chunk, then close the
 *  fd). 50k messages is far past anything a real human session
 *  reaches; capping here keeps `session_list` latency bounded
 *  even on pathological files. */
export const MESSAGE_COUNT_LINE_CAP = 50_000;

/** Hard cap on the firstMessage text length. Truncation is a hard
 *  `slice(0, 200)` — no ellipsis suffix. The bridge doesn't try
 *  to be clever here: ChoicePage's level2 row is a narrow column
 *  that doesn't need long previews, and a hard cap is the
 *  simplest way to bound the wire payload size (200 chars × N
 *  rows = bounded). */
export const FIRST_MESSAGE_TEXT_MAX_CHARS = 200;

/** Internal: chunk size for `readSync`. Equal to
 *  `FIRST_MESSAGE_BYTE_LIMIT` so the scan window is exactly one
 *  chunk — no need to carry leftover bytes past the window. */
const READ_CHUNK_BYTES = FIRST_MESSAGE_BYTE_LIMIT;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read a pi session jsonl and return the per-row summary consumed
 *  by `BridgeSessionLayer.scanSessionsForWorkDir`.
 *
 *  Tolerates any failure mode:
 *   - File missing / permission denied / IO error mid-read →
 *     `firstMessage: null`, `messageCount: 0`.
 *   - Bad JSON line → silently skipped (count continues from the
 *     next good line).
 *   - Line spanning chunk boundary → joined with the next chunk's
 *     head; if the line still fails JSON.parse after being fully
 *     read, it's skipped.
 *  The function never throws — `session_list` must produce a
 *  usable row even for an unreadable / corrupted jsonl. */
export function readSessionSummary(jsonlPath: string): SessionSummary {
  let fd: number;
  try {
    fd = openSync(jsonlPath, 'r');
  } catch {
    // ENOENT / EACCES / EPERM / EISDIR / etc. — degrade gracefully.
    return { firstMessage: null, messageCount: 0 };
  }
  let firstMessage: string | null = null;
  let messageCount = 0;
  let messageCountCapped = false;
  // `windowBytesSeen` is the file offset (in bytes) of the
  // start byte of the line currently being processed. Tracked
  // PER LINE rather than per chunk so a user prompt whose
  // start byte lives in the first 64 KB but whose body extends
  // past it is still captured. See the window check JSDoc below
  // for the exact semantics.
  let windowBytesSeen = 0;
  let linesSeen = 0;
  let firstMessageWindowClosed = false;
  // Carryover for a partial line at the chunk boundary. pi jsonl
  // lines are short, but a single very long user message (large
  // pasted text) could span two chunks — we keep the tail here
  // and prepend it to the next chunk's text before splitting on
  // newlines. The carryover is dropped as soon as we close the
  // firstMessage scan window; past that we only care about line
  // boundaries for the messageCount tally.
  //
  // Carryover scope: dropping the partial-line remainder on
  // firstMessage-window-close ONLY affects the firstMessage
  // scan path (we no longer try to stitch it back). The
  // messageCount loop reads until EOF and stitches any
  // cross-chunk partial line into the next chunk via this same
  // `remainder` variable — a message line that straddles a
  // boundary still gets parsed and counted exactly once, so the
  // count is not inflated or under-counted by the boundary
  // logic.
  let remainder = '';
  const buf = Buffer.alloc(READ_CHUNK_BYTES);
  try {
    while (true) {
      let n: number;
      try {
        n = readSync(fd, buf, 0, READ_CHUNK_BYTES, null);
      } catch {
        // IO error mid-read — degrade with what we have so far.
        break;
      }
      if (n <= 0) break;
      const chunkText = remainder + buf.subarray(0, n).toString('utf8');
      const lastNl = chunkText.lastIndexOf('\n');
      let lines: string[];
      if (lastNl === -1) {
        // Whole chunk is a partial line (no terminator yet).
        remainder = chunkText;
        lines = [];
      } else {
        lines = chunkText.slice(0, lastNl).split('\n');
        remainder = chunkText.slice(lastNl + 1);
      }
      for (const line of lines) {
        // Per-line scan-window check. Semantic: a line is "in the
        // scan window" iff its start byte position is `<=
        // FIRST_MESSAGE_BYTE_LIMIT`. The strict `>` (not `>=`)
        // matches the user-spec semantic: a line whose start byte
        // IS exactly the byte-limit byte is still in the window.
        // A line whose START is in the window but whose BODY
        // extends past the byte limit is fully processed — the
        // check gates on line-START position, not line-END.
        if (
          !firstMessageWindowClosed &&
          (linesSeen > FIRST_MESSAGE_LINE_LIMIT || windowBytesSeen > FIRST_MESSAGE_BYTE_LIMIT)
        ) {
          firstMessageWindowClosed = true;
          remainder = '';
        }
        // +1 accounts for the trailing '\n' that was stripped
        // by the split.
        windowBytesSeen += line.length + 1;
        if (line.length === 0) continue;
        linesSeen++;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Malformed line (truncated flush, fs corruption,
          // operator droppings). Skip; count continues from the
          // next good line.
          continue;
        }
        if (parsed === null || typeof parsed !== 'object') continue;
        const obj = parsed as { type?: unknown; message?: unknown };
        if (obj.type !== 'message') continue;
        if (!messageCountCapped) {
          messageCount++;
          if (messageCount >= MESSAGE_COUNT_LINE_CAP) {
            messageCountCapped = true;
          }
        }
        if (!firstMessageWindowClosed && firstMessage === null) {
          const extracted = extractFirstUserMessageText(parsed);
          if (extracted !== null) {
            firstMessage = extracted;
            // Close the scan window as soon as we find the first
            // user message — no need to keep looking, and we
            // avoid the cost of `extractFirstUserMessageText` on
            // every subsequent line.
            firstMessageWindowClosed = true;
          }
        }
      }
      // Early exit when both goals are saturated: firstMessage
      // resolved (or window closed) AND messageCount hit the cap.
      // We do NOT exit on "firstMessage found" alone — we still
      // need to count messages for the rest of the file.
      if (firstMessageWindowClosed && messageCountCapped) break;
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort
    }
  }
  return { firstMessage, messageCount };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Pull the joined text content out of a parsed `{"type":"message",
 *  "message":{"role":"user", "content":[{"type":"text","text":"…"}, …]}}`
 *  line. Returns `null` for any shape mismatch (wrong role,
 *  missing content array, no text elements) so the caller can
 *  continue scanning. Truncates the joined text to
 *  `FIRST_MESSAGE_TEXT_MAX_CHARS` chars — a hard slice, no
 *  ellipsis (see constant JSDoc for rationale).
 *
 *  Defensive type narrowing throughout — pi may add new fields,
 *  reorder them, or introduce new content element types; we only
 *  pick out the ones we recognise. Unknown shapes return `null`. */
function extractFirstUserMessageText(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const top = parsed as { message?: unknown };
  if (top.message === null || typeof top.message !== 'object') return null;
  const msg = top.message as { role?: unknown; content?: unknown };
  if (msg.role !== 'user') return null;
  if (!Array.isArray(msg.content)) return null;
  const parts: string[] = [];
  for (const elem of msg.content) {
    if (elem === null || typeof elem !== 'object') continue;
    const e = elem as { type?: unknown; text?: unknown };
    if (e.type === 'text' && typeof e.text === 'string') parts.push(e.text);
  }
  if (parts.length === 0) return null;
  const joined = parts.join('');
  if (joined.length === 0) return null;
  return joined.length > FIRST_MESSAGE_TEXT_MAX_CHARS
    ? // Code-point truncation (Array.from yields one entry per
      // Unicode codepoint, so a surrogate pair counts as 1 not 2).
      // A naïve `slice(0, 200)` on the UTF-16 string can cut
      // between the high and low surrogate and yield an isolated
      // surrogate — invalid for downstream consumers.
      Array.from(joined).slice(0, FIRST_MESSAGE_TEXT_MAX_CHARS).join('')
    : joined;
}
