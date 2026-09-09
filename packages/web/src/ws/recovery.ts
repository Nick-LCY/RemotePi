// RemotePi web — M3 dual-query recovery ceremony (PRD §4.4) + M4
// 5s timeout fix (PRD §6 / tasks/m4/01).
//
// On every (re)connect the web fires a parallel pair of queries the
// moment the WebSocket is open and the handshake has been sent:
//
//   pi/get_messages     { id: m1 }       — pull authoritative history
//   control/get_state   { id: g1 }       — pull session state
//                                          (phase + blocked_on?)
//
// Both replies must arrive before the chat surface mounts. The
// handshake itself is fire-and-forget (no ack) — its only purpose
// is to authenticate the connection; the bridge may take a few
// ticks before it forwards a session_list, so the recovery must
// start as soon as the socket opens, not after the handshake is
// acked. The handshake-replies bridge_status is the bridge-online
// signal (carried over from M2), not the recovery gate.
//
// Failure handling (PRD §4.4): either reply missing for
// `RECOVERY_TIMEOUT_MS` (or arriving with `ok: false` /
// `success: false` / a malformed data payload) flips the gate to
// a failure state and the UI shows a "恢复失败" card with a
// manual retry button. The ceremony is never silent — every
// timeout is observed, every failure state is surfaced, every
// successful run mounts the chat surface exactly once.
//
// M4 timeout fix (PRD §6 / tasks/m4/01, B+C 合体方案):
//   - **C (核心)** — snapshot 腿从"绝对 5s"改为"无进度窗口":
//     `RECOVERY_TIMEOUT_MS` 保留作"无任何相位变化即失败"兜底；
//     新增 `PHASE_PROGRESS_TIMEOUT_MS = 15_000` —— 仪式内注册
//     `session_state` 监听（必须走 `ceremony.unsubs` 清理数组，
//     StrictMode / retry 安全），看到 sessionPhase 字段实际变化
//     （spawning / ready / running / idle 迁移）→ 重置 snapshot
//     定时器为 15s 窗口；`blocked_on`-only 广播不重置（严格只认
//     相位字段实际变化）。
//   - **B (辅助)** — `bridgeStatus.online === false` 立即失败
//     （`null` 不算离线——冷启动误杀防护）；新增 `bridge_offline`
//     错误三态，UI 文案区分"bridge 离线"与 snapshot/state 失败。
//
// The gate is framework-free (plain object + subscribe), so the
// React layer in `App.tsx` can plug it into `useSyncExternalStore`
// without coupling the ceremony to React's lifecycle. The
// WsClient reference is held for the gate's lifetime — disconnect
// the WsClient and the gate's pending timers will simply expire
// to `both_failed` and the user retries.

import { PROTOCOL_VERSION, type Envelope, type SessionPhase } from '@remotepi/shared';

import type { BridgeStatusInfo, WsClient } from './WsClient.js';
import { tryDecodeGetStateData } from './WsClient.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-reply baseline deadline for the dual-query ceremony. The
 *  PRD §4.4 quotes "5s" and calls it adjustable; the value is
 *  intentionally generous because a `get_messages` arriving during
 *  `exited` phase has to wake a pi subprocess (PRD §2.7) before
 *  it can produce a snapshot. On a healthy machine the round-trip
 *  is well under one second; 5s is the safety net for cold-start
 *  + slow disks.
 *
 *  M4 修订注记（tasks/m4/01 B+C 方案）—— 常量**保留**但语义改
 *  为"无进度窗口兜底"：
 *  - snapshot 定时器初始值 = `RECOVERY_TIMEOUT_MS`（5s）——仪式
 *    启动后 5s 内若**无任何 sessionPhase 变化**，视为 pi 冷启动
 *    失败 / 网络静默失败 → 判 `snapshot_failed`。
 *  - 一旦看到 sessionPhase 实际变化 → snapshot 定时器重置为
 *    `PHASE_PROGRESS_TIMEOUT_MS`（15s，见下），5s 兜底失效。
 *  - state 定时器仍以 `RECOVERY_TIMEOUT_MS` 为死线（state 包小
 *    且源自 bridge 内存视图，5s 足够）。 */
export const RECOVERY_TIMEOUT_MS = 5_000;

