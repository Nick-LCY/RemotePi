// useAutoResizeTextarea — M5 task 02 (PRD §4 / 验收 §4).
//
// Auto-grow the textarea height as the user types up to a hard
// `maxHeight` cap (default 200px). When content exceeds the cap,
// the textarea stops growing and `overflow-y: auto` takes over
// (styles.css `.input-bar-field` rule — see CSS for the
// matching pair).
//
// Implementation notes:
//   - `useLayoutEffect` (NOT `useEffect`) so the height
//     adjustment runs synchronously BEFORE the browser paints
//     the new value, eliminating the one-frame "jump" the user
//     would otherwise see when typing past a growth threshold.
//   - First we reset `el.style.height = 'auto'` — without this
//     step the textarea would only ever grow (because the
//     `scrollHeight` is monotonically non-decreasing for an
//     element with no `height` cap), so on a value CLEARS the
//     textarea would NOT shrink back. The reset + re-measure
//     sequence is the canonical fix (mirrored by most textarea
//     auto-grow libraries, e.g. `react-textarea-autosize`).
//   - `computeTargetHeight` is exported separately so the
//     "given a scrollHeight, clamp to maxHeight" decision can
//     be unit-tested as a pure function (jsdom returns 0 for
//     `scrollHeight`, which makes a true DOM-level test of
//     this hook require either a polyfill or a manual mock —
//     the pure function sidesteps that friction while still
//     pinning the behaviour).

import { useLayoutEffect, type RefObject } from 'react';

export interface UseAutoResizeTextareaOptions {
  /** React ref pointing at the `<textarea>` element. The hook
   *  reads `scrollHeight` + writes `style.height` against this
   *  ref's `current` value. The ref may be `null` before
   *  mount — the hook is a no-op in that case. */
  ref: RefObject<HTMLTextAreaElement | null>;
  /** Current input value. Used as the `useLayoutEffect` dep
   *  so the height re-computes whenever the value changes
   *  (including the empty-string case after submit, which is
   *  the "clear → single line" path the task pins). */
  value: string;
  /** Hard ceiling on the textarea height (pixels). Defaults to
   *  200 per the PRD. When content exceeds this, the textarea
   *  caps at `maxHeight` and `overflow-y: auto` shows the
   *  scrollbar (CSS contract). */
  maxHeight?: number;
}

/** Default max-height in pixels. Mirrors the `--input-max-height`
 *  CSS variable defined in `styles.css` — the JS default and the
 *  CSS default must agree, otherwise the textarea would visually
 *  cap at one and JS-allow growth past the other (the JS side
 *  wins because it sets `style.height` inline). */
export const DEFAULT_TEXTAREA_MAX_HEIGHT = 200;

/** Pure height-clamp helper. Exported so tests can pin the
 *  decision ("if content is taller than the cap, return the
 *  cap; otherwise return the content height") without setting
 *  up a DOM. The hook itself also calls this so the two paths
 *  cannot drift. */
export function computeTargetHeight(scrollHeight: number, maxHeight: number): number {
  if (scrollHeight <= 0) return 0;
  if (scrollHeight >= maxHeight) return maxHeight;
  return scrollHeight;
}

/** Auto-grow / auto-shrink the `<textarea>` height to match its
 *  `scrollHeight`, capped at `maxHeight`. See file header for
 *  the rationale on `useLayoutEffect` + the reset-before-
 *  measure sequence. */
export function useAutoResizeTextarea({
  ref,
  value,
  maxHeight = DEFAULT_TEXTAREA_MAX_HEIGHT,
}: UseAutoResizeTextareaOptions): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    // Reset before re-measuring so a CLEARS value can shrink
    // the textarea back to single-line (see file header).
    el.style.height = 'auto';
    el.style.height = `${computeTargetHeight(el.scrollHeight, maxHeight)}px`;
    // `value` is intentionally the effect dep — we want the
    // resize to fire whenever the textarea's content length
    // changes. `ref` is also a dep (the ref object identity
    // is stable per mount, but explicit deps keep React's
    // lint plugin happy and document the contract).
  }, [ref, value, maxHeight]);
}