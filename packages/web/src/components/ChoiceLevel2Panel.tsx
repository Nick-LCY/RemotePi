// ChoiceLevel2Panel — the level=2 panel component for the right
// rail of AppShell (M5 §第二块 G5 / D8 / 任务 06 §b).
//
// ## M4 → M5 split
//
// M4 ChoicePage.tsx contained ChoiceLevel2 (sessions list + new
// + change-work-dir + work_dir header). M5 task 06 splits the
// list-rendering responsibility out — the sidebar (sidebar.tsx)
// now owns the sessions list, while this panel keeps:
//   - The header (h2 + current work_dir + change-work-dir button).
//   - The error banner (session_list 超时).
//   - The "新建会话" button (`session-new` — moved here from
//     the sidebar's SessionsTab so the panel keeps the legacy
//     「新建会话」 CTA visible).
//
// ## What this panel does NOT render
//
//   - The sessions list (now in Sidebar's SessionsTab).
//   - DirectoryBrowser (now modal-mounted by App).
//
// ## testid
//
// Preserved from M4 ChoicePage level=2 (testid 零增零删 约束):
//   - `choice-page`           — section root, data-level="2".
//   - `choice-page-work-dir`  — `<code>` element holding the path.
//   - `session-new`           — 新建会话 button.
//   - `work-dir-change`       — 更换目录 button.
//   - `choice-page-error`     — session_list error banner.
//   - `session-list-loading`  — list loading hint (matches Sidebar's).
//   - `session-list-empty`    — list empty hint (matches Sidebar's).
//
// ## Tailwind only
//
// New file — Tailwind utilities only (task 04 已就绪).

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
   *  and re-dispatches to recovery (session='new'). */
  onNewSession: () => void;
}

export function ChoiceLevel2Panel(props: ChoiceLevel2PanelProps): JSX.Element {
  const { workDir, error, onChangeWorkDir, onNewSession } = props;
  return (
    <section
      className="flex flex-col gap-3 rounded border border-border bg-surface p-4"
      data-testid="choice-page"
      data-level="2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 flex-1 text-lg font-semibold text-text">选择会话</h2>
        <button
          type="button"
          onClick={onNewSession}
          className="rounded border border-border bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent/90"
          data-testid="session-new"
        >
          新建会话
        </button>
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
