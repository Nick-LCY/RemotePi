// Sidebar — persistent left-rail navigation surface (M5 §第二块
// G5 / D8 / 任务 06 §a).
//
// ## Layout (top → bottom)
//
//   1. **Brand slot** — `<h1>RemotePi</h1>` migrated from the
//      old App-level `<main className="app-shell">` top.
//   2. **Tabs row** — `[Sessions] [WorkDirs]`. The active tab
//      is internal `useState` (per task brief: "active tab
//      内部 useState，不写 URL"); the initial value is decided
//      by the parent's view prop — choiceLevel1 → WorkDirs (the
//      user has no work_dir yet so the natural next step is
//      browsing directories); everything else → Sessions
//      (default per D8).
//   3. **List slot** — Sessions tab renders the current
//      work_dir's sessions; WorkDirs tab renders the saved
//      work_dirs list. The list data sources come from the
//      WsClient store via the existing hooks (no new store
//      slice; sidebar reads everything off the existing
//      SessionBucket mirrors).
//   4. **Footer** — `<BridgeStatusBar>` (compact) +
//      `<button>Settings</button>` (`settings-button` testid).
//      Settings opens `<TokenModal closable>` for token
//      rotation (M5 §D10 closable mode).
//
// ## Why the list lives here (and not in ChoicePage)
//
// M4 ChoicePage level=2 rendered its own session list; M5 task
// 06 splits the list render into the sidebar — the ChoicePage
// panels (`ChoiceLevel1Panel` / `ChoiceLevel2Panel`) only carry
// the header copy + empty-state CTA + an open-modal handle. This
// avoids duplicate data fetching (the WsClient store is the
// single source; both surfaces read the same `useSessionList` /
// `useWorkDirs` hook) and lets the user navigate sessions
// without leaving the chat surface (釘子 6 — sidebar is the
// view, hash is the truth).
//
// ## testid inventory (new — task 06 §a specifies "新组件新
// testid 不计入本约束")
//
//   - `sidebar`                  — the root `<aside>`.
//   - `sidebar-tabs`             — the tabs row.
//   - `sidebar-tab-sessions`     — the Sessions tab button.
//   - `sidebar-tab-work-dirs`    — the WorkDirs tab button.
//   - `settings-button`          — Settings button in the footer.
//
// ## Legacy testid reuse
//
// The session row / work-dir-row / work-dir-list / etc. anchors
// from the M4 ChoicePage are reused here so e2e 01 / 04 / 07 specs
// continue to work without spec changes — the anchor selectors
// match both the ChoicePage-mount path (pre-task-06) and the
// Sidebar-mount path (post-task-06). The data-testid inventory
// grep must remain zero-add/zero-del for these legacy anchors
// (testid list baseline from task 06 brief).
//
// ## Tailwind only
//
// New component — Tailwind utilities only (task 04 已就绪：
// `bg-bg` / `text-text` / `border-border` / `text-muted` /
// `bg-surface` 等已映射到 13 存量 CSS var via `@theme inline`
// 块 — D11 落地后所有新组件走 Tailwind，存量 1280 行不触碰）。

import { useEffect, useState, type ReactNode } from 'react';
import type { SessionListEntry } from '@remotepi/shared';

import {
  changeWorkDirHash,
  newSessionHash,
  selectSessionHash,
  selectWorkDirHash,
} from '../hash.js';
import {
  useConnState,
  useSessionList,
  useWorkDirs,
} from '../ws/WsClientContext.js';
import { useWsClient } from '../ws/WsClientContext.js';

import { BridgeStatusBar } from './BridgeStatusBar.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which tab the sidebar is currently showing. The active tab is
 *  internal state — the URL hash doesn't carry a tab discriminator
 *  (D13: 「交互细节默认」 — sidebar is a view, hash is the navigation
 *  truth). */
type SidebarTab = 'sessions' | 'work-dirs';

/** Props the App layer wires up. App owns the gateMapRef /
 *  handleRefill / sessionKey so the sidebar can stay pure
 *  (no App-level refs leak through). */
