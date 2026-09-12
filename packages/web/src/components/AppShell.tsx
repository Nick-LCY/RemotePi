// AppShell — the top-level layout container for the M5
// double-column workspace (M5 §第二块 G5 / D8 / 任务 06 §a + 任务
// 07 §b §c 移动端抽屉装配)。
//
// ## Layout — desktop (>=768px)
//
// ```
// ┌─────────────────────────────────────────────────────────┐
// │ ┌─────────────┐ ┌─────────────────────────────────────┐ │
// │ │  Sidebar    │ │  Main                                │ │
// │ │  ┌────────┐ │ │  ┌───────────────────────────────┐  │ │
// │ │  │ brand  │ │ │  │ SessionStatusBar (本 session)   │  │ │
// │ │  └────────┘ │ │  └───────────────────────────────┘  │ │
// │ │  ┌────────┐ │ │  ┌───────────────────────────────┐  │ │
// │ │  │ tabs   │ │ │  │ ChatView / ChoiceLevel{1,2}   │  │ │
// │ │  └────────┘ │ │  │ Panel / RecoveryView          │  │ │
// │ │  ┌────────┐ │ │  └───────────────────────────────┘  │ │
// │ │  │ list   │ │ │                                     │ │
// │ │  └────────┘ │ │                                     │ │
// │ │  ┌────────┐ │ │                                     │ │
// │ │  │footer  │ │ │                                     │ │
// │ │  └────────┘ │ │                                     │ │
// │ └─────────────┘ └─────────────────────────────────────┘ │
// └─────────────────────────────────────────────────────────┘
// ```
//
// 桌面布局 `grid-template-columns: var(--sidebar-width) 1fr`
// (D8 — sidebar 280px on desktop)；sidebar 常驻网格第一列。
//
// ## Layout — mobile (<768px, M5 task 07)
//
// ```
// ┌─────────────────────────────────────────────────────────┐
// │   ┌───────────────────────────────────────────────────┐ │
// │   │  Main                                              │ │
// │   │  ┌────────────────────┐                            │ │
// │   │  │ SessionStatusBar   │  ← hamburger 在最左         │ │
// │   │  ├────────────────────┤                            │ │
// │   │  │ ChatView           │                            │ │
// │   │  └────────────────────┘                            │ │
// │   └───────────────────────────────────────────────────┘ │
// │                          ↑                              │
// │             抽屉展开时侧滑 drawer (z=200) + backdrop (z=199) │
// └─────────────────────────────────────────────────────────┘
// ```
//
// 移动端 `grid-template-columns: 1fr`——sidebar 槽位移出 grid
// （脱离文档流），改 `position: fixed` + `translate-x` 过渡：
//
//   - 收起：`translate-x(-100%)`（隐藏在屏外）；
//   - 展开：`translate-x(0)` + backdrop 半透黑 + `backdrop-filter: blur(4px)`；
//
// z-index 栈：D12 — `toast(100) < sidebar(200) < dialog-host(300) < token-modal(400)`。
// backdrop 位于 sidebar 之下：`z-[199]`。
//
// ## 移动端装配要点（任务 07 brief §c + 任务 08 review W1）
//
//   - **汉堡按钮** ——位于 `SessionStatusBar` 行左侧（仅移动端
//     渲染；aria-label + aria-expanded + aria-controls）。
//   - **body 滚动锁** ——抽屉展开时 `document.body.style.overflow
//     = 'hidden'`；收起还原（cleanup 安全——保存 prev 值 + 恢复）。
//   - **hashchange 自动收起** ——监听 hash 变化 → 抽屉收起 + 焦点
//     归还。`useEffect` deps：`[isMobile, onCloseSidebar]`，mount-once
//     监听器，`isMobile === false` 时不挂。
//   - **焦点陷阱** ——抽屉展开时 `useFocusTrap` active；收起时焦点
//     归还 `returnFocusRef`（汉堡按钮 ref）。
//   - **桌面端不受影响** ——isMobile false 时 backdrop 不渲染、汉堡
//     不渲染、sidebar 常驻。
//   - **inert attribute（任务 08 review W1）**——移动端收起态
//     `<aside>` 挂 `inert` 属性（property 方式赋值——见下方
//     effect）。inert 是 HTML 布尔属性，浏览器解析为「子树不可
//     交互（鼠标 / 键盘 / 读屏）」，拦截屏外 sidebar 按钮接收
//     Tab 焦点（e2e 09 spec §断言 4 W1 钉桩）。React 18.3.1 未
//     把 `inert` 列入 known boolean 属性列表，传 `inert={true}`
//     会序列化为 `inert="true"`（HTML 布尔属性 spec 非法值，
//     浏览器容忍但 Safari / 旧 Chrome 可能不识别），故用 ref
//     property 赋值保证跨浏览器一致。
//
// ## Why AppShell is purely a layout container
//
// M4 task 08 / 验收期 4th gap 修复 (commit `264cefc`) lifts the
// gate map + the stem-refilled `handleRefill` callback into App
// level — the watcher requires App-level closure stability so
// `useCallback` deps don't churn and the watcher doesn't re-attach
// mid-flight (which would drop the session_state event between
// unsubscribe and resubscribe, losing the stem refill). AppShell
// has NO `client` / `gateMapRef` props — the gate map and the
// WsClient both live in App, and `<RecoveryShell>` is rendered
// by App directly inside `mainContent`. AppShell's job ends at
// "lay out [sidebar | mainContent] in a grid" + mobile drawer
// glue (which is purely view-layer + no client/gate knowledge).
//
// ## Props
//
//   - `mainContent` — the right-rail content (ChoicePage /
//     ChatView / RecoveryView / etc.). Already wired by App:
//     App composes `<SessionStatusBar>` + `<RecoveryShell>` /
//     `<ChoiceLevel{1,2}Panel>` and passes the fragment as
//     `mainContent`. AppShell doesn't need (or want) access to
//     the WsClient or the gate map to do its layout job.
//   - Sidebar session-state props — current session (or null) +
//     work_dir (or null) + current view (drives default tab).
//   - `onSettingsClick` / `onBrowseWorkDirsClick` — Sidebar
//     dispatches these up to App (which owns the TokenModal
//     closable state + the DirectoryBrowser modal slot).
//   - M5 task 07 — mobile drawer state:
//     - `sidebarOpen` — `true` when drawer should be expanded.
//     - `onCloseSidebar` — backdrop click / Escape / hashchange
//       close handler. Always passed; desktop path is no-op.
//     - `hamburgerRef` — `useFocusTrap` 的 returnFocus 目标。
//
// ## Tailwind only
//
// New file — Tailwind utilities only (task 04 已就绪：bg-bg /
// text-text / border-border 等已映射到 13 存量 CSS var via
// `@theme inline` 块 — D11 落地后所有新组件走 Tailwind，存量
// 1280 行不触碰）。

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

