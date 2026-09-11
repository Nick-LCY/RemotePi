// URL hash two-field parser + writer (M4 钉子 1 + 钉子 6, M5 §第二块
// G6 / D9 收缩版本).
//
// ## Wire contract (PRD §4.1 + tasks/m4/07 §钉子 1)
//
//   https://remote-pi.sankabox.com/#work_dir=<encoded>&session=<key|new>
//   https://remote-pi.sankabox.com/#work_dir=<encoded>             # level=2
//   https://remote-pi.sankabox.com/                                # level=1 (or tokenPrompt)
//
// Format rules:
//   - `work_dir` is a URL-encoded absolute path (`encodeURIComponent`
//     on write, `decodeURIComponent` on read). Optional. The
//     `&work_dir=` marker must be present; a missing value (no `=`)
//     is treated the same as a missing key.
//   - `session` is the sessionKey stem (pi session file name without
//     `.jsonl`) or the literal `new` (pending — bridge will derive the
//     real stem on first entry_appended / agent_start). Optional.
//
// Parsing order: work_dir → session. Missing fields become `null`
// in the returned object — callers map to the 3-row decision table
// in App.tsx (see `decideView()` below and tasks/m4/07 §钉子 6).
//
// ## M5 §第二块 G6 / D9 — token 迁 localStorage + hash 模型收缩
//
// The room access token no longer lives in the URL hash. It is
// cached in `localStorage` under the key `remotepi.token` (see
// `ws/tokenStorage.ts`) and read on App boot. The hash carries only
// the navigation state (work_dir + session).
//
// D9 explicitly forbids any form of backward compatibility:
//   - no `migrateLegacyHashToken`,
//   - no `token` field on the parsed model,
//   - no deprecation warning on old hashes,
//   - no soft-deprecation path.
//
// A bookmark that uses the M3 shape `#<token>&work_dir=…&session=…`
// silently parses to `{workDir, session}` — the leading token segment
// is consumed by the parser as "body text before the first `&`" and
// then dropped, because no body key matches the literal token value.
// The user lands on whatever the work_dir/session values resolve to
// (usually `null`/`null` for a `#<token>` bookmark, which routes to
// `<TokenModal required>` via the App-level `auth.token === null`
// branch — exactly the documented "旧书签 token 已失效" UX).
//
// ## Why a separate file
//
// The hash contract is small, pure, framework-free, and the test
// target of every §9.5 spec item (special-char encoding round-trips,
// deep paths, missing-field semantics). Extracting it lets the test
// file import a single function surface and exercise it without
// React or the WsClient.

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

/** Two-field hash model (M5 §第二块 G6 / D9). Every field is
 *  nullable; missing = "user hasn't reached that stage yet"
 *  (see M4 三态分派决策表 — tasks/m4/07 §钉子 6 / PRD §4.2). The
 *  `token` field that lived here through M3 / M4 has been REMOVED —
 *  token is now sourced from `localStorage` via
 *  `ws/tokenStorage.ts` and injected at the App level before
 *  `decideView()` runs. */
export interface AuthFromHash {
  workDir: string | null;
  session: string | null;
}

/** The three possible render dispatches derived from `AuthFromHash`.
 *  `decideView()` is the single source of truth that App.tsx
 *  consults — keeping the mapping in this module means the test
 *  surface and the production render share one definition
 *  (a copy-paste bug in App.tsx would be invisible to tests; an
 *  inline `decideView` here closes that gap).
 *
 *  `tokenPrompt` is GONE — the App-level `auth.token === null`
 *  branch handles it (see `readAuth()` in App.tsx) before
 *  `decideView()` is called. `decideView` is therefore a 3-row
 *  table that operates on work_dir × session only. */
export type View = 'choiceLevel1' | 'choiceLevel2' | 'recovery';

/** Payload for the `encodeHash()` writer — every field is optional
 *  (missing field is omitted from the output, producing a strictly
 *  shorter hash). `session` accepts both real keys and the `new`
 *  sentinel (constant re-exported above). No `token` field — the
 *  writer is purely navigation state. */
