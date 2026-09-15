// Bridge configuration loader — JSON file + zod validation + work_dir
// strict check. The four connection-related inputs (worker URL, web
// base URL, work directory, optional persistent token) live in one
// place; the bridge never reaches for env vars on its own.
//
// Loading flow (one attempt, fail-fast):
//   1. read file as UTF-8
//   2. JSON.parse — any SyntaxError becomes `ConfigError` with
//      `code: 'parse_failed'` (vs. the `missing_field` code for the
//      next stage so callers can tell "your JSON is malformed" from
//      "your JSON is valid but lacks `worker_url`").
//   3. zod schema validates the 3 required string fields + optional
//      `token` (PRD §2.1 field set). zod errors are mapped onto the
//      `missing_field` code because for the bridge's purposes a
//      missing-or-wrong-type field is the same operational outcome
//      ("operator needs to fix their config").
//   4. `statSync` → `isDirectory()` → `accessSync(R_OK)` triplet
//      validates `work_dir`. ANY of these failing throws
//      `ConfigError` with `code: 'work_dir_invalid'`. We deliberately
//      do NOT auto-mkdir — that decision is locked in M3 PRD §2.1
//      (decision 3): "存在 + 是目录 + 当前用户可读，否则退出码 1;
//      不自动 mkdir". A typo in `work_dir` should fail loudly, not
//      silently create an empty directory the operator will discover
//      days later.
//
// Token policy (PRD §2.1):
//   - `token` field present and non-empty → use it as-is.
//   - `token` field absent or empty → generate a fresh one with
//     `generateToken()`. The new token is intentionally NOT written
//     back to the config file (PRD §2.1: "存在且非空 → 用；否则
//     ... 生成 ... 不回写到配置文件"); persistence would require a
//     separate "persist?" decision and risks clobbering operator
//     edits. Users who want a stable token across restarts write it
//     into the JSON themselves.
//
// Default path resolution (`resolveDefaultConfigPath`) honours
// `XDG_CONFIG_HOME` when set, otherwise falls back to
// `$HOME/.config/remotepi/bridge.json` (XDG Base Directory spec §2).
// The XDG check is read here (not at module load) so tests can flip
// the env var per-case without import-order surprises.

import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { generateToken, shareUrl } from './token.js';

/** Shape of a parsed, validated bridge configuration. The two
 *  URL fields are the connection contract; `token` is optional and
 *  only used when present + non-empty (see `readTokenOrGenerate`);
 *  `work_dir` is the M3 compatibility field that becomes **optional**
 *  in M4 — operators who have fully migrated to `state.json` can
 *  omit it. When omitted, `state.json` is the sole source of truth for
 *  `work_dirs` (or the bridge boots with an empty work_dirs list if
 *  `state.json` is also absent). The three-piece `statSync` /
 *  `isDirectory` / `accessSync` validation only fires when
 *  `work_dir` is present. */
export interface BridgeConfig {
  worker_url: string;
  web_base_url: string;
  /** M3 compat field. M4 makes this optional — see JSDoc above. */
  work_dir?: string;
  /** When present and non-empty, the bridge uses this token verbatim
   *  and skips token generation. Absent / empty triggers generation. */
  token?: string;
}

/** zod schema mirroring `BridgeConfig`. Lives next to the type so
 *  they're guaranteed to evolve together. The `.strict()` is
 *  intentional: a typo like `workerUrl` (camelCase) would otherwise
 *  silently drop on parse and surface later as "missing worker_url"
 *  — strict mode surfaces it as "unknown key" which is the actionable
 *  error. The two URL fields are required (`min(1)`); `token` is
 *  optional. `work_dir` is **M4 optional** — `.optional()` lets the
 *  field be absent while the inner `min(1)` still rejects empty
 *  strings (an empty `work_dir: ""` is meaningless and would
 *  previously fall through to the M3 three-piece check with a
 *  confusing ENOENT message). The three-piece validation only fires
 *  when `work_dir` is present (see `loadBridgeConfig`). */
const BridgeConfigSchema = z
  .object({
    worker_url: z.string().min(1),
    web_base_url: z.string().min(1),
    work_dir: z.string().min(1).optional(),
    token: z.string().optional(),
  })
  .strict();

/** Error class for every recoverable failure in the config loading
 *  pipeline. `code` is the machine-readable discriminator callers
 *  can switch on; `message` is human-friendly and safe to print to
 *  stderr verbatim. `cause` carries the underlying error (SyntaxError,
 *  ZodError, fs exception) for diagnostics — the operator never sees
 *  it directly because the bridge logs a clean message. */
