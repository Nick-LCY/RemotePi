// E2E scenario (a): first-turn streaming render — see ADR-0009 §决策 3
// 场景 (a) + 任务 12 §场景 (a).
//
// Verifies the M3 happy path end-to-end:
//   1. `page.goto('/#<token>')` triggers the dual-query recovery
//      ceremony.
//   2. ChatView renders (with retry tolerance for the 5s
//      RECOVERY_TIMEOUT_MS vs. cold pi-startup race documented in
//      ADR-0009 §开放点 1 — see retry-tolerant block below).
//   3. The user types into `input-field` and clicks `input-send`.
//   4. The user message row appears with the typed text.
//   5. The assistant's terminal message row (`message-row`) appears
//      containing the assistant's reply text (the harness's fake
//      server returns a single-delta `textReply('ok')` by default —
//      the assistant message is observable as a single render
//      cycle).
//   6. After the agent settles, the input field is usable again
//      (`input-send` enabled, `input-field` not disabled).
//
// The streaming-draft growth assertion from task 12 §场景 (a) step 7
// is intentionally omitted: the default fake server reply is
// single-delta (one `content_block_delta(text='ok')` event) so the
// draft either flashes too quickly to observe OR never appears at
// all (one-shot terminal render). Asserting on monotonic draft
// growth would require plumbing the spec's own fake-llm server URL
// back into the bridge's fixture (a bridge restart per spec) —
// that work belongs to a future task (e.g. scenario (a)'s
// multi-delta streaming extension under task 13). The MVP contract
// is "draft (if visible) + terminal message row appears with the
// assistant text" — both observable today.

import { test, expect } from '@playwright/test';

import { readRunState } from '../helpers/global-setup.js';

test.describe('scenario (a) — first-turn streaming render', () => {
  test('user sends a prompt; assistant streams back; input regains focus', async ({ page }) => {
    const state = await readRunState();
    const { token, baseUrl } = state;

    // Navigate to the URL with the run-tag token in the hash. The
    // hash is the single source of truth for the token — App.tsx
    // reads it on mount and drives the WsClient.
    await page.goto(`${baseUrl}/#${token}`);

    // Retry-tolerant recovery assertion (ADR-0009 §开放点 1).
    //
    // On a cold wrangler + pi spawn, the dual-query ceremony's
    // 5s RECOVERY_TIMEOUT_MS can fire before pi is ready. Until
    // that 挂账 (current-state TODO 2026-09-07) is resolved, E2E
    // first-turn may hit the recovery-error card on the first
    // cold attempt. We tolerate one retry: click
    // `recovery-retry`, wait for `chat-view`. If we get ChatView
    // first, no retry is needed.
    //
    // We use `Promise.race` rather than `expect.poll` because
    // race gives us a cleaner answer (which one fired first) for
    // the retry decision below.
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
      // One retry, then wait for chat-view. We do NOT loop — if
      // the second attempt also times out, the test fails loudly
      // so we can investigate (the 挂账 is supposed to be
      // fixed soon; extra retries here would mask the symptom
      // rather than fix it).
      await page.locator('[data-testid="recovery-retry"]').click();
      await page
        .locator('[data-testid="chat-view"]')
        .waitFor({ state: 'visible', timeout: 30_000 });
    } else if (either !== 'chat-view') {
      throw new Error('Neither chat-view nor recovery-error appeared within 30s');
    }

    // Type + send. Playwright's locator.fill is the canonical
    // way to set input value + dispatch input events in one go.
    const inputField = page.locator('[data-testid="input-field"]');
    await inputField.waitFor({ state: 'visible', timeout: 10_000 });
    await inputField.fill('hello-from-e2e');

    const sendButton = page.locator('[data-testid="input-send"]');
    await sendButton.click();

    // User message row appears. The MessageList renders the user's
    // message immediately on `sendPrompt` (optimistic local
    // append via the `WsClient.sendPrompt` path; the row's
    // data-testid is `message-row` regardless of role — the role
    // is distinguished by class `message-role-user`).
    const userRow = page.locator('[data-testid="message-row"]', {
      hasText: 'hello-from-e2e',
    });
    await userRow.waitFor({ state: 'visible', timeout: 15_000 });

    // Assistant terminal message row. The harness's fake server
    // returns a default `textReply('ok')` for every prompt
    // (the queue is empty after the recovery ceremony's
    // preflight, and the default fallback kicks in), so the
    // assistant's message text is the literal string "ok".
    //
    // We poll for it via `expect.poll` (rather than `waitFor`)
    // because the WsClient's `message_end` event fires
    // asynchronously after pi's RPC roundtrip + the worker DO
    // forwarding — the actual `message-row` mount is a few
    // React renders later, and `waitFor` can race that. `expect.poll`
    // auto-retries and surfaces a useful error if it never
    // appears.
    const assistantRow = page.locator('[data-testid="message-row"]', {
      hasText: 'ok',
    });
    await expect
      .poll(async () => await assistantRow.count(), {
        timeout: 30_000,
        message: 'assistant message-row with text "ok" never appeared',
      })
      .toBeGreaterThan(0);

    // After agent_settled, the input field is usable again
    // (input-not-disabled, NOT necessarily sendButton-enabled —
    // the button is correctly disabled when the input value is
    // empty, which is the case here because `submitText` clears
    // the value on send). The bridge emits
    // session_state{phase:'idle'} on agent_settled, which the
    // WsClient turns into `phase='idle'`, which the InputBar
    // uses to flip `inputDisabled` back to false. Allow up to
    // 30s for this transition (cold pi + LLM roundtrip is the
    // worst case on a busy machine).
    //
    // We assert on `input-field` (the textbox), not
    // `input-send` (the button), because the button's disabled
    // state is also gated by `value.trim().length === 0` —
    // an empty input correctly disables the button even when
    // phase is idle. The textbox's disabled flag is gated
    // ONLY by phase, so it's the right signal here.
    await expect(inputField).toBeEnabled({ timeout: 30_000 });
    // Sanity check: typing a single character should enable the
    // send button (value non-empty + phase idle). This catches
    // the inverse regression (phase stuck at running).
    await inputField.fill('ready-again');
    await expect(sendButton).toBeEnabled({ timeout: 5_000 });

    // Draft cleanup — the streaming draft (`message-draft`)
    // must be gone after the terminal message arrives. We
    // tolerate either an instantaneous terminal (no draft ever
    // visible) or a transient draft that was replaced. The
    // check is a `toHaveCount(0)` poll with a generous
    // timeout — the WsClient's message_end handler clears the
    // streaming draft in the same React batch as the message
    // append, so a quick machine may skip the draft phase
    // entirely.
    const draft = page.locator('[data-testid="message-draft"]');
    await expect(draft).toHaveCount(0, { timeout: 30_000 });
  });
});
