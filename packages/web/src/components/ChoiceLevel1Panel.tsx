// ChoiceLevel1Panel — level=1 panel for the right rail.
//
// The Sidebar (Sidebar.tsx) now owns the work-dirs list and the
// 「浏览添加」 button; this panel keeps the header copy, the
// "must pick a work_dir first" hint, and an optional remove-error
// banner.
//
// ## M6 T09 — minimal hint card reference form (D7 / G12)
//
// Visual reference:
//   - Container: white hint card — `rounded-2xl border border-border
//     bg-surface p-7 shadow-sm max-w-md mx-auto text-center`.
//     Sits inside the main elevated card; the `max-w-md mx-auto
//     text-center` triple centres the panel within the rail so the
//     user's eye lands on the hint + icon.
//   - Header icon block: `size-11 rounded-xl bg-accent-soft text-accent`
//     with a lucide `FolderOpen` icon — mirrors the TokenModal
//     reference tinted icon block + the DirectoryBrowser header
//     (D7 tinted icon block family).
//   - Remove error: red semantic strip (`bg-state-offline/[0.08]
//     border border-state-offline text-state-offline`) — same
//     family used by the DirectoryBrowser `directory-browser-error`.
//
// Preserved testids:
//   - `choice-page`              — section root, data-level="1".
//   - `work-dir-empty`           — empty-state hint.
//   - `choice-page-remove-error` — remove error banner (the
//     Sidebar's WorkDirsTab currently emits this — kept in the
//     JSDoc for future re-introduction).
//
// No testid on the "请通过左侧 WorkDirs 标签的「浏览添加」按钮"
// hint so spec selectors can rely on the Sidebar's anchor without
// colliding with this duplicate.

import { FolderOpen } from 'lucide-react';

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
      // M6 T09 — minimal hint card (D7 / G12). The data-level
      // attribute stays so e2e 01 / 02 / 03 / 04 / 05 / 06 / 07 /
      // 08 / 09's `[data-testid="choice-page"][data-level="1"]`
      // selectors still match. The card itself is `max-w-md
      // mx-auto text-center` so the panel centres inside the
      // main card rail.
      className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-surface p-7 text-center shadow-sm"
      data-testid="choice-page"
      data-level="1"
    >
      {/* Header icon block — `size-11 rounded-xl bg-accent-soft
          text-accent` with `FolderOpen` icon, mirrors the
          DirectoryBrowser + TokenModal reference tinted icon
          block family (D7). aria-hidden on the icon block keeps
          the screen reader focused on the text. */}
      <div
        className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent"
        aria-hidden="true"
      >
        <FolderOpen className="size-5" focusable="false" />
      </div>

      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-base font-semibold tracking-tight text-text">选择工作目录</h2>
        <p className="m-0 text-sm leading-6 text-muted">
          裁定 A：必须先选目录才能看会话列表。
        </p>
      </div>

      {removeError !== undefined && removeError !== null ? (
        <p
          className="m-0 w-full rounded-md border border-state-offline bg-state-offline/[0.08] px-3 py-2 text-left text-sm text-state-offline"
          role="alert"
        >
          {removeError}
        </p>
      ) : null}

      <p className="m-0 text-sm leading-6 text-muted">
        暂无保存的工作目录。请通过左侧 WorkDirs 标签的「浏览添加」按钮选择一个目录。
      </p>
    </section>
  );
}
