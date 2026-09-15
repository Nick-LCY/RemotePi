/** The shape of a keydown event we need to make the decision.
 *  Intentionally narrow — the helper doesn't care about the
 *  React-specific event wrapper (target / currentTarget / etc.)
 *  so tests can pass plain objects. */
export interface InputBarKeyDownLike {
  /** `event.key` — `'Enter'` for the submit newline, anything
   *  else we ignore. */
  key: string;
  /** `event.shiftKey` — true on Shift+Enter (newline path). */
  shiftKey: boolean;
  /** `event.nativeEvent.isComposing` — true while an IME
   *  composition is in progress. Spec-correct guard for the
   *  "user pressed Enter to commit a candidate" case. */
  isComposing?: boolean;
  /** Optional `event.keyCode` (a legacy numeric field still set
   *  by Safari on macOS / iOS during IME composition even when
   *  `isComposing` is undefined or false). UI Events §6.3 keeps
   *  `keyCode === 229` as the historical "IME composition in
   *  progress" sentinel; modern Safari now sets `isComposing`
   *  correctly, but a defensive guard here protects callers
   *  that observe the old-WebKit shape via React's synthetic
   *  event (`event.nativeEvent.keyCode`). Not part of the
   *  public contract beyond the IME guard — absent or zero is
   *  treated as "no legacy signal". */
  keyCode?: number;
}

/** Decision returned to the InputBar's onKeyDown handler. The
 *  handler maps these tags onto side effects:
 *    - `'submit'` → `event.preventDefault()` + call submit path
 *    - `'newline'` → NO `preventDefault` (browser inserts '\n')
 *    - `'ignore'` → no action (the textarea / IME handles it)
 */
export type InputBarKeyDownAction = 'submit' | 'newline' | 'ignore';

export function decideKeyDownAction(event: InputBarKeyDownLike): InputBarKeyDownAction {
  if (event.isComposing === true) {
    return 'ignore';
  }
  if (event.keyCode === 229) return 'ignore';
  if (event.key !== 'Enter') {
    return 'ignore';
  }
  if (event.shiftKey) {
    return 'newline';
  }
  return 'submit';
}