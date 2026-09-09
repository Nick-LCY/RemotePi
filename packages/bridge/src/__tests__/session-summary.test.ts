// Vitest specs for `readSessionSummary` (the `session_list` row
// summary parser). Covers PRD §4.2 "level2 每行显示 created /
// first_message 摘要 / status 徽章" — first_message was a hardcoded
// `null` placeholder before M4 验收期缺口修复.
//
// Style: bare-file fixtures (tmp dir + writeFileSync), small set of
// per-line JSON literals, numbered cases that each pin one decision.

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIRST_MESSAGE_BYTE_LIMIT,
  FIRST_MESSAGE_LINE_LIMIT,
  FIRST_MESSAGE_TEXT_MAX_CHARS,
  MESSAGE_COUNT_LINE_CAP,
  readSessionSummary,
} from '../session-summary.js';

const trackedDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-summary-'));
  trackedDirs.push(dir);
  return dir;
}

function writeSession(dir: string, name: string, lines: string[]): string {
  const p = path.join(dir, name);
  // Ensure trailing newline so the last line is recognised by the
  // split-on-last-newline logic. Pi always emits a trailing newline.
  writeFileSync(p, lines.length === 0 ? '' : lines.join('\n') + '\n', 'utf8');
  return p;
}

afterEach(() => {
  for (const d of trackedDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Happy path — real-shape pi jsonl
// ---------------------------------------------------------------------------

describe('readSessionSummary — happy path', () => {
  it('1.1 normal session: metadata + user first + assistant replies → firstMessage = first user text, messageCount = N', () => {
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_a1b2c3d4.jsonl', [
      '{"type":"session","version":3,"id":"a1b2c3d4","timestamp":"2026-09-08T10:00:00.000Z","cwd":"/work"}',
      '{"type":"model_change","id":"m1","provider":"anthropic","modelId":"claude-haiku"}',
      '{"type":"thinking_level_change","id":"t1","thinkingLevel":"off"}',
      '{"type":"message","id":"u1","parentId":"t1","message":{"role":"user","content":[{"type":"text","text":"hello pi"}],"timestamp":1}}',
      '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"hello human"}]}}',
      '{"type":"message","id":"u2","parentId":"a1","message":{"role":"user","content":[{"type":"text","text":"second question"}]}}',
      '{"type":"message","id":"a2","parentId":"u2","message":{"role":"assistant","content":[{"type":"text","text":"second answer"}]}}',
    ]);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).toBe('hello pi');
    expect(summary.messageCount).toBe(4);
  });

  it('1.2 real-fixture shape (toolResult message + assistant toolCall message still counts)', () => {
    // Reproduces the on-disk shape from
    // tests/integration/.tmp/.../e2e-.../.../2026-09-09T03-48-18-...jsonl
    // — assistant toolCall + toolResult + plain text messages all
    // share `type: "message"` at the top level and so all count.
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-09T03-48-18-582Z_01a08447.jsonl', [
      '{"type":"session","version":3,"id":"01a08447","cwd":"/work"}',
      '{"type":"model_change","id":"da47373d","provider":"fake-anthropic","modelId":"fake-claude-haiku-4-5"}',
      '{"type":"thinking_level_change","id":"473d944a","thinkingLevel":"off"}',
      '{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"hello-from-e2e"}]}}',
      '{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"hello back from fake LLM"}]}}',
      '{"type":"message","id":"u2","message":{"role":"user","content":[{"type":"text","text":"trigger"}]}}',
      '{"type":"message","id":"a2","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"trigger_dialog","arguments":{}}]}}',
      '{"type":"message","id":"tr1","message":{"role":"toolResult","toolCallId":"t1","content":[{"type":"text","text":"confirmed=true"}]}}',
    ]);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).toBe('hello-from-e2e');
    expect(summary.messageCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 2. firstMessage content shape
// ---------------------------------------------------------------------------

describe('readSessionSummary — firstMessage content shape', () => {
  it('2.1 multi-text-element user content: text elements are joined in order', () => {
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_multi.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      '{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"first part. "},{"type":"text","text":"second part."}]}}',
    ]);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).toBe('first part. second part.');
  });

  it('2.2 mixed content elements: only `type:"text"` elements contribute; non-text elements are skipped', () => {
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_mixed.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      JSON.stringify({
        type: 'message',
        id: 'u1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'before-image ' },
            { type: 'image', source: '…' }, // unknown to us — skip
            { type: 'text', text: 'after-image' },
          ],
        },
      }),
    ]);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).toBe('before-image after-image');
  });

  it('2.3 first user message text exceeding 200 chars is hard-truncated (no ellipsis suffix)', () => {
    const dir = makeTmp();
    const longText = 'a'.repeat(500);
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_long.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      JSON.stringify({
        type: 'message',
        id: 'u1',
        message: { role: 'user', content: [{ type: 'text', text: longText }] },
      }),
    ]);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).not.toBeNull();
    expect(summary.firstMessage!.length).toBe(FIRST_MESSAGE_TEXT_MAX_CHARS);
    expect(summary.firstMessage).toBe('a'.repeat(FIRST_MESSAGE_TEXT_MAX_CHARS));
  });

  it('2.4 first user message text exactly 200 chars is returned verbatim (boundary)', () => {
    const dir = makeTmp();
    const text200 = 'b'.repeat(FIRST_MESSAGE_TEXT_MAX_CHARS);
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_200.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      JSON.stringify({
        type: 'message',
        id: 'u1',
        message: { role: 'user', content: [{ type: 'text', text: text200 }] },
      }),
    ]);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).toBe(text200);
  });

  it('2.4b surrogate-pair truncation: 199 ASCII + 😀 (surrogate pair) fits in cap without orphaning a surrogate', () => {
    // 😀 is U+1F600, encoded in UTF-16 as the surrogate pair
    // \uD83D\uDE00. A naïve `slice(0, 200)` on the UTF-16 string
    // would cut between the high and low surrogate and yield an
    // isolated high surrogate (\uD83D) at the tail — invalid as
    // a JS string for downstream consumers (zod revalidation,
    // JSON.stringify, IndexedDB write). The implementation
    // truncates on code-point boundaries via `Array.from`, so
    // the full 199 ASCII + emoji (200 code points total, 201
    // UTF-16 code units) fits inside the 200-codepoint cap and
    // is returned verbatim. We pin two invariants: (1) no
    // isolated high surrogate at the tail, (2) the code-point
    // length of the result never exceeds the cap.
    const dir = makeTmp();
    const ascii199 = 'a'.repeat(FIRST_MESSAGE_TEXT_MAX_CHARS - 1);
    const textWithEmoji = ascii199 + '😀';
    // Sanity: the test premise is that this is a surrogate pair
    // and that naïve slice(0, 200) on the UTF-16 string would
    // cut it. If either premise breaks (e.g. V8 changes surrogate
    // encoding), the test would silently lose meaning.
    expect(textWithEmoji.length).toBe(FIRST_MESSAGE_TEXT_MAX_CHARS + 1); // 201 UTF-16 code units
    expect(Array.from(textWithEmoji).length).toBe(FIRST_MESSAGE_TEXT_MAX_CHARS); // 200 code points
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_surrogate.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      JSON.stringify({
        type: 'message',
        id: 'u1',
        message: { role: 'user', content: [{ type: 'text', text: textWithEmoji }] },
      }),
    ]);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).not.toBeNull();
    // (1) No orphan high surrogate at the tail — negative
    // assertion directly pins the surrogate-pair correctness.
    expect(/\uD83D$/.test(summary.firstMessage!)).toBe(false);
    // (2) Code-point length of the result is at most the cap.
    expect(Array.from(summary.firstMessage!).length).toBeLessThanOrEqual(FIRST_MESSAGE_TEXT_MAX_CHARS);
    // (3) Whole text fits (200 code points) → returned verbatim.
    expect(summary.firstMessage).toBe(textWithEmoji);
  });

  it('2.5 user message with only non-text content (image-only) → firstMessage null', () => {
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_imageonly.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      JSON.stringify({
        type: 'message',
        id: 'u1',
        message: { role: 'user', content: [{ type: 'image', source: 'data:…' }] },
      }),
    ]);
    const summary = readSessionSummary(p);
    // No text element → no firstMessage, but messageCount still 1.
    expect(summary.firstMessage).toBeNull();
    expect(summary.messageCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. firstMessage role semantics
// ---------------------------------------------------------------------------

describe('readSessionSummary — firstMessage role semantics', () => {
  it('3.1 no user message (only assistant + toolResult) → firstMessage null', () => {
    // Per the task brief, "first_message" means the FIRST USER
    // message — web renders this so the user can recognise the
    // session at a glance. Assistant-only / toolResult-only
    // sessions return null and ChoicePage renders
    // `（无首条消息）`. messageCount still counts every message
    // line regardless of role.
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_assistonly.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      '{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"only assistant reply"}]}}',
      '{"type":"message","id":"tr1","message":{"role":"toolResult","content":[{"type":"text","text":"tool result"}]}}',
    ]);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).toBeNull();
    expect(summary.messageCount).toBe(2);
  });

  it('3.2 assistant message FIRST, then user message → firstMessage = user message text (assistant skipped)', () => {
    // The scan only stops on the first USER message — assistant /
    // toolResult messages are passed over.
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_order.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      '{"type":"message","id":"a0","message":{"role":"assistant","content":[{"type":"text","text":"preamble reply"}]}}',
      '{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"actual user prompt"}]}}',
      '{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}',
    ]);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).toBe('actual user prompt');
    expect(summary.messageCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. messageCount semantics
// ---------------------------------------------------------------------------

describe('readSessionSummary — messageCount semantics', () => {
  it('4.1 only metadata lines (no messages) → messageCount 0', () => {
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_metaonly.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      '{"type":"model_change","id":"m","provider":"x"}',
      '{"type":"thinking_level_change","id":"t","thinkingLevel":"off"}',
    ]);
    const summary = readSessionSummary(p);
    expect(summary.messageCount).toBe(0);
    expect(summary.firstMessage).toBeNull();
  });

  it('4.2 every `type:"message"` line counts (user + assistant + toolResult)', () => {
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_mixed-role.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      '{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"hi back"}]}}',
      '{"type":"message","id":"tr1","message":{"role":"toolResult","content":[{"type":"text","text":"ok"}]}}',
      '{"type":"message","id":"u2","message":{"role":"user","content":[{"type":"text","text":"next"}]}}',
    ]);
    const summary = readSessionSummary(p);
    expect(summary.messageCount).toBe(4);
  });

  it('4.3 non-message event lines (agent_start, response, message_update, etc.) do NOT count', () => {
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_events.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      '{"type":"agent_start"}',
      '{"type":"response","command":"prompt","id":"p1","success":true}',
      '{"type":"message_update","delta":"partial…"}',
      '{"type":"message_end"}',
      '{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"only user msg"}]}}',
    ]);
    const summary = readSessionSummary(p);
    expect(summary.messageCount).toBe(1);
    expect(summary.firstMessage).toBe('only user msg');
  });

  it('4.4 messageCount line cap: more than MESSAGE_COUNT_LINE_CAP message lines caps at the cap', () => {
    const dir = makeTmp();
    // Pin the upper-bound semantics without coupling to the
    // exact arrival sequence — the cap is the contract ("at
    // most CAP messages reported"), and the precise tick on
    // which we stop (first line that crosses CAP, or only after
    // finishing the current chunk) is an implementation detail.
    // We overshoot by a small margin so the test doesn't have
    // to enumerate 50k+ lines; we then assert ≤ cap (upper bound
    // holds) AND > 0 (file clearly contains messages — guards
    // against a regression where the cap kicks in at 0).
    const lines: string[] = ['{"type":"session","version":3,"id":"x"}'];
    for (let i = 0; i < MESSAGE_COUNT_LINE_CAP + 5; i++) {
      lines.push(
        JSON.stringify({
          type: 'message',
          id: `m${i}`,
          message: { role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `m${i}` }] },
        }),
      );
    }
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_cap.jsonl', lines);
    const summary = readSessionSummary(p);
    expect(summary.messageCount).toBeLessThanOrEqual(MESSAGE_COUNT_LINE_CAP);
    expect(summary.messageCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Tolerance — bad inputs don't throw
// ---------------------------------------------------------------------------

describe('readSessionSummary — tolerance', () => {
  it('5.1 missing file → firstMessage null + messageCount 0 (does NOT throw)', () => {
    const dir = makeTmp();
    const ghost = path.join(dir, 'nonexistent.jsonl');
    const summary = readSessionSummary(ghost);
    expect(summary.firstMessage).toBeNull();
    expect(summary.messageCount).toBe(0);
  });

  it('5.2 empty file → firstMessage null + messageCount 0', () => {
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_empty.jsonl', []);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).toBeNull();
    expect(summary.messageCount).toBe(0);
  });

  it('5.3 file with only bad JSON lines → messageCount 0 + firstMessage null (skip silently)', () => {
    const dir = makeTmp();
    writeFileSync(
      path.join(dir, '2026-09-08T10-00-00-000Z_bad.jsonl'),
      'not json\n{also bad\n{"type":"message","id":"x"\n', // last line missing closing brace
      'utf8',
    );
    const p = path.join(dir, '2026-09-08T10-00-00-000Z_bad.jsonl');
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).toBeNull();
    expect(summary.messageCount).toBe(0);
  });

  it('5.4 bad JSON lines are skipped while surrounding good lines still count', () => {
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_skip.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      'this is not json', // bad line — skip
      '{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"good user"}]}}',
      '{truncated', // bad line — skip
      '{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"good assist"}]}}',
    ]);
    const summary = readSessionSummary(p);
    expect(summary.messageCount).toBe(2);
    expect(summary.firstMessage).toBe('good user');
  });

  it('5.5 directory instead of file → null + 0 (no throw)', () => {
    const dir = makeTmp();
    const summary = readSessionSummary(dir);
    expect(summary.firstMessage).toBeNull();
    expect(summary.messageCount).toBe(0);
  });

  it('5.6 message line with non-object payload → line skipped (count not incremented)', () => {
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_nonobj.jsonl', [
      '{"type":"session","version":3,"id":"x"}',
      JSON.stringify({ type: 'message', id: 'm1', message: 'not-an-object' }),
      '{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"real one"}]}}',
    ]);
    const summary = readSessionSummary(p);
    // The malformed message line has type:"message" but its `message`
    // field isn't an object — extractFirstUserMessageText returns
    // null, but the outer count has already incremented. We DO count
    // it (the type is correct; only firstMessage lookup bails). This
    // is intentional — a corrupted message line is still semantically
    // a "message" by its top-level type field.
    expect(summary.messageCount).toBe(2);
    expect(summary.firstMessage).toBe('real one');
  });

  it('5.7 empty lines are skipped silently (forward compat for stray newlines)', () => {
    const dir = makeTmp();
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_blanklines.jsonl', [
      '',
      '{"type":"session","version":3,"id":"x"}',
      '',
      '{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"ok"}]}}',
      '',
    ]);
    const summary = readSessionSummary(p);
    expect(summary.messageCount).toBe(1);
    expect(summary.firstMessage).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 6. firstMessage scan window — boundary decisions
