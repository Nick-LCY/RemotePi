// SessionStatusBar — the per-session status row at the top of the
// chat surface (M5 §第二块 G5 / D8 / 任务 06 §a).
//
// The bar repackages three pieces of per-session state —
// phase badge + queue pills + session name — into a single
// horizontal row that sits above the MessageList. The bridge
// status (previously on the chat surface via the old `<StatusBar>`)
// has moved to the sidebar footer (`<BridgeStatusBar>`); this
// component is the "本 session 状态" surface only.
//
// ## M5 task 07 — mobile hamburger (D12 / G7)
//
// On viewport `< 768px` the sidebar collapses into a drawer
// (see `AppShell.tsx` mobile drawer mode). The hamburger button
// to open / toggle the drawer lives **on the left of this row**
// (per PRD §D12 「汉堡按钮位置：移动端 SessionStatusBar 左侧」
// + task 07 brief §c)。桌面（≥768px）不渲染汉堡按钮（sidebar
// 在 grid 槽位常驻）。
//
//   - `sidebar-toggle` testid — 移动端专属，桌面 render null。
//   - `aria-label="打开侧边栏"` / `"关闭侧边栏"` 由调用方控制。
//   - 按钮 click 触发 `onToggleSidebar` 回调（App 层持有
//     `sidebarOpen` state）；AppShell 内 `useFocusTrap` 在抽屉
//     关闭时调用 `returnFocusRef.focus()`（即此按钮的 ref）归还
//     焦点。
//
// ## Data sources
//
// All three sub-pieces reuse existing store hooks:
//
//   - **Phase badge** — `useSessionPhaseFor(sessionKey)` — the
//     same five-value enum (`running` / `idle` / `spawning` /
//     `exited` / `unknown`) that `PhaseIndicator` (ChatView) used
//     to render as its own row. M5 task 06 复用数据源，但
//     PhaseIndicator 组件本体保留（`ChatView.tsx` 仍 mount 一个
//     隐藏 PhaseIndicator 为 a11y 兜底——见 ChatView 改动）。
//
//   - **Queue pills** — `useQueueFor(sessionKey)` returns the
//     `{steering, followUp}` counts; `QueueIndicator` (ChatView)
//     rendered this as its own footer row. Same data, repackaged
//     into the bar.
//
//   - **Session name** — when `sessionKey === 'new'` (pending —
//     first prompt hasn't derived the real stem yet), the bar
//     shows the literal "**新会话**" copy (M4 ChoicePage level=2
//     既有渲染对齐); otherwise it shows the stem itself (e.g.
//     `sess-2026-09-11-XYZ`)。
//
// ## testid
//
//   - `session-status-bar` — the root container. e2e specs that
//     need to assert "the chat surface is showing a session row"
//     can poll this anchor. New testid — NOT in the legacy
//     zero-add/zero-del inventory (which covers the
//     `message-*` / `input-*` / `bridge-status` / `recovery-*` /
//     `choice-page-*` / `work-dir-*` / `session-row` / etc.
//     set). M5 task 06 §a specifies "新组件新 testid 不计入本
//     约束".
//   - `sidebar-toggle` — **new in M5 task 07** — 仅移动端渲染。
//     新组件新 testid，**不**计入「既有 testid 零增零删」约束
//     （与 `sidebar-backdrop` 同列——task 07 brief §c 明示）。
//
// ## Tailwind only
//
// New component — Tailwind utilities only (task 04 已就绪：
// `bg-bg` / `text-text` / `border-border` / `text-muted` 等
// 已映射到 13 存量 CSS var via `@theme inline` 块）。

import type { SessionPhase } from '@remotepi/shared';
import type { RefObject } from 'react';

import { useQueueFor, useSessionPhaseFor } from '../ws/WsClientContext.js';
import { useIsMobile } from '../hooks/useIsMobile.js';

