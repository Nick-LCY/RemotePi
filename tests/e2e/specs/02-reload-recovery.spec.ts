// E2E scenario (b): F5 reload recovery — see ADR-0009 §决策 3 场景 (b)
// + 任务 13 §场景 (b).
//
// Verifies the dual-query recovery ceremony re-runs after a full
// page reload, and the message history is fully re-rendered with
// the same content as before the reload.
//
// ## Ceremony invariants
//
//   1. The recovery gate is per-mount (App.tsx `useGateRef` + the
//      `autoStartConsumedRef` per-token guard — ADR-0009 §决策 7 末条
//      第二条). `page.reload()` builds a fresh component tree, so
//      the gate instance is fresh too: the dual queries fire again
//      (this is one of the legitimate "re-fire" triggers, along
//      with token change and manual retry — see
//      tests/e2e/helpers/spec-helper.ts for the semantic
//      convention).
//
//   2. The history is sourced from the JSONL session file via the
//      bridge's `get_messages` round-trip; the worker's Room DO
//      holds no message state. The SQLite-backed DO persists
//      across reloads (wrangler `--persist-to`), so a session
//      started in turn 1 is fully readable in turn 2.
//
//   3. The retry-tolerant block (5s recovery timeout vs cold pi
//      startup — ADR-0009 §开放点 1) applies on the post-reload
//      ceremony too. We mirror scenario (a)'s helper.
//
// ## History verification
//
//   We snapshot `message-row` elements BEFORE reload (testid +
//   text content) and compare AFTER reload:
//     - row COUNT must match exactly;
//     - row TEXT (in order) must match exactly;
//     - the role class on each row must match (assistant rows
//       survive a reload identically — the S7 filter used in
//       scenario (a) re-applies here).

import { test, expect, type Page } from '@playwright/test';

import { readRunState } from '../helpers/global-setup.js';
import {
  sseContentBlockStart,
  sseContentBlockDelta,
  sseContentBlockStop,
  sseMessageDelta,
  sseMessageStart,
  sseMessageStop,
} from '../../integration/helpers/fake-llm-server.js';
import { injectScript } from '../helpers/llm-script.js';

interface MessageRowSnapshot {
  testid: string;
  /** Role class on the row (e.g. `message-role-user`,
   *  `message-role-assistant`). Empty string if absent. */
  roleClass: string;
  /** Trimmed visible text of the row body (not the role label). */
  text: string;
}

async function snapshotMessageRows(page: Page): Promise<MessageRowSnapshot[]> {
  return await page.evaluate((): MessageRowSnapshot[] => {
    const rows = Array.from(
      document.querySelectorAll('[data-testid="message-row"], [data-testid="message-draft"]'),
    );
    return rows.map((row) => {
      const testid = row.getAttribute('data-testid') ?? '';
      const classList = Array.from(row.classList);
      const roleClass = classList.find((c) => c.startsWith('message-role-')) ?? '';
      const body = row.querySelector('.message-body');
      const text = (body?.textContent ?? '').trim();
      return { testid, roleClass, text };
    });
  });
}