/** Snapshot "with-progress" deadline — the snapshot timer is reset
 *  to this value on every observed `sessionPhase` change (M4 §6.1
 *  / tasks/m4/01）。15s 足够覆盖 pi 冷启动 + bridge → worker →
 *  pi 完整握手 + 派生 → snapshot 落地的整链路（实测 pi 启动
 *  ~500ms，bridge spawn + handshake + idle 唤醒余量 10s+）。 */
export const PHASE_PROGRESS_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Recovery failure discriminator. M4 增 `bridge_offline`：B 方案
 *  检测到 `bridgeStatus.online === false` 时立即失败（`null` 不
 *  触发——冷启动期间 `bridge_status` 未补发是常态），UI 文案独立
 *  区分"bridge 离线"与 snapshot/state 失败。UI 层 `RecoveryErrorCard`
 *  按 `bridge_offline` > `both_failed`（文案已暗示 bridge 离线）
 *  > `snapshot_failed` > `state_failed` 优先级渲染。 */
export type RecoveryError =
  | 'snapshot_failed'
  | 'state_failed'
  | 'both_failed'
  | 'bridge_offline';

/** Snapshot of the gate's externally-visible state. `ready` and
 *  `error` are mutually exclusive in steady state (ready=true
 *  implies error=null, error!==null implies ready=false); during
 *  the in-flight window both are false / null. */
export interface RecoveryState {
  ready: boolean;
  error: RecoveryError | null;
}

/** Recovery ceremony handle. Lives across React re-renders
 *  (caller keeps one per component instance via useRef). The gate's lifetime follows
 *  its owning component instance; active ceremony timers and listeners
 *  are cancelled by retry or naturally become inert when no listeners
 *  remain.
 *
 *  `getSnapshot` and `subscribe` are exposed as **arrow field
 *  references** (bound at gate-construction time, not methods
 *  re-bound per access) so React's `useSyncExternalStore` sees a
 *  stable function identity across renders. This is the contract
 *  useSyncExternalStore wants — `getSnapshot` must also return a
 *  stable reference when the underlying state hasn't changed (see
 *  the cached `snapshot` field in `initiateRecovery`). Returning
 *  a fresh `{ ready, error }` object on every call would trip
 *  React's referential-equality check and trigger an infinite
 *  re-render loop (PRD §-bug-2026-09-07 — `Maximum update depth
 *  exceeded`). */
export interface RecoveryGate {
  /** Read the current `ready` / `error` pair. Returns the
   *  cached snapshot reference verbatim — identity is preserved
   *  across calls when the gate hasn't transitioned, so
   *  `useSyncExternalStore` skips re-render. Stable per gate
   *  instance (arrow field, not a method). */
  getSnapshot: () => RecoveryState;
  /** Subscribe to gate state changes. Fires on every transition
   *  (in-flight → ready, in-flight → error, error → in-flight on
   *  retry, etc.). Returns an unsubscribe function. Stable per
   *  gate instance (arrow field). */
  subscribe: (listener: () => void) => () => void;
  /** Trigger a fresh ceremony. Idempotent in the sense that a
   *  call from the UI's "retry" button always restarts from
   *  scratch — any in-flight ceremony is cancelled (its timers
   *  cleared, its reply-resolvers unsubscribed) and a new pair
   *  of dual queries goes out.
   *
   *  The gate intentionally exposes no `dispose()` entry point —
   *  the host component owns the gate for its lifetime via
   *  `useRef`, and listeners are torn down naturally when
   *  `useSyncExternalStore`'s unsubscribe closure runs (the
   *  effect cleanup the host does NOT install for the gate).
   *  Inert timers and reply-resolvers either fire into an empty
   *  listener set or no-op on `stale`, so an unmounted gate
   *  holds no live state worth actively cleaning up. */
  retry(): void;
}

// ---------------------------------------------------------------------------
// Initiator
// ---------------------------------------------------------------------------

/** Test seams — production callers use the default. The options
 *  bag lets unit tests inject deterministic ids + a custom timeout
 *  without monkey-patching globals. */
