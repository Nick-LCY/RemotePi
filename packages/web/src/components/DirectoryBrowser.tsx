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

const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 5_000;

interface DirectoryBrowserProps {
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

interface WorkDirAddOutcome {
  ok: boolean;
  error?: { code: string; message: string };
}

export function DirectoryBrowser({ onAdded, onCancel }: DirectoryBrowserProps) {
  const client = useWsClient();
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
  // home query (no `path` in the outbound). The polling loop reads
  // `takeListDirResult(id)`; on success we replace the entries; on
  // timeout / socket drop we surface an error.
  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setListError(null);
    const id = client.sendListDirectories(path ?? undefined);
    inFlightListRef.current = id;
    const start = Date.now();
    const pollHandle = setInterval(() => {
      if (cancelled) return;
      if (inFlightListRef.current !== id) {
        // A newer navigation superseded this one — stop polling.
        clearInterval(pollHandle);
        return;
      }
      const result = client.takeListDirResult(id);
      if (result !== null) {
        clearInterval(pollHandle);
        inFlightListRef.current = null;
        setEntries({ entries: result });
        return;
      }
      if (Date.now() - start > POLL_TIMEOUT_MS) {
        clearInterval(pollHandle);
        inFlightListRef.current = null;
        setListError('list_directories 超时未回执 — bridge 可能离线');
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(pollHandle);
    };
  }, [client, path]);

  const navigateTo = useCallback((next: string) => {
    setPath(next);
  }, []);

  const goHome = useCallback(() => {
    setPath(null);
  }, []);

  /** Click handler for a "选择" button on a row. Fires
   *  `work_dir_add` and polls the result map; on success calls
   *  `onAdded` (parent advances to level=2). On failure surfaces the
   *  bridge message inline. */
  const handleSelect = useCallback(
    (selectedPath: string) => {
      setAddingPath(selectedPath);
      setAddError(null);
      const id = client.sendWorkDirAdd(selectedPath);
      const start = Date.now();
      const pollHandle = setInterval(() => {
        const result: WorkDirAddOutcome | null = client.takeWorkDirResult(id);
        if (result !== null) {
          clearInterval(pollHandle);
          setAddingPath(null);
          if (result.ok) {
            onAdded(selectedPath);
            return;
          }
          setAddError(formatAddError(result.error));
          return;
        }
        if (Date.now() - start > POLL_TIMEOUT_MS) {
          clearInterval(pollHandle);
          setAddingPath(null);
          setAddError('work_dir_add 超时未回执 — bridge 可能离线');
        }
      }, POLL_INTERVAL_MS);
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