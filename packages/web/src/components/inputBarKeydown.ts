// inputBarKeydown — pure decision helper for the InputBar's
// onKeyDown handler (M5 task 02 / PRD §4 / 验收 §3).
//
// Why extracted:
//   The keydown handler in ChatView.tsx's InputBar component is
//   tightly coupled to React (it lives inside the component
//   closure so it can call `submitText(value)` + access the Ws
//   client). The DECISION it makes from the raw event —
//   "should we submit, allow a newline, or do nothing?" — is a
//   pure function of three event fields (`key`, `shiftKey`,
//   `isComposing`) and is the part that matters for behavior
//   tests. Extracting it here lets the unit tests pin the
//   decision without spinning up a DOM / WsClient / provider
//   stack. The component then maps the returned tag onto the
//   side effects (`event.preventDefault()` + `submitText(...)`).
//
// Rules (PRD §4 / 验收 §3):
//   1. Enter without Shift AND not in an IME composition →
//      submit (tag = 'submit').
//   2. Enter + Shift → browser inserts '\n' (the textarea's
//      native behaviour); we MUST NOT call `preventDefault` so
//      the newline lands in the value (tag = 'newline').
//   3. Enter while IME is composing (pinyin / Japanese kana /
//      etc.) → the IME is using Enter to commit a candidate.
//      We MUST NOT submit or call preventDefault; the candidate
//      lands in the value naturally (tag = 'ignore'). The
//      `isComposing` flag is the primary guard — Safari / older
//      Chromium used `keyCode === 229` for the same state, but
//      `isComposing` is the spec-correct field (UI Events §6.3)
//      and every modern browser sets it correctly.
//
// Non-Enter keys → 'ignore' (the textarea handles them
// natively — backspace, arrow keys, etc. all just work).

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
}

/** Decision returned to the InputBar's onKeyDown handler. The
 *  handler maps these tags onto side effects:
 *    - `'submit'` → `event.preventDefault()` + call submit path
 *    - `'newline'` → NO `preventDefault` (browser inserts '\n')
 *    - `'ignore'` → no action (the textarea / IME handles it)
 */
export type InputBarKeyDownAction = 'submit' | 'newline' | 'ignore';

export function decideKeyDownAction(event: InputBarKeyDownLike): InputBarKeyDownAction {
  // IME composition guard FIRST — the IME may also press Enter
  // to commit a candidate, and we must not submit in that case
  // regardless of shift state. (`isComposing` is the spec-correct
  // flag; Safari historically used `keyCode === 229` but modern
  // Safari now sets `isComposing` correctly so we don't need to
  // defend on keyCode.)
  if (event.isComposing === true) {
    return 'ignore';
  }
  if (event.key !== 'Enter') {
    return 'ignore';
  }
  if (event.shiftKey) {
    // Shift+Enter on a textarea inserts a '\n'; the textarea
    // handles this natively as long as we don't call
    // preventDefault.
    return 'newline';
  }
  // Enter + no Shift + not composing → submit. The handler will
  // call preventDefault so the textarea doesn't ALSO insert a
  // '\n' alongside the submit (the prior <input> implementation
  // did this too).
  return 'submit';
}