export class ConfigError extends Error {
  readonly code: 'parse_failed' | 'missing_field' | 'work_dir_invalid';
  constructor(
    code: 'parse_failed' | 'missing_field' | 'work_dir_invalid',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

/** Resolve the default bridge config path. XDG-aware per the XDG Base
 *  Directory specification:
 *   - `process.env.XDG_CONFIG_HOME` if set (and non-empty) → that
 *     directory + `/remotepi/bridge.json`. We do NOT check whether
 *     the XDG dir exists; the file check happens later and produces a
 *     cleaner `parse_failed`-style error than a stat-race here.
 *   - Otherwise → `~/.config/remotepi/bridge.json` (the XDG default
 *     for `$XDG_CONFIG_HOME`). `os.homedir()` mirrors what most
 *     unix tools do; on systems without `HOME` set it returns the
 *     empty string and the resulting path is obviously broken — the
 *     load attempt then fails with a friendly ENOENT-style error.
 *  Read on every call (not cached at module load) so tests can flip
 *  the env var per-case. */
export function resolveDefaultConfigPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg !== '') {
    return path.join(xdg, 'remotepi', 'bridge.json');
  }
  return path.join(os.homedir(), '.config', 'remotepi', 'bridge.json');
}

/** Load + validate a bridge config from `path`. Throws `ConfigError`
 *  with a stable `code` on any failure; the caller (`start()`) maps
 *  each code to a friendly stderr line. Returns the validated config
 *  object (not the zod-parsed form, but the same shape — zod's
 *  output and our `BridgeConfig` interface match by construction). */
export function loadBridgeConfig(path: string): BridgeConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // ENOENT / EACCES / EISDIR all map to `parse_failed` here —
    // they're all "we couldn't read the config file", which is the
    // same operational outcome for the operator ("your config is
    // missing or inaccessible").
    throw new ConfigError(
      'parse_failed',
      `cannot read config file: ${path} (${(err as Error).message})`,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      'parse_failed',
      `config file is not valid JSON: ${path} (${(err as Error).message})`,
      err,
    );
  }

  const result = BridgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    // Format the zod issues into a compact, operator-friendly summary.
    // We intentionally do NOT dump the raw `ZodError` object — the
    // message only needs to point at which field(s) failed. Path
    // joining uses `.` so an a.b.c failure is readable.
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(
      'missing_field',
      `config file failed validation: ${issues}`,
      result.error,
    );
  }

  // `work_dir` strict check — three independent failures, all
  // reported as `work_dir_invalid`. We do these as separate steps
  // rather than a single try/catch wrapping all three so the message
  // names the precise problem (missing vs. file-not-directory vs.
  // not-readable) instead of dumping the underlying errno and
  // forcing the operator to translate.
  //
  // M4: `work_dir` is optional. When absent, the three-piece check
  // is skipped entirely — `state.json` (or the absence of any
  // work_dirs) is the runtime source of truth for M4 multi-session
  // mode, and the M3-compat auto-spawn path (BridgeSessionLayer's
  // `defaultWorkDir`) falls back to `undefined` when the layer has
  // zero managers, which rejects session-less commands with
  // `invalid_envelope` (see session-layer.ts Branch 6) instead of
  // crashing. The `state.json` migration path
  // (`migrateFromBridgeConfig`) already tolerates an absent /
  // empty `bridgeConfig.work_dir` (writes an empty state.json and
  // returns `[]`).
  const { work_dir } = result.data;
  if (work_dir !== undefined) {
    let stat: import('node:fs').Stats;
    try {
      stat = statSync(work_dir);
    } catch (err) {
      throw new ConfigError(
        'work_dir_invalid',
        `work_dir is not accessible: ${work_dir} (${(err as Error).message})`,
        err,
      );
    }
    if (!stat.isDirectory()) {
      throw new ConfigError(
        'work_dir_invalid',
        `work_dir is not a directory: ${work_dir}`,
      );
    }
    try {
      accessSync(work_dir, constants.R_OK);
    } catch (err) {
      throw new ConfigError(
        'work_dir_invalid',
        `work_dir is not readable: ${work_dir} (${(err as Error).message})`,
        err,
      );
    }
  }

  return result.data;
}

/** Resolve the effective token + share URL for the given config.
 *   - `config.token` non-empty → use it, share URL uses
 *     `config.web_base_url`.
 *   - `config.token` empty / missing → generate a fresh token, share
 *     URL uses `config.web_base_url`. The generated token is NOT
 *     persisted to the config file (PRD §2.1: "不回写到配置文件").
 *
 *  Returns the data the bridge banner prints (token + share URL);
 *  the worker URL is the caller's responsibility because it lives in
 *  `config.worker_url` and the banner needs all three values. */
export function readTokenOrGenerate(config: BridgeConfig): {
  token: string;
  shareUrl: string;
} {
  const token =
    config.token !== undefined && config.token !== ''
      ? config.token
      : generateToken();
  return {
    token,
    shareUrl: shareUrl(token, config.web_base_url),
  };
}
