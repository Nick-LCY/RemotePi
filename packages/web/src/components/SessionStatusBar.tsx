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
// Data sources:
//   - Phase badge — `useSessionPhaseFor(sessionKey)`. The
//     five-value enum (running / idle / spawning / exited /
//     unknown) maps to background colours mirroring the legacy
//     `.phase-{value}` rules in styles.css.
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
      className="flex flex-wrap items-center gap-3 rounded border border-border bg-surface px-3 py-2 text-sm"
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
      ) : null}

      <span className="font-semibold text-text" data-testid="session-status-bar-name">
        {sessionLabel}
      </span>

      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.72rem] font-semibold text-white ${
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