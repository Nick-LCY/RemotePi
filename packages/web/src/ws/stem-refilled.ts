// stem-refilled watcher — extracted from App.tsx for unit-testability
// (M4 task 08 review 修复轮 W8) + M4 验收期 4th gap 修复（task 11）。
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
// ## M4 验收期 4th gap 修复 — 流式打字机效果丢失
//
// 验收期发现：新会话首 turn 流式打字机效果被破坏——message_update
// delta 期间 ChatView 被 `RecoveryInFlight` 顶替，delta 一次性渲染
// 而非逐字出现。
//
// 根因（frame-level）：
//   - 新会话走 `createReadyGate()` ready gate（'new' 键，无仪式）；
//   - bridge pending → stem 迁移后 broadcast `session_state`；
//   - 本 watcher 回填 hash → App 重派发到 recovery 分支；
//   - gateForSession('<stem>') miss（'new' key ≠ '<stem>' key）→ 触发
//     全新 `initiateRecovery()` 仪式 → gate.ready === false → ChatView
//     卸载换 `<RecoveryInFlight/>`；
//   - message_update delta 仍写入 stem 桶（R4 迁移已搬迁）但无人渲染；
//   - 5s 仪式到点 + snapshot 落定 → ChatView 重挂 → 消息一次性出现。
//
// 修复（双管齐下）：
//   1. 【核心】`onRefill` 回调——App 在 watcher fire 时执行 gate 重键
//      （take-and-set）：`gateMap.set(stem, gateMap.get('new'))` +
//      `gateMap.delete('new')`。语义依据：迁移来的 stem 是"刚建的全新
//      会话"——历史为空，与 `session === 'new'` 走 `createReadyGate()`
//      的既有理由完全一致，不该跑 get_messages 恢复仪式。Hash 翻转后
//      `gateForSession(<stem>)` 命中既有 ready gate → ChatView 全程挂
//      载，流式不断。R4 桶迁移（WsClient 层）已保证数据随键迁移，
//      两层配合 ChatView 读写无缝。
//   2. 【次要】`sendSessionList` 推迟——回填瞬间触发会阻塞 turn 开头
//      ~309ms（实测 PiExperiment 22 文件 40MB 全目录扫描）。改为延迟
//      到该会话 `agent_settled`（phase → idle）后触发 + 3s debounce
//      兜底（whichever 先到即触发）。钉子 5 语义保持：stem 回填后
//      level2 列表会重查——只是推迟到本轮对话结束，用户退回 level2
//      前必然已刷新。
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
//   1. `window.location.hash = selectSessionHash(workDir, stem)`
//      → 触发 App.tsx 的 `hashchange` 监听器 → 重新派生 auth。
//      另外同步调用 `wsClient.setCurrentSessionKey(stem)`，先于查询
//      出站，确保查询 envelope.session 已是 stem。
//   2. `wsClient.sendSessionList(workDir)` → ChoicePage level=2
//      下次 mount 时拿到含新 session 的列表。
//
// 已知的两个良性副作用：
//   - 在途的旧 `session_list` 回执可能因 W4 的 reply-id 守卫被静默丢弃
//     一次；本 watcher 紧接着发出的 stem 查询会在下一 tick 收敛镜像。
//   - hash-derived session 与 WsClient 镜像在当前同步 tick 内可能短暂不一致；
//     watcher 先写镜像，随后 hashchange handler 写入同一个 stem，下一 tick
//     即收敛，不会产生第二个 manager 或错误的持久化 session。
////
// ## 设计要点：辅助函数 + 自管 listener
//
// `watchStemRefilled` 是 framework-free helper：传入 token / workDir
// + wsClient + onRefill 回调，返回一个 unsub 闭包。App.tsx 在 useEffect
// 内调用，deps 变化时 cleanup unsub。Effect 主体条件不满足时（如
// session 已非 'new'）→ 返回 no-op unsub，避免 React 警告。
//
// 测试用例（W8 落地 + 4th gap 增项）：见
// `packages/web/src/__tests__/stem-refilled.test.ts`。
// 1. session_state{session:<stem>} → onRefill fire + hash 写入 +
//    延迟 sendSessionList（test 11/12/13）。
// 2. session_state{session:'new'} → 不 fire（仍是 pending）。
// 3. session_state{session:undefined} → 不 fire（schema 防御）。
// 4. URL session 切到非 'new' 后 → 卸载后不 fire。
// 5. sendSessionList 推迟触发（fake timers / agent_settled）。