export interface SidebarProps {
  /** Active session (or 'new' / null for level=2 / M3_LEGACY).
   *  Used to highlight the current session row. */
  currentSession: string | null;
  /** Current work_dir (or null for level=1). */
  currentWorkDir: string | null;
  /** The view the App is currently rendering — drives the
   *  default tab on mount. `choiceLevel1` → WorkDirs; everything
   *  else → Sessions. */
  view: 'choiceLevel1' | 'choiceLevel2' | 'recovery';
  /** Open the TokenModal in closable mode (settings button). */
  onSettingsClick: () => void;
  /** Open the DirectoryBrowser modal (WorkDirs tab → 浏览添加). */
  onBrowseWorkDirsClick: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SESSION_LIST_TIMEOUT_MS — 5s. Mirrors the ChoicePage level=2
 *  watchdog (tasks/m4/07 §钉子 5 — session_list 超时未回执视为
 *  bridge 离线). */
const SESSION_LIST_TIMEOUT_MS = 5_000;

/** WORK_DIR_TIMEOUT_MS — 5s. Mirror of ChoicePage level=1
 *  watchdog (tasks/m4/07 §钉子 5 — work_dir_list 超时未回执视为
 *  bridge 离线). */
const WORK_DIR_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Sidebar(props: SidebarProps): JSX.Element {
  const { currentSession, currentWorkDir, view, onSettingsClick, onBrowseWorkDirsClick } = props;
  // active tab — internal useState (per task brief). Default
  // 由 view 决定：choiceLevel1 → WorkDirs (next step); 其余 → Sessions.
  const [activeTab, setActiveTab] = useState<SidebarTab>(
    view === 'choiceLevel1' ? 'work-dirs' : 'sessions',
  );

  return (
    <aside
      className="flex h-full w-[var(--sidebar-width)] flex-col gap-3 border-r border-border bg-surface p-3"
      data-testid="sidebar"
      data-active-tab={activeTab}
    >
      {/* Brand slot — moved from App's <main className="app-shell">
          top. `data-testid="brand"` is the new testid (task 06
          §a "新组件新 testid 不计入本约束"). */}
      <div className="flex items-center justify-between">
        <h1
          className="m-0 text-lg font-semibold tracking-tight text-text"
          data-testid="brand"
        >
          RemotePi
        </h1>
      </div>

      {/* Tabs row */}
      <div
        className="flex gap-1 rounded border border-border bg-bg p-1"
        data-testid="sidebar-tabs"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'sessions'}
          onClick={() => setActiveTab('sessions')}
          className={`flex-1 rounded px-2 py-1 text-sm font-medium transition-colors ${
            activeTab === 'sessions'
              ? 'bg-surface text-text shadow-sm'
              : 'text-muted hover:text-text'
          }`}
          data-testid="sidebar-tab-sessions"
          data-active={activeTab === 'sessions'}
        >
          Sessions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'work-dirs'}
          onClick={() => setActiveTab('work-dirs')}
          className={`flex-1 rounded px-2 py-1 text-sm font-medium transition-colors ${
            activeTab === 'work-dirs'
              ? 'bg-surface text-text shadow-sm'
              : 'text-muted hover:text-text'
          }`}
          data-testid="sidebar-tab-work-dirs"
          data-active={activeTab === 'work-dirs'}
        >
          WorkDirs
        </button>
      </div>

      {/* List slot — 列表数据从 WsClient bucket 读，与 ChoicePage
          panels 同源。Active tab 切换不重查数据（数据独立于 tab）；
          mount + workDir 变化触发查询。 */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'sessions' ? (
          <SessionsTab
            currentSession={currentSession}
            currentWorkDir={currentWorkDir}
          />
        ) : (
          <WorkDirsTab
            currentWorkDir={currentWorkDir}
            onOpenBrowser={onBrowseWorkDirsClick}
          />
        )}
      </div>

