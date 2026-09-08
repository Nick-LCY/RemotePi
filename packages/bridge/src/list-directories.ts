// Bridge directory-browser pure function — `control/list_directories`.
//
// ## Wire flow (PRD §2.5)
//
//   web → bridge:  { v:1, kind:'control', type:'list_directories', id,
//                   payload: { path?: string } }
//   bridge → web:  result.ok=true,  data = { entries: [{name, path}…] }
//                  result.ok=false, error.code ∈ ERROR_CODES,
//                                   error.message (operator-friendly text)
//
// ## Path semantics
//
//   - `path` 缺省 = `$HOME`（即 `os.homedir()`）；不传 path 视为列
//     home；web UI 提供"上到 home"按钮调 `path = $HOME`。
//   - `path` 提供时 → `path.resolve(path)` 规范化（处理 `..` /
//     多斜杠 / 相对路径转绝对）。
//   - **不设范围限制**（对齐业务共识 2 "起点 home，不设范围限制"）：
//     任何合法路径都可列；单用户自用，无 traversal 安全顾虑。
//   - 列子目录（`withFileTypes: true` → 过滤 `dirent.isDirectory()`），
//     **不含文件**（"添加手段"场景下文件无意义）。
//
// ## Error code mapping (PRD §2.5 + §9.2 + ADR-0010 §决策.4)
//
// PRD §2.5 文本提到 `invalid_path`，但 control.md §8 / ADR-0010 §决策.4
// 明确"沿用既有 6 code 集合，不新增"。M3 §2.1 配置校验的同类做法
// 是 ENOENT / EACCES / ENOTDIR 各分支独立 → 各自带不同 message，但
// 在本任务中所有三类失败都属于"用户提供的 path 在 fs 语义上不可列"，
// 归类到同一个 wire-level code：
//
//   | fs 错误          | 本函数 code       | 映射到 wire code     | 理由
//   | ---------------- | ----------------- | ------------------- | ----
//   | ENOENT           | 'path_not_found'  | 'invalid_envelope'  | 路径不存在 ——
//                       用户的 envelope payload 指向一个不存在的 path，
//                       即 envelope payload 的内容无效。Schema 允许任意
//                       string，但 `path.resolve` 后的实存性是
//                       payload 的语义前提。
//   | EACCES           | 'path_not_readable' | 'invalid_envelope' | 路径不可读
//                       —— 同上，路径在 fs 语义上不可枚举 = 用户
//                       输入路径无效。Bridge 自身未出错。
//   | ENOTDIR          | 'path_not_directory' | 'invalid_envelope' | 路径不是目录
//                       —— 用户提供的 path 解析后是文件而非目录，
//                       与 `list_directories` 的"列子目录"语义不符。
//   | 其他 (EIO/ELOOP…) | 'internal'        | 'internal'          | 非预期 fs 失败
//                       —— bridge 侧未能归类为用户输入错误，归 internal
//                       兜底。这条分支严格留给"操作系统层面抛了非典型
//                       errno"的情况；开发者不应该能从这条路径上
//                       走出来。
//
// 映射发生在 dispatcher（`pi-process.ts` 中 `handleListDirectories`）。
// 本函数只暴露 domain-level outcome，让 dispatcher 决定 wire 形态
// —— 这是 M3 既有 `result.error.code` 翻译（`normalizeCommandError` 等）
// 的同类做法。
//
// ## Sort order
//
// PRD §2.5 未规定顺序；本实现选字典序（locale-independent code-point
// 顺序，Node 内置 `localeCompare` 不带 locale 参数）作为稳定 UI
// 体验的兜底。`Array.prototype.sort` 在 V8 上对此种 String 比较是稳定的，
// 这一点由 ECMAScript 2019 起标准保证。
//
// ## Result schema revalidation
//
// PRD §9.2 + 任务 05 规格："result 回执形状用 shared 的
// `ListDirectoriesResultSchema` 二次校验（防御性，构造后自检）"。
// 本函数在构造完 `{ entries }` 后立即 `safeParse` 一次 —— 防止
// 未来重构（比如改了 `name`/`path` 字段名 / 类型）让本函数产生
// 不再 schema-valid 的 data。Parse 失败抛 internal error，dispatcher
// 捕获后回 `result.error.code = 'internal'`。
//
// ## 与 state.ts 的关系
//
// 本函数**不**消费 `WorkDirStore` 或 state.json —— 目录浏览是通用
// fs 操作，不限于已保存的 work_dir 清单。`list_directories` 是"添加
// 手段"的实现（web 在 ChoicePage level=1 点"浏览添加"时调用），
// 调成功后 web 才用返回的 path 触发 `work_dir_add` 把目录加进清单。
// 任务 06 才把 `list_directories` + `work_dir_*` 三个 control type
// 一起接线进 `BridgeSessionLayer`；本任务只把 list_directories 接线
// 进 `pi-process.ts handleEnvelope`（与 get_state 同级，因为
// list_directories 也不需要 pi 进程）。

