// toolResultMerge — pure rendering-layer merger for pi-native
// toolCall ↔ toolResult matching (M5 验收期 gap — tool result 未与
// toolCall 合并、被渲染成独立未折叠行)。
//
// ## Why this file exists
//
// Per the scout report, the pi 0.85.x wire delivers tool results
// as **separate messages** (`{role:'toolResult', toolCallId,
// toolName, content:[{type:'text', text}…], isError, timestamp}`)
// that follow the assistant turn's `message_end`. The shared
// `messages` array therefore contains:
//   - assistant message with `content: [{type:'toolCall', id,
//     name, arguments}, …]`
//   - toolResult message(s), one per toolCall (matched by
//     `toolCallId === toolCall.id`).
//
// Two rendering-layer bugs followed from that shape:
//   1. `AssistantMessageBody`'s toolCall branch read
//      `obj.result` — but toolCall blocks carry no result field
//      in the real wire, so the UI rendered `pending…`
//      permanently for every tool call.
//   2. `ChatView`'s toolResult path went through the D6
//      plain-text fallback — each result rendered as its own
//      message row (1 row per tool call), and a single ~29k-
//      char result would dominate the scroll area uncollapsed.
//
// ## Fix strategy (rendering-layer only)
//
// We rebuild the messages list for rendering:
//   - **matched** toolResult messages are consumed (removed
//     from the output) and their `{text, isError}` payload is
//     attached to the corresponding toolCall block on the most
//     recent assistant message (matched by `toolCall.id`).
//   - **orphan** toolResult messages (no matching toolCall —
//     e.g. MESSAGES_CAP truncated the assistant message, or
//     the toolCall landed after the result for any reason) are
//     kept as independent items and rendered as a folded
//     `<details>` summary by the caller.
//
// No WsClient / store / protocol / bridge / worker change is
// made — the wire shape is preserved verbatim and the renderer
// only sees the merged view.
//
// ## Immutability contract
//
// The function never mutates `messages` or any nested object.
// Assistant messages with attached results are reconstructed
// via shallow copies (`{...msg, content: [...content]}` then
// replace the matching index). Tools blocks are reconstructed
// via `{...block, result}` when attaching the merged result.
// Non-matching messages pass through by reference (the
// downstream consumer must not mutate them either, which the
// existing contract already required).

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Normalised form of a toolResult attached to a matching toolCall
 *  block. We join `content[].text` into a single string and carry
 *  the `isError` flag through so the renderer can apply error
 *  styling. The original `content` array is intentionally NOT
 *  preserved — the renderer only needs the joined text (D4: 不
 *  截断 the result body, but only `text` parts survive — image /
 *  binary blocks would be skipped at extraction time). */
export interface MergedToolResult {
  /** Joined text from `content[].text` blocks. `''` when the
   *  toolResult had no text parts. */
  text: string;
  /** `isError` from the wire, defaulting to `false` when missing
   *  (older pi builds or partial flushes). */
  isError: boolean;
}

/** Marker tag attached to orphan toolResult messages that survive
 *  the merge (no matching toolCall block). Pure observability —
 *  the renderer can rely on `role === 'toolResult'` alone to detect
 *  an orphan (all surviving toolResult messages are orphans by
 *  definition), but the marker makes the contract explicit and
 *  gives tests a non-fragile handle. The leading underscores +
 *  the literal "mergedOrphan" key signal "this property was
 *  added by the renderer-side merger, not by the wire" so a
 *  downstream JSON dump carries the marker visibly. */
export const ORPHAN_MARKER_KEY = '__mergedOrphan';
export type OrphanMarker = true;

// ---------------------------------------------------------------------------
// Merge function
// ---------------------------------------------------------------------------

