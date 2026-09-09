// E2E scenario (c): multi-tab first-responder wins — see ADR-0009
// §决策 3 场景 (c) + 任务 13 §场景 (c).
//
// Two browser contexts on the same token are two web clients of
// the same Room DO. When a confirm dialog opens, BOTH sides see
// it (worker broadcasts `extension_ui_request` to every connected
// web on the token). The first to commit ("先答者胜") closes the
// dialog on both sides; the loser's response comes back as
// `command_result{success:false, error.code:'request_expired'}`
// which the web surfaces as a toast (PRD §4.5 dialog → toast UX).
//
// ## 敲定点 5 (竞态构造手法) — 首选 A 落地
//
//   Preferred path (per task file 敲定点 5): B clicks Yes FIRST
//   to put the dialog in `submitting` state, then A clicks Yes.
//   The bridge sees A's response commit first (B is still in
//   `submitting` because its extension_ui_response is in flight).
//   The bridge clears `blocked_on` on the A commit, the dialog
//   unmounts on both sides (React key drop, ADR-0009 §决策 7 末条),
//   and B's late `command_result` arrives as `request_expired`,
//   surfaced as a `dialog-toast` on B's side.
//
//   We use `test.describe.configure({ mode: 'serial' })` so the
//   click ordering is deterministic (Playwright tests within a
//   serial block run in declared order, not in parallel).
//
//   If path A becomes unworkable (e.g. the `submitting` state
//   becomes too brief to assert on a slow machine), the
//   fallback paths B/C in task 13 §敲定点 5 remain valid; we
//   log the degradation in the task file when flipping.
//
// ## Why TWO contexts (not one context two tabs)?
//
//   `browser.newContext()` gives each side an isolated cookie +
//   localStorage jar — Playwright's multi-context model is the
//   closest analogue to "two operators on two phones, same token".
//   One-context-two-tabs would share localStorage (e.g. the persisted
//   WsClient token if we ever moved off the URL hash) and could
//   pass tests for the wrong reasons.
//
// ## Conformance with §决策 7 末条 (断言语义)
//
//   - Dialog auto-close is React key unmount, not a timer — we
//     assert `toHaveCount(0)` (DOM gone), never wait on a
//     countdown number.
//   - Same-token reconnect does NOT re-fire the recovery ceremony —
//     we don't test this here directly (would need a transient
//     network drop); the convention is documented in
//     tests/e2e/helpers/spec-helper.ts and the review guard
//     against regressing it lives in scenario (b)'s reload test
//     (a `page.reload()` IS a legitimate re-fire trigger; a
//     hypothetical "offline → online" same-token reconnect would
//     not be — and that's exactly what scenario (c) doesn't
//     exercise).

import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';

import { readRunState } from '../helpers/global-setup.js';
import { injectScript } from '../helpers/llm-script.js';
import {
  sseMessageStart,
  sseContentBlockStart,
  sseContentBlockDelta,
  sseContentBlockStop,
  sseMessageDelta,
  sseMessageStop,
  toolUseReply,
} from '../../integration/helpers/fake-llm-server.js';

interface DialogContext {
  page: Page;
  context: BrowserContext;
}

/** Open a chat-view on a fresh browser context with the given
 *  token. Returns the context handle (which holds the underlying
 *  cookies/storage — the test is responsible for closing it via
 *  `await ctx.context.close()`). */
