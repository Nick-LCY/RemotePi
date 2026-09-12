// App root — owns:
//   1. The single WsClient instance (memoized for StrictMode safety).
//   2. The hash + localStorage auth derivation (`token` from
//      `tokenStorage`, `work_dir` + `session` from the URL hash).
//      The hash carries only navigation state per M5 §G6 / D9;
//      the token is sourced from localStorage (see
//      `ws/tokenStorage.ts`).
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
//      → <TokenModal required>; token + no work_dir → ChoicePage level=1;
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
//   8. M5 task 06 — AppShell 双栏装配（任务书 §a/§g）：
//      AppShell 是布局容器，只接 sidebar + main 两栏；client /
//      gateMapRef / handleRefill 全部留在 App 层（不下移——
//      M4 验收期 4th gap 修复路径要求 App 级闭包稳定），RecoveryShell
//      由 App 直接 mount 到 mainContent 里。AppShell 接 Sidebar 的
//      列表 / tabs / 设置按钮 → TokenModal closable；
//      SessionStatusBar 接管对话区顶部 status bar（本 session 状态）。
//      DirectoryBrowser modal 化（`open` prop；App 持 `browserOpen`
//      state）。
//
// ## M5 task 07 gap fix — 汉堡按钮覆盖全部移动端视图
//
// M5 task 07 commit `a6fd9ef` 落地汉堡按钮（`sidebar-toggle`
// testid）仅位于 `SessionStatusBar` 左侧；SessionStatusBar 仅在
// recovery 分支挂载（`sessionForSessionBar !== null`）→ 移动端
// `<768px` 在 `choiceLevel1` / `choiceLevel2` 视图下**没有任何
// 入口打开侧边栏** → 用户无法选工作目录/会话 → 功能性死路。
//
// 修法：本 App.tsx 按 view 分派顶部条幅——
//
//   - `view === 'recovery'` → 渲染 `<SessionStatusBar>`（既有
//     路径，包含汉堡 + phase + queue + session 名）；
//   - `view === 'choiceLevel1' || 'choiceLevel2'` → 渲染
//     `<MobileTopBar>`（M5 task 07 新建组件，含汉堡 + 视图标题）。
//
// 两组件**互斥**渲染（按 view 分派；不可能同时挂载）。
// `hamburgerRef` 在 App 层持有（`useRef<HTMLButtonElement>(null)`）
// 并同时透传给两个组件——`ref.current` 永远指向当前可见的汉堡
// 按钮，`useFocusTrap` 关闭时焦点归还正确（不出现「归还到
// 已卸载组件的 ref → no-op」）。
//
// testid 约束：`sidebar-toggle` testid 在任一时刻仅 0 或 1 个
// DOM 实例（mobile 1 / desktop 0），不重复；`mobile-top-bar` 是
// 新组件新 testid（任务 06 brief 明示「新组件新 testid 不计入
// 既有约束」）。桌面端（≥768px）零回归——MobileTopBar 内部
// `useIsMobile()` 判定返回 null，不参与布局。
//
// ## M5 task 06 review W1 — AppShell dead props removed
//
// `client` and `gateMapRef` were declared on AppShellProps but never
// read by the AppShell component body (RecoveryShell is now
// composed by App into `mainContent`, so AppShell has no need
// to forward them). Removed from the type + the call site;
// AppShell is purely a layout container.
//
// ## M5 task 06 review W2 — closable submit no longer double-connects
//
// The old `closable` submit did `client.connect(value)` immediately
// after `tokenStorage.write()`, then `setAuth(readAuth())`. The
// `setAuth` triggered the `useEffect([client, auth.token])` effect
// which called `client.connect(auth.token)` a SECOND time. The
// second connect tore down the first socket mid-handshake (WsClient
// `connect()` teardown is unconditional — it calls `disconnect()`
// on any existing socket first), causing the freshly-opened
// subprotocol handshake to abort. The fix is to drop the manual
// `client.connect(value)` call entirely; the useEffect is the
// sole, deterministic connect path. `setAuth(readAuth())` is still
// required (hash is unchanged so `hashchange` doesn't fire) so
// React state catches up to the new localStorage source of truth.
//
// ## M5 task 05 review W1 — write-failure handling
//
// `tokenStorage.write()` returns `boolean` (was `void`). The App
// submit handlers check the return and:
//   - required mode → if (ok) window.location.reload(); else
//     setStorageError(true) (inline error banner in TokenModal).
//   - closable mode → if (ok) setAuth(readAuth()) only (W2 —
//     no manual connect); else setStorageError(true).
// Failure surfaces inline ("浏览器禁用了本地存储，无法保存 token")
// — no silent no-op / no infinite-reload loop.
//
// ## M5 task 05 review W2 — closable auth state sync (superseded by W2)
//
// Settings → TokenModal closable → submit success → call
// `setAuth(readAuth())` to keep `auth.token` state in sync with
// localStorage. The original review also asked for a manual
// `client.connect(value)`; W2 (above) drops that call because
// the `useEffect([client, auth.token])` already drives the
// connect deterministically.
//
// The URL hash is the single source of truth for navigation.
// The TokenModal / ChoicePage / DirectoryBrowser all write
// `window.location.hash` and the `hashchange` listener re-derives
// the auth model via `readAuth()` (token from localStorage +
// work_dir/session from hash). `decideView()` then picks the
// render branch.
//
// ## M5 task 06 review W6 — Sidebar WorkDirsTab refresh semantics
//
// Sidebar's WorkDirsTab effect no longer depends on `currentWorkDir`.
// Rationale: the work_dirs list is GLOBAL (one list of saved
// directories, not scoped to the current work_dir). Refetching
// whenever the user navigates between work_dirs (level=2 → 更换目录
// → click another row) was redundant — the list contents haven't
// changed just because the user picked a different work_dir.
//
// Refetch still fires on:
//   - mount (initial fetch),
//   - connState transition (retry after reconnect),
//   - post-add (fired explicitly in `onAdded` below — see the
//     DirectoryBrowser render block),
//   - post-remove (already inline in Sidebar's handleRemove).
//
// The four-path coverage keeps spec 04 (work_dir_add → level=2 →
// back to level=1 → list contains new entry) stable while
// eliminating the redundant refetches on level=2 work_dir
// navigation.
//
// ## M5 task 06 review W3 — Sidebar activeTab syncs to view
//
// view transitions (e.g. choiceLevel1 → choiceLevel2 after a
// work_dir is picked) used to leave `activeTab` stuck at
// 'work-dirs', hiding the Sessions tab on the very surface
// where the user wanted to see the session list. Fixed via a
// useEffect in Sidebar that resets activeTab to view's default
// when `view` changes; same-view tab clicks remain free
// (controlled by local state).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';

