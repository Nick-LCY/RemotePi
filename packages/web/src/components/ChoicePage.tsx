// ChoicePage — M4 tasks/m4/07 入口选择页（裁定 A + 钉子 6）。
//
// Two render paths selected by the `level` prop:
//   - level=1 (token + no work_dir): top "选择工作目录" + middle
//     work_dirs list + bottom "浏览添加" button → DirectoryBrowser.
//   - level=2 (token + work_dir + no session): top "选择会话" +
//     current work_dir path + "更换目录" button + "新建会话"
//     button + middle sessions list (with status badges).
//
// Navigation actions (钉子 6):
//   - Selecting a work_dir (row click OR DirectoryBrowser "选择")
//     writes the hash via `selectWorkDirHash(token, work_dir)` →
//     `hashchange` → App re-dispatches to level=2.
//   - Removing a work_dir fires `work_dir_remove` and re-fetches
//     `work_dir_list` to update the in-memory mirror.
//   - "更换目录" writes `changeWorkDirHash(token)` → App
//     re-dispatches to level=1.
//   - Selecting a session writes `selectSessionHash(token, work_dir,
//     sessionKey)` → App re-dispatches to RecoveryView.
//   - "新建会话" writes `newSessionHash(token, work_dir)` (= adds
//     `session=new`) → App re-dispatches to RecoveryView (the
//     bridge pending-key path takes over from there).
//
// 钉子 5 (level2 刷新时机) — handled here:
//   - 进入 level=2 时查询一次（mount 触发）— `useEffect` dep =
//     `[client, workDir]`；mount 本身是 React 第一次跑该 effect。
//   - 从 ChatView 退回 level=2 时重查 — App.tsx 从 `<RecoveryShell>`
//     切回 `<ChoicePage level={2}>` 是新 mount（render 分支变化），
//     重新跑 effect，本任务不需要额外的 setState trigger。
//   - 新会话 stem 回填后重查 — 此任务留 hook 点：完整实现需要
//     任务 08 的 per-session store（pending 状态从 bridge 推回
//     web），本任务的 stem 回填事件只是写到 hash（task 08 接管
//     `session_state.session` 监听 + 重查调度）。
//   - workDir 变化时重查 — 同 effect dep 触发，user 在 level=2
//     点"更换目录"回到 level=1 选另一个目录 → 回到 level=2 时
//     `workDir` prop 变了，effect 重跑。
//   - NO polling — `useEffect` 是唯一查询调度入口；setInterval 仅
//     作为 timeout 守门（5s 未回执报错）。
//
// State source: WsClient mirror (`workDirs` / `currentWorkDir` /
// `sessionList`). All outbound mutations are Hash writes (single
// source of truth) + `wsClient.sendXxx()` for mutations that don't
// touch the URL (work_dir_add / work_dir_remove). After every
// mutation we re-fire `work_dir_list` so the mirror stays current —
// the bridge doesn't broadcast changes itself; the web polls.

import { useCallback, useEffect, useRef, useState } from 'react';

// Review 修复轮——超时预算集中常量：
//   - WORK_DIR_TIMEOUT_MS / SESSION_LIST_TIMEOUT_MS = 5_000（参考
//     M3 RECOVERY_TIMEOUT_MS；这些 control 命令均为轻量 fs /
//     内存查询，bridge 一秒内可回应）；
//   - LIST_DIRECTORIES_TIMEOUT_MS = 10_000（list_directories 属
//     fs 操作，大目录 readdirSync 可能慢——见 reviewer W1 推导）。
const WORK_DIR_TIMEOUT_MS = 5_000;
const SESSION_LIST_TIMEOUT_MS = 5_000;
import type { SessionListEntry } from '@remotepi/shared';

import {
  changeWorkDirHash,
  newSessionHash,
  selectSessionHash,
  selectWorkDirHash,
} from '../hash.js';
import {
  useCurrentWorkDir,
  useSessionList,
  useWsClient,
  useWorkDirs,
} from '../ws/WsClientContext.js';
import { DirectoryBrowser } from './DirectoryBrowser.js';