interface SessionStatusBarProps {
  /** Session key. M3-compat: `M3_LEGACY_KEY` for the legacy
   *  token-only path; `'new'` for the pending branch (bar
   *  displays "**新会话**"); any other stem for in-session. */
  session: string;
  /** 抽屉是否已展开。`isMobile === false` 时忽略。传入供按钮
   *  aria-label 动态切换（展开 → "关闭侧边栏"，收起 →
   *  "打开侧边栏"）。 */
  sidebarOpen?: boolean;
  /** 汉堡按钮 click 回调（移动端）。`isMobile === false` 时
   *  按钮不渲染。 */
  onToggleSidebar?: () => void;
  /** 汉堡按钮 ref——抽屉关闭时 `AppShell` 的 `useFocusTrap` 调
   *  `returnFocusRef.focus()` 归还焦点至此按钮。仅移动端使用；
   *  桌面端忽略。 */
  hamburgerRef?: RefObject<HTMLButtonElement>;
}

// ---------------------------------------------------------------------------
// Phase presentation (mirrors PhaseIndicator's 5-state mapping)
// ---------------------------------------------------------------------------

/** Background-colour class for each phase — mirrors the legacy
 *  `.phase-{value}` rules in styles.css. `null` falls back to
 *  `phase-unknown` (the muted grey). */
const PHASE_CLASS: Record<NonNullable<SessionPhase>, string> = {
  spawning: 'bg-state-connecting',
  ready: 'bg-accent',
  running: 'bg-state-offline', // amber-ish in legacy CSS; sidebar mode keeps the offline tint as a "working" signal
  idle: 'bg-state-online',
  exited: 'bg-state-offline',
};

function phaseLabel(phase: SessionPhase | null): string {
  if (phase === null) return 'unknown';
  return phase;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SessionStatusBar(props: SessionStatusBarProps): JSX.Element {
  const { session, sidebarOpen = false, onToggleSidebar, hamburgerRef } = props;
  const phase = useSessionPhaseFor(session);
  const queue = useQueueFor(session);
  const steeringCount = queue.steering.length;
  const followUpCount = queue.followUp.length;
  const totalQueue = steeringCount + followUpCount;
  const isMobile = useIsMobile();

  // `session === 'new'` → 显示「**新会话**」(M4 ChoicePage
  // level=2 既有 'new' 渲染对齐); 其他 → 显示 stem 本身。
  // M3-compat（M3_LEGACY_KEY）显示「M3 旧链接会话」 — 与既有
  // 命名风格保持一致。
  const sessionLabel = session === 'new'
    ? '新会话'
    : session === 'm3-legacy'
      ? 'M3 旧链接会话'
      : session;

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded border border-border bg-surface px-3 py-2 text-sm"
      data-testid="session-status-bar"
      data-session={session}
      data-phase={phase ?? 'unknown'}
    >
      {/* M5 task 07 — mobile-only hamburger button. Lives on the
          LEFT of the row per PRD §D12 / task 07 brief §c. Desktop
          (>=768px) renders nothing here so the layout matches
          the pre-task-07 baseline (session-status-bar flex children
          flow unchanged). The button reads `data-open` so e2e 09
          spec (task 08) can assert "drawer toggle button reflects
          current drawer state". */}
      {isMobile ? (
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
              aria-hidden on the SVG. */}
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
      ) : null}

      {/* Session name — 显式区分 'new' 路径 */}
      <span className="font-semibold text-text" data-testid="session-status-bar-name">
        {sessionLabel}
      </span>

      {/* Phase badge — 五态 + null(unknown) */}
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.72rem] font-semibold text-white ${
          phase === null ? 'bg-muted' : PHASE_CLASS[phase]
        }`}
        data-testid="session-status-bar-phase"
        data-phase={phase ?? 'unknown'}
      >
        {phaseLabel(phase)}
      </span>

      {/* Queue pills — steering + follow_up. Hidden when both are
          zero so the bar doesn't get cluttered during a normal
          chat session (queue pills are a "user has pending
          steering" signal, not a default-on indicator). */}
      {totalQueue > 0 ? (
        <div
          className="flex flex-wrap items-center gap-2 text-muted"
          data-testid="session-status-bar-queue"
        >
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs"
            data-testid="session-status-bar-queue-steering"
            data-count={steeringCount}
          >
            steering: <strong className="text-text">{steeringCount}</strong>
          </span>
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs"
            data-testid="session-status-bar-queue-follow-up"
            data-count={followUpCount}
          >
            follow-up: <strong className="text-text">{followUpCount}</strong>
          </span>
        </div>
      ) : null}
    </div>
  );
}