import { watchStemRefilled } from './ws/stem-refilled.js';
import type { SessionPhase } from '@remotepi/shared';

import { AppShell } from './components/AppShell.js';
import { ChatView } from './components/ChatView.js';
import { ChoiceLevel1Panel } from './components/ChoiceLevel1Panel.js';
import { ChoiceLevel2Panel } from './components/ChoiceLevel2Panel.js';
import { DirectoryBrowser } from './components/DirectoryBrowser.js';
import { MobileTopBar } from './components/MobileTopBar.js';
import { SessionStatusBar } from './components/SessionStatusBar.js';
import { TokenModal } from './components/TokenModal.js';
import { errorHint } from './components/error-hint.js';
import { decideView, readAuthFromHash } from './hash.js';
import * as tokenStorage from './ws/tokenStorage.js';
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

/** Read the auth model used by App.tsx. M5 §G6 / D9 — the token
 *  is sourced from `localStorage` (see `ws/tokenStorage.ts`) and
 *  injected into the model alongside the hash-derived `work_dir` +
 *  `session`. The returned shape is the M5 two-field form
 *  (`workDir` + `session`) plus the separately-sourced `token`.
 *  App.tsx treats `auth.token === null` as the trigger for
 *  `<TokenModal required>` (D9 / D10).
 *
 *  Token-vs-hash ordering note: `token` is read on every call (not
 *  cached) so the Settings → 「更换 Token」 flow (M5 §D10 closable
 *  mode) can `tokenStorage.write()` + `client.connect(newToken)`
 *  without a manual `readAuth()` round-trip — but the App-level
 *  `tokenModalRequired` render only re-reads on `hashchange` / mount,
 *  which is the right cadence for the first-touch `TokenModal
 *  required` UX. The localStorage read is a single in-process
 *  `localStorage.getItem` (~µs), so the lack of caching is fine. */