import { PROTOCOL_VERSION, type Envelope } from '@remotepi/shared';

import { SESSION_NEW, selectSessionHash } from '../hash.js';
import { M3_LEGACY_KEY, type WsClient } from './WsClient.js';

/** The return value of `watchStemRefilled` — an unsub closure.
 *  Calling it tears down the type listener immediately. Calling
 *  twice is safe (second call is a no-op). */
export type Unsubscribe = () => void;

/** Delay (ms) before the deferred `sendSessionList` is fired as a
 *  fallback when the agent never settles to `idle`/`exited` within
 *  this window. 钉子 5 重查在 turn 开头会触发 bridge 全目录扫描
 *  （~309ms 实测 PiExperiment 22 文件 40MB），推迟到 turn 结束即
 *  保证用户退回 level2 前列表已更新，又不阻塞流式。
 *
 *  3s 选定理由（PRD §4.2 + tasks/m4/07 §钉子 5）：
 *    - 常规 multi-delta 流式 turn（user prompt → llm call → 5 deltas
 *      → message_end → idle）总耗时通常 < 5s；3s 足够覆盖多数场景；
 *    - 偶发 cold start + LLM provider slow 路径下 3s 兜底触发仍
 *      显著优于 turn 开头触发的 309ms 阻塞（流式已开始，更晚的
 *      sendSessionList 不阻塞渲染）；
 *    - 与 PRD §6.1 RECOVERY_TIMEOUT_MS = 5s / PHASE_PROGRESS_TIMEOUT_MS
 *      = 15s 一致的设计节律：用户感知阈值 + 安全余量。 */
export const SESSION_LIST_DEFER_MS = 3_000;

export interface WatchStemRefilledOptions {
  /** URL hash's session component (the watcher fires only when this
   *  is the literal `'new'`). */
  currentSession: string | null;
  /** URL hash's work_dir component (used to compose the new hash
   *  via `selectSessionHash` and as the `session_list` query arg). */
  workDir: string;
  /** M5 §G6 / D9 — the token is no longer part of the hash. We
   *  keep this option for the watcher's internal gate (so the
   *  watcher can short-circuit when the user has explicitly
   *  cleared the token via the settings button before the
   *  stem refill lands) but the field is unused for hash
   *  composition — the new hash is `work_dir + session` only.
   *  Required for symmetry with the test surface (the
   *  test-injection path asserts on the option shape). */
  token: string;
  /** Override the side-effect writer — production uses the default
   *  (writes `window.location.hash = ...`); tests inject a recorder
   *  to assert on the URL the watcher would have written without
   *  touching a real `window` (the web test environment runs in
   *  node, no jsdom — see choice-page-flow.test.ts comment on the
   *  intentional no-jsdom policy + ADR-0009 §决策 4). The default
   *  is the production writer. */
  writeHash?: (hash: string) => void;
  /** M4 验收期 4th gap 修复——stem 重键回调。App 在 watcher 触发
   *  时执行 gate 重键（take-and-set）：
   *    `gateMap.set(stem, gateMap.get('new'))` + `gateMap.delete('new')`
   *  把 'new' 的 ready gate 移交到 stem 键，hash 翻转后
   *  `gateForSession(<stem>)` 命中既有 ready gate → ChatView 全程挂
   *  载，流式不断。
   *
   *  边界：
   *    - 'new' gate 不存在（如时序边缘：用户在 stem 到达前已退回
   *      level2）→ 回调应 no-op（fallback 维持既有 initiateRecovery
   *      路径，不崩）。
   *    - 回调 throw → 静默吞（log warn）继续后续副作用；这是用户
   *      回调编程错误的容差路径，watcher 的主流程（hash + sendList）
   *      不应被打断。
   *
   *  Production 调用点：App.tsx 通过 useCallback 闭包 gateMapRef
   *  传入；测试可注入 recorder 断言触发次数与参数。
   */
  onRefill?: (stem: string, workDir: string) => void;
  /** Override the deferred `sendSessionList` delay. Production uses
   *  `SESSION_LIST_DEFER_MS`（3s）；测试注入更短窗口以加速断言。 */
  deferMs?: number;
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
  const onRefill = options.onRefill;
  const deferMs = options.deferMs ?? SESSION_LIST_DEFER_MS;
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

