// AppShell — top-level layout container for the double-column workspace.
//
// ## Layout — desktop (>=768px)
//
// Two-column grid: `grid-template-columns: var(--sidebar-width) 1fr`.
// Sidebar lives permanently in the first column; main in the second.
//
// ## Layout — mobile (<768px)
//
// Single-column grid (`grid-template-columns: 1fr`). The sidebar
// moves out of the grid into a fixed drawer (`position: fixed` +
// `translate-x` transition); a backdrop overlays the rest of the
// screen when expanded.
//
// z-index stack: `toast(100) < sidebar(200) < dialog-host(300) <
// token-modal(400)`. Backdrop sits below the sidebar at `z-[199]`.
//
// ## Mobile drawer wiring
//
//   - Hamburger button in `SessionStatusBar` (mobile only;
//     aria-label + aria-expanded + aria-controls).
//   - body scroll lock while the drawer is open (restores the
//     prior `overflow` value on cleanup).
//   - hashchange auto-close — `useEffect` listens for hash changes
//     and closes the drawer.
//   - `useFocusTrap` active while the drawer is open; Escape
//     closes it; focus is restored to the hamburger on close.
//   - `inert` attribute on the `<aside>` while the drawer is
//     closed on mobile — keeps the off-screen sidebar buttons
//     from receiving Tab focus. Applied via ref property rather
//     than JSX attribute because React 18.3.1 does not list
//     `inert` in its known boolean properties (would serialise
//     to `inert="true"`, an illegal HTML boolean attribute value
//     that some browsers don't honour). Effect ordering: this
//     `inert` effect must run BEFORE the `useFocusTrap` effect on
//     the same commit — focus into an `inert` subtree is a no-op
//     per the HTML spec.
//
// ## Why AppShell is purely a layout container
//
// The per-session gate map and the stem-refilled `handleRefill`
// callback live in the App component (not AppShell). The
// stem-refilled watcher requires App-level closure stability so
// its `useCallback` deps don't churn — re-attaching mid-flight
// would drop a session_state event between unsubscribe and
// resubscribe, losing the stem refill. AppShell has no `client` /
// `gateMapRef` props; it only knows how to lay out `[sidebar |
// mainContent]` and wire the mobile drawer.

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

import { Sidebar } from './Sidebar.js';
import { useFocusTrap } from '../hooks/useFocusTrap.js';
import { useIsMobile } from '../hooks/useIsMobile.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Compute whether the sidebar should carry `inert` to keep
 *  off-screen buttons out of the Tab order. Pure function so it
 *  can be tested without jsdom (the `useEffect` doesn't run under
 *  `renderToStaticMarkup`; the SSR HTML + the inert property on
 *  the real DOM element are exercised separately). */
export function computeInert(isMobile: boolean, sidebarOpen: boolean): boolean {
  return isMobile && !sidebarOpen;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppShellProps {
  /** Right-rail content — App composes a fragment of
   *  `<SessionStatusBar>` + `<RecoveryShell>` /
   *  `<ChoiceLevel{1,2}Panel>` and passes it here. AppShell
   *  does not touch the WsClient or the gate map. */
  mainContent: ReactNode;
  /** Current session (or null) + work_dir (or null) + view
   *  (drives the Sidebar's default tab). */
  currentSession: string | null;
  currentWorkDir: string | null;
  view: 'choiceLevel1' | 'choiceLevel2' | 'recovery';
  /** Sidebar → settings button click (TokenModal closable). */
  onSettingsClick: () => void;
  /** Sidebar → WorkDirs tab → 浏览添加 (DirectoryBrowser modal). */
  onBrowseWorkDirsClick: () => void;
  // -------- Mobile drawer state --------
  /** Drawer open state. Ignored on desktop (sidebar is permanently
   *  mounted in the grid). */
  sidebarOpen: boolean;
  /** Drawer close handler (backdrop click / Escape / hashchange).
   *  Not called on desktop. */
  onCloseSidebar: () => void;
  /** Hamburger ref — `useFocusTrap` restores focus here when the
   *  drawer closes (active true → false). App-level holds the ref
   *  and shares the same ref object with `SessionStatusBar`. */
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

  const sidebarRef = useRef<HTMLElement | null>(null);

  // Body scroll lock while the drawer is open. Restores the
  // prior overflow value on cleanup so the lock is reversible
  // even if a downstream effect set it first.
  useEffect(() => {
    if (!isMobile) return undefined;
    if (!sidebarOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isMobile, sidebarOpen]);

  // hashchange auto-close — mount-once listener; deps
  // `[isMobile, onCloseSidebar]`. `onCloseSidebar` is wrapped in
  // `useCallback` at the App level (identity stable); isMobile
  // flips re-run the effect.
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

  // `inert` attribute on the off-screen mobile sidebar — keeps
  // its buttons out of the Tab order. Applied via ref property
  // rather than JSX attribute because React 18.3.1 does not list
  // `inert` in its known boolean properties (would serialise to
  // `inert="true"`, an illegal HTML boolean attribute value that
  // some browsers don't honour).
  //
  // Effect ordering: this effect MUST run before the
  // `useFocusTrap` effect on the same commit. Focusing into an
  // `inert` subtree is a no-op per the HTML spec; on a
  // false → true `sidebarOpen` flip the previous frame's `inert
  // === true` is still in effect until this effect runs, so the
  // subsequent `focusFirstIn` call would silently fail. React
  // effects fire in declaration order — declare `inert` first.
  useEffect(() => {
    const el = sidebarRef.current;
    if (el === null) return;
    el.inert = computeInert(isMobile, sidebarOpen);
  }, [isMobile, sidebarOpen]);

  // Focus trap while the drawer is open on mobile. Escape
  // closes it; closing returns focus to the hamburger (see
  // `useFocusTrap` header for the return-focus contract).
  useFocusTrap({
    active: isMobile && sidebarOpen,
    containerRef: sidebarRef,
    onEscape: isMobile ? onCloseSidebar : undefined,
    returnFocusRef: hamburgerRef,
  });

  const gridStyle = {
    gridTemplateColumns: isMobile ? '1fr' : 'var(--sidebar-width) 1fr',
  };

  // Mobile aside: fixed drawer with translate-x transition.
  //   - Closed: `-translate-x-full pointer-events-none` so the
  //     backdrop can receive clicks through it.
  //   - Open: `translate-x-0`.
  //   - z-[200] per the stack above.
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
      {/* Sidebar — desktop grid slot; mobile fixed drawer.
          `id="app-sidebar"` is referenced by the hamburger's
          `aria-controls`. `inert` is set via the `useEffect` above
          (ref property), not via a JSX attribute (React 18.3.1
          does not recognise `inert` as a boolean property).
          The outer `<aside>` does NOT carry `data-testid="sidebar"`
          — that testid is owned by the inner `Sidebar` component
          (zero-add/zero-delete contract); re-attaching it here
          would break the e2e single-element locator. */}
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

      {/* Backdrop — mobile + drawer open only. z-[199] (below the
          sidebar). Click to close. Explicit `w-screen` + `h-screen`
          (not just `inset-0`) because a content-less `<button>`
          with `position: fixed; inset: 0` falls back to
          shrink-to-fit width/height in some browsers, which would
          fail Playwright's `toBeVisible` assertion. */}
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