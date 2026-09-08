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
//
// ## Why this file has no exports
//
//   This module deliberately ships the two断言语义约定 (ADR-0009
//   §决策 7 末条) as JSDoc-only. An earlier revision exported
//   `dialogAutoCloseAssertion` (selector builder) and `KNOWN_FLAKY`
//   (sentinel symbol for soft-fail assertion paths), but neither
//   was wired into a spec — both lived as dead code with
//   speculative future use. The conventions themselves are the
//   load-bearing artefact here; any helper that grows up around
//   them should be co-designed with its first consumer rather
//   than pre-shipped.
