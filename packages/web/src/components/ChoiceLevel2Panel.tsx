// ChoiceLevel2Panel — level=2 panel for the right rail.
//
// The Sidebar (Sidebar.tsx) now owns the sessions list and the
// 「新建会话」 button; this panel keeps the header copy, the
// 「更换目录」 button (unique to this panel — the Sidebar doesn't
// render it), and an optional session_list error banner.
//
// Preserved testids:
//   - `choice-page`           — section root, data-level="2".
//   - `choice-page-work-dir`  — `<code>` element holding the path.
//   - `work-dir-change`       — 更换目录 button.
//   - `choice-page-error`     — session_list error banner.

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
      className="flex flex-col gap-3 rounded border border-border bg-surface p-4"
      data-testid="choice-page"
      data-level="2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 flex-1 text-lg font-semibold text-text">选择会话</h2>
        {/* 「更换目录」 button — `work-dir-change` is unique to this
            panel (the Sidebar doesn't render it; the user picks
            a new work_dir via the Sidebar's WorkDirsTab click). */}
        <button
          type="button"
          onClick={onChangeWorkDir}
          className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-text hover:bg-bg"
          data-testid="work-dir-change"
        >
          更换目录
        </button>
      </div>

      <p className="m-0 text-sm text-muted">
        工作目录：
        <code
          className="ml-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs"
          data-testid="choice-page-work-dir"
        >
          {workDir}
        </code>
      </p>

      {error !== undefined && error !== null ? (
        <p
          className="m-0 rounded border border-state-offline bg-state-offline/[0.08] px-3 py-2 text-sm text-state-offline"
          role="alert"
          data-testid="choice-page-error"
        >
          {error}
        </p>
      ) : null}

      {/* Empty/loading hint anchors (`session-list-loading`,
          `session-list-empty`) live in the sidebar; this panel
          doesn't re-render them. */}
    </section>
  );
}