// ---------------------------------------------------------------------------

describe('readSessionSummary — firstMessage scan window', () => {
  it('6.1 user message past FIRST_MESSAGE_BYTE_LIMIT → firstMessage null (window closed)', () => {
    // Pad the metadata preamble with enough lines to push the first
    // user message past the 64KB window. Each padding line is
    // ~1.2 KB of garbage text — 60 lines × 1.2 KB ≈ 72 KB, past
    // the 64 KB limit. The real user message at the end is
    // therefore outside the scan window → firstMessage null.
    const dir = makeTmp();
    const padding = 'x'.repeat(1100); // ~1.1 KB per line
    const lines: string[] = [
      '{"type":"session","version":3,"id":"x"}',
      ...Array.from({ length: 70 }, (_, i) =>
        JSON.stringify({ type: 'padding_line', n: i, data: padding }),
      ),
      JSON.stringify({
        type: 'message',
        id: 'u1',
        message: { role: 'user', content: [{ type: 'text', text: 'past-the-window' }] },
      }),
    ];
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_window.jsonl', lines);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).toBeNull();
    // messageCount still sees the user message (no window cap on count).
    expect(summary.messageCount).toBe(1);
  });

  it('6.2 user message past FIRST_MESSAGE_LINE_LIMIT → firstMessage null', () => {
    // Symmetric to 6.1 but using the line-limit guard: a file
    // with 200+ non-message lines pushes the user message past the
    // line budget.
    const dir = makeTmp();
    const lines: string[] = [
      '{"type":"session","version":3,"id":"x"}',
      ...Array.from({ length: FIRST_MESSAGE_LINE_LIMIT + 5 }, (_, i) =>
        JSON.stringify({ type: 'pad', n: i }),
      ),
      JSON.stringify({
        type: 'message',
        id: 'u1',
        message: { role: 'user', content: [{ type: 'text', text: 'past-line-window' }] },
      }),
    ];
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_lines.jsonl', lines);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).toBeNull();
    expect(summary.messageCount).toBe(1);
  });

  it('6.3 user message within the window → firstMessage resolved (sanity)', () => {
    // Sanity check: a normal session (well under both limits)
    // returns the user message. This pins that the window caps
    // don't trigger false positives on real-world data.
    const dir = makeTmp();
    const lines: string[] = [
      '{"type":"session","version":3,"id":"x"}',
      '{"type":"model_change","id":"m"}',
      '{"type":"thinking_level_change","id":"t"}',
      '{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    ];
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_sanity.jsonl', lines);
    const summary = readSessionSummary(p);
    expect(summary.firstMessage).toBe('hi');
    expect(summary.messageCount).toBe(1);
    // Sanity: limits are positive (defensive — guards against
    // future constants being zeroed out by accident).
    expect(FIRST_MESSAGE_BYTE_LIMIT).toBeGreaterThan(0);
    expect(FIRST_MESSAGE_LINE_LIMIT).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. firstMessage byte-window granularity — per-line cursor (M4 验收期 2nd-gap)
//
// The byte budget used to be tracked at CHUNK granularity
// (`bytesRead += n` after `readSync`), so a single chunk of ≥
// 64 KB immediately closed the window for every line in that
// chunk — even when the actual user prompt lived at byte ~400
// of the chunk. This section钉s the regression at three
// boundaries:
//
//   7.1 user prompt early + file > 64 KB → must extract
//       (the钉子钉的 bug: old code returned null).
//   7.2 user prompt straddles the 64 KB byte boundary → must
//       extract (line-START position is what gates; the body
//       can extend past the limit without losing the line).
//   7.3 user prompt genuinely past the byte limit → must remain
//       null (window-guard sanity on the new cursor).
//
// The fixtures use precise padding sizes so the user-prompt
// start byte lands exactly where we claim — a comment above
// each fixture shows the arithmetic.
describe('readSessionSummary — byte-window per-line cursor', () => {
  it('7.1 REGRESSION 钉子: 3-line preamble + user prompt at line 4 + file > 64 KB → firstMessage extracted', () => {
    // Layout (exact bytes):
    //   line 1: session metadata, ~71 bytes incl. newline
    //   line 2: model_change, ~76 bytes incl. newline
    //   line 3: thinking_level_change, ~61 bytes incl. newline
    //   line 4: USER prompt — start byte ≈ 209, length ~50
    //           (well within the 64 KB window)
    //   lines 5..N: ~80 padding lines of ~1100 bytes each →
    //               pushes file size to ~88 KB (well past 64 KB)
    //
    // Bug repro (old chunk-aligned logic):
    //   - `readSync` reads the first 64 KB chunk in one shot
    //     (file is > 64 KB).
    //   - `bytesRead = 65536` immediately after that one read.
    //   - Per-line check `bytesRead >= FIRST_MESSAGE_BYTE_LIMIT`
    //     fires on line 1 → `firstMessageWindowClosed = true`
    //     → every line in the chunk is bypassed → firstMessage
    //     is null even though the user prompt sits at byte ~209.
    //
    // New logic (per-line cursor):
    //   - `windowBytesSeen` advances only as lines are processed:
    //     after line 1 ≈ 72, line 2 ≈ 148, line 3 ≈ 209.
    //   - At line 4 start: `windowBytesSeen = 209`, NOT > 64 KB
    //     → user prompt is processed → firstMessage extracted.
    //   - The line-4 body is fully processed even though it's
    //     in the same chunk as lines that cross 64 KB later.
    const dir = makeTmp();
    const userText = 'preamble-prompt-extracted';
    const padding = 'x'.repeat(1100); // ~1.1 KB per line
    const lines: string[] = [
      '{"type":"session","version":3,"id":"x"}',
      '{"type":"model_change","id":"m","provider":"anthropic","modelId":"x"}',
      '{"type":"thinking_level_change","id":"t","thinkingLevel":"off"}',
      JSON.stringify({
        type: 'message',
        id: 'u1',
        message: { role: 'user', content: [{ type: 'text', text: userText }] },
      }),
      ...Array.from({ length: 80 }, (_, i) =>
        JSON.stringify({ type: 'padding', n: i, data: padding }),
      ),
    ];
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_regression.jsonl', lines);
    // Sanity: file is past 64 KB (otherwise the bug doesn't trigger
    // and the test would pass for the wrong reason).
    const fileBytes = statSync(p).size;
    expect(fileBytes).toBeGreaterThan(FIRST_MESSAGE_BYTE_LIMIT);
    const summary = readSessionSummary(p);
    // THE钉子钉的 assertion — old impl returned null here.
    expect(summary.firstMessage).toBe(userText);
    // messageCount still sees the user message + every padding
    // `type:"message"` line — but the padding lines have type
    // "padding", so the count should be 1 (the user message).
    expect(summary.messageCount).toBe(1);
  });

  it('7.2 user prompt straddles the 64 KB byte boundary (start ≤ limit, end > limit) → firstMessage extracted', () => {
    // Layout goal:
    //   line 1: session metadata
    //   lines 2..K+1: fixed-size padding lines so the byte math
    //                 is closed-form
    //   line K+2: USER prompt whose start byte is in
    //             [0, FIRST_MESSAGE_BYTE_LIMIT] but whose body
    //             extends past the limit
    //
    // Approach: compute the actual padding-line size via
    // `Buffer.byteLength` so the math is exact (UTF-8 ASCII, so
    // byte length == char length). Then pick K so the user
    // line's start byte lands in the last few hundred bytes of
    // the window — close enough to the cut that a body of ~250
    // chars straddles it.
    const dir = makeTmp();
    const userText = 'a'.repeat(250); // body length 250
    // Use 2 padding lines of ~32 KB each so the user line lands
    // at byte ~65416 (within 64 KB) but extends to ~65758
    // (past 64 KB). Two padding lines also keeps `linesSeen`
    // = 2 when the user line is processed — well below
    // FIRST_MESSAGE_LINE_LIMIT (200), so the test isolates the
    // BYTE-window behaviour from the LINE-window behaviour.
    //
    // Why 2 lines instead of 275 small ones: if we used many
    // small padding lines (e.g. 275 × 238 bytes), `linesSeen`
    // would already be past FIRST_MESSAGE_LINE_LIMIT by the
    // time the user line is processed in the second chunk,
    // and the LINE-window guard would close the window —
    // masking the byte-window behaviour we're trying to test.
    // With 2 padding lines we cleanly isolate the byte guard.
    const padPayload = 'p'.repeat(32650);
    const padSample = JSON.stringify({ type: 'padding', n: '00000', d: padPayload });
    const padSize = Buffer.byteLength(padSample, 'utf8') + 1; // +1 for trailing '\n'

    const metaLine = '{"type":"session","version":3,"id":"x"}';
    const metaSize = Buffer.byteLength(metaLine, 'utf8') + 1;
    const K = 2;

    const padding = Array.from({ length: K }, () =>
      JSON.stringify({ type: 'padding', n: '00000', d: padPayload }),
    );
    const userLine = JSON.stringify({
      type: 'message',
      id: 'u1',
      message: { role: 'user', content: [{ type: 'text', text: userText }] },
    });
    const lines: string[] = [metaLine, ...padding, userLine];
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_straddle.jsonl', lines);

    // Pin the preconditions so this test cannot silently lose
    // meaning if the fixture shape changes. Closed-form math
    // (every padding line has identical size):
    const startByte = metaSize + K * padSize;
    const endByte = startByte + Buffer.byteLength(userLine, 'utf8');
    // (1) Start byte is within the window.
    expect(startByte).toBeLessThanOrEqual(FIRST_MESSAGE_BYTE_LIMIT);
    // (2) End byte crosses the window — i.e. the body straddles.
    expect(endByte).toBeGreaterThan(FIRST_MESSAGE_BYTE_LIMIT);
    // (3) The window-guard semantic per `session-summary.ts`
    //     JSDoc: "行起始游标 ≤ limit 即在窗口内" — strict `>`,
    //     so a start byte of EXACTLY FIRST_MESSAGE_BYTE_LIMIT
    //     would still be in the window. Our start is < limit
    //     (we left 100 bytes of headroom), well inside.
    expect(startByte).toBeLessThan(FIRST_MESSAGE_BYTE_LIMIT);
    // (4) The file is past 64 KB — i.e. the buggy chunk-aligned
    //     check WOULD have fired on this file in the old code.
    //     We want to prove the new per-line cursor works on a
    //     file where the bug would have triggered. Strict
    //     `>` (not `>=`) so a file of exactly 64 KB doesn't
    //     silently degrade into a chunk-aligned test.
    expect(statSync(p).size).toBeGreaterThan(FIRST_MESSAGE_BYTE_LIMIT);

    const summary = readSessionSummary(p);
    // The user line's START byte is within the window, so the
    // whole line is processed — the body crossing past the limit
    // does NOT close the window mid-line. The full 250-char
    // prompt is extracted (then truncated by FIRST_MESSAGE_TEXT_MAX_CHARS
    // — 250 > 200, so we expect the truncated form, not the raw
    // 250-char string). See extractFirstUserMessageText for
    // truncation semantics.
    expect(summary.firstMessage).not.toBeNull();
    expect(summary.firstMessage!.length).toBe(FIRST_MESSAGE_TEXT_MAX_CHARS);
    expect(summary.firstMessage).toBe('a'.repeat(FIRST_MESSAGE_TEXT_MAX_CHARS));
  });

  it('7.3 user prompt genuinely past the 64 KB byte limit (start > limit) → firstMessage null', () => {
    // Sanity钉子 on the NEW per-line cursor: when the user
    // prompt's start byte is genuinely past FIRST_MESSAGE_BYTE_LIMIT
    // (not just its body, but its start), the window must close
    // and firstMessage stays null. Mirrors existing 6.1 but
    // makes the assertion explicit on the new `windowBytesSeen
    // > limit` check rather than the chunk-aligned one.
    const dir = makeTmp();
    const padding = 'y'.repeat(1100);
    const lines: string[] = [
      '{"type":"session","version":3,"id":"x"}',
      ...Array.from({ length: 80 }, (_, i) =>
        JSON.stringify({ type: 'padding', n: i, data: padding }),
      ),
      JSON.stringify({
        type: 'message',
        id: 'u1',
        message: { role: 'user', content: [{ type: 'text', text: 'past-window' }] },
      }),
    ];
    const p = writeSession(dir, '2026-09-08T10-00-00-000Z_overflow.jsonl', lines);
    const summary = readSessionSummary(p);
    // Pin: user line's start byte is well past 64 KB →
    // windowBytesSeen > FIRST_MESSAGE_BYTE_LIMIT on the first
    // iteration that touches it → firstMessageWindowClosed
    // flips to true before parse → user line is skipped for
    // firstMessage scan. messageCount still sees it (count
    // loop is not gated by the window).
    expect(summary.firstMessage).toBeNull();
    expect(summary.messageCount).toBe(1);
  });
});
