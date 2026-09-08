// E2E scenario (b): F5 reload recovery — see ADR-0009 §决策 3 场景 (b).
//
// STUB for 任务 13 — see docs/tasks/m3/13-e2e-scenarios.md.
//
// Per task 12 §硬约束 + §specs/, this file ships as a `test.skip()`
// stub on 任务 12 so Playwright can validate the harness end-to-end
// (globalSetup / globalTeardown / spec discovery) without scenarios
// (b) + (c) being implemented yet. 任务 13 will replace the body
// with the real assertion chain (page.reload() → recovery ceremony
// runs again → ChatView re-renders with the full message history
// intact — counts + text match the pre-reload state).
//
// The stub keeps:
//   - `test.describe` with the same name task 13 will use;
//   - the file path 任务 13 already references in its dependency list;
//   - a JSDoc pointer back to the ADR + the next task so a future
//     maintainer doesn't mistake this for a missed implementation.

import { test } from '@playwright/test';

test.describe.skip('scenario (b) — F5 reload recovery [task 13]', () => {
  test.skip('placeholder — see docs/tasks/m3/13-e2e-scenarios.md for the real assertion chain', () => {
    // Intentionally empty. The harness is fully exercised by
    // `01-first-turn.spec.ts`; this stub exists so Playwright's
    // spec discovery + globalSetup/Teardown wiring is
    // round-trippable and so task 13 has a file path to write
    // into without recreating the harness plumbing.
  });
});
