// URL hash three-field parser + writer (M4 钉子 1 + 钉子 6).
//
// ## Wire contract (PRD §4.1 + tasks/m4/07 §钉子 1)
//
//   https://remote-pi.sankabox.com/#<token>&work_dir=<encoded>&session=<key|new>
//   https://remote-pi.sankabox.com/#<token>&work_dir=<encoded>             # level=2
//   https://remote-pi.sankabox.com/#<token>                                # M3 兼容 — level=1
//
// Format rules:
//   - `token` is FIRST and has NO key name (M3 convention carries over);
//     it is the room access key, the only fragment component a malicious
//     server can't observe (vs. query string / cookie).
//   - `work_dir` is a URL-encoded absolute path (`encodeURIComponent` on
//     write, `decodeURIComponent` on read). Optional. The `&work_dir=`
//     marker must be present; a missing value (no `=`) is treated the
//     same as a missing key.
//   - `session` is the sessionKey stem (pi session file name without
//     `.jsonl`) or the literal `new` (pending — bridge will derive the
//     real stem on first entry_appended / agent_start). Optional.
//
// Parsing order: token → work_dir → session. Missing fields become
// `null` in the returned object — callers map to the 4-row decision
// table in App.tsx (see `decideView()` below and tasks/m4/07 §钉子 6).
//
// ## M3 compatibility path
//
// `#<token>` (no work_dir, no session) is NOT treated as an error: the
// hash is parsed as `{ token, workDir: null, session: null }`, which
// App.tsx's three-state dispatch maps to ChoicePage level=1. Existing
// M3 share-links continue to work — the user lands on the directory-
// selection page and walks the new two-level choice flow forward.
//
// ## Why a separate file
//
// The hash contract is small, pure, framework-free, and the test target
// of every §9.5 spec item (special-char encoding round-trips, deep
// paths, missing-field semantics). Extracting it lets the test file
// import a single function surface and exercise it without React or
// the WsClient.
import type { SessionListEntry } from '@remotepi/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Literal placeholder the web writes into the hash when the user
 *  picks "New session" from ChoicePage level=2. The bridge matches on
 *  this exact string to enter its pending-key control path
 *  (`new:<work_dir>` internal map key — see PRD §1.5 / §2.7 / 钉子 2). */
export const SESSION_NEW = 'new';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Three-field hash model. Every field is nullable; missing = "user
 *  hasn't reached that stage yet" (see M4 三态分派决策表 — tasks/m4/07
 *  §钉子 6 / PRD §4.2). */
export interface AuthFromHash {
  token: string | null;
  workDir: string | null;
  session: string | null;
}

/** The four possible render dispatches derived from `AuthFromHash`.
 *  `decideView()` is the single source of truth that App.tsx consults
 *  — keeping the mapping in this module means the test surface and
 *  the production render share one definition (a copy-paste bug in
 *  App.tsx would be invisible to tests; an inline `decideView` here
 *  closes that gap). */
export type View = 'tokenPrompt' | 'choiceLevel1' | 'choiceLevel2' | 'recovery';

/** Payload for the `encodeHash()` writer — every field is optional
 *  (missing field is omitted from the output, producing a strictly
 *  shorter hash). `session` accepts both real keys and the `new`
 *  sentinel (constant re-exported above). */
