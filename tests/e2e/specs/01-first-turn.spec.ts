// E2E scenario (a): first-turn streaming render — see ADR-0009 §决策 3
// 场景 (a) + 任务 13 §场景 (a) 补全.
//
// Verifies the M3 happy path end-to-end:
//   1. `page.goto('/#<token>')` triggers the dual-query recovery
//      ceremony.
//   2. ChatView renders (with retry tolerance for the 5s
//      RECOVERY_TIMEOUT_MS vs. cold pi-startup race documented in
//      ADR-0009 §开放点 1 — see retry-tolerant block below).
//   3. The user types into `input-field` and clicks `input-send`.
//   4. The user message row appears with the typed text (filtered
//      by `.message-role-user` per S7 review tightening — the
//      unfiltered `data-testid="message-row"` selector would
//      match any row whose body text contains the substring,
//      including a future assistant echo; the role class is
//      authoritative for the row's identity).
//   5. The assistant's terminal message row appears, also
//      filtered by `.message-role-assistant` (S7), with the
//      expected full text.
//   6. The streaming draft grows monotonically as the scripted
//      multi-delta reply unfolds (task 12 §场景 (a) step 7 —
//      now actually landed; previous harness relied on a single-
//      delta default that flashed the draft too quickly to
//      observe). We assert at least two intermediate draft
//      snapshots with strictly increasing length, then the
//      terminal row with the full text.
//   7. After the agent settles, the input field is usable again.
//
// ## Multi-delta script injection
//
// The fake LLM server runs as a standalone child (see
// fake-llm-process.ts); the spec can't reach into its in-process
// `script()` state directly. Instead we POST to
// `${fakeLlmUrl}/__e2e/script` — a loopback-only admin endpoint
// added in task 13 (see tests/integration/helpers/fake-llm-server.ts
// handleScriptInjection JSDoc) that REPLACES the server's script
// queue. We inject a 5-delta reply BEFORE sending the prompt so
// the web sees a multi-event SSE stream rather than the single-
// delta default.
//
// The 5-delta choice is deliberate: it's enough to observe
// monotonic draft growth (5 intermediate snapshots is overkill
// for `expect.poll`, but 2-3 is the sweet spot — fewer than 2
// leaves no monotonic-growth signal, more than 5 makes the
// SSE timing on a slow machine compress to a single frame).

import { test, expect, type Page } from '@playwright/test';

import { readRunState } from '../helpers/global-setup.js';
import { seedToken } from '../helpers/seed-token.js';
import { injectScript } from '../helpers/llm-script.js';
import {
  sseContentBlockDelta,
  sseContentBlockStart,
  sseContentBlockStop,
  sseMessageDelta,
  sseMessageStart,
  sseMessageStop,
} from '../../integration/helpers/fake-llm-server.js';

const MULTI_DELTA_PARTS = ['hello ', 'back ', 'from ', 'fake ', 'LLM'] as const;
const MULTI_DELTA_FULL = MULTI_DELTA_PARTS.join('');

function buildMultiDeltaScript(): Array<{ event: string; data: unknown }> {
  const messageId = `msg_e2e_${Date.now().toString(36)}`;
  const events: Array<{ event: string; data: unknown }> = [
    sseMessageStart({ messageId, model: 'fake-claude-haiku-4-5', inputTokens: 10 }),
    sseContentBlockStart({ index: 0, block: { type: 'text', text: '' } }),
  ];
  for (const part of MULTI_DELTA_PARTS) {
    events.push(sseContentBlockDelta({ index: 0, delta: { type: 'text_delta', text: part } }));
  }
  events.push(sseContentBlockStop({ index: 0 }));
  events.push(sseMessageDelta({ stopReason: 'end_turn', outputTokens: MULTI_DELTA_FULL.length }));
  events.push(sseMessageStop());
  return events;
}

async function waitForChatView(page: Page): Promise<void> {
  await page.locator('[data-testid="chat-view"]').waitFor({ state: 'visible', timeout: 30_000 });
}


