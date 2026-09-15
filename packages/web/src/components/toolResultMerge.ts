// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Normalised form of a toolResult attached to a matching toolCall
 *  block. We join `content[].text` into a single string and carry
 *  the `isError` flag through so the renderer can apply error
 *  styling. The original `content` array is intentionally NOT
 *  preserved — the renderer only needs the joined text. */
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
 *  message is irrelevant.
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

  const toolCallIndex = new Map<string, { messageIndex: number; blockIndex: number }>();
  for (let i = 0; i < messages.length; i += 1) {
    const toolCallBlocks = readToolCallBlocks(messages[i]);
    if (toolCallBlocks === null) continue;
    for (let j = 0; j < toolCallBlocks.length; j += 1) {
      const id = toolCallBlocks[j]!.id;
      toolCallIndex.set(id, { messageIndex: i, blockIndex: j });
    }
  }

  const attachedByMessage = new Map<number, Map<number, MergedToolResult>>();

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

  const output: unknown[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const toolCallId = readToolResultId(msg);
    if (toolCallId !== null) {
      const matched = toolCallIndex.get(toolCallId);
      if (matched !== undefined) continue;
      output.push({ ...(msg as Record<string, unknown>), [ORPHAN_MARKER_KEY]: true });
      continue;
    }
    const perMessage = attachedByMessage.get(i);
    if (perMessage !== undefined) {
      output.push(rebuildAssistantWithResults(msg, perMessage));
      continue;
    }
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
 *  Joined text is the pure concatenation of `content[].text` fields
 *  with NO separator (each block's text is the model's emitted chunk
 *  verbatim; the wire never inserts a delimiter between blocks —
 *  adding one would invent content). The `isError` flag is read
 *  defensively (defaults to `false` when missing or non-boolean). */
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
  let nextContent: Record<string, unknown>[] | null = null;
  for (const [blockIndex, merged] of perMessage) {
    if (blockIndex < 0 || blockIndex >= content.length) continue;
    const block: unknown = content[blockIndex];
    if (block === null || typeof block !== 'object') continue;
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
  const keys = Object.keys(block);
  for (const key of keys) {
    out[key] = (block as Record<string, unknown>)[key];
  }
  return out;
}