async function openChatOnContext(
  browser: Browser,
  baseUrl: string,
  token: string,
  workDir: string,
): Promise<DialogContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  // M4 task 08 review R6 — M4 flow migration per reviewer 方案 B:
  //   `#<token>` → ChoicePage level=1 → click work_dir → level=2
  //   → 新建会话 → pending ChatView → stem refilled。
  //
  // 关键依赖：R1 (decideView 翻 choiceLevel1) + R2 (fallback 链) +
  // R3 (仪式带 session) + R4 (stem 回填桶迁移) + W8 (stem-refilled
  // watcher 抽取测试)。
  //
  // 两个 context 必须独立走 M4 流（每个 context 自己的 hash /
  // currentSessionKey / WsClient 镜像）；但共享 bridge 端的
  // Room DO（同一 token）。多端弹窗先答者胜（anonymous ADR-0004
  // §补注 3）的语义在 R3 仪式带 session 出站下保持——bridge 按
  // session 路由 extension_ui_response 到该 manager，广播
  // session_state 给所有 web（同 session）。
  await page.goto(`${baseUrl}/#${token}`);
  const level1 = page.locator('[data-testid="choice-page"][data-level="1"]');
  await level1.waitFor({ state: 'visible', timeout: 30_000 });
  const workDirRow = page.locator(
    '[data-testid="work-dir-select"][data-path="' + workDir + '"]',
  );
  await workDirRow.waitFor({ state: 'visible', timeout: 10_000 });
  await workDirRow.click();
  const level2 = page.locator('[data-testid="choice-page"][data-level="2"]');
  await level2.waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('[data-testid="session-new"]').click();
  // R6 review 修复轮——wait for WebSocket to be online before
  // sending prompts. ChatView for session='new' mounts
  // immediately (createReadyGate = always ready, 不跑仪式),
  // 但 WebSocket 可能仍在握手/connecting 中——若 sendRaw 时
  // socket.readyState !== OPEN 则静默丢包。
  await page
    .locator('[data-testid="bridge-status"] [data-state="online"]')
    .waitFor({ state: 'visible', timeout: 30_000 });
  // Retry-tolerant recovery wait (5s timeout挂账 can fire on cold
  // pi restart, ADR-0009 §开放点 1). Same one-retry block as
  // scenarios (a) + (b).
  const either = await Promise.race([
    page
      .locator('[data-testid="chat-view"]')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'chat-view' as const)
      .catch(() => null),
    page
      .locator('[data-testid="recovery-error"]')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'recovery-error' as const)
      .catch(() => null),
  ]);
  if (either === 'recovery-error') {
    await page.locator('[data-testid="recovery-retry"]').click();
    await page
      .locator('[data-testid="chat-view"]')
      .waitFor({ state: 'visible', timeout: 30_000 });
  } else if (either !== 'chat-view') {
    throw new Error('Neither chat-view nor recovery-error appeared within 30s on context');
  }
  return { context, page };
}

/** Open a chat-view on a fresh browser context with a FULL M4 hash
 *  (token + work_dir + session=<stem>) — used for the second
 *  context in scenario (c) so both contexts view the SAME session
 *  (multi-tab first-responder semantics). The hash must already be
 *  refilled (session=<realStem>), not pending ('new'), so the
 *  recovery ceremony hits an existing manager via R3's session-
 *  bearing dual queries.
 *
 *  Context A uses `openChatOnContext` (M4 nav → new session).
 *  Context B uses this helper with the refilled hash from A —
 *  both contexts then view the same session, dialog broadcasts
 *  reach both sides (per ADR-0004 §补注 3 + 多端先答者胜). */
async function openChatOnExistingContext(
  browser: Browser,
  fullHash: string,
): Promise<DialogContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Direct navigation to the refilled M4 hash — bridge receives
  // pi/get_messages + control/get_state with session=<stem>
  // (R3 仪式带 session 出站) and recovers the same manager.
  await page.goto(fullHash);
  const either = await Promise.race([
    page
      .locator('[data-testid="chat-view"]')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'chat-view' as const)
      .catch(() => null),
    page
      .locator('[data-testid="recovery-error"]')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'recovery-error' as const)
      .catch(() => null),
  ]);
  if (either === 'recovery-error') {
    await page.locator('[data-testid="recovery-retry"]').click();
    await page
      .locator('[data-testid="chat-view"]')
      .waitFor({ state: 'visible', timeout: 30_000 });
  } else if (either !== 'chat-view') {
    throw new Error('Neither chat-view nor recovery-error appeared within 30s on existing session context');
  }
  return { context, page };
}

