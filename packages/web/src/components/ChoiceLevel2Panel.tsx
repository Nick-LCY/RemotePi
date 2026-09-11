// ChoiceLevel2Panel — the level=2 panel component for the right
// rail of AppShell (M5 §第二块 G5 / D8 / 任务 06 §b).
//
// ## M4 → M5 split
//
// M4 ChoicePage.tsx contained ChoiceLevel2 (sessions list + new
// + change-work-dir + work_dir header). M5 task 06 splits the
// list-rendering responsibility out — the sidebar (sidebar.tsx)
// now owns the sessions list AND the 新建会话 button
// (the session-new anchor, owned by Sidebar's SessionsTab).
// This panel keeps:
//   - The header (h2 + current work_dir).
//   - The 「更换目录」 button (data-testid="work-dir-change" —
//     unique to this panel, the Sidebar's WorkDirsTab doesn't
//     render it).
//   - The error banner (session_list 超时).
//
// ## What this panel does NOT render
//
//   - The sessions list (now in Sidebar's SessionsTab).
//   - The 新建会话 button (`session-new` — moved to Sidebar's
//     SessionsTab to eliminate the strict-mode duplicate that
//     would have fired Playwright on 6 e2e specs).
//   - DirectoryBrowser (now modal-mounted by App).
//
// ## testid
//
// Preserved from M4 ChoicePage level=2 (testid 零增零删 约束):
//   - `choice-page`           — section root, data-level="2".
//   - `choice-page-work-dir`  — `<code>` element holding the path.
//   - `work-dir-change`       — 更换目录 button.
//   - `choice-page-error`     — session_list error banner.
//
// Removed in M5 task 06 review (Playwright strict-mode fix):
//   - `session-new`           — moved to Sidebar's SessionsTab.
//   - `session-list-loading`  — moved to Sidebar's SessionsTab.
//   - `session-list-empty`    — moved to Sidebar's SessionsTab.
//
// ## Tailwind only
//
// New file — Tailwind utilities only (任务 04 已就绪).

interface ChoiceLevel2PanelProps {
  /** Current work_dir (the one we're listing sessions under).
   *  Required at level=2 (decideView already proved it's
   *  present). */
  workDir: string;
  /** session_list reply 超时错误. Rendered as a top-of-panel
   *  banner; the sidebar mirrors the same error in its own
   *  copy. The duplication is intentional — the panel is the
   *  primary user attention area; the sidebar's mirror is a
   *  secondary "what just failed" hint. */
  error?: string | null;
  /** 「更换目录」 button click → writes changeWorkDirHash() and
   *  re-dispatches to level=1. */
  onChangeWorkDir: () => void;
  /** 「新建会话」 button click → writes newSessionHash(workDir)
   *  and re-dispatches to recovery (session='new'). Currently
   *  unused — the Sidebar's SessionsTab owns the canonical
   *  新建会话 CTA (the session-new anchor, owned by Sidebar).
   *  Kept on the props surface for future re-introduction
   *  (the M4 task 07 brief wanted a panel-level CTA; the M5
   *  task 06 review moved it to the Sidebar to dedupe the
   *  anchor). */
  onNewSession: () => void;
}

export function ChoiceLevel2Panel(props: ChoiceLevel2PanelProps): JSX.Element {
  const { workDir, error, onChangeWorkDir } = props;
  // `onNewSession` is intentionally destructured-but-unused —
  // the prop is kept on the public surface for a future re-
  // introduction (M4 task 07 wanted a panel-level 新建会话 CTA;
  // M5 task 06 review moved it to the Sidebar to dedupe the
  // `session-new` testid). Destructure would have required
  // prefixing with `_onNewSession` to silence the lint warning,
  // but that hides the prop from the IDE autocomplete. Instead
  // we read it off `props` once and discard the value.
  void props.onNewSession;
  return (
    <section
      className="flex flex-col gap-3 rounded border border-border bg-surface p-4"
      data-testid="choice-page"
      data-level="2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 flex-1 text-lg font-semibold text-text">选择会话</h2>
        {/* 新建会话 button is NOT rendered here — the Sidebar's
            SessionsTab owns the canonical `session-new` anchor
            (Playwright strict-mode friendly: the Sidebar is
            the persistent surface and renders one and only one
            such button across the entire workspace). The panel
            keeps the 「更换目录」 button (work-dir-change is
            unique to this panel — the Sidebar doesn't render it
            because the user can also pick a new work_dir via
            the Sidebar's WorkDirsTab click). */}
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
          className="m-0 rounded border border-state-offline px-3 py-2 text-sm text-state-offline"
          style={{ backgroundColor: 'rgba(192, 57, 43, 0.08)' }}
          role="alert"
          data-testid="choice-page-error"
        >
          {error}
        </p>
      ) : null}

      {/* Empty/loading hint anchors (`session-list-loading`,
          `session-list-empty`) live in the sidebar; the panel
          keeps its own placeholder only as a soft visual
          reminder for users who land on level=2 with no
          sidebar mounted (legacy M4 path — preserved here for
          a11y / future-proofing). */}
    </section>
  );
}
