// Worker-side vitest config. Picked up by the root vitest workspace
// (`vitest.workspace.ts`) which lists `${repoRoot}worker` as a project
// entry. The alias mirrors the worker's build-time resolution of
// `@remotepi/shared` (worker/tsconfig.json resolves via Bundler mode +
// the package's `main: ./src/index.ts`, so we point vitest at the same
// TS source rather than at the not-yet-built dist). `passWithNoTests`
// keeps `pnpm test` green on the worker package before any test file
// lands — the rest of the workspace continues to drive test discovery
// from `packages/*`.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@remotepi/shared': `${repoRoot}packages/shared/src/index.ts`,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
