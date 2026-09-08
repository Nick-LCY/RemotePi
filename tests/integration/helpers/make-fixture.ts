// Helper: build an isolated agent-dir fixture for integration tests.
//
// Writes the four-file set pi 0.85.1 needs (models.json / settings.json
// / auth.json / extensions/) under a per-test temp directory rooted at
// `tests/integration/.tmp/<run-tag>/agent-dir/`. The temp root lives
// inside the repo (per revision instruction A) so any node_modules
// walk from inside the extension directory hits the repo root.
//
// `makeAgentDir({ fakeLlmBaseUrl })` returns the absolute agent-dir
// path plus a `cleanup()` async function. The cleanup is best-effort —
// a missing directory is fine, but other errors surface so the test
// can fail loudly rather than masking file-leak symptoms.

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Repo-root-relative path for the test extension source. We COPY the
// source file (rather than symlinking) because pi's loader reads the
// extension file via its absolute path and the temp directory must
// be self-contained for the run-tag cleanup to remove everything in
// one shot. Symlinking would also work but adds a `lstat` step to
// `discoverExtensionsInDir` that the loader doesn't need.
const EXTENSION_SOURCE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'fixtures',
  'agent-dir',
  'extensions',
  'test-ext.ts',
);

export interface MakeAgentDirOptions {
  /** Base URL of the fake LLM server (e.g. `http://127.0.0.1:34567`). */
  fakeLlmBaseUrl: string;
  /** Override the api key in auth.json (default: `fake-anthropic-test-key`). */
  apiKey?: string;
  /** Override the default model id (default: `fake-claude-haiku-4-5`). */
  modelId?: string;
  /** Optional run-tag prefix for the temp directory name (helps debugging). */
  runTag?: string;
}

export interface MakeAgentDirResult {
  /** Absolute path to the agent-dir (parent of auth.json / models.json). */
  agentDir: string;
  /** Absolute path to the workDir used for the test session. */
  workDir: string;
  /** Async cleanup function; best-effort rm -rf of both directories. */
  cleanup: () => Promise<void>;
}

/**
 * Create a fresh agent-dir + workDir pair under
 * `tests/integration/.tmp/<random>/` and write the four-file fixture
 * set. The agent-dir references `fakeLlmBaseUrl` directly (no
 * trailing slash — the Anthropic SDK rejects it).
 */
export async function makeAgentDir(opts: MakeAgentDirOptions): Promise<MakeAgentDirResult> {
  const apiKey = opts.apiKey ?? 'fake-anthropic-test-key';
  const modelId = opts.modelId ?? 'fake-claude-haiku-4-5';
  const randomTag = `${opts.runTag ?? 'fixture'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    '.tmp',
    randomTag,
  );
  const agentDir = path.join(tmpRoot, 'agent-dir');
  const workDir = path.join(tmpRoot, 'work');

  await mkdir(path.join(agentDir, 'extensions'), { recursive: true });
  await mkdir(workDir, { recursive: true });

  // models.json — fake-anthropic provider pointed at the test server.
  // baseUrl MUST NOT have a trailing slash (the Anthropic SDK joins
  // `${baseURL}/v1/messages` verbatim; a trailing slash would yield
  // `/v1/messages` doubling the slash). `api` is the locked Anthropic
  // contract literal verified against `pi-ai` v0.x — see
  // `docs/testing.md §2.5` for the source-of-truth reference.
  const models = {
    providers: {
      'fake-anthropic': {
        baseUrl: opts.fakeLlmBaseUrl,
        apiKey,
        api: 'anthropic-messages',
        models: [
          {
            id: modelId,
            name: `Fake ${modelId}`,
            contextWindow: 200_000,
            maxTokens: 8192,
          },
        ],
      },
    },
  };
  await writeFile(path.join(agentDir, 'models.json'), JSON.stringify(models, null, 2), 'utf8');

  // settings.json — minimal: default provider + model only. The
  // extension loader reads `extensions:` if present; we don't need
  // it (extensions are auto-discovered from `<agentDir>/extensions/`).
  const settings = {
    defaultProvider: 'fake-anthropic',
    defaultModel: modelId,
  };
  await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');

  // auth.json — schema-conforming key entry. pi's `auth.js getAuth`
  // is strict about the `{type:'api_key', key:string}` shape; a
  // malformed value kills the spawn with an unhandled exception.
  // The key value here MUST match `expectedApiKey` if the fake server
  // was started with that option; the default value
  // `fake-anthropic-test-key` matches no server enforcement so
  // auth wiring is not exercised in the default config.
  const auth = {
    'fake-anthropic': { type: 'api_key', key: apiKey },
  };
  await writeFile(path.join(agentDir, 'auth.json'), JSON.stringify(auth, null, 2), 'utf8');

  // Copy the test extension source into <agentDir>/extensions/.
  // We copy (not symlink) to keep the directory self-contained for
  // rm-rf cleanup.
  await copyFile(EXTENSION_SOURCE, path.join(agentDir, 'extensions', 'test-ext.ts'));

  const cleanup = async (): Promise<void> => {
    await rm(tmpRoot, { recursive: true, force: true });
  };

  return { agentDir, workDir, cleanup };
}