interface ChoicePageProps {
  level: 1 | 2;
  token: string;
  /** Required when `level === 2`. App.tsx only passes this when the
   *  hash has a `work_dir` component — `decideView()` already
   *  proved the field is present at the level=2 branch. */
  workDir?: string;
}

export function ChoicePage(props: ChoicePageProps) {
  if (props.level === 1) {
    return <ChoiceLevel1 token={props.token} />;
  }
  // props.workDir is non-null at the level=2 dispatch branch (App's
  // `decideView()` already proved the hash has a work_dir), but we
  // narrow defensively so a stale render after a hash change doesn't
  // crash.
  if (props.workDir === undefined) {
    return <ChoiceLevel1 token={props.token} />;
  }
  return <ChoiceLevel2 token={props.token} workDir={props.workDir} />;
}

// ---------------------------------------------------------------------------
// ChoiceLevel1 — work directory selection
// ---------------------------------------------------------------------------

function ChoiceLevel1({ token }: { token: string }) {
  const client = useWsClient();
  const workDirs = useWorkDirs();
  const currentWorkDir = useCurrentWorkDir();
  const [browsing, setBrowsing] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removingPath, setRemovingPath] = useState<string | null>(null);

  // First-mount fetch — work_dirs list mirrors `bridge/state.json`
  // (PRD §2.1). We always fetch on mount so a refresh / F5 / hard
  // navigation also re-syncs the mirror with the canonical bridge
  // state. Mutation actions (`work_dir_add` / `work_dir_remove`)
  // re-fire the same query below to invalidate the cache.
  //
  // Review 修复轮 C1+W1+W5——废弃 setInterval 50ms 轮询 +
  // transient `workDirResults` Map + `takeWorkDirResult` 方法，
  // 改为一次性回调模式（对齐 M3 recovery.ts
  // `registerReplyResolver` 先例）：
  //   1. sendWorkDirList() → outbound id;
  //   2. registerReplyResolver(id, cb) 注册一次性回调；
  //   3. setTimeout 看门狗——超时调 unsub（静默，原实现
  //      mount 阶段超时无 UI 反馈；mirror 空数组 + "暂无保存
  //      的工作目录"提示已足够）；
  //   4. useEffect cleanup 统一 clearTimeout + unsub（W5）；
  //   5. 5s 超时预算（work_dir_list 属小包 fs 操作，参考 M3
  //      RECOVERY_TIMEOUT_MS）。
  // 自动清理：reply 到达时 `dispatchReplyResolvers` 自动从
  // 内部 map 删除 resolver（one-shot）——无需 resolver 内部
  // 调用 unsub；显式 unsub 仍保留作双保险。
  //
  // S4 顺手：进入时清陈旧 removeError 状态（用户在别的路径已经
  // 看过该错误，回到 level=1 不应继续展示——避免重新 mount
  // 仍顶置上一轮的移除失败提示）。
  useEffect(() => {
    setRemoveError(null);
    const id = client.sendWorkDirList();
    let unsub: (() => void) | null = null;
    const watchdog = setTimeout(() => {
      unsub?.();
      // 静默超时——原实现 mount 阶段超时无 UI 反馈；保持行为
      // 一致（mirror 保持空数组，UI 展示"暂无保存的工作目录"）。
    }, WORK_DIR_TIMEOUT_MS);
    unsub = client.registerReplyResolver(id, () => {
      // 镜像已由 WsClient 集中 case 'result' 处理器（work_dir_list
      // 解码分支）更新，无需此处手动 setWorkDirs。看门狗清除。
      clearTimeout(watchdog);
    });
    return () => {
      clearTimeout(watchdog);
      unsub?.();
    };
  }, [client]);

  const handleSelect = useCallback(
    (path: string) => {
      // Write the hash → hashchange listener re-dispatches to
      // ChoicePage level=2. We do NOT call any outbound command
      // here (the directory is already in `workDirs`, which means
      // the bridge has it).
      window.location.hash = selectWorkDirHash(token, path);
    },
    [token],
  );

  const handleRemove = useCallback(
    (path: string) => {
      setRemoveError(null);
      setRemovingPath(path);
      const id = client.sendWorkDirRemove(path);
      // Review 修复轮 C1+W1+W5——废弃 setInterval 50ms 轮询 +
      // transient `workDirResults` + `takeWorkDirResult`：
      //   - 一次性回调 `registerReplyResolver(id, cb)` 处理
      //     成功/失败两种分支（成功 → 重查 mirror + 处理
      //     currentWorkDir 回落；失败 → setRemoveError）；
      //   - setTimeout 看门狗超时 → unsub + setRemoveError；
      //   - 5s 超时预算（work_dir_remove 与 mount 同）。
      // 注意：setRemovingPath(null) 是删除结束的 “UI 反馈点”
      // 必须在成功 + 失败 + 超时三条路径都调用——原轮询实现
      // 保证过；这里用 let 持有 unsub 让超时闭包可调用。
      let unsub: (() => void) | null = null;
      const watchdog = setTimeout(() => {
        unsub?.();
        setRemovingPath(null);
        setRemoveError('work_dir_remove 超时未回执 — bridge 可能离线');
      }, WORK_DIR_TIMEOUT_MS);
      unsub = client.registerReplyResolver(id, (env) => {
        clearTimeout(watchdog);
        setRemovingPath(null);
        if (env.kind !== 'control' || env.type !== 'result') return;
        if (env.payload.ok !== true) {
          // 失败：bridge 拒绝（StateError / path 不在 state.json
          // / 权限不足等）；error.code / error.message 来自 bridge
          // 6-code 锁版集合。
          const err = env.payload.error;
          setRemoveError(
            `移除失败（${err?.code ?? 'unknown'}）：${err?.message ?? 'unknown error'}`,
          );
          return;
        }
        // 成功：重查 mirror 让 UI 赶上 bridge 端 state.json。
        // 重查本身不 await——成功 reset 的 setWorkDirs 在
        // work_dir_list reply 到达时自动触发（central handler
        // 路径）。
        client.sendWorkDirList();
        // 若被删的是当前选中的 work_dir（用户在 level=1 时
        // 应不会发生——`currentWorkDir` 由 hash 反推，level=1
        // 无 work_dir 字段；但保留原逻辑以防御 stale render），
        // 跳回 level=1；非当前选中则 mirror 不动。
        if (currentWorkDir === path) {
          window.location.hash = changeWorkDirHash(token);
        }
      });
    },
    [client, currentWorkDir, token],
  );

  const handleBrowseAdded = useCallback(
    (path: string) => {
      // DirectoryBrowser "选择" succeeded — write the hash, which
      // triggers App's hashchange listener → re-dispatch to level=2.
      setBrowsing(false);
      window.location.hash = selectWorkDirHash(token, path);
    },
    [token],
  );

  return (
    <section className="card choice-page choice-level-1" data-testid="choice-page" data-level="1">
      <h2>选择工作目录</h2>
      <p className="choice-page-hint">裁定 A：必须先选目录才能看会话列表。</p>

      {removeError !== null ? (
        <p
          className="choice-page-error"
          role="alert"
          data-testid="choice-page-remove-error"
        >
          {removeError}
        </p>
      ) : null}

      {workDirs.length === 0 ? (
        <p className="choice-page-empty" data-testid="work-dir-empty">
          暂无保存的工作目录。请通过下方"浏览添加"按钮选择一个目录。
        </p>
      ) : (
        <ul className="choice-page-list" data-testid="work-dir-list">
          {workDirs.map((path) => (
            <li
              key={path}
              className="choice-page-row"
              data-testid="work-dir-row"
              data-path={path}
            >
              <button
                type="button"
                onClick={() => handleSelect(path)}
                className="choice-page-row-button"
                data-testid="work-dir-select"
                data-path={path}
              >
                <code>{path}</code>
              </button>
              <button
                type="button"
                onClick={() => handleRemove(path)}
                className="choice-page-row-remove"
                disabled={removingPath === path}
                data-testid="work-dir-remove"
                data-path={path}
              >
                {removingPath === path ? '移除中…' : '删除'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="choice-page-actions">
        <button
          type="button"
          onClick={() => setBrowsing(true)}
          data-testid="work-dir-browse"
        >
          浏览添加
        </button>
      </div>

      {browsing ? (
        <DirectoryBrowser
          onAdded={handleBrowseAdded}
          onCancel={() => setBrowsing(false)}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ChoiceLevel2 — session selection (per current work_dir)
// ---------------------------------------------------------------------------

interface ChoiceLevel2Props {
  token: string;
  workDir: string;
}

function ChoiceLevel2({ token, workDir }: ChoiceLevel2Props) {
  const client = useWsClient();
  const sessionList = useSessionList();
  const [error, setError] = useState<string | null>(null);
  // W4 inFlightListRef 同款防护：记录最近一次 sendSessionList
  // 生成的 id；resolver 回调内如果发现已被新询查覆写则丢弃。
  // 与 WsClient 集中处理器中 `_lastSessionListId` 守卫互补：
  // 组件层避免本地 resolver 运行；WsClient 层避免 mirror 写入。
  // useEffect cleanup 正常会 unsub 旧 resolver；本 ref 是防御层。
  const inFlightListRef = useRef<string | null>(null);

  // 钉子 5 — level=2 刷新时机：
  //   - 进入 level=2 时查询一次（首次 mount 触发）
  //   - 从 ChatView 退回 level=2 时重查（App.tsx 从 <RecoveryShell>
  //     切回 <ChoicePage level={2}> 是新 mount — 本 effect 重新触发）
  //   - 新会话 stem 回填后重查（pending → 真实 stem 时连带一次）
  //     —— 此任务留 hook 点，完整实现在任务 08（per-session store）
  //   - 不做轮询
  //
  // 触发规则：dep = `[client, workDir]`。mount + workDir 字符串
  // 变化都重查。session 维度不作为 dep：上述 mount 转换已经覆盖
  // 了"从 ChatView 退回"的场景（App.tsx 的 render 分支变化保证
  // ChoicePage 是新 mount），新会话 stem 回填留待任务 08 接线。
  // 这样避免了 setState 触发额外渲染 / 重查的复杂性。
  //
  // Review 修复轮 C1+W1——废弃 setInterval 纯超时看门狗
  // （reviewer W1 原话：入站 setSessionList 已更新 store 镜像，
  // 看门狗只需单个 setTimeout(5s) → setError）：
  //   1. sendSessionList(workDir) → outbound id;
  //   2. registerReplyResolver(id, cb) 注册一次性回调（只需
  //      清看门狗 + W4 inFlightListRef 守卫——mirror 写入已
  //      由 WsClient 集中处理器 + `_lastSessionListId` 守卫）；
  //   3. setTimeout 看门狗超时 → unsub + setError；
  //   4. useEffect cleanup 统一 clearTimeout + unsub（W5）；
  //   5. 5s 超时预算（session_list 与 work_dir_* 同为轻量 fs
  //      操作，参考 M3 RECOVERY_TIMEOUT_MS）。
  useEffect(() => {
    setError(null);
    const id = client.sendSessionList(workDir);
    inFlightListRef.current = id;
    let unsub: (() => void) | null = null;
    const watchdog = setTimeout(() => {
      unsub?.();
      setError('session_list 超时未回执 — bridge 可能离线');
    }, SESSION_LIST_TIMEOUT_MS);
    unsub = client.registerReplyResolver(id, (_env) => {
      // W4 组件层守卫：resolver 闭包内检查 inFlightListRef 仍
      // 持有本次 id；否则是陈旧回执（中间 workDir 变化导致
      // cleanup 已 unsub，但同时新 mount 写入 inFlightListRef）
      // ——丢弃避免 callback 误调 setError 之类的状态。
      if (inFlightListRef.current !== id) return;
      clearTimeout(watchdog);
      // 镜像已由 WsClient 集中 case 'result' 处理器（session_list
      // 解码分支 + _lastSessionListId 守卫）更新；本回调仅做
      // 守卫 + 清看门狗。
    });
    return () => {
      clearTimeout(watchdog);
      unsub?.();
    };
  }, [client, workDir]);

  const handleSelectSession = useCallback(
    (sessionKey: string) => {
      window.location.hash = selectSessionHash(token, workDir, sessionKey);
    },
    [token, workDir],
  );

  const handleNewSession = useCallback(() => {
    // 钉子 6 新建会话：写 hash `&session=new` → 进 ChatView
    // pending（bridge 收到 session:'new' + work_dir 启动 pending
    // 键控）。本任务先把 hash 写对 + 进恢复链；pending 完整行为
    // （包括 stem 回填事件回写 hash）落到任务 08。
    window.location.hash = newSessionHash(token, workDir);
  }, [token, workDir]);

  const handleChangeWorkDir = useCallback(() => {
    // 钉子 6 更换目录：清 work_dir + session，回 level=1。
    window.location.hash = changeWorkDirHash(token);
  }, [token]);

  return (
    <section className="card choice-page choice-level-2" data-testid="choice-page" data-level="2">
      <div className="choice-page-header">
        <h2>选择会话</h2>
        <p className="choice-page-current-work-dir">
          工作目录：<code data-testid="choice-page-work-dir">{workDir}</code>
        </p>
        <div className="choice-page-header-actions">
          <button
            type="button"
            onClick={handleNewSession}
            data-testid="session-new"
          >
            新建会话
          </button>
          <button
            type="button"
            onClick={handleChangeWorkDir}
            data-testid="work-dir-change"
          >
            更换目录
          </button>
        </div>
      </div>

      {error !== null ? (
        <p className="choice-page-error" role="alert" data-testid="choice-page-error">
          {error}
        </p>
      ) : null}

      {sessionList === null ? (
        <p className="choice-page-loading" data-testid="session-list-loading">
          加载会话列表…
        </p>
      ) : sessionList.length === 0 ? (
        <p className="choice-page-empty" data-testid="session-list-empty">
          该目录下暂无会话。点击"新建会话"创建第一个会话。
        </p>
      ) : (
        <ul className="choice-page-list" data-testid="session-list">
          {sessionList.map((entry) => (
            <SessionListRow
              key={entry.id}
              entry={entry}
              onSelect={handleSelectSession}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// SessionListRow — single row in level=2 list (extracted for testability)
// ---------------------------------------------------------------------------

interface SessionListRowProps {
  entry: SessionListEntry;
  onSelect: (sessionKey: string) => void;
}

function SessionListRow({ entry, onSelect }: SessionListRowProps) {
  const handleClick = useCallback(() => {
    onSelect(entry.id);
  }, [entry.id, onSelect]);

  return (
    <li
      className="choice-page-row"
      data-testid="session-row"
      data-session={entry.id}
      data-status={entry.status}
    >
      <button
        type="button"
        onClick={handleClick}
        className="choice-page-row-button"
        data-testid="session-select"
        data-session={entry.id}
      >
        <div className="choice-page-row-meta">
          <span className="choice-page-row-time" data-testid="session-row-time">
            {entry.created}
          </span>
          <span
            className={`choice-page-row-status status-${entry.status}`}
            data-testid="session-row-status"
            data-status={entry.status}
          >
            {entry.status}
          </span>
        </div>
        <div className="choice-page-row-first" data-testid="session-row-first">
          {entry.first_message ?? '（无首条消息）'}
        </div>
      </button>
    </li>
  );
}