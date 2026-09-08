// E2E scenario (a): first-turn streaming render — see ADR-0009 §决策 3
// 场景 (a) + 任务 13 §场景 (a) 补全.
//
// Verifies the M3 happy path end-to-end:
//   1. `page.goto('/#<token>')` triggers the dual-query recovery
//      ceremony.
//   2. ChatView renders (with retry tolerance for the 5s
//      RECOVERY_TIMEOUT_MS vs. cold pi-startup race documented in
//      ADR-0009 §开放点 1 — see retry-tolerant block below).
//   3. The user types into `input-field` and clicks `input-send`.
//   4. The user message row appears with the typed text (filtered
//      by `.message-role-user` per S7 review tightening — the
//      unfiltered `data-testid="message-row"` selector would
//      match any row whose body text contains the substring,
//      including a future assistant echo; the role class is
//      authoritative for the row's identity).
//   5. The assistant's terminal message row appears, also
//      filtered by `.message-role-assistant` (S7), with the
//      expected full text.
//   6. The streaming draft grows monotonically as the scripted
//      multi-delta reply unfolds (task 12 §场景 (a) step 7 —
//      now actually landed; previous harness relied on a single-
//      delta default that flashed the draft too quickly to
//      observe). We assert at least two intermediate draft
//      snapshots with strictly increasing length, then the
//      terminal row with the full text.
//   7. After the agent settles, the input field is usable again.
//
// ## Multi-delta script injection
//
// The fake LLM server runs as a standalone child (see
// fake-llm-process.ts); the spec can't reach into its in-process
// `script()` state directly. Instead we POST to
// `${fakeLlmUrl}/__e2e/script` — a loopback-only admin endpoint
// added in task 13 (see tests/integration/helpers/fake-llm-server.ts
// handleScriptInjection JSDoc) that REPLACES the server's script
// queue. We inject a 5-delta reply BEFORE sending the prompt so
// the web sees a multi-event SSE stream rather than the single-
// delta default.
//
// The 5-delta choice is deliberate: it's enough to observe
// monotonic draft growth (5 intermediate snapshots is overkill
// for `expect.poll`, but 2-3 is the sweet spot — fewer than 2
// leaves no monotonic-growth signal, more than 5 makes the
// SSE timing on a slow machine compress to a single frame).

import { test, expect, type Page } from '@playwright/test';

import { readRunState } from '../helpers/global-setup.js';
import { injectScript } from '../helpers/llm-script.js';
import {
  sseContentBlockDelta,
  sseContentBlockStart,
  sseContentBlockStop,
  sseMessageDelta,
  sseMessageStart,
  sseMessageStop,
} from '../../integration/helpers/fake-llm-server.js';

const MULTI_DELTA_PARTS = ['hello ', 'back ', 'from ', 'fake ', 'LLM'] as const;
const MULTI_DELTA_FULL = MULTI_DELTA_PARTS.join('');

function buildMultiDeltaScript(): Array<{ event: string; data: unknown }> {
  const messageId = `msg_e2e_${Date.now().toString(36)}`;
  const events: Array<{ event: string; data: unknown }> = [
    sseMessageStart({ messageId, model: 'fake-claude-haiku-4-5', inputTokens: 10 }),
    sseContentBlockStart({ index: 0, block: { type: 'text', text: '' } }),
  ];
  for (const part of MULTI_DELTA_PARTS) {
    events.push(sseContentBlockDelta({ index: 0, delta: { type: 'text_delta', text: part } }));
  }
  events.push(sseContentBlockStop({ index: 0 }));
  events.push(sseMessageDelta({ stopReason: 'end_turn', outputTokens: MULTI_DELTA_FULL.length }));
  events.push(sseMessageStop());
  return events;
}

