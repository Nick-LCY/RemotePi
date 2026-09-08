// E2E scenario (c): multi-tab first-responder wins — see ADR-0009
// §决策 3 场景 (c).
//
// STUB for 任务 13 — see docs/tasks/m3/13-e2e-scenarios.md.
//
// Per task 12 §硬约束 + §specs/, this file ships as a `test.skip()`
// stub on 任务 12 so Playwright can validate the harness end-to-end
// without scenarios (b) + (c) being implemented yet. 任务 13 will
// replace the body with two browser contexts on the same token,
// trigger `trigger_dialog` from one, assert the other context's
// popup auto-closes when the first responder picks (ADR-0004 +
// tasks/m3/05-bridge-popup-core).
//
// The stub keeps:
//   - `test.describe` with the same name task 13 will use;
//   - the file path task 13 already references in its dependency list;
//   - a JSDoc pointer back to the ADR + the next task so a future
//     maintainer doesn't mistake this for a missed implementation.

import { test } from '@playwright/test';

test.describe.skip('scenario (c) — multi-tab first-responder wins [task 13]', () => {
  test.skip('placeholder — see docs/tasks/m3/13-e2e-scenarios.md for the real assertion chain', () => {
    // Intentionally empty. See 02-reload-recovery.spec.ts for
    // the same rationale; scenario (c) is a multi-context spec
    // that task 13 will implement against the same harness.
  });
});
