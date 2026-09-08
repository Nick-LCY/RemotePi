// Vitest config for the integration test suite — see docs/testing.md §2.
//
// Runs the tests in `tests/integration/` that drive a real `pi` subprocess
// pointed at a fixture agent-dir + a fake Anthropic Messages API server
// bound to `127.0.0.1:0`. CI is intentionally excluded from this run
// (the workflow at `.github/workflows/ci.yml` only invokes
// `pnpm run test` + the four lint/typecheck/build steps); this config
// exists so a developer with `pi` installed locally can opt into the
// regression suite via `pnpm run test:integration` without touching the
// baseline `pnpm run test` discovery.
//
// ## Why this lives at `tests/integration/vitest.integration.config.js`
//
// Two constraints forced the location and extension:
//   1. Vitest 2.1.x's workspace discovery looks for
//      `vitest.workspace.{ts,mts,cts,js,mjs,cjs,json}` in the SAME
//      directory as the config file (see `getWorkspaceConfigPath` in
//      `vitest/dist/chunks/cli-api.DqsSTaIi.js`). Putting this file
//      under `tests/integration/` keeps it physically separate from
//      the root `vitest.workspace.ts`, so vitest doesn't accidentally
//      load the workspace config and run the per-package suites
//      alongside the integration tests. Putting the config at the
//      repo root makes the workspace auto-load.
//   2. ESLint's flat config (typescript-eslint with `projectService`)
//      only accepts `*.js`, `*.mjs`, `*.cjs` as default-project
//      fallbacks. A `vitest.integration.config.ts` would have to be
//      added to a tsconfig.json include, but the project rules
//      forbid touching the root tsconfig (only `package.json`,
//      `.gitignore`, and the root `vitest.config.ts` may be modified).
//
// ## Configuration notes
//
// - `include` is intentionally narrow (`tests/integration/**/*.test.ts`)
//   so the fast unit-test suite (per-package `vitest.config.ts` and the
//   root workspace) is NOT executed here. Vitest's default discovery
//   picks up `**/*.{test,spec}.{js,ts,tsx,jsx,mts,mjs}`; the explicit
//   include overrides that for this config only.
// - `fileParallelism: false` runs files sequentially. Each test file
//   spawns at least one `pi --mode rpc` child, and parallel workers
//   would race for the same fake-server port (despite `port: 0` the
//   event loop / Node fetch / DNS cache still contends under load) AND
//   for /tmp file-system bandwidth when many jsonl sessions land at
//   once. Serial execution is acceptable because the suite is bounded
//   (~5 files × ≤20 s per case → ≤100 s) and well below the 5-minute
//   CI step budget we want to preserve for the future.
// - `testTimeout: 60_000` covers the longest single case (session
//   recovery spawn + 2 LLM roundtrips + idle timer ≈ 15–20 s in
//   practice). `hookTimeout: 30_000` is generous for fixture setup /
//   teardown that does synchronous `mkdtemp` + writes.
// - `passWithNoTests: true` mirrors the root `pnpm run test` contract
//   so a clean checkout with no `tests/integration/**/*.test.ts`
//   matched (e.g. if a future refactor moves them) exits 0. NOTE: this
//   does NOT excuse a missing `pi` binary — if the test files ARE
//   present but `pi` is absent, every case will time out on its 30 s
//   spawn probe rather than being silently skipped. The
//   `assertPiAvailable()` guard in `helpers/make-manager.ts` catches
//   that case with a clear error message.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // The integration suite imports from workspace packages via
      // their bare names (`@remotepi/shared`, `@remotepi/bridge/*`)
      // for readability, but at runtime Node ESM has no way to
      // resolve those names from `tests/integration/**` (the
      // packages' `node_modules/@remotepi/*` symlinks live in
      // `packages/bridge/node_modules/`, not at the repo root). The
      // Vite resolver aliases below map the bare names to the
      // workspace source `.ts` files so vitest's transform pipeline
      // can pick them up.
      //
      // Vite's alias matches the START of the import specifier —
      // `@remotepi/bridge/` (with trailing slash) catches all
      // `@remotepi/bridge/*` imports. The `.js` → `.ts` rewrite is
      // handled by Vite's `resolve.extensions` default.
      {
        find: /^@remotepi\/shared$/,
        replacement: path.join(repoRoot, 'packages/shared/src/index.ts'),
      },
      {
        find: /^@remotepi\/shared\/(.+)$/,
        // No `.js` rewrite — vite's default `resolve.extensions`
        // already covers `.ts` / `.js`, so source files under
        // `packages/shared/src/<x>` resolve directly.
        replacement: path.join(repoRoot, 'packages/shared/src/') + '$1',
      },
      {
        find: /^@remotepi\/bridge$/,
        replacement: path.join(repoRoot, 'packages/bridge/src/index.ts'),
      },
      {
        find: /^@remotepi\/bridge\/(.+?)\.js$/,
        replacement: path.join(repoRoot, 'packages/bridge/src/') + '$1.ts',
      },
      {
        find: /^@remotepi\/bridge\/(.+)$/,
        replacement: path.join(repoRoot, 'packages/bridge/src/') + '$1',
      },
    ],
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    passWithNoTests: true,
    reporters: ['default'],
  },
});
