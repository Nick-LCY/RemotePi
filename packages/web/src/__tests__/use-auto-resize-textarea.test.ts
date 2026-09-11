// @vitest-environment node
// Vitest specs for `useAutoResizeTextarea` + `computeTargetHeight`
// (M5 task 02 / PRD §4 / 验收 §4 — auto-grow textarea).
//
// Coverage strategy:
//   - `computeTargetHeight` is the pure "given a scrollHeight,
//     clamp to maxHeight" decision. We test it directly with
//     plain numbers — no DOM, no React. jsdom returns 0 for
//     `scrollHeight` unconditionally, so DOM-level testing
//     would either require a polyfill or an indirect mock of
//     the element property; the pure-function approach pins the
//     same behaviour with much less ceremony.
//   - `DEFAULT_TEXTAREA_MAX_HEIGHT` is exported so the JS-side
//     default can be cross-checked against the
//     `--input-max-height` CSS variable (200px / 200) — they
//     must stay in lock-step or the visual cap and the JS cap
//     would diverge.
//   - The hook itself is a one-liner over `computeTargetHeight`
//     + a `style.height = 'auto'` reset. The reset-before-measure
//     sequence is the canonical "shrink back to single line on
//     clear" pattern; we trust React's `useLayoutEffect` to
//     invoke it synchronously (well-established contract) and
//     pin the pure-function decisions instead. If a future
//     review wants DOM-level coverage, that suite would add
//     jsdom + `// @vitest-environment jsdom` (project policy
//     today is no DOM runtime — see `choice-page-flow.test.ts`
//     header + ADR-0009 §决策 4).

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEXTAREA_MAX_HEIGHT,
  computeTargetHeight,
} from '../hooks/useAutoResizeTextarea.js';

// ---------------------------------------------------------------------------
// computeTargetHeight — pure clamp decision
// ---------------------------------------------------------------------------

describe('computeTargetHeight — pure clamp', () => {
  it('1.1 empty content (scrollHeight 0) returns 0 (cleared → single-line)', () => {
    // The 0 → 0 mapping is the "submit cleared the value, the
    // textarea shrinks back to nothing-visible" path. Real-world
    // scrollHeight is never literally 0 (the element has its
    // padding + border), but the helper must NOT clamp 0 to
    // maxHeight — the hook relies on this to shrink the textarea.
    expect(computeTargetHeight(0, 200)).toBe(0);
  });

  it('1.2 single-line content (scrollHeight 32) returns 32 (under cap)', () => {
    // 32px ≈ line-height (~22px at 0.95rem) + padding (2 × ~5px).
    // Comfortable single-row; the hook writes this height directly.
    expect(computeTargetHeight(32, 200)).toBe(32);
  });

  it('1.3 three-line content (scrollHeight 96) returns 96 (still under cap)', () => {
    // 3 × 32 = 96; well under the 200 cap, so we let the
    // textarea grow to its natural height.
    expect(computeTargetHeight(96, 200)).toBe(96);
  });

  it('1.4 multi-line content past the cap (scrollHeight 280) clamps to maxHeight 200', () => {
    // The "overflow-y: auto" CSS path takes over here — the
    // textarea stops growing and gains an internal scrollbar.
    // Without the clamp the row would blow the page layout.
    expect(computeTargetHeight(280, 200)).toBe(200);
  });

  it('1.5 content exactly at the cap (scrollHeight 200) returns 200 (no off-by-one)', () => {
    // Edge case — `>=` comparison (not `>`) so a content height
    // that exactly matches the cap still hits the cap path
    // rather than the "return content" path.
    expect(computeTargetHeight(200, 200)).toBe(200);
  });

  it('1.6 custom maxHeight (e.g. 80) is honoured', () => {
    // The hook exposes maxHeight as an option so future tweaks
    // can pass a smaller cap without forking the helper. Pin
    // that the helper honours the value rather than a hard
    // 200 — a regression here would silently cap everything
    // at 200 even when callers asked for less.
    expect(computeTargetHeight(120, 80)).toBe(80);
    expect(computeTargetHeight(40, 80)).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_TEXTAREA_MAX_HEIGHT — CSS / JS contract
// ---------------------------------------------------------------------------

describe('DEFAULT_TEXTAREA_MAX_HEIGHT', () => {
  it('2.1 mirrors the --input-max-height CSS variable (200px / 200)', () => {
    // styles.css declares `--input-max-height: 200px;`. If this
    // constant drifts the JS-side inline `style.height` would
    // silently disagree with the CSS cap and the textarea would
    // visually clip past 200 (or stop short of 200) regardless of
    // which side "wins". Pin the contract here.
    expect(DEFAULT_TEXTAREA_MAX_HEIGHT).toBe(200);
  });
});