import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ListDirectoriesResultSchema,
  type ErrorCode,
  type ListDirectoriesResult,
} from '@remotepi/shared';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Domain-level outcome
// ---------------------------------------------------------------------------

/** Domain-level error code returned by `listDirectories` to its
 *  caller (the bridge dispatcher in `pi-process.ts`). Distinct from
 *  the wire-level `ErrorCode` set — the dispatcher maps each domain
 *  code to the closest `ErrorCode` (see header table). */
export type ListDirectoriesDomainCode =
  /** `fs.readdirSync` threw ENOENT — the resolved path does not
   *  exist on disk (could be ENOENT on the path itself, or ENOENT
   *  encountered during readdir). Maps to wire `invalid_envelope`. */
  | 'path_not_found'
  /** `accessSync(path, R_OK)` threw EACCES, or `readdirSync` threw
   *  EACCES — the path exists but the bridge user cannot read it.
   *  Maps to wire `invalid_envelope`. */
  | 'path_not_readable'
  /** `statSync` (via `accessSync`) surfaced a non-directory file,
   *  or `readdirSync` threw ENOTDIR — the path resolves to a
   *  non-directory. Maps to wire `invalid_envelope`. */
  | 'path_not_directory'
  /** `readdirSync` threw something we did not anticipate (EIO, ELOOP,
   *  EMFILE, …). Maps to wire `internal` — the bridge did nothing
   *  wrong, but the failure isn't a user-input issue either. */
  | 'internal';

/** Map a domain-level error code to the closest wire-level
 *  `ErrorCode`. Extracted as a pure function so:
 *    1. The mapping table is testable without going through the
 *       full dispatcher wiring (no envelope, no outbound sink).
 *    2. The mapping is the single source of truth — the dispatcher
 *       calls this function rather than re-implementing the
 *       switch inline, so a future addition (e.g. a new domain
 *       code) only has to be added in one place.
 *
 *  See module header table for rationale. The rule is:
 *    - all three "user-provided path is bad" codes → `invalid_envelope`
 *    - non-user-input fs failures (the `internal` bucket) → `internal`
 *
 *  Note: this function lives here rather than in `pi-process.ts`
 *  because it's a domain-level decision (which wire code most
 *  honestly describes a given domain failure), not a wire-level
 *  concern. The dispatcher's job is purely to invoke the mapper
 *  + emit the envelope. */
export function mapListDirectoriesDomainCodeToWire(
  domainCode: ListDirectoriesDomainCode,
): ErrorCode {
  if (domainCode === 'internal') return 'internal';
  // All three user-input-path failures map to the same wire code.
  // We keep the domain-level distinction (so the operator sees a
  // precise message in `error.message`) but collapse the wire code.
  return 'invalid_envelope';
}

/** Result of `listDirectories` — either the success outcome with the
 *  schema-validated entries list, or the failure outcome with a
 *  domain-specific code and a human-friendly message. We deliberately
 *  use a discriminated union instead of throwing — control flow
 *  through exceptions is hidden cost, and the dispatcher's three
 *  branches (success / domain-error / revalidation-fail) are cleaner
 *  to express as case-by-case handling than try/catch nesting. */
export type ListDirectoriesOutcome =
  | { readonly ok: true; readonly data: ListDirectoriesResult }
  | {
      readonly ok: false;
      readonly code: ListDirectoriesDomainCode;
      readonly message: string;
    };

/** `path.resolve(undefined)` would throw TypeError; map undefined to
 *  `$HOME` first so the caller-side schema (which types `path?:
 *  string`) sees an unambiguous string here. `os.homedir()` reads
 *  `$HOME` on POSIX and `USERPROFILE` on Windows; the test environment
 *  is Linux, but the call is identical on both. */
function resolveOrHome(inputPath: string | undefined): string {
  if (inputPath === undefined) {
    return os.homedir();
  }
  // `path.resolve` accepts an empty string (resolves to cwd), any
  // non-empty string (resolves to absolute or `<cwd>/<path>`), and
  // never throws on a string input. Multiple slashes / `..` / `.`
  // are normalised by construction (POSIX path semantics).
  return path.resolve(inputPath);
}

