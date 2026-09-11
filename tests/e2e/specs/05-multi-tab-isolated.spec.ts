// E2E scenario (e): multi-tab isolated sessions — see ADR-0009 §决策 3
// 场景 + 任务 10 §场景 (e).
//
// Two browser contexts on the same token = two web clients of the
// same Room DO. When each picks (or creates) a DIFFERENT session,
// A's prompt must NOT appear in B's ChatView (per-session
// isolation; M4 任务 08 store-per-bucket + per-session ChatView).
//
// ## 钉子 2 race window (deterministic ordering)
//
//   Both contexts call `session-new` shortly after one another.
//   Bridge's `BridgeSessionLayer.handleEnvelope` for session='new'
//   checks `managers.has('new:' + workDir)` — TRUE reuses the
//   in-flight pending manager (钉子 2 pending-key merge); FALSE
//   spawns a fresh pending. If A's pending has not yet been
//   migrated to a real stem by the time B's session-new arrives
//   at the bridge, B reuses A's pending → both contexts end up
//   on the same session → A's broadcast events land in B's
//   bucket.
//
//   Mitigation: wait for A's stem-refilled watcher to fire (the
//   URL hash transitions `session=new` → `session=<stem>`) BEFORE
//   B clicks session-new. Once A's key is the real stem, the
//   pending-key check `managers.has('new:' + workDir)` is FALSE
//   and B gets a fresh pending.
//
// ## Assertion shape
//
//   We assert `toHaveCount(0)` on B's `[data-testid="message-row"]`
//   (rather than `not.toContainText` over an unfiltered list) to
//   avoid strict-mode violations and to express the real
//   invariant: B is on a fresh session with no history.

import { test, expect, type Page } from '@playwright/test';

import { readRunState, type RunState } from '../helpers/global-setup.js';
import { seedToken } from '../helpers/seed-token.js';

async function openChatOnFreshSession(page: Page, state: RunState): Promise<void> {
  await seedToken(page, state.baseUrl, state.token);
  await page.locator('[data-testid="work-dir-select"][data-path="' + state.workDir + '"]').click();
  await page.locator('[data-testid="choice-page"][data-level="2"]').waitFor();
  await page.locator('[data-testid="session-new"]').click();
  await page.locator('[data-testid="chat-view"]').waitFor({ state: 'visible', timeout: 30_000 });
  // R6 — wait for WS online before sending prompts (ChatView for
  // session='new' mounts immediately via createReadyGate, but WS
  // may still be handshaking; sendRaw silently drops on
  // readyState !== OPEN).
  await page.locator('[data-testid="bridge-status"] [data-state="online"]').waitFor({
    state: 'visible',
    timeout: 30_000,
  });
}

test('scenario (e): two contexts viewing different sessions stay isolated', async ({ browser }) => {
  const state = await readRunState();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pa = await ctxA.newPage();
  const pb = await ctxB.newPage();

  // A: open a fresh session, send a prompt.
  await openChatOnFreshSession(pa, state);
  await pa.locator('[data-testid="input-field"]').fill('isolated-a');
  await pa.locator('[data-testid="input-send"]').click();

  // Wait for A's stem-refilled watcher (App.tsx) to fire — proves
  // A's pending manager has been migrated to a real stem on the
  // bridge side. Only AFTER this is B's session-new safe to fire
  // (otherwise 钉子 2's pending-key merge would route B to A's
  // still-pending manager — see module JSDoc).
  await expect
    .poll(
      async () => {
        const currentHash = await pa.evaluate(() => window.location.hash);
        const match = currentHash.match(/session=([^&]*)/);
        if (match === null) return null;
        const decoded = decodeURIComponent(match[1]!);
        return decoded === 'new' ? null : decoded;
      },
      {
        timeout: 30_000,
        message: 'Context A: stem-refilled watcher did not update URL hash within 30s',
      },
    )
    .not.toBeNull();

  // B: open a fresh session. With A's stem migration complete,
  // bridge's pending-key check is FALSE → B gets a fresh pending.
  await openChatOnFreshSession(pb, state);

  // B's chat-view must be empty (no messages from A). The
  // assertion uses `toHaveCount(0)` to express "fresh session
  // with no history" rather than a substring absence on a
  // multi-match locator (strict-mode safe).
  await expect(pb.locator('[data-testid="message-row"]')).toHaveCount(0);

  await ctxA.close();
  await ctxB.close();
});
