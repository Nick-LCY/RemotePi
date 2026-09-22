// DirectoryBrowser — lets the user pick a directory off the
// filesystem and add it to the saved work_dirs list.
//
// Calls `client.sendListDirectories(path)` to enumerate the
// children of `path` (omitted ⇒ bridge defaults to `$HOME`) and
// shows a "上到 home" button that re-issues the same command with
// `path` omitted.
//
// Lifecycle:
//   - Local React state holds `path: string | null`. `null` means
//     "show home" — the outbound `list_directories` omits `path`.
//   - On path change (initial mount + button clicks) we fire
//     `sendListDirectories(path)` and register a one-shot
//     `registerReplyResolver` callback. A `setTimeout` watchdog
//     (`LIST_DIRECTORIES_TIMEOUT_MS`) clears the resolver on
//     timeout.
//   - Each row shows "name" + a "选择" button. Clicking "选择"
//     fires `sendWorkDirAdd(path)` with the same one-shot
//     callback + watchdog pattern.
//
// Bridge error handling (PRD §6.5):
//   - `invalid_envelope` → "路径无效 / 不存在 / 不可读" (ENOENT/
//     EACCES/EPERM/ENOTDIR etc.).
//   - `internal` → "bridge 内部错误" for unexpected I/O errors.
//   - `unknown` → fallback when the reply carried no error code
//     (defensive).

import { useCallback, useEffect, useRef, useState } from 'react';

import { useFocusTrap } from '../hooks/useFocusTrap.js';
import { useIsMobile } from '../hooks/useIsMobile.js';
import { useWsClient } from '../ws/WsClientContext.js';

interface DirectoryBrowserProps {
  /** When false, the browser renders nothing (parent is hiding
   *  it). Default true for backward compat with the legacy
   *  ChoicePage level=1 mount path. */
  open?: boolean;
  /** Called after `work_dir_add` succeeds. Parent typically uses
   *  this to write the new work_dir into the URL hash, which
   *  triggers App's `hashchange` listener and re-dispatches to
   *  ChoicePage level=2. */
  onAdded: (path: string) => void;
  /** Called when the user dismisses the browser (e.g. hits
   *  Escape or clicks "取消"). */
  onCancel: () => void;
}

interface ListEntries {
  entries: Array<{ name: string; path: string }>;
}

// Watchdog budgets:
//   - LIST_DIRECTORIES_TIMEOUT_MS = 10_000 (large directory
//     readdirSync can be slow; relaxed from 5s).
//   - WORK_DIR_ADD_TIMEOUT_MS = 5_000 (lightweight fs op, same
//     shape as M3 RECOVERY_TIMEOUT_MS).
const LIST_DIRECTORIES_TIMEOUT_MS = 10_000;
const WORK_DIR_ADD_TIMEOUT_MS = 5_000;

