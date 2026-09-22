// Sidebar — persistent left-rail navigation surface.
//
// ## Layout (top → bottom) — M6 T04 reference 重做
//
// Container chrome (300px wide, rounded-2xl, shadow-sm, border,
// bg-surface, p-3) is provided by AppShell (T03). The Sidebar
// itself only paints the inner surface:
//
//   1. **Brand slot** — 72px row (T04 D5):
//      - Left: size-9 rounded-xl deep slate square with Terminal icon.
//      - Right: two-line block — "RemotePi" (text-sm font-semibold
//        tracking-tight, var(--text)) + "远程开发工作台" (text-[11px],
//        var(--muted-4)).
//      - Mobile-only: right-aligned X button that calls `onClose`
//        (the App layer wires this to set sidebarOpen=false).
//      - Border-bottom hairline (var(--border-3)) for visual
//        separation from the body content.
//   2. **Tabs row** — `[Sessions] [WorkDirs]`. Active tab is
//      internal state (not written to the URL); the initial value
//      is decided by the parent's view prop — `choiceLevel1` →
//      WorkDirs; everything else → Sessions. Per-view sync via
//      useEffect (M5 W3).
//   3. **List slot** — Sessions tab renders the current
//      work_dir's sessions; WorkDirs tab renders the saved
//      work_dirs list. Both read from the WsClient store via
//      the existing `useSessionList` / `useWorkDirs` hooks.
//      Both tabs share the "分组标题" header pattern (T04 §4):
//      11px uppercase tracking-[0.12em] color var(--muted-4).
//   4. **Footer** — `<BridgeStatusBar>` (compact three-node card)
//      + `<button>Settings</button>` (`settings-button` testid).
//      Settings opens `<TokenModal closable>` for token rotation.
//
// The list lives in the Sidebar (not in ChoicePage) so the user
// can navigate sessions without leaving the chat surface — the
// sidebar is the view, the hash is the truth.
//
// ## M6 T04 changes
//
//   - **lucide-react introduced** (D3). Hamburger SVG in
//     `MobileTopBar.tsx` and `SessionStatusBar.tsx` retired in
//     favour of `<Menu />` / `<X />`. Terminal / Plus / FolderOpen /
//     Folder / ChevronDown / Globe2 / Server / Bot / Settings
//     land as Sidebar / BridgeStatusBar icons.
//   - **Brand 双行块** — replaces the legacy M5 single-line
//     `<h1>RemotePi</h1>` with the 72px-deep reference block
//     (size-9 rounded-xl 深石板方块 + 双行文字).
//   - **session row + work-dir row reference 形态** — T03 container
//     rounded-xl + token-driven active state (bg-surface-2 for
//     active sessions, bg-accent-soft + text-accent for the active
//     work_dir — D5 tokenised high-contrast highlight).
//   - **分组标题** — 11px uppercase tracking-[0.12em] token-driven
//     text color.
//   - **BridgeStatusBar reference「远端连接」卡** — three-node
//     Globe → Server → Bot with state-driven paint + emerald
//     connect line + animate-ping heartbeat on online. See
//     `BridgeStatusBar.tsx` for the implementation.
//
// testid inventory:
//   - `sidebar` / `sidebar-tabs` / `sidebar-tab-sessions` /
//     `sidebar-tab-work-dirs` / `settings-button` — preserved.
//   - `brand` — preserved (decoration container wrapping the
//     Terminal icon + 双行文字; renders Terminal icon node now).
//   - The session row / work-dir-row / etc. anchors are reused
//     from the legacy ChoicePage so e2e selectors continue to
//     match.

