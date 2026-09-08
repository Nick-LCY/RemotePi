// Playwright config for the E2E suite — see ADR-0009 §决策 1 / §决策 6
// / §决策 7 + 任务 12 §顶层骨架.
//
// Key choices:
//   - **.ts config** (敲定点 1): validated against the existing
//     ESLint flat config; the config file is at `tests/e2e/`, which
//     is covered by the repo's blanket ESLint walk. The
//     `recommendedTypeChecked` ruleset would normally complain
//     about config files outside any `projectService` include —
//     see 敲定点 1 验证结论 in the task file. If this config ever
//     stops type-checking cleanly, the退路 is to rename to `.js`
//     (matches ADR-0008 §3 的 vitest.integration.config.js 路径).
//   - **testDir: './specs'**: Playwright's default spec pattern is
//     `*.spec.ts`; the helpers / config / dist files live outside
//     `specs/` so they don't accidentally become test targets.
//   - **timeout: 60_000** per task 12 §决策 7 起点建议.
//   - **retries: 1** per task 12 §决策 7 起点建议 (本机专用).
//   - **baseURL**: `http://localhost:8787` (wrangler dev port) per
//     task 12 §顶层骨架 use.baseURL.
//   - **artifacts**: trace + screenshot + video retained on failure
//     (flakiness investigation anchors; .gitignore'd below).
//   - **reporters**: `list` for human-readable output + `html` for
//     post-run browsing (`open: 'never'` because we don't want
//     Playwright to spawn a browser on the report directory).
//   - **globalSetup / globalTeardown**: routes to
//     `helpers/global-setup.ts` + `helpers/global-teardown.ts`. The
//     harness builds the run state once; each spec reads it via
//     `readRunState()` from `global-setup.ts`.
//
// Workers / parallelism: 默认 `1`（单 worker 顺序执行场景）。四进程
// 装配在全局层共享，假 LLM server 也是单实例；如果并行跑，two
// browsers 都打开 `/<token>` 会共享同一 Room DO，场景 (a) 单独跑是
// 干净的——把并行留给任务 13 的多 tab 场景。

import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const e2eRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.resolve(e2eRoot, 'playwright-report'), open: 'never' }],
  ],
  globalSetup: fileURLToPath(new URL('./helpers/global-setup.ts', import.meta.url)),
  globalTeardown: fileURLToPath(new URL('./helpers/global-teardown.ts', import.meta.url)),
  use: {
    baseURL: 'http://localhost:8787',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Browser context timeout: how long a Playwright `page` method
    // (goto, locator, etc.) waits before timing out. Independent
    // from `timeout` (per-test total). The 30s default is fine for
    // most operations; the recovery ceremony's first chat-view
    // appearance may take 5-10s on a cold wrangler + pi spawn so
    // individual assertions should use longer polls.
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  // Disable parallel workers for the v1 harness (see JSDoc above).
  workers: 1,
  outputDir: path.resolve(e2eRoot, 'test-results'),
});
