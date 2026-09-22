// ChoiceLevel2Panel — level=2 panel for the right rail.
//
// The Sidebar (Sidebar.tsx) now owns the sessions list and the
// 「新建会话」 button; this panel keeps the header copy, the
// 「更换目录」 button (unique to this panel — the Sidebar doesn't
// render it), and an optional session_list error banner.
//
// ## M6 T09 — minimal hint card reference form (D7 / G12)
//
// Visual reference:
//   - Container: white hint card — `rounded-2xl border border-border
//     bg-surface p-7 shadow-sm max-w-md mx-auto text-center`.
//     Sits inside the main elevated card; `text-center` aligns the
//     text content while the action button keeps its natural width.
//   - Header icon block: `size-11 rounded-xl bg-accent-soft text-accent`
//     with a lucide `Folder` icon (D7 tinted icon block family —
//     mirrors DirectoryBrowser + TokenModal).
//   - Main button: accent-filled, white text — `bg-accent text-white
//     hover:bg-accent-hover rounded-xl px-4 py-2`. Promoted from
//     pre-T09's neutral white-on-border chip so the "更换目录" CTA
//     reads as the primary action (D7 modal primary-button family).
//   - Path inline code: `surface-2` background + accent foreground
//     + monospace font — mirrors the DirectoryBrowser
//     `directory-browser-path` inline code (D7 inline-code family).
//   - Session-list error: red semantic strip (`bg-state-offline/[0.08]
//     border border-state-offline text-state-offline`) — same
//     family used by DirectoryBrowser `directory-browser-error`.
//
// Preserved testids:
//   - `choice-page`           — section root, data-level="2".
//   - `choice-page-work-dir`  — `<code>` element holding the path.
//   - `work-dir-change`       — 更换目录 button.
//   - `choice-page-error`     — session_list error banner.

import { Folder } from 'lucide-react';

interface ChoiceLevel2PanelProps {
  /** Current work_dir (the one we're listing sessions under).
   *  Required at level=2 (decideView already proved it's
   *  present). */
  workDir: string;
  /** session_list reply timeout error. Rendered as a top-of-
   *  panel banner; the sidebar mirrors the same error in its
   *  own copy. The duplication is intentional — the panel is
   *  the primary user attention area; the sidebar's mirror is
   *  a secondary "what just failed" hint. */
  error?: string | null;
  /** 「更换目录」 button click → writes `changeWorkDirHash()`
   *  and re-dispatches to level=1. */
  onChangeWorkDir: () => void;
  /** 「新建会话」 button click → writes
   *  `newSessionHash(workDir)` and re-dispatches to recovery
   *  (`session='new'`). Currently unused — the Sidebar's
   *  SessionsTab owns the canonical 新建会话 CTA. Kept on the
   *  props surface for a future re-introduction. */
  onNewSession: () => void;
}

export function ChoiceLevel2Panel(props: ChoiceLevel2PanelProps): JSX.Element {
  const { workDir, error, onChangeWorkDir } = props;
  // `onNewSession` is destructured-but-unused — kept on the
  // public surface for a future re-introduction. Reading it off
  // `props` (rather than destructuring with a `_` prefix) keeps
  // it in IDE autocomplete.
  void props.onNewSession;
  return (
    <section
      // M6 T09 — minimal hint card (D7 / G12). The data-level
      // attribute stays so e2e 01 / 02 / 03 / 04 / 05 / 06 / 07 /
      // 08 / 09's `[data-testid="choice-page"][data-level="2"]`
      // selectors still match. The card itself is `max-w-md
      // mx-auto text-center` so the panel centres inside the
      // main card rail.
      className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-surface p-7 text-center shadow-sm"
      data-testid="choice-page"
      data-level="2"
    >
      {/* Header icon block — `size-11 rounded-xl bg-accent-soft
          text-accent` with `Folder` icon, mirrors the
          DirectoryBrowser + TokenModal reference tinted icon
          block family (D7). aria-hidden on the icon block keeps
          the screen reader focused on the text. */}
      <div
        className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent"
        aria-hidden="true"
      >
        <Folder className="size-5" focusable="false" />
      </div>

      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-base font-semibold tracking-tight text-text">选择会话</h2>
      </div>

      {/* M6 T09 — work_dir inline code promoted to accent
          foreground (was neutral text). Mirrors the
          DirectoryBrowser `directory-browser-path` inline-code
          treatment (D7 inline-code family). */}
      <p className="m-0 text-sm leading-6 text-muted">
        工作目录：
        <code
          className="ml-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-accent"
          data-testid="choice-page-work-dir"
        >
          {workDir}
        </code>
      </p>

      {error !== undefined && error !== null ? (
        <p
          className="m-0 w-full rounded-md border border-state-offline bg-state-offline/[0.08] px-3 py-2 text-left text-sm text-state-offline"
          role="alert"
          data-testid="choice-page-error"
        >
          {error}
        </p>
      ) : null}

      {/* M6 T09 — 「更换目录」 button promoted to accent-filled
          primary CTA (was white-on-border chip). Mirrors the
          TokenModal `token-submit` accent-filled button (D7
          modal primary-button family). testid `work-dir-change`
          is preserved so e2e 04's click path stays intact. */}
      <button
        type="button"
        onClick={onChangeWorkDir}
        className="mt-1 inline-flex items-center justify-center rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover focus:outline-none focus-visible:ring-4 focus-visible:ring-accent-ring"
        data-testid="work-dir-change"
      >
        更换目录
      </button>

      {/* Empty/loading hint anchors (`session-list-loading`,
          `session-list-empty`) live in the sidebar; this panel
          doesn't re-render them. */}
    </section>
  );
}