export interface InitiateRecoveryOptions {
  /** Override the baseline 5s per-reply timeout (state side + initial
   *  snapshot timer). M4 修订后语义 = "无进度窗口兜底"。 */
  timeoutMs?: number;
  /** Override the 15s "with-progress" snapshot timeout (M4 §6.1）。
   *  在仪式内看到 sessionPhase 实际变化后，snapshot 定时器重置为
   *  此值。 */
  phaseProgressTimeoutMs?: number;
  /** Override the id generator. Production uses `crypto.randomUUID`
   *  so each ceremony's m1 / g1 ids are unique even across
   *  retries in the same session. Tests inject a deterministic
   *  sequence to assert on the wire shape. */
  makeId?: () => string;
  /** Optional notification hook fired on every gate transition.
   *  Production callers don't need this (the React layer observes
   *  via `subscribe`) — tests use it to assert on the transition
   *  order without juggling the subscribe dance. The hook receives
   *  the post-transition `RecoveryState` snapshot. */
  onTransition?: (state: RecoveryState) => void;
  /** M4 task 08 review 修复轮 R3——仪式在出站信封上携带
   *  `envelope.session` 字段（来自当前 URL hash 的 session
   *  分量）。语义：
   *  - `undefined` / `null`：仪式保持 M3 形态（session-less
   *    envelope），bridge 的 M3_LEGACY manager 接 auto-spawn 路径。
   *    task 08 review 决定保留 M3-compat fallback 以服务 e2e / 旧
   *    链接——R6 e2e 迁移后此 fallback 仅服务调试场景。
   *  - 字符串：仪式在 `pi/get_messages` 与 `control/get_state` 两
   *    个信封上携带 `envelope.session`，bridge 按 session 路由到
   *    对应 manager（M4 normal flow）。
   *
   *  App.tsx 的 RecoveryShell 调用点从 `currentSessionKey` 镜像
   *  传入。`currentSessionKey === null`（M3 token-only URL）
   *  时传 `null`，仪式保持 session-less。
   *
   *  `workDir` 同样传给仪式：session='new' 的仪式需要把 work_dir
   *  写入 `pi/get_messages` payload 以满足 bridge pending-key 路由
   *  的需求（钉子 2：new 必带 work_dir）。M3-compat fallback
   *  （sessionKey=null）不需要 work_dir。M4 normal flow（真 stem）
   *  不需要——work_dir 仅 session='new' 时塞 payload。*/
  sessionKey?: string | null;
  /** Work directory 镜像（来自 URL hash 的 work_dir 分量）。仪式
   *  在 `sessionKey === 'new'` 时把它塞进 `pi/get_messages` 与
   *  `control/get_state` 两个信封的 payload.work_dir 字段，以启动
   *  bridge 的 pending-key 路由。App.tsx RecoveryShell 调用点从
   *  `currentWorkDir` 镜像传入；sessionKey 不是 'new' 时该字段被
   *  忽略。*/
  workDir?: string | null;
}

