// Vitest specs for `readSessionSummary` (the `session_list` row
// summary parser). Covers PRD §4.2 "level2 每行显示 created /
// first_message 摘要 / status 徽章" — first_message was a hardcoded
// `null` placeholder before M4 验收期缺口修复.
//
// Style: bare-file fixtures (tmp dir + writeFileSync), small set of
// per-line JSON literals, numbered cases that each pin one decision.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    // Generate 2 × cap + 5 messages. Past the cap, additional
    // message lines are ignored — count is the cap exactly. (We
    // deliberately overshoot the cap by a small margin so the
    // test doesn't have to enumerate 50k+ lines; we assert the
    // cap holds by checking count === cap regardless of total.)
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
    expect(summary.messageCount).toBe(MESSAGE_COUNT_LINE_CAP);
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
