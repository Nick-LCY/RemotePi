// Vitest specs for `mergeToolResults` (M5 验收期 gap fix — tool
// result 渲染层归并进 toolCall pill).
//
// Strategy: pure-function unit tests against `mergeToolResults`,
// running under vitest's default node environment (no jsdom /
// happy-dom — project policy, see `assistant-message-body.test.tsx`
// header + ADR-0009 §决策 4). The function is framework-free so
// the tests don't need a React / DOM stack.
//
// Coverage targets (≥10 per the task spec):
//   1.  Single toolCall ↔ toolResult match (basic happy path).
//   2.  Same assistant message with multiple toolCalls — matched
//       by id, NOT by position (the second test pins the "matched
//       by id, not by order" rule explicitly).
//   3.  Multiple toolResults per assistant message — order
//       independence (toolResults arriving in any order all
//       attach correctly).
//   4.  `isError` flag propagation from toolResult to attached
//       MergedToolResult.
//   5.  Orphan toolResult (no matching toolCall) — preserved in
//       output with `__mergedOrphan: true` marker.
//   6.  toolResult with non-text content blocks — text is joined,
//       non-text is silently skipped.
//   7.  Input array is NEVER mutated (regression guard — a future
//       refactor must not start mutating).
//   8.  Assistant message with NO toolCall blocks — the
//       corresponding toolResult falls back to orphan.
//   9.  Empty input array → empty output.
//   10. Out-of-order arrival: toolResult appears BEFORE its
//       assistant message (the function must still match by id,
//       not by adjacency).
//   11. (Bonus) toolCall without matching toolResult — survives
//       merge intact (no result field attached), so the renderer
//       still shows the `pending…` hint for in-flight calls.
//   12. (Bonus) Assistant message where SOME toolCalls match and
//       SOME don't — partial merge keeps the unmatched as
//       pending; only the matched blocks get a result.

import { describe, expect, it } from 'vitest';

import {
  mergeToolResults,
  ORPHAN_MARKER_KEY,
  type MergedToolResult,
} from '../components/toolResultMerge.js';

// ---------------------------------------------------------------------------
// Helpers — small builder functions to keep test bodies readable
// ---------------------------------------------------------------------------

function assistant(...content: unknown[]): unknown {
  return { role: 'assistant', content };
}

function user(text: string): unknown {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function toolCall(id: string, name = 'bash', args: Record<string, unknown> = {}): unknown {
  return { type: 'toolCall', id, name, arguments: args };
}

function toolResult(
  toolCallId: string,
  text: string,
  opts: { isError?: boolean; toolName?: string; content?: unknown[] } = {},
): unknown {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: opts.toolName ?? 'bash',
    content: opts.content ?? [{ type: 'text', text }],
    isError: opts.isError ?? false,
    timestamp: 1_700_000_000,
  };
}

// ---------------------------------------------------------------------------
// 1. Single toolCall ↔ toolResult match
// ---------------------------------------------------------------------------

describe('mergeToolResults — single match', () => {
  it('1.1 attaches one toolResult to its matching toolCall and removes the toolResult from the output', () => {
    const a = assistant(toolCall('t1', 'bash', { cmd: 'ls' }));
    const r = toolResult('t1', 'file.txt');
    const out = mergeToolResults([a, r]);
    expect(out).toHaveLength(1);
    const resultMsg = out[0] as { role: string; content: unknown[] };
    expect(resultMsg.role).toBe('assistant');
    const block = resultMsg.content[0] as Record<string, unknown>;
    expect(block.type).toBe('toolCall');
    expect(block.id).toBe('t1');
    expect(block.result).toEqual<MergedToolResult>({ text: 'file.txt', isError: false });
  });

  it('1.2 preserves user messages + non-toolResult messages by reference', () => {
    const u = user('hi');
    const a = assistant(toolCall('t1'));
    const r = toolResult('t1', 'ok');
    const out = mergeToolResults([u, a, r]);
    expect(out).toHaveLength(2);
    // User message passes through by reference (no allocation /
      // no copy when the merger has nothing to do with it).
    expect(out[0]).toBe(u);
    expect(out[1]).not.toBe(a); // assistant is reconstructed (content is shallow-cloned)
    expect((out[1] as { role: string }).role).toBe('assistant');
  });
});