export function DirectoryBrowser({ open, onAdded, onCancel }: DirectoryBrowserProps) {
  const client = useWsClient();
  // When `open === false`, return an empty fragment so the modal
  // doesn't occupy DOM slots that could catch a backdrop click or
  // leak focus.
  if (open === false) return <></>;

  // Mobile: full-screen sheet. Desktop: centred `.card` panel.
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLElement | null>(null);
  useFocusTrap({
    active: true, // 永远 trap（open=true 时）：移动端避免键盘跑
                  // 到背后 hidden 区；桌面端避免 Tab 跳出模态。
    containerRef,
    onEscape: onCancel,
  });

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

  // Fetch entries whenever `path` changes. `path === null`
  // triggers a home query (no `path` in the outbound).
  //
  // One-shot callback pattern (mirrors `recovery.ts`'s
  // `registerReplyResolver`):
  //   1. `sendListDirectories(path?)` → outbound id.
  //   2. `registerReplyResolver(id, cb)` registers a one-shot
  //      callback that parses `envelope.payload.data.entries` (or
  //      `payload.error`) for the success/failure branch.
  //   3. `setTimeout` watchdog (`LIST_DIRECTORIES_TIMEOUT_MS`);
  //      timeout → unsub + `setListError`.
  //   4. useEffect cleanup cancels both timer and unsub.
  //   5. `inFlightListRef` is a defensive guard — the cleanup
  //      already unsubs, but the resolver closure still checks the
  //      ref before mutating state so a stale reply that somehow
  //      raced past cleanup is still dropped.
  //
  // `setEntries(null) + setListError(null)` at effect start
  // preserves the "switch path → clear stale entries + clear
  // errors" semantic.
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
      // Success: parse `envelope.payload.data.entries`. Schema is
      // `ListDirectoriesResult` = `{ entries: { name, path }[] }`.
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
    <section
      ref={containerRef}
      // `directory-browser` retained as a semantic anchor on the
      // desktop form — the e2e 09 spec asserts mobile should NOT
      // contain the literal `card directory-browser` substring,
      // so we don't add `card` class to the desktop form (the
      // chrome utilities below replace it 1-for-1). Mobile form
      // stays free of both classes — the spec assertion
      // `not.toContain('card directory-browser')` is satisfied
      // trivially.
      className={isMobile
        ? 'directory-browser-mobile fixed inset-0 z-[250] flex flex-col gap-3 overflow-y-auto bg-bg p-4'
        : 'directory-browser flex flex-col gap-3 rounded-lg border border-dashed border-border bg-surface px-5 py-4'
      }
      data-testid="directory-browser"
      role="dialog"
      aria-modal="true"
      aria-labelledby="directory-browser-title"
    >
      <div className="directory-browser-header flex flex-col gap-2">
        <h3 id="directory-browser-title" className="directory-browser-title m-0 text-base">浏览目录</h3>
        <p className="directory-browser-path m-0 text-[0.88rem] text-muted" data-testid="directory-browser-path">
          当前路径：<code>{path ?? '$HOME'}</code>
        </p>
        <div className="directory-browser-actions flex gap-2">
          <button
            type="button"
            onClick={goHome}
            disabled={path === null}
            data-testid="directory-browser-home"
            className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-text disabled:opacity-50"
          >
            上到 home
          </button>
          <button
            type="button"
            onClick={onCancel}
            data-testid="directory-browser-cancel"
            className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-text"
          >
            取消
          </button>
        </div>
      </div>

      {listError !== null ? (
        <p
          className="directory-browser-error m-0 rounded bg-state-offline/[0.08] px-3 py-2 text-[0.85rem] text-state-offline"
          role="alert"
          data-testid="directory-browser-error"
        >
          {listError}
        </p>
      ) : null}

      {addError !== null ? (
        <p
          className="directory-browser-error m-0 rounded bg-state-offline/[0.08] px-3 py-2 text-[0.85rem] text-state-offline"
          role="alert"
          data-testid="directory-browser-add-error"
        >
          {addError}
        </p>
      ) : null}

      {entries === null && listError === null ? (
        <p className="directory-browser-loading m-0 text-[0.88rem] text-muted" data-testid="directory-browser-loading">
          加载中…
        </p>
      ) : null}

      {entries !== null ? (
        <ul className="directory-browser-entries m-0 flex max-h-[40vh] list-none flex-col gap-1 overflow-y-auto p-0" data-testid="dir-entries">
          {entries.entries.length === 0 ? (
            <li className="directory-browser-empty text-[0.88rem] text-muted">（无子目录）</li>
          ) : (
            entries.entries.map((entry) => (
              <li
                key={entry.path}
                className="directory-browser-entry grid grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)_auto] items-center gap-2 rounded border border-border bg-surface-2 px-2 py-1"
                data-testid="dir-entry"
              >
                <span
                  className="directory-browser-entry-name text-[0.92rem] font-semibold"
                  data-testid="dir-entry-name"
                >
                  {entry.name}
                </span>
                <span className="directory-browser-entry-path break-all font-mono text-[0.82rem] text-muted">
                  <code>{entry.path}</code>
                </span>
                <div className="directory-browser-entry-actions flex gap-1">
                  <button
                    type="button"
                    onClick={() => navigateTo(entry.path)}
                    data-testid="dir-entry-open"
                    className="rounded border border-border bg-surface px-2 py-0.5 text-[0.82rem] text-text"
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelect(entry.path)}
                    disabled={addingPath === entry.path}
                    data-testid="dir-entry-select"
                    className="rounded border border-accent bg-accent px-2 py-0.5 text-[0.82rem] text-white disabled:bg-accent-disabled disabled:border-accent-disabled"
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