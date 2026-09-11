// E2E scenario (d): directory browse + add — see ADR-0009 §决策 3
// 场景 + 任务 10 §场景 (d).
//
// Verifies the M4 directory-browser flow end-to-end:
//   1. Land on ChoicePage level=1 (the M3老链接兼容 path also
//      lands here per钉子 6).
//   2. Click "浏览添加" → DirectoryBrowser opens, enumerates
//      $HOME subdirectories via `control/list_directories`.
//   3. Pick the first entry → click "选择" → `control/work_dir_add`
//      fires → bridge persists to state.json → onAdded callback
//      fires → ChoicePage dispatches to level=2 via hash update.
//   4. Go back to level=1 via "更换目录" → verify the new entry
//      is in `work-dir-list`.
//   5. Click the new `work-dir-select` → land on level=2.

import { test, expect } from '@playwright/test';

import { readRunState } from '../helpers/global-setup.js';
import { seedToken } from '../helpers/seed-token.js';

test('scenario (d): browse a home subdirectory, add it, then enter its session list', async ({ page }) => {
  const state = await readRunState();
  await seedToken(page, state.baseUrl, state.token);

  // Step 1: land on ChoicePage level=1.
  const level1 = page.locator('[data-testid="choice-page"][data-level="1"]');
  await level1.waitFor({ state: 'visible', timeout: 30_000 });

  // Step 2: open DirectoryBrowser.
  await page.locator('[data-testid="work-dir-browse"]').click();
  const browser = page.locator('[data-testid="directory-browser"]');
  await browser.waitFor({ state: 'visible', timeout: 10_000 });

  // Step 3: wait for the first entry (list_directories round-trip
  // takes a moment on a cold bridge).
  const entry = browser.locator('[data-testid="dir-entry"]').first();
  await expect(entry).toBeVisible({ timeout: 10_000 });

  // The DirectoryBrowser renders each entry as
  //   <li data-testid="dir-entry">
  //     <span data-testid="dir-entry-name">{name}</span>
  //     <span><code>{path}</code></span>
  //     <button data-testid="dir-entry-open">打开</button>
  //     <button data-testid="dir-entry-select">选择</button>
  //   </li>
  // The path is the only field the test cares about — we extract
  // it from the <code> child so we can assert the new entry
  // appears in the work_dir_list after `work_dir_add`.
  const entryPath = (await entry.locator('code').first().textContent())?.trim() ?? '';
  expect(entryPath.length, 'directory entry should expose an absolute path').toBeGreaterThan(0);

  // Click "选择" → work_dir_add → onAdded → handleBrowseAdded →
  // setBrowsing(false) + hash = selectWorkDirHash → App dispatches
  // to level=2.
  await entry.locator('[data-testid="dir-entry-select"]').click();
  const level2 = page.locator('[data-testid="choice-page"][data-level="2"]');
  await level2.waitFor({ state: 'visible', timeout: 30_000 });

  // Step 4: go back to level=1 to verify the new entry is in the
  // list (and then click it to re-enter level=2 — that's the spec
  // assertion shape). We use the "更换目录" button on level=2 which
  // calls `changeWorkDirHash(token)` (hash becomes `#<token>`).
  await page.locator('[data-testid="work-dir-change"]').click();
  await level1.waitFor({ state: 'visible', timeout: 30_000 });
  await expect(page.locator('[data-testid="work-dir-list"]')).toContainText(entryPath);

  // Step 5: click the LAST work-dir-select (the newly added one
  // is appended to work_dirs on add per state.json's array push).
  await page.locator('[data-testid="work-dir-select"]').last().click();
  await level2.waitFor({ state: 'visible', timeout: 30_000 });
});