test.describe('scenario (a) — first-turn streaming render (M4 flow)', () => {
  test('user sends a prompt through the M4 ChoicePage flow; assistant streams multi-delta; stem refilled; input regains focus', async ({ page }) => {
    const state = await readRunState();
    const { token, baseUrl, fakeLlmUrl } = state;

    // M4 task 08 review R6 — migrated to M4 flow per reviewer 方案 B:
    //   `#<token>` → ChoicePage level=1 (work_dirs list) →
    //   点击 bridge.json 配置的 work_dir → level=2 →
    //   「新建会话」→ pending ChatView (hash `&session=new`) →
    //   bridge 派生 stem → App.tsx stem-refilled watcher 回填
    //   hash → continue with the refilled hash (session=<stem>)。
    //
    // 该路径依赖：
    //   - R1 翻转 task 07 实施期的 M3-compat 偏离（`#<token>`
    //     不再旁路到 recovery，路由 choiceLevel1）；
    //   - R2 入站 fallback 链（bridge 不在 event/snapshot 上注入
    //     session，依赖 `currentSessionKey` 兜底落桶）；
    //   - R3 恢复仪式带 session 出站（get_messages + get_state
    //     信封携带 envelope.session）；
    //   - R4 stem 回填桶迁移（'new' 桶累积的早期消息整体搬到
    //     stem 桶，避免 ChatView 切到读 stem 桶时丢早期状态）。
    //
    // 三场景（a/b/c）同走此 M4 流——M3_LEGACY auto-spawn 路径
    // （`#<token>` 旁路到 recovery 的旧形态）不再被 e2e 消费；
    // bridge M3_LEGACY manager 仍然存在以服务 M3 旧链接的运维
    // / 调试场景，但 e2e 全 M4 化后该路径仅在外部访问旧链接
    // 时才被触发。

    // Step 1: seed token into localStorage + load → land on
    // ChoicePage level=1. (M5 §G6 / D9 — token is no longer in the
    // URL hash; it's stored in `localStorage['remotepi.token']`.)
    page.on('pageerror', (err) => {
      // Fail loudly if there's a JS error — common cause of React mount failure.
      throw new Error(`[browser pageerror] ${err.message}\n${err.stack ?? ''}`);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        process.stdout.write(`[browser ${msg.type()}] ${msg.text()}\n`);
      }
    });
    await seedToken(page, baseUrl, token);
    const level1 = page.locator('[data-testid="choice-page"][data-level="1"]');
    await level1.waitFor({ state: 'visible', timeout: 30_000 });

    // Step 2: click the work_dir row for the bridge's configured
    // work_dir (exposed via run-state.json). Row's data-testid is
    // 'work-dir-select' with a 'data-path' attribute matching the
    // absolute path.
    const workDirRow = page.locator(
      '[data-testid="work-dir-select"][data-path="' + state.workDir + '"]',
    );
    await workDirRow.waitFor({ state: 'visible', timeout: 10_000 });
    await workDirRow.click();

    // Step 3: land on ChoicePage level=2 — session list (may be
    // empty for this fresh work_dir; the test pre-populates no
    // sessions, so we expect the "暂无会话" empty state).
    const level2 = page.locator('[data-testid="choice-page"][data-level="2"]');
    await level2.waitFor({ state: 'visible', timeout: 30_000 });

    // Step 4: click 「新建会话」 → hash gets `&session=new` →
    // App re-dispatches to recovery → ChatView pending.
    await page.locator('[data-testid="session-new"]').click();
    await waitForChatView(page);

    // Wait for WebSocket to be online before sending prompts.
    // ChatView for session='new' mounts immediately
    // (createReadyGate = always ready, no ceremony), but the
    // WebSocket may still be in handshake/connecting — if
    // `sendRaw` runs while `socket.readyState !== OPEN` the
    // packet is silently dropped. The testid click path is
    // correct; just wait for WS online before clicking send.
    await page
      .locator('[data-testid="bridge-status"] [data-state="online"]')
      .waitFor({ state: 'visible', timeout: 30_000 });

    // Inject the multi-delta reply BEFORE sending the prompt so
    // the LLM call (which the bridge spawns pi to make on the
    // user's prompt) hits our scripted queue rather than the
    // server's default `textReply('ok')`. The script REPLACES the
    // queue (server semantics, not appends — see
    // handleScriptInjection JSDoc) so a stale queue from an
    // earlier spec doesn't bleed through.
    const count = await injectScript(fakeLlmUrl, [
      { kind: 'reply', reply: buildMultiDeltaScript() },
    ]);
    expect(count, 'injectScript should accept exactly one entry').toBe(1);

    // Type + send.
    const inputField = page.locator('[data-testid="input-field"]');
    await inputField.waitFor({ state: 'visible', timeout: 10_000 });
    await inputField.fill('hello-from-e2e');
    const sendButton = page.locator('[data-testid="input-send"]');
    // Start the in-page MutationObserver BEFORE clicking send.
    // The observer setup runs in the page's microtask queue, so
    // it's armed by the time the first SSE delta arrives — any
    // window between click and observer-armed would let an
    // intermediate draft render slip past unrecorded.
    //
    // The evaluate awaits the assistant terminal row inside the
    // page context (with a 20s budget) so we don't need to race
    // the click → LLM response on the Node side; the page knows
    // when it's done.
    const observerPromise = page.evaluate(async () => {
      const samples: number[] = [];
      const draftSelector = '[data-testid="message-draft"]';
      // Streaming continuity guard: the observer also tracks
      // `[data-testid="chat-view"]` / `[data-testid="recovery-in-
      // flight"]` visibility during the stream. If ChatView gets
      // replaced by `<RecoveryInFlight/>` between any two
      // deltas, ChatView unmounts → draft element leaves the DOM
      // → subsequent deltas don't render → the streaming
      // typewriter effect is lost (the original 4th gap
      // regression).
      const start = performance.now();
      const deadline = start + 20_000;
      // Observe the MessageList subtree (the closest stable
      // ancestor of the draft) so we catch inserts/removals even
      // if the draft element itself is replaced by the terminal
      // message row mid-flight.
      const messageList = document.querySelector('[data-testid="message-list"]');
      if (messageList === null) {
        return { samples, recoveryInFlightSeen: false, chatViewSeen: false, error: 'message-list not found at evaluate time' };
      }
      const observer = new MutationObserver(() => {
        const draft = document.querySelector(draftSelector);
        if (draft !== null) {
          // `textContent` on the `<li>` includes BOTH the role
          // label (`assistant`/`user`) and the body text; the
          // appended delta only contributes to `.message-body`.
          // We measure the body specifically so the sample length
          // maps 1:1 to the streamed text length (no role-label
          // constant offset).
          const body = draft.querySelector('.message-body');
          const text = body?.textContent ?? '';
          const len = text.length;
          if (len > 0) {
            const last = samples[samples.length - 1];
            if (last !== len) samples.push(len);
          }
        }
      });
      observer.observe(messageList, { childList: true, subtree: true, characterData: true });
      // Streaming continuity tracker: while the observer is
      // alive, poll the DOM for chat-view and recovery-in-flight
      // visibility. `chatViewSeen` is a sanity pin (chat-view
      // should be visible when the observer starts);
      // `recoveryInFlightSeen` is the load-bearing assertion — if
      // it ever becomes true during the observer window,
      // ChatView was replaced by RecoveryInFlight, violating the
      // 4th gap regression invariant.
      let chatViewSeen = false;
      let recoveryInFlightSeen = false;
      while (performance.now() < deadline) {
        const assistant = document.querySelector(
          '[data-testid="message-row"].message-role-assistant',
        );
        const chatView = document.querySelector('[data-testid="chat-view"]');
        const recoveryInFlight = document.querySelector(
          '[data-testid="recovery-in-flight"]',
        );
        if (chatView !== null) chatViewSeen = true;
        if (recoveryInFlight !== null) recoveryInFlightSeen = true;
        if (assistant !== null) {
          // Wait one more animation frame to catch any final
          // MutationObserver flush before disconnecting.
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      observer.disconnect();
      return { samples, chatViewSeen, recoveryInFlightSeen, error: null };
    });
    await sendButton.click();

    // User message row (S7 — filter by role class). The MessageList
    // renders the user message immediately on `sendPrompt` (local
    // optimistic append); the role class is the authoritative
    // identity for the row.
    const userRow = page.locator(
      '[data-testid="message-row"].message-role-user',
      { hasText: 'hello-from-e2e' },
    );
    await userRow.waitFor({ state: 'visible', timeout: 15_000 });

    // Step 6: wait for the App-level stem-refilled watcher to
    // fire — bridge broadcasts session_state{session:<stem>}
    // after the pending manager's first session_state, watcher
    // refills the hash from `session=new` to
    // `session=<realStem>`. We poll up to 30s (the ceremony's
    // first turn + pi cold spawn + watcher fire usually well
    // under 5s; 30s is headroom for slow machines).
    //
    // The watcher fires when the session_state arrives in the
    // bucket, which typically lands after the user's prompt
    // + pi's first session_state phase transition. After
    // userRow appears (local optimistic append) we poll for
    // the watcher fire.
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
          timeout: 30_000,
          message:
            'App.tsx stem-refilled watcher did not update URL hash from session=new to a real stem within 30s',
        },
      )
      .not.toBeNull();

    // Await the in-page observer's completion — it records every
    // intermediate draft length and signals when the terminal
    // assistant row appears.
    const draftGrowthSamples = await observerPromise;
    expect(
      draftGrowthSamples.error,
      'MutationObserver setup',
    ).toBeNull();
    expect(
      draftGrowthSamples.samples.length,
      `expected at least 2 distinct draft text lengths (monotonic growth signal); got [${draftGrowthSamples.samples.join(', ')}]`,
    ).toBeGreaterThanOrEqual(2);
    // Streaming continuity assertion: chat-view must stay
    // mounted throughout the observer window (not unmounted);
    // recovery-in-flight must NOT appear in the DOM (ChatView
    // not replaced by RecoveryInFlight). The original symptom
    // was: hash flip → gateForSession(<stem>) miss →
    // initiateRecovery → ChatView unmounts → RecoveryInFlight
    // → deltas don't render → typewriter effect lost. This
    // assertion is the regression pin for that bug.
    expect(
      draftGrowthSamples.chatViewSeen,
      'chat-view should be visible throughout the streaming window',
    ).toBe(true);
    expect(
      draftGrowthSamples.recoveryInFlightSeen,
      'recovery-in-flight must NOT appear during streaming window — would indicate ChatView was unmounted',
    ).toBe(false);
    // Verify strict monotonicity (this is the load-bearing
    // assertion — a non-monotonic sequence means the renderer
    // emitted shorter text after longer text, which is a real
    // regression bug).
    for (let i = 1; i < draftGrowthSamples.samples.length; i += 1) {
      const prev = draftGrowthSamples.samples[i - 1] as number;
      const curr = draftGrowthSamples.samples[i] as number;
      expect(
        curr > prev,
        `draft text length must be strictly increasing: [${draftGrowthSamples.samples.join(', ')}]`,
      ).toBe(true);
    }
    // The last sample must reach the full scripted length — the
    // observer stops once the terminal row appears, but the
    // draft's final commit should match the LLM's terminal text.
    expect(
      draftGrowthSamples.samples[draftGrowthSamples.samples.length - 1],
      'final draft length should reach the full scripted text length',
    ).toBe(MULTI_DELTA_FULL.length);
    // terminal row appears once the WsClient's `message_end`
    // handler clears the matching draft and appends the final
    // message. `count() === 1` (per S7 tightening) catches the
    // double-render regression where the terminal row briefly
    // appears alongside a stale draft before both settle.
    const assistantRow = page.locator(
      '[data-testid="message-row"].message-role-assistant',
      { hasText: MULTI_DELTA_FULL },
    );
    await expect
      .poll(async () => await assistantRow.count(), {
        timeout: 30_000,
        message: 'assistant message-row with full multi-delta text never appeared',
      })
      .toBe(1);

    // After agent_settled, the input field is usable again
    // (textbox gated ONLY by phase; sendButton gated by phase
    // AND value non-empty). See task 12 spec for the full
    // reasoning on why we assert on inputField (not sendButton
    // alone).
    await expect(inputField).toBeEnabled({ timeout: 30_000 });
    await inputField.fill('ready-again');
    await expect(sendButton).toBeEnabled({ timeout: 5_000 });

    // Draft cleanup — `message-draft` must be gone after the
    // terminal message arrives (WsClient's message_end handler
    // clears the draft in the same React batch as the message
    // append). Tolerate either instantaneous terminal (no draft
    // ever visible) or a transient draft replaced by the
    // terminal.
    const draft = page.locator('[data-testid="message-draft"]');
    await expect(draft).toHaveCount(0, { timeout: 30_000 });
  });
});