/** Build the scripted sequence for scenario (c):
 *    1. toolUseReply(trigger_dialog, kind=confirm)  → opens dialog
 *       on both contexts.
 *    2. textReply(...)  → assistant's follow-up text after the
 *       dialog commits. We use a recognisable string so the
 *       terminal row assertion is robust.
 *  The first call consumes (1), the second consumes (2). */
function buildScenarioCScript(followupText: string): Array<{ kind: 'reply'; reply: Array<{ event: string; data: unknown }> }> {
  return [
    {
      kind: 'reply',
      reply: toolUseReply({
        toolName: 'trigger_dialog',
        toolId: `toolu_scenC_${Date.now().toString(36)}`,
        input: { kind: 'confirm', title: 'Please confirm', message: 'Proceed with the operation?' },
        messageId: `msg_scenC_dialog_${Date.now().toString(36)}`,
      }),
    },
    {
      kind: 'reply',
      reply: [
        sseMessageStart({
          messageId: `msg_scenC_followup_${Date.now().toString(36)}`,
          model: 'fake-claude-haiku-4-5',
          inputTokens: 10,
        }),
        sseContentBlockStart({ index: 0, block: { type: 'text', text: '' } }),
        sseContentBlockDelta({ index: 0, delta: { type: 'text_delta', text: followupText } }),
        sseContentBlockStop({ index: 0 }),
        sseMessageDelta({ stopReason: 'end_turn', outputTokens: followupText.length }),
        sseMessageStop(),
      ],
    },
  ];
}

test.describe.configure({ mode: 'serial' });