function readAuth(): { token: string | null; workDir: string | null; session: string | null } {
  return {
    token: tokenStorage.read(),
    ...readAuthFromHash(window.location.hash),
  };
}

/** Inline error banner copy surfaced when `tokenStorage.write()`
 *  returns `false` (privacy mode / quota exceeded / SecurityError).
 *  Single source of truth — both required + closable submit
 *  handlers set the same message via `setStorageError(true)`. */
const STORAGE_ERROR_COPY = '浏览器禁用了本地存储，无法保存 token';

/** Pure handlers for opening the two App-level modals (Settings
 *  → TokenModal closable + Sidebar WorkDirs tab → DirectoryBrowser)
 *  with the **mobile drawer auto-close** side effect — M5 task 08
 *  review W1 焦点陷阱互斥 (focus trap mutual exclusion).
 *
 *  ## Why both modals close the drawer
 *
 *  PRD §D12 specifies the z-index stack `toast(100) < sidebar(200)
 *  < dialog-host(300) < token-modal(400)` — modals therefore
 *  visually overlay the drawer on mobile. But z-index alone doesn't
 *  solve the focus-trap conflict: both AppShell's drawer (sidebar
 *  drawer when `sidebarOpen=true` on mobile) AND the modal
 *  component (TokenModal closable / DirectoryBrowser) install
 *  document-level `keydown` listeners via `useFocusTrap`. With
 *  both `active=true` at once, a single Escape key fires
 *  `onClose`/`onCancel` on BOTH layers (modal closes AND drawer
 *  closes), and Tab keys are intercepted twice (preventDefault +
 *  focus jumps from each listener, doubling the move).
 *
 *  The simplest contract that eliminates the conflict is
 *  **modal-over-drawer exclusive**: opening any modal forces
 *  the drawer closed first, so only ONE focus trap is active
 *  at any moment. This matches the visual stacking (modal covers
 *  drawer) and aligns with the user's mental model ("opening a
 *  dialog should hide the thing behind it"). The alternative —
 *  App-level modalCount coordination of trap `active` flags — adds
 *  plumbing for no UX gain (the user never wants both visible).
 *
 *  Pure helpers extracted for unit testing (`app-modal-sidebar-mutex.test.ts`).
 *  The inline `useCallback` wrappers in `<App />` (`handleSettingsClick`
 *  / `handleBrowseWorkDirsClick`) close over the React setters,
 *  which have stable identity across renders — so the resulting
 *  handler identity is stable (no spurious effect re-runs in
 *  `useFocusTrap` / `useEffect([onCloseSidebar])`). */
export function openSettingsAndCloseDrawer(args: {
  setSettingsOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
}): void {
  // W1 — 焦点陷阱互斥：modal 打开前先收抽屉，保证 document 上
  // 至多一个 useFocusTrap keydown listener。React batch 一帧内
  // 落定（无需 setTimeout）——drawer 收起与 modal 展开在同一 commit
  // 落定，下一帧 useFocusTrap 已感知 drawer=false + modal=true 互斥。
  args.setSidebarOpen(false);
  args.setSettingsOpen(true);
}

export function openBrowserAndCloseDrawer(args: {
  setBrowserOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
}): void {
  // W1 — 同上（DirectoryBrowser 也是 trap 全开，详见组件 header）。
  args.setSidebarOpen(false);
  args.setBrowserOpen(true);
}

/** Pure handler for the closable-mode TokenModal flow (M5 task 05
 *  D10 + task 06 review W2). Extracted out of `<App />` so the
 *  W2 single-connect invariant can be unit-tested without
 *  spinning up a DOM / React reconciler.
 *
 *  Contract:
 *   1. `tokenStorage.write(value)` returns false → set
 *      storageError, return (no connect, no setAuth).
 *   2. write succeeds → `setAuth(readAuth())` ONLY. The
 *      `useEffect([client, auth.token])` in App is the sole
 *      connect path — calling `client.connect(value)` here
 *      would race with the effect's cleanup-then-reconnect and
 *      tear down the freshly-opened handshake.
 *
 *  The handler does NOT call `client.connect()` directly — that's
 *  the load-bearing invariant of W2. The test in
 *  `app-token-submit.test.ts` pins this with a spy on
 *  `client.connect`.
 */