// ---------------------------------------------------------------------------
// 2. Multiple toolCalls per assistant — matched by id, not by position
// ---------------------------------------------------------------------------

describe('mergeToolResults — multi-toolCall match by id', () => {
  it('2.1 attaches the second toolResult to the second toolCall (matched by id, not by index)', () => {
    // The id-order is `t-alpha` at index 0, `t-beta` at index 1.
    // We send the toolResult for `t-beta` first — naive
    // position-based matching would attach it to index 0 (wrong).
    const a = assistant(toolCall('t-alpha'), toolCall('t-beta'));
    const r1 = toolResult('t-beta', 'beta-result');
    const r2 = toolResult('t-alpha', 'alpha-result');
    const out = mergeToolResults([a, r1, r2]);
    expect(out).toHaveLength(1);
    const blocks = (out[0] as { content: Record<string, unknown>[] }).content;
    const alphaBlock = blocks.find((b) => b.id === 't-alpha')!;
    const betaBlock = blocks.find((b) => b.id === 't-beta')!;
    expect(alphaBlock.result).toEqual<MergedToolResult>({ text: 'alpha-result', isError: false });
    expect(betaBlock.result).toEqual<MergedToolResult>({ text: 'beta-result', isError: false });
    // The original argument shape is preserved verbatim — only
    // `result` is additive.
    expect(alphaBlock.arguments).toEqual({});
    expect(betaBlock.arguments).toEqual({});
  });

  it('2.2 same-id toolResult delivered twice (rare: re-delivery) — second wins (last-write)', () => {
    // The bridge re-delivers a toolResult for the same id if pi
    // re-emits (rare; the WebSocket would carry the same id again).
    // We treat the second as authoritative (matches the
    // upsertMessage replace-path used for assistant messages).
    const a = assistant(toolCall('t1'));
    const r1 = toolResult('t1', 'first');
    const r2 = toolResult('t1', 'second');
    const out = mergeToolResults([a, r1, r2]);
    expect(out).toHaveLength(1);
    const block = (out[0] as { content: Record<string, unknown>[] }).content[0]!;
    expect(block.result).toEqual<MergedToolResult>({ text: 'second', isError: false });
  });
});

// ---------------------------------------------------------------------------
// 3. isError propagation
// ---------------------------------------------------------------------------

describe('mergeToolResults — isError propagation', () => {
  it('3.1 isError: true propagates from toolResult to MergedToolResult', () => {
    const a = assistant(toolCall('t1'));
    const r = toolResult('t1', 'something went wrong', { isError: true });
    const out = mergeToolResults([a, r]);
    const block = (out[0] as { content: Record<string, unknown>[] }).content[0]!;
    expect(block.result).toEqual<MergedToolResult>({ text: 'something went wrong', isError: true });
  });

  it('3.2 isError missing (older pi build / partial flush) defaults to false', () => {
    const a = assistant(toolCall('t1'));
    // Manually construct a toolResult WITHOUT isError to simulate
    // the older wire shape.
    const r = {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'ok' }],
      timestamp: 1,
    };
    const out = mergeToolResults([a, r]);
    const block = (out[0] as { content: Record<string, unknown>[] }).content[0]!;
    expect(block.result).toEqual<MergedToolResult>({ text: 'ok', isError: false });
  });
});

// ---------------------------------------------------------------------------
// 4. Orphan fallback (no matching toolCall)
// ---------------------------------------------------------------------------