export function initiateRecovery(
  wsClient: WsClient,
  options: InitiateRecoveryOptions = {},
): RecoveryGate {
  const timeoutMs = options.timeoutMs ?? RECOVERY_TIMEOUT_MS;
  const phaseProgressTimeoutMs = options.phaseProgressTimeoutMs ?? PHASE_PROGRESS_TIMEOUT_MS;
  const makeId = options.makeId ?? defaultMakeId;
  const onTransition = options.onTransition;
  const sessionKey = options.sessionKey ?? null;
  const workDir = options.workDir ?? null;

  // ---- state ---------------------------------------------------------------
  // Cached snapshot — replace-on-change semantics. `useSyncExternalStore`
  // calls `getSnapshot` on every render and compares the result to the
  // previous call's return with `Object.is`. Returning a freshly
  // constructed `{ ready, error }` on every call (the bug we are fixing)
  // always trips that check and triggers an infinite re-render loop —
  // the previous version of this file was the cause of the
  // `Maximum update depth exceeded` crash at RecoveryView mount.
  //
  // The contract enforced below: `snapshot` is replaced ONLY when one
  // of its fields actually changes (`setState` does the equality guard).
  // `getSnapshot` returns the cached reference verbatim, so React sees
  // identity-stable output across re-renders that don't transition the
  // gate and skips the re-render. The arrow-field binding on the gate
  // object further guarantees the getSnapshot *function* is identity
  // stable too — passing a fresh `() => snapshot` inline would not
  // cause a loop by itself, but the spec asks for it and it lets the
  // App.tsx call site drop its wrapping arrow.
  let snapshot: RecoveryState = { ready: false, error: null };
  const listeners = new Set<() => void>();
  let active: ActiveCeremony | null = null;

  const setState = (next: { ready: boolean; error: RecoveryError | null }): void => {
    // Replace-on-change: equal in both fields → no-op (preserves the
    // current snapshot reference AND suppresses the listener fan-out).
    // This is the second half of the snapshot-stability contract —
    // without it, an idempotent transition (e.g. retry() while the
    // gate is already in `error`) would emit a state-change event
    // and force consumers to re-render on no information.
    if (snapshot.ready === next.ready && snapshot.error === next.error) return;
    snapshot = { ready: next.ready, error: next.error };
    if (onTransition !== undefined) {
      try {
        onTransition(snapshot);
      } catch (err) {
        // Tests should not throw, but a buggy hook must not
        // disrupt the React-side subscribers. Logged-and-swallowed
        // (matches the WsClient dispatchReplyResolvers policy) so
        // a test bug surfaces in the operator console instead of
        // being silently lost — the ceremony's invariants (timer
        // firing, gate transitions) keep going regardless.
        // eslint-disable-next-line no-console
        console.warn('[recovery] onTransition hook threw:', err);
      }
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        // Logged-and-swallowed — mirrors WsClient's listener
        // isolation policy. One bad subscriber doesn't break the
        // rest of the chain; the throw itself is operator-visible.
        // eslint-disable-next-line no-console
        console.warn('[recovery] gate subscriber threw:', err);
      }
    }
  };

  // ---- per-attempt ceremony ------------------------------------------------

  /** Internal mutable record of an in-flight attempt. The
   *  resolver callbacks close over the instance so the right
   *  attempt's outcome is recorded (a stale attempt is dropped
   *  by setting `stale = true` on disposal / retry). */
  const startCeremony = (): void => {
    // Cancel any in-flight attempt first — its timers must not
    // fire after a new attempt's state has been set, and its
    // resolvers must not see this attempt's replies. We cancel
    // the active ceremony which clears timers + unsubscribes.
    cancelActive();
    setState({ ready: false, error: null });
    const messagesId = makeId();
    const stateId = makeId();
    const ceremony: ActiveCeremony = {
      messagesId,
      stateId,
      snapshotOutcome: 'pending',
      stateOutcome: 'pending',
      // M4 §6.1: initial `lastSeenPhase` 镜像仪式启动瞬间的
      // `wsClient.sessionPhase`；后续 `subscribeToSessionState`
      // 收到不同 phase 时重置 snapshot 定时器。
      lastSeenPhase: wsClient.sessionPhase,
      // M4 B 方案：仪式启动时如果 bridgeStatus 已知为 offline，
      // 立刻标记；后续 `subscribeToBridgeStatus` 也可触发。
      bridgeOfflineDetected: false,
      // snapshot 定时器句柄（独立于 `timers` Set——它的"重置"
      // 语义决定我们需直接持有句柄以 `clearTimeout`）。
      snapshotTimerHandle: null,
      stale: false,
      timers: new Set(),
      unsubs: [],
    };
    active = ceremony;

    // Register reply resolvers BEFORE sending — the WebSocket
    // send is synchronous (writes to the open socket) so a
    // reply can only arrive via the event loop after this
    // function returns. Registering after the send would leave
    // a window where the reply arrives before the resolver is
    // installed and is silently dropped.
    ceremony.unsubs.push(
      wsClient.registerReplyResolver(messagesId, (env) => {
        ceremony.snapshotOutcome = evaluateSnapshotOutcome(env) ? 'ok' : 'fail';
        checkComplete(ceremony);
      }),
    );
    ceremony.unsubs.push(
      wsClient.registerReplyResolver(stateId, (env) => {
        ceremony.stateOutcome = evaluateStateOutcome(env) ? 'ok' : 'fail';
        checkComplete(ceremony);
      }),
    );

    // M4 §6.1 C 方案：snapshot 定时器初始值 = `RECOVERY_TIMEOUT_MS`
    // （5s 兜底——仪式启动后 5s 内若无 phase 变化即失败）。收到
    // session_state phase 实际变化时通过 `armSnapshotTimer(
    // phaseProgressTimeoutMs)` 重置为 15s 窗口。
    armSnapshotTimer(ceremony, timeoutMs);

    // State 定时器仍以 `RECOVERY_TIMEOUT_MS` 为死线（state
    // 包小且源自 bridge 内存视图，5s 足够）。
    ceremony.timers.add(
      setTimeout(() => {
        if (ceremony.stale) return;
        if (ceremony.stateOutcome === 'pending') {
          ceremony.stateOutcome = 'fail';
        }
        checkComplete(ceremony);
      }, timeoutMs),
    );

    // M4 §6.1 C 方案——仪式内注册 `session_state` 监听：内部
    // 返回的 unsub 注册到 `ceremony.unsubs` 清理数组（沿用现有
    // 仪式 unsubscribe 模式，StrictMode / retry 安全）。看到
    // sessionPhase 字段实际变化（spawning / ready / running / idle
    // 迁移）→ 重置 snapshot 定时器为 `PHASE_PROGRESS_TIMEOUT_MS`。
    // `blocked_on`-only 广播不重置——我们的 listener 只关心
    // `envelope.payload.phase` 字段本身，不读取 blocked_on，
    // 浅相等守护天然挡重复帧（lastSeenPhase === newPhase）。
    ceremony.unsubs.push(
      subscribeToSessionState(wsClient, (newPhase) => {
        if (ceremony.stale) return;
        if (newPhase === ceremony.lastSeenPhase) return;
        ceremony.lastSeenPhase = newPhase;
        armSnapshotTimer(ceremony, phaseProgressTimeoutMs);
      }),
    );

    // M4 §6.1 B 方案——仪式内注册 `bridge_status` 监听：同样走
    // `ceremony.unsubs` 清理；看到 `online === false` 立即标记
    // 失败（`null` 不触发——冷启动期间 `bridge_status` 未补发是
    // 常态，避免误杀）。仪式启动时若当前 bridgeStatus 已知为
    // offline 也同步标记（不等待下一帧）。
    const initialBridgeStatus = wsClient.bridgeStatus;
    if (initialBridgeStatus !== null && initialBridgeStatus.online === false) {
      ceremony.bridgeOfflineDetected = true;
    }
    ceremony.unsubs.push(
      subscribeToBridgeStatus(wsClient, (status) => {
        if (ceremony.stale) return;
        if (status.online === false) {
          ceremony.bridgeOfflineDetected = true;
          checkComplete(ceremony);
        }
      }),
    );

    // Parallel send — handshake has no ack (PRD §4.4), so the
    // queries are legal the moment the socket is open. The
    // WsClient.send() path silently drops if the socket isn't
    // open yet; in that case both replies time out at `timeoutMs`
    // and the gate flips to `both_failed`. The RecoveryView
    // defers the first start until `connState === 'online'`
    // precisely to avoid this drop — the `getSnapshot` /
    // `subscribe` shape above supports that without coupling
    // the ceremony to connection state.
    //
    // R3 review 修复轮——`envelope.session` 字段携带。语义：
    //   - `sessionKey !== null`：M4 normal flow，bridge 按 session
    //     路由（manager 命中或 pending-key auto-spawn）。
    //   - `sessionKey === null`：M3-compat fallback，bridge 走
    //     `M3_LEGACY_KEY` auto-spawn（M3 token-only 链接的路径）。
    // `session === 'new'`（pending 占位）允许携带——bridge 用
    // `new:<work_dir>` 内部键路由 + 派生后 stem 回填。R6 e2e
    // 迁移后仪式在 M4 流下携带真实 session 或 `'new'`，M3
    // fallback 仅在调试 / 旧链接场景生效。
    const sessionField = sessionKey !== null ? { session: sessionKey } : {};
    // R3 review 修复轮——`session: 'new'` 的仪式需要 work_dir
    // 才能让 bridge pending-key 路由生效（钉子 2）：
    // `getOrCreateManagerForSession` 读取 `payload.work_dir`
    // 动态判断 work_dir——session='new' 缺 work_dir 会被判为
    // invalid_envelope。共享 GetMessagesPayloadSchema 仅含
    // `since`（zod 默认 strip 模式：多余字段被剥离但 schema
    // 通过），所以 web 端在 payload 上附加 `work_dir` 后，
    // bridge 端按动态 narrowing 读到 work_dir，shared 不动。
    //
    // M3-compat fallback（sessionKey=null）不发 work_dir——
    // bridge 走 M3_LEGACY auto-spawn 路径，不需 work_dir。
    // 真 stem（sessionKey=<stem>）也不需要——session 路由已
    // 命中 manager。仅 sessionKey='new' 时塞 work_dir。
    const needsWorkDir = sessionKey === 'new' && workDir !== null;
    const messagesPayload: Record<string, unknown> = {};
    const statePayload: Record<string, unknown> = {};
    if (needsWorkDir) {
      messagesPayload['work_dir'] = workDir;
      statePayload['work_dir'] = workDir;
    }
    // TODO 任务 09：work_dir 进 GetMessagesPayloadSchema / GetStatePayloadSchema
    // 显式字段——本轮最小侵入用 cast 钉桩（zod default = strip，多余
    // 字段在 worker.safeParse 被剥离但 schema 通过；bridge 端按
    // 动态 narrowing 读到 work_dir，shared 不动）。TypeScript
    // 推荐用法：直接断言到 envelope schema 的 payload 类型，因为
    // `Record<string, unknown>` 的所有字段值都是 `unknown`，
    // 本身可以看作"任何对象"的扩展——lint 视为"无需断言"。
    const getMessagesEnvelope = {
      v: PROTOCOL_VERSION,
      kind: 'pi' as const,
      type: 'get_messages' as const,
      id: messagesId,
      ...sessionField,
      payload: messagesPayload,
    };
    const getStateEnvelope = {
      v: PROTOCOL_VERSION,
      kind: 'control' as const,
      type: 'get_state' as const,
      id: stateId,
      ...sessionField,
      payload: statePayload,
    };
    wsClient.send(getMessagesEnvelope);
    wsClient.send(getStateEnvelope);
  };

  /** Per-reply outcome: `pi/snapshot` with the matching reply_to
   *  is the only success path. Any other envelope (including
   *  a `control/result` that happens to carry the snapshot's
   *  id) is treated as failure — defensive against a future
   *  bridge that mistakenly cross-routes. */
  const evaluateSnapshotOutcome = (env: Envelope): boolean => {
    return env.kind === 'pi' && env.type === 'snapshot';
  };

  /** Per-reply outcome for the `control/get_state` reply.
   *  Delegates to `tryDecodeGetStateData` (shared with the
   *  WsClient's central `case 'result':` handler) so the
   *  `SessionStatePayloadSchema` check lives in one place —
   *  the ceremony's verdict stays consistent with the WsClient's
   *  "would this have mutated store state?" answer. */
  const evaluateStateOutcome = (env: Envelope): boolean => {
    return tryDecodeGetStateData(env) !== null;
  };

  /** Arm / re-arm the snapshot timer. M4 §6.1 C 方案核心：
   *  - 仪式启动时调用 `armSnapshotTimer(ceremony, timeoutMs)`
   *    （= 5s 兜底）；
   *  - 收到 sessionPhase 实际变化后调用
   *    `armSnapshotTimer(ceremony, phaseProgressTimeoutMs)`
   *    （= 15s with-progress 窗口）。
   * 每次重置前先 `clearTimeout` 旧句柄——`snapshotTimerHandle`
   * 持有当前活跃句柄，外部 `cancelActive` 通过 `timers` Set 仍可
   * 清掉，但重置场景必须直持句柄。timer 自身触发时把
   * `snapshotOutcome` 标 'fail' 并触发 `checkComplete`，与
   * state timer 同形。 */
  const armSnapshotTimer = (ceremony: ActiveCeremony, delayMs: number): void => {
    if (ceremony.stale) return;
    if (ceremony.snapshotTimerHandle !== null) {
      clearTimeout(ceremony.snapshotTimerHandle);
      ceremony.snapshotTimerHandle = null;
    }
    const handle = setTimeout(() => {
      // Handle fired — drop reference so a future arm() call
      // doesn't try to clearTimeout a stale id.
      if (ceremony.snapshotTimerHandle === handle) {
        ceremony.snapshotTimerHandle = null;
      }
      if (ceremony.stale) return;
      if (ceremony.snapshotOutcome === 'pending') {
        ceremony.snapshotOutcome = 'fail';
      }
      checkComplete(ceremony);
    }, delayMs);
    ceremony.snapshotTimerHandle = handle;
  };

  /** Per-reply outcome resolution: when BOTH replies have
   *  resolved (or timed out), tear down the active ceremony
   *  and update the gate's externally-visible state. The
   *  active-pointer check guards against the (admittedly
   *  unreachable-in-practice) case where a stale attempt's
   *  late timer fires after a fresh attempt has taken over.
   *
   *  M4 §6.1 B 方案——`bridgeOfflineDetected` 优先级最高：仪式
   *  检测到 bridge 离线立即失败（不等 snapshot / state 任一
   * 回应），错误态 = `bridge_offline`。仅当仪式 active 且非 stale
   * 时生效。 */
  const checkComplete = (ceremony: ActiveCeremony): void => {
    if (ceremony.stale) return;
    if (active !== ceremony) return;
    if (ceremony.bridgeOfflineDetected) {
      cancelActive();
      setState({ ready: false, error: 'bridge_offline' });
      return;
    }
    if (ceremony.snapshotOutcome === 'pending' || ceremony.stateOutcome === 'pending') return;
    cancelActive();
    if (ceremony.snapshotOutcome === 'ok' && ceremony.stateOutcome === 'ok') {
      setState({ ready: true, error: null });
      return;
    }
    const snapshotOk = ceremony.snapshotOutcome === 'ok';
    const stateOk = ceremony.stateOutcome === 'ok';
    let nextError: RecoveryError;
    if (!snapshotOk && !stateOk) {
      nextError = 'both_failed';
    } else if (!snapshotOk) {
      nextError = 'snapshot_failed';
    } else {
      nextError = 'state_failed';
    }
    setState({ ready: false, error: nextError });
  };

  /** Tear down the active ceremony: clear timers (incl. snapshot
   *  timer handle), unsubscribe reply resolvers + session_state /
   *  bridge_status listeners, mark stale so a late callback is a
   *  no-op. Idempotent. M4 增项：`snapshotTimerHandle` 也需
   *  clearTimeout——重置路径用同一个 handle，跟 `timers` Set
   * 共享清理语义。 */
  const cancelActive = (): void => {
    const current = active;
    if (current === null) return;
    current.stale = true;
    if (current.snapshotTimerHandle !== null) {
      clearTimeout(current.snapshotTimerHandle);
      current.snapshotTimerHandle = null;
    }
    for (const timer of current.timers) {
      clearTimeout(timer);
    }
    current.timers.clear();
    for (const unsub of current.unsubs) {
      try {
        unsub();
      } catch (err) {
        // Logged-and-swallowed — mirrors the WsClient dispatch
        // path. A buggy unsubscribe (e.g. a thrown cleanup
        // closure) must not break the rest of the cancel-active
        // sequence (we still want to clear the remaining unsubs
        // + the timer set, even if the first unsubscribe throws).
        // The throw itself is operator-visible so a programming
        // error in the resolver-cleanup path doesn't go silent.
        // eslint-disable-next-line no-console
        console.warn('[recovery] cancelActive unsubscribe threw:', err);
      }
    }
    current.unsubs.length = 0;
    active = null;
  };

  // ---- public surface ------------------------------------------------------

  // `getSnapshot` and `subscribe` are arrow fields (not shorthand
  // methods) so the references are stable per gate instance. React's
  // `useSyncExternalStore` doesn't crash on a fresh function ref each
  // render, but it does re-validate and re-subscribe on every identity
  // change — keeping these as bound arrow fields makes that cost zero
  // AND satisfies `@typescript-eslint/unbound-method` without the
  // consumer having to wrap each call site in another arrow. The
  // App.tsx RecoveryView can now write `useSyncExternalStore(gate
  // .subscribe, gate.getSnapshot)` directly.
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry: startCeremony,
  };
}

