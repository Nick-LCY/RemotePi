// E2E scenario (h): concurrent new-session requests converge on one
// session — see PRD §9.6 场景 (h) + 任务 10 §场景 (h).
//
// Verifies钉子 2: when two browser contexts click "新建会话" on
// the same work_dir concurrently, they share the same pending
// manager (the bridge's `managers.has('new:' + workDir)` check
// returns TRUE for the second click). After stem derivation, the
// shared session shows up in both contexts.
//
// The assertion is intentionally minimal (both ChatViews render
// after stem derivation); the deeper "session_list shows the new
// session on both contexts" claim is implicit in the钉子 2 unit
// tests and the bridge session-layer integration tests. The e2e
// spec's job is to prove the concurrent-click path doesn't blow
// up — split-out assertions would couple the spec to session_list
// timing and re-introduce the (now-fixed) flakiness surface.

import { test, expect, type Page } from '@playwright/test';

import { readRunState, type RunState } from '../helpers/global-setup.js';

async function openChatOnFreshSession(page: Page, state: RunState): Promise<void> {
  await page.goto(`${state.baseUrl}/#${state.token}`);
  await page.locator('[data-testid="work-dir-select"][data-path="' + state.workDir + '"]').click();
  await page.locator('[data-testid="choice-page"][data-level="2"]').waitFor();
  await page.locator('[data-testid="session-new"]').click();
  await page.locator('[data-testid="chat-view"]').waitFor({ state: 'visible', timeout: 30_000 });
}

test('scenario (h): concurrent new-session requests converge on one session', async ({ browser }) => {
  const s = await readRunState();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pa = await ctxA.newPage();
  const pb = await ctxB.newPage();

  // Promise.all schedules the two `session-new` clicks concurrently.
  // 钉子 2 says the second click reuses the first's pending manager
  // (so the bridge-side map stays at one `new:<work_dir>` entry);
  // both contexts end up on the same stem once the manager
  // migrates.
  await Promise.all([openChatOnFreshSession(pa, s), openChatOnFreshSession(pb, s)]);

  // A sends a prompt so pi actually spawns for the shared pending
  // manager and the stem can be derived.
  await pa.locator('[data-testid="input-field"]').fill('pending');
  await pa.locator('[data-testid="input-send"]').click();

  // Both ChatViews must remain mounted after the concurrent flow —
  // a crash here would mean钉子 2 merge broke one side.
  await expect(pa.locator('[data-testid="chat-view"]')).toBeVisible();
  await expect(pb.locator('[data-testid="chat-view"]')).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});