export function handleClosableTokenSubmit(args: {
  value: string;
  client: Pick<WsClient, 'connect'>;
  setAuth: (auth: { token: string | null; workDir: string | null; session: string | null }) => void;
  setStorageError: (msg: string | null) => void;
  readAuth: () => { token: string | null; workDir: string | null; session: string | null };
}): void {
  const { value, client, setAuth, setStorageError, readAuth } = args;
  setStorageError(null);
  const ok = tokenStorage.write(value);
  if (!ok) {
    setStorageError(STORAGE_ERROR_COPY);
    return;
  }
  // M5 task 06 review W2 — single `setAuth` is enough.
  // The `useEffect([client, auth.token])` cleanup disconnects
  // the old socket, then opens the new one with the
  // freshly-cached token. Manually calling `client.connect(value)`
  // here would race with the effect-driven connect (both close
  // the old socket independently → second handshake tears down
  // the first's progress).
  void client; // intentionally not called — see W2 above.
  setAuth(readAuth());
}

export function App() {
  const [auth, setAuth] = useState(() => readAuth());
  // M5 task 05 review W1 — `storageError` 状态：当
  // `tokenStorage.write()` 返回 false 时设为 true，渲染内联错误
  // banner。`null` 时不渲染（happy path）。Required 模式触发后
  // 用户重新提交时复位为 null（每次 onSubmit 重置）。
  const [storageError, setStorageError] = useState<string | null>(null);
  // M5 task 06 — App-level modal state. DirectoryBrowser modal
  // (`browserOpen`) + TokenModal closable (`settingsOpen`) are
  // owned by App so the sidebar buttons can dispatch them through
  // AppShell. The state lives here (not in the sidebar) so a
  // session change / hash navigation can reset them predictably.
  const [browserOpen, setBrowserOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // M5 task 07 — mobile drawer state. `sidebarOpen` controls
  // whether the sidebar drawer is expanded on mobile (<768px);
  // desktop (>=768px) ignores this value (sidebar is permanently
  // mounted in the grid). `hamburgerRef` is shared between
  // AppShell (for useFocusTrap return-focus) and SessionStatusBar
  // (for the actual <button>); the same RefObject instance
  // identity guarantees the ref reads/writes line up across
  // components. Default `false` (drawer collapsed); AppShell
  // mount-once handles the initial viewport check.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  // One WsClient per mount. Memoized so React StrictMode's double-invoke
  // in dev returns the same instance and we don't end up with two parallel
  // sockets during the probe render.
  const client = useMemo(() => new WsClient(resolveWssUrl()), []);

  // Hash is the single source of truth — listen for both programmatic
  // writes (TokenModal / ChoicePage / DirectoryBrowser) and
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
  //
  // M5 task 05 review W2 — closable 模式 `setAuth(readAuth())` 后
  // 也会触发 hashchange（hash 没变，但 token 变了 → setAuth 内部
  // state 刷新）。监听器只在 hash 实际变化时回调；token 变化靠
  // `setAuth` 直接生效。
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
  //
  // M4 验收期 4th gap 修复（task 11）——新增 `onRefill` 回调：watcher
  // fire 时执行 gate 重键（take-and-set），避免 hash 翻转后 ChatView
  // 被 `RecoveryInFlight` 顶替导致流式打字机效果丢失。详见
  // `ws/stem-refilled.ts` 顶部 §M4 验收期 4th gap 修复段 + `handleRefill`
  // JSDoc。
  //
  // M5 task 06 — gateMapRef / handleRefill 仍在 App 层创建（任务书
  // §g 雷区代码：不下移到 AppShell）。AppShell 只是布局容器。
  const gateMapRef = useRecoveryGateMap();
  const handleRefill = useCallback(
    (stem: string, _refillWorkDir: string): void => {
      const map = gateMapRef.current;
      if (map === null) return;
      const newGate = map.get('new');
      if (newGate === undefined) return;
      map.set(stem, newGate);
      map.delete('new');
    },
    [],
  );
  useEffect(() => {
    if (auth.token === null || auth.workDir === null) return;
    return watchStemRefilled(client, {
      currentSession: auth.session,
      workDir: auth.workDir,
      token: auth.token,
      onRefill: handleRefill,
    });
  }, [client, auth.session, auth.workDir, auth.token, handleRefill]);

  const view = decideView(auth);

  // M5 §G6 / D9 — tokenPrompt 由 App 层触发：未拿到 token (=
  // tokenStorage.read() === null) → 渲染 `<TokenModal required>`，
  // 不进 WsClientProvider 主树（保持既有 disconnect 语义：未认证
  // 时不试图建立 WebSocket 连接）。`hashchange` 不触发
  // `auth.token` 重新读取（hash 不再承载 token），仅在硬刷新 /
  // `TokenModal required` 提交 → `window.location.reload()` 后
  // 重新读 localStorage → 走正常 recovery 流程。
  //
  // M5 task 05 review W1 — `tokenStorage.write()` 现在返回 boolean；
  // `false` 时不 reload（避免无限 reload 循环），改设 storageError
  // state → TokenModal 内联错误 banner 显示。
  if (auth.token === null) {
    // 旧书签检测：URL hash 仍携带非空 body（说明原 #<token>&work_dir=...
    // 形态的旧书签被访问了）。提示文案明示"书签 token 已失效"——避免
    // 用户误以为仅仅 lost-credentials。
    const legacyBookmark = typeof window !== 'undefined'
      && (window.location.hash.includes('work_dir=')
        || window.location.hash.includes('session='));
    return (
      <TokenModal
        required
        bannerHint={legacyBookmark
          ? '旧书签中的 token 已不再生效，请重新粘贴新 token。'
          : ''}
        storageError={storageError}
        onSubmit={(value: string) => {
          setStorageError(null);
          const ok = tokenStorage.write(value);
          if (!ok) {
            // Review W1 — write 失败不 reload；设内联错误文案
            // 提示用户「浏览器禁用了本地存储」。下一次提交会
            // 重新覆盖 storageError state（`setStorageError(null)`
            // 在 onSubmit 入口已执行）。
            setStorageError(STORAGE_ERROR_COPY);
            return;
          }
          // 硬刷新触发 App 重新 readAuth → token !== null → App
          // 走正常 recovery 流程（D10 required 模式提交 = write +
          // reload）。
          window.location.reload();
        }}
      />
    );
  }

  // Token 已就绪 → 装配 AppShell + 双栏内容。
  // DirectoryBrowser modal state lives in App (not Sidebar) so
  // hash navigation can predictably reset it; the Sidebar's
  // WorkDirsTab 「浏览添加」 button dispatches `setBrowserOpen(true)`
  // via the `onBrowseWorkDirsClick` callback.
  const handleSettingsClick = useCallback(() => {
    // W1 — 焦点陷阱互斥：开 modal 前先收抽屉。openSettingsAndCloseDrawer
    // 是纯函数 helper（见文件 header 注释），React setter identity
    // 稳定（useState 返回值）所以 useCallback deps 为空即可。
    openSettingsAndCloseDrawer({ setSettingsOpen, setSidebarOpen });
  }, []);
  const handleBrowseWorkDirsClick = useCallback(() => {
    // W1 — 同上（DirectoryBrowser trap 全开，开之前先收抽屉）。
    openBrowserAndCloseDrawer({ setBrowserOpen, setSidebarOpen });
  }, []);
  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
    setStorageError(null);
  }, []);
  const handleCloseBrowser = useCallback(() => {
    setBrowserOpen(false);
  }, []);
  // M5 task 07 — mobile drawer toggle (汉堡按钮回调)。
  // 桌面端不渲染汉堡按钮，所以此回调不会被调用，但传 AppShell
  // 给 SessionStatusBar 共享同一回调即可（identity stable via
  // useCallback）。
  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);
  // 抽屉关闭回调：backdrop click / Escape / hashchange 都走此。
  // 在 useCallback 内只读 setState，identity 稳定——AppShell 的
  // hashchange 监听器 effect 依赖此 identity（不要每次 render
  // 变新，否则 listener 每次重挂）。
  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  // Build the right-rail content (chat / choice panel / recovery).
  // The `<SessionStatusBar>` is always mounted above the main
  // content — it shows the per-session status (phase badge + queue
  // pills + session name) and bridge status now lives in the sidebar.
  let mainContent: JSX.Element;
  let sessionForSessionBar: string | null;

  if (view === 'choiceLevel1') {
    sessionForSessionBar = null;
    mainContent = (
      <ChoiceLevel1Panel />
    );
  } else if (view === 'choiceLevel2') {
    sessionForSessionBar = null;
    mainContent = (
      <ChoiceLevel2Panel
        workDir={auth.workDir!}
        onChangeWorkDir={() => { window.location.hash = ''; }}
        onNewSession={() => {
          // 釘子 6 新建会话：写 hash `&session=new` → 进 ChatView pending
          // (bridge pending-key path takes over from there).
          window.location.hash = `work_dir=${encodeURIComponent(auth.workDir!)}&session=new`;
        }}
      />
    );
  } else {
    // recovery — token + work_dir + session.
    const sessionForGate = auth.session ?? M3_LEGACY_KEY;
    sessionForSessionBar = auth.session;
    mainContent = (
      <RecoveryShell
        token={auth.token}
        session={sessionForGate}
        workDir={auth.workDir ?? ''}
        client={client}
        gateMapRef={gateMapRef}
      />
    );
  }

  return (
    <>
      <WsClientProvider client={client}>
        <AppShell
          currentSession={sessionForSessionBar}
          currentWorkDir={auth.workDir}
          view={view}
          onSettingsClick={handleSettingsClick}
          onBrowseWorkDirsClick={handleBrowseWorkDirsClick}
          sidebarOpen={sidebarOpen}
          onCloseSidebar={handleCloseSidebar}
          hamburgerRef={hamburgerRef}
          mainContent={
            <>
              {sessionForSessionBar !== null ? (
                // recovery 分支：SessionStatusBar 顶栏（带汉堡 + phase +
                // queue + session 名）。Hamburger ref 与 mobile top bar
                // 共享同一对象（见 App.tsx `hamburgerRef = useRef(...)`），
                // 焦点归还永远指向当前可见的汉堡按钮。
                <SessionStatusBar
                  session={sessionForSessionBar}
                  sidebarOpen={sidebarOpen}
                  onToggleSidebar={handleToggleSidebar}
                  hamburgerRef={hamburgerRef}
                />
              ) : (
                // level1 / level2 分支：mobile 顶栏（M5 task 07 gap 修复）。
                // 移动端 <768px 渲染 hamburger + 视图标题；桌面端
                // 组件内部 `useIsMobile()` 判定返回 null，不参与布局。
                // 与 SessionStatusBar 按 view 分派——互斥渲染，
                // `sidebar-toggle` testid 在任一时刻仅 0 或 1 个
                // DOM 实例（mobile 1 / desktop 0）。
                <MobileTopBar
                  title={view === 'choiceLevel1' ? '选择工作目录' : '选择会话'}
                  sidebarOpen={sidebarOpen}
                  onToggleSidebar={handleToggleSidebar}
                  hamburgerRef={hamburgerRef}
                />
              )}
              {mainContent}
            </>
          }
        />
      </WsClientProvider>

      {/* DirectoryBrowser modal — `open={true}` mounts the
          browser; clicking cancel / a "选择" path fires
          onCancel / onAdded, both reset the open state. App owns
          the `open` state so the sidebar's WorkDirsTab 「浏览添加」
          button + a future `WorkDirsTab → 直接 mount` (M+ candidate)
          can share the same modal slot.

          M5 task 06 review W6 — `onAdded` also fires
          `client.sendWorkDirList()` to refresh the Sidebar's
          `useWorkDirs()` mirror. The Sidebar's WorkDirsTab effect
          no longer depends on `currentWorkDir` (the work_dirs
          list is global — switching work_dirs at level=2
          doesn't change its contents, so refetching on
          workDir-change was redundant). The post-add refresh
          is now driven from THIS callback, which is the single
          point in the codebase that knows an add just landed.
          Mirror mirroring the same pattern as
          `handleRemove` in Sidebar.tsx (which also calls
          `sendWorkDirList()` inline after a successful remove). */}
      {browserOpen ? (
        <WsClientProvider client={client}>
          <DirectoryBrowser
            open={browserOpen}
            onAdded={(path: string) => {
              setBrowserOpen(false);
              window.location.hash = `work_dir=${encodeURIComponent(path)}`;
              // W6 — post-add refresh; the bridge updated
              // state.json but does NOT push a new work_dir_list
              // to the web, so the web has to ask.
              client.sendWorkDirList();
            }}
            onCancel={handleCloseBrowser}
          />
        </WsClientProvider>
      ) : null}

      {/* TokenModal closable — settings button → open. Submit:
          M5 task 05 review W2 — 必须 setAuth(readAuth()) 同步
          auth state 与 localStorage（避免脱钩）。Failure → 内联
          storageError banner（review W1）。

          M5 task 06 review W2 — removed the explicit
          `client.connect(value)` call. The previous code did
          `write → connect → setAuth(readAuth())` which double-
          connected: the manual `connect()` opened a fresh socket
          AND the `useEffect([client, auth.token])` effect below
          saw `auth.token` change via `setAuth(readAuth())` and
          fired ANOTHER `connect()`, tearing down the first
          socket mid-handshake. Now we only `setAuth(readAuth())`
          — the existing useEffect handles the (re)connect
          deterministically exactly once per `auth.token` change,
          with proper cleanup. `hashchange` doesn't fire (hash
          is unchanged), so the explicit `setAuth` is required
          to flush the new token into React state. */}
      {settingsOpen ? (
        <TokenModal
          required={false}
          onSubmit={(value: string) => {
            handleClosableTokenSubmit({
              value,
              client,
              setAuth,
              setStorageError,
              readAuth,
            });
            setSettingsOpen(false);
          }}
          onClose={handleCloseSettings}
          storageError={storageError}
        />
      ) : null}
    </>
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
  gateMapRef,
}: {
  token: string;
  session: string;
  workDir: string;
  client: WsClient;
  gateMapRef: { current: Map<string, RecoveryGate> | null };
}) {
  // `gateMapRef` is owned by App level (M4 验收期 4th gap 修复) so the
  // `handleRefill` callback can execute take-and-set on the gate map
  // during stem-refilled transitions. Token / session changes don't
  // re-create the map — see `RecoveryView` for the auto-start contract
  // that re-fires the ceremony on session change.
  // Defensive: gateMapRef.current is null only if useRecoveryGateMap
  // failed to initialize (e.g. React render path edge case). Fallback
  // to a fresh typed Map — RecoveryShell re-creates it on next render
  // if the gate map becomes empty.
  const map: Map<string, RecoveryGate> =
    gateMapRef.current ?? new Map<string, RecoveryGate>();
  const gate = gateForSession(map, session, workDir, client);
  return <RecoveryView gate={gate} session={session} workDir={workDir} token={token} />;
}