import { useEffect, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  Folder,
  FolderOpen,
  Plus,
  Settings,
  Terminal,
  X,
} from 'lucide-react';
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
  /** Mobile-only close button (right side of brand row, lg:hidden).
   *  App wires this to set sidebarOpen=false. Undefined on
   *  desktop (no-op) so the Sidebar stays view-agnostic. */
  onClose?: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Background + foreground colour class per session status.
 *  Mirrors the legacy `.choice-page-row-status.status-${value}`
 *  rules that were deleted in M6 T02's styles.css contraction.
 *
 *  M6 T09 (D7 / 状态色 token 化收尾): the previous `running: 'bg-[#e69138]'`
 *  hard-coded hex was the last non-tokenised status colour in the
 *  table. T07 introduced the `--amber` / `--amber-soft` family for
 *  the select-dialog tinted icon block; T09 routes `running` through
 *  the same token (`bg-amber`) so the visual language stays
 *  consistent across Sidebar / SessionStatusBar / select dialog.
 *  All other statuses already mapped to state-* / muted tokens
 *  since T02.
 *
 *  M6 T11 (G13 dark contrast WCAG AA): every coloured pill is
 *  paired with the matching `--on-*` text token so dark mode
 *  clears WCAG AA — `--on-amber` / `--on-online` /
 *  `--on-offline` are deep ink colours (light mode `#ffffff`
 *  keeps the visual identical to T01-T09 baseline). The
 *  `spawning` / `unknown` grey pills stay text-white
 *  (borderline in dark mode but not in the T11 three-edge
 *  list). */
const SESSION_STATUS_CLASS: Record<SessionListEntry['status'], string> = {
  running: 'bg-amber text-on-amber',
  idle: 'bg-state-online text-on-online',
  spawning: 'bg-state-connecting text-white',
  exited: 'bg-state-offline text-on-offline',
  unknown: 'bg-muted text-white',
};

/** session_list / work_dir_list watchdogs — same 5s ceiling as
 *  the legacy ChoicePage level=2 / level=1 timeouts. */
const SESSION_LIST_TIMEOUT_MS = 5_000;
const WORK_DIR_TIMEOUT_MS = 5_000;

/** Shared label for the group titles (D5 / §4 of task brief).
 *  Applied to BOTH tabs so the visual language matches the
 *  reference. The text content differs per tab; this constant
 *  captures the layout token (uppercase + tracking + colour +
 *  font-size) so both call sites stay in sync. */