async function waitForChatViewOrRecovery(page: Page): Promise<'chat-view' | 'recovery-error'> {
  // Same retry-tolerant block as task 12 (5s recovery timeout vs
  // cold pi-startup race, ADR-0009 §开放点 1). One retry on
  // `recovery-error`, no second retry — we want a loud failure
  // when the underlying挂账 truly blocks.
  const either = await Promise.race([
    page
      .locator('[data-testid="chat-view"]')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'chat-view' as const)
      .catch(() => null),
    page
      .locator('[data-testid="recovery-error"]')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'recovery-error' as const)
      .catch(() => null),
  ]);
  if (either === 'recovery-error') {
    await page.locator('[data-testid="recovery-retry"]').click();
    await page
      .locator('[data-testid="chat-view"]')
      .waitFor({ state: 'visible', timeout: 30_000 });
    return 'chat-view';
  }
  if (either !== 'chat-view') {
    throw new Error('Neither chat-view nor recovery-error appeared within 30s');
  }
  return 'chat-view';
}

test.describe('scenario (a) — first-turn streaming render', () => {
  test('user sends a prompt; assistant streams multi-delta; input regains focus', async ({ page }) => {
    const state = await readRunState();
    const { token, baseUrl, fakeLlmUrl } = state;

    // M4 task 08: still on the M3 token-only URL — the bridge's
    // outbound wrapper (task 06) only injects the session field
    // on `session_state` envelopes, not on events / snapshots.
    // That means a `&session=new` outbound would create a
    // `new:<work_dir>` map key on the bridge whose events arrive
    // session-less at the web and get routed to the M3_LEGACY
    // bucket — not the `new` bucket ChatView is reading. M3
    // token-only URL goes through the M3_LEGACY manager whose
    // events DO arrive in the M3_LEGACY bucket, so ChatView (now
    // pinned to the M3_LEGACY bucket when currentSessionKey is
    // null) renders correctly. This is the same M3-compat path
    // task 10's spec acknowledges and will eventually retire. See
    // the task 08 report for the M3_LEGACY retirement evaluation.
    await page.goto(`${baseUrl}/#${token}`);
    await waitForChatViewOrRecovery(page);

    // Inject the multi-delta reply BEFORE sending the prompt so
    // the LLM call (which the bridge spawns pi to make on the
    // user's prompt) hits our scripted queue rather than the
    // server's default `textReply('ok')`. The script REPLACES the
    // queue (server semantics, not appends — see
    // handleScriptInjection JSDoc) so a stale queue from an
    // earlier spec doesn't bleed through.
    const count = await injectScript(fakeLlmUrl, [
      { kind: 'reply', reply: buildMultiDeltaScript() },
    ]);
    expect(count, 'injectScript should accept exactly one entry').toBe(1);

    // Type + send.
    const inputField = page.locator('[data-testid="input-field"]');
    await inputField.waitFor({ state: 'visible', timeout: 10_000 });
    await inputField.fill('hello-from-e2e');
    const sendButton = page.locator('[data-testid="input-send"]');
    // Start the in-page MutationObserver BEFORE clicking send.
    // The observer setup runs in the page's microtask queue, so
    // it's armed by the time the first SSE delta arrives — any
    // window between click and observer-armed would let an
    // intermediate draft render slip past unrecorded.
    //
    // The evaluate awaits the assistant terminal row inside the
    // page context (with a 20s budget) so we don't need to race
    // the click → LLM response on the Node side; the page knows
    // when it's done.
    const observerPromise = page.evaluate(async () => {
      const samples: number[] = [];
      const draftSelector = '[data-testid="message-draft"]';
      const start = performance.now();
      const deadline = start + 20_000;
      // Observe the MessageList subtree (the closest stable
      // ancestor of the draft) so we catch inserts/removals even
      // if the draft element itself is replaced by the terminal
      // message row mid-flight.
      const messageList = document.querySelector('[data-testid="message-list"]');
      if (messageList === null) {
        return { samples, error: 'message-list not found at evaluate time' };
      }
      const observer = new MutationObserver(() => {
        const draft = document.querySelector(draftSelector);
        if (draft !== null) {
          // `textContent` on the `<li>` includes BOTH the role
          // label (`assistant`/`user`) and the body text; the
          // appended delta only contributes to `.message-body`.
          // We measure the body specifically so the sample length
          // maps 1:1 to the streamed text length (no role-label
          // constant offset).
          const body = draft.querySelector('.message-body');
          const text = body?.textContent ?? '';
          const len = text.length;
          if (len > 0) {
            const last = samples[samples.length - 1];
            if (last !== len) samples.push(len);
          }
        }
      });
      observer.observe(messageList, { childList: true, subtree: true, characterData: true });
      // Poll until the deadline OR until the assistant terminal
      // row is present (whichever comes first). We don't want to
      // hold the observer alive past the natural end of the
      // streaming phase.
      while (performance.now() < deadline) {
        const assistant = document.querySelector(
          '[data-testid="message-row"].message-role-assistant',
        );
        if (assistant !== null) {
          // Wait one more animation frame to catch any final
          // MutationObserver flush before disconnecting.
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      observer.disconnect();
      return { samples, error: null };
    });
    await sendButton.click();

    // User message row (S7 — filter by role class). The MessageList
    // renders the user message immediately on `sendPrompt` (local
    // optimistic append); the role class is the authoritative
    // identity for the row.
    const userRow = page.locator(
      '[data-testid="message-row"].message-role-user',
      { hasText: 'hello-from-e2e' },
    );
    await userRow.waitFor({ state: 'visible', timeout: 15_000 });

    // Await the in-page observer's completion — it records every
    // intermediate draft length and signals when the terminal
    // assistant row appears.
    const draftGrowthSamples = await observerPromise;
    expect(
      draftGrowthSamples.error,
      'MutationObserver setup',
    ).toBeNull();
    expect(
      draftGrowthSamples.samples.length,
      `expected at least 2 distinct draft text lengths (monotonic growth signal); got [${draftGrowthSamples.samples.join(', ')}]`,
    ).toBeGreaterThanOrEqual(2);
    // Verify strict monotonicity (this is the load-bearing
    // assertion — a non-monotonic sequence means the renderer
    // emitted shorter text after longer text, which is a real
    // regression bug).
    for (let i = 1; i < draftGrowthSamples.samples.length; i += 1) {
      const prev = draftGrowthSamples.samples[i - 1] as number;
      const curr = draftGrowthSamples.samples[i] as number;
      expect(
        curr > prev,
        `draft text length must be strictly increasing: [${draftGrowthSamples.samples.join(', ')}]`,
      ).toBe(true);
    }
    // The last sample must reach the full scripted length — the
    // observer stops once the terminal row appears, but the
    // draft's final commit should match the LLM's terminal text.
    expect(
      draftGrowthSamples.samples[draftGrowthSamples.samples.length - 1],
      'final draft length should reach the full scripted text length',
    ).toBe(MULTI_DELTA_FULL.length);
    // terminal row appears once the WsClient's `message_end`
    // handler clears the matching draft and appends the final
    // message. `count() === 1` (per S7 tightening) catches the
    // double-render regression where the terminal row briefly
    // appears alongside a stale draft before both settle.
    const assistantRow = page.locator(
      '[data-testid="message-row"].message-role-assistant',
      { hasText: MULTI_DELTA_FULL },
    );
    await expect
      .poll(async () => await assistantRow.count(), {
        timeout: 30_000,
        message: 'assistant message-row with full multi-delta text never appeared',
      })
      .toBe(1);

    // After agent_settled, the input field is usable again
    // (textbox gated ONLY by phase; sendButton gated by phase
    // AND value non-empty). See task 12 spec for the full
    // reasoning on why we assert on inputField (not sendButton
    // alone).
    await expect(inputField).toBeEnabled({ timeout: 30_000 });
    await inputField.fill('ready-again');
    await expect(sendButton).toBeEnabled({ timeout: 5_000 });

    // Draft cleanup — `message-draft` must be gone after the
    // terminal message arrives (WsClient's message_end handler
    // clears the draft in the same React batch as the message
    // append). Tolerate either instantaneous terminal (no draft
    // ever visible) or a transient draft replaced by the
    // terminal.
    const draft = page.locator('[data-testid="message-draft"]');
    await expect(draft).toHaveCount(0, { timeout: 30_000 });
  });
});
