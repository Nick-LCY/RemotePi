// Sidebar — persistent left-rail navigation surface.
//
// ## Layout (top → bottom)
//
//   1. **Brand slot** — `<h1>RemotePi</h1>`.
//   2. **Tabs row** — `[Sessions] [WorkDirs]`. The active tab is
//      internal state (not written to the URL); the initial value
//      is decided by the parent's view prop — `choiceLevel1` →
//      WorkDirs; everything else → Sessions.
//   3. **List slot** — Sessions tab renders the current
//      work_dir's sessions; WorkDirs tab renders the saved
//      work_dirs list. Both read from the WsClient store via
//      the existing `useSessionList` / `useWorkDirs` hooks.
//   4. **Footer** — `<BridgeStatusBar>` (compact) +
//      `<button>Settings</button>` (`settings-button` testid).
//      Settings opens `<TokenModal closable>` for token rotation.
//
// The list lives in the Sidebar (not in ChoicePage) so the user
// can navigate sessions without leaving the chat surface — the
// sidebar is the view, the hash is the truth.
//
// testid inventory:
//   - `sidebar` / `sidebar-tabs` / `sidebar-tab-sessions` /
//     `sidebar-tab-work-dirs` / `settings-button` — new.
//   - The session row / work-dir-row / etc. anchors are reused
//     from the legacy ChoicePage so e2e selectors continue to
//     match.

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

/** Which tab the sidebar is currently showing. The active tab
 *  is internal state — the URL hash doesn't carry a tab
 *  discriminator (sidebar is a view, hash is the navigation
 *  truth). */
type SidebarTab = 'sessions' | 'work-dirs';

/** Default active tab for a given App view. `choiceLevel1` →
 *  `'work-dirs'` (the user's next step is picking a directory);
 *  every other view → `'sessions'`. Pure function — extracted
 *  from the Sidebar render path so the view-sync logic can be
 *  unit-tested without a DOM / React reconciler. */
export function defaultTabForView(
  view: 'choiceLevel1' | 'choiceLevel2' | 'recovery',
): SidebarTab {
  return view === 'choiceLevel1' ? 'work-dirs' : 'sessions';
}

/** Props the App layer wires up. */
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

/** Background colour class per session status. Mirrors the legacy
 *  `.choice-page-row-status.status-${value}` rules that were
 *  deleted in M6 T02's styles.css contraction. The mapping table
 *  matches the pre-T02 colours 1-for-1 (running #e69138,
 *  idle --state-online, spawning --state-connecting,
 *  exited --state-offline, unknown --muted) so the visual stays
 *  identical pre/post migration. */
const SESSION_STATUS_CLASS: Record<SessionListEntry['status'], string> = {
  running: 'bg-[#e69138]',
  idle: 'bg-state-online',
  spawning: 'bg-state-connecting',
  exited: 'bg-state-offline',
  unknown: 'bg-muted',
};

/** session_list / work_dir_list watchdogs — same 5s ceiling as
 *  the legacy ChoicePage level=2 / level=1 timeouts. */
const SESSION_LIST_TIMEOUT_MS = 5_000;
const WORK_DIR_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Sidebar(props: SidebarProps): JSX.Element {
  const { currentSession, currentWorkDir, view, onSettingsClick, onBrowseWorkDirsClick } = props;
  // Active tab — internal state; default comes from the view.
  const [activeTab, setActiveTab] = useState<SidebarTab>(() =>
    defaultTabForView(view),
  );

  // Sync activeTab to view transitions: a user who lands on
  // choiceLevel1 (default tab = WorkDirs) and then picks a
  // work_dir → view flips to choiceLevel2 — without this effect
  // activeTab would stay at 'work-dirs' and the user would see
  // the WorkDirsTab content while the right rail shows the
  // level=2 panel + sessions header. Same-view tab clicks stay
  // free (the user can flip tabs inside choiceLevel2 to glance
  // at the WorkDirsTab without leaving the view).
  useEffect(() => {
    setActiveTab(defaultTabForView(view));
  }, [view]);

  return (
    <aside
      className="flex h-full w-[var(--sidebar-width)] flex-col gap-3 border-r border-border bg-surface p-3"
      data-testid="sidebar"
      data-active-tab={activeTab}
    >
      <div className="flex items-center justify-between">
        <h1
          className="m-0 text-lg font-semibold tracking-tight text-text"
          data-testid="brand"
        >
          RemotePi
        </h1>
      </div>

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

  // Refresh session_list on:
  //   - mount (initial fetch),
  //   - connState transition (retry after reconnect),
  //   - workDir change (user picked a new directory at level=1).
  // Returning from ChatView re-mounts the Sidebar, which re-fires
  // the effect — no explicit refetch needed there.
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

  if (currentWorkDir === null) {
    return (
      <div className="flex flex-col gap-2 text-sm text-muted" data-testid="sidebar-sessions-empty-no-workdir">
        <p>尚未选择工作目录。请切换到 WorkDirs 标签浏览添加。</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
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
          className="m-0 rounded border border-state-offline bg-state-offline/[0.08] px-3 py-2 text-xs text-state-offline"
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
                    // The legacy `.choice-page-row-status.status-${entry.status}`
                    // CSS rules painted each running / idle / spawning /
                    // exited / unknown state with a tinted bg. With
                    // those rules gone, the same paint is now an inline
                    // Tailwind class per status. Mapping mirrors the
                    // legacy 5-value table verbatim so e2e + screenshot
                    // parity is preserved (D8).
                    className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase text-white ${SESSION_STATUS_CLASS[entry.status]}`}
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

  // Refresh work_dir_list on:
  //   - mount (initial fetch),
  //   - connState transition (retry after reconnect),
  //   - post-add (fired explicitly in App.tsx `onAdded` — the one
  //     place that knows an add just landed),
  //   - post-remove (inline in `handleRemove` below).
  //
  // The list is GLOBAL — not scoped to the current work_dir — so
  // there's no refetch on `currentWorkDir` change.
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
  }, [client, connState]);

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
      if (currentWorkDir === path) {
        window.location.hash = changeWorkDirHash();
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {removeError !== null ? (
        <p
          className="m-0 rounded border border-state-offline bg-state-offline/[0.08] px-3 py-2 text-xs text-state-offline"
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