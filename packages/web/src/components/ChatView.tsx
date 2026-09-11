// ChatView — M3 main chat surface (PRD §4.3), made per-session in M4
// task 08 (PRD §4.6).
//
// Composition:
//   <PhaseIndicator />   — StatusBar-below row showing current phase.
//                          `work_dir` source: not part of v1 wire
//                          surface (only bridge config knows it);
//                          we display only phase and note the gap in
//                          the dev report (PRD §4.3 wording allows
//                          this fallback).
//   <MessageList />      — History + streaming draft (typing effect).
//   <QueueIndicator />   — Steering + followUp queue lengths.
//   <InputBar />         — Text input + send + abort.
//   <DialogHost />       — Layered dialog renderer over the chat.
//
// M4 task 08 (PRD §4.6): ChatView now takes a `session` prop and
// reads/writes exclusively from the per-session bucket via
// `bucketFor(session)`. The previous M3 single-bucket reads
// (client.messages, client.sessionPhase, etc.) are still available
// as back-compat getters — they resolve to the current session's
// bucket — but ChatView's internal hooks pin the session so
// background sessions can't accidentally leak into the foreground
// UI.
//
// M5 §1 / §3 — MessageList now renders streaming drafts by
// segment (thinking → `<details>` folded, text → plain `\n`-split
// text inside `.message-body` for e2e 01 spec §6 continuity
// compatibility, tool → folded pill). The terminal assistant
// message body delegates to `<AssistantMessageBody>` which does
// the markdown / folded-think / tool-pill final-state rendering.
// Non-assistant messages (user / toolResult) keep the existing
// pure-text path unchanged (D6).
//
// State source: WsClient per-session bucket. ChatView reads via
// `useXxxFor(session)` hooks (no local state that could drift from
// the protocol) — the only React state local to this subtree is
// the controlled-input value in InputBar.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';

import {
  useCommandErrorSubscription,
  useMessagesFor,
  useQueueFor,
  useSessionPhaseFor,
  useStreamingDraftFor,
  useWsClient,
} from '../ws/WsClientContext.js';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea.js';
import { decideKeyDownAction } from './inputBarKeydown.js';
import { DialogHost } from './dialogs/DialogHost.js';
import type { StreamingSegment } from '../ws/WsClient.js';
import { mergeToolResults } from './toolResultMerge.js';

// M5 review W1 — `AssistantMessageBody` pulls in the entire
// markdown pipeline (react-markdown + remark-gfm +
// rehype-sanitize + micromark + mdast/hast/unist transitives,
// ~170 KB raw / ~52 KB gzip). To stay under the 350 KB first-
// load budget we lazy-load it: the main bundle never imports it
// directly. The component is only needed for TERMINAL assistant
// messages (the streaming-time path uses the lightweight
// `StreamingDraftBody` below, which renders plain text / folded
// `<details>` / tool pills — no markdown). The terminal branch
// fires the dynamic import on first render.
//
// Lazy import reference: kept as a module-level constant so the
// `prewarmMarkdownChunk` effect below can fire the SAME dynamic
// import() on ChatView mount — Vite dedupes by URL, so this is
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
 *  slow-network cases.
 */
function prewarmMarkdownChunk(): void {
  void import('./AssistantMessageBody.js').catch(() => {
    // intentional no-op — see comment above.
  });
}

// ---------------------------------------------------------------------------
// ChatView
// ---------------------------------------------------------------------------

