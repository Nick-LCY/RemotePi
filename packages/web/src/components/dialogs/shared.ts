// Shared dialog plumbing — re-exports of pieces used by all 4
// dialog components. Keeping them in one file (rather than
// importing each dialog from SelectDialog) avoids a circular import
// when DialogHost needs to know about each component's props.
//
// DialogHeader carries the title + optional countdown.
// DialogFooter renders the Cancel + Submit button pair.
// The ConfirmDialog / InputDialog / EditorDialog files below import
// these directly.

export { DialogHeader, DialogFooter } from './SelectDialog.js';
export type { DialogHeaderProps, DialogFooterProps } from './SelectDialog.js';

/** Reason a dialog transitioned out of the parent's render tree.
 *  DialogHost uses this to drive the brief error toast + close
 *  cycle (PRD §4.5: "显示错误 toast + 自动收起"). The dialog itself
 *  doesn't render the toast — DialogHost owns the global toast
 *  layer so multi-dialog races don't pile up local banners. */
export type DialogCloseReason = 'committed' | 'cancelled' | 'timed_out' | 'expired';
