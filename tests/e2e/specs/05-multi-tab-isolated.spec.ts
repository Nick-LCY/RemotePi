import { test, expect } from '@playwright/test';
import { readRunState } from '../helpers/global-setup.js';

async function level2(page:any, state:any) {
  await page.goto(`${state.baseUrl}/#${state.token}`);
  await page.locator('[data-testid="work-dir-select"][data-path="'+state.workDir+'"]').click();
  await page.locator('[data-testid="choice-page"][data-level="2"]').waitFor();
}
test('scenario (e): two contexts viewing different sessions stay isolated', async ({ browser }) => {
  const state=await readRunState(); const a=await browser.newContext(); const b=await browser.newContext();
  const pa=await a.newPage(), pb=await b.newPage();
  await level2(pa,state); await pa.locator('[data-testid="session-new"]').click(); await pa.locator('[data-testid="chat-view"]').waitFor();
  await pa.locator('[data-testid="input-field"]').fill('isolated-a'); await pa.locator('[data-testid="input-send"]').click();
  await level2(pb,state); await pb.locator('[data-testid="session-new"]').click(); await pb.locator('[data-testid="chat-view"]').waitFor();
  await expect(pb.locator('[data-testid="message-row"]')).not.toContainText('isolated-a');
  await a.close(); await b.close();
});