  // M4 验收期 4th gap 修复——deferred sendSessionList 状态机。
  // 维护一个 `pendingDeferred` 单例；watcher fire 时若已存在则忽略
  // （防御：single-fire path 上 watcher 一生只 fire 一次——hash 一旦
  // 翻转回 'new' 不会被此 useEffect 重新激活，effect 已 unsub），
  // 但暴露显式 start/cancel 接口让 unsub 路径能取消挂起的 fire。
  let pendingDeferred: DeferredSend | null = null;

  // M4 验收期 4th gap 修复——refill 幂等标志。一旦真 stem fire
  // 过一次 handler 走完所有检查 + 副作用，后续同 stem 的
  // session_state 全部早退（hasRefilled gate 在最末尾）。
  let hasRefilled = false;

  const fireOrCancelDeferred = (reason: 'fire' | 'cancel'): void => {
    const deferred = pendingDeferred;
    if (deferred === null) return;
    pendingDeferred = null;
    if (reason === 'fire') {
      wsClient.sendSessionList(workDir);
    }
    // Always cancel both branches — clearTimeout + unsub phase listener.
    clearTimeout(deferred.timerHandle);
    try {
      deferred.phaseUnsub();
    } catch (err) {
      // Phase listener unsub throw 防御性吞（与 WsClient listener
      // 隔离策略一致）：unsub 失败不影响 sendSessionList 是否落地。
      // eslint-disable-next-line no-console
      console.warn('[stem-refilled] deferred phase listener unsub threw:', err);
    }
  };