/** Three-piece pre-flight check, mirrors `state.ts validateWorkDir`
 *  (exists + is directory + readable). Done up front so each failure
 *  branch is independent and the error message names the precise
 *  problem (the dispatcher preserves the message verbatim in
 *  `result.error.message`). */
function preflight(
  resolvedPath: string,
): { kind: 'ok' } | { kind: 'err'; code: ListDirectoriesDomainCode; message: string } {
  // 1. stat / existence check. ENOENT (or any other stat-time errno)
  // maps to `path_not_found` — the dispatcher only cares about
  // "does this path exist?" here. Permission errors during stat are
  // also ENOENT-class from the operator's perspective: the path
  // is effectively unreachable, so we surface `path_not_readable`
  // rather than `path_not_found` (the operator can fix a missing
  // path; they can't easily fix an unreadable one without
  // understanding permission semantics, so the distinction matters).
  let stat: import('node:fs').Stats;
  try {
    // Static import at module top binds `statSync` to the real
    // `node:fs` module. Tests that want to inject an EACCES-style
    // failure use `vi.doMock('node:fs', ...)` + `vi.resetModules()` +
    // dynamic `import('../list-directories.js')` — the dynamic import
    // goes through the loader registry which has the doMock'd fs
    // installed, so this `statSync` call observes the mocked version.
    // See config.test.ts case 7 / state.test.ts case 15 / 9c for the
    // exact pattern.
    stat = statSync(resolvedPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return {
        kind: 'err',
        code: 'path_not_found',
        message: `path does not exist: ${resolvedPath}`,
      };
    }
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      return {
        kind: 'err',
        code: 'path_not_readable',
        message: `path is not readable: ${resolvedPath} (${e.message})`,
      };
    }
    // ELOOP / ENAMETOOLONG / EIO / etc. — non-classified, fall
    // through to `internal` so the dispatcher can surface it.
    return {
      kind: 'err',
      code: 'internal',
      message: `unexpected error inspecting path: ${resolvedPath} (${e.code ?? 'unknown'}: ${e.message})`,
    };
  }
  // 2. directory check. `stat.isDirectory()` is false for files,
  // symlinks-to-files, sockets, devices, etc. The PRD's
  // `list_directories` contract is "列子目录"; a file isn't a
  // directory and doesn't have enumerable children, so this is
  // a semantic mismatch (path is reachable but wrong type).
  if (!stat.isDirectory()) {
    return {
      kind: 'err',
      code: 'path_not_directory',
      message: `path is not a directory: ${resolvedPath}`,
    };
  }
  // 3. readability check. accessSync is a separate syscall from
  // stat — a path can exist (stat succeeds) but be unreadable
  // (mode bits forbid R_OK). We check this explicitly so the
  // error message names the actual problem rather than a generic
  // "EACCES from readdir" surface.
  try {
    accessSync(resolvedPath, constants.R_OK);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      kind: 'err',
      code: 'path_not_readable',
      message: `path is not readable: ${resolvedPath} (${e.message})`,
    };
  }
  return { kind: 'ok' };
}

/** Read the directory entries. Filters to directories only
 *  (PRD §2.5: "列子目录（withFileTypes: true → 过滤 dirent.isDirectory()），
 *  不含文件"); hidden files (`.foo`) are NOT special-cased — if
 *  they're directories they're listed, matching the unix convention
 *  `ls -l` does NOT filter dotfiles by default but the listing still
 *  includes them. (Web UI may want to filter dotfiles in a future
 *  polish pass; that's a UI concern, not a wire contract one.)
 *
 *  Sort: locale-independent lexicographic (code-point) order; see
 *  module header "Sort order" note for rationale.
 *
 *  ## TOCTOU note (readdir-time ENOTDIR / ENOENT)
 *
 *  The preflight above is best-effort — between stat + readdir
 *  the path could be deleted (ENOENT) or replaced with a file
 *  (ENOTDIR). These are handled in the catch block below (the
 *  ENOTDIR branch around line 290+), mapped to `path_not_found`
 *  and `path_not_directory` respectively so the operator sees
 *  the same message regardless of which syscall surfaced the
 *  failure. These branches are **not** unit-tested (synthesising
 *  the precise race is impractical in a hermetic tmpdir); the
 *  integration / e2e suite is the right place to exercise them. */