export interface AuthToHash {
  token: string;
  workDir?: string | null;
  session?: string | null;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Parse `window.location.hash` (or any string that already looks like
 *  a hash fragment) into the three-field model. Pure function — does
 *  not read `window` directly so unit tests can pass arbitrary inputs.
 *
 *  The leading `#` is optional; whitespace is trimmed from the token
 *  (users paste tokens with trailing newlines).
 *
 *  Unknown keys (anything that isn't `work_dir` / `session`) are
 *  silently dropped — extension-friendly and matches the v1
 *  wire-evolution rule that new optional fields must not break old
 *  parsers. */
export function readAuthFromHash(rawHash: string): AuthFromHash {
  // Strip leading `#` if present; tolerate whitespace; tolerate the
  // empty string (returns all-null, which `decideView` maps to
  // `tokenPrompt`).
  const stripped = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  if (stripped.length === 0) {
    return { token: null, workDir: null, session: null };
  }

  // Token occupies the position BEFORE the first `&`. It is NOT
  // URL-encoded (it is the access key, deliberately a clean
  // alphabet to survive copy-paste). Everything after the first `&`
  // follows the standard `key=value&key=value` shape.
  const firstAmp = stripped.indexOf('&');
  const tokenPart = (firstAmp === -1 ? stripped : stripped.slice(0, firstAmp)).trim();
  const token = tokenPart.length > 0 ? tokenPart : null;

  if (firstAmp === -1) {
    // Token-only (M3 shape). No work_dir / session keys present —
    // return them as null so the decision table lands on level=1.
    return { token, workDir: null, session: null };
  }

  // Split remaining body into key=value pairs. `URLSearchParams` would
  // do this for us, but it also lowercases keys, coerces `+` to space,
  // and assumes `application/x-www-form-urlencoded` semantics — none of
  // which match the fragment conventions we want (the PRD pins the
  // encoder to `encodeURIComponent`, and we want round-trip symmetry
  // across `&` / `#` / `+` / `%` / space). We do the split manually
  // and run `decodeURIComponent` only on the value side.
  let workDir: string | null = null;
  let session: string | null = null;
  const tail = stripped.slice(firstAmp + 1);
  for (const pair of tail.split('&')) {
    if (pair.length === 0) continue;
    const eqIdx = pair.indexOf('=');
    const rawKey = (eqIdx === -1 ? pair : pair.slice(0, eqIdx)).trim();
    const rawValue = eqIdx === -1 ? '' : pair.slice(eqIdx + 1);
    // `decodeURIComponent` on malformed sequences throws URIError; we
    // catch and fall back to the raw value so a typo in the URL doesn't
    // blow up the whole render. The token stays usable (the broken key
    // is just dropped from the parsed model).
    const safeDecode = (v: string): string | null => {
      try {
        return decodeURIComponent(v);
      } catch {
        return null;
      }
    };
    if (rawKey === 'work_dir') {
      const decoded = safeDecode(rawValue);
      if (decoded !== null && decoded.length > 0) {
        workDir = decoded;
      }
    } else if (rawKey === 'session') {
      const decoded = safeDecode(rawValue);
      if (decoded !== null && decoded.length > 0) {
        session = decoded;
      }
    }
    // Unknown keys are silently ignored.
  }

  return { token, workDir, session };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Build a hash string from a three-field model. Inverse of
 *  `readAuthFromHash` — round-trip testable.
 *
 *  Output shape matches the format documented at the top of this file:
 *   - token first, no key
 *   - `work_dir=<encodeURIComponent(value)>` when present
 *   - `session=<encodeURIComponent(value)>` when present
 *
 *  `token` is required (a missing token produces the empty string —
 *  the caller almost certainly forgot to set it; we don't second-guess
 *  and write a bare `&work_dir=...` shape). `workDir` / `session` are
 *  both optional; `null` / `undefined` / empty-string all mean "omit".
 *
 *  No leading `#` — `window.location.hash` setter and `pushState`
 *  both accept either form (browsers normalise to `#…`), but emitting
 *  the bare form keeps the function output predictable for snapshot
 *  tests. */
export function encodeHash(auth: AuthToHash): string {
  const parts: string[] = [];
  parts.push(auth.token);
  if (auth.workDir !== undefined && auth.workDir !== null && auth.workDir.length > 0) {
    parts.push(`work_dir=${encodeURIComponent(auth.workDir)}`);
  }
  if (auth.session !== undefined && auth.session !== null && auth.session.length > 0) {
    parts.push(`session=${encodeURIComponent(auth.session)}`);
  }
  return parts.join('&');
}

// ---------------------------------------------------------------------------
// Three-state dispatch (PRD §4.2 / tasks/m4/07 §钉子 6)
//
// Centralised here so App.tsx's render branch is a one-liner and so the
// test file can mock `readAuthFromHash` and feed the result straight
// into `decideView()` to assert on the 4-row decision table.
// ---------------------------------------------------------------------------

/** Map a parsed three-field hash to the render branch App.tsx should
 *  dispatch. The 4-row decision table is documented in PRD §4.2 +
 *  tasks/m4/07 §钉子 6:
 *
 *    token | workDir | session | render
 *    ------|---------|---------|--------
 *    —     | —       | —       | tokenPrompt
 *    ✓     | —       | —       | choiceLevel1
 *    ✓     | ✓       | —       | choiceLevel2
 *    ✓     | ✓       | ✓       | recovery (RecoveryView → ChatView)
 *
 *  The钉子 6 text in PRD §4.2 also explicitly says: "有
 *  token+session（含 new）→ RecoveryView/ChatView" — i.e. the
 *  presence of a `session` value is the authoritative "user has
 *  picked a session" signal. The degenerate case
 *  `{ token, workDir: null, session: <key> }` is therefore routed
 *  to `recovery` (the same branch as the strict 4-row last row);
 *  the M4 ChoicePage never produces this shape (it enforces the
 *  two-level order on write), but a hand-crafted hash with the
 *  session segment but no work_dir must not loop forever.
 *
 *  `session: 'new'` is treated like any other session value — it
 *  routes to `recovery` because the chat surface (with pending
 *  semantics) is the right destination for the "first prompt will
 *  spawn a manager" flow. The PRD §4.2 wording allows the M3
 *  RecoveryView + ChatView chain to handle `session: 'new'`: the
 *  recovery ceremony's `get_state` query receives `session: 'new'`
 *  in M4 single-bucket web (task 07 scope), which the bridge
 *  handles as a no-active-session → bridges the user straight
 *  into ChatView via the recovery gate's `ready` outcome. Full
 *  per-session + pending behaviour lands in task 08.
 *
 *  Review 修复轮 W3——退化 hash 形态告警：`{token, session≠null,
 *  workDir=null}` 是手工拼出 URL 才会出现的退化形态（用户从
 * 钉子 1 验证表外输入或 scraper / bot 拼接）。M4 ChoicePage 正
 *  常流程不会产生该形态（level=2 必须先选 work_dir），因此其出现
 *  提示 可能是"陈旧的书签 / 手写链接"。在进入 recovery 分支前
 *  `console.warn` 提示，避免静默渲染陷入不期望的 session 上下文。
 *  该告警不会影响路由决策——recovery 仍然是该形态的正确出口
 * （上述钉子 6 文本明文规定），仅是开发者可见的信号。*/
export function decideView(auth: AuthFromHash): View {
  if (auth.token === null) return 'tokenPrompt';
  if (auth.session !== null) {
    // W3 退化形态告警：session 不为空但 work_dir 为空。
    if (auth.workDir === null) {
      // eslint-disable-next-line no-console
      console.warn(
        '[hash] session without work_dir — stale bookmark? token+session with no work_dir; ',
        'will route to recovery but likely indicates a hand-crafted link. ',
        '(session=<redacted>, token present, workDir=null)',
      );
    }
    return 'recovery';
  }
  if (auth.workDir === null) return 'choiceLevel1';
  return 'choiceLevel2';
}

// ---------------------------------------------------------------------------
// Navigation helpers (tasks/m4/07 §钉子 6 — 退出会话 / 更换目录 / 新建会话)
//
// Each helper returns the hash that App.tsx should write. Callers
// invoke `window.location.hash = …` and the `hashchange` listener
// re-derives state — we don't bypass the URL hash as single source of
// truth (M3 convention; the URL is the only thing F5 / back / forward
// + shareable links can observe).
// ---------------------------------------------------------------------------

/** "退出会话" — clear `session`, keep `work_dir`. Hash drops to
 *  `#<token>&work_dir=<encoded>` → App re-dispatches to
 *  `choiceLevel2`. The hash change also triggers `session_list`
 *  re-query on the ChoicePage side (钉子 5 — level=2 刷新时机). */
export function exitSessionHash(token: string, workDir: string): string {
  return encodeHash({ token, workDir });
}

/** "更换目录" — clear BOTH `work_dir` and `session`. Hash drops to
 *  `#<token>` → App re-dispatches to `choiceLevel1`. The user picks
 *  a fresh directory (or adds a new one via DirectoryBrowser) and
 *  re-walks the two-level flow. */
export function changeWorkDirHash(token: string): string {
  return encodeHash({ token });
}

/** "新建会话" — append `&session=new`. Hash becomes
 *  `#<token>&work_dir=<encoded>&session=new` → App re-dispatches to
 *  `recovery` → ChatView pending. The bridge pending-key control
 *  path (钉子 2) takes over from there: first entry_appended /
 *  agent_start triggers the `new:<work_dir>` → real-stem map key
 *  migration + `session_state{session:<stem>}` broadcast, and the
 *  web `session_state` handler refills the hash with the real stem
 *  (task 07 scope keeps this as a no-op stub — see
 *  `WsClient.subscribeToSessionState` future hook — and full
 *  refilling lives in task 08). */
export function newSessionHash(token: string, workDir: string): string {
  return encodeHash({ token, workDir, session: SESSION_NEW });
}

/** "选择会话" — append the chosen sessionKey. Hash becomes
 *  `#<token>&work_dir=<encoded>&session=<key>` → App re-dispatches
 *  to `recovery` → ChatView for that session. */
export function selectSessionHash(
  token: string,
  workDir: string,
  sessionKey: string,
): string {
  return encodeHash({ token, workDir, session: sessionKey });
}

/** "选择工作目录" — write `work_dir` (and keep `token`). The
 *  ChoicePage level=1 row-click + the DirectoryBrowser "选择" button
 *  both produce this shape. */
export function selectWorkDirHash(token: string, workDir: string): string {
  return encodeHash({ token, workDir });
}

// ---------------------------------------------------------------------------
// Re-exports for the ChoicePage layer
// ---------------------------------------------------------------------------

// Re-exporting `SessionListEntry` from `@remotepi/shared` is convenient
// for the ChoicePage props — it avoids the layer reaching into the
// shared package directly. The type is part of the public surface
// (re-exported through `@remotepi/shared`'s barrel).
export type { SessionListEntry };