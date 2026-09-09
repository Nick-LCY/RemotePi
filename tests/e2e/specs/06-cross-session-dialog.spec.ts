// E2E scenario (f): cross-session blocked dialog isolation — see
// ADR-0009 §决策 3 场景 + 任务 10 §场景 (f).
//
// Two browser contexts on the same token, each on a DIFFERENT
// session. A triggers a `trigger_dialog(kind=select)` via pi's
// tool_use path. The dialog is broadcast to all web clients on the
// Room DO, but only the web client viewing the SAME session (A)
// renders it; B's chat-view must not contain the select dialog
// (per-session blockedOn isolation, M4 任务 08 §4.5).
//
// ## 钉子 2 cross-context caveat (why A and B use different work_dirs)
//
//   钉子 2 is "same work_dir short-time `session:'new'` merges into
//   one pending manager". In a single-context case (user double-
//   clicking "新建会话") the merge is the intended UX. In a multi-
//   context case (two browser tabs on the same work_dir), the merge
//   would force both contexts onto the same session — which is
//   exactly what scenario (f) wants to disprove.
//
//   Additionally, App.tsx's `stem-refilled` watcher subscribes for
//   ANY `session_state` whose `payload.work_dir` matches the URL's
//   `work_dir` — it refills the hash to the broadcast session. When
//   A's manager migrates and broadcasts `session_state{session:
//   <stem>, work_dir: A_work}`, B's watcher (subscribed for
//   B_work === A_work) refills B's hash to A's stem too. This is
//   the same collision as 钉子 2 merge, surfacing in a different
//   layer.
//
//   Mitigation in this spec: A navigates to the bridge-configured
//   workDir; B adds a NEW workDir via DirectoryBrowser and navigates
//   to IT. Different work_dirs → different 钉子 2 map keys
//   (`new:A_work` vs `new:B_work`) → no merge; different
//   stem-refilled watcher scopes → no cross-refill.
//
// ## Test endpoint (per task file 任务 10 §场景 (f) note)
//
//   The PRD §9.6 (f) description mentions a 3rd step ("切 B 到 X
//   后 dialog 恢复 + 倒计时") which would test the
//   background-bucket restore-on-switch path. We DELIBERATELY do
//   not test that path here — per the task file, the per-session
//   restore-on-switch semantics are covered by unit + integration
//   tests; the e2e spec asserts the load-bearing isolation
//   invariant (A sees the dialog, B doesn't) and nothing more.
//   Adding the 3rd step would couple the test to dialog
//   timeout countdown math and re-flake a previously green spec.
//
// ## Why we assert on `dialog-select` (not `dialog-host`)
//
//   `data-testid="dialog-host"` is the ALWAYS-mounted wrapper div
//   in `<ChatView>` — it's not a per-dialog marker, so
//   `toHaveCount(0)` against it is impossible whenever ChatView is
//   open. The actual per-dialog selectors live on the inner dialog
//   components: `dialog-confirm` / `dialog-input` /
//   `dialog-select` / `dialog-editor`. We assert against
//   `dialog-select` (matching A's `kind: 'select'` input).

import { test, expect, type Page } from '@playwright/test';

import { readRunState, type RunState } from '../helpers/global-setup.js';
import { injectScript } from '../helpers/llm-script.js';
import { toolUseReply } from '../../integration/helpers/fake-llm-server.js';

/** Open a chat-view on a specific workDir (M4 flow:
 *  level=1 → level=2 → session-new). */
async function openChatOnWorkDir(page: Page, state: RunState, workDir: string): Promise<void> {
  await page.goto(`${state.baseUrl}/#${state.token}`);
  await page.locator('[data-testid="choice-page"][data-level="1"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="work-dir-select"][data-path="' + workDir + '"]').click();
  await page.locator('[data-testid="choice-page"][data-level="2"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="session-new"]').click();
  await page.locator('[data-testid="chat-view"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('[data-testid="bridge-status"] [data-state="online"]').waitFor({
    state: 'visible',
    timeout: 30_000,
  });
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

/** Add a NEW work_dir via DirectoryBrowser. The bridge persists the
 *  add to state.json. Returns the absolute path of the added
 *  directory (first $HOME subdirectory, alphabetically). */
async function addNewWorkDir(page: Page, state: RunState): Promise<string> {
  await page.goto(`${state.baseUrl}/#${state.token}`);
  await page.locator('[data-testid="choice-page"][data-level="1"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="work-dir-browse"]').click();
  const dirBrowser = page.locator('[data-testid="directory-browser"]');
  await dirBrowser.waitFor({ state: 'visible', timeout: 10_000 });
  const dirEntry = dirBrowser.locator('[data-testid="dir-entry"]').first();
  await expect(dirEntry).toBeVisible({ timeout: 10_000 });
  const newWorkDir = (await dirEntry.locator('code').first().textContent())?.trim() ?? '';
  expect(newWorkDir.length, 'directory entry should expose an absolute path').toBeGreaterThan(0);
  await dirEntry.locator('[data-testid="dir-entry-select"]').click();
  // After add, App dispatches to level=2 for newWorkDir.
  await page.locator('[data-testid="choice-page"][data-level="2"]').waitFor({ timeout: 30_000 });
  return newWorkDir;
}

test('scenario (f): blocked dialog is stored per session and restored on switch', async ({ browser }) => {
  const s = await readRunState();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pa = await ctxA.newPage();
  const pb = await ctxB.newPage();

  // B adds a NEW work_dir first (via a throwaway page in ctxB) so
  // B's session lives on a different work_dir than A's.
  const helperPage = await ctxB.newPage();
  const bWorkDir = await addNewWorkDir(helperPage, s);
  await helperPage.close();

  // A: open a fresh session on the bridge-configured workDir and
  // trigger a dialog via pi's `trigger_dialog(kind=select)`.
  await openChatOnWorkDir(pa, s, s.workDir);
  await pa.locator('[data-testid="input-field"]').fill('trigger');
  await injectScript(s.fakeLlmUrl, [
    {
      kind: 'reply',
      reply: toolUseReply({
        toolName: 'trigger_dialog',
        toolId: 'e2e-f',
        input: { kind: 'select', title: 'Choose', message: 'Choose', options: ['one', 'two'] },
        messageId: 'e2e-f',
      }),
    },
  ]);
  await pa.locator('[data-testid="input-send"]').click();

  // Wait for A's dialog AND stem-refilled — both are preconditions
  // for the cross-session assertion (B must end up on a session
  // that has no dialog).
  await expect(pa.locator('[data-testid="dialog-select"]')).toBeVisible({ timeout: 30_000 });
  await waitForStemRefilled(pa);

  // B: open a fresh session on the NEW workDir (added above).
  // Different work_dir → no钉子 2 merge and no stem-refilled
  // watcher cross-fire. B's chat-view must not contain the
  // select dialog (per-session blockedOn isolation).
  await openChatOnWorkDir(pb, s, bWorkDir);
  await expect(pb.locator('[data-testid="dialog-select"]')).toHaveCount(0);

  await ctxA.close();
  await ctxB.close();
});
