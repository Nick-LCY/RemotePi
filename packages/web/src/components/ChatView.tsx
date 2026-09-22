// ChatView — main chat surface, per-session.
//
// Composition:
//   <MessageList />  — History + streaming draft (typing effect).
//   <InputBar />     — Text input + send + abort.
//   <DialogHost />   — Layered dialog renderer over the chat.
//
// The previous render tree also mounted a per-session
// `<PhaseIndicator />` + `<QueueIndicator />` pair. Both moved
// into the new `<SessionStatusBar>` (mounted by App above this
// subtree); the user no longer sees phase badge + queue pills
// twice. Those components are removed (cleaner than leaving dead
// helpers).
//
// Per-session reads/writes: ChatView takes a `session` prop and
// reads exclusively from the per-session bucket via
// `useXxxFor(session)`. Background sessions can't accidentally
// leak into the foreground UI.
//
// Streaming draft renders by segment (thinking folded
// `<details>` / text plain inside `.message-body` / tool folded
// pill). The terminal assistant message body delegates to
// `<AssistantMessageBody>` for the markdown / folded-think /
// tool-pill final-state rendering. Non-assistant messages (user
// / toolResult) keep the existing pure-text path.
//
// State source: WsClient per-session bucket via `useXxxFor(
// session)` — no local state that could drift from the protocol.
// The only React state local to this subtree is the
// controlled-input value in InputBar.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';

import {
  useCommandErrorSubscription,
  useMessagesFor,
  useSessionPhaseFor,
  useStreamingDraftFor,
  useWsClient,
} from '../ws/WsClientContext.js';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea.js';
import { decideKeyDownAction } from './inputBarKeydown.js';
import { DialogHost } from './dialogs/DialogHost.js';
import type { StreamingSegment } from '../ws/WsClient.js';
import { mergeToolResults, extractMergedResult } from './toolResultMerge.js';

// `AssistantMessageBody` pulls in the entire markdown pipeline
// (react-markdown + remark-gfm + rehype-sanitize + micromark +
// mdast/hast/unist transitives, ~170 KB raw / ~52 KB gzip). To
// stay under the 350 KB first-load budget we lazy-load it: the
// main bundle never imports it directly. The component is only
// needed for TERMINAL assistant messages (the streaming-time
// path uses the lightweight `StreamingDraftBody` below, which
// renders plain text / folded `<details>` / tool pills — no
// markdown). The terminal branch fires the dynamic import on
// first render.
//
// Lazy import reference: kept as a module-level constant so the
// `prewarmMarkdownChunk` effect below can fire the SAME dynamic
// `import()` on ChatView mount — Vite dedupes by URL, so this is
// free at the network level. The chunk lands in the browser's
// HTTP cache during the warm-up; the first real terminal
// assistant message resolves the same `import()` Promise
// instantly (no visible loading gap).
const AssistantMessageBody = lazy(() =>
  import('./AssistantMessageBody.js').then((m) => ({ default: m.AssistantMessageBody })),
);

/** Kick off the markdown chunk download in the background. Fire-
 *  and-forget: we don't `await` it (ChatView mount shouldn't
 *  block on a chunk it doesn't need yet) and we don't surface
 *  the rejection (a failed preload only means the first terminal
 *  message takes the normal React.lazy load path, which has its
 *  own `<Suspense>` fallback). The catch is intentionally empty
 *  — there's nothing useful to do with a preload failure here,
 *  and logging would just spam the dev console for offline /
 *  slow-network cases. */
function prewarmMarkdownChunk(): void {
  void import('./AssistantMessageBody.js').catch(() => {
    // intentional no-op — see comment above.
  });
}

// ---------------------------------------------------------------------------
// ChatView
// ---------------------------------------------------------------------------

/** Per-session ChatView entry. The `session` prop pins the
 *  bucket — all reads/writes inside this subtree go through
 *  `useXxxFor(session)`. `workDir` is plumbed through so the
 *  InputBar's `session: 'new'` prompt auto-fill can include
 *  `payload.work_dir`.
 *
 *  ChatView mounts the markdown chunk on first paint (prewarm)
 *  so the user-visible first-load doesn't carry the 170 KB chunk.
 *  The chunk only becomes load-bearing when a terminal assistant
 *  message renders — the streaming draft path renders plain text
 *  and never touches `<AssistantMessageBody>`. */
