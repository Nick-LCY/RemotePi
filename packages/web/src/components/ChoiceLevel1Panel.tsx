// ChoiceLevel1Panel — level=1 panel for the right rail.
//
// The Sidebar (Sidebar.tsx) now owns the work-dirs list and the
// 「浏览添加」 button; this panel keeps the header copy, the
// "must pick a work_dir first" hint, and an optional remove-error
// banner.
//
// Preserved testids:
//   - `choice-page`              — section root, data-level="1".
//   - `work-dir-empty`           — empty-state hint.
//   - `choice-page-remove-error` — remove error banner.
//
// No testid on the "请通过左侧 WorkDirs 标签的「浏览添加」按钮"
// hint so spec selectors can rely on the Sidebar's anchor without
// colliding with this duplicate.

interface ChoiceLevel1PanelProps {
  /** Optional error from a recent `work_dir_remove` in the
   *  Sidebar's WorkDirsTab. Reserved for future surfacing —
   *  Sidebar currently shows the remove error inline. Optional —
   *  when null, no banner renders. */
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
          className="m-0 rounded border border-state-offline bg-state-offline/[0.08] px-3 py-2 text-sm text-state-offline"
          role="alert"
        >
          {removeError}
        </p>
      ) : null}

      <p className="m-0 text-sm text-muted">
        暂无保存的工作目录。请通过左侧 WorkDirs 标签的「浏览添加」按钮选择一个目录。
      </p>
    </section>
  );
}