describe('mergeToolResults — orphan fallback', () => {
  it('4.1 toolResult without a matching toolCall is preserved with the orphan marker', () => {
    const r = toolResult('ghost', 'orphan payload');
    const out = mergeToolResults([r]);
    expect(out).toHaveLength(1);
    const orphan = out[0] as Record<string, unknown>;
    expect(orphan.role).toBe('toolResult');
    expect(orphan[ORPHAN_MARKER_KEY]).toBe(true);
    // Original fields are preserved.
    expect(orphan.toolCallId).toBe('ghost');
    expect(orphan.toolName).toBe('bash');
  });

  it('4.2 assistant with no toolCall + toolResult → toolResult becomes orphan', () => {
    // The assistant message has a text block but no toolCall —
    // any toolResult in the array has nothing to match against.
    const a = assistant({ type: 'text', text: 'hello' });
    const r = toolResult('t1', 'orphan result');
    const out = mergeToolResults([a, r]);
    expect(out).toHaveLength(2);
    // The assistant message is unchanged.
    expect(out[0]).toBe(a);
    // The toolResult is preserved as orphan.
    const orphan = out[1] as Record<string, unknown>;
    expect(orphan[ORPHAN_MARKER_KEY]).toBe(true);
  });

  it('4.3 mixed: matched toolResult consumed, orphan toolResult preserved in same array', () => {
    const a1 = assistant(toolCall('t1'));
    const a2 = assistant(toolCall('t2'));
    const rMatched = toolResult('t1', 'matched');
    const rOrphan = toolResult('ghost', 'orphan');
    const out = mergeToolResults([a1, a2, rMatched, rOrphan]);
    expect(out).toHaveLength(3);
    // a1 has result attached
    const block1 = (out[0] as { content: Record<string, unknown>[] }).content[0]!;
    expect(block1.result).toEqual<MergedToolResult>({ text: 'matched', isError: false });
    // a2 has no result (no match)
    expect(((out[1] as { content: Record<string, unknown>[] }).content[0] as Record<string, unknown>).result).toBeUndefined();
    // rOrphan is preserved with marker
    const orphan = out[2] as Record<string, unknown>;
    expect(orphan.role).toBe('toolResult');
    expect(orphan[ORPHAN_MARKER_KEY]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Content shape tolerance (non-text blocks)
// ---------------------------------------------------------------------------

describe('mergeToolResults — content tolerance', () => {
  it('5.1 toolResult with mixed text + non-text content blocks → only text is joined', () => {
    const a = assistant(toolCall('t1'));
    const r = toolResult('t1', '', {
      content: [
        { type: 'text', text: 'line one\n' },
        { type: 'image', url: 'http://x/y.png' }, // not text — skipped
        { type: 'text', text: 'line two' },
      ],
    });
    const out = mergeToolResults([a, r]);
    const block = (out[0] as { content: Record<string, unknown>[] }).content[0]!;
    expect(block.result).toEqual<MergedToolResult>({ text: 'line one\nline two', isError: false });
  });

  it('5.2 toolResult with no text content → empty result text + isError preserved', () => {
    const a = assistant(toolCall('t1'));
    const r = toolResult('t1', '', { isError: true, content: [{ type: 'image', url: 'x' }] });
    const out = mergeToolResults([a, r]);
    const block = (out[0] as { content: Record<string, unknown>[] }).content[0]!;
    expect(block.result).toEqual<MergedToolResult>({ text: '', isError: true });
  });

  it('5.3 toolResult missing `content` field entirely → empty result text', () => {
    const a = assistant(toolCall('t1'));
    // Partial / older wire — no `content` field.
    const r = { role: 'toolResult', toolCallId: 't1', toolName: 'bash', isError: false };
    const out = mergeToolResults([a, r]);
    const block = (out[0] as { content: Record<string, unknown>[] }).content[0]!;
    expect(block.result).toEqual<MergedToolResult>({ text: '', isError: false });
  });
});

// ---------------------------------------------------------------------------
// 6. Input immutability (regression guard)
// ---------------------------------------------------------------------------

describe('mergeToolResults — input immutability', () => {
  it('6.1 input array is NOT mutated (length + identity stable)', () => {
    const a = assistant(toolCall('t1'));
    const r = toolResult('t1', 'matched');
    const rOrphan = toolResult('ghost', 'orphan');
    const input = [a, r, rOrphan];
    // Snapshot the input for post-mutation comparison.
    const inputSnapshot = input.slice();
    const aSnapshot: unknown = JSON.parse(JSON.stringify(a));
    const rSnapshot: unknown = JSON.parse(JSON.stringify(r));
    const rOrphanSnapshot: unknown = JSON.parse(JSON.stringify(rOrphan));
    mergeToolResults(input);
    // Array length + element identity preserved.
    expect(input).toEqual(inputSnapshot);
    expect(input.length).toBe(3);
    expect(input[0]).toBe(a);
    expect(input[1]).toBe(r);
    expect(input[2]).toBe(rOrphan);
    // Nested object deep-equal to the original (no field added,
    // no field removed, no array reordered).
    expect(input[0]).toEqual(aSnapshot);
    expect(input[1]).toEqual(rSnapshot);
    expect(input[2]).toEqual(rOrphanSnapshot);
  });

  it('6.2 deep immutability: toolCall block + assistant content array not mutated', () => {
    // The merger attaches a result by spreading the assistant
    // message + spreading the toolCall block. The original
    // reference must NOT carry the new `result` field after
    // the merge runs — otherwise a future React render using the
    // input reference (rather than the output) would see the
    // attached result and skip the pending render.
    const a = assistant(toolCall('t1', 'bash', { cmd: 'ls' }));
    const r = toolResult('t1', 'file.txt');
    mergeToolResults([a, r]);
    // Original toolCall block has no result field.
    const originalBlock = (a as { content: Record<string, unknown>[] }).content[0]!;
    expect(originalBlock.result).toBeUndefined();
    // Original assistant `content` array length unchanged.
    expect((a as { content: unknown[] }).content.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Empty input
// ---------------------------------------------------------------------------

describe('mergeToolResults — empty input', () => {
  it('7.1 empty input → empty output (by reference, no allocation)', () => {
    const input: unknown[] = [];
    const out = mergeToolResults(input);
    expect(out).toHaveLength(0);
    // Per the "never allocate when nothing to do" contract: the
    // empty input passes through by reference. This is a soft
    // assertion (the contract is "no side effects", not "no
    // allocation"); we keep it because it documents the fast-
    // path intent.
    expect(out).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 8. Out-of-order arrival (乱序容错)
// ---------------------------------------------------------------------------

describe('mergeToolResults — out-of-order arrival', () => {
  it('8.1 toolResult arriving BEFORE its assistant message still matches by id', () => {
    // The pre-scan-then-build strategy means matching is purely
    // by id — position is irrelevant. The toolResult appears
    // before the assistant message in the array; matching still
    // succeeds and the merged assistant message appears at its
    // original index (toolResult is consumed, not promoted).
    const r = toolResult('t1', 'result-text');
    const a = assistant(toolCall('t1'));
    const out = mergeToolResults([r, a]);
    expect(out).toHaveLength(1);
    // The assistant message is at index 0 (the toolResult was
    // consumed; no promotion).
    const block = (out[0] as { content: Record<string, unknown>[] }).content[0]!;
    expect(block.result).toEqual<MergedToolResult>({ text: 'result-text', isError: false });
  });

  it('8.2 toolResults interleaved with assistant messages — all match correctly', () => {
    // a1 has t1; t1-result; a2 has t2; t2-result; user; a3 (no
    // toolCall, only text); orphan-toolResult.
    //   Input: [a1, r1, a2, r2, u, a3, r3] → length 7
    //   After merge: a1 (consumes r1), a2 (consumes r2), u,
    //   a3 (unchanged), r3 (orphan marker) → length 5
    const a1 = assistant(toolCall('t1'));
    const r1 = toolResult('t1', 'one');
    const a2 = assistant(toolCall('t2'));
    const r2 = toolResult('t2', 'two');
    const u = user('hi');
    const a3 = assistant({ type: 'text', text: 'no tool calls here' });
    const r3 = toolResult('ghost', 'orphan');
    const out = mergeToolResults([a1, r1, a2, r2, u, a3, r3]);
    expect(out).toHaveLength(5);
    // a1 has t1 result
    expect(((out[0] as { content: Record<string, unknown>[] }).content[0] as Record<string, unknown>).result).toEqual<MergedToolResult>({ text: 'one', isError: false });
    // a2 has t2 result
    expect(((out[1] as { content: Record<string, unknown>[] }).content[0] as Record<string, unknown>).result).toEqual<MergedToolResult>({ text: 'two', isError: false });
    // u (user) by reference
    expect(out[2]).toBe(u);
    // a3 by reference (no toolCall → no result attached)
    expect(out[3]).toBe(a3);
    // r3 (orphan) preserved with marker
    const orphan = out[4] as Record<string, unknown>;
    expect(orphan[ORPHAN_MARKER_KEY]).toBe(true);
    expect(orphan.role).toBe('toolResult');
    expect(orphan.toolCallId).toBe('ghost');
  });
});

// ---------------------------------------------------------------------------
// 9. Partial match — only SOME toolCalls in an assistant have results
// ---------------------------------------------------------------------------

describe('mergeToolResults — partial match', () => {
  it('9.1 assistant with 3 toolCalls, only 2 have results — unmatched stays as pending', () => {
    const a = assistant(toolCall('t1'), toolCall('t2'), toolCall('t3'));
    const r1 = toolResult('t1', 'one');
    const r3 = toolResult('t3', 'three');
    const out = mergeToolResults([a, r1, r3]);
    expect(out).toHaveLength(1);
    const blocks = (out[0] as { content: Record<string, unknown>[] }).content;
    // t1 + t3 have results, t2 stays as pending (no result field).
    expect((blocks[0] as Record<string, unknown>).result).toEqual<MergedToolResult>({ text: 'one', isError: false });
    expect((blocks[1] as Record<string, unknown>).result).toBeUndefined();
    expect((blocks[2] as Record<string, unknown>).result).toEqual<MergedToolResult>({ text: 'three', isError: false });
  });

  it('9.2 toolCall with no matching toolResult — survives merge intact (renderer shows pending)', () => {
    const a = assistant(toolCall('t1'));
    const out = mergeToolResults([a]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(a); // unchanged reference — no allocation
    const block = (out[0] as { content: Record<string, unknown>[] }).content[0]!;
    expect(block.result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Defensive: messages that don't match either toolCall or
//     toolResult shape pass through untouched.
// ---------------------------------------------------------------------------

describe('mergeToolResults — defensive passes-through', () => {
  it('10.1 system / unknown / null entries pass through untouched', () => {
    const a = assistant(toolCall('t1'));
    const r = toolResult('t1', 'matched');
    const systemMsg = { role: 'system', content: 'beep' };
    const stringMsg = 'a raw string message';
    const nullMsg = null;
    const out = mergeToolResults([systemMsg, a, r, stringMsg, nullMsg]);
    // Input length 5; toolResult `r` is consumed → output length 4.
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(systemMsg);
    expect(out[1]).not.toBe(a); // reconstructed (has attached result)
    expect(out[2]).toBe(stringMsg);
    expect(out[3]).toBe(nullMsg);
  });

  it('10.2 messages with role=toolResult but NO toolCallId are NOT consumed (treated as non-toolResult)', () => {
    // Defensive: a malformed toolResult (no toolCallId) can never
    // match anything; we treat it as a non-toolResult message so
    // the pass-through path handles it. The orphan marker is NOT
    // applied because the message never entered the toolResult
    // branch — the renderer would render it via its default
    // plain-text path. This is the "tolerant of weird wire shapes"
    // contract from the merge JSDoc.
    const r = { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'orphan?' }] };
    const out = mergeToolResults([r]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(r); // passed through by reference
    expect((out[0] as Record<string, unknown>)[ORPHAN_MARKER_KEY]).toBeUndefined();
  });
});