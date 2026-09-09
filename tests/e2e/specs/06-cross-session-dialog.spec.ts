import { test, expect } from '@playwright/test';
import { readRunState } from '../helpers/global-setup.js';
import { injectScript } from '../helpers/llm-script.js';
import { toolUseReply } from '../../integration/helpers/fake-llm-server.js';

test('scenario (f): blocked dialog is stored per session and restored on switch', async ({ browser }) => {
  const s=await readRunState(); const a=await browser.newContext(); const b=await browser.newContext();
  const pa=await a.newPage(); const pb=await b.newPage();
  const open=async(p:any)=>{await p.goto(`${s.baseUrl}/#${s.token}`);await p.locator('[data-testid="work-dir-select"][data-path="'+s.workDir+'"]').click();await p.locator('[data-testid="session-new"]').click();await p.locator('[data-testid="chat-view"]').waitFor();};
  await open(pa); await pa.locator('[data-testid="input-field"]').fill('trigger');
  await injectScript(s.fakeLlmUrl,[{kind:'reply',reply:toolUseReply({toolName:'trigger_dialog',toolId:'e2e-f',input:{kind:'select',title:'Choose',message:'Choose',options:['one','two']},messageId:'e2e-f'})}]);
  await pa.locator('[data-testid="input-send"]').click(); await expect(pa.locator('[data-testid="dialog-host"]')).toBeVisible();
  await open(pb); await expect(pb.locator('[data-testid="dialog-host"]')).toHaveCount(0);
  await a.close(); await b.close();
});