/** Build a no-op gate that is ALREADY in the `ready: true` state
 *  — used when the recovery ceremony cannot meaningfully run.
 *  Primary use case: `session: 'new'` (the bridge has no manager
 *  for the 'new' key until the first pi/prompt creates the pending
 *  manager; running `get_messages` / `get_state` against it returns
 *  `invalid_envelope` / `no manager`). The new session has empty
 *  history by definition — there's nothing to recover. ChatView
 *  renders immediately; the user's first prompt triggers the
 *  bridge pending-key spawn, then the App.tsx stem-refilled watcher
 *  (W8) refills the hash with the real stem and the next session
 *  change gets a real ceremony.
 *
 *  `retry()` is wired to a no-op — re-pressing "重试" on a no-op
 *  gate does nothing (the gate never enters the error state, so
 *  the menu item isn't shown; the implementation is defensive). */
export function createReadyGate(): RecoveryGate {
  const snapshot: RecoveryState = { ready: true, error: null };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {
      // no listeners — no-op
    },
    retry: () => {
      // no-op — already ready
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ActiveCeremony {
  readonly messagesId: string;
  readonly stateId: string;
  snapshotOutcome: 'pending' | 'ok' | 'fail';
  stateOutcome: 'pending' | 'ok' | 'fail';
  /** M4 §6.1 C 方案：仪式启动瞬间镜像 `wsClient.sessionPhase`，
   *  后续 `subscribeToSessionState` 收到不同 phase 时重置
   *  snapshot 定时器。`null` → 'spawning' 同样是实际变化（重置）。 */
  lastSeenPhase: SessionPhase | null;
  /** M4 §6.1 B 方案：bridgeStatus.online === false 时置位（启动时
   *  若已知离线也立刻置位），`checkComplete` 看到此标志立即判
   *  `bridge_offline`。 */
  bridgeOfflineDetected: boolean;
  /** M4 §6.1 C 方案：snapshot 定时器句柄——`armSnapshotTimer` 重置
   *  时需 `clearTimeout` 旧句柄，独立于 `timers` Set（state 定时器
   *  与 reply resolvers 走 Set，重置场景唯一）。 */
  snapshotTimerHandle: ReturnType<typeof setTimeout> | null;
  /** Set true on retry-cancellation. Late timer
   *  firings + late reply-resolver callbacks observe this and
   *  short-circuit instead of mutating the (now-cancelled)
   *  attempt's outcome. */
  stale: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  unsubs: Array<() => void>;
}

function defaultMakeId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Ceremony-internal subscribers — M4 §6.1 B+C 方案
// ---------------------------------------------------------------------------

/** Subscribe to `control/session_state` envelopes and yield the
 *  authoritative `phase` value on every broadcast. Designed to be
 *  registered into `ceremony.unsubs` (StrictMode / retry 安全):
 *  the returned unsub 闭包闭包了 `wsClient.on('session_state', ...)`
 *  的返回 unsub，外部代码需将它 push 到 `ceremony.unsubs` 以走
 *  `cancelActive` 的统一清理路径。
 *
 *  浅相等由调用方负责（ceremony 在 `lastSeenPhase === newPhase`
 *  时直接 return），本函数不重复比较——`session_state.blocked_on`
 *  变化的广播仍是 `session_state` 信封但 `payload.phase` 不变，
 *  调用方因此拒绝重置 snapshot 定时器（PRD §技术裁定 2 严格只认
 *  相位字段变化）。 */
export function subscribeToSessionState(
  wsClient: WsClient,
  onPhaseChange: (phase: SessionPhase) => void,
): () => void {
  return wsClient.on('session_state', (envelope) => {
    if (envelope.kind !== 'control' || envelope.type !== 'session_state') return;
    onPhaseChange(envelope.payload.phase);
  });
}

/** Subscribe to `control/bridge_status` envelopes and yield a
 *  fully-formed `BridgeStatusInfo` (含 `receivedAt = Date.now()`)
 *  on every broadcast. 与 `subscribeToSessionState` 同模式——返回
 *  unsub 需 push 到 `ceremony.unsubs` 以走 `cancelActive` 清理。
 *
 *  调用方负责解读 `status.online === false` 并标记仪式失败；
 *  本函数不主动设错误状态，保证仪式唯一真相源 = ceremony 内的
 *  `bridgeOfflineDetected` 字段。`null` / `online === true` 状态
 *  不产生错误（冷启动误杀防护）。 */
export function subscribeToBridgeStatus(
  wsClient: WsClient,
  onBridgeStatusChange: (status: BridgeStatusInfo) => void,
): () => void {
  return wsClient.on('bridge_status', (envelope) => {
    if (envelope.kind !== 'control' || envelope.type !== 'bridge_status') return;
    onBridgeStatusChange({
      online: envelope.payload.online,
      changedAt: envelope.payload.changed_at,
      reason: envelope.payload.reason,
      receivedAt: Date.now(),
    });
  });
}
