// App root — owns:
//   1. The single WsClient instance (memoized for StrictMode safety).
//   2. The hash → three-field derivation (`token` + `work_dir` +
//      `session`, M4 钉子 1). URL convention is
//      `#<token>&work_dir=<encoded>&session=<key|new>`; missing
//      fields are tolerated (`#<token>` is the M3 legacy shape and
//      is treated as "no work_dir, no session" → level=1).
//   3. The connect/disconnect lifecycle tied to token presence.
//   4. The M3 dual-query recovery gate between token-present and the
//      chat surface (task 07 — PRD §4.4).
//   5. M4 task 01 — 5s 修复接 phase 文案（PRD §6 / tasks/m4/01 B+C
//      合体）：RecoveryInFlight 三态文案 + RecoveryErrorCard 4 类错误
//      文案（新增 `bridge_offline`） + auto-start 补 bridgeStatus
//      offline 守门。bridge / worker 零改动。
//   6. M4 task 07 — ChoicePage 三态分派（钉子 6 决策表）：no token
//      → TokenPrompt; token + no work_dir → ChoicePage level=1;
//      token + work_dir + no session → ChoicePage level=2;
//      token + work_dir + session → RecoveryView/ChatView.
//
// The URL hash is the single source of truth. The TokenPrompt /
// ChoicePage / DirectoryBrowser all write `window.location.hash` and
// the `hashchange` listener re-derives the three-field model via
// `readAuthFromHash()`. `decideView()` then picks the render branch.
//
// M3 routing (task 06 + task 07):
//   - token absent → TokenPrompt.
//   - token present → RecoveryView → ChatView (only after the
//     dual-query ceremony's `get_state` + `get_messages` replies
//     have both landed; the gate is the single source of truth
//     for the render decision).
//   - On the gate flipping to `error`, RecoveryView shows a
//     "恢复失败" card with a retry button that re-fires the
//     dual queries. F5 takes the same path — a fresh mount
//     builds a fresh gate, runs the ceremony once, and only
//     renders ChatView on success.
//
// M4 three-state dispatch (task 07 / PRD §4.2 / 钉子 6):
//   - no token → TokenPrompt (M3 path, preserved)
//   - token + no work_dir → ChoicePage level=1 (work_dirs list +
//     DirectoryBrowser entry point)
//   - token + work_dir + no session → ChoicePage level=2
//     (session list + "新建会话" button + "更换目录" button)
//   - token + work_dir + session → RecoveryView → ChatView
//     (`session: 'new'` falls through here; task 08 wires the
//     pending-state stem refilling).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';

import type { SessionPhase } from '@remotepi/shared';

import { ChatView } from './components/ChatView.js';
import { ChoicePage } from './components/ChoicePage.js';
import { StatusBar } from './components/StatusBar.js';
import { TokenPrompt } from './components/TokenPrompt.js';
import { errorHint } from './components/error-hint.js';
import { decideView, readAuthFromHash, type AuthFromHash } from './hash.js';
import { WsClient, type ConnState } from './ws/WsClient.js';
import { useBridgeStatus, useConnState, useSessionPhase, useWsClient, WsClientProvider } from './ws/WsClientContext.js';
import { initiateRecovery, type RecoveryError, type RecoveryGate } from './ws/recovery.js';
import { resolveWssUrl } from './ws/config.js';

export { errorHint };

/** Read the three-field hash model (`token` + `work_dir` + `session`)
 *  via the M4 parser. App.tsx calls this on every `hashchange` (and
 *  on first mount) so the render dispatch can pick the right branch
 *  per 钉子 6 决策表. The M3 single-token `readTokenFromHash()`
 *  helper is removed — `readAuthFromHash()` covers its job (token
 *  first, no key) and the new `decideView()` maps the model onto the
 *  render branches. */
function readAuth(): AuthFromHash {
  return readAuthFromHash(window.location.hash);
}

