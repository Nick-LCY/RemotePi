// AppShell — the top-level layout container for the M5
// double-column workspace (M5 §第二块 G5 / D8 / 任务 06 §a).
//
// ## Layout
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
// The grid is `grid-template-columns: var(--sidebar-width) 1fr`
// (D8 — sidebar 280px on desktop, full-width slot on mobile
// after task 07 introduces the drawer; this task does NOT add
// the drawer — `sidebarOpen`/`onToggle` are reserved props for
// task 07 to wire without re-architecting this layout).
//
// ## Why AppShell does NOT own gateMapRef / handleRefill
//
// M4 task 08 / 验收期 4th gap 修复 (commit `264cefc`) lifts the
// gate map + the stem-refilled `handleRefill` callback into App
// level — the watcher requires App-level closure stability so
// `useCallback` deps don't churn and the watcher doesn't re-attach
// mid-flight (which would drop the session_state event between
// unsubscribe and resubscribe, losing the stem refill). Moving
// those refs into AppShell would move the watcher into AppShell
// too, which would break the M4 4th-gap fix's invariant. **AppShell
// is purely a layout container** — all state stays in App.
//
// ## props
//
//   - `gateMapRef` / `client` — pass-through to `RecoveryShell` so
//     the gate map stays owned by App.
//   - `sidebarOpen` / `onToggle` — reserved for task 07 (mobile
//     drawer). `sidebarOpen` is currently a no-op render prop
//     (defaults `true` for desktop); `onToggle` defaults to a
//     no-op stub. Task 07 reads `matchMedia('(max-width:
//     767px)')` to flip the prop and adds the drawer backdrop.
//   - `mainContent` — the right-rail content (ChoicePage /
//     ChatView / RecoveryView / etc.).
//
// ## Tailwind only
//
// New file — Tailwind utilities only (task 04 已就绪：bg-bg /
// text-text / border-border 等已映射到 13 存量 CSS var via
// `@theme inline` 块 — D11 落地后所有新组件走 Tailwind，存量
// 1280 行不触碰）。

import type { ReactNode } from 'react';

import type { WsClient } from '../ws/WsClient.js';
import type { RecoveryGate } from '../ws/recovery.js';

import { Sidebar } from './Sidebar.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppShellProps {
  /** WebSocket client. Created once in App (useMemo) and passed
   *  through. */
  client: WsClient;
  /** Per-session RecoveryGate map (M4 task 08 / 4th gap fix).
   *  Owned by App level — AppShell only forwards it to
   *  `RecoveryShell`. */
  gateMapRef: { current: Map<string, RecoveryGate> | null };
  /** Right-rail content — the App layer passes `<RecoveryShell>`,
   *  `<ChoicePage level={1} />`, etc. */
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
  } = props;

  return (
    <div
      className="grid h-screen w-screen"
      style={{ gridTemplateColumns: 'var(--sidebar-width) 1fr' }}
      data-testid="app-shell"
    >
      <Sidebar
        currentSession={currentSession}
        currentWorkDir={currentWorkDir}
        view={view}
        onSettingsClick={onSettingsClick}
        onBrowseWorkDirsClick={onBrowseWorkDirsClick}
      />
      <main
        className="flex h-full flex-col gap-3 overflow-y-auto bg-bg p-4"
        data-testid="app-shell-main"
      >
        {mainContent}
      </main>
    </div>
  );
}
