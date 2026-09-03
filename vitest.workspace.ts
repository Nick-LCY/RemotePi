// Vitest workspace — lists each project that owns a vitest config or ships
// tests. Absolute paths are used so that `vitest run` works regardless of
// whether it's invoked from the repo root (`pnpm run test`) or from inside a
// package (`pnpm --filter <name> test`). Without absolute paths vitest would
// resolve these entries relative to the caller's CWD, breaking the per-package
// invocation.
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

export default [`${repoRoot}packages/*`, `${repoRoot}worker`];