  const startDeferredSessionList = (): void => {
    if (pendingDeferred !== null) return; // 防御：重复启动 no-op
    let fired = false;
    const fire = (): void => {
      if (fired) return;
      fired = true;
      fireOrCancelDeferred('fire');
    };
    const timerHandle = setTimeout(fire, deferMs);
    // M4 验收期 4th gap 修复（次要）——agent_settled 监听：
    // bridge session_state phase → 'idle' / 'exited' 立即触发
    // sendSessionList（agent 落定本轮 turn 结束，列表重查不阻塞
    // 流式）。浅相等守护由 wsClient.on 内部 fan-out 保证——
    // 同一 phase 多次广播由 App 层 useSessionPhase 浅相等吞掉，
    // 此处只关心 transition；重复调用 fire() 由 `fired` 标志吞。
    const phaseUnsub = wsClient.on('session_state', (env: Envelope) => {
      if (env.kind !== 'control' || env.type !== 'session_state') return;
      const phase = env.payload.phase;
      if (phase === 'idle' || phase === 'exited') {
        fire();
      }
    });
    pendingDeferred = { timerHandle, phaseUnsub };
  };

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
    // Skip the bridge's internal `pending-key` format
    // (`new:<work_dir>` — see task 06 §钉子 2). The bridge's outbound
    // wrapper forwards a pending manager's FIRST `session_state`
    // broadcast with `envelope.session === 'new:<work_dir>'` BEFORE
    // the migration (jsonl not yet on disk) — the migration broadcast
    // (with the real stem) is what we want to act on. Refilling the
    // hash with the pending key makes the URL `&session=new:<work_dir>`
    // which is a real stem from the bridge's view (Branch 1+2, not
    // Branch 3): the bridge map misses, the agent-dir scan finds no
    // jsonl for that name, and the subsequent recovery ceremony's
    // `get_state` / `get_messages` get rejected. Only the migration
    // broadcast (with the real stem) should drive the hash refill.
    if (newSession.startsWith('new:')) {
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
    // M4 验收期 4th gap 修复——refill 幂等性：
    //   watcher 在 URL 翻转回 'new' 之前（hashchange listener + React
    //   re-render + useEffect cleanup 是 async 链路）会持续接收
    //   session_state（phase 迁移：spawning → ready → running → idle）。
    //   每一帧都通过此 handler 路由——若不挡，第一次 fire 后的 sendSessionList
    //   debounce / agent_settled 触发后会清空 pendingDeferred，下一帧
    //   session_state 又 startDeferredSessionList 一个新的 → 重复
    //   触发 sendSessionList，污染 ChoicePage level=2 镜像节奏。
    //
    //   正确语义：refill 是单次事件——首次 fire 后已 stem 移交 + hash 翻转，
    //   后续同 stem 的 session_state 只更新 phase（recovery ceremony 内
    //   subscribeToSessionState 路径），不动 refill 副作用。
    //
    //   防御：跟踪 `hasRefilled`——一旦真 stem fire 过一次，后续同 stem
    //   的 session_state 全部 no-op。unsub 不重置（单次生命周期内）。
    //   注：原行为（非 4th gap 修复前）下同一问题也存在——每次都 fire
    //   sendSessionList——本修复是同一问题的同步根治。
    if (hasRefilled) return;
    // Side effect 1: gate rekey callback (M4 验收期 4th gap 核心)。
    // 在 writeHash 之前调用——App 的 onRefill 会执行 take-and-set
    // 把 'new' 的 ready gate 移交到 stem 键。Hash 翻转后
    // `gateForSession(<stem>)` 命中既有 ready gate → ChatView 不
    // 卸载换 `<RecoveryInFlight/>`，流式不断。
    //
    // 异常隔离：onRefill throw → log warn 继续后续副作用（hash +
    // setCurrentSessionKey + 延迟 sendSessionList）。回调编程错误
    // 不应阻断 watcher 的主流程；测试可注入 throw 回调验证隔离。
    if (onRefill !== undefined) {
      try {
        onRefill(newSession, workDir);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[stem-refilled] onRefill callback threw:', err);
      }
    }
    // Side effect 2: refill the hash. The `hashchange` listener
    // re-derives auth + updates WsClient mirror. Use the same
    // hash helper the rest of the app uses (single source of
    // truth — see hash.ts). `writeHash` is injectable so the
    // test surface (no jsdom) can record the would-be write
    // without touching `window.location`.
    writeHash(selectSessionHash(workDir, newSession));
    // Side effect 3: WsClient mirror update.
    //
    // CRITICAL ORDERING (e2e 修复 2026-09-09): we must update the
    // WsClient's `currentSessionKey` mirror SYNCHRONOUSLY before
    // any `sendSessionList` (now deferred) reads it. The watcher
    // fires inside the session_state dispatch (synchronous, before
    // the queued `hashchange` event flushes the App.tsx mirror
    // update) — without this write, the deferred sendSessionList
    // would still read `currentSessionKey === 'new'` (or worse,
    // race with the hashchange handler) and emit a session_list
    // envelope with `session: 'new'`. Post-migration that key is
    // gone (replaced by `<stem>`), so the lookup misses, the
    // bridge spawns a FRESH pending manager with no `--session`
    // flag, the new pi creates a SECOND jsonl, and the new manager
    // migrates to that different stem. Two managers, two jsonls,
    // second prompt lands on the wrong one — the test's history
    // assertion sees only one stem's messages.
    //
    // The deferred trigger fires later (after `agent_settled` /
    // debounce), at which point this mirror has been stable for
    // many ticks. The hashchange handler will later write the SAME
    // value, making the mirror a stable point rather than a
    // moving target.
    wsClient.setCurrentSessionKey(newSession);
    // Side effect 4: deferred sendSessionList (M4 验收期 4th gap
    // 次要)。不再 turn 开头同步触发（~309ms 全目录扫描阻塞），
    // 改为等到该会话 `agent_settled`（phase → idle/exited）或
    // 3s 兜底后触发（whichever 先到）。
    startDeferredSessionList();
    // M4 验收期 4th gap 修复——refill 幂等性 seal：标记已 fire 过，
    // 后续同 stem 的 session_state 走顶部 `if (hasRefilled) return`
    // 早退，避免重复触发 deferred sendSessionList 副作用（详见上方
    // handler JSDoc 备注）。
    hasRefilled = true;
  };

  const unsub = wsClient.on('session_state', handler);
  // Wrap so the caller can call unsub() twice without warning
  // (StrictMode double-invoke path).
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    unsub();
    // 清理挂起的 deferred state：unsub 时若仍有 pending fire，
    // 取消掉（用户可能已退回 level2 / 换 session，延迟 fire 落地
    // 会污染 level2 列表 / 触发不必要的 outbound）。
    fireOrCancelDeferred('cancel');
  };
}

/** M4 验收期 4th gap 修复——deferred sendSessionList 内部状态。
 *  闭包封装 setTimeout 句柄 + phase 监听 unsub，由
 *  `fireOrCancelDeferred` 统一清理（任何路径 fire / cancel 都会
 *  clearTimeout + phaseUnsub，二者一致清理避免泄漏）。 */
interface DeferredSend {
  readonly timerHandle: ReturnType<typeof setTimeout>;
  readonly phaseUnsub: () => void;
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
