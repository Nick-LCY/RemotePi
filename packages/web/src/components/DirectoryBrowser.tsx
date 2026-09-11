// DirectoryBrowser — M4 tasks/m4/07 DirectoryBrowser component.
//
// Renders inside ChoicePage level=1 ("浏览添加" button) to let the
// user pick a directory off the filesystem. Calls
// `client.sendListDirectories(path)` to enumerate the children of
// `path` (缺省 = $HOME on the bridge side) and shows a "上到 home"
// button that re-issues the same command with `path` omitted.
//
// Lifecycle / state machine:
//   - Local React state holds `path: string | null`. `null` means
//     "show home" — the outbound `list_directories` omits `path` and
//     the bridge defaults to `$HOME` (control.md §6.5).
//   - On path change (initial mount + button clicks) we fire
//     `sendListDirectories(path)` and poll `takeListDirResult(id)`
//     until the reply lands. The poll is short-lived (every 50ms,
//     bounded to 5s — same envelope budget as the recovery
//     ceremony's per-reply window). On timeout / socket-drop we
//     surface an error message instead of crashing.
//   - Each row shows "name" + a "选择" button. Clicking "选择" fires
//     `sendWorkDirAdd(path)` and polls `takeWorkDirResult(id)` for
//     the success/failure verdict. On success we call
//     `onAdded(path)` (parent typically advances to level=2 by
//     writing the hash). On failure we show the bridge-side message
//     inline; the user can retry by clicking "选择" again.
//
// Error handling (PRD §6.5 / tasks/m4/05 错误码映射):
//   - `invalid_envelope` → "路径无效 / 不存在 / 不可读" —
//     usually ENOENT/EACCES/EPERM/ENOTDIR. We surface this as the
//     bridge message verbatim (the message includes a domain hint).
//   - `internal` → "bridge 内部错误" — fallback for unexpected
//     I/O errors.
//   - `unknown` → fallback when the reply carried no error code
//     (defensive — should never occur on a healthy bridge).

import { useCallback, useEffect, useRef, useState } from 'react';

import { useWsClient } from '../ws/WsClientContext.js';

// Review 修复轮 C1+W1——废弃 POLL_INTERVAL_MS / POLL_TIMEOUT_MS
// setInterval 50ms 轮询常量。轮询路径改为一次性回调（见下方
// useEffect + handleSelect 实现），仅保留 setTimeout 看门狗
// 常量 LIST_DIRECTORIES_TIMEOUT_MS / WORK_DIR_ADD_TIMEOUT_MS
// （定义在文件中段，靠近使用点便于审阅）。

interface DirectoryBrowserProps {
  /** When false, the browser renders nothing (parent is hiding
   *  it). Default true for backward compat with the ChoicePage
   *  level=1 mount path (where the parent renders the browser
   *  inline whenever `browsing === true`). M5 task 06
   *  Sidebar → WorkDirs tab → 浏览添加 路径下，`open` is the
   *  canonical visibility flag and the parent no longer needs
   *  to track a separate `browsing` state. */
  open?: boolean;
  /** Called after `work_dir_add` succeeds. Parent typically uses
   *  this to write the new work_dir into the URL hash, which
   *  triggers App's `hashchange` listener and re-dispatches to
   *  ChoicePage level=2. */
  onAdded: (path: string) => void;
  /** Called when the user dismisses the browser (e.g. presses an
   *  "上一步" button or hits Escape). */
  onCancel: () => void;
}

interface ListEntries {
  entries: Array<{ name: string; path: string }>;
}

// Review 修复轮 C1+W1+W5——`WorkDirAddOutcome` 内部类型删除（只
// 轮询路径内部使用；resolver 回调直接从 envelope.payload 解析）。

// 超时预算集中常量：
//   - LIST_DIRECTORIES_TIMEOUT_MS = 10_000（reviewer W1 推导：大
//     目录 readdirSync 可能慢，fs 操作看门狗从 5s 放宽到 10s）；
//   - WORK_DIR_ADD_TIMEOUT_MS = 5_000（add 路径与 work_dir_*
//     同为轻量 fs 操作，参考 M3 RECOVERY_TIMEOUT_MS）。
const LIST_DIRECTORIES_TIMEOUT_MS = 10_000;
const WORK_DIR_ADD_TIMEOUT_MS = 5_000;