/** Merge toolResult messages into the matching toolCall blocks of
 *  prior assistant messages. Returns a new array — the input is
 *  not mutated. The output preserves the original order of all
 *  non-consumed messages (assistant / user / system / orphan
 *  toolResult); only matched toolResult messages are removed.
 *
 *  **Matching rule**: for each toolResult, find the assistant
 *  message containing a toolCall block whose `id` equals
 *  `toolResult.toolCallId`. When multiple toolCall blocks share
 *  an id across different assistant messages (shouldn't happen
 *  in practice but defensive), the LAST assistant message wins
 *  (the pre-scan overwrites the index). The matching is purely
 *  by id — the toolResult's position relative to its assistant
 *  message is irrelevant (the spec covers out-of-order arrival
 *  via the §乱序容错 test).
 *
 *  **Result attachment**: when a match is found, the assistant
 *  message is reconstructed with a shallow-cloned `content`
 *  array whose matching index holds
 *  `{...toolCall, result: MergedToolResult}`. The original
 *  toolCall block (and its `arguments`, `name`, `id`) is
 *  preserved verbatim — the new `result` field is additive.
 *  Assistant messages without any attached results pass through
 *  by reference (no allocation, no mutation).
 *
 *  **Orphan fallback**: when no matching toolCall is found, the
 *  toolResult message is emitted in the output with an
 *  `__mergedOrphan: true` marker so the caller can render it as
 *  a folded `<details>` instead of plain text. The orphan
 *  marker is additive — all original fields (role / toolCallId /
 *  toolName / content / isError / timestamp) are preserved.
 *
 *  **Input invariants**:
 *  - The function tolerates any shape for the input (each entry
 *    is `unknown`). Messages that don't carry `role === 'toolResult'`
 *    AND a string `toolCallId` are treated as "not a toolResult"
 *    and passed through unchanged.
 *  - Empty input → empty output (no edge cases).
 *  - `messages` is `readonly`; the function never mutates the
 *    caller's array. */
