// stem-refilled watcher — extracted from App.tsx for unit-testability
// (M4 task 08 review 修复轮 W8).
//
// ## What this watches
//
// The bridge's pending-key path (钉子 2,
// `docs/tasks/m4/06-bridge-session-layer.md` §1.5) lets the web
// commit a `pi/prompt` with `session: 'new'` + `payload.work_dir`
// BEFORE the manager has spawned (the bridge stashes under
// `new:<work_dir>` internal key and spawns on first outbound).
// Once the manager's first stdout event lands, the bridge
// broadcasts `session_state{session:<realStem>}` (the
// `makeOutboundWrapper` injects `session` here — the anchor frame).
//
// The web's URL hash is currently `#<token>&work_dir=...&session=new`.
// The user is in ChatView with currentSessionKey='new'. Once the
// stem lands, the hash should refill to `&session=<realStem>` so:
//   - F5 / share-link preserves the real session key;
//   - ChoicePage level=2's session_list mirror gets a fresh query
//     (钉子 5 — stem 回填后重查)。
//
// ## 触发条件（review R4 钉桩）
//
// Watcher 仅在以下条件同时满足时触发 hash 回填：
//   1. URL hash 的 `session === 'new'`（pending 占位）；用户切
//      到其他会话或 level=2 后不应再 fire。
//   2. bridge session_state 携带 `envelope.session === <realStem>`
//      （非 'new' / 非 undefined / 非 M3_LEGACY_KEY）。
//
// 反例：
//   - `envelope.session === 'new'`（bridge 自答或自身 loop）：
//     skip（仍处于 pending 阶段）。
//   - `envelope.session === undefined`：session-less session_state
//     不可能（bridge `makeOutboundWrapper` 必注入）——skip（防御）。
//   - `envelope.session === M3_LEGACY_KEY`：M3-compat fallback，
//     不应让 URL 指向 M3_LEGACY 桶——skip。
//   - URL hash 的 `session` 已是其他会话（非 'new'）：用户已离开
//     pending 流——skip（防误触发其他会话的 hash 覆盖）。
//
// ## Side effects（执行顺序固定）
//
//   1. `window.location.hash = selectSessionHash(token, workDir, stem)`
//      → 触发 App.tsx 的 `hashchange` 监听器 → 重新派生 auth +
//      setCurrentSessionKey(stem)。
//   2. `wsClient.sendSessionList(workDir)` → ChoicePage level=2
//      下次 mount 时拿到含新 session 的列表。
//
// ## 设计要点：辅助函数 + 自管 listener
//
// `watchStemRefilled` 是 framework-free helper：传入 token / workDir
// + wsClient，返回一个 unsub 闭包。App.tsx 在 useEffect 内调用，
// deps 变化时 cleanup unsub。Effect 主体条件不满足时（如 session
// 已非 'new'）→ 返回 no-op unsub，避免 React 警告。
//
// 测试用例（W8 落地）：见
// `packages/web/src/__tests__/stem-refilled.test.ts`。
// 1. session_state{session:<stem>} → hash 写入 + sendSessionList fire。
// 2. session_state{session:'new'} → 不 fire（仍是 pending）。
// 3. session_state{session:undefined} → 不 fire（schema 防御）。
// 4. URL session 切到非 'new' 后 → 卸载后不 fire。

import { PROTOCOL_VERSION, type Envelope } from '@remotepi/shared';

import { SESSION_NEW, selectSessionHash } from '../hash.js';
import { M3_LEGACY_KEY, type WsClient } from './WsClient.js';

/** The return value of `watchStemRefilled` — an unsub closure.
 *  Calling it tears down the type listener immediately. Calling
 *  twice is safe (second call is a no-op). */
export type Unsubscribe = () => void;

