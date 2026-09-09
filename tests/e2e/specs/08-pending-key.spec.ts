import { test, expect } from '@playwright/test';
import { readRunState } from '../helpers/global-setup.js';
test('scenario (h): concurrent new-session requests converge on one session', async ({ browser }) => {
 const s=await readRunState(); const a=await browser.newContext(), b=await browser.newContext(); const pa=await a.newPage(), pb=await b.newPage();
 const open=async(p:any)=>{await p.goto(`${s.baseUrl}/#${s.token}`);await p.locator('[data-testid="work-dir-select"][data-path="'+s.workDir+'"]').click();await p.locator('[data-testid="session-new"]').click();await p.locator('[data-testid="chat-view"]').waitFor();};
 await Promise.all([open(pa),open(pb)]); await pa.locator('[data-testid="input-field"]').fill('pending'); await pa.locator('[data-testid="input-send"]').click(); await expect(pa.locator('[data-testid="chat-view"]')).toBeVisible(); await expect(pb.locator('[data-testid="chat-view"]')).toBeVisible(); await a.close(); await b.close();
});