export function mergeToolResults(messages: readonly unknown[]): readonly unknown[] {
  if (messages.length === 0) return messages;

  // Pre-scan: build `toolCallId → {messageIndex, blockIndex}` for
  // every toolCall block across every assistant message. Single
  // map keyed by id — duplicates across assistant messages are
  // resolved by last-wins (see JSDoc).
  const toolCallIndex = new Map<string, { messageIndex: number; blockIndex: number }>();
  for (let i = 0; i < messages.length; i += 1) {
    const toolCallBlocks = readToolCallBlocks(messages[i]);
    if (toolCallBlocks === null) continue;
    for (let j = 0; j < toolCallBlocks.length; j += 1) {
      const id = toolCallBlocks[j]!.id;
      toolCallIndex.set(id, { messageIndex: i, blockIndex: j });
    }
  }

  // If the index is empty (no toolCalls in any assistant message)
  // we still want to walk the messages once to flag any
  // toolResults as orphans. We can't bail early.

  // Aggregate attached results: messageIndex → blockIndex →
  // MergedToolResult. Built incrementally as we encounter
  // matched toolResults.
  const attachedByMessage = new Map<number, Map<number, MergedToolResult>>();

  // We don't strictly need to pre-scan every message here — we
  // could combine this with the build pass. But splitting makes
  // the orphan-vs-match decision a pure function of the
  // pre-built index, which keeps the build pass linear and
  // avoids an in-loop "have we seen this message before" state
  // machine. The pre-scan cost is O(n × avg-toolCall-count);
  // for typical chat turns (1-3 toolCalls) this is well under
  // any user-visible threshold.
  for (let i = 0; i < messages.length; i += 1) {
    const toolCallId = readToolResultId(messages[i]);
    if (toolCallId === null) continue;
    const target = toolCallIndex.get(toolCallId);
    if (target === undefined) continue;
    const merged = extractMergedResult(messages[i]);
    let perMessage = attachedByMessage.get(target.messageIndex);
    if (perMessage === undefined) {
      perMessage = new Map();
      attachedByMessage.set(target.messageIndex, perMessage);
    }
    perMessage.set(target.blockIndex, merged);
  }

  // Build pass: emit one output entry per surviving message,
  // reconstructing assistant messages whose indices appear in
  // `attachedByMessage`. Matched toolResults are SKIPPED (they
  // were consumed); orphans (toolResult without a matching
  // toolCall) get the `__mergedOrphan: true` marker added.
  const output: unknown[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const toolCallId = readToolResultId(msg);
    if (toolCallId !== null) {
      // It's a toolResult message. Was it matched? If yes, skip
      // (consumed into the matching assistant's toolCall block).
      const matched = toolCallIndex.get(toolCallId);
      if (matched !== undefined) continue;
      // Orphan: pass through with the marker. Add the marker
      // immutably — `{...msg, __mergedOrphan: true}` is a fresh
      // shallow copy.
      output.push({ ...(msg as Record<string, unknown>), [ORPHAN_MARKER_KEY]: true });
      continue;
    }
    const perMessage = attachedByMessage.get(i);
    if (perMessage !== undefined) {
      // This assistant message has results attached to one or
      // more of its toolCall blocks. Reconstruct it with a
      // fresh `content` array (shallow clone) and substitute
      // each affected block with `{...block, result: merged}`.
      output.push(rebuildAssistantWithResults(msg, perMessage));
      continue;
    }
    // Unchanged — emit by reference (the contract guarantees
    // the caller never mutates these).
    output.push(msg);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the `toolCallId` of a toolResult-shaped message, or `null`
 *  when the entry doesn't qualify as a toolResult.
 *
 *  ToolResult detection: `role === 'toolResult'` AND `toolCallId`
 *  is a non-empty string. The `toolCallId` is the matching key
 *  against toolCall.id; messages without it can never be matched
 *  (and would be orphans at best), so we treat them as "not a
 *  toolResult" and let the caller pass them through. */
function readToolResultId(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (obj.role !== 'toolResult') return null;
  const id = obj.toolCallId;
  if (typeof id !== 'string' || id.length === 0) return null;
  return id;
}

/** Read the toolCall blocks of an assistant message, returning
 *  an array of `{id, block}` pairs (preserving block order) for
 *  blocks whose `type === 'toolCall'` AND have a string `id`.
 *  Returns `null` when the entry is not an assistant message or
 *  its `content` is not an array — the caller treats `null` as
 *  "no toolCalls to register".
 *
 *  We return the blocks (not just ids) so the rebuild path can
 *  avoid re-reading the message — pre-scan + build use the same
 *  block reference, which lets the rebuild step do a single
 *  shallow copy per attached block instead of a second content
 *  walk. */
function readToolCallBlocks(value: unknown): readonly { id: string; block: Record<string, unknown> }[] | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (obj.role !== 'assistant') return null;
  const content = obj.content;
  if (!Array.isArray(content)) return null;
  const out: { id: string; block: Record<string, unknown> }[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const blockObj = block as Record<string, unknown>;
    if (blockObj.type !== 'toolCall') continue;
    if (typeof blockObj.id !== 'string' || blockObj.id.length === 0) continue;
    out.push({ id: blockObj.id, block: blockObj });
  }
  return out;
}

/** Build a `MergedToolResult` from a toolResult message. Joins
 *  `content[].text` blocks (the only content kind the wire carries
 *  in practice; non-text blocks are silently skipped at extraction
 *  time — image / binary blocks would simply not contribute).
 *
 *  **Exported** (M5 review W1) so the orphan-renderer
 *  (`ChatView.tsx` `OrphanToolResultBody`) and the merger
 *  (`mergeToolResults`) share one source of truth for the
 *  joined-text semantics. Prior to this export, the orphan
 *  path went through `extractTextFromMessage` →
 *  `extractText(obj.content)` which uses a `\n` separator
 *  between content blocks and `trimEnd()` — so the SAME wire
 *  payload `content:[{text:'line1'},{text:'line2'}]` rendered
 *  as `'line1\nline2'` when orphaned vs `'line1line2'` when
 *  matched. The discrepancy confused operators and made the two
 *  render paths impossible to reason about. Both now go
 *  through `extractMergedResult`, which joins text blocks with
 *  NO separator (each block's text is the model's emitted chunk
 *  verbatim; the wire never inserts a delimiter between
 *  blocks — adding one would invent content).
 *
 *  Contract: the joined text is purely the concatenation of
 *  `content[].text` fields. Non-text blocks are skipped. The
 *  `isError` flag is read defensively (defaults to `false`
 *  when missing or non-boolean). */
export function extractMergedResult(value: unknown): MergedToolResult {
  let text = '';
  let isError = false;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.isError === 'boolean') isError = obj.isError;
    const content = obj.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const piece of content) {
        if (piece === null || typeof piece !== 'object') continue;
        const p = piece as Record<string, unknown>;
        if (p.type === 'text' && typeof p.text === 'string') {
          parts.push(p.text);
        }
      }
      text = parts.join('');
    }
  }
  return { text, isError };
}