export interface WatchStemRefilledOptions {
  /** URL hash's session component (the watcher fires only when this
   *  is the literal `'new'`). */
  currentSession: string | null;
  /** URL hash's work_dir component (used to compose the new hash
   *  via `selectSessionHash` and as the `session_list` query arg). */
  workDir: string;
  /** URL hash's token component. Required — the watcher no-ops
   *  without it. */
  token: string;
  /** Override the side-effect writer — production uses the default
   *  (writes `window.location.hash = ...`); tests inject a recorder
   *  to assert on the URL the watcher would have written without
   *  touching a real `window` (the web test environment runs in
   *  node, no jsdom — see choice-page-flow.test.ts comment on the
   *  intentional no-jsdom policy + ADR-0009 §决策 4). The default
   *  is the production writer. */
  writeHash?: (hash: string) => void;
}

/** Subscribe to `control/session_state` envelopes and refill the URL
 *  hash when the bridge broadcasts a real stem for the pending
 *  `'new'` session.
 *
 *  Returns an unsub function the caller MUST invoke on cleanup
 *  (StrictMode / dep-change / unmount). The function is a no-op
 *  when `currentSession !== 'new'` or `workDir === ''` or
 *  `token === ''` — callers don't need to gate the call site, but
 *  doing so avoids an unused listener attachment. */
export function watchStemRefilled(
  wsClient: WsClient,
  options: WatchStemRefilledOptions,
): Unsubscribe {
  const { currentSession, workDir, token } = options;
  const writeHash = options.writeHash ?? defaultWriteHash;
  // Gating: only act when the URL is in the pending 'new' state.
  // All other states (level=1, level=2, recovery with stem,
  // M3-compat token-only) → no listener attached.
  if (currentSession !== SESSION_NEW) {
    return () => {
      // no-op unsub; allows useEffect cleanup to call without
      // requiring the callsite to check the gate.
    };
  }
  if (token.length === 0 || workDir.length === 0) {
    return () => {
      /* no-op */
    };
  }

  const handler = (envelope: Envelope): void => {
    if (envelope.kind !== 'control' || envelope.type !== 'session_state') return;
    const newSession = envelope.session;
    // Skip pending / M3_LEGACY / session-less envelopes.
    if (
      newSession === undefined ||
      newSession === SESSION_NEW ||
      newSession === M3_LEGACY_KEY
    ) {
      return;
    }
    // Skip envelope without work_dir (defensive — bridge may omit
    // it; we can't refill the hash with an ambiguous work_dir).
    if (envelope.payload.work_dir === undefined) {
      return;
    }
    // Skip when broadcast work_dir doesn't match the URL's
    // work_dir (defensive — the pending manager and the broadcast
    // are guaranteed same work_dir by bridge logic; mismatch is a
    // signal that we're observing an unrelated session).
    if (envelope.payload.work_dir !== workDir) {
      return;
    }
    // Side effect 1: refill the hash. The `hashchange` listener
    // re-derives auth + updates WsClient mirror. Use the same
    // hash helper the rest of the app uses (single source of
    // truth — see hash.ts). `writeHash` is injectable so the
    // test surface (no jsdom) can record the would-be write
    // without touching `window.location`.
    writeHash(selectSessionHash(token, workDir, newSession));
    // Side effect 2: fire session_list re-query for the current
    // work_dir so ChoicePage level=2's mirror catches up (钉子 5
    // — stem 回填后重查).
    wsClient.sendSessionList(workDir);
  };

  const unsub = wsClient.on('session_state', handler);
  // Wrap so the caller can call unsub() twice without warning
  // (StrictMode double-invoke path).
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    unsub();
  };
}

// Re-export PROTOCOL_VERSION for test convenience (some tests may
// want to build envelopes with the same v tag — avoid importing
// from @remotepi/shared directly in test files).
export { PROTOCOL_VERSION };

/** Production hash writer — writes to `window.location.hash` which
 *  triggers App.tsx's `hashchange` listener (re-derives auth +
 *  updates WsClient mirror). The window-global write is wrapped in
 *  a feature-detect so the helper remains importable in node test
 *  environments where `window` is undefined — production bundles
 *  always have `window` (browser). */
function defaultWriteHash(hash: string): void {
  if (typeof window !== 'undefined') {
    window.location.hash = hash;
  }
}
