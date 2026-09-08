// Vitest workspace for the web package — mirrors the repo root
// `vitest.workspace.ts` so `pnpm --filter @remotepi/web test` runs the
// same project set as `pnpm run test` from the repo root.
//
// Why this file exists (S1 / review fix):
//   `packages/web/vite.config.ts` declares the Vite + React plugin
//   chain. When `vitest` is invoked from inside the web package
//   (`pnpm --filter @remotepi/web test` → `vitest run` with
//   `cwd = packages/web`), vitest's `findUp` walks up from CWD and
//   picks `packages/web/vite.config.ts` as the config file. The
//   workspace lookup then happens **next to the resolved config
//   file**, NOT up the tree at the repo root — see
//   `node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js`:
//   `getWorkspaceConfigPath` does `readdir(dirname(configFile))`
//   and looks for `vitest.workspace.{ts,...}`. Without this file
//   the workspace is undefined and vitest falls back to a single
//   project rooted at the config file, which means only the web
//   package's 25 tests run (the 281 tests in `packages/bridge` /
//   `packages/shared` / `worker` are silently skipped).
//
//   `packages/bridge` and `packages/shared` do not ship a
//   `vite.config.ts` / `vitest.config.ts`, so vitest's `findUp`
//   walks past them to the repo root and discovers
//   `vitest.workspace.ts` there — the per-package test command
//   runs the full 306-test suite as a side effect. This is
//   accidental symmetry, not a contract; the web package's Vite
//   config breaks the chain.
//
//   Fix: re-export the root workspace from this file. The two
//   files now share the same project list (root paths are
//   absolute, so CWD-relative resolution doesn't matter), and
//   every per-package `pnpm --filter <name> test` invocation runs
//   the full suite regardless of which package owns the
//   `vite.config.ts` / `vitest.config.ts` that `findUp` lands on.
//
// CI impact: `.github/workflows/ci.yml` runs `pnpm run test` from
// the repo root, which already exercises the full suite — the
// change here is purely a per-package developer-experience fix
// (no CI change needed). The numbers reported in the review
// (root 306, web per-package 25) converge to 306 after this file
// is added.

export { default } from '../../vitest.workspace.js';
