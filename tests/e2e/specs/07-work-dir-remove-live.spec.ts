// E2E scenario (g): work_dir_remove does not kill live chat — see
// PRD §9.6 场景 (g) + 任务 10 §场景 (g).
//
// Verifies钉子 3: removing a work_dir from the work_dir_list does
// NOT kill any active manager whose cwd is that work_dir. The
// manager runs until natural idle回收 (per裁定 C: ready 5min
// without writes also recycles); the user can keep chatting in
// the open ChatView after the remove.
//
// ## Endpoint (per task file 任务 10 §场景 (g) note)
//
//   The spec asserts "ChatView 不被立即 kill + 可继续对话". Natural
//   idle回收 is covered by unit + integration tests (钉子 3
//   itself is in bridge-session-layer.test.ts; ready 5min is
//   covered by integration; we don't replicate that here). The
//   e2e assertion is the live-chat-still-works-after-remove
//   invariant — bounded to one round of "send → wait for reply"
//   to keep the test deterministic and short.
//
// ## work_dir lifecycle (why we add-then-remove a NEW work_dir)
//
//   We add a brand-new work_dir via DirectoryBrowser (rather than
//   using the bridge.json-configured workDir) so the test doesn't
//   break later specs which all depend on the original workDir
//   still being in state.json. After spec 07 finishes, state.json
//   holds only the bridge-configured workDir, same as before
//   this spec ran.

import { test, expect, type Page } from '@playwright/test';

import { readRunState } from '../helpers/global-setup.js';
import { injectScript } from '../helpers/llm-script.js';
import {
  sseMessageStart,
  sseContentBlockStart,
  sseContentBlockDelta,
  sseContentBlockStop,
  sseMessageDelta,
  sseMessageStop,
} from '../../integration/helpers/fake-llm-server.js';

function buildSingleDeltaScript(text: string): Array<{ event: string; data: unknown }> {
  return [
    sseMessageStart({
      messageId: `msg_g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
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

/** Wait for the URL hash's `session=` to be a real stem (not the
 *  `'new'` placeholder). The App.tsx stem-refilled watcher writes
 *  the real stem into the hash on the first non-'new' session_state
 *  arrival. */
async function waitForStemRefilled(page: Page, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const currentHash = await page.evaluate(() => window.location.hash);
        const match = currentHash.match(/session=([^&]*)/);
        if (match === null) return null;
        const decoded = decodeURIComponent(match[1]!);
        return decoded === 'new' ? null : decoded;
      },
      {
        timeout: timeoutMs,
        message: 'stem-refilled watcher did not update URL hash within timeout',
      },
    )
    .not.toBeNull();
}

test('scenario (g): removing a work directory does not kill its live chat', async ({ browser }) => {
  const s = await readRunState();
  const ctx = await browser.newContext();
  const chatPage = await ctx.newPage();

  // Step 1: add a NEW work_dir via DirectoryBrowser (the test owns
  // this work_dir for its lifetime — we add it, we remove it, we
  // never touch the bridge-configured workDir).
  await chatPage.goto(`${s.baseUrl}/#${s.token}`);
  await chatPage.locator('[data-testid="choice-page"][data-level="1"]').waitFor();
  await chatPage.locator('[data-testid="work-dir-browse"]').click();
  const dirBrowser = chatPage.locator('[data-testid="directory-browser"]');
  await dirBrowser.waitFor({ state: 'visible', timeout: 10_000 });
  const dirEntry = dirBrowser.locator('[data-testid="dir-entry"]').first();
  await expect(dirEntry).toBeVisible({ timeout: 10_000 });
  const newWorkDir = (await dirEntry.locator('code').first().textContent())?.trim() ?? '';
  expect(newWorkDir.length, 'directory entry should expose an absolute path').toBeGreaterThan(0);
  await dirEntry.locator('[data-testid="dir-entry-select"]').click();
  // After add, App dispatches to level=2 for newWorkDir.
  await chatPage.locator('[data-testid="choice-page"][data-level="2"]').waitFor({ timeout: 30_000 });

  // Step 2: open ChatView on a fresh session.
  await chatPage.locator('[data-testid="session-new"]').click();
  await chatPage.locator('[data-testid="chat-view"]').waitFor({ state: 'visible', timeout: 30_000 });
  await chatPage.locator('[data-testid="bridge-status"] [data-state="online"]').waitFor({
    state: 'visible',
    timeout: 30_000,
  });

  // Step 3: send a prompt and wait for response — proves the
  // manager is fully operational (pi spawned, stem derived, first
  // turn settled). The stem-refilled wait below confirms the
  // bridge-side migration completed.
  await injectScript(s.fakeLlmUrl, [
    { kind: 'reply', reply: buildSingleDeltaScript('alive after remove') },
  ]);
  await chatPage.locator('[data-testid="input-field"]').fill('live');
  await chatPage.locator('[data-testid="input-send"]').click();
  await expect(
    chatPage.locator('[data-testid="message-row"].message-role-assistant', {
      hasText: 'alive after remove',
    }),
  ).toHaveCount(1, { timeout: 30_000 });
  // Belt-and-braces: stem-refilled watcher fired.
  await waitForStemRefilled(chatPage);

  // Step 4: remove the work_dir via a SEPARATE page in the same
  // context. The chatPage's ChatView must remain alive (钉子 3).
  // Using a separate page (rather than navigating chatPage away to
  // level=1) keeps chatPage's ChatView mounted, so we can observe
  // the "still interactive" invariant without unmount/remount
  // noise.
  const removePage = await ctx.newPage();
  await removePage.goto(`${s.baseUrl}/#${s.token}`);
  await removePage.locator('[data-testid="choice-page"][data-level="1"]').waitFor();
  await removePage
    .locator('[data-testid="work-dir-remove"][data-path="' + newWorkDir + '"]')
    .click();
  await expect(
    removePage.locator('[data-testid="work-dir-row"][data-path="' + newWorkDir + '"]'),
  ).toHaveCount(0, { timeout: 10_000 });

  // Step 5: chatPage's ChatView is still alive and interactive.
  // 钉子 3 invariant: work_dir_remove does NOT kill the manager;
  // the session continues until natural idle回收.
  await expect(chatPage.locator('[data-testid="chat-view"]')).toBeVisible();
  await expect(chatPage.locator('[data-testid="input-field"]')).toBeEnabled({ timeout: 30_000 });

  // Step 6: conversation can CONTINUE — send another prompt and
  // verify a fresh response. This is the "可继续对话" half of the
  // task file's endpoint ("ChatView 不被立即 kill 且可继续对话").
  await injectScript(s.fakeLlmUrl, [
    { kind: 'reply', reply: buildSingleDeltaScript('still alive') },
  ]);
  await chatPage.locator('[data-testid="input-field"]').fill('after-remove');
  await chatPage.locator('[data-testid="input-send"]').click();
  await expect(
    chatPage.locator('[data-testid="message-row"].message-role-assistant', {
      hasText: 'still alive',
    }),
  ).toHaveCount(1, { timeout: 30_000 });

  await ctx.close();
});
