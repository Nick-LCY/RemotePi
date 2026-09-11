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
//      `isComposing` flag is the primary guard; legacy WebKit
//      builds also surface `keyCode === 229` during composition
//      even when `isComposing` is undefined / false, so the
//      helper defends on that sentinel too (UI Events §6.3
//      keeps 229 as the historical "IME in progress" marker).
//      Modern Safari / Chromium set `isComposing` correctly so
//      the keyCode branch is a pure safety net, not the hot path.
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
  // IME composition guard FIRST — the IME may also press Enter
  // to commit a candidate, and we must not submit in that case
  // regardless of shift state. (`isComposing` is the spec-correct
  // flag; modern Safari now sets it correctly too, but the
  // legacy WebKit shape still surfaces as `keyCode === 229` on
  // older Safari builds even when `isComposing` is undefined /
  // false, so we defend on that sentinel here to avoid an
  // accidental submit during a CJK composition.)
  if (event.isComposing === true) {
    return 'ignore';
  }
  // Old-WebKit IME composition sentinel (legacy Safari
  // surfaces `keyCode === 229` even when `isComposing` is
  // undefined / false — UI Events §6.3 historical marker).
  // Same tag as the modern guard so the InputBar's onKeyDown
  // mapping is unchanged.
  if (event.keyCode === 229) return 'ignore';
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