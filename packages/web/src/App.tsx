// App root — owns:
//   1. The single WsClient instance (memoized for StrictMode safety).
//   2. The hash → three-field derivation (`token` + `work_dir` +
//      `session`, M4 钉子 1). URL convention is
//      `#<token>&work_dir=<encoded>&session=<key|new>`; missing
//      fields are tolerated (`#<token>` is the M3 legacy shape and
//      is treated as "no work_dir, no session" → level=1).
//   3. The connect/disconnect lifecycle tied to token presence.
//   4. The per-session M3 dual-query recovery gate (M4 task 08 /
//      §4.2) — each session key gets its own gate, persisted across
//      navigation so re-entering a session doesn't re-fire the
//      ceremony.
//   5. M4 task 01 — 5s 修复接 phase 文案（PRD §6 / tasks/m4/01 B+C
//      合体方案）：RecoveryInFlight 三态文案 + RecoveryErrorCard
//      4 类错误文案（新增 `bridge_offline`） + auto-start 补
//      bridgeStatus offline 守门。bridge / worker 零改动。
//   6. M4 task 07 — ChoicePage 三态分派（钉子 6 决策表）：no token
//      → TokenPrompt; token + no work_dir → ChoicePage level=1;
//      token + work_dir + no session → ChoicePage level=2;
//      token + work_dir + session → RecoveryView/ChatView.
//   7. M4 task 08 — per-session ChatView + per-session
//      RecoveryGate map (see `RecoveryShell`). ChatView receives
//      `currentSessionKey` so its store reads/writes are bucket-
//      scoped (M4 §4.6 / §4.3). On session_state arriving with
//      a new `session` value while the current bucket is the
//      pending `'new'` marker, the hash gets refilled
//      (`&session=<realStem>`) and a session_list re-query is
//      fired so ChoicePage level=2's mirror catches up
//      (钉子 5 — stem 回填后重查).
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
//
// M4 per-session wiring (task 08 / PRD §4.2 / 钉子 6):
//   - ChatView takes `session` as a prop; its store reads/writes
//     go through `sessions[session]` (or the M3_LEGACY bucket
//     when session is `null` — the M3 token-only URL path).
//   - RecoveryGate per-session: a `Map<sessionKey, RecoveryGate>`
//     in the `RecoveryShell` keeps one gate per session. Enter
//     creates; leave does NOT destroy (暂存 so re-entering a
//     session doesn't re-fire the ceremony).
//   - Stem refilling: a session_state broadcast whose session
//     field is a real stem (i.e. not the literal 'new') while
//     the URL hash's `session` is still 'new' triggers a hash
//     refill (`&session=<realStem>`) and a session_list re-query
//     for the current work_dir (钉子 5 — see `useStemRefilled`).
//   - ChoicePage level=2 reads `sessionList` from the per-session
//     bucket (M3_LEGACY bucket when `currentSessionKey === null`,
//     which is the level=2 case).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';

import { watchStemRefilled } from './ws/stem-refilled.js';
import type { SessionPhase } from '@remotepi/shared';

