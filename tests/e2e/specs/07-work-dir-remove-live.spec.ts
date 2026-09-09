import { test, expect } from '@playwright/test';
import { readRunState } from '../helpers/global-setup.js';
test('scenario (g): removing a work directory does not kill its live chat', async ({ page }) => {
 const s=await readRunState(); await page.goto(`${s.baseUrl}/#${s.token}`); await page.locator('[data-testid="work-dir-select"][data-path="'+s.workDir+'"]').click(); await page.locator('[data-testid="session-new"]').click(); await page.locator('[data-testid="chat-view"]').waitFor();
 await page.locator('[data-testid="input-field"]').fill('live'); await page.locator('[data-testid="input-send"]').click(); await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();
});
