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

import { useCallback, useEffect, useState } from 'react';
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
  useEffect(() => {
    const id = client.sendWorkDirList();
    const start = Date.now();
    const pollHandle = setInterval(() => {
      const result = client.takeWorkDirResult(id);
      if (result !== null) {
        clearInterval(pollHandle);
        return;
      }
      if (Date.now() - start > 5_000) {
        clearInterval(pollHandle);
      }
    }, 50);
    return () => clearInterval(pollHandle);
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
      const start = Date.now();
      const pollHandle = setInterval(() => {
        const result = client.takeWorkDirResult(id);
        if (result !== null) {
          clearInterval(pollHandle);
          setRemovingPath(null);
          if (!result.ok) {
            setRemoveError(
              `移除失败（${result.error?.code ?? 'unknown'}）：${result.error?.message ?? 'unknown error'}`,
            );
            return;
          }
          // Re-fetch so the mirror catches up. We don't await —
          // the cache update fires automatically when the
          // work_dir_list reply lands.
          client.sendWorkDirList();
          // If the user just removed their currently-selected
          // work_dir, fall back to level=1 (we're already here, so
          // no-op; if they removed a different one, the
          // currentWorkDir store mirror stays valid).
          if (currentWorkDir === path) {
            window.location.hash = changeWorkDirHash(token);
          }
          return;
        }
        if (Date.now() - start > 5_000) {
          clearInterval(pollHandle);
          setRemovingPath(null);
          setRemoveError('work_dir_remove 超时未回执 — bridge 可能离线');
        }
      }, 50);
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
  useEffect(() => {
    setError(null);
    client.sendSessionList(workDir);
    // 轮询一个 timeout 守门 — 没有数据轮询（mirror 由 inbound
    // 回执 wholesale 替换）。如果 5s 内没回执则提示错误。
    const start = Date.now();
    const pollHandle = setInterval(() => {
      if (Date.now() - start > 5_000) {
        clearInterval(pollHandle);
        setError('session_list 超时未回执 — bridge 可能离线');
      }
    }, 50);
    return () => clearInterval(pollHandle);
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