      {/* Footer — bridge status (compact) + settings button */}
      <div className="flex flex-col gap-2">
        <BridgeStatusBar />
        <button
          type="button"
          onClick={onSettingsClick}
          className="rounded border border-border bg-surface px-3 py-1.5 text-left text-sm text-text hover:bg-bg"
          data-testid="settings-button"
          aria-label="设置 — 更换访问令牌"
        >
          ⚙ 设置
        </button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// SessionsTab — list of sessions under the current work_dir.
// ---------------------------------------------------------------------------

interface SessionsTabProps {
  currentSession: string | null;
  currentWorkDir: string | null;
}

function SessionsTab({ currentSession, currentWorkDir }: SessionsTabProps): ReactNode {
  const client = useWsClient();
  const connState = useConnState();
  const sessionList = useSessionList();
  const [error, setError] = useState<string | null>(null);

  // 钉子 5 — level=2 列表刷新时机移植到 Sidebar：
  //   - mount 时查询一次（首次 mount 触发）
  //   - workDir 变化时重查（user 切目录 → hash 翻 → workDir 变）
  //   - 从 ChatView 退回时重查（App.tsx 的 render 分支变化保证
  //     Sidebar 是新 mount——本 effect 重新触发）
  //   - 不轮询
  useEffect(() => {
    setError(null);
    if (connState !== 'online') return;
    if (currentWorkDir === null) return;
    const id = client.sendSessionList(currentWorkDir);
    let unsub: (() => void) | null = null;
    const watchdog = setTimeout(() => {
      unsub?.();
      setError('session_list 超时未回执 — bridge 可能离线');
    }, SESSION_LIST_TIMEOUT_MS);
    unsub = client.registerReplyResolver(id, () => {
      clearTimeout(watchdog);
    });
    return () => {
      clearTimeout(watchdog);
      unsub?.();
    };
  }, [client, connState, currentWorkDir]);

  const handleSelect = (sessionKey: string): void => {
    if (currentWorkDir === null) return;
    window.location.hash = selectSessionHash(currentWorkDir, sessionKey);
  };

  const handleNew = (): void => {
    if (currentWorkDir === null) return;
    window.location.hash = newSessionHash(currentWorkDir);
  };

  // No work_dir yet — Sessions tab is non-applicable. The empty
  // state guides the user to the WorkDirs tab to pick a directory.
  if (currentWorkDir === null) {
    return (
      <div className="flex flex-col gap-2 text-sm text-muted" data-testid="sidebar-sessions-empty-no-workdir">
        <p>尚未选择工作目录。请切换到 WorkDirs 标签浏览添加。</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* New-session button — 顶部 CTA，与 M4 ChoicePage level=2
          既有「新建会话」语义对齐。 */}
      <button
        type="button"
        onClick={handleNew}
        className="rounded border border-border bg-accent px-3 py-1.5 text-left text-sm text-white hover:bg-accent/90"
        data-testid="session-new"
      >
        ＋ 新建会话
      </button>

      {error !== null ? (
        <p
          className="rounded border border-state-offline px-3 py-2 text-xs text-state-offline"
          style={{ backgroundColor: 'rgba(192, 57, 43, 0.08)' }}
          role="alert"
          data-testid="sidebar-sessions-error"
        >
          {error}
        </p>
      ) : null}

      {sessionList === null ? (
        <p className="px-1 text-xs text-muted" data-testid="sidebar-sessions-loading">
          加载会话列表…
        </p>
      ) : sessionList.length === 0 ? (
        <p className="px-1 text-xs text-muted" data-testid="session-list-empty">
          该目录下暂无会话。点击「新建会话」创建第一个会话。
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="session-list">
          {sessionList.map((entry: SessionListEntry) => (
            <li
              key={entry.id}
              className={`flex flex-col gap-1 rounded border px-2 py-1.5 text-sm transition-colors ${
                currentSession === entry.id
                  ? 'border-accent bg-bg'
                  : 'border-border bg-surface hover:bg-bg'
              }`}
              data-testid="session-row"
              data-session={entry.id}
              data-active={currentSession === entry.id}
              data-status={entry.status}
            >
              <button
                type="button"
                onClick={() => handleSelect(entry.id)}
                className="flex flex-col items-start gap-1 text-left"
                data-testid="session-select"
                data-session={entry.id}
              >
                <div className="flex w-full items-center gap-2 text-[0.72rem] text-muted">
                  <span data-testid="session-row-time">{entry.created}</span>
                  <span
                    className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase text-white status-${entry.status}`}
                    data-testid="session-row-status"
                    data-status={entry.status}
                  >
                    {entry.status}
                  </span>
                </div>
                <div className="w-full truncate text-xs text-text" data-testid="session-row-first">
                  {entry.first_message ?? '（无首条消息）'}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkDirsTab — list of saved work_dirs + browse button.
// ---------------------------------------------------------------------------

interface WorkDirsTabProps {
  currentWorkDir: string | null;
  /** Sidebar doesn't own the DirectoryBrowser modal — the parent
   *  (App) holds the open state. The Sidebar only renders the
   *  「浏览添加」 button; clicking it dispatches a callback
   *  that flips the parent's `browserOpen` state to true. */
  onOpenBrowser: () => void;
}

function WorkDirsTab({ currentWorkDir, onOpenBrowser }: WorkDirsTabProps): ReactNode {
  const client = useWsClient();
  const connState = useConnState();
  const workDirs = useWorkDirs();
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removingPath, setRemovingPath] = useState<string | null>(null);

  // Mount-time fetch — mirrors ChoiceLevel1Panel mount effect.
  // Also re-fires on `currentWorkDir` change (hash navigation
  // between work_dirs triggers a fresh fetch — the persistent
  // sidebar doesn't unmount on view branches, so the dep list
  // explicitly includes currentWorkDir to cover "user picks a
  // new work_dir → list of all work_dirs may have grown via
  // a DirectoryBrowser add → re-fetch to mirror the new state").
  useEffect(() => {
    setRemoveError(null);
    if (connState !== 'online') return;
    const id = client.sendWorkDirList();
    let unsub: (() => void) | null = null;
    const watchdog = setTimeout(() => {
      unsub?.();
      // Silent timeout — same rationale as ChoiceLevel1Panel.
    }, WORK_DIR_TIMEOUT_MS);
    unsub = client.registerReplyResolver(id, () => {
      clearTimeout(watchdog);
    });
    return () => {
      clearTimeout(watchdog);
      unsub?.();
    };
  }, [client, connState, currentWorkDir]);

  const handleSelect = (path: string): void => {
    window.location.hash = selectWorkDirHash(path);
  };

  const handleRemove = (path: string): void => {
    setRemoveError(null);
    setRemovingPath(path);
    const id = client.sendWorkDirRemove(path);
    let unsub: (() => void) | null = null;
    const watchdog = setTimeout(() => {
      unsub?.();
      setRemovingPath(null);
      setRemoveError('work_dir_remove 超时未回执 — bridge 可能离线');
    }, WORK_DIR_TIMEOUT_MS);
    unsub = client.registerReplyResolver(id, (env) => {
      clearTimeout(watchdog);
      setRemovingPath(null);
      if (env.kind !== 'control' || env.type !== 'result') return;
      if (env.payload.ok !== true) {
        const err = env.payload.error;
        setRemoveError(
          `移除失败（${err?.code ?? 'unknown'}）：${err?.message ?? 'unknown error'}`,
        );
        return;
      }
      client.sendWorkDirList();
      // 防御性：若被删的是当前 work_dir，跳回 level=1。
      if (currentWorkDir === path) {
        window.location.hash = changeWorkDirHash();
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {removeError !== null ? (
        <p
          className="rounded border border-state-offline px-3 py-2 text-xs text-state-offline"
          style={{ backgroundColor: 'rgba(192, 57, 43, 0.08)' }}
          role="alert"
          data-testid="choice-page-remove-error"
        >
          {removeError}
        </p>
      ) : null}

      {workDirs.length === 0 ? (
        <p className="px-1 text-xs text-muted" data-testid="work-dir-empty">
          暂无保存的工作目录。请通过下方「浏览添加」按钮选择一个目录。
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="work-dir-list">
          {workDirs.map((path) => (
            <li
              key={path}
              className={`flex items-center gap-1 rounded border px-2 py-1.5 ${
                currentWorkDir === path
                  ? 'border-accent bg-bg'
                  : 'border-border bg-surface'
              }`}
              data-testid="work-dir-row"
              data-path={path}
              data-active={currentWorkDir === path}
            >
              <button
                type="button"
                onClick={() => handleSelect(path)}
                className="flex-1 truncate text-left text-sm text-text"
                data-testid="work-dir-select"
                data-path={path}
              >
                <code>{path}</code>
              </button>
              <button
                type="button"
                onClick={() => handleRemove(path)}
                disabled={removingPath === path}
                className="rounded border border-border bg-surface px-2 py-0.5 text-[0.7rem] text-text hover:bg-bg disabled:opacity-50"
                data-testid="work-dir-remove"
                data-path={path}
              >
                {removingPath === path ? '…' : '×'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={onOpenBrowser}
        className="rounded border border-border bg-surface px-3 py-1.5 text-left text-sm text-text hover:bg-bg"
        data-testid="work-dir-browse"
      >
        📁 浏览添加
      </button>
    </div>
  );
}