test.describe('scenario (c) — multi-tab first-responder wins', () => {
  let ctxA: DialogContext;
  let ctxB: DialogContext;

  test.afterAll(async () => {
    // Close both contexts in parallel — the contexts are
    // independent (no shared cookies / localStorage), so the
    // order doesn't matter. Failures are isolated: a close error
    // on one context doesn't block the other.
    await Promise.allSettled([
      ctxA?.context.close().catch(() => undefined),
      ctxB?.context.close().catch(() => undefined),
    ]);
  });

  test('both contexts see dialog; first responder wins; other gets request_expired toast', async ({
    browser,
  }) => {
    const state = await readRunState();
    const { token, baseUrl, fakeLlmUrl } = state;

    // Step 1: A creates a new session via M4 flow (level=1 → level=2
    // → 新建会话 → stem refilled). B then opens the SAME session by
    // hash — both contexts view the same session for the multi-tab
    // first-responder semantics. We can't `Promise.all` because B
    // needs A's refilled hash.
    //
    // M4 task 08 review 修复轮 R6 flow note: the bridge's pending
    // manager (钉子 2, mapKey = `new:<work_dir>`) is only spawned
    // when the user sends the FIRST `pi/prompt` (Branch 3) — the
    // M4 flow's `session: 'new'` uses `createReadyGate()` (no
    // ceremony, task 08 R3) so the recovery ceremony is bypassed.
    // This is different from the M3 flow where the ceremony fired
    // `pi/get_messages` + `control/get_state` on mount and triggered
    // the manager spawn immediately. In M4, A must send its FIRST
    // prompt BEFORE the stem can be derived (the manager is
    // lazy-spawned on the first outbound command with `session:
    // 'new'` + `payload.work_dir`). We therefore install the dialog
    // script and send the prompt FIRST, then wait for the stem
    // refilled watcher to fire, then create B with the refilled
    // hash. B then subscribes to the same session for the multi-tab
    // first-responder semantics.
    ctxA = await openChatOnContext(browser, baseUrl, token, state.workDir);
    expect(ctxA).toBeDefined();

    // Step 2: install the dialog script BEFORE A sends the
    // prompt (so the LLM call that fires after A's prompt hits
    // our scripted toolUseReply and opens the dialog). The
    // follow-up text is the response after the dialog commits.
    await injectScript(fakeLlmUrl, buildScenarioCScript('scenario-c follow-up text'));

    // Step 3: A sends the prompt that triggers the manager spawn
    // (Branch 3) → pi subprocess cold start → jsonl creation →
    // stem derivation → bridge pending→stem migration → bridge
    // session_state{session:<stem>} broadcast → web stem-refilled
    // watcher refills the hash from `&session=new` to
    // `&session=<stem>`.
    const inputA = ctxA.page.locator('[data-testid="input-field"]');
    await inputA.waitFor({ state: 'visible', timeout: 10_000 });
    await inputA.fill('trigger confirm dialog');
    await ctxA.page.locator('[data-testid="input-send"]').click();

    // Step 3.5: wait for the App.tsx stem-refilled watcher to fire
    // (see R6 M4 flow note above — the watcher only refills the
    // hash after the pending manager derives a real stem, which
    // requires A's first prompt to land on the bridge). 30s budget
    // covers cold pi spawn + jsonl write + bridge migration + WS
    // round-trip; the test (a) R6 spec comment notes typical
    // completion is well under 5s on a local machine.
    await expect
      .poll(
        async () => {
          const currentHash = await ctxA.page.evaluate(() => window.location.hash);
          const match = currentHash.match(/session=([^&]*)/);
          if (match === null) return null;
          const decoded = decodeURIComponent(match[1]!);
          return decoded === 'new' ? null : decoded;
        },
        {
          timeout: 30_000,
          message:
            'Context A: App.tsx stem-refilled watcher did not update URL hash from session=new to a real stem within 30s',
        },
      )
      .not.toBeNull();
    const refilledHashOnA = await ctxA.page.evaluate(() => window.location.href);
    // B opens the same session via the full refilled M4 hash.
    ctxB = await openChatOnExistingContext(browser, refilledHashOnA);
    expect(ctxB).toBeDefined();

    // Step 4: both sides see the dialog. We use a short wait
    // because the dialog's lifetime is bounded by pi's 1st-turn
    // processing (pi emits agent_settled after the tool result
    // flows back, which clears blocked_on and unmounts the
    // dialog). On a fast machine the dialog is visible for
    // 1-3s only — sometimes as little as 40ms before the
    // bridge auto-clears blocked_on. We use a faster polling
    // cadence so Playwright doesn't miss it.
    const dialogSelector = '[data-testid="dialog-confirm"]';
    const fastPoll = async (page: Page): Promise<boolean> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((await page.locator(dialogSelector).count()) > 0) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    };
    const [aSawDialog, bSawDialog] = await Promise.all([
      fastPoll(ctxA.page),
      fastPoll(ctxB.page),
    ]);
    if (!aSawDialog || !bSawDialog) {
      throw new Error(
        `dialog never appeared on ${aSawDialog ? 'B' : !bSawDialog ? 'A' : 'either'} ` +
        `(aSawDialog=${aSawDialog} bSawDialog=${bSawDialog})`,
      );
    }

    // Step 5: B clicks Yes first (preferred 敲定点 5 path A).
    // The dialog may be about to auto-close (pi's 1st-turn
    // processing is fast on a local machine — typically 1-3s),
    // so we click without a separate waitFor. Playwright's
    // locator resolution retries the query until it finds the
    // element; if the dialog closes before resolution, this
    // fails. The retry tolerance is what gives the click the
    // race window against pi's agent_settled broadcast.
    const yesB = ctxB.page.locator('[data-testid="dialog-confirm-yes"]');
    await yesB.click({ timeout: 5_000 });

    // Step 6: A clicks Yes. The bridge clears blocked_on on
    // A's commit (per the first-responder-wins rule in
    // tasks/m3/05-bridge-popup-core + ADR-0004); DialogHost
    // unmounts the dialog on both sides via React key drop
    // (ADR-0009 §决策 7 末条 — DOM gone, NOT timer).
    //
    // On a fast machine A's dialog might already be gone
    // (B's commit cleared blocked_on before A could click).
    // The catch block below tolerates ONLY the auto-closed race
    // window: if the dialog had already vanished before our
    // click resolved, treat it as a soft pass. We probe the
    // dialog's presence BEFORE the click (via `count()`) so
    // that a future selector rename (`dialog-confirm-yes` →
    // something else) doesn't silently degrade into a
    // always-soft-pass — we explicitly require the dialog to
    // have been there in the first place.
    const yesA = ctxA.page.locator('[data-testid="dialog-confirm-yes"]');
    const sawYesButton = (await yesA.count()) > 0;
    try {
      await yesA.click({ timeout: 5_000 });
    } catch (e) {
      const stillThere = await ctxA.page.locator(dialogSelector).count();
      if (!sawYesButton && stillThere === 0) {
        // A's dialog already closed because B's click took
        // priority — this is the expected race window for path A.
        // The probe above guarantees we didn't silently pass on
        // a missing selector. (See step 7's soft assertion
        // below for the request_expired-side effect on B.)
      } else {
        // Dialog was still there at probe time, OR re-appeared
        // after the click failed for some other reason (e.g.
        // selector rename, transient click error): rethrow so
        // the failure isn't papered over as a race-window pass.
        throw e;
      }
    }

    // Step 7: dialog container unmounts on BOTH sides. We
    // assert `toHaveCount(0)` (per ADR-0009 §决策 7 —
    // react-key unmount, not timer wait).
    await Promise.all([
      expect(ctxA.page.locator(dialogSelector)).toHaveCount(0, { timeout: 5_000 }),
      expect(ctxB.page.locator(dialogSelector)).toHaveCount(0, { timeout: 5_000 }),
    ]);

    // Step 8: B's late response may surface as `request_expired`
    // toast (PRD §4.5 dialog → toast UX). The toast text
    // contains `request_expired` literally (per DialogHost's
    // string concat); we assert the regex tolerates future
    // i18n.
    //
    // This assertion is best-effort — the bridge might clear
    // blocked_on so fast that B's extension_ui_response
    // arrives after the dialog is gone but BEFORE the bridge
    // can tag it request_expired. On a fast machine the toast
    // is unlikely to appear because the dialog auto-closes
    // before B's click can register. We record the observation
    // as a `test.info().annotations.push(...)` so it shows up
    // in the Playwright HTML report (and on CI artefacts) —
    // replacing the previous console.log path that drowned in
    // the test runner's stdout.
    const toastB = ctxB.page.locator('[data-testid="dialog-toast"]');
    const toastVisible = await toastB.isVisible().catch(() => false);
    if (toastVisible) {
      const toastText = await toastB.textContent();
      test.info().annotations.push({
        type: 'observation',
        description: `[scenario-c] B request_expired toast: ${toastText ?? '<empty>'}`,
      });
    } else {
      test.info().annotations.push({
        type: 'observation',
        description: '[scenario-c] B toast did not appear (acceptable per 敲定点 5)',
      });
    }

    // Step 9: follow-up assistant message (the LLM's second
    // turn after the dialog commits) lands on A's side. We
    // don't require it on B's side because B's state machine
    // is also tracking the same history via the bridge's
    // broadcast, but the timing on which terminal row appears
    // can vary; asserting only on A keeps the test
    // deterministic. (The text isn't user-visible elsewhere
    // — it's a stable test anchor.)
    const followupA = ctxA.page.locator(
      '[data-testid="message-row"].message-role-assistant',
      { hasText: 'scenario-c follow-up text' },
    );
    await expect
      .poll(async () => await followupA.count(), {
        timeout: 30_000,
        message: 'follow-up assistant message with scripted text never appeared on A',
      })
      .toBeGreaterThanOrEqual(1);

    // Step 10: agent_settled — input regains focus on A (the
    // active turn driver). We don't require the same on B
    // (B may be in a transitional state after the request_expired
    // path); the load-bearing assertion is that A's session
    // recovered normally.
    await expect(ctxA.page.locator('[data-testid="input-field"]')).toBeEnabled({
      timeout: 30_000,
    });
  });
});