export interface AuthToHash {
  workDir?: string | null;
  session?: string | null;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Parse `window.location.hash` (or any string that already looks
 *  like a hash fragment) into the two-field model. Pure function
 *  — does not read `window` directly so unit tests can pass
 *  arbitrary inputs.
 *
 *  The leading `#` is optional.
 *
 *  ## M3 legacy / D9 silent drop
 *
 *  A pre-M5 hash starts with `<token>` before the first `&`. The
 *  parser reads everything BEFORE the first `&` as the "token slot"
 *  and everything AFTER as `key=value` pairs. Since M5 §D9 forbids
 *  any token preservation, the token slot is **silently dropped** —
 *  no warning, no error, no field on the returned object. Old
 *  bookmarks therefore degrade to whatever work_dir / session
 *  segments they carry (most often `{workDir:null, session:null}`,
 *  which routes to `<TokenModal required>` via the App-level
 *  `auth.token === null` branch).
 *
 *  Unknown keys (anything that isn't `work_dir` / `session`) are
 *  silently dropped — extension-friendly and matches the v1
 *  wire-evolution rule that new optional fields must not break old
 *  parsers. */
export function readAuthFromHash(rawHash: string): AuthFromHash {
  // Strip leading `#` if present; tolerate the empty string
  // (returns all-null, which `decideView` maps to `choiceLevel1`
  // — the App-level token check handles "no token" before this
  // is consulted, so an empty hash here means "user is logged in
  // and hasn't picked a work_dir yet").
  const stripped = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  if (stripped.length === 0) {
    return { workDir: null, session: null };
  }

  // The first `&` separates the (now-deprecated) leading token slot
  // from the body. M5 §D9 — the leading token slot is silently
  // dropped: if the substring before the first `&` is NOT a valid
  // `key=value` pair (i.e. has no `=`), we treat it as the legacy
  // token and discard it. If it IS a valid `key=value` pair (the
  // M5 shape, no token prefix at all), we keep it as the first
  // body entry.
  //
  // The "looks like a key=value pair" heuristic: contains an
  // `=` and the part before the `=` is a recognised key name
  // (`work_dir` / `session`). Tokens in M3 / M4 never contained
  // `=` (they were clean alphabet per the M3 wire contract), so
  // the heuristic is safe for the legacy shape too — anything
  // containing `=` is a body entry regardless of the leading-`#`
  // presence. The `=` heuristic also covers the edge case where
  // the user has a literal `=` in their token (vanishingly rare
  // in practice; the M3 token alphabet disallowed `=`).
  //
  // After the (possibly-virtual) `&` split, the rest follows the
  // standard `key=value&key=value` shape.
  const firstAmp = stripped.indexOf('&');
  const tokenSlot = firstAmp === -1 ? stripped : stripped.slice(0, firstAmp);
  const bodyTail = firstAmp === -1 ? '' : stripped.slice(firstAmp + 1);
  const looksLikeKeyValue = tokenSlot.includes('=')
    && /^(work_dir|session)=/.test(tokenSlot);
  const pairs: string[] = [];
  if (looksLikeKeyValue) {
    pairs.push(tokenSlot);
  }
  if (bodyTail.length > 0) {
    for (const pair of bodyTail.split('&')) {
      if (pair.length > 0) pairs.push(pair);
    }
  }
  if (pairs.length === 0) {
    // Either empty hash (already handled above), legacy
    // `#<token>` with no body, or a token-shaped string with no
    // `&` and no `=` (= definitely not a body entry). All three
    // → return both null so the App routes to `<TokenModal
    // required>` via the `auth.token === null` branch.
    return { workDir: null, session: null };
  }

  // Split remaining body into key=value pairs. `URLSearchParams`
  // would do this for us, but it also lowercases keys, coerces `+`
  // to space, and assumes `application/x-www-form-urlencoded`
  // semantics — none of which match the fragment conventions we
  // want (the PRD pins the encoder to `encodeURIComponent`, and
  // we want round-trip symmetry across `&` / `#` / `+` / `%` /
  // space). We do the split manually and run `decodeURIComponent`
  // only on the value side.
  let workDir: string | null = null;
  let session: string | null = null;
  for (const pair of pairs) {
    if (pair.length === 0) continue;
    const eqIdx = pair.indexOf('=');
    const rawKey = (eqIdx === -1 ? pair : pair.slice(0, eqIdx)).trim();
    const rawValue = eqIdx === -1 ? '' : pair.slice(eqIdx + 1);
    // `decodeURIComponent` on malformed sequences throws URIError;
    // we catch and fall back to the raw value so a typo in the URL
    // doesn't blow up the whole render. The other keys are still
    // parsed; the broken key is just dropped from the model.
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

  return { workDir, session };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Build a hash string from a two-field model. Inverse of
 *  `readAuthFromHash` — round-trip testable.
 *
 *  Output shape matches the format documented at the top of this
 *  file:
 *   - `work_dir=<encodeURIComponent(value)>` when present
 *   - `session=<encodeURIComponent(value)>` when present
 *
 *  No leading `#` — `window.location.hash` setter and `pushState`
 *  both accept either form (browsers normalise to `#…`), but
 *  emitting the bare form keeps the function output predictable
 *  for snapshot tests.
 *
 *  `workDir` / `session` are both optional; `null` / `undefined` /
 *  empty-string all mean "omit". No token field — the token lives
 *  in localStorage (see `ws/tokenStorage.ts`); `encodeHash` is
 *  pure navigation state. */
export function encodeHash(auth: AuthToHash): string {
  const parts: string[] = [];
  if (auth.workDir !== undefined && auth.workDir !== null && auth.workDir.length > 0) {
    parts.push(`work_dir=${encodeURIComponent(auth.workDir)}`);
  }
  if (auth.session !== undefined && auth.session !== null && auth.session.length > 0) {
    parts.push(`session=${encodeURIComponent(auth.session)}`);
  }
  return parts.join('&');
}

// ---------------------------------------------------------------------------
// Two-state dispatch (PRD §4.2 / tasks/m4/07 §钉子 6, M5 §G6 / D9)
//
// Centralised here so App.tsx's render branch is a one-liner and so
// the test file can mock `readAuthFromHash` and feed the result
// straight into `decideView()` to assert on the 3-row decision table.
// ---------------------------------------------------------------------------

/** Map a parsed two-field hash to the render branch App.tsx should
 *  dispatch. The 3-row decision table (M5 §G6 — tokenPrompt 分支
 *  由 App 层 token===null 触发，hash.ts 不再判定) is:
 *
 *    workDir | session | render
 *    --------|---------|--------
 *    —       | —       | choiceLevel1
 *    ✓       | —       | choiceLevel2
 *    ✓       | ✓       | recovery (RecoveryView → ChatView)
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
 *  Review 修复轮 W3——退化 hash 形态告警：`{session≠null,
 *  workDir=null}` 是手工拼出 URL 才会出现的退化形态（用户从
 *  钉子 1 验证表外输入或 scraper / bot 拼接）。M4 ChoicePage
 *  正常流程不会产生该形态（level=2 必须先选 work_dir），因此其
 *  出现提示 可能是"陈旧的书签 / 手写链接"。在进入 recovery 分支前
 *  `console.warn` 提示，避免静默渲染陷入不期望的 session 上下文。
 *  该告警不会影响路由决策——recovery 仍然是该形态的正确出口
 *  （上述钉子 6 文本明文规定），仅是开发者可见的信号。*/
export function decideView(auth: AuthFromHash): View {
  if (auth.workDir === null && auth.session === null) return 'choiceLevel1';
  if (auth.session !== null) {
    // W3 退化形态告警：session 不为空但 work_dir 为空。
    if (auth.workDir === null) {
      // eslint-disable-next-line no-console
      console.warn(
        '[hash] session without work_dir — stale bookmark? session with no work_dir; ',
        'will route to recovery but likely indicates a hand-crafted link. ',
        '(session=<redacted>, workDir=null)',
      );
    }
    return 'recovery';
  }
  return 'choiceLevel2';
}

// ---------------------------------------------------------------------------
// Navigation helpers (tasks/m4/07 §钉子 6 — 退出会话 / 更换目录 / 新建会话)
//
// Each helper returns the hash that App.tsx should write. Callers
// invoke `window.location.hash = …` and the `hashchange` listener
// re-derives state — we don't bypass the URL hash as single source
// of truth (M3 convention; the URL is the only thing F5 / back /
// forward + shareable links can observe for navigation state).
//
// All helpers take `workDir` (and optionally `sessionKey`) only —
// the token parameter has been REMOVED per M5 §D9. The token is
// sourced from `localStorage` and is no longer encoded in the hash
// at all.
// ---------------------------------------------------------------------------

/** "退出会话" — clear `session`, keep `work_dir`. Hash drops to
 *  `work_dir=<encoded>` → App re-dispatches to `choiceLevel2`.
 *  The hash change also triggers `session_list` re-query on the
 *  ChoicePage side (钉子 5 — level=2 刷新时机). */
export function exitSessionHash(workDir: string): string {
  return encodeHash({ workDir });
}

/** "更换目录" — clear BOTH `work_dir` and `session`. Hash drops to
 *  empty → App re-dispatches to `choiceLevel1`. The user picks a
 *  fresh directory (or adds a new one via DirectoryBrowser) and
 *  re-walks the two-level flow. */
export function changeWorkDirHash(): string {
  return encodeHash({});
}

/** "新建会话" — append `&session=new`. Hash becomes
 *  `work_dir=<encoded>&session=new` → App re-dispatches to
 *  `recovery` → ChatView pending. The bridge pending-key control
 *  path (钉子 2) takes over from there: first entry_appended /
 *  agent_start triggers the `new:<work_dir>` → real-stem map key
 *  migration + `session_state{session:<stem>}` broadcast, and the
 *  web `session_state` handler refills the hash with the real stem
 *  (task 07 scope keeps this as a no-op stub — see
 *  `WsClient.subscribeToSessionState` future hook — and full
 *  refilling lives in task 08). */
export function newSessionHash(workDir: string): string {
  return encodeHash({ workDir, session: SESSION_NEW });
}

/** "选择会话" — append the chosen sessionKey. Hash becomes
 *  `work_dir=<encoded>&session=<key>` → App re-dispatches to
 *  `recovery` → ChatView for that session. */
export function selectSessionHash(workDir: string, sessionKey: string): string {
  return encodeHash({ workDir, session: sessionKey });
}

/** "选择工作目录" — write `work_dir` only. The ChoicePage level=1
 *  row-click + the DirectoryBrowser "选择" button both produce
 *  this shape. */
export function selectWorkDirHash(workDir: string): string {
  return encodeHash({ workDir });
}

// ---------------------------------------------------------------------------
// Re-exports for the ChoicePage layer
// ---------------------------------------------------------------------------

// Re-exporting `SessionListEntry` from `@remotepi/shared` is convenient
// for the ChoicePage props — it avoids the layer reaching into the
// shared package directly. The type is part of the public surface
// (re-exported through `@remotepi/shared`'s barrel).
export type { SessionListEntry };
