// Vitest specs for the InputBar's keydown decision helper
// `decideKeyDownAction` (M5 task 02 / PRD §4 / 验收 §3 —
// Enter submit + Shift+Enter newline + IME composing guard).
//
// 9 specs covering 4 decision surfaces: submit (1.x, 2 cases),
// newline (2.x, 2 cases), IME composing guard (3.x, 2 cases
// incl. the legacy WebKit `keyCode === 229` safety net), and
// non-Enter keys (4.x, 3 cases).
//
// The decision logic itself lives in
// `packages/web/src/components/inputBarKeydown.ts` as a pure
// function so it can be unit-tested without a DOM / WsClient /
// provider stack. The InputBar component (`ChatView.tsx`) calls
// it from its onKeyDown handler with the three relevant fields
// (`event.key` / `event.shiftKey` / `event.nativeEvent.isComposing`)
// and maps the returned tag onto side effects:
//
//   - 'submit' → event.preventDefault() + call submit path
//   - 'newline' → no preventDefault (browser inserts '\n')
//   - 'ignore' → no action (textarea / IME handles natively)
//
// We test the decision rules here; the side-effect mapping is
// trivial enough that the call site + TypeScript signatures are
// sufficient static documentation (the component test would
// need jsdom to actually fire a keydown, which the project
// intentionally avoids today — see ADR-0009 §决策 4 + the
// `assistant-message-body.test.tsx` header).

import { describe, expect, it } from 'vitest';

import { decideKeyDownAction } from '../components/inputBarKeydown.js';

// ---------------------------------------------------------------------------
// Submit path — Enter + no Shift + not composing
// ---------------------------------------------------------------------------

describe('decideKeyDownAction — submit path', () => {
  it('1.1 Enter + no shift + not composing → submit', () => {
    // The hot path: user pressed Enter, expects the prompt to
    // go out. The component then calls event.preventDefault()
    // so the textarea doesn't ALSO insert a '\n' alongside the
    // submit (the prior <input> implementation did the same).
    expect(
      decideKeyDownAction({ key: 'Enter', shiftKey: false, isComposing: false }),
    ).toBe('submit');
  });

  it('1.2 Enter + no shift + isComposing undefined → submit (defensive default)', () => {
    // Some test doubles + older browsers omit `isComposing` when
    // the event is not from a composition (undefined rather than
    // false). The helper's `=== true` guard treats both as
    // "not composing" so a regression in the default doesn't
    // silently break the submit path.
    expect(
      decideKeyDownAction({ key: 'Enter', shiftKey: false }),
    ).toBe('submit');
  });
});

// ---------------------------------------------------------------------------
// Newline path — Shift+Enter
// ---------------------------------------------------------------------------

describe('decideKeyDownAction — newline path (Shift+Enter)', () => {
  it('2.1 Shift+Enter + not composing → newline (no submit, browser inserts \\n)', () => {
    // The user pressed Shift+Enter because they want to break
    // the line without sending — we MUST NOT call
    // preventDefault so the textarea's native newline behaviour
    // fires. If we returned 'submit' here the user couldn't
    // write multi-line prompts at all.
    expect(
      decideKeyDownAction({ key: 'Enter', shiftKey: true, isComposing: false }),
    ).toBe('newline');
  });

  it('2.2 Shift+Enter + isComposing → ignore (IME wins, no \\n, no submit)', () => {
    // Both Shift and IME composing — the IME is using Enter to
    // commit a candidate (Shift may be part of the IME's key
    // chord for committing with selection). The IME gets first
    // dibs because the user is in the middle of typing a CJK
    // word; inserting a stray '\n' would break the composition.
    expect(
      decideKeyDownAction({ key: 'Enter', shiftKey: true, isComposing: true }),
    ).toBe('ignore');
  });
});

// ---------------------------------------------------------------------------
// IME guard — Enter while composing
// ---------------------------------------------------------------------------

describe('decideKeyDownAction — IME composing guard', () => {
  it('3.1 Enter + no shift + isComposing true → ignore (candidate commit wins)', () => {
    // The "Enter pressed during pinyin / kana composition"
    // case the task explicitly pins (验收 §3). Submitting
    // here would fire off whatever the user had typed BEFORE
    // the candidate landed — almost never what the user
    // intended. The helper must return 'ignore' so the InputBar
    // leaves the event alone and the IME commits the candidate
    // into the textarea naturally.
    //
    // This test ALSO pins the ORDER of the three checks — the
    // `isComposing` branch is the FIRST one in the helper, so a
    // composing Enter is ignored regardless of shift / key. Test
    // 2.2 covers the same composition + shift combination; both
    // would fail simultaneously if a regression reordered the
    // checks, which is why a separate precedence test was
    // dropped (the comment block above now carries that intent
    // rather than duplicating the assertion in a 3.2).
    expect(
      decideKeyDownAction({ key: 'Enter', shiftKey: false, isComposing: true }),
    ).toBe('ignore');
  });

  it('3.2 Enter + no shift + keyCode 229 (legacy WebKit composition) → ignore', () => {
    // Old-WebKit safety net: Safari on older macOS / iOS still
    // surfaces composition state as `event.keyCode === 229` even
    // when `event.isComposing` is undefined / false (UI Events
    // §6.3 keeps 229 as the historical "IME in progress" sentinel).
    // The helper defends on that branch so the InputBar doesn't
    // accidentally submit a half-typed CJK candidate. Modern
    // Safari / Chromium set `isComposing` correctly so this
    // branch is a safety net, not the hot path; the assertion
    // pins it explicitly so a future refactor that drops the
    // guard (e.g. on a "modern browsers only" cleanup pass) is
    // caught by the test suite rather than by an angry Japanese
    // user's bug report.
    expect(
      decideKeyDownAction({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 }),
    ).toBe('ignore');
  });
});

// ---------------------------------------------------------------------------
// Non-Enter keys — all ignored (textarea handles natively)
// ---------------------------------------------------------------------------

describe('decideKeyDownAction — non-Enter keys', () => {
  it('4.1 letter key (no shift, not composing) → ignore', () => {
    // Backspace, arrow keys, character keys, etc. — the
    // textarea handles all of these natively. The helper must
    // NOT call submit for any non-Enter key.
    expect(
      decideKeyDownAction({ key: 'a', shiftKey: false, isComposing: false }),
    ).toBe('ignore');
  });

  it('4.2 Backspace (no shift, not composing) → ignore', () => {
    // Explicit Backspace pin — a regression where the helper
    // matched a prefix of 'Enter' (e.g. `'Enter'.startsWith(...)`)
    // would pass on letter keys but break here. We assert
    // against the canonical non-Enter key the user expects to
    // delete characters with.
    expect(
      decideKeyDownAction({ key: 'Backspace', shiftKey: false, isComposing: false }),
    ).toBe('ignore');
  });

  it('4.3 Escape key (no shift, not composing) → ignore', () => {
    // Escape is sometimes wired to "clear input" by other chat
    // surfaces; the InputBar doesn't currently do anything on
    // Escape so it must NOT submit either.
    expect(
      decideKeyDownAction({ key: 'Escape', shiftKey: false, isComposing: false }),
    ).toBe('ignore');
  });
});