/** M4 task 08 per-session entry. The `session` prop pins the
 *  bucket — all reads/writes inside this subtree go through
 *  `useXxxFor(session)`. `workDir` is plumbed through so the
 *  InputBar's `session: 'new'` prompt auto-fill can include
 *  `payload.work_dir` (裁定 A 方案 A — only the new-session
 *  prompt carries the work_dir field).
 *
 *  M5 review W1 — ChatView mounts the markdown chunk on
 *  first paint (prewarm) so the user-visible first-load
 *  doesn't carry the 170 KB chunk. The chunk only becomes
 *  load-bearing when a terminal assistant message renders —
 *  the streaming draft path renders plain text and never
 *  touches `<AssistantMessageBody>`. */
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
    <div className="chat-view" data-testid="chat-view" data-session={session}>
      <PhaseIndicator session={session} />
      <MessageList session={session} />
      <QueueIndicator session={session} />
      <InputBar session={session} workDir={workDir} />
      <DialogHost />
    </div>
  );
}

// ---------------------------------------------------------------------------
// PhaseIndicator
// ---------------------------------------------------------------------------

/** Small row below the StatusBar showing the current pi subprocess
 *  phase for the per-session bucket. The 5-value enum maps to 5
 *  distinct visual states so the user can spot the transition
 *  between "agent thinking" and "ready for input" at a glance.
 *
 *  `work_dir` is intentionally NOT shown: the v1 wire surface does
 *  not carry bridge-side configuration to the web client, and the
 *  task brief authorises the phase-only fallback ("若无来源则以
 *  phase 为准并在汇报中说明"). The dev report covers this gap. */
function PhaseIndicator({ session }: { session: string }) {
  const phase = useSessionPhaseFor(session);
  const label = phase ?? 'unknown';
  const hint = phaseHint(phase);
  return (
    <div className="phase-indicator" aria-live="polite" data-phase={phase ?? 'unknown'}>
      <span className={`phase-badge phase-${phase ?? 'unknown'}`}>{label}</span>
      {hint !== null ? <span className="phase-hint">{hint}</span> : null}
    </div>
  );
}

