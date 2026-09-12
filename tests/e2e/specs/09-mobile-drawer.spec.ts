// E2E spec (09): mobile drawer + focus trap + inert + scroll lock — see
// PRD §第二块 G7 + D12 / 任务 07 brief §c / 任务 08 §b 移动端新 spec.
//
// ## Viewport
//
//   **375×667 (iPhone SE 第一代 viewport)** — PRD §D12 「768px 单断点」
//   下 mobile 侧的最大常用尺寸；与 `useIsMobile` 阈值 767px 对齐
//   （即 viewport 宽 ≤ 767 判 mobile，375 < 768 → mobile）。
//
// ## Scope
//
//   覆盖移动端专属行为——桌面端既有 8 个 spec 已覆盖常规路径。
//   本 spec 验证：
//
//   1. **未认证路径** — 直接访问（无 token），TokenModal required
//      模式可见且**不可关闭**（Esc 键 + 遮罩点击均无效），提交后
//      进入主流程（ChoicePage level=1）。
//   2. **level1 移动端顶栏** — mobile-top-bar 渲染 + 汉堡按钮唯一
//      （无桌面 SessionStatusBar）。
//   3. **抽屉展开态** — backdrop 可见 + aria-expanded=true +
//      body 滚动锁（getComputedStyle(document.body).overflow ===
//      'hidden'）。
//   4. **backdrop 关闭 + 焦点归还** — 点击 backdrop 关闭抽屉 + 焦点
//      归还到汉堡按钮（document.activeElement === sidebar-toggle）。
//   5. **Tab 循环真测量** — 抽屉展开态连续 Tab 后焦点仍在 sidebar
//      内循环；Shift+Tab 反向。
//   6. **W1 钉桩 (任务 08 review)** — 抽屉关闭态按 Tab，焦点不落
//      入屏外 sidebar（inert property 生效 → 浏览器拒绝 Tab 进入
//      inert 子树）。
//   7. **Escape 关闭** — 抽屉展开态按 Escape 关闭 + 焦点归还汉堡。
//   8. **滚动锁实测** — getComputedStyle(document.body).overflow
//      开关切换（开 = 'hidden'，关 = 原值）。
//   9. **跨 view 导航** — level1 → 开抽屉选 workDir → 自动收起进
//      level2 → 再开抽屉选 session → 进 recovery；recovery 视图
//      汉堡位于 SessionStatusBar，无双汉堡（testid 唯一实例）。
//   10. **TokenModal / DirectoryBrowser 移动端 sheet 形态抽查** —
//      full-screen / 非居中卡片形态可识别（class 含 inset-0 +
//      无 rounded-lg）。
//   11. **桌面零回归抽查** — ≥768 viewport → 0 个 sidebar-toggle
//      / 0 个 mobile-top-bar（防 mobile-only testid 泄漏）。
//
// ## Conventions
//
//   - `seedToken(page, baseUrl, token)` 注入 localStorage（M5 §G6 /
//     D9 hash 模型收缩后 token 不再走 URL hash）。
//   - 浏览器上下文由 `test.use({ viewport: ... })` 在 `describe` 级
//     设；桌面端抽查走第二个 `describe` 重新设 viewport。
//   - 焦点断言走 `page.evaluate(() => document.activeElement?.tagName
//     + selector)` —— 与既有 01 spec §6 MutationObserver 模式一致。
//   - 移动端 viewport 下 `matchMedia('(max-width: 767px)')` 触发
//     mobile 分支；桌面端抽查走 ≥768 viewport。

import { test, expect, type Page } from '@playwright/test';

import { readRunState } from '../helpers/global-setup.js';
import { seedToken } from '../helpers/seed-token.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function gotoApp(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl);
}

async function waitForTokenModal(page: Page): Promise<void> {
  await page.locator('[data-testid="token-modal"]').waitFor({ state: 'visible', timeout: 30_000 });
}

async function waitForHamburger(page: Page): Promise<void> {
  await page.locator('[data-testid="sidebar-toggle"]').waitFor({ state: 'visible', timeout: 10_000 });
}

async function waitForLevel1(page: Page): Promise<void> {
  await page.locator('[data-testid="choice-page"][data-level="1"]').waitFor({ state: 'visible', timeout: 30_000 });
}