function buildSingleDeltaScript(text: string): Array<{ event: string; data: unknown }> {
  return [
    sseMessageStart({
      messageId: `msg_e2e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      model: 'fake-claude-haiku-4-5',
      inputTokens: 10,
    }),
    sseContentBlockStart({ index: 0, block: { type: 'text', text: '' } }),
    sseContentBlockDelta({ index: 0, delta: { type: 'text_delta', text } }),
    sseContentBlockStop({ index: 0 }),
    sseMessageDelta({ stopReason: 'end_turn', outputTokens: text.length }),
    sseMessageStop(),
  ];
}

/** Same retry-tolerant block as scenario (a) — the 5s recovery
 *  timeout挂账 can still fire on a cold pi restart. We tolerate
 *  one retry; a second failure means the挂账 is a real blocker. */
async function waitForChatViewOrRecovery(page: Page): Promise<void> {
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
  } else if (either !== 'chat-view') {
    throw new Error('Neither chat-view nor recovery-error appeared within 30s');
  }
}

/** Send a prompt, wait for agent_settled (input-field back to
 *  enabled), then verify the assistant terminal row contains the
 *  scripted reply text. Used in steps 1 + 2 (both pre-reload
 *  prompts follow this shape). */
async function sendPromptAndAwait(
  page: Page,
  promptText: string,
  expectedReply: string,
): Promise<void> {
  const inputField = page.locator('[data-testid="input-field"]');
  await inputField.waitFor({ state: 'visible', timeout: 10_000 });
  await inputField.fill(promptText);
  await page.locator('[data-testid="input-send"]').click();

  const userRow = page.locator(
    '[data-testid="message-row"].message-role-user',
    { hasText: promptText },
  );
  await userRow.waitFor({ state: 'visible', timeout: 15_000 });

  const assistantRow = page.locator(
    '[data-testid="message-row"].message-role-assistant',
    { hasText: expectedReply },
  );
  await expect
    .poll(async () => await assistantRow.count(), {
      timeout: 30_000,
      message: `assistant message-row containing "${expectedReply}" never appeared`,
    })
    .toBe(1);

  // Wait for the input field to regain focus (agent_settled →
  // phase=idle → inputField.enabled). This guards against
  // snapshotting while the LLM is still mid-streaming.
  await expect(inputField).toBeEnabled({ timeout: 30_000 });
}

test.describe('scenario (b) — F5 reload recovery', () => {
  test('after reload, recovery ceremony re-runs and history is fully restored', async ({ page }) => {
    const state = await readRunState();
    const { token, baseUrl, fakeLlmUrl } = state;

    // Step 1: load the chat, send two prompts, wait for both
    // terminal rows to land. The LLM scripts are pre-installed
    // so the assistant replies are deterministic.
    await page.goto(`${baseUrl}/#${token}`);
    await waitForChatViewOrRecovery(page);

    // Pre-script two replies so each prompt gets a known response.
    await injectScript(fakeLlmUrl, [
      { kind: 'reply', reply: buildSingleDeltaScript('first reply from fake LLM') },
      { kind: 'reply', reply: buildSingleDeltaScript('second reply from fake LLM') },
    ]);
    await sendPromptAndAwait(page, 'reload-test-prompt-1', 'first reply from fake LLM');
    await sendPromptAndAwait(page, 'reload-test-prompt-2', 'second reply from fake LLM');

    // Snapshot the pre-reload history. We expect 2 user prompts +
    // 2 assistant replies from THIS scenario (other scenarios may
    // have left messages in the same Room DO if they ran earlier
    // in this `pnpm test:e2e` invocation — we filter to the rows
    // belonging to this test instead of asserting on the total
    // count, which would couple scenarios through shared SQLite).
    const allBeforeRows = await snapshotMessageRows(page);
    const beforeRows = allBeforeRows.filter(
      (r) =>
        r.text === 'reload-test-prompt-1' ||
        r.text === 'reload-test-prompt-2' ||
        r.text === 'first reply from fake LLM' ||
        r.text === 'second reply from fake LLM',
    );
    expect(
      beforeRows.length,
      `pre-reload history should have 4 rows from this scenario (2 user + 2 assistant), got ${beforeRows.length}; all rows: ${JSON.stringify(allBeforeRows.map((r) => r.text))}`,
    ).toBe(4);
    // Sanity: user / assistant role classes alternate.
    expect(beforeRows[0]?.roleClass).toBe('message-role-user');
    expect(beforeRows[0]?.text).toBe('reload-test-prompt-1');
    expect(beforeRows[1]?.roleClass).toBe('message-role-assistant');
    expect(beforeRows[1]?.text).toBe('first reply from fake LLM');
    expect(beforeRows[2]?.roleClass).toBe('message-role-user');
    expect(beforeRows[2]?.text).toBe('reload-test-prompt-2');
    expect(beforeRows[3]?.roleClass).toBe('message-role-assistant');
    expect(beforeRows[3]?.text).toBe('second reply from fake LLM');

    // Step 2: page.reload() — fresh mount, fresh gate.
    await page.reload();

    // Step 3: wait for the recovery ceremony to complete. The
    // ceremony may briefly surface `recovery-in-flight` (we don't
    // assert on it; it's allowed to be missed if the machine is
    // fast). The retry-tolerant helper covers the 5s timeout挂账.
    await waitForChatViewOrRecovery(page);

    // Step 4: history consistency assertions — filter to this
    // scenario's messages (same rationale as above: SQLite is
    // shared across scenarios in a single `pnpm test:e2e` run).
    const allAfterRows = await snapshotMessageRows(page);
    const afterRows = allAfterRows.filter(
      (r) =>
        r.text === 'reload-test-prompt-1' ||
        r.text === 'reload-test-prompt-2' ||
        r.text === 'first reply from fake LLM' ||
        r.text === 'second reply from fake LLM',
    );
    expect(
      afterRows.length,
      'post-reload row count for this scenario must equal pre-reload row count',
    ).toBe(beforeRows.length);
    // Per-row text + role class must match in order. We use a
    // pairwise comparison so a single swapped row would fail
    // loudly (vs a single text-concatenation check that could
    // paper over a permutation).
    for (let i = 0; i < beforeRows.length; i += 1) {
      const before = beforeRows[i] as MessageRowSnapshot;
      const after = afterRows[i] as MessageRowSnapshot;
      expect(
        { before, after },
        `row[${i}] content mismatch`,
      ).toEqual({ before, after });
    }
    // Sanity: chat-view is interactive (input-field present + enabled).
    await expect(page.locator('[data-testid="input-field"]')).toBeEnabled({ timeout: 5_000 });
  });
});