function phaseHint(phase: ReturnType<typeof useSessionPhaseFor>): string | null {
  switch (phase) {
    case 'spawning':
      return 'spawning pi…';
    case 'ready':
      return 'ready';
    case 'running':
      return 'agent is working — input disabled';
    case 'idle':
      return 'agent settled — 5 min idle timer running';
    case 'exited':
      return 'exited — next message will respawn pi';
    case null:
      return 'awaiting first session_state…';
    default:
      return null;
  }
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

  // M5 验收期 gap fix — tool result 渲染层归并。`mergeToolResults`
  // walks the per-session bucket's `messages` array, consumes
  // toolResult messages whose `toolCallId` matches a prior
  // assistant message's toolCall block, and attaches the
  // normalised `{text, isError}` payload to that block
  // (immutably, via shallow-copy). Orphan toolResults (no
  // matching toolCall — e.g. MESSAGES_CAP truncated the
  // assistant message) are preserved with `__mergedOrphan: true`
  // and rendered as folded `<details>` by `TerminalMessageBody`'s
  // toolResult branch. Pure function; never mutates the input;
  // runs cheaply on every render (assistant turns carry ≤ a
  // handful of toolCalls; toolResult count is bounded by
  // `MESSAGES_CAP` at 1k).
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
    <section className="card message-list" aria-label="Conversation" data-testid="message-list">
      {items.length === 0 ? (
        <p className="empty" data-testid="message-list-empty">No messages yet — send a prompt to start.</p>
      ) : (
        <ol className="message-list-items">
          {items.map((item) => (
            <li
              key={item.key}
              className={`message-row message-role-${item.role}${item.kind === 'draft' ? ' message-draft' : ''}`}
              data-testid={item.kind === 'draft' ? 'message-draft' : 'message-row'}
            >
              <div className="message-role">{item.role}</div>
              <div className="message-body">
                {item.kind === 'draft' ? (
                  <StreamingDraftBody segments={item.segments} />
                ) : (
                  <TerminalMessageBody role={item.role} raw={item.raw} />
                )}
              </div>
            </li>
          ))}
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
            <details
              key={`think-${idx}`}
              className="message-thinking-details"
              data-testid="message-draft-thinking"
            >
              <summary className="thinking-summary">
                Thinking… ({seg.text.length} chars)
              </summary>
              <div className="thinking-body">{seg.text}</div>
            </details>
          );
        }
        if (seg.type === 'tool') {
          return (
            <details
              key={`tool-${idx}`}
              className="message-tool-details"
              data-testid="message-draft-tool"
            >
              <summary className="message-tool-pill">
                <span aria-hidden="true">🔧</span> {seg.name || 'tool'}
              </summary>
              <pre className="message-tool-body">{seg.args || '(running…)'}</pre>
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
 *  M5 review W1 — `<AssistantMessageBody>` is lazy-loaded; we
 *  wrap it in `<Suspense>` so React has a fallback during the
 *  chunk fetch. The fallback is an empty `<span>` (not a
 *  spinner / "loading…" text) because:
 *    - The prewarm effect in `ChatView` typically lands the
 *      chunk before the user reaches the first terminal
 *      assistant message — the fallback almost never paints.
 *    - When it does paint (cold cache, slow network), an empty
 *      span keeps `.message-body`'s layout stable (no spinner
 *      height jump); the assistant text just appears a frame
 *      later. The user perceives "the message is here, content
 *      coming in" rather than "the UI re-layed out".
 *
 *  M5 验收期 gap fix — toolResult 分支从纯文本路径切换为折叠
 *  details。`mergeToolResults` 已经把「能归并到 assistant toolCall
 *  块的」toolResult 消费掉了；走到这条分支的是「孤儿」toolResult
 *  （找不到匹配 toolCall——典型场景是 MESSAGES_CAP 截断后丢了
 *  上面 assistant 的 toolCall，但 toolResult 还在 1k 窗口内）。
 *  折作为 `<details>` 摘要 + `pre` 内容，避免 29k 字符的 result
 *  裸文本刷屏；isError 为真时加 `.message-tool-result-error`
 *  样式。 */
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
 *  their matching toolCall block's `result` field). */
function OrphanToolResultBody({ raw }: { raw: unknown }) {
  // Narrow the shape defensively — the merge function only
  // preserves toolResult messages with `role === 'toolResult'` +
  // string `toolCallId`. We re-extract the same fields here so
  // a future drift in either layer surfaces a folded details
  // with a sensible fallback rather than crashing the render.
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const toolName = obj !== null && typeof obj.toolName === 'string' ? obj.toolName : 'tool';
  const toolCallId = obj !== null && typeof obj.toolCallId === 'string' ? obj.toolCallId : '';
  const isError = obj !== null && typeof obj.isError === 'boolean' ? obj.isError : false;
  // Joined text — same extraction rule the merge function uses,
  // so the rendered orphan body matches what the matching
  // toolCall would have shown.
  const text = extractTextFromMessage(raw);
  return (
    <details
      className="message-tool-details message-tool-result-orphan"
      data-testid="message-tool-result-orphan"
    >
      <summary className="message-tool-pill">
        <span aria-hidden="true">🔧</span> {toolName}
        {toolCallId.length > 0 ? (
          <span className="message-tool-orphan-id"> · result (orphan)</span>
        ) : (
          <span className="message-tool-orphan-id"> · result</span>
        )}
      </summary>
      <pre
        className={
          isError
            ? 'message-tool-result message-tool-result-error'
            : 'message-tool-result'
        }
      >
        {text}
      </pre>
    </details>
  );
}

/** Minimal text extractor for the terminal-message plain-text
 *  path. Mirrors the original M3 behaviour from `messageToItem`
 *  (extractText / JSON.stringify fallback). The D6 rule keeps
 *  user / toolResult messages on this path; only assistant
 *  messages with `content: Array` opt into the markdown body. */
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
// QueueIndicator
// ---------------------------------------------------------------------------

/** Tiny footer showing the steering + follow_up queue depths. Hidden
 *  when both queues are empty to keep the chat surface uncluttered
 *  (most of the time the queues are empty). */
function QueueIndicator({ session }: { session: string }) {
  const queue = useQueueFor(session);
  const total = queue.steering.length + queue.followUp.length;
  if (total === 0) return null;
  return (
    <div className="queue-indicator" role="status" aria-live="polite" data-testid="queue-indicator">
      <span
        className="queue-pill"
        title="Messages currently steering the running turn (mid-run inserts)"
        data-testid="queue-indicator-steering"
        data-count={queue.steering.length}
      >
        steering: <strong>{queue.steering.length}</strong>
      </span>
      <span
        className="queue-pill"
        title="Messages queued for after the current turn settles"
        data-testid="queue-indicator-follow-up"
        data-count={queue.followUp.length}
      >
        follow-up: <strong>{queue.followUp.length}</strong>
      </span>
    </div>
  );
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
  // M4 task 08: `session === 'new'` requires the prompt to carry
  // `payload.work_dir` (裁定 A 方案 A — only `session: 'new'` carries
  // the work_dir field; the bridge rejects `session: 'new'` without
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

  // M5 task 02 — auto-grow textarea (see
  // `hooks/useAutoResizeTextarea.ts`). The ref is owned by the
  // component (so the hook can keep using `value` as a stable
  // dep) and the hook writes `style.height` against `ref.current`
  // on every render that touches `value`. The hook intentionally
  // does not manage the ref itself — keeping ref ownership local
  // matches the existing `commandErrorTimerRef` style.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutoResizeTextarea({ ref: textareaRef, value });

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(event.target.value);
  };

  /** The shared send path used by both the form's onSubmit and the
   *  input's onKeyDown (S7 review). Extracting it removes the
   *  `event as unknown as FormEvent<...>` cast that the previous
   *  version needed because onKeyDown synthesised a fake form-event
   *  to call onSubmit. Now both call sites just pass a plain string
   *  — no synthetic events, no casts.
   *
   *  M4 task 08 (裁定 A 方案 A): when `session === 'new'`, the
   *  prompt payload carries `work_dir` so the bridge can spawn the
   *  new manager with the right cwd. We use `client.send` (the
   *  low-level escape hatch on `WsClient`) to construct the
   *  envelope with the optional `work_dir` field — the high-level
   *  `sendPrompt` shape is intentionally narrow to in-session
   *  prompts. The bridge rejects `session: 'new'` without
   *  work_dir (钉子 2 边界) so the InputBar is the only place this
   *  is enforced. */
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
    // M5 task 02 / PRD §4 / 验收 §3 — three-piece guard:
    //   Enter + !shiftKey + !isComposing → submit
    //   Shift+Enter → browser native newline (no preventDefault)
    //   IME composing → ignore (let candidate commit)
    // The decision is extracted to `decideKeyDownAction` so the
    // rules are unit-testable without spinning up a DOM /
    // WsClient stack (see `__tests__/input-bar-keydown.test.ts`).
    // `event.nativeEvent.isComposing` is the spec-correct IME
    // flag (UI Events §6.3) — every modern browser sets it on
    // composition-end Enter; Safari historically used
    // `keyCode === 229` for the same state but modern Safari
    // now sets `isComposing` correctly, so no keyCode defence is
    // needed (S-implification: don't carry dead-code paths).
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
    <form className="input-bar" onSubmit={onSubmit} aria-label="Send a prompt">
      <textarea
        ref={textareaRef}
        className="input-bar-field"
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
      <button type="submit" data-testid="input-send" disabled={inputDisabled || value.trim().length === 0}>
        Send
      </button>
      <button
        type="button"
        data-testid="input-abort"
        className={abortLive ? 'abort-button abort-live' : 'abort-button'}
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
        <p className="input-bar-hint">agent settled — 5 minutes until auto-shutdown</p>
      ) : null}
      {commandError !== null ? (
        <p className="input-bar-error" role="alert" data-testid="input-error">
          {commandError}
        </p>
      ) : null}
    </form>
  );
}