async function waitForLevel2(page: Page): Promise<void> {
  await page.locator('[data-testid="choice-page"][data-level="2"]').waitFor({ state: 'visible', timeout: 30_000 });
}

/** Build a selector string describing the active element — for
 *  log readability + assertion clarity. Returns `null` when nothing
 *  is focused (or `document.activeElement` is the body). */
async function activeElementDescriptor(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body) return null;
    const tag = el.tagName.toLowerCase();
    const testId = (el as HTMLElement).getAttribute?.('data-testid') ?? null;
    const id = (el as HTMLElement).id ?? null;
    return testId !== null
      ? `${tag}[data-testid="${testId}"]`
      : id !== ''
        ? `${tag}#${id}`
        : tag;
  });
}

/** Returns the `inert` property of an element by testid — for W1
 * 钉桩验证. */
async function _inertProperty(page: Page, testId: string): Promise<boolean | null> {
  return await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el === null) return null;
    return (el as HTMLElement).inert ?? false;
  }, testId);
}

// ===========================================================================
// Mobile viewport — 375×667 (iPhone SE 第一代 viewport)
// ===========================================================================

test.describe('scenario (mobile 375x667): drawer + focus trap + inert + scroll lock', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('1. 未认证路径：TokenModal required 不可关闭（Esc + 遮罩点击无效）→ 提交后进主流程', async ({ page }) => {
    const state = await readRunState();

    // Step 1: 直接访问 → auth.token === null → TokenModal required
    // 渲染。无 token localStorage seed（用 `goto` 而非 `seedToken`）。
    await gotoApp(page, state.baseUrl);
    await waitForTokenModal(page);

    // 断言 1a：required 模式不渲染 X 关闭按钮（testid 缺失）。
    const closeBtn = page.locator('[data-testid="token-modal-close"]');
    await expect(closeBtn, 'required mode should not render X close button').toHaveCount(0);

    // 断言 1b：backdrop 渲染但 `disabled`（required 模式 backdrop
    // 点击无效）。
    const backdrop = page.locator('[data-testid="token-modal-backdrop"]');
    await expect(backdrop).toBeVisible();
    const backdropDisabled = await backdrop.evaluate((el) => (el as HTMLButtonElement).disabled);
    expect(backdropDisabled, 'required mode backdrop must be disabled').toBe(true);

    // 断言 1c：按 Esc → token-modal 仍在 DOM（required 模式 Esc 无效）。
    // Esc 是同步 no-op（TokenModal required 模式不挂 useFocusTrap，
    // document 上无 Escape 监听器）—— 立即断言更强，无需 waitForTimeout。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="token-modal"]')).toBeVisible();

    // 断言 1d：模拟 click 事件派发到 disabled backdrop（验证即使
    // 绕过浏览器原生 disabled 拦截，组件层 handleBackdropClick
    // 仍有 `if (required) return;` 兜底——token-modal 仍可见）。
    // 用 `dispatchEvent` 直接派发 click，跳过 Playwright 的 actionability
    // 检查（disabled button 在 Playwright 默认策略下不可点）。
    // `handleBackdropClick` 是同步 no-op → 立即断言。
    await backdrop.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await expect(page.locator('[data-testid="token-modal"]')).toBeVisible();

    // 断言 1e：提交合法 token → reload → 进入 ChoicePage level=1
    // （mobile 顶栏 + 汉堡可见）。
    await page.locator('[data-testid="token-input"]').fill(state.token);
    await page.locator('[data-testid="token-submit"]').click();
    await waitForLevel1(page);
    await waitForHamburger(page);
  });

  test('2. level1 移动端顶栏：mobile-top-bar 渲染 + 汉堡唯一', async ({ page }) => {
    const state = await readRunState();

    await seedToken(page, state.baseUrl, state.token);
    await waitForLevel1(page);

    // 断言 2a：mobile-top-bar 根 testid 可见（level1 视图专属组件）。
    const mobileTopBar = page.locator('[data-testid="mobile-top-bar"]');
    await expect(mobileTopBar, 'mobile level1 should render MobileTopBar').toBeVisible();

    // 断言 2b：view 标题为「选择工作目录」（level1 文案）。
    await expect(mobileTopBar).toHaveAttribute('data-view-title', '选择工作目录');

    // 断言 2c：汉堡按钮渲染 + aria-expanded=false（默认收起）。
    const hamburger = page.locator('[data-testid="sidebar-toggle"]');
    await expect(hamburger).toBeVisible();
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    await expect(hamburger).toHaveAttribute('aria-label', '打开侧边栏');

    // 断言 2d：恰好 1 个 sidebar-toggle（无双汉堡）+ 0 个
    // session-status-bar（recovery 组件不应出现）。
    expect(await page.locator('[data-testid="sidebar-toggle"]').count()).toBe(1);
    expect(await page.locator('[data-testid="session-status-bar"]').count()).toBe(0);
  });

  test('3. 开抽屉 → backdrop 可见 + aria-expanded=true + body 滚动锁', async ({ page }) => {
    const state = await readRunState();

    await seedToken(page, state.baseUrl, state.token);
    await waitForLevel1(page);
    await waitForHamburger(page);

    // 记录原 body overflow（spec body 滚动锁应恢复而非清空）。
    const originalOverflow = await page.evaluate(() => document.body.style.overflow);
    expect(originalOverflow, 'baseline body overflow should be empty string').toBe('');

    // 触发开抽屉。
    const hamburger = page.locator('[data-testid="sidebar-toggle"]');
    await hamburger.click();

    // 断言 3a：aria-expanded 翻 true + aria-label 翻「关闭侧边栏」。
    await expect(hamburger).toHaveAttribute('aria-expanded', 'true');
    await expect(hamburger).toHaveAttribute('aria-label', '关闭侧边栏');

    // 断言 3b：backdrop 可见。
    const backdrop = page.locator('[data-testid="sidebar-backdrop"]');
    await expect(backdrop).toBeVisible();

    // 断言 3c：body 滚动锁生效（getComputedStyle 读实际样式；含
    // 内联样式 + 默认 stylesheet 叠加）。
    const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
    expect(bodyOverflow, 'body overflow should be hidden when drawer is open').toBe('hidden');

    // 断言 3d：sidebar 元素可见（不在屏外）。
    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(sidebar).toBeVisible();

    // 清理：关抽屉让后续测试 body 状态正确。
    await backdrop.click();
    await expect(backdrop).toBeHidden();
  });

  test('4. backdrop 关闭 + 焦点归还汉堡（document.activeElement === sidebar-toggle）', async ({ page }) => {
    const state = await readRunState();

    await seedToken(page, state.baseUrl, state.token);
    await waitForLevel1(page);
    await waitForHamburger(page);

    const hamburger = page.locator('[data-testid="sidebar-toggle"]');
    await hamburger.click();
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeVisible();

    // 抽屉展开后 useFocusTrap focus 容器内第一个 focusable
    // (level1 view → WorkDirs tab default → sidebar-tab-work-dirs
    // 第一个 focusable)。等焦点移动后再 backdrop close — 不可
    // 用固定 setTimeout（race with focusTrap 同步 focus 调用）。
    await expect
      .poll(
        async () => await activeElementDescriptor(page),
        { timeout: 2_000, message: 'focus should have moved off the hamburger after drawer opens' },
      )
      .not.toBe('button[data-testid="sidebar-toggle"]');

    await page.locator('[data-testid="sidebar-backdrop"]').click();

    // 断言：backdrop 隐藏 + 焦点回到 hamburger。
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeHidden();
    await expect
      .poll(
        async () => await activeElementDescriptor(page),
        { timeout: 2_000, message: 'focus should return to hamburger after backdrop close' },
      )
      .toBe('button[data-testid="sidebar-toggle"]');
  });

  test('5. Tab 焦点逃逸防护：抽屉展开态连续 Tab 焦点始终留在 sidebar 内 + Shift+Tab 反向（包含性检查非逐位循环测量）', async ({ page }) => {
    const state = await readRunState();

    await seedToken(page, state.baseUrl, state.token);
    await waitForLevel1(page);
    await waitForHamburger(page);

    await page.locator('[data-testid="sidebar-toggle"]').click();
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeVisible();

    // 收集 sidebar 内 focusable 元素数量（应 ≥ 2 才能验证循环）。
    const sidebarFocusableCount = await page.evaluate(() => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      if (sidebar === null) return 0;
      const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const els = Array.from(sidebar.querySelectorAll(sel));
      // 过滤 inert 子树内的 focusable（本测试 sidebar 在抽屉
      // 展开态 inert=false，应该全部可 Tab）。
      return els.filter((el) => {
        let cur: HTMLElement | null = el as HTMLElement;
        while (cur !== null && cur !== sidebar) {
          if (cur.inert) return false;
          cur = cur.parentElement;
        }
        return true;
      }).length;
    });
    expect(sidebarFocusableCount, 'sidebar should have ≥2 focusable elements for cycle test').toBeGreaterThanOrEqual(2);

    // 正向 Tab 循环：连续 N+2 次 Tab（N = sidebar focusable 数），
    // 焦点仍应在 sidebar 内。
    const iterations = sidebarFocusableCount + 2;
    for (let i = 0; i < iterations; i += 1) {
      await page.keyboard.press('Tab');
    }
    const afterForwardTab = await page.evaluate(() => {
      const active = document.activeElement;
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      if (active === null || sidebar === null) return false;
      return sidebar.contains(active);
    });
    expect(afterForwardTab, 'forward Tab cycle should keep focus inside sidebar').toBe(true);

    // Shift+Tab 反向循环：再 N+2 次 Shift+Tab，焦点仍应在
    // sidebar 内（反向 wrap）。
    for (let i = 0; i < iterations; i += 1) {
      await page.keyboard.press('Shift+Tab');
    }
    const afterBackwardTab = await page.evaluate(() => {
      const active = document.activeElement;
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      if (active === null || sidebar === null) return false;
      return sidebar.contains(active);
    });
    expect(afterBackwardTab, 'Shift+Tab reverse cycle should keep focus inside sidebar').toBe(true);

    // 清理：关抽屉。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeHidden();
  });

  test('6. W1 钉桩：抽屉关闭态按 Tab 焦点不落入屏外 sidebar（inert 生效）', async ({ page }) => {
    const state = await readRunState();

    await seedToken(page, state.baseUrl, state.token);
    await waitForLevel1(page);
    await waitForHamburger(page);

    // 抽屉关闭态断言 inert 生效（任务 08 review W1）。
    const inertActive = await page.evaluate(() => {
      const aside = document.getElementById('app-sidebar');
      return aside?.inert ?? null;
    });
    expect(inertActive, 'app-sidebar should have inert=true when drawer is closed (W1 钉桩)').toBe(true);

    // 记录原 activeElement（应 = 汉堡按钮本身，因为我们刚
    // seedToken 完）。
    await page.locator('[data-testid="sidebar-toggle"]').focus();
    const beforeTabFocus = await activeElementDescriptor(page);
    expect(beforeTabFocus).toBe('button[data-testid="sidebar-toggle"]');

    // Tab 焦点前移：浏览器应跳过 inert 子树内的所有 focusable
    // 元素（包括 sidebar 内的 tabs / settings / work-dir-browse
    // 等）。连续 Tab 多次验证焦点从未落入 sidebar 子树。
    const sidebarFocusables = await page.evaluate(() => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      if (sidebar === null) return [];
      const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return Array.from(sidebar.querySelectorAll(sel))
        .filter((el) => (el as HTMLElement).tabIndex !== -1)
        .map((el) => {
          const testId = (el as HTMLElement).getAttribute?.('data-testid') ?? null;
          return testId !== null ? `[data-testid="${testId}"]` : el.tagName.toLowerCase();
        });
    });
    expect(sidebarFocusables.length, 'sanity: sidebar should have focusable elements').toBeGreaterThan(0);

    // Tab 10 次（覆盖 sidebar 内全部 focusable + 越过去到 main
    // 槽位的 input-field）—— 任何一次焦点落入 sidebar 都视为
    // W1 失效。
    let landedInSidebar = false;
    let landedSelector: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press('Tab');
      const cur = await activeElementDescriptor(page);
      const inSidebar = await page.evaluate(() => {
        const active = document.activeElement;
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        return active !== null && sidebar !== null && sidebar.contains(active);
      });
      if (inSidebar) {
        landedInSidebar = true;
        landedSelector = cur;
        break;
      }
    }
    expect(
      landedInSidebar,
      `Tab should never enter inert sidebar (W1 钉桩) — landed at ${landedSelector}`,
    ).toBe(false);
  });

  test('7. Escape 关闭 → 焦点回汉堡', async ({ page }) => {
    const state = await readRunState();

    await seedToken(page, state.baseUrl, state.token);
    await waitForLevel1(page);
    await waitForHamburger(page);

    const hamburger = page.locator('[data-testid="sidebar-toggle"]');
    await hamburger.click();
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeVisible();

    // useFocusTrap 的 onEscape 触发 onCloseSidebar（任务 08 W2
    // 验证：useFocusTrap 的 keydown 是 Escape 唯一入口，无显式
    // window listener 双触发）。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeHidden();

    const focusAfterEsc = await activeElementDescriptor(page);
    expect(focusAfterEsc, 'focus should return to hamburger after Escape close').toBe('button[data-testid="sidebar-toggle"]');
  });

  test('8. 滚动锁实测：开抽屉 → overflow=hidden；关抽屉 → 还原', async ({ page }) => {
    const state = await readRunState();

    await seedToken(page, state.baseUrl, state.token);
    await waitForLevel1(page);
    await waitForHamburger(page);

    const hamburger = page.locator('[data-testid="sidebar-toggle"]');

    // 关闭态基线：getComputedStyle 返回 computed value，body 默认
    // overflow === 'visible'（无内联样式）。AppShell 的 effect
    // cleanup 会恢复内联 style.overflow；恢复后 computed value
    // 回到 'visible'。
    const baselineOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
    expect(baselineOverflow, 'baseline body computed overflow').toBe('visible');

    // 开抽屉 → hidden（computed overflow 翻 'hidden'）。
    await hamburger.click();
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeVisible();
    await expect
      .poll(
        async () => await page.evaluate(() => getComputedStyle(document.body).overflow),
        { timeout: 2_000, message: 'open drawer body computed overflow should be hidden' },
      )
      .toBe('hidden');

    // 关抽屉 → 还原 baseline。effect cleanup 是同步的，但 React
    // commit/effect 调度会有微秒延迟——轮询直到恢复 'visible'。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeHidden();
    await expect
      .poll(
        async () => await page.evaluate(() => getComputedStyle(document.body).overflow),
        { timeout: 2_000, message: 'closed drawer body computed overflow should restore to baseline' },
      )
      .toBe(baselineOverflow);
  });

  test('9. level1 → 开抽屉选 workDir → 自动收起进 level2 → 再开抽屉选 session → 进 recovery', async ({ page }) => {
    const state = await readRunState();

    await seedToken(page, state.baseUrl, state.token);
    await waitForLevel1(page);
    await waitForHamburger(page);

    // 9.1 — level1 视图下开抽屉 → 抽屉内 WorkDirs tab 默认激活
    // （defaultTabForView(choiceLevel1) = 'work-dirs'）→ 选 workDir
    // 行 → hash 翻 → 进 level2 → 抽屉自动收起（hashchange 监听）。
    await page.locator('[data-testid="sidebar-toggle"]').click();
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeVisible();

    // 抽屉展开后 sidebar 内 WorkDirs tab 应为 active（level1
    // 视图默认 tab）。
    const sidebarWorkDirsTab = page.locator('[data-testid="sidebar-tab-work-dirs"]');
    await expect(sidebarWorkDirsTab).toHaveAttribute('data-active', 'true');

    // 抽屉内点击 work-dir-select（侧边栏 work-dir 列表的某行）。
    const workDirRow = page.locator(
      '[data-testid="work-dir-select"][data-path="' + state.workDir + '"]',
    );
    await workDirRow.waitFor({ state: 'visible', timeout: 10_000 });
    await workDirRow.click();

    // 9.2 — level2 视图：choice-page[data-level="2"] 可见 + 抽屉
    // 自动收起（hashchange → onCloseSidebar）。
    await waitForLevel2(page);
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeHidden({ timeout: 10_000 });

    // 9.3 — level2 视图下 mobile-top-bar 标题 = 「选择会话」；
    // 抽屉内 default tab 现在是 Sessions（defaultTabForView(
    // choiceLevel2) = 'sessions'）。
    const mobileTopBar = page.locator('[data-testid="mobile-top-bar"]');
    await expect(mobileTopBar).toHaveAttribute('data-view-title', '选择会话');

    // 9.4 — level2 开抽屉 → Sessions tab active → sidebar
    // session-list 可见（空状态可接受，因 e2e fixture 无 seed
    // sessions）。
    await page.locator('[data-testid="sidebar-toggle"]').click();
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeVisible();
    const sidebarSessionsTab = page.locator('[data-testid="sidebar-tab-sessions"]');
    await expect(sidebarSessionsTab).toHaveAttribute('data-active', 'true');

    // 抽屉内点击「+ 新建会话」→ 进 recovery。
    await page.locator('[data-testid="session-new"]').click();

    // 9.5 — recovery 视图：chat-view 可见 + 汉堡唯一位于
    // SessionStatusBar（无双汉堡）+ 不再渲染 mobile-top-bar
    // （App.tsx 按 view 分派——互斥渲染）。
    await page.locator('[data-testid="chat-view"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator('[data-testid="session-status-bar"]')).toBeVisible();
    expect(await page.locator('[data-testid="sidebar-toggle"]').count()).toBe(1);
    expect(await page.locator('[data-testid="mobile-top-bar"]').count()).toBe(0);

    // 9.6 — recovery 视图下 mobile bridge 在线 → 汉堡开抽屉仍
    // 可用（spot check：抽屉机制在 recovery 视图继续工作）。
    await page.locator('[data-testid="sidebar-toggle"]').click();
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeVisible();
    // 关抽屉。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeHidden();
  });

  test('10. TokenModal / DirectoryBrowser 移动端 sheet 形态抽查', async ({ page }) => {
    const state = await readRunState();

    // 10a — TokenModal（未认证路径）：移动端 sheet 形态（inset-0
    // + 非居中卡片 + 无 rounded-lg）—— 直接访问，无 token seed。
    // 使用独立 page（fixture 提供 fresh context，describe 级
    // `test.use({ viewport: { width: 375, height: 667 } })` 已生效，
    // 无需手动 newContext + setViewportSize）。
    await page.goto(state.baseUrl);
    await waitForTokenModal(page);

    // 移动端 sheet 形态：modal root 含 `inset-0`（任务 07 §c
    // TokenModal mobile 全屏）+ inner card 无 `rounded-lg`
    // （桌面卡片专属圆角）。
    const tokenModalHtml = await page.locator('[data-testid="token-modal"]').first().evaluate((el) => el.outerHTML);
    expect(tokenModalHtml, 'TokenModal mobile sheet should use inset-0 (full-screen)').toContain('inset-0');
    // inner card 不含 rounded-lg（移动端 sheet 无圆角）。
    expect(tokenModalHtml, 'TokenModal mobile sheet should NOT have rounded-lg card').not.toContain('rounded-lg');

    // 10b — DirectoryBrowser（mobile 全屏 sheet 形态）：seedToken
    // → ChoicePage level=1 → 开抽屉 → 点 work-dir-browse →
    // DirectoryBrowser 打开。mobile 形态：testid 容器含 `inset-0`
    // + 非 `card directory-browser`（桌面形态）。
    //
    // 注意：抽屉关闭态下 sidebar 是 `-translate-x-full pointer-events-
    // none`（屏外），Playwright 直接点 work-dir-browse 会报
    // outside-of-viewport。须先开抽屉让 sidebar 进入视口。W1 焦点
    // 陷阱互斥（`openBrowserAndCloseDrawer` helper）确保抽屉在
    // DirectoryBrowser 打开同时自动收起——但开抽屉的瞬间 sidebar
    // 在视口里，work-dir-browse 即可点击。
    //
    // 用新 page 避免 10a 状态污染（10a 提交 token 后会进 ChoicePage，
    // 此处需要从零状态验证 DirectoryBrowser）。fixture 自带 context
    // 隔离，每个 test 独立 page；如需同 test 内多 page，再 newPage。
    const pageB = await page.context().newPage();
    await seedToken(pageB, state.baseUrl, state.token);
    await waitForLevel1(pageB);
    await pageB.locator('[data-testid="sidebar-toggle"]').click();
    await expect(pageB.locator('[data-testid="sidebar-backdrop"]')).toBeVisible();
    await pageB.locator('[data-testid="work-dir-browse"]').click();
    const directoryBrowser = pageB.locator('[data-testid="directory-browser"]');
    await directoryBrowser.waitFor({ state: 'visible', timeout: 10_000 });

    const dirBrowserClass: string = await directoryBrowser.evaluate((el: Element) => el.className);
    expect(dirBrowserClass, 'DirectoryBrowser mobile should use inset-0 (full-screen sheet)').toContain('inset-0');
    expect(dirBrowserClass, 'DirectoryBrowser mobile should NOT have `card directory-browser` (desktop form)').not.toContain('card directory-browser');
    await pageB.close();
  });

  test('10b. 抽屉 → 设置按钮 → closable TokenModal → Esc 恰好关一次（S4 e2e 闭环）', async ({ page }) => {
    // S4 — 补全 W2 e2e 闭环：test 1 验证了「required 模式 Esc 无效」；
    // 本测试验证「closable 模式 Esc 有效 + 抽屉/TokenModal 互斥 +
    // Esc 仅关 TokenModal 不连带关其他 trap」。流程：
    //
    //   level1 → 开抽屉 → 点 settings-button → openSettingsAndCloseDrawer
    //   helper 同时收起抽屉 + 打开 TokenModal（互斥）→ 按 Esc → 仅
    //   TokenModal 关闭（document 上只一个 useFocusTrap active listener，
    //   Esc 只触 TokenModal 的 onClose）。
    //
    //   若 Esc 意外触发抽屉关闭（双 trap 残留），drawer backdrop 仍
    //   可见 → 断言失败。
    //   若 Esc 未关 TokenModal（Trap 钩子未挂），token-modal 仍在 → 断言失败。
    const state = await readRunState();
    await seedToken(page, state.baseUrl, state.token);
    await waitForLevel1(page);
    await waitForHamburger(page);

    // 步骤 1：开抽屉。
    await page.locator('[data-testid="sidebar-toggle"]').click();
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeVisible();

    // 步骤 2：点 settings-button → TokenModal closable 打开 +
    // 抽屉自动收起（openSettingsAndCloseDrawer W1 互斥）。
    await page.locator('[data-testid="settings-button"]').click();

    // 断言：token-modal 出现 + 抽屉 backdrop 已收起（互斥落定）。
    await expect(page.locator('[data-testid="token-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="token-modal-close"]')).toBeVisible();
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeHidden();

    // 步骤 3：按 Esc → token-modal 关闭恰好一次（Trap active
    // listener 唯一触发）。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="token-modal"]')).toBeHidden();

    // 断言 Esc 没有连带关其他 trap：抽屉 backdrop 仍为 hidden
    // （关闭后无副作用再触发 setSidebarOpen(false)→true 翻转）。
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeHidden();

    // 断言 TokenModal 关闭后 settings-button 可再次打开（验证
    // 不是「Esc 关后 state 锁死」）。
    await page.locator('[data-testid="sidebar-toggle"]').click();
    await expect(page.locator('[data-testid="sidebar-backdrop"]')).toBeVisible();
    await page.locator('[data-testid="settings-button"]').click();
    await expect(page.locator('[data-testid="token-modal"]')).toBeVisible();
    // 关闭收尾。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="token-modal"]')).toBeHidden();
  });
});

// ===========================================================================
// Desktop viewport — ≥768px 零回归抽查（mobile-only testid 泄漏守门）
// ===========================================================================

test.describe('scenario (desktop ≥768 viewport): mobile-only testid 零回归', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('11. 桌面端 0 个 sidebar-toggle + 0 个 mobile-top-bar（mobile-only testid 不泄漏）', async ({ page }) => {
    const state = await readRunState();

    await seedToken(page, state.baseUrl, state.token);
    await waitForLevel1(page);

    // 桌面端 level1 视图：sidebar 常驻（grid 槽位）+ 不渲染
    // MobileTopBar + 不渲染汉堡。
    expect(await page.locator('[data-testid="sidebar-toggle"]').count()).toBe(0);
    expect(await page.locator('[data-testid="mobile-top-bar"]').count()).toBe(0);
    // sidebar 自身可见（grid 槽位常驻，非 drawer）。
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    // sidebar-backdrop 不渲染（桌面无 drawer）。
    expect(await page.locator('[data-testid="sidebar-backdrop"]').count()).toBe(0);

    // 桌面端 app-sidebar inert 属性应为 false（不挂 inert——
    // sidebar 常驻可交互）。
    const asideInert = await page.evaluate(() => {
      const aside = document.getElementById('app-sidebar');
      return aside?.inert ?? null;
    });
    expect(asideInert, 'desktop app-sidebar should NOT have inert=true (sidebar is always interactive)').toBe(false);
  });
});