export function DirectoryBrowser({ open, onAdded, onCancel }: DirectoryBrowserProps) {
  const client = useWsClient();
  // M5 task 06 — modal-化：父组件持 `open` 开关；`open === false`
  // 时不渲染（避免 modal 仍占 DOM 槽位导致 backdrop 点击触发空
  // handler / a11y 焦点泄漏）。`open` 默认 `true` 向后兼容既有
  // ChoicePage level=1 mount 路径（父组件 `<>{browsing ? <DB
  // /> : null}</>` 一直显式 mount）。
  if (open === false) return <></>;

  // `path === null` ⇒ 列 home (path omitted from outbound); otherwise
  // 列 this absolute path. Initial value `null` so the first paint
  // immediately shows $HOME without an extra click — most users
  // start by browsing their own home directory.
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<ListEntries | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [addingPath, setAddingPath] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  // Track the in-flight list_directories id so a stale reply from a
  // navigation we already left behind can't overwrite `entries`.
  // Mirrors the WsClient's reply-resolver one-shot semantics — a
  // newer query supersedes the older one in the UI even if the older
  // reply lands last.
  const inFlightListRef = useRef<string | null>(null);

  // Fetch entries whenever `path` changes. `path === null` triggers a
  // home query (no `path` in the outbound).
  //
  // Review 修复轮 C1+W1+W5——废弃 setInterval 50ms 轮询 +
  // transient `listDirResults` Map + `takeListDirResult` 方法，
  // 改为一次性回调模式（对齐 M3 recovery.ts
  // `registerReplyResolver` 先例）：
  //   1. sendListDirectories(path?) → outbound id;
  //   2. registerReplyResolver(id, cb) 注册一次性回调——resolver
  //      内部从 envelope.payload 解析 entries（success）或
  //      `payload.error`（failure）走成功/失败分支；
  //   3. setTimeout 看门狗（10s — list_directories 属 fs 操作，
  //      大目录 readdirSync 可能慢，reviewer W1 推导）；超时
  //      → unsub + setListError；
  //   4. useEffect cleanup 统一 clearTimeout + unsub（W5）；
  //   5. inFlightListRef 防护语义保留——resolver 闭包内检查
  //      ref 仍持有本次 id；否则陈旧回执丢弃（尽管 cleanup
  //      已经 unsub，双保险）。
  // setEntries(null) + setListError(null) 在 effect 起始同步执行，
  // 保持原“切换路径 → 清陈旧 entries + 清错误”语义。
  useEffect(() => {
    setEntries(null);
    setListError(null);
    const id = client.sendListDirectories(path ?? undefined);
    inFlightListRef.current = id;
    let unsub: (() => void) | null = null;
    const watchdog = setTimeout(() => {
      unsub?.();
      inFlightListRef.current = null;
      setListError('list_directories 超时未回执 — bridge 可能离线');
    }, LIST_DIRECTORIES_TIMEOUT_MS);
    unsub = client.registerReplyResolver(id, (env) => {
      if (inFlightListRef.current !== id) return;
      clearTimeout(watchdog);
      inFlightListRef.current = null;
      if (env.kind !== 'control' || env.type !== 'result') return;
      if (env.payload.ok !== true) {
        const err = env.payload.error;
        setListError(
          `读取目录失败（${err?.code ?? 'unknown'}）：${err?.message ?? 'unknown error'}`,
        );
        return;
      }
      // 成功：从 envelope.payload.data 解析 entries。 schema
      // `ListDirectoriesResult` = { entries: { name, path }[] }。
      const data = env.payload.data;
      if (data === null || typeof data !== 'object') return;
      const entriesRaw = (data as { entries?: unknown }).entries;
      if (!Array.isArray(entriesRaw)) return;
      const parsed: Array<{ name: string; path: string }> = [];
      for (const e of entriesRaw) {
        if (e !== null && typeof e === 'object') {
          const obj = e as { name?: unknown; path?: unknown };
          if (typeof obj.name === 'string' && typeof obj.path === 'string') {
            parsed.push({ name: obj.name, path: obj.path });
          }
        }
      }
      setEntries({ entries: parsed });
    });
    return () => {
      clearTimeout(watchdog);
      unsub?.();
    };
  }, [client, path]);

  const navigateTo = useCallback((next: string) => {
    setPath(next);
  }, []);

  const goHome = useCallback(() => {
    setPath(null);
  }, []);

  /** Click handler for a "选择" button on a row. Fires
   *  `work_dir_add` and waits for the reply via
   *  `registerReplyResolver` (一次性回调 + 5s 看门狗)；on
   *  success calls `onAdded` (parent advances to level=2). On
   *  failure surfaces the bridge message inline.
   *
   *  Review 修复轮 C1+W1——废弃 setInterval 50ms 轮询 +
   *  transient `workDirResults` + `takeWorkDirResult` 方法，
   *  改为一次性回调模式（与 useEffect 同形）：
   *    1. sendWorkDirAdd(path) → outbound id;
   *    2. registerReplyResolver(id, cb) 从 envelope.payload 解析
   *       ok / error 走成功/失败分支；
   *    3. setTimeout 看门狗（5s — work_dir_add 与 mount 同）；
   *    4. let unsub 让超时闭包可调 + 成功后 resolver 内部
   *       双保险 unsub（注册仅一次性，dispatchReplyResolvers
   *       自动从内部 map 删除）。
   */
  const handleSelect = useCallback(
    (selectedPath: string) => {
      setAddingPath(selectedPath);
      setAddError(null);
      const id = client.sendWorkDirAdd(selectedPath);
      let unsub: (() => void) | null = null;
      const watchdog = setTimeout(() => {
        unsub?.();
        setAddingPath(null);
        setAddError('work_dir_add 超时未回执 — bridge 可能离线');
      }, WORK_DIR_ADD_TIMEOUT_MS);
      unsub = client.registerReplyResolver(id, (env) => {
        clearTimeout(watchdog);
        setAddingPath(null);
        if (env.kind !== 'control' || env.type !== 'result') return;
        if (env.payload.ok !== true) {
          setAddError(formatAddError(env.payload.error));
          return;
        }
        onAdded(selectedPath);
      });
    },
    [client, onAdded],
  );

  return (
    <section className="card directory-browser" data-testid="directory-browser">
      <div className="directory-browser-header">
        <h3>浏览目录</h3>
        <p className="directory-browser-path" data-testid="directory-browser-path">
          当前路径：<code>{path ?? '$HOME'}</code>
        </p>
        <div className="directory-browser-actions">
          <button
            type="button"
            onClick={goHome}
            disabled={path === null}
            data-testid="directory-browser-home"
          >
            上到 home
          </button>
          <button
            type="button"
            onClick={onCancel}
            data-testid="directory-browser-cancel"
          >
            取消
          </button>
        </div>
      </div>

      {listError !== null ? (
        <p
          className="directory-browser-error"
          role="alert"
          data-testid="directory-browser-error"
        >
          {listError}
        </p>
      ) : null}

      {addError !== null ? (
        <p
          className="directory-browser-error"
          role="alert"
          data-testid="directory-browser-add-error"
        >
          {addError}
        </p>
      ) : null}

      {entries === null && listError === null ? (
        <p className="directory-browser-loading" data-testid="directory-browser-loading">
          加载中…
        </p>
      ) : null}

      {entries !== null ? (
        <ul className="directory-browser-entries" data-testid="dir-entries">
          {entries.entries.length === 0 ? (
            <li className="directory-browser-empty">（无子目录）</li>
          ) : (
            entries.entries.map((entry) => (
              <li
                key={entry.path}
                className="directory-browser-entry"
                data-testid="dir-entry"
              >
                <span
                  className="directory-browser-entry-name"
                  data-testid="dir-entry-name"
                >
                  {entry.name}
                </span>
                <span className="directory-browser-entry-path">
                  <code>{entry.path}</code>
                </span>
                <div className="directory-browser-entry-actions">
                  <button
                    type="button"
                    onClick={() => navigateTo(entry.path)}
                    data-testid="dir-entry-open"
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelect(entry.path)}
                    disabled={addingPath === entry.path}
                    data-testid="dir-entry-select"
                  >
                    {addingPath === entry.path ? '选择中…' : '选择'}
                  </button>
                </div>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </section>
  );
}

/** Pretty-print the bridge-side error from a `work_dir_add`
 *  failure. The bridge uses a 6-value lock-versioned
 *  `ERROR_CODES` set; `internal` covers `WorkDirStore.StateError`
 *  (the file-write / three-piece-check failure path) and
 *  `invalid_envelope` would only appear if the outbound payload was
 *  malformed (impossible for this code path). We surface the bridge
 *  message verbatim so any future error code adds itself to the UI
 *  without a code change here. */
function formatAddError(
  error: { code: string; message: string } | undefined,
): string {
  if (error === undefined) return '添加失败（无错误详情）';
  return `添加失败（${error.code}）：${error.message}`;
}