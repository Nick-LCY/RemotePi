// SessionStatusBar — per-session status row at the top of the
// chat surface.
//
// Repackages three pieces of per-session state — phase badge +
// queue pills + session name — into a single horizontal row that
// sits above the MessageList. Bridge status lives in the sidebar
// footer (`<BridgeStatusBar>`); this component is the "本 session
// 状态" surface only.
//
// On mobile (<768px) the sidebar collapses into a drawer (see
// `AppShell.tsx`); the hamburger button lives on the LEFT of
// this row. Desktop (>=768px) doesn't render the hamburger (the
// sidebar is permanently mounted in the grid). The hamburger's
// `data-open` reflects the current drawer state for e2e 09 spec
// assertions.
//
// ## M6 T09 — reference pill 条形态（D7 / G12）
//
// Visual reference:
//   - Container: white pill bar — `rounded-xl border border-border
//     bg-surface px-4 py-2.5 shadow-sm flex items-center gap-3`.
//     Sits inside the main elevated card; the slight border + shadow
//     lift it off the main card surface (avoid "白上白" wash-out).
//   - Phase badge: tinted small pill — amber for `running` (D7 amber
//     family matches the select-dialog tinted icon block), accent
//     for `ready`, state-online for `idle`, state-connecting for
//     `spawning`, state-offline for `exited`, muted for `unknown`.
//     The five-value mapping mirrors the legacy `.phase-{value}` rule
//     shape (re-coloured under the M6 token family).
//   - Queue pills: light grey small pill — `rounded-full bg-surface-2
//     border border-border px-2 py-0.5 text-xs`. Numbers in `text-text`
//     for emphasis.
//   - Session name: when `sessionKey === 'new'` shows "新会话";
//     when `sessionKey === 'm3-legacy'` shows "M3 旧链接会话";
//     otherwise the stem itself.
//
// ## M6 T09 — session 状态色 token 化收尾
//
// The session-status / phase colour map (`SESSION_STATUS_CLASS` in
// `Sidebar.tsx` + `PHASE_CLASS` here) used a hard-coded hex for
// `running` (`#e69138`, amber). M6 T07 introduced the tokenized
// `--amber` / `--amber-soft` family for the select-dialog tinted icon
// block; T09 repurposes the foreground token `bg-amber` for the
// phase badge + sidebar status pill so the visual language stays
// consistent across the app (select dialog + sidebar + status bar
// share the amber family).
//
// Data sources:
//   - Phase badge — `useSessionPhaseFor(sessionKey)`. The
//     five-value enum (running / idle / spawning / exited /
//     ready / unknown) maps to background colours via tokenised
//     utilities.
//   - Queue pills — `useQueueFor(sessionKey)` returns
//     `{steering, followUp}` counts. Hidden when both are zero
//     so the bar doesn't get cluttered during a normal chat.
//   - Session name — when `sessionKey === 'new'` shows "新会话";
//     when `sessionKey === 'm3-legacy'` shows "M3 旧链接会话";
//     otherwise the stem itself.
//
// testids:
//   - `session-status-bar` — root container.
//   - `sidebar-toggle` — hamburger button (mobile only;
//     mutual-exclusivity with `MobileTopBar` keeps one DOM
//     instance at a time).
//   - `session-status-bar-phase` / `session-status-bar-queue-*`
//     — sub-anchors.

import type { SessionPhase } from '@remotepi/shared';
import type { RefObject } from 'react';

import { Menu } from 'lucide-react';

import { useQueueFor, useSessionPhaseFor } from '../ws/WsClientContext.js';
import { useIsMobile } from '../hooks/useIsMobile.js';

interface SessionStatusBarProps {
  /** Session key. `'new'` for the pending branch (bar displays
   *  "新会话"); `M3_LEGACY_KEY` for the legacy token-only path;
   *  any other stem for in-session. */
  session: string;
  /** Drawer open state. Drives the hamburger's aria-label and
   *  data-open attribute. */
  sidebarOpen?: boolean;
  /** Hamburger click handler (mobile only — button doesn't
   *  render on desktop). */
  onToggleSidebar?: () => void;
  /** Hamburger ref — `AppShell`'s `useFocusTrap` calls
   *  `returnFocusRef.focus()` on drawer close. */
  hamburgerRef?: RefObject<HTMLButtonElement>;
}

