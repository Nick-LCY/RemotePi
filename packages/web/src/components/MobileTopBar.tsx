// MobileTopBar — M5 task 07 gap fix (commit `a6fd9ef` 后).
//
// ## Why this component exists
//
// M5 task 07 commit `a6fd9ef` 落地汉堡按钮 (sidebar-toggle testid)
// 仅位于 `SessionStatusBar` 左侧。但 `SessionStatusBar` 只在
// recovery 分支挂载（`App.tsx` 中 `sessionForSessionBar !== null`
// 才渲染）→ **移动端 <768px 在 choiceLevel1 / choiceLevel2 视图
// 下没有入口打开抽屉** → 用户无法选择工作目录 / 会话，
// 功能性死路。
//
// 修法：本组件提供 mobile-only top bar（含汉堡 + 视图标题），
// 在 `App.tsx` 内按 view 分派——
//   - `view === 'recovery'` → 渲染 `<SessionStatusBar>`
//     （既有路径，含汉堡 + phase + queue + session 名）；
//   - `view === 'choiceLevel1' || 'choiceLevel2'` → 渲染
//     `<MobileTopBar>`（本组件）。
//
// 两者**互斥**渲染（按 view 分派），共享同一个 `hamburgerRef`
// `useRef` 实例（`App.tsx` 持有 + 透传）—— focus 归还永远指向
// 当前可见的那个汉堡按钮。
//
// ## 渲染策略
//
// `useIsMobile()` 内置判定：
//   - desktop (≥768px)：返回 `null`，不参与 DOM（不动桌面端布局）；
//   - mobile (<768px)：渲染 hamburger + view title。
//
// AppShell 的 grid 模板在 mobile 下是 `1fr` 单列——本组件
// 是 right-rail 第一行（位于 mainContent 顶部，与既有
// SessionStatusBar 位置对齐）。
//
// ## testid
//
//   - `mobile-top-bar`           — 根容器（M5 task 07 新增 testid；
//     任务 06 brief 明示「新组件新 testid 不计入本约束」）。
//   - `sidebar-toggle`           — 汉堡按钮（与 SessionStatusBar
//     复用同一 testid；render by view 分派保证 per view 唯一
//     渲染实例）。
//
//   「testid 零增零删」约束：本组件不删除任何既有 testid；新增
//   testid（mobile-top-bar）显式标注为 M5 task 07 新增，
//   走既有「新组件新 testid」惯例。`sidebar-toggle` 复用既有，
//   不视为新增。
//
// ## Tailwind only
//
// 新组件——Tailwind utilities only（task 04 已就绪：
// `bg-surface` / `text-text` / `border-border` 等已映射到 13
// 存量 CSS var via `@theme inline` 块）。本组件无 module.css，
// 无新 CSS 规则引入。

import type { RefObject } from 'react';

import { useIsMobile } from '../hooks/useIsMobile.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MobileTopBarProps {
  /** 视图标题——level1 显「选择工作目录」，level2 显「选择会话」。
   *  Mobile 顶栏右侧仅显示该文字（与 SessionStatusBar 把 session
   *  名放在汉堡右侧的布局对齐）。 */
  title: string;
  /** 抽屉是否已展开。`isMobile === false` 时忽略。传入供按钮
   *  aria-label 动态切换（展开 → "关闭侧边栏"，收起 →
   *  "打开侧边栏"）。 */
  sidebarOpen?: boolean;
  /** 汉堡按钮 click 回调（移动端）。`isMobile === false` 时
   *  按钮不渲染。 */
  onToggleSidebar?: () => void;
  /** 汉堡按钮 ref——抽屉关闭时 `AppShell` 的 `useFocusTrap` 调
   *  `returnFocusRef.focus()` 归还焦点至此按钮。仅移动端使用；
   *  桌面端忽略。本 ref **与 SessionStatusBar 共享同一对象**
   *  （App 层持有 → 透传），ref.current 永远指向当前可见
   *  汉堡按钮（recovery → SessionStatusBar / level1+2 →
   *  MobileTopBar）。 */
  hamburgerRef?: RefObject<HTMLButtonElement>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MobileTopBar(props: MobileTopBarProps): JSX.Element | null {
  const {
    title,
    sidebarOpen = false,
    onToggleSidebar,
    hamburgerRef,
  } = props;
  const isMobile = useIsMobile();

  // 桌面端不渲染——保持桌面布局（无顶栏）与 pre-fix 一致；
  // App.tsx 的 mainContent 槽位里本组件 conditional mount
  // 不会被 main grid 触达。
  if (!isMobile) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded border border-border bg-surface px-3 py-2 text-sm"
      data-testid="mobile-top-bar"
      data-view-title={title}
    >
      {/* 汉堡按钮——与 SessionStatusBar 内的汉堡按钮同 testid
          `sidebar-toggle`。两组件按 view 分派，互斥渲染：
          App.tsx 同一时刻只挂载一个，故 e2e selector
          `page.locator('[data-testid="sidebar-toggle"]')` 在
          移动端始终命中唯一实例。
          aria-label 动态切换 + aria-controls 指向 AppShell 内
          `<aside id="app-sidebar">`；data-open 反映抽屉状态。 */}
      <button
        ref={hamburgerRef}
        type="button"
        aria-label={sidebarOpen ? '关闭侧边栏' : '打开侧边栏'}
        aria-expanded={sidebarOpen}
        aria-controls="app-sidebar"
        onClick={onToggleSidebar}
        className="-ml-1 inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-bg text-text hover:bg-surface"
        data-testid="sidebar-toggle"
        data-open={sidebarOpen ? 'true' : 'false'}
      >
        {/* Simple hamburger icon — three horizontal bars.
            Inline SVG keeps it self-contained (no asset path
            to manage). aria-label already conveys semantic so
            aria-hidden on the SVG. 与 SessionStatusBar 内的
            SVG 保持一致——视觉外观统一。 */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <line x1="2" y1="4" x2="14" y2="4" />
          <line x1="2" y1="8" x2="14" y2="8" />
          <line x1="2" y1="12" x2="14" y2="12" />
        </svg>
      </button>

      {/* 视图标题——仅 mobile 渲染。Tailwind utility: text-text
          font-semibold + 截断 ellipsis（防御极长 title）。 */}
      <span
        className="min-w-0 flex-1 truncate font-semibold text-text"
        data-testid="mobile-top-bar-title"
      >
        {title}
      </span>
    </div>
  );
}