export function App() {
  const [auth, setAuth] = useState<AuthFromHash>(() => readAuth());

  // One WsClient per mount. Memoized so React StrictMode's double-invoke
  // in dev returns the same instance and we don't end up with two parallel
  // sockets during the probe render.
  const client = useMemo(() => new WsClient(resolveWssUrl()), []);

  // Hash is the single source of truth — listen for both programmatic
  // writes (TokenPrompt / ChoicePage / DirectoryBrowser) and
  // back/forward navigation. The listener is stable and only depends
  // on `setAuth`, which is itself stable. We also mirror the parsed
  // `work_dir` into the WsClient store so the ChoicePage's outbound
  // commands (session_list + future pi commands) can read it off the
  // store without re-parsing the URL.
  //
  // Review 修复轮 W6 + S1——hashchange effect 收敛为 mount-once：
  //   - 监听器本身读 `window.location.hash`（不依赖 `auth`），所以
  //     没必要将 `auth.workDir` 列入 deps。
  //   - 原实现 deps = `[auth.workDir, client]` 错误：依赖了
  //     auth.workDir 意味着每当 work_dir 变化（点“选择工作目录” /
  //     点“更换目录”）该 effect 重跑，监听器被清理后重新加载——但
  //     hashchange 事件本来就在下一个 tick 发出，新监听器听得到。
  //     净效果是 *看起来* 能工作，但多了一次 cleanup + 重建 + 同步
  //     `setCurrentWorkDir`（重复 setState，不幂等）。
  //   - S1 一并处理：初始 `setCurrentWorkDir` 同步移出该 effect，
  //     作为独立 mount-once 调用 + 监听器为权威路径（每次 hashchange
  //     重新调用 `setCurrentWorkDir`）——消除冗余 setState。
  useEffect(() => {
    // Mount-time mirror——原实现将“初始镜像”写在 effect 体内 `addEventListener`
    // 之后；现拆为独立调用（块状语句上下文变为 mount-only 主体），含义一致。
    client.setCurrentWorkDir(readAuth().workDir);
    const onHashChange = () => {
      const next = readAuth();
      setAuth(next);
      // 监听器为权威路径：每次 hashchange 都重写镜像，
      // 不再依赖 effect deps 重跑来 sync。
      client.setCurrentWorkDir(next.workDir);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
    // client 是 useMemo 返回的稳定实例（见上方）——监听器生命周期与
    // App mount 绑定，不需 deps 重跑。
  }, [client]);

  // Drive connect/disconnect from token presence. Cleanup also disconnects
  // so StrictMode's mount → unmount → mount cycle doesn't leak an orphan
  // socket between the two mounts.
  useEffect(() => {
    if (auth.token) {
      client.connect(auth.token);
    } else {
      client.disconnect();
    }
    return () => {
      client.disconnect();
    };
  }, [client, auth.token]);

  const view = decideView(auth);

  if (view === 'tokenPrompt') {
    return (
      <WsClientProvider client={client}>
        <TokenPrompt />
      </WsClientProvider>
    );
  }

  if (view === 'choiceLevel1') {
    return (
      <WsClientProvider client={client}>
        <main className="app-shell">
          <h1>RemotePi</h1>
          <StatusBar />
          <ChoicePage level={1} token={auth.token!} />
        </main>
      </WsClientProvider>
    );
  }

  if (view === 'choiceLevel2') {
    return (
      <WsClientProvider client={client}>
        <main className="app-shell">
          <h1>RemotePi</h1>
          <StatusBar />
          <ChoicePage level={2} token={auth.token!} workDir={auth.workDir!} />
        </main>
      </WsClientProvider>
    );
  }

  // Token + work_dir + session → render the M3 chat surface via the
  // dual-query recovery gate (task 07). The gate is created once per
  // mount and torn down on unmount; its lifecycle is independent of
  // the WsClient's connection state (reconnects are WsClient-internal;
  // a mid-recovery drop shows up as a `both_failed` after the
  // 5s timer fires, and the user can retry). The token is non-null at
  // this branch (`decideView` already proved it).
  return (
    <WsClientProvider client={client}>
      <main className="app-shell">
        <h1>RemotePi</h1>
        <StatusBar />
        <RecoveryShell token={auth.token!} />
      </main>
    </WsClientProvider>
  );
}

// ---------------------------------------------------------------------------
// RecoveryShell — owns the single RecoveryGate per mount and renders the
// appropriate view based on its state.
// ---------------------------------------------------------------------------

/** Wire-level entry: one `RecoveryGate` per component instance.
 *  Pulled out of `<App />` so the gate instance survives any future
 *  re-renders triggered by hash changes / context consumers below it.
 *  The component is intentionally small —
 *  the real gating logic lives in the gate object (`recovery.ts`)
 *  and the renderer (`RecoveryView`) below. */
function RecoveryShell({ token }: { token: string }) {
  const client = useWsClient();
  // `useRef` keeps one gate per component instance under StrictMode
  // dev's double-invoke; the gate is intentionally not disposed by
  // effect cleanup (see RecoveryShell).
  const gateRef = useGateRef(client);
  // The gate follows this component instance's lifetime. Do not dispose
  // it from effect cleanup: StrictMode uses cleanup as a simulated
  // teardown before the second setup, and disposal is irreversible.
  return <RecoveryView gate={gateRef} token={token} />;
}

/** Stable-per-mount gate factory: a real `useRef` (not `useMemo`)
 *  avoids the StrictMode-double-invoke trap — `useMemo`'s factory
 *  re-runs on every render, which would create two gates under
 *  StrictMode dev. `useRef`'s initial value is computed once and
 *  reused for the lifetime of the component instance. The factory
 *  closes over the client from the current render; token changes
 *  don't re-create the gate — see `RecoveryView` for the auto-start
 *  contract that re-fires the ceremony on token change. */
function useGateRef(client: WsClient): RecoveryGate {
  const ref = useRef<RecoveryGate | null>(null);
  if (ref.current === null) {
    ref.current = initiateRecovery(client);
  }
  return ref.current;
}

// ---------------------------------------------------------------------------
// RecoveryView — the visible surface for the gate's three states.
// ---------------------------------------------------------------------------

/** Three render paths driven by the gate's `ready` / `error` pair:
 *    - ready=true  → mount the chat surface (ChatView + DialogHost etc.)
 *    - error!==null → "恢复失败" card with a retry button
 *    - otherwise (in-flight) → "恢复中…" placeholder
 *
 *  The first start is gated on `connState === 'online'` so the
 *  dual queries don't fire before the WebSocket is open (the
 *  WsClient's `send` silently drops when the socket isn't open;
 *  deferring avoids an immediate 5s timer-fail on cold start).
 *
 *  `autoStartConsumedRef` records the token under which the
 *  auto-start has already fired. Token changes are a re-connect
 *  signal (the worker rooms are keyed by token; see architecture
 *  note below), so the effect re-fires the ceremony on each
 *  fresh-token → online transition — matching PRD §4.4's
 *  "every (re)connect fires the dual-query ceremony" contract.
 *  WsClient-internal reconnects (offline → connecting → online
 *  for the SAME token) are intentionally NOT re-fired: only a
 *  token change (or the user pressing retry / F5) restarts the
 *  ceremony. F5 is still the way to fully reset (which re-mounts
 *  everything and gets a fresh `autoStartConsumedRef`).
 *
 *  Architecture note: the worker DO rooms are keyed by token, so
 *  a token swap in the same tab logically hands off to a fresh
 *  bridge session — the old `get_messages` / `get_state` replies
 *  (if any were in flight from the previous session) belong to a
 *  different room and would never arrive on this socket anyway.
 *  Re-firing the ceremony on token change is the only correct
 *  behaviour; otherwise the gate would latch onto `error` from a
 *  stale 5s timer firing against a socket that's now serving a
 *  different room. `gate.retry()` itself calls `cancelActive()`,
 *  so any in-flight ceremony's timers + reply-resolvers are
 *  torn down before the fresh pair of dual queries goes out. */
function RecoveryView({ gate, token }: { gate: RecoveryGate; token: string }) {
  const connState = useConnState();
  // M4 tasks/m4/01 B 方案补充：订阅 `bridgeStatus` 使 auto-start
  // effect 能感知 bridge 离线（`null` 不触发——冷启动误杀防护）。
  // 同时 `RecoveryInFlight` 仅需 phase 读取——bridgeStatus 文案仍
  // 走 `StatusBar`，避免重复渲染。
  const bridgeStatus = useBridgeStatus();
  // M4 tasks/m4/01 §6.1 UI：`RecoveryInFlight` 接 `phase` prop 显示
  // 阶段文案。phase 从 `useSessionPhase()` 读取（WebState 镜像）。
  const phase = useSessionPhase();
  // `gate.subscribe` and `gate.getSnapshot` are arrow fields on the
  // gate object (stable per mount, see `RecoveryGate` JSDoc) — pass
  // them through verbatim. Inline arrows here would re-create the
  // function identity on every render; React's `useSyncExternalStore`
  // tolerates that but would re-validate / re-subscribe each time. The
  // critical bug being guarded against is `gate.getSnapshot` returning
  // a freshly constructed `{ ready, error }` on every call — the
  // gate now returns the cached snapshot reference, so React's
  // referential-equality check sees identity-stable output across
  // no-op transitions and skips re-render (fixes the
  // `Maximum update depth exceeded` crash on page load).
  const view = useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  // Render-stable ref so the auto-start effect doesn't re-run on
  // every gate transition (the gate instance is stable for the
  // mount lifetime).
  const gateRef = useMemo(() => ({ current: gate }), [gate]);
  // Records the token under which the auto-start ceremony has
  // already fired. `null` on first render (no ceremony yet); set
  // to the token string once we fire. On token change the effect
  // detects the mismatch and re-fires — the gate's `retry()`
  // handles the cancel-and-restart of any in-flight ceremony.
  const autoStartConsumedRef = useRef<string | null>(null);

  // First attempt per token: wait for the WebSocket to be open so
  // the dual queries actually go out. Token changes re-arm the
  // guard so a fresh token → online transition starts a new
  // ceremony. M4 B 方案补充 `bridgeStatus?.online === false`
  // 守门：仪式启动瞬间若已知 bridge 离线（worker 握手后同步补发
  // 的 `bridge_status` 显示 offline），不要发仪式；仪式仅由
  // retry 按钮 / hash 变化（token 变化）重新发起——bridge 重新
  // 上线后**不**自动重燃仪式（`autoStartConsumedRef` 已锁住当前
  // token，bridgeStatus 由 false 翻 true 触发 effect 重跑时守门
  // 仍命中 `current === token` → no-op）。PRD §6 仅要求"bridge
  // 离线 → 秒失败"，不要求"恢复在线 → 自动重燃"——超规格承诺
  // 显式剔除，用户须手动 retry / F5 / 换 token 才能重试。
  // `null` 不触发——冷启动期间 `bridge_status` 未补发是常态，
  // 避免误杀。 The retry button (and F5) drive subsequent
  // attempts manually — the WsClient drops `send()` if the socket
  // is closed and the 5s timer will catch the no-reply case.
  useEffect(() => {
    if (connState !== 'online') return;
    if (bridgeStatus !== null && bridgeStatus.online === false) return;
    if (autoStartConsumedRef.current === token) return;
    autoStartConsumedRef.current = token;
    gateRef.current.retry();
  }, [connState, bridgeStatus, gateRef, token]);

  if (view.ready) {
    return <ChatView />;
  }
  if (view.error !== null) {
    return <RecoveryErrorCard error={view.error} onRetry={() => gate.retry()} />;
  }
  return <RecoveryInFlight connState={connState} phase={phase} />;
}

// ---------------------------------------------------------------------------
// RecoveryInFlight — the placeholder shown while the dual-query ceremony
// is in flight. M4 tasks/m4/01 §6.1 UI：接 `phase` prop 三态文案。
// ---------------------------------------------------------------------------

/** M4 §6.1 三态文案映射：
 *  - `phase === 'spawning'` → "正在启动会话…"（pi 冷启动中）
 *  - `phase` ∈ `'ready' | 'running' | 'idle'` → "正在加载历史…"（manager 已
 *    完成握手，等待 get_messages 拉快照）
 *  - `phase === null` → "5 秒未收到进度…"（5s 兑底未到前已可见——
 *    UX 上该变量即刻呈现，不等兑底命中。仪式在 5s 内见到 phase 变化
 *    后会重启 snapshot 定时器 15s 窗口。）
 *
 *  `'exited'` 单独处理：视为"正在加载历史…"——`spawn → ready` 链路中
 *  exited 作为起始相位也是 bridge 内存视角的有效相位，不应误导用户。
 *  其他未知值（`null`）不匹配任何分支 → 走默认提示。 */
function RecoveryInFlight({ connState, phase }: { connState: ConnState; phase: SessionPhase | null }) {
  const phaseText = ((): string => {
    if (phase === 'spawning') return '正在启动会话…';
    if (phase === 'ready' || phase === 'running' || phase === 'idle') return '正在加载历史…';
    if (phase === 'exited') return '正在加载历史…';
    return '5 秒未收到进度…';
  })();

  return (
    <section
      className="card recovery-in-flight"
      aria-busy="true"
      aria-live="polite"
      data-phase={phase ?? 'null'}
      data-testid="recovery-in-flight"
    >
      <h2>恢复中…</h2>
      <p>
        {phaseText}
        {connState !== 'online' ? <span>（等待 WebSocket 连接…）</span> : null}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// RecoveryErrorCard — "恢复失败" surface with a manual retry button. The
// four-way error discriminator (M4 tasks/m4/01 §新错误文案) maps to a
// short user-visible hint; the longer operator-facing detail (PRD §6.4
// 验收) lives in the per-error JSDoc on `RecoveryError`.
// ---------------------------------------------------------------------------

function RecoveryErrorCard({ error, onRetry }: { error: RecoveryError; onRetry: () => void }) {
  return (
    <section className="card recovery-error" role="alert" data-error={error} data-testid="recovery-error">
      <h2>恢复失败</h2>
      <p>{errorHint(error)}</p>
      <button type="button" onClick={onRetry} data-testid="recovery-retry">
        重试
      </button>
    </section>
  );
}