const GROUP_TITLE_CLASS = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-4';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Sidebar(props: SidebarProps): JSX.Element {
  const {
    currentSession,
    currentWorkDir,
    view,
    onSettingsClick,
    onBrowseWorkDirsClick,
    onClose,
  } = props;
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
      {/* Brand row — 72px deep, h-[72px], border-b border-border-3
          hairline. Two children: (left) Terminal icon block +
          双行文字; (right) mobile-only X close button.
          The `lg:hidden` class on the close button follows the
          AppShell drawer wiring — desktop renders no X because
          the sidebar is permanently in the grid; mobile renders
          the X so the user can dismiss the drawer without
          tapping the backdrop. The X button is a *visual*
          element only; its testid surface stays at the drawer
          level (`sidebar-backdrop` / `sidebar-toggle`) so we
          don't add new testid anchors here (D6 zero-add). */}
      <div
        className="flex h-[72px] shrink-0 items-center justify-between gap-3 border-b border-border-3 px-5"
        data-testid="brand"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div
            // Terminal icon block — deep slate square + white
            // Terminal icon. Deep colour mirrors the reference's
            // #17202b exactly; tokenised via bg-deep (T03) so
            // light / dark mode both render the same ink
            // (`--deep` keeps the same hex in light mode and
            // lifts slightly in dark mode for the T03 scrim
            // contrast).
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-deep text-white"
          >
            <Terminal className="size-4" aria-hidden="true" focusable="false" />
          </div>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-semibold tracking-tight text-text">
              RemotePi
            </span>
            <span className="truncate text-[11px] text-muted-4">
              远程开发工作台
            </span>
          </div>
        </div>
        {onClose !== undefined ? (
          <button
            type="button"
            aria-label="关闭侧边栏"
            onClick={onClose}
            // M6 T11 — keyboard focus-visible ring 2px / accent-ring
            // with 1px surface offset so the close X button is
            // perceivable when the user tabs to it (mobile
            // drawer focus trap). Hover paint (text-muted-4 +
            // bg-surface-2) stays so the visual identity with
            // the rest of the brand chrome is preserved.
            className="-mr-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-4 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface lg:hidden"
          >
            <X className="size-4" aria-hidden="true" focusable="false" />
          </button>
        ) : null}
      </div>

      {/* Tabs row — horizontal [Sessions] [WorkDirs]. Kept the
          M5 tab mechanism + testids because (a) data-active-tab
          is part of the e2e contract and (b) the same-view tab
          click → setActiveTab flow stays free per M5 W3.
          visual升级: 用 GROUP_TITLE_CLASS 形式的字号 + padding
          而非 M5 的浅底 chip — 但 tab 形态保留（任务文件未强制
          用 reference 的「分组标题替代 tabs」）。 */}
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
          // M6 T11 — focus-visible ring 2px / accent-ring / 1px
          // surface offset for keyboard tab navigation between
          // the two sidebar tabs.
          className={`flex-1 rounded px-2 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface ${
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
          className={`flex-1 rounded px-2 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface ${
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

      {/* List slot — tab dispatch. padding bumped to px-2 + py-4
          to align content with the reference's grouping rhythm
          (px-5 brand row → px-2 content rows keeps the visual
          margin inset consistent). */}
      <div className="flex-1 overflow-y-auto px-2 py-4">
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

      {/* Footer — BridgeStatusBar + settings button. gap-2
          matches the reference's spacing between the two cards. */}
      <div className="flex flex-col gap-2">
        <BridgeStatusBar />
        <button
          type="button"
          onClick={onSettingsClick}
          // M6 T11 — focus-visible ring 2px / accent-ring / 1px
          // surface offset for keyboard navigation to the
          // settings button (the last tabable in the sidebar
          // footer before the bridge status card).
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-muted hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
          data-testid="settings-button"
          aria-label="设置 — 更换访问令牌"
        >
          <Settings className="size-4" aria-hidden="true" focusable="false" />
          <span>设置</span>
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
      <div
        className="flex flex-col gap-2 text-sm text-muted"
        data-testid="sidebar-sessions-empty-no-workdir"
      >
        <p>尚未选择工作目录。请切换到 WorkDirs 标签浏览添加。</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Group title — 11px uppercase tracking-[0.12em]. */}
      <div
        className={`flex items-center justify-between px-2 ${GROUP_TITLE_CLASS}`}
      >
        <span>对话</span>
        {/* New-session button hidden in the title row — kept as
            the explicit 「新建会话」 button below for testid
            stability (`session-new` zero-add). The Plus icon is
            rendered as part of the button label so the visual
            identifier stays with the action. */}
      </div>

      <button
        type="button"
        onClick={handleNew}
        // M6 T11 — focus-visible ring 2px / accent-ring / 1px
        // surface offset on the 「新建会话」 button (first
        // focusable after the sidebar tabs when Sessions is
        // active).
        className="flex items-center justify-center gap-1.5 rounded-xl bg-accent-soft px-3 py-2.5 text-sm font-medium text-accent hover:bg-accent-soft/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
        data-testid="session-new"
      >
        <Plus className="size-3.5" aria-hidden="true" focusable="false" />
        <span>新建会话</span>
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
        <ul className="flex flex-col gap-1" data-testid="session-list">
          {sessionList.map((entry: SessionListEntry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => handleSelect(entry.id)}
                // M6 T11 — focus-visible ring 2px / accent-ring /
                // 1px surface offset so the keyboard tab path
                // through the session list lands on a perceivable
                // ring at every row (e2e 09 spec asserts the sidebar
                // tab path cycles focus inside the drawer — the ring
                // is the visual confirmation for that path).
                className={`flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface ${
                  currentSession === entry.id
                    ? 'bg-surface-2 text-text'
                    : 'text-muted hover:bg-surface-2'
                }`}
                data-testid="session-row"
                data-session={entry.id}
                data-active={currentSession === entry.id}
                data-status={entry.status}
              >
                <span
                  // The legacy `.choice-page-row-status.status-${entry.status}`
                  // CSS rules painted each running / idle / spawning /
                  // exited / unknown state with a tinted bg. With
                  // those rules gone, the same paint is now an inline
                  // Tailwind class per status. Mapping mirrors the
                  // legacy 5-value table verbatim so e2e + screenshot
                  // parity is preserved (D8). M6 T11 drops the base
                  // `text-white` — every SESSION_STATUS_CLASS entry
                  // pairs its bg with the matching `text-on-*` token
                  // (or text-white for the borderline grey states)
                  // so dark mode clears WCAG AA contrast.
                  className={`mt-1 inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase ${SESSION_STATUS_CLASS[entry.status]}`}
                  data-testid="session-row-status"
                  data-status={entry.status}
                >
                  {entry.status}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-xs text-muted" data-testid="session-row-time">
                    {entry.created}
                  </span>
                  <span
                    className="truncate text-sm font-medium"
                    data-testid="session-row-first"
                  >
                    {entry.first_message ?? '（无首条消息）'}
                  </span>
                </span>
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
      {/* Group title — same 11px uppercase tracking as sessions. */}
      <div className={`px-2 ${GROUP_TITLE_CLASS}`}>
        <span>工作目录</span>
      </div>

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
        <ul className="flex flex-col gap-1" data-testid="work-dir-list">
          {workDirs.map((path) => {
            const isActive = currentWorkDir === path;
            return (
              <li key={path}>
                {/* Active work-dir highlight: accent-soft tint +
                    accent-coloured text. Inactive: muted text,
                    no background; hover lifts to surface-2. The
                    visual hierarchy matches the reference's
                    "current directory" block. The FolderOpen
                    icon on active rows replaces Folder on
                    inactive rows to give the active row an
                    extra identity cue (mirrors the reference's
                    open-folder vs closed-folder signal). */}
                <div
                  className={`group flex items-center gap-2 rounded-xl px-3 py-2.5 ${
                    isActive
                      ? 'bg-accent-soft text-accent'
                      : 'text-muted hover:bg-surface-2'
                  }`}
                  data-testid="work-dir-row"
                  data-path={path}
                  data-active={isActive}
                >
                  {isActive ? (
                    <FolderOpen
                      className="size-4 shrink-0"
                      aria-hidden="true"
                      focusable="false"
                    />
                  ) : (
                    <Folder
                      className="size-4 shrink-0"
                      aria-hidden="true"
                      focusable="false"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => handleSelect(path)}
                    // M6 T11 — focus-visible ring 2px / accent-ring
                    // / 1px surface offset for keyboard navigation
                    // through the work-dir list rows.
                    className="min-w-0 flex-1 truncate text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
                    data-testid="work-dir-select"
                    data-path={path}
                  >
                    {path}
                  </button>
                  {isActive ? (
                    <ChevronDown
                      className="size-3.5 shrink-0 opacity-60"
                      aria-hidden="true"
                      focusable="false"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleRemove(path)}
                      disabled={removingPath === path}
                      // M6 T11 — focus-visible ring 2px / accent-ring
                      // / 1px surface offset on the × remove button
                      // so keyboard users can perceive + activate
                      // the destructive action (the ring colour
                      // mirrors the rest of the chrome; the action
                      // itself stays opt-in via keyboard
                      // confirmation in DialogHost).
                      className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-surface disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
                      data-testid="work-dir-remove"
                      data-path={path}
                      aria-label={`移除工作目录 ${path}`}
                    >
                      {removingPath === path ? '…' : '×'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={onOpenBrowser}
        // M6 T11 — focus-visible ring 2px / accent-ring / 1px
        // surface offset on the 「浏览添加」 button (last focusable
        // in the WorkDirs tab — keyboard users tabbing through
        // the list land on this as the terminal action).
        className="flex items-center justify-center gap-1.5 rounded-xl bg-surface-2 px-3 py-2.5 text-sm font-medium text-text hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
        data-testid="work-dir-browse"
      >
        <FolderOpen className="size-3.5" aria-hidden="true" focusable="false" />
        <span>浏览添加</span>
      </button>
    </div>
  );
}