import { Sidebar } from './Sidebar.js';
import { useFocusTrap } from '../hooks/useFocusTrap.js';
import { useIsMobile } from '../hooks/useIsMobile.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** 任务 08 review W1 inert 计算——pure helper，便于无 jsdom 单测。
 *
 *  行为：
 *   - `isMobile === false`（桌面端）→ `false`（不挂 inert）——桌面
 *     sidebar 常驻 grid 槽位，用户理应能 Tab 进入。
 *   - `isMobile === true && sidebarOpen === false`（移动收起）→
 *     `true`（挂 inert）——sidebar 屏外，拦截 Tab 焦点进入。
 *   - `isMobile === true && sidebarOpen === true`（移动展开）→
 *     `false`（不挂 inert）——抽屉展开用户应能 Tab 进 sidebar。
 *
 *  抽为 pure 函数：renderToStaticMarkup 路径下 useEffect 不跑，
 *  单元测试需在 SSR HTML 里验证逻辑而非真挂 DOM 属性。e2e 09
 *  spec §断言 4 W1 钉桩走真浏览器读 `el.inert` property 验证。
 */
export function computeInert(isMobile: boolean, sidebarOpen: boolean): boolean {
  return isMobile && !sidebarOpen;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppShellProps {
  /** Right-rail content — the App layer composes a fragment of
   *  `<SessionStatusBar>` + `<RecoveryShell>` / `<ChoiceLevel{
   *  1,2}Panel>` and passes it here. AppShell does NOT touch the
   *  WsClient or the gate map — those live in App, and the
   *  right-rail components that need them are wired by App
   *  directly. */
  mainContent: ReactNode;
  /** Sidebar session-state props — current session (or null) +
   *  work_dir (or null) + current view (drives default tab). */
  currentSession: string | null;
  currentWorkDir: string | null;
  view: 'choiceLevel1' | 'choiceLevel2' | 'recovery';
  /** Sidebar → settings button click (TokenModal closable). */
  onSettingsClick: () => void;
  /** Sidebar → WorkDirs tab → 浏览添加 (DirectoryBrowser modal). */
  onBrowseWorkDirsClick: () => void;
  // -------- M5 task 07 移动端抽屉状态 --------
  /** 抽屉展开状态。`isMobile === false` 时忽略；桌面 sidebar
   *  常驻不依赖此值。 */
  sidebarOpen: boolean;
  /** 抽屉关闭回调（backdrop click / Escape / hashchange）。
   *  `isMobile === false` 时不调用。 */
  onCloseSidebar: () => void;
  /** 汉堡按钮 ref——`useFocusTrap` 在抽屉关闭（active true→false）
   *  时调用 `returnFocusRef.focus()` 归还焦点。App 层持 ref 并
   *  传给 `SessionStatusBar` 与 `AppShell` 共享同一 ref 对象。 */
  hamburgerRef?: RefObject<HTMLButtonElement>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AppShell(props: AppShellProps): JSX.Element {
  const {
    mainContent,
    currentSession,
    currentWorkDir,
    view,
    onSettingsClick,
    onBrowseWorkDirsClick,
    sidebarOpen,
    onCloseSidebar,
    hamburgerRef,
  } = props;
  const isMobile = useIsMobile();

  // 容器 ref：给 useFocusTrap 用。mount 后 ref.current 是 <aside> 元素；
  // 移动端 drawer 模式下即为抽屉 DOM。
  const sidebarRef = useRef<HTMLElement | null>(null);

  // -------- body 滚动锁（任务 07 §c）--------
  // 抽屉展开时锁 body 滚动；收起还原（cleanup 安全——保存原值 + 恢复）。
  useEffect(() => {
    if (!isMobile) return undefined;
    if (!sidebarOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isMobile, sidebarOpen]);

  // -------- hashchange 自动收起（任务 07 §c）--------
  // 监听 hash 变化 → 抽屉收起。mount-once 注册（isMobile 翻转
  // false→true 时补挂，true→false 时 cleanup 注销）。依赖：
  // `[isMobile, onCloseSidebar]`——onCloseSidebar 是 App 层 useCallback
  // 包装（identity stable）；isMobile 翻转时 effect 重跑。
  useEffect(() => {
    if (!isMobile) return undefined;
    const onHashChange = (): void => {
      onCloseSidebar();
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [isMobile, onCloseSidebar]);

  // -------- inert attribute（任务 08 review W1）--------
  // 移动端收起态 `<aside>` 设 inert=true（property 方式赋值——
  // 见文件 header §移动端装配要点）。React 18.3.1 已知 boolean
  // 属性列表不含 inert（源码 cjs/react-dom.development.js
  // setValueForProperty: known properties branch + generic
  // `setAttribute(name, '' + value)` branch），故传 `inert={true}`
  // 会序列化为 `inert="true"`，spec 非法（HTML 布尔属性仅接受
  // 空串 / canonical name），Chrome 当前容忍但 Safari 不识别。
  // 用 ref property 赋值跨浏览器一致。effect deps `[isMobile,
  // sidebarOpen]` 保证两态翻转同步。桌面端 isMobile === false
  // → effect 内 inert = false（即使初始 HTML 序列化已写
  // `inert="false"`，property false 显式复位）。
  //
  // **Effect 顺序约束**：此 effect 必须**早于**下方 `useFocusTrap`
  // 的 focusFirstIn effect 触发——抽屉展开（sidebarOpen false→true）
  // 时，前一帧 inert=true 状态会保留到当前帧 effect 跑完才被改写；
  // 若 inert=true 时 focusFirstIn 调 `first.focus()`，按 HTML spec
  // inert 子树不可接收 focus（包括程序化 focus），焦点实际不
  // 移动（activeElement 仍为 hamburger）。先清 inert 再调
  // focusFirstIn 才能正常进 sidebar。React useEffect 触发顺序按
  // 声明顺序——故 inert effect 必须在 useFocusTrap 之前声明。
  //
  // `computeInert` 抽为 pure helper（详见函数定义）——便于无
  // jsdom 单测（`renderToStaticMarkup` 不跑 effect；e2e 09 spec
  // 走真浏览器钉 property 生效）。
  useEffect(() => {
    const el = sidebarRef.current;
    if (el === null) return;
    el.inert = computeInert(isMobile, sidebarOpen);
  }, [isMobile, sidebarOpen]);

  // -------- 焦点陷阱（任务 07 §c）--------
  // 移动端 + 抽屉展开 → active；Escape 触发 onCloseSidebar。
  // 关闭时（active true→false）useFocusTrap 自动归还焦点到
  // hamburgerRef（汉堡按钮）——见 useFocusTrap header。
  //
  // **Effect 顺序约束**（配合上方 inert effect）：active 翻转
  // false→true 时 useFocusTrap 调 `focusFirstIn(sidebarRef)`。
  // inert 属性若此时仍 true（因 inert effect 还未跑），focus()
  // 对 inert 子树无效（spec：「If the new focus target is in
  // an inert subtree, do nothing else」）。故 inert effect 必须
  // 先于本 hook 跑——见上方 inert effect 注释。
  useFocusTrap({
    active: isMobile && sidebarOpen,
    containerRef: sidebarRef,
    onEscape: isMobile ? onCloseSidebar : undefined,
    returnFocusRef: hamburgerRef,
  });

  // 桌面 grid 模板：sidebar 列 + main 列。
  // 移动 grid 模板：仅 main（sidebar 改 fixed 不占 grid）。
  const gridStyle = {
    gridTemplateColumns: isMobile ? '1fr' : 'var(--sidebar-width) 1fr',
  };

  // Sidebar 容器 className：桌面 = grid 槽位常驻；移动端 = fixed
  // 抽屉 + translate-x 过渡。
  //   - 默认（收起）：`-translate-x-full`（屏外）；
  //   - 展开：`translate-x-0`（屏内）；
  //   - z-[200]（D12 栈）。
  //   - `pointer-events-none` 在收起时让 backdrop 也能接收点击
  //     （抽屉本身不可点）；展开时还原。
  const asideClass = isMobile
    ? `fixed inset-y-0 left-0 z-[200] flex h-full w-[var(--sidebar-width)] flex-col gap-3 border-r border-border bg-surface p-3 transition-transform duration-200 ease-in-out ${
        sidebarOpen ? 'translate-x-0' : '-translate-x-full pointer-events-none'
      }`
    : 'flex h-full w-[var(--sidebar-width)] flex-col gap-3 border-r border-border bg-surface p-3';

  return (
    <div
      className="grid h-screen w-screen"
      style={gridStyle}
      data-testid="app-shell"
      data-sidebar-open={sidebarOpen ? 'true' : 'false'}
    >
      {/* Sidebar — 桌面网格槽位；移动端 fixed 抽屉。
          M5 task 07 — `id="app-sidebar"` 供汉堡按钮 aria-controls 引用。
          M5 task 08 review W1 — `inert` 由上方的 `useEffect`（ref
          property 方式）动态设置；不在此处写 JSX attribute（理由：
          React 18.3.1 不识别 inert 布尔属性，写 `inert={true}` 会
          序列化为 `inert="true"` spec 非法）。e2e 09 spec 通过
          `document.querySelector(...).inert` 读 property 钉桩
          （见 spec §断言 4 W1 钉桩）。
          注意：外层 <aside> **不**挂 `data-testid="sidebar"`——该 testid
          由内部 Sidebar 组件挂载（既有约束「testid 零增零删」），外层
          重复挂载会破坏 e2e 锚点单元素定位。 */}
      <aside
        ref={sidebarRef}
        id="app-sidebar"
        className={asideClass}
        data-open={sidebarOpen ? 'true' : 'false'}
        aria-hidden={isMobile && !sidebarOpen ? 'true' : 'false'}
      >
        <Sidebar
          currentSession={currentSession}
          currentWorkDir={currentWorkDir}
          view={view}
          onSettingsClick={onSettingsClick}
          onBrowseWorkDirsClick={onBrowseWorkDirsClick}
        />
      </aside>

      {/* Backdrop — 仅移动端 + 抽屉展开时渲染。
          z-[199]（D12 栈 sidebar 之下）。点击关闭抽屉。
          w-screen + h-screen 显式尺寸：纯 `<button>` 元素无 content
          时 + `position: fixed` + `inset-0` 的组合，某些浏览器
          会把 shrink-to-fit width 算为 0（CSS 规格：fixed 元素
          的 auto width = shrink-to-fit），导致 Playwright
          toBeVisible 判 hidden。显式 w-screen/h-screen 钉柜尺寸
          与 inset-0 一致——视觉 + a11y 双满足。 */}
      {isMobile && sidebarOpen ? (
        <button
          type="button"
          aria-label="关闭侧边栏"
          data-testid="sidebar-backdrop"
          onClick={onCloseSidebar}
          className="fixed inset-0 z-[199] h-screen w-screen cursor-default border-0 bg-black/40 backdrop-blur-sm"
          style={{ padding: 0 }}
        />
      ) : null}

      <main
        className="flex h-full flex-col gap-3 overflow-y-auto bg-bg p-4"
        data-testid="app-shell-main"
      >
        {mainContent}
      </main>
    </div>
  );
}