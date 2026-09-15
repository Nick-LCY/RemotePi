// MobileTopBar — mobile-only top bar with hamburger + view title.
//
// Rendered exclusively on mobile (<768px) on the choiceLevel1 /
// choiceLevel2 surfaces; the recovery branch renders
// `<SessionStatusBar>` instead (which also carries a hamburger).
// App dispatches by view, so the two top bars are mutually
// exclusive — both share the same `hamburgerRef` instance so
// `useFocusTrap`'s return-focus always lands on the visible one.
//
// `useIsMobile()` is the gate: desktop returns `null` (no DOM
// contribution; doesn't touch desktop layout).
//
// testids:
//   - `mobile-top-bar` — root container.
//   - `sidebar-toggle` — hamburger button (shared with
//     `SessionStatusBar`; per-view exclusivity means one DOM
//     instance at a time).

import type { RefObject } from 'react';

import { useIsMobile } from '../hooks/useIsMobile.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MobileTopBarProps {
  /** View title — "选择工作目录" / "选择会话" depending on
   *  decideView. Shown to the right of the hamburger. */
  title: string;
  /** Drawer open state. Drives the hamburger's aria-label and
   *  data-open attribute. */
  sidebarOpen?: boolean;
  /** Hamburger click handler (mobile only — button doesn't
   *  render on desktop). */
  onToggleSidebar?: () => void;
  /** Hamburger ref — `AppShell`'s `useFocusTrap` calls
   *  `returnFocusRef.focus()` on drawer close. Shared object
   *  identity with `SessionStatusBar`'s hamburger (App-level
   *  holds the ref). */
  hamburgerRef?: RefObject<HTMLButtonElement>;
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export function MobileTopBar(props: MobileTopBarProps): JSX.Element | null {
  const {
    title,
    sidebarOpen = false,
    onToggleSidebar,
    hamburgerRef,
  } = props;
  const isMobile = useIsMobile();

  // Desktop: no contribution (keeps desktop layout identical
  // to pre-fix).
  if (!isMobile) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded border border-border bg-surface px-3 py-2 text-sm"
      data-testid="mobile-top-bar"
      data-view-title={title}
    >
      {/* Hamburger button — shares `sidebar-toggle` testid with
          `SessionStatusBar`. The two are dispatched by view, so
          only one is mounted at a time and the e2e locator
          always hits a single instance. aria-label flips
          between open / closed; aria-controls points at the
          AppShell `<aside id="app-sidebar">`. */}
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
        {/* Three horizontal bars — inline SVG keeps it self-
            contained. aria-label carries the semantic so the
            SVG itself is aria-hidden. */}
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

      <span
        className="min-w-0 flex-1 truncate font-semibold text-text"
        data-testid="mobile-top-bar-title"
      >
        {title}
      </span>
    </div>
  );
}