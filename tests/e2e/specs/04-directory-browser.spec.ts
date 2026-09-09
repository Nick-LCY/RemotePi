import { test, expect } from '@playwright/test';
import { readRunState } from '../helpers/global-setup.js';

test('scenario (d): browse a home subdirectory, add it, then enter its session list', async ({ page }) => {
  const state = await readRunState();
  await page.goto(`${state.baseUrl}/#${state.token}`);
  await page.locator('[data-testid="choice-page"][data-level="1"]').waitFor();
  await page.locator('[data-testid="work-dir-browse"]').click();
  const browser = page.locator('[data-testid="directory-browser"]');
  await browser.waitFor();
  const entry = browser.locator('[data-testid="directory-entry"]').first();
  await expect(entry).toBeVisible();
  await entry.click();
  const add = browser.locator('[data-testid="directory-add"]');
  await add.click();
  await page.locator('[data-testid="choice-page"][data-level="1"]').waitFor();
  await expect(page.locator('[data-testid="work-dir-list"]')).toContainText(await entry.getAttribute('data-path') ?? '');
  await page.locator('[data-testid="work-dir-select"]').last().click();
  await expect(page.locator('[data-testid="choice-page"][data-level="2"]')).toBeVisible();
});
