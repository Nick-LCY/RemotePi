// E2E spec helper — semantic assertion conventions (S5).
//
// This module exists to make ADR-0009 §决策 7's two load-bearing
//断言语义约定 explicit in code. Specs import from here so the
// rule shows up in the diff when the convention is reviewed, rather
// than living only in the ADR body where future readers can miss
// it.
//
// ## Convention 1 — Dialog auto-close is React-key unmount, NOT a
// timer (ADR-0009 §决策 7 末条第一条).
//
//   DialogHost renders each dialog keyed by its
//   `session_state.blocked_on` entry id. When the bridge clears
//   the id (after first-responder commits, after timeout mirror,
//   after bridge-side clearAll), the next `session_state` frame
//   drops the entry and React unmounts the dialog on the key
//   change. The countdown UI in the dialog header is purely
//   informational — it does NOT drive unmount.
//
//   Assertion guidance: prefer `toBeHidden()` or `toHaveCount(0)`
//   on the dialog container `data-testid`. Do NOT assert against
//   a countdown number or wait a fixed delay to observe auto-
//   close. The product bug being guarded against is "dialog stays
//   visible after first-responder commits" — the assertion shape
//   that catches it is "the DOM disappears", which is exactly
//   what the React key semantics guarantee.
//
// ## Convention 2 — Same-token reconnect does NOT re-fire the
// recovery ceremony (ADR-0009 §决策 7 末条第二条).
//
//   `App.tsx` guards the auto-start ceremony behind
//   `autoStartConsumedRef`, which is keyed by token. Three
//   legitimate "re-fire" triggers:
//     1. Token change (hashchange to a new token).
//     2. F5 / full page reload (fresh mount → fresh ref).
//     3. Manual retry button on `RecoveryErrorCard`.
//   WsClient-internal reconnects (the same token, dropping from
//   `online` → `connecting` → `online` because of a transient
//   network hiccup) are NOT among the triggers. The ceremony
//   runs once per token per page lifetime.
//
//   Assertion guidance: do NOT assert that "the dual queries
//   re-fired after a network drop" — they did not, by design.
//   The product bug being guarded against is "WsClient's
//   reconnect logic gets confused and re-fires the ceremony
//   unnecessarily", which would manifest as a duplicate
//   `get_messages` round-trip with no user-visible difference.
//   Asserting the absence (no second `recovery-in-flight`) is the
//   right shape, but it's brittle to test reliably; prefer just
//   keeping the rule in mind when writing reconnect tests.

/** Dialog auto-close helper. Returns a Playwright assertion that
 *  the dialog container has been unmounted (React-key drop in
 *  `DialogHost`'s render loop, not a timer). The default selector
 *  matches the convention's first `data-testid`; pass a more
 *  specific selector for stacked / multi-dialog assertions.
 *
 *  Use this helper rather than rolling your own `expect(...).toBeHidden`
 *  so the convention lives in one place — if the rendering shape
 *  changes (e.g. dialogs move out of DialogHost), only this
 *  helper needs updating. */
export const dialogAutoCloseAssertion = (selector = '[data-testid^="dialog-"]:not([data-testid="dialog-host"]):not([data-testid="dialog-toast"])'): string => {
  // We intentionally return a selector string rather than a
  // pre-built `expect.poll(() => …)` so the spec retains control
  // over timeout + retry semantics. Typical usage:
  //   await expect(page.locSelector(dialogAutoCloseAssertion('dialog-confirm')))
  //     .toHaveCount(0, { timeout: 5_000 });
  return selector;
};

/** Sentinel: throw this from a spec body to mark a test as a
 *  known-flaky implementation gap rather than a regression. The
 *  `globalSetup` runs once per `pnpm test:e2e` invocation, so the
 *  test runner collects `test.skip()` reasons from `test.info()`
 *  annotations when an assertion is wrapped in this helper.
 *
 *  Currently unused — kept as a marker for the multi-tab scenario
 *  if the "B sees request_expired" assertion degrades to a soft
 *  fail (敲定点 5 备选 C 路径). */
export const KNOWN_FLAKY = Symbol.for('remotepi.e2e.known-flaky');