/** Stable-per-mount `Map<sessionKey, RecoveryGate>`. We use
 *  `useRef` (not `useMemo`) so StrictMode's dev double-invoke
 *  doesn't create two maps and orphan the first one's gates
 *  (the gates hold `setTimeout` handles and reply resolvers
 *  that must persist). The map is created empty; the
 *  `gateForSession` helper fills it on demand.
 *
 *  M4 验收期 4th gap 修复——`useRecoveryGateMap` 必须返回**稳定对象**
 *  （identity-stable wrapper），因为 App 级 `handleRefill` 的
 *  `useCallback` 闭包依赖此 ref；若每次 render 返回新 wrapper
 *  对象，handleRefill 身份不稳定 → stem-refilled useEffect deps 变
 *  → 每帧 re-attach watcher → 在 stem refill 到达前 unsub 旧 watcher
 *  + 重新 attach，期间漏接 session_state → 流式不回填。
 *
 *  实际实现：`useRef<Map>(null)` 返回的是 ref object（identity stable
 *  across renders），ref.current 的赋值仅在 mount-once 路径上发生。
 *  调用者统一通过 `.current` 访问 Map——之前 inline `{ current: ref.current }`
 *  wrapper 是 bug（每次 render 新对象）。返回 ref object 直传更省一层。*/
function useRecoveryGateMap(): { current: Map<string, RecoveryGate> | null } {
  const ref = useRef<Map<string, RecoveryGate> | null>(null);
  if (ref.current === null) {
    ref.current = new Map();
  }
  return ref;
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
      //     key 路由——釘子 2）。本分支是真 stem 走仪式，work_dir
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