import { ChatView } from './components/ChatView.js';
import { ChoicePage } from './components/ChoicePage.js';
import { StatusBar } from './components/StatusBar.js';
import { TokenPrompt } from './components/TokenPrompt.js';
import { errorHint } from './components/error-hint.js';
import { decideView, readAuthFromHash, type AuthFromHash } from './hash.js';
import { WsClient, M3_LEGACY_KEY, type ConnState } from './ws/WsClient.js';
import { useBridgeStatus, useConnState, useSessionPhase, WsClientProvider } from './ws/WsClientContext.js';
import {
  createReadyGate,
  initiateRecovery,
  type RecoveryError,
  type RecoveryGate,
} from './ws/recovery.js';
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
  // `work_dir` + `session` into the WsClient store so outbound
  // commands (session_list auto-fill + pi/control session auto-fill
  // — M4 §4.3) can read them off the store without re-parsing the
  // URL.
  //
  // Review 修复轮 W6 + S1——hashchange effect 收敛为 mount-once：
  //   - 监听器本身读 `window.location.hash`（不依赖 `auth`），所以
  //     没必要将 `auth.workDir` / `auth.session` 列入 deps。
  //   - 初始 `setCurrentWorkDir` + `setCurrentSessionKey` 同步移出
  //     该 effect，作为独立 mount-once 调用 + 监听器为权威路径
  //     （每次 hashchange 重新调用）——消除冗余 setState。
  useEffect(() => {
    // Mount-time mirror——初始镜像写在 mount-once 主体中。
    const initial = readAuth();
    client.setCurrentWorkDir(initial.workDir);
    client.setCurrentSessionKey(initial.session);
    const onHashChange = () => {
      const next = readAuth();
      setAuth(next);
      // 监听器为权威路径：每次 hashchange 都重写镜像，
      // 不再依赖 effect deps 重跑来 sync。
      client.setCurrentWorkDir(next.workDir);
      client.setCurrentSessionKey(next.session);
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

  // M4 task 08 — stem refilled watcher (钉子 5 / ChoicePage hook 点).
  // review 修复轮 W8——抽出到 packages/web/src/ws/stem-refilled.ts
  // 以便单元测试（见 stem-refilled.test.ts W8.1-W8.4）。语义不变：
  // bridge session_state 携带真实 stem（且当前 URL session 仍 'new'）
  // → 回填 hash + sendSessionList work_dir 重查。
  useEffect(() => {
    if (auth.token === null || auth.workDir === null) return;
    return watchStemRefilled(client, {
      currentSession: auth.session,
      workDir: auth.workDir,
      token: auth.token,
    });
  }, [client, auth.session, auth.workDir, auth.token]);

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
  // per-session dual-query recovery gate (task 08). The gate map is
  // created once per mount and persisted in `RecoveryShell`; its
  // lifecycle is independent of the WsClient's connection state
  // (reconnects are WsClient-internal; a mid-recovery drop shows
  // up as a `both_failed` after the 5s timer fires, and the user
  // can retry). The token / session are non-null at this branch
  // (`decideView` already proved them).
  //
  // M3-compat: the `decideView` M3 branch (token only) routes
  // here too. In that case `auth.session === null` and we use
  // `M3_LEGACY_KEY` as the gate / bucket key — same constant as
  // the WsClient uses for session-less inbound routing. ChatView
  // (pinned to the M3_LEGACY bucket via `useBucketField(null, …)`)
  // renders the M3 single-bucket state. The M3_LEGACY retire
  // evaluation is in the task 08 report.
  const sessionForGate = auth.session ?? M3_LEGACY_KEY;
  return (
    <WsClientProvider client={client}>
      <main className="app-shell">
        <h1>RemotePi</h1>
        <StatusBar />
        <RecoveryShell
          token={auth.token!}
          session={sessionForGate}
          workDir={auth.workDir ?? ''}
          client={client}
        />
      </main>
    </WsClientProvider>
  );
}

// ---------------------------------------------------------------------------
// RecoveryShell — owns the per-session RecoveryGate map.
// ---------------------------------------------------------------------------

/** Wire-level entry: a `Map<sessionKey, RecoveryGate>` per mount.
 *  Pulled out of `<App />` so the gate map survives any future
 *  re-renders triggered by hash changes / context consumers below
 *  it. The map is keyed by session; we expose
 *  `gateForSession(session)` so `RecoveryView` can read the gate
 *  for the current session without re-creating it.
 *
 *  `session === 'new'` (pending marker) is treated like any
 *  other session key — its gate fires the dual-query ceremony
 *  with `session: 'new'` and the bridge's pending-key path
 *  routes the request. When the bridge broadcasts
 *  session_state{session:<realStem>}, the URL hash's `session`
 *  flips to the real stem (via the App-level `useStemRefilled`
 *  effect); the new stem's gate is created on the next render
 *  via the create-on-miss pattern in `gateForSession`. The
 *  pending gate's reply-resolvers and timers are naturally
 *  torn down by the gate's own `cancelActive` on `retry()` /
 *  on the success path — see `recovery.ts` for the lifecycle.
 *
 *  R3 review 修复轮——仪式携带 `envelope.session` 出站：每个 session
 *  的 gate 在出站 `pi/get_messages` + `control/get_state` 信封上
 *  携带 session 字段（M4 normal flow）。M3 token-only 链接路径
 *  下 `session === 'm3-legacy'`，仪式保持 session-less（M3-compat
 *  fallback）；M4 normal flow `session === <stem>` 或 `'new'`，
 *  bridge 按 session 路由到对应 manager 或 pending 键。
 */
function RecoveryShell({
  token,
  session,
  workDir,
  client,
}: {
  token: string;
  session: string;
  workDir: string;
  client: WsClient;
}) {
  // `useRef` keeps the gate map stable per mount; the factory
  // closes over the client from the current render. Token /
  // session changes don't re-create the map — see `RecoveryView`
  // for the auto-start contract that re-fires the ceremony on
  // session change.
  const gateMapRef = useRecoveryGateMap();
  const gate = gateForSession(gateMapRef.current, session, workDir, client);
  return <RecoveryView gate={gate} session={session} workDir={workDir} token={token} />;
}

/** Stable-per-mount `Map<sessionKey, RecoveryGate>`. We use
 *  `useRef` (not `useMemo`) so StrictMode's dev double-invoke
 *  doesn't create two maps and orphan the first one's gates
 *  (the gates hold `setTimeout` handles and reply resolvers
 *  that must persist). The map is created empty; the
 *  `gateForSession` helper fills it on demand. */
function useRecoveryGateMap(): { current: Map<string, RecoveryGate> } {
  const ref = useRef<Map<string, RecoveryGate> | null>(null);
  if (ref.current === null) {
    ref.current = new Map();
  }
  return { current: ref.current };
}

/** Look up (or create) the gate for a given session key. The
 *  map is the per-mount `Map<sessionKey, RecoveryGate>` —
 *  create-on-miss matches the lazy-bucket pattern the WsClient
 *  uses for its store (so a brand-new session key that fires
 *  the ceremony for the first time also gets a bucket). The
 *  gate instance lives until the App unmounts — navigation
 *  between sessions does NOT destroy other sessions' gates
 *  (the M4 §4.2 "暂存" contract). */
function gateForSession(
  map: Map<string, RecoveryGate>,
  session: string,
  workDir: string,
  client: WsClient,
): RecoveryGate {
  let gate = map.get(session);
  if (gate === undefined) {
    if (session === 'new') {
      // R3 review 修复轮——`session: 'new'` 不跑仪式：
      //   bridge 在收到首条 pi/prompt 之前没有 'new' 对应的
      //   manager（pending manager 是 lazy spawn）；get_messages
      //   / get_state 都会返 `invalid_envelope` / `no manager`。
      //   新会话按定义历史为空——无东西可恢复。createReadyGate
      //   直接返回 ready=true 的 no-op gate，ChatView 立即渲染；
      //   用户首条 prompt 触发 bridge pending 键 + App.tsx
      //   stem-refilled watcher 回填 hash → 下次会话切换进真
      //   stem 的仪式。
      gate = createReadyGate();
    } else {
      // R3 review 修复轮——仪式带 session + workDir 出站：
      //   - sessionKey 来自 URL hash 的 session 分量；
      //   - workDir 来自 URL hash 的 work_dir 分量（pending
      //     session='new' 时仪式需 work_dir 触发 bridge pending-
      //     key 路由——钉子 2）。本分支是真 stem 走仪式，work_dir
      //     仅在 session='new' 时被仪式消费；真 stem 时仪式不
      //     消费（manager 已存在，session 路由已命中）。
      //   M3-compat 路径（currentSessionKey=null）下 M3_LEGACY
      //     路径走 session-less，bridge auto-spawn 接住。R6 e2e
      //     迁移后所有路径走带 session 形态。
      gate = initiateRecovery(client, {
        sessionKey: session,
        workDir: workDir.length > 0 ? workDir : null,
      });
    }
    map.set(session, gate);
  }
  return gate;
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
 *  `autoStartConsumedRef` records the session under which the
 *  auto-start has already fired. Session changes (the user
 *  navigating from session A to session B) re-arm the guard so
 *  a fresh session → online transition starts a new ceremony
 *  (the M3 single-gate flow had a `token`-keyed guard; M4
 *  generalises to `session`-keyed because the recovery gate is
 *  per-session). WsClient-internal reconnects (offline →
 *  connecting → online for the SAME session) are intentionally
 *  NOT re-fired: only a session change (or the user pressing
 *  retry / F5) restarts the ceremony. F5 is still the way to
 *  fully reset (which re-mounts everything and gets a fresh
 *  `autoStartConsumedRef`).
 *
 *  M4 §6.1 B 方案补充：`bridgeStatus.online === false` 守门——离线
 *  立即判 `bridge_offline`。`null` 不触发（冷启动误杀防护）。
 *  bridge 重新上线后**不**自动重燃（autoStartConsumedRef 已锁住
 *  当前 session）——用户须手动 retry / F5 / 换 session 重试。
 *  PRD §6 仅要求"bridge 离线 → 秒失败"，不要求"恢复在线 →
 *  自动重燃"——超规格承诺显式剔除。 */
function RecoveryView({
  gate,
  session,
  workDir,
  token: _token,
}: {
  gate: RecoveryGate;
  session: string;
  workDir: string;
  token: string;
}) {
  const connState = useConnState();
  // M4 tasks/m4/01 B 方案补充：订阅 `bridgeStatus` 使 auto-start
  // effect 能感知 bridge 离线（`null` 不触发——冷启动误杀防护）。
  // 同时 `RecoveryInFlight` 仅需 phase 读取——bridgeStatus 文案仍
  // 走 `StatusBar`，避免重复渲染。
  const bridgeStatus = useBridgeStatus();
  // M4 tasks/m4/01 §6.1 UI：`RecoveryInFlight` 接 `phase` prop 显示
  // 阶段文案。phase 从 `useSessionPhase()` 读取（WebState 镜像
  // ——`bucketFor(currentSessionKey).sessionPhase`）。M4 多会话下
  // phase 跟随当前 session 桶的 phase（用户切会话后 ChatView 立即
  // 显示新桶的 phase）。
  const phase = useSessionPhase();
  // `gate.subscribe` and `gate.getSnapshot` are arrow fields on the
  // gate object (stable per mount, see `RecoveryGate` JSDoc) — pass
  // them through verbatim. Inline arrows here would re-create the
  // function identity on every render; React's `useSyncExternalStore`
  // tolerates that but would re-validate / re-subscribe each time.
  const view = useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  // Render-stable ref so the auto-start effect doesn't re-run on
  // every gate transition (the gate instance is stable for the
  // mount lifetime).
  const gateRef = useMemo(() => ({ current: gate }), [gate]);
  // Records the session under which the auto-start ceremony has
  // already fired. `null` on first render (no ceremony yet); set
  // to the session string once we fire. On session change the
  // effect detects the mismatch and re-fires — the gate's
  // `retry()` handles the cancel-and-restart of any in-flight
  // ceremony.
  const autoStartConsumedRef = useRef<string | null>(null);

  // First attempt per session: wait for the WebSocket to be open so
  // the dual queries actually go out. Session changes re-arm the
  // guard so a fresh session → online transition starts a new
  // ceremony. M4 B 方案补充 `bridgeStatus?.online === false` 守门。
  useEffect(() => {
    if (connState !== 'online') return;
    if (bridgeStatus !== null && bridgeStatus.online === false) return;
    if (autoStartConsumedRef.current === session) return;
    autoStartConsumedRef.current = session;
    gateRef.current.retry();
  }, [connState, bridgeStatus, gateRef, session]);

  if (view.ready) {
    return <ChatView session={session} workDir={workDir} />;
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
 *  - `phase === 'exited'` → "正在加载历史…"（`spawn → ready` 链路中
 *    exited 作为起始相位也是 bridge 内存视角的有效相位，不应误导用户）
 *  - `phase === null` → "5 秒未收到进度…"（5s 兑底未到前已可见——
 *    UX 上该变量即刻呈现，不等兑底命中。仪式在 5s 内见到 phase 变化
 *    后会重启 snapshot 定时器 15s 窗口。）
 */
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
