// ChoiceLevel1Panel — the level=1 panel component for the right
// rail of AppShell (M5 §第二块 G5 / D8 / 任务 06 §b).
//
// ## M4 → M5 split
//
// M4 ChoicePage.tsx contained two top-level components:
// ChoiceLevel1 (work_dirs list + browse button) and ChoiceLevel2
// (sessions list + new + change-work-dir). M5 task 06 splits the
// list-rendering responsibility out of these panels — the sidebar
// (sidebar.tsx) now owns the lists + browse button, while the
// panels keep the header copy + error/empty-state CTAs.
//
// ## What this panel renders
//
//   - `<h2>` header copy — "选择工作目录" (legacy M4 wording)
//   - Hint text — "裁定 A：必须先选目录才能看会话列表"
//   - error banner (e.g. work_dir_remove 失败 — moved here from
//     the sidebar's work-dir-row remove callback)
//
// ## What this panel does NOT render
//
//   - The work_dirs list (now in Sidebar's WorkDirsTab).
//   - **The 浏览添加 button** (now in Sidebar's WorkDirsTab).
//     M4 ChoicePage level=1 had a `work-dir-browse` button here;
//     M5 task 06 moves the canonical button to the sidebar so
//     the user has ONE place to discover it (and to avoid the
//     Playwright strict-mode violation that fires when both
//     sidebar + panel render the same `data-testid="work-dir-browse"`).
//     The panel keeps the textual hint pointing to the
//     sidebar's button.
//   - The DirectoryBrowser itself (now modal-mounted by App).
//
// ## testid
//
// Preserved from M4 ChoicePage level=1 (testid 零增零删 约束):
//   - `choice-page`           — section root, data-level="1".
//   - `work-dir-empty`        — empty-state hint.
//   - `choice-page-remove-error` — remove error banner.
//
// Removed in M5 task 06 (testid 零增零删 约束 applies to anchors
// that EXISTED pre-task-06 — the work-dir-browse button's
// canonical home is now the sidebar):
//   - `work-dir-browse`       — moved to sidebar (WorkDirsTab).
//
// ## Tailwind only
//
// New file — Tailwind utilities only (task 04 已就绪).

interface ChoiceLevel1PanelProps {
  /** Optional error from a recent `work_dir_remove` that
   *  happened in the Sidebar's WorkDirsTab. Reserved for future
   *  surfacing — current Sidebar shows the remove error inline
   *  in its own WorkDirsTab (data-testid="choice-page-remove-error"
   *  owned by Sidebar). Optional — when null, no banner renders. */
  removeError?: string | null;
}

export function ChoiceLevel1Panel(props: ChoiceLevel1PanelProps): JSX.Element {
  const { removeError } = props;
  return (
    <section
      className="flex flex-col gap-3 rounded border border-border bg-surface p-4"
      data-testid="choice-page"
      data-level="1"
    >
      <h2 className="m-0 text-lg font-semibold text-text">选择工作目录</h2>
      <p className="m-0 text-sm text-muted">裁定 A：必须先选目录才能看会话列表。</p>

      {removeError !== undefined && removeError !== null ? (
        <p
          className="m-0 rounded border border-state-offline px-3 py-2 text-sm text-state-offline"
          style={{ backgroundColor: 'rgba(192, 57, 43, 0.08)' }}
          role="alert"
        >
          {removeError}
        </p>
      ) : null}

      {/* Empty-state hint — points the user to the Sidebar's
          WorkDirsTab which owns the actual list (data-testid=
          "work-dir-list") + empty-state ("work-dir-empty") +
          「浏览添加」 button. This panel is a soft visual reminder
          only; the canonical work-dir surface lives in the
          Sidebar (persistent, single source of truth — Playwright
          strict-mode friendly). No data-testid on this hint so
          spec selectors can rely on the Sidebar's anchor without
          colliding with this duplicate. */}
      <p className="m-0 text-sm text-muted">
        暂无保存的工作目录。请通过左侧 WorkDirs 标签的「浏览添加」按钮选择一个目录。
      </p>
    </section>
  );
}