function readDirectoryEntries(resolvedPath: string): {
  kind: 'ok';
  entries: { name: string; path: string }[];
} | {
  kind: 'err';
  code: ListDirectoriesDomainCode;
  message: string;
} {
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = readdirSync(resolvedPath, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // ENOENT can fire here too if the path was deleted between
    // preflight and readdir (TOCTOU). Map it to `path_not_found`
    // for consistency with the preflight branch — the user will
    // see the same error message regardless of which syscall
    // surfaced it.
    if (e.code === 'ENOENT') {
      return {
        kind: 'err',
        code: 'path_not_found',
        message: `path does not exist: ${resolvedPath}`,
      };
    }
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      return {
        kind: 'err',
        code: 'path_not_readable',
        message: `path is not readable: ${resolvedPath} (${e.message})`,
      };
    }
    if (e.code === 'ENOTDIR') {
      // ENOTDIR at readdir time means the path became a non-directory
      // between preflight and readdir — extremely rare (TOCTOU),
      // but the dispatcher surfaces a stable error message either way.
      return {
        kind: 'err',
        code: 'path_not_directory',
        message: `path is not a directory: ${resolvedPath}`,
      };
    }
    // EIO / ELOOP / EMFILE / ENFILE / anything else — internal.
    return {
      kind: 'err',
      code: 'internal',
      message: `unexpected error reading directory: ${resolvedPath} (${e.code ?? 'unknown'}: ${e.message})`,
    };
  }
  const entries: { name: string; path: string }[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    entries.push({
      name: dirent.name,
      // Build the entry path by joining resolvedPath + dirent.name.
      // `path.join` normalises a trailing slash on resolvedPath
      // (e.g. when $HOME is `/`); the result is always absolute.
      path: path.join(resolvedPath, dirent.name),
    });
  }
  // Stable, locale-independent lexicographic sort. `Array.sort`
  // without a comparator uses code-point ordering on strings
  // (ECMAScript 2019+ guarantees stability), which matches the
  // "stable UI experience" intent in PRD §2.5 without bringing
  // in locale-aware collation semantics that could surprise a
  // single-locale user.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: 'ok', entries };
}

/** List subdirectories of `path` (or `$HOME` when `path` is
 *  absent). Pure filesystem operation — does NOT consult
 *  `state.json` / `WorkDirStore` (directory browsing is a
 *  pre-addition step; the saved work_dirs list is consulted
 *  separately via `work_dir_list`, see state.ts).
 *
 *  Returns a discriminated union — see `ListDirectoriesOutcome`.
 *  Callers should narrow on `outcome.ok` before reading fields. */
export function listDirectories(
  inputPath: string | undefined,
): ListDirectoriesOutcome {
  // Step 1: resolve input → absolute path (or $HOME if absent).
  // Done up front so every error message below can quote the
  // canonical, normalised path the operator should grep their
  // filesystem for. Empty-string input falls through to
  // `path.resolve('')` → cwd (POSIX); not an error per se, just
  // a weird user input — schema validation already rejects
  // null/non-string, and the empty-string path is operator-
  // diagnosed (cwd is a real directory that lists just fine).
  const resolved = resolveOrHome(inputPath);

  // Step 2: preflight (stat + isDirectory + R_OK). Each failure
  // branch is independent (PRD §2.5 + M3 §2.1 配置校验的同类做法).
  const pre = preflight(resolved);
  if (pre.kind === 'err') {
    return { ok: false, code: pre.code, message: pre.message };
  }

  // Step 3: readdir + filter + sort. Failure branches mirror
  // the preflight ones for consistency (operator sees the same
  // message whether the failure surfaced at stat-time or at
  // readdir-time — TOCTOU between the two is rare but the
  // contract is stable).
  const read = readDirectoryEntries(resolved);
  if (read.kind === 'err') {
    return { ok: false, code: read.code, message: read.message };
  }

  // Step 4: defensive revalidation against the shared
  // `ListDirectoriesResultSchema`. Constructing `{ entries }`
  // from local variables is unlikely to drift from the schema,
  // but the cost of `safeParse` is microseconds and the value
  // of catching a future refactor that breaks the wire contract
  // is high — the dispatcher would otherwise emit a malformed
  // `result.data` that fails the web's zod refine silently.
  // Failure here is `internal` — by construction, the schema
  // only fails if our own code produced an unexpected shape,
  // which is a bridge bug.
  const data: ListDirectoriesResult = { entries: read.entries };
  const revalidated = ListDirectoriesResultSchema.safeParse(data);
  if (!revalidated.success) {
    logger.error(
      `list_directories: defensive revalidation failed: ${revalidated.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
    return {
      ok: false,
      code: 'internal',
      message: 'list_directories produced an invalid result shape (defensive revalidation failed)',
    };
  }
  return { ok: true, data: revalidated.data };
}