export function ChatView({ session, workDir }: { session: string; workDir: string }) {
  useEffect(() => {
    // Fire-and-forget preload of the markdown chunk. Runs once
    // per ChatView mount; Vite caches the resolved module so
    // the actual `React.lazy` import resolves synchronously
    // (or near-instantly) when the first terminal assistant
    // message lands.
    prewarmMarkdownChunk();
  }, []);
  return (
    // `chat-view` retained as a semantic class anchor (no styling
    // remains under it; e2e selectors target `[data-testid="chat-view"]`
    // directly, so the class is load-bearing only for any future
    // global hooks). The flex column + gap is now a Tailwind utility.
    <div className="chat-view flex flex-col gap-2" data-testid="chat-view" data-session={session}>
      <MessageList session={session} />
      <InputBar session={session} workDir={workDir} />
      <DialogHost />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageList
// ---------------------------------------------------------------------------

/** Renders the authoritative message history + the in-flight streaming
 *  draft as a single scrolling list. `message_end` events clear the
 *  matching draft via `messageId` (WsClient owns this matching), so
 *  the UI doesn't need to deduplicate.
 *
 *  Each message is rendered via a small renderer that picks out a
 *  `role` and a text body when the shape carries one. Anything that
 *  doesn't match the renderer pattern falls back to a
 *  `<pre>{JSON.stringify(...)}</pre>` so the user can still see what
 *  pi emitted (the shared package treats messages as opaque).
 *
 *  M5 §3 — streaming draft renders by segments (thinking folded
 *  `<details>` / text plain `<br>`-split inside `.message-body` /
 *  tool folded pill). The plain-text path inside `.message-body`
 *  is preserved so the e2e 01 spec §6 streaming-continuity
 *  assertion (`.message-body` textContent monotonic) keeps working
 *  — `<details>` children still contribute to textContent whether
 *  folded or unfolded.
 */
function MessageList({ session }: { session: string }) {
  const messages = useMessagesFor(session);
  const draft = useStreamingDraftFor(session);

  // Tool-result rendering-layer merge: `mergeToolResults` walks
  // the per-session bucket's `messages` array, consumes
  // toolResult messages whose `toolCallId` matches a prior
  // assistant message's toolCall block, and attaches the
  // normalised `{text, isError}` payload to that block
  // (immutably, via shallow-copy). Orphan toolResults (no
  // matching toolCall — e.g. MESSAGES_CAP truncated the
  // assistant message) are preserved with `__mergedOrphan: true`
  // and rendered as folded `<details>` by the toolResult branch.
  // Pure function; never mutates the input; cheap on every
  // render (assistant turns carry ≤ a handful of toolCalls;
  // toolResult count is bounded by `MESSAGES_CAP` at 1k).
  const mergedMessages = useMemo(() => mergeToolResults(messages), [messages]);

  // No virtualization for now — the MESSAGES_CAP of 1k keeps the DOM
  // small enough that simple flex layout outperforms virtualized lists
  // (which add runtime + accessibility complexity we don't need yet).
  // If a session outgrows this, swap to a virtualized list — the
  // shape below (item = role + text) is the right abstraction.
  const items = useMemo(() => {
    const list: MessageItem[] = [];
    for (let i = 0; i < mergedMessages.length; i += 1) {
      list.push(messageToItem(mergedMessages[i], i));
    }
    if (draft !== null && draft.segments.length > 0) {
      list.push({
        kind: 'draft',
        key: `draft:${draft.messageId ?? 'live'}`,
        role: draft.role ?? 'assistant',
        segments: draft.segments,
      });
    }
    return list;
  }, [mergedMessages, draft]);

  return (
    // `message-list` retained as a semantic class anchor (no
    // styling remains under it after M6 T02; the `card` chrome
    // and the 50vh cap now live as Tailwind utilities below).
    // The `message-list-items` class on the `<ol>` likewise stays
    // for structural reference but contributes no paint.
    <section
      className="message-list flex max-h-[50vh] flex-col gap-3 overflow-y-auto rounded-md border border-border bg-surface p-4"
      aria-label="Conversation"
      data-testid="message-list"
    >
      {items.length === 0 ? (
        <p className="empty text-muted text-center" data-testid="message-list-empty">No messages yet — send a prompt to start.</p>
      ) : (
        <ol className="message-list-items m-0 flex list-none flex-col gap-2 p-0">
          {items.map((item) => {
            // Per-role border colour: the previous legacy
            // `.message-role-user { border-color: var(--accent); }` /
            // `.message-role-assistant { border-color: var(--state-online); }`
            // rules painted the corresponding row's left/top border
            // in accent / online green. With utilities that lived
            // in `<li class="border border-border rounded-md ...">`
            // we're now opting in to `border-accent` /
            // `border-state-online` per role. Other roles fall
            // back to `border-border` from the base class.
            const roleBorderClass =
              item.role === 'user'
                ? 'border-accent'
                : item.role === 'assistant'
                  ? 'border-state-online'
                  : '';
            return (
              <li
                key={item.key}
                className={`message-row message-role-${item.role}${
                  item.kind === 'draft' ? ' message-draft' : ''
                } border border-border ${roleBorderClass} rounded-md bg-surface-2 px-3 py-2`}
                data-testid={item.kind === 'draft' ? 'message-draft' : 'message-row'}
              >
                <div className="message-role mb-1.5 text-[0.72rem] uppercase tracking-[0.05em] text-muted">{item.role}</div>
                <div className="message-body text-[0.92rem] break-words whitespace-pre-wrap">
                  {item.kind === 'draft' ? (
                    <StreamingDraftBody segments={item.segments} />
                  ) : (
                    <TerminalMessageBody role={item.role} raw={item.raw} />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** Render an in-flight streaming draft's segments inside
 *  `.message-body`. The thinking / tool segments use a
 *  `<details>` element (D3 路线 B — always folded by default);
 *  the text segments stay as plain `\n`-split text so the e2e
 *  01 spec §6 streaming-continuity assertion continues to
 *  observe monotonically growing `textContent`. Text inside a
 *  `<details>` element still contributes to its `textContent`
 *  regardless of the `open` attribute, so folding never resets
 *  the observed length. */
function StreamingDraftBody({ segments }: { segments: readonly StreamingSegment[] }) {
  return (
    <>
      {segments.map((seg, idx) => {
        if (seg.type === 'thinking') {
          return (
            // `message-thinking-details` retained as a semantic
            // anchor (no styling beyond the `<details>`/`<summary>`
            // pseudo-element rules in styles.css). Tailwind utilities
            // paint the chrome (border / padding / background).
            <details
              key={`think-${idx}`}
              className="message-thinking-details my-1 rounded-md border border-border bg-surface-2"
              data-testid="message-draft-thinking"
            >
              <summary className="thinking-summary cursor-pointer px-3 py-1 text-[0.85rem] text-muted">
                Thinking… ({seg.text.length} chars)
              </summary>
              <div className="thinking-body whitespace-pre-wrap break-words border-t border-border px-3 pb-2 pt-2 text-[0.88rem] text-muted">{seg.text}</div>
            </details>
          );
        }
        if (seg.type === 'tool') {
          return (
            // `message-tool-details` / `message-tool-pill` retained
            // as semantic anchors. The `message-tool-body` on the
            // `<pre>` likewise stays — current consumers (this
            // component + `AssistantMessageBody.tsx`) don't assert
            // on its paint (the streaming draft wraps the args /
            // running message in a single `<pre>` of minimal chrome).
            <details
              key={`tool-${idx}`}
              className="message-tool-details my-1 rounded-md border border-border bg-surface-2"
              data-testid="message-draft-tool"
            >
              <summary className="message-tool-pill inline-flex cursor-pointer items-center gap-1 px-3 py-1 text-[0.88rem] text-text">
                <span aria-hidden="true">🔧</span> {seg.name || 'tool'}
              </summary>
              <pre className="message-tool-body m-0 overflow-auto whitespace-pre-wrap break-words rounded border-t border-border bg-code-bg p-3 text-[0.82em]">{seg.args || '(running…)'}</pre>
            </details>
          );
        }
        // text segment — plain text inside `.message-body` so the
        // e2e 01 spec §6 monotonic-length assertion works
        // unchanged. Stream-time never renders markdown (D2).
        return (
          <span key={`text-${idx}`}>
            {seg.text.split('\n').map((line, lineIdx, arr) => (
              <span key={lineIdx}>
                {line}
                {lineIdx < arr.length - 1 ? <br /> : null}
              </span>
            ))}
          </span>
        );
      })}
    </>
  );
}

/** Render a terminal message body inside `.message-body`. Assistant
 *  messages with an array `content` delegate to
 *  `<AssistantMessageBody>` (markdown / folded thinking / tool
 *  pill final state); orphan toolResult messages go through
 *  `<OrphanToolResultBody>` (folded `<details>` summary so a
 *  truncated-by-MESSAGES_CAP result never paints raw on
 *  screen); everything else goes through the existing
 *  `messageToItem` + `extractText` plain-text path unchanged (D6
 *  — user / plain assistant content stay plain).
 *
 *  `<AssistantMessageBody>` is lazy-loaded; we wrap it in
 *  `<Suspense>` so React has a fallback during the chunk fetch.
 *  The fallback is an empty `<span>` (not a spinner / "loading…"
 *  text) because:
 *    - The prewarm effect in `ChatView` typically lands the
 *      chunk before the user reaches the first terminal
 *      assistant message — the fallback almost never paints.
 *    - When it does paint (cold cache, slow network), an empty
 *      span keeps `.message-body`'s layout stable (no spinner
 *      height jump); the assistant text just appears a frame
 *      later. The user perceives "the message is here, content
 *      coming in" rather than "the UI re-layed out".
 *
 *  toolResult branch falls back to a folded `<details>`
 * summary: `mergeToolResults` consumes toolResults that match
 * a prior assistant's toolCall; the surviving orphans
 * (typically because MESSAGES_CAP truncated the assistant
 * message but the toolResult still fits in the 1k window)
 * render as a folded summary with a `pre` body so a ~29k-char
 * result doesn't paint raw on screen. `isError` adds a
 * `.message-tool-result-error` class. */
function TerminalMessageBody({ role, raw }: { role: string; raw: unknown }) {
  if (role === 'assistant' && raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const content = obj.content;
    if (Array.isArray(content)) {
      return (
        <Suspense fallback={<span />}>
          <AssistantMessageBody content={content} />
        </Suspense>
      );
    }
  }
  if (role === 'toolResult') {
    return <OrphanToolResultBody raw={raw} />;
  }
  // Non-assistant (user / plain assistant string content) — old
  // plain-text path. Preserves e2e spec testid / className anchors.
  const text = extractTextFromMessage(raw);
  return (
    <>
      {text.split('\n').map((line, idx, arr) => (
        <span key={idx}>
          {line}
          {idx < arr.length - 1 ? <br /> : null}
        </span>
      ))}
    </>
  );
}

/** Render an orphan toolResult as a folded `<details>`. Survives
 *  `mergeToolResults` only when no matching toolCall was found in
 *  the prior assistant messages (typical: MESSAGES_CAP truncated
 *  the assistant message). Folding is mandatory: a single
 *  toolResult payload can be ~29k chars, and rendering it as raw
 *  text would dominate the scroll area uncollapsed (the exact
 *  bug this fix is closing).
 *
 *  Style: shares `.message-tool-details` / `.message-tool-result`
 *  with the terminal toolCall pill so the visual treatment is
 *  consistent. The `data-testid="message-tool-result-orphan"`
 *  distinguishes orphans for e2e targeting (non-orphan toolResults
 *  never reach the DOM — they're consumed by the merger into
 *  their matching toolCall block's `result` field).
 *
 *  Text extraction goes through the SAME `extractMergedResult`
 *  helper the merger uses, so an orphan with
 *  `content:[{text:'line1'},{text:'line2'}]` renders
 *  `'line1line2'` and a matching toolCall with the same wire
 *  payload also renders `'line1line2'`. Keeps the two render
 *  paths aligned through one helper.
 *
 *  The summary line ALWAYS carries `(orphan)` — every entry
 *  reaching this component is by definition orphan (the only way
 *  to land here is the merger couldn't find a matching
 *  toolCall). The unconditional marker reflects that invariant. */
function OrphanToolResultBody({ raw }: { raw: unknown }) {
  // Narrow the shape defensively — the merge function only
  // preserves toolResult messages with `role === 'toolResult'` +
  // string `toolCallId`. We re-extract the same fields here so
  // a future drift in either layer surfaces a folded details
  // with a sensible fallback rather than crashing the render.
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const toolName = obj !== null && typeof obj.toolName === 'string' ? obj.toolName : 'tool';
  // `toolCallId` is read for display but the summary marker no
  // longer depends on its presence; we keep the field extraction
  // in case a future revision wants to surface the id inline
  // (and so test fixtures that include a non-empty id still parse
  // cleanly).
  const _toolCallId = obj !== null && typeof obj.toolCallId === 'string' ? obj.toolCallId : '';
  // Joined text — same extraction rule the merge function uses,
  // so the rendered orphan body matches what the matching
  // toolCall would have shown. `extractMergedResult` is the
  // single source of truth for orphan / matched-text parity —
  // see `components/toolResultMerge.ts` for join semantics
  // (no separator; non-text blocks skipped).
  const merged = extractMergedResult(raw);
  const text = merged.text;
  const isError = merged.isError;
  return (
    // `message-tool-details` + `message-tool-result-orphan`
    // anchor the orphan variant in styles.css (the border-color
    // override + orphan-id span styles live there). The chrome
    // (padding / margin / rounded / bg) is now utilities.
    <details
      className="message-tool-details message-tool-result-orphan my-1 rounded-md border border-border bg-surface-2"
      data-testid="message-tool-result-orphan"
    >
      <summary className="message-tool-pill inline-flex cursor-pointer items-center gap-1 px-3 py-1 text-[0.88rem] text-text">
        <span aria-hidden="true">🔧</span> {toolName}
        <span className="message-tool-orphan-id"> · result (orphan)</span>
      </summary>
      <pre
        // `message-tool-result` + `message-tool-result-error` keep
        // the dual-class anchor so the `.message-tool-result.
        // message-tool-result-error` rule in styles.css still
        // paints the red tint for `isError === true` orphans.
        // Background + border + padding + font (the success path)
        // are now Tailwind utilities.
        className={
          (isError
            ? 'message-tool-result message-tool-result-error'
            : 'message-tool-result') +
          ' m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border-t border-border bg-code-bg p-3 font-mono text-[0.82em]'
        }
      >
        {text}
      </pre>
    </details>
  );
}

/** Minimal text extractor for the terminal-message plain-text
 *  path. Mirrors the original behaviour from `messageToItem`
 *  (extractText / JSON.stringify fallback). User / toolResult
 *  messages stay on this path; only assistant messages with
 *  `content: Array` opt into the markdown body. */
function extractTextFromMessage(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') {
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      return String(raw);
    }
    return extractJson(raw);
  }
  const obj = raw as Record<string, unknown>;
  const fromContent = extractText(obj.content);
  if (fromContent !== undefined) return fromContent;
  if (typeof obj.text === 'string') return obj.text;
  return extractJson(raw);
}

/** Coerce a pi-native message shape into a uniform `MessageItem`.
 *  Falls back to a JSON dump for shapes we don't recognise — the
 *  shared package treats `messages` as `unknown[]`, so we never
 *  throw on an unfamiliar element.
 *
 *  M5 §1 / §3 — the draft branch carries `segments` (used by
 *  `StreamingDraftBody`); the terminal branch carries `raw` (used
 *  by `TerminalMessageBody`, which decides between markdown for
 *  assistant / plain-text for everything else). The two shapes
 *  coexist because the renderer needs the segment list for the
 *  typewriter effect but the raw shape for the terminal state. */
type MessageItem =
  | { kind: 'draft'; key: string; role: string; segments: readonly StreamingSegment[] }
  | { kind: 'terminal'; key: string; role: string; raw: unknown };

function messageToItem(raw: unknown, index: number): MessageItem {
  const key = stableKey(raw, index);
  if (raw === null || typeof raw !== 'object') {
    return { kind: 'terminal', key, role: 'unknown', raw };
  }
  const obj = raw as Record<string, unknown>;
  const role = typeof obj.role === 'string' ? obj.role : 'unknown';
  return { kind: 'terminal', key, role, raw };
}

/** A stable string key for React rendering. Pi 0.85.1's
 *  AssistantMessage / UserMessage / ToolResultMessage (verified
 *  against `@earendil-works/pi-coding-agent@0.85.1`'s
 *  `node_modules/@earendil-works/pi-ai/dist/types.d.ts`) have NO
 *  top-level id field — the previous `messageId` / `message_id` /
 *  `id` lookup therefore ALWAYS fell through to the JSON-fingerprint
 *  fallback. When two messages had identical content (e.g. two
 *  assistant turns with the same answer, or the user re-sent the
 *  same prompt), `JSON.stringify(raw).slice(0, 64)` collided and
 *  React logged `Encountered two children with the same key`. The
 *  user-visible symptom (warning in dev console, marginal
 *  reconciliation noise in prod) is benign on its own, but the
 *  LOG noise masks any real React issue that comes after.
 *
 *  The `messages` array is order-stable within a single render —
 *  `setMessages` replaces wholesale, `upsertMessage` slices in
 *  place, the only mutation in flight is append at the tail — so
 *  positional indices make perfectly stable React keys. Switching
 *  to a pure positional key makes the collision impossible.
 *
 *  `responseId` (present on assistant messages but not on user /
 *  toolResult) was considered as a weak key and rejected: it's
 *  provider-specific, not present uniformly across message types,
 *  and not authoritative for the row identity we want React to
 *  track. */
function stableKey(_raw: unknown, index: number): string {
  return 'idx:' + index;
}

/** Extract a text payload from the common pi-native `content`
 *  variants:
 *    - string                       → use as-is
 *    - `{ text: string }`           → use the text field
 *    - `{ type:'thinking', thinking:string }` → use the thinking field
 *    - `[{ type:'text', text:'…' }, …]`           → join text fields
 *    - `[{ type:'thinking', thinking:'…' }, …]`   → join thinking fields
 *  Returns `undefined` for shapes we don't recognise so the caller
 *  can fall back to JSON rendering.
 *
 *  Thinking blocks are handled explicitly because pi 0.85.1's
 *  ThinkingContent type (verified against
 *  `@earendil-works/pi-coding-agent@0.85.1`'s
 *  `node_modules/@earendil-works/pi-ai/dist/types.d.ts:242`)
 *  carries a `thinking` field, NOT a `text` field — the previous
 *  implementation silently dropped every ThinkingContent block
 *  (joined as empty string), so models that emitted thinking
 *  before their final answer appeared to skip straight to the
 *  answer in the rendered conversation. We preserve render order
 *  (thinking first, then text) and use a newline separator so
 *  the two blocks don't run together — the `MessageList` renderer
 *  splits on `\n` and renders each segment in its own span.
 *
 *  ToolCall blocks (the third member of AssistantMessage.content's
 *  union: `ToolCall = { type:'toolCall', name, arguments, … }`)
 *  are intentionally skipped — the dialog host surfaces tool
 *  activity via `extension_ui_request`, not via the message list,
 *  and rendering a raw `arguments` object as text would be
 *  confusing. A future iteration can branch on `type === 'toolCall'`
 *  and render a compact "ran tool foo(args)" pill here without
 *  touching the WsClient pipeline. */
function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  // Direct text content (legacy / non-pi shapes).
  if (typeof obj.text === 'string') return obj.text;
  // Thinking content — pi's ThinkingContent blocks carry a
  // `thinking` field (NOT `text`).
  if (obj.type === 'thinking' && typeof obj.thinking === 'string') return obj.thinking;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    let isFirst = true;
    for (const piece of value) {
      if (piece === null || typeof piece !== 'object') continue;
      const p = piece as Record<string, unknown>;
      if (p.type === 'text' && typeof p.text === 'string') {
        // Only NON-FIRST blocks get a leading '\n' so the first
        // block renders top-aligned (no leading blank line) and
        // adjacent blocks stay separated. The trailing trimEnd()
        // drops the redundant blank after the last block.
        parts.push((isFirst ? '' : '\n') + p.text);
        isFirst = false;
      } else if (p.type === 'thinking' && typeof p.thinking === 'string') {
        // Newline separator so thinking doesn't run into adjacent
        // blocks; the renderer splits on '\n' anyway. Same first/
        // non-first rule as the text branch — a sole thinking block
        // starts with no leading '\n' so its first line top-aligns.
        parts.push((isFirst ? '' : '\n') + p.thinking);
        isFirst = false;
      }
      // ToolCall / unknown shapes are intentionally skipped.
    }
    return parts.length > 0 ? parts.join('').trimEnd() : undefined;
  }
  return undefined;
}

function extractJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable message]';
  }
}

// ---------------------------------------------------------------------------
// InputBar
// ---------------------------------------------------------------------------

/** Bottom-of-screen input bar. Behaviour rules (PRD §4.3):
 *    - send prompt (Enter or click) → `client.sendPrompt(value)`
 *      and clears the local input.
 *    - abort button — live (red, clickable) when `phase === 'running'`
 *      (the bridge forwards abort to pi). Clicking while idle / ready
 *      / exited calls `sendAbort()` anyway — bridge handles the
 *      no-op for `exited` (returns command_result{success:true}) and
 *      for `idle` aborts the next pending turn start.
 *    - input disabled while `phase === 'running'` (PRD §4.3: "abort
 *      按钮活态于 phase === 'running'"; the symmetric rule is the
 *      input stays disabled until `agent_settled` brings the agent
 *      back to idle). PRD §4.3 also notes that exited → spawning is
 *      triggered by sending a prompt — we therefore keep the input
 *      editable in `exited` so the user can start a new turn.
 *
 *  Optimistic UI is OFF by design (H decision): we do not flip a
 *  local "submitting" flag after send. The next event / state frame
 *  (session_state.phase change, message_update, etc.) is what the
 *  UI listens to. The clear-on-send here is a convenience for the
 *  user — the UI doesn't change state semantics because of it.
 *
 *  PRD §4.5 ordinary-command failure UX: when a prompt /
 *  steer / follow_up comes back as `command_result{success:false}`
 *  (the WsClient only fires this when the failing envelope id
 *  matches one we sent), show a temporary error banner and DO NOT
 *  retry. The banner auto-hides after 5s and the user can correct
 *  the input manually. */
function InputBar({ session, workDir }: { session: string; workDir: string }) {
  const client = useWsClient();
  const phase = useSessionPhaseFor(session);
  const [value, setValue] = useState('');
  // Tracks the most recent agent_settled timestamp so we can show the
  // "agent settled" hint for a few seconds after each turn (PRD §4.3
  // wording: "UI 显示 'agent 已就绪（5 分钟后自动休眠）'"). The
  // session_state broadcast brings phase to `idle` on the same turn
  // end — we treat that as the source of truth.
  const [settledHintVisible, setSettledHintVisible] = useState(false);
  // §4.5 failure banner. We keep the message string in state and use
  // a ref to manage the auto-hide timer so a fast succession of
  // failures resets the 5s window rather than overlapping.
  const [commandError, setCommandError] = useState<string | null>(null);
  const commandErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `session === 'new'` requires the prompt to carry
  // `payload.work_dir` (the bridge rejects `session: 'new'` without
  // it as `invalid_envelope`). The InputBar routes through a small
  // helper that splits the wire shape between new-session and
  // in-session sends.
  const isNewSession = session === 'new';

  // Subscribe to pi/event envelopes for the agent_settled hint. We
  // can't put this in a top-level ChatView effect because agent_settled
  // is per-turn and the InputBar owns the hint UI.
  useEffect(() => {
    const unsub = client.on('event', (envelope) => {
      if (envelope.kind !== 'pi' || envelope.type !== 'event') return;
      const payload = envelope.payload;
      if (payload.event === 'agent_settled') {
        setSettledHintVisible(true);
      }
    });
    return unsub;
  }, [client]);

  // Hide the hint once we leave the idle phase (i.e. user sent
  // another prompt). The hint reappears on the next agent_settled.
  useEffect(() => {
    if (phase !== 'idle') {
      setSettledHintVisible(false);
    }
  }, [phase]);

  // §4.5 failure banner subscription. Each failure resets the 5s
  // hide-timer so the message stays visible long enough to be read
  // even if multiple failures arrive in quick succession. We always
  // clear the timer on unmount so a stale hide doesn't fire on a
  // remounted InputBar (the next session's failure will set up its
  // own timer fresh).
  useCommandErrorSubscription(
    useCallback((notice) => {
      // Generic failure banner: both `request_expired` (idle-timeout
      // / queued-too-long) and the `pi_error` family (model not
      // found, parse failure, etc.) reach this callback via the
      // shared `command_error` subscription. Earlier wording pinned
      // every failure to "可能是 idle 超时 kill", which is only true
      // for `request_expired` — `pi_error` failures come from pi
      // itself. `request_expired` is handled by the extension's
      // own notice flow and does not surface here, so a generic
      // "命令失败 (code: message)" line is correct for everything
      // that does.
      const display = `命令失败（${notice.code}）：${notice.message}`;
      setCommandError(display);
      if (commandErrorTimerRef.current !== null) {
        clearTimeout(commandErrorTimerRef.current);
      }
      commandErrorTimerRef.current = setTimeout(() => {
        commandErrorTimerRef.current = null;
        setCommandError(null);
      }, 5_000);
    }, []),
  );

  useEffect(() => {
    return () => {
      if (commandErrorTimerRef.current !== null) {
        clearTimeout(commandErrorTimerRef.current);
        commandErrorTimerRef.current = null;
      }
    };
  }, []);

  const inputDisabled = phase === 'running' || phase === 'spawning';
  const abortLive = phase === 'running';

  // Auto-grow textarea (see `hooks/useAutoResizeTextarea.ts`).
  // The ref is owned by the component (so the hook can keep using
  // `value` as a stable dep) and the hook writes `style.height`
  // against `ref.current` on every render that touches `value`.
  // The hook intentionally does not manage the ref itself —
  // keeping ref ownership local matches the existing
  // `commandErrorTimerRef` style.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutoResizeTextarea({ ref: textareaRef, value });

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(event.target.value);
  };

  /** The shared send path used by both the form's onSubmit and the
   *  input's onKeyDown. Extracting it removes the
   *  `event as unknown as FormEvent<...>` cast the previous
   *  version needed because onKeyDown synthesised a fake
   *  form-event to call onSubmit. Both call sites now just pass
   *  a plain string — no synthetic events, no casts.
   *
   *  When `session === 'new'`, the prompt payload carries
   *  `work_dir` so the bridge can spawn the new manager with the
   *  right cwd. We use `client.send` (the low-level escape hatch
   *  on `WsClient`) to construct the envelope with the optional
   *  `work_dir` field — the high-level `sendPrompt` shape is
   *  intentionally narrow to in-session prompts. The bridge
   *  rejects `session: 'new'` without work_dir, so the InputBar
   *  is the only place this is enforced. */
  const submitText = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (isNewSession) {
      // The web outbound encloses `session: 'new'` (auto-filled
      // by the WsClient from currentSessionKey) plus
      // `payload.work_dir`. Both fields are required for the
      // bridge's pending-key path (PRD §1.2). `workDir` is the
      // URL-hash `work_dir` plumbed down from App.tsx; if the
      // hash is missing work_dir (defensive — decideView
      // guarantees level=2 with work_dir present at this
      // branch), we fall back to the store's currentWorkDir
      // mirror.
      const effectiveWorkDir = workDir !== '' ? workDir : client.currentWorkDir;
      if (effectiveWorkDir === null) {
        // Defensive — should never happen because the URL hash
        // gates ChatView on `&work_dir=...`. If it does, surface
        // an inline error rather than firing a doomed request.
        setCommandError('命令失败（invalid_envelope）：session=new 必带 work_dir');
        return;
      }
      // Construct the envelope by hand so the `work_dir` field
      // can ride along. The shared `PiPromptPayload` type does
      // not pin `work_dir` (it is an additive optional field per
      // envelope evolution rule (a)) so a plain object cast is
      // sufficient — the bridge's own Zod schema validates the
      // full shape on receipt.
      client.send({
        v: 1,
        kind: 'pi',
        type: 'prompt',
        id: crypto.randomUUID(),
        session: 'new',
        payload: { content: trimmed, work_dir: effectiveWorkDir },
      } as unknown as Parameters<typeof client.send>[0]);
    } else {
      client.sendPrompt(trimmed);
    }
    setValue('');
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitText(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Three-piece guard:
    //   Enter + !shiftKey + !isComposing → submit
    //   Shift+Enter → browser native newline (no preventDefault)
    //   IME composing → ignore (let candidate commit)
    // The decision is extracted to `decideKeyDownAction` so the
    // rules are unit-testable without spinning up a DOM /
    // WsClient stack (see `__tests__/input-bar-keydown.test.ts`).
    // `event.nativeEvent.isComposing` is the spec-correct IME
    // flag (UI Events §6.3) — every modern browser sets it on
    // composition-end Enter.
    const action = decideKeyDownAction({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    });
    if (action === 'submit') {
      // preventDefault so the textarea doesn't ALSO insert a
      // '\n' alongside the submit (mirrors the prior <input>
      // implementation).
      event.preventDefault();
      submitText(value);
    }
    // 'newline' / 'ignore' → no preventDefault, no submit. The
    // textarea / IME handles the keypress natively (Shift+Enter
    // inserts '\n' in the value; IME composing Enter commits
    // the candidate).
  };

  const onAbort = () => {
    // Always send — the bridge handles the no-op for `exited` /
    // `idle` (returns command_result{success:true}).
    client.sendAbort();
  };

  return (
    // `input-bar` retained as a semantic class anchor (no
    // styling remains under it; the flex / align / gap / chrome
    // are Tailwind utilities below). The class is kept for any
    // future global hook + to anchor the `keydown` testid
    // surface (`[data-testid="chat-view"] > form.input-bar`).
    <form className="input-bar flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface px-3 py-2" onSubmit={onSubmit} aria-label="Send a prompt">
      <textarea
        ref={textareaRef}
        // `input-bar-field` retained as a semantic anchor (the
        // `useAutoResizeTextarea` effect depends on this class to
        // detect its textarea for the height auto-grow pass — see
        // `hooks/useAutoResizeTextarea.ts` references). All
        // chrome (box-sizing / resize / min-height / max-height /
        // overflow / focus outline) is now utilities.
        className="input-bar-field m-0 box-border w-full min-w-[12rem] flex-1 resize-none rounded border border-border bg-surface-2 px-2 py-1.5 font-[inherit] text-[0.95rem] leading-[1.4] text-text outline outline-2 outline-offset-1 outline-accent focus:outline disabled:cursor-not-allowed disabled:opacity-70"
        style={{ maxHeight: 'var(--input-max-height)' }}
        data-testid="input-field"
        rows={1}
        placeholder={
          inputDisabled
            ? 'agent is working — abort to take over'
            : phase === 'exited'
              ? 'send a prompt to respawn pi…'
              : 'send a prompt…'
        }
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        disabled={inputDisabled}
        aria-label="Prompt"
        autoComplete="off"
        spellCheck={false}
      />
      <button type="submit" data-testid="input-send" disabled={inputDisabled || value.trim().length === 0} className="self-end rounded border border-accent bg-accent px-4 py-2 font-[inherit] text-white">
        Send
      </button>
      <button
        type="button"
        data-testid="input-abort"
        // `abort-button` retained as a semantic anchor (mirror of
        // `input-bar-field`). `abort-live` was the live-state
        // red paint — the legacy CSS rule is gone, so we apply
        // the red Tailwind colour stack explicitly here.
        className={
          (abortLive
            ? 'abort-button abort-live border-state-offline bg-state-offline text-white'
            : 'abort-button border-border bg-surface text-text') +
          ' self-end rounded px-4 py-2 font-[inherit] disabled:cursor-not-allowed disabled:opacity-50'
        }
        onClick={onAbort}
        disabled={!abortLive}
        title={
          abortLive
            ? 'Abort the running turn'
            : phase === 'exited'
              ? 'No active turn (bridge will no-op)'
              : 'No active turn'
        }
      >
        Abort
      </button>
      {settledHintVisible && phase === 'idle' ? (
        // `input-bar-hint` retained as a semantic anchor (no
        // styling; layout pulse + text colour are utilities).
        <p className="input-bar-hint m-0 basis-full text-[0.82rem] text-muted">agent settled — 5 minutes until auto-shutdown</p>
      ) : null}
      {commandError !== null ? (
        // `input-bar-error` retained as a semantic anchor (no
        // styling; tint is the canonical "red = something
        // failed" 8%-alpha paint matching the other surfaces that
        // flip on `--state-offline`).
        <p className="input-bar-error m-0 basis-full rounded bg-state-offline/[0.08] px-2 py-1 text-[0.82rem] text-state-offline" role="alert" data-testid="input-error">
          {commandError}
        </p>
      ) : null}
    </form>
  );
}