/** Reconstruct an assistant message with attached results. The
 *  input is the original assistant message; the output is a fresh
 *  object with a shallow-cloned `content` array whose matching
 *  indices hold `{...block, result: MergedToolResult}`. Unaffected
 *  blocks pass through by reference. The non-`content` fields
 *  (`role`, `id`, `timestamp`, etc.) are preserved verbatim via
 *  spread.
 *
 *  Pre-condition: `value` is an assistant message with an array
 *  `content` (we don't re-validate here — the caller has already
 *  passed the `readToolCallBlocks` gate). A defensive fallback
 *  returns the input by reference if the shape is unexpected. */
function rebuildAssistantWithResults(
  value: unknown,
  perMessage: ReadonlyMap<number, MergedToolResult>,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const content: unknown = obj.content;
  if (!Array.isArray(content)) return value;
  // Walk content once, building a new array only when we hit a
  // matched index. Unaffected indices pass through by reference
  // (so a message with 1 of 5 toolCalls attached allocates a
  // fresh array + one new block — minimal churn).
  let nextContent: Record<string, unknown>[] | null = null;
  for (const [blockIndex, merged] of perMessage) {
    if (blockIndex < 0 || blockIndex >= content.length) continue;
    // Type the array element explicitly so the lint rule below
    // doesn't widen `unknown` to `any` on index access.
    const block: unknown = content[blockIndex];
    if (block === null || typeof block !== 'object') continue;
    // Build the new block by cloning the original's own
    // enumerable keys. We can't cast `block as Record<string,
    // unknown>` because the index signature on Record is wider
    // than `unknown`'s, tripping `no-unsafe-*` rules; the
    // loop-local re-keying keeps the type narrow without
    // touching the lint surface.
    const blockCopy = cloneBlock(block);
    if (nextContent === null) {
      nextContent = content.slice() as Record<string, unknown>[];
    }
    blockCopy.result = merged;
    nextContent[blockIndex] = blockCopy;
  }
  if (nextContent === null) return value;
  return { ...obj, content: nextContent };
}

/** Shallow-clone a toolCall block into a `Record<string, unknown>`
 *  with the same enumerable keys. Returns `null` for non-object
 *  inputs so the caller can fall back to the no-op path. The
 *  helper exists because `Object.assign({}, block)` and the
 *  spread `{ ...block }` both trip `no-unsafe-assignment` when
 *  the source is typed `unknown`; the explicit for-loop +
 *  Object.keys walk satisfies the linter without giving up the
 *  narrow typing. */
function cloneBlock(block: unknown): Record<string, unknown> {
  if (block === null || typeof block !== 'object') return {};
  const out: Record<string, unknown> = {};
  // Object.keys on `block` requires `block` to be `object` — the
  // narrow above guarantees that. Each key yields a known
  // string; indexing back into `block` via that key keeps the
  // assignment type-safe (string index into an `object` widens
  // to `unknown`).
  const keys = Object.keys(block);
  for (const key of keys) {
    out[key] = (block as Record<string, unknown>)[key];
  }
  return out;
}