// ---------------------------------------------------------------------------
// Phase presentation (D7 amber family — tokenised)
// ---------------------------------------------------------------------------

/** Background-colour class for each phase. Tokenised via the
 *  M6 T07 `--amber` / `--amber-soft` family so the visual language
 *  stays consistent with the select-dialog tinted icon block + the
 *  Sidebar's session status pill. `null` falls back to muted grey. */
const PHASE_CLASS: Record<NonNullable<SessionPhase>, string> = {
  // M6 T09 — running now uses the amber family (was hard-coded
  // `bg-[#e69138]` in Sidebar's SESSION_STATUS_CLASS; T09 brings
  // both maps onto the same tokenised vocabulary).
  running: 'bg-amber',
  ready: 'bg-accent',
  idle: 'bg-state-online',
  spawning: 'bg-state-connecting',
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

  // `session === 'new'` → "新会话" (pending — first prompt hasn't
  // derived the real stem yet). `M3_LEGACY_KEY` → "M3 旧链接会话".
  // Otherwise the stem itself.
  const sessionLabel = session === 'new'
    ? '新会话'
    : session === 'm3-legacy'
      ? 'M3 旧链接会话'
      : session;

  return (
    <div
      // M6 T09 — pill bar reference form (D7 / G12). White pill
      // 条 with border + shadow-sm, sits inside the main elevated
      // card; the border + shadow lift it off the main card
      // surface so it doesn't wash out (避免"白上白").
      className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm shadow-sm"
      data-testid="session-status-bar"
      data-session={session}
      data-phase={phase ?? 'unknown'}
    >
      {isMobile ? (
        <button
          ref={hamburgerRef}
          type="button"
          aria-label={sidebarOpen ? '关闭侧边栏' : '打开侧边栏'}
          aria-expanded={sidebarOpen}
          aria-controls="app-sidebar"
          onClick={onToggleSidebar}
          // Hamburger kept on the surface-2 chip background so
          // it pops against the white pill bar (mirrors the
          // SessionStatusBar's pre-T09 visual).
          className="-ml-1 inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-surface-2 text-text hover:bg-bg"
          data-testid="sidebar-toggle"
          data-open={sidebarOpen ? 'true' : 'false'}
        >
          {/* M6 T04 (D3) — hamburger icon moved from inline SVG to
              lucide-react's `Menu` icon. aria-label on the
              button carries the semantic so the SVG stays
              aria-hidden. lucide-react inherits `currentColor`
              so the icon picks up the surrounding `text-text`
              colour automatically. */}
          <Menu className="size-4" aria-hidden="true" focusable="false" />
        </button>
      ) : null}

      <span className="font-semibold text-text" data-testid="session-status-bar-name">
        {sessionLabel}
      </span>

      {/* M6 T09 — phase badge: tinted small pill (D7 / G12). The
          five-value mapping is tokenised via PHASE_CLASS; the
          `text-white` foreground stays so the colour reads as a
          solid pill against the white surface. */}
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.72rem] font-semibold uppercase tracking-wide text-white ${
          phase === null ? 'bg-muted' : PHASE_CLASS[phase]
        }`}
        data-testid="session-status-bar-phase"
        data-phase={phase ?? 'unknown'}
      >
        {phaseLabel(phase)}
      </span>

      {totalQueue > 0 ? (
        <div
          className="flex flex-wrap items-center gap-2 text-muted"
          data-testid="session-status-bar-queue"
        >
          {/* M6 T09 — queue pills: light grey small pill
              (D7 / G12). Numbers lifted into text-text via the
              nested `<strong>` so the count reads as the
              primary signal while the label stays muted. */}
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs"
            data-testid="session-status-bar-queue-steering"
            data-count={steeringCount}
          >
            steering: <strong className="text-text">{steeringCount}</strong>
          </span>
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs"
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
