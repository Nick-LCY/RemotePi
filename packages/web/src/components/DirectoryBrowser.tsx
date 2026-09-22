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
//
// ## M6 T08 — reference modal visual shape (D7 family)
//
//   - **Outer wrapper** (testid `directory-browser`):
//     `fixed inset-0 z-[250]` — same outer pattern as the
//     TokenModal reference modal. Mobile: stays full-screen
//     `flex flex-col gap-3 overflow-y-auto bg-bg p-4`. Desktop:
//     `flex items-center justify-center p-4` to centre the card.
//   - **Backdrop** (desktop only, **M+ (b) 兑现** — M4 kept
//     DirectoryBrowser without a backdrop on desktop):
//     `absolute inset-0 bg-deep/30 backdrop-blur-[3px]` deep
//     slate + 3px blur, click fires `onCancel`. Matches the
//     TokenModal / DialogHost backdrop family (`bg-deep` token
//     from `--deep`; 30% alpha for the DirectoryBrowser scrim
//     is intentionally slightly lighter than TokenModal's 45%
//     because the DirectoryBrowser modal is a working list
//     rather than a blocking auth gate).
//   - **Card** (desktop): `w-full max-w-[480px] rounded-2xl
//     bg-surface p-6 shadow-2xl` — reference blueprint slightly
//     wider than TokenModal's 420px because the directory entry
//     rows hold name + path + dual action buttons across three
//     conceptual columns. Shadow-2xl (no border) supplies the
//     elevation; the desktop form does NOT carry the legacy
//     `card` class — the e2e 09 spec asserts that mobile
//     `data-testid="directory-browser"` should not contain the
//     substring `card directory-browser`, so we deliberately
//     avoid the literal `card` class on either breakpoint.
//   - **Header tinted icon block**: `size-11 rounded-xl
//     bg-accent-soft text-accent` (44×44) with a lucide
//     `<FolderOpen size={20} />` glyph. Same chrome language as
//     TokenModal's Hash icon block + the 4 类 DialogHost tinted
//     icon blocks (D7 family — blue tinted family for input /
//     editor / directory types).
//   - **Title**: `text-base font-semibold tracking-tight text-
//     text` — slightly smaller than TokenModal's `text-xl` to
//     match the in-card widget scale (the DirectoryBrowser
//     header sits inside a multi-row working area, not a
//     blocking gate).
//   - **Path bar** (testid `directory-browser-path`):
//     `text-sm text-muted-3` wrapper + inline code `rounded
//     bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-accent`
//     — name/path single line with the active path in a soft
//     accent-tinted code chip.
//   - **Action buttons**: `上到 home` / `取消` as `rounded-lg
//     border border-border bg-surface px-3 py-1.5 text-sm
//     text-text hover:bg-surface-2 disabled:cursor-not-allowed`
//     — same shape as T07 cancel buttons (white-on-surface
//     outlined pair); the `disabled:opacity-50` modifier keeps
//     the empty path state legible.
//   - **Entry row** (testid `dir-entry`):
//     `rounded-xl border border-border bg-surface p-2
//     hover:bg-surface-2` card + dual-line name + path inside
//     the row + inline 「打开」/「选择」 action buttons.
//     `open` button = white-on-surface outlined (弱态描边);
//     `select` button = accent-soft background + accent
//     foreground (accent 弱态) to differentiate the two
//     actions without competing with the title's primary
//     blue block.
//   - **Errors** (`directory-browser-error` / `directory-browser
//     -add-error`): state-offline family — `bg-state-offline/[0.08]
//     text-state-offline rounded-md px-3 py-2` — kept for visual
//     continuity with the other red "something failed" banners
//     (`.input-bar-error` / `.dialog-error` / `.dialog-host-
//     toast` / `.message-tool-result-error`).
//   - **Loading**: `text-sm text-muted-3` — same as the path
//     bar (loading is "now we'll resolve the path").
//
// ## Mobile full-screen sheet (M5 沿用)
//
// M5 任务 07 mobile sheet path stays zero-changed:
//   - `<768px`: outer wrapper is `fixed inset-0 z-[250] flex
//     flex-col gap-3 overflow-y-auto bg-bg p-4` (matches the
//     e2e 09 spec assertion `toContain('inset-0')`).
//   - Backdrop is NOT rendered on mobile (the sheet fills the
//     viewport; no scrim needed).
//
// ## Focus trap + click-out semantics
//
// `useFocusTrap` is always active while `open === true`. The
// container ref points to the outer wrapper (same pattern as
// TokenModal) so Tab cycles through the card content; the
// backdrop `<button>` is in the cycle as well (browser default
// button focus — same shape as TokenModal's backdrop where
// the button cycles into and out of focus). Escape always fires
// `onCancel`. **Backdrop click** also fires `onCancel` (M4
// 既有行为保留 per task brief).
//
// ## testids (zero add / zero drop vs M5 / D6 baseline)
//
//   - `directory-browser` (root wrapper — both breakpoints)
//   - `directory-browser-path` (path bar)
//   - `directory-browser-home` (上到 home button)
//   - `directory-browser-cancel` (取消 button)
//   - `directory-browser-error` (list-level error banner)
//   - `directory-browser-add-error` (per-entry add error)
//   - `directory-browser-loading` (loading placeholder)
//   - `dir-entries` (entry list)
//   - `dir-entry` (row)
//   - `dir-entry-name` (name span)
//   - `dir-entry-open` (open / navigate button)
//   - `dir-entry-select` (select / choose button)
//
// No `data-*` attributes are touched. Per the brief the
// backdrop is intentionally NOT tagged with a new testid
// (PRD testid zero-add commitment); e2e + unit locators use
// existing className patterns.

import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';

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
   *  Escape or clicks "取消" or backdrop — M4 行为保留). */
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

  // Mobile: full-screen sheet (`flex flex-col bg-bg p-4`).
  // Desktop: centred modal (`flex items-center justify-center p-4`)
  // — same shape as TokenModal.
  const isMobile = useIsMobile();
  // containerRef points to the outer wrapper. The trap is always
  // active while open === true; mobile avoids Tab escape into the
  // hidden page body, desktop avoids Tab escape out of the modal.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap({
    active: true,
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

  // Outer wrapper chrome — same fixed-inset-0 z-250 pattern as
  // TokenModal. Mobile keeps the full-screen sheet form so the
  // e2e 09 spec assertion (testid element has `inset-0`) and
  // `not.toContain('card directory-browser')` continue to hold.
  const outerClass = isMobile
    ? 'directory-browser-mobile fixed inset-0 z-[250] flex flex-col gap-3 overflow-y-auto bg-bg p-4'
    : 'directory-browser fixed inset-0 z-[250] flex items-center justify-center p-4';

  // Inner card — desktop is the reference blueprint (T08 D7);
  // mobile reuses the sheet body (no rounded corners, no shadow,
  // no max-width per M5 任务 07 mobile sheet idiom).
  const cardClass = isMobile
    ? 'flex h-full w-full flex-col gap-4'
    : 'relative flex w-full max-w-[480px] flex-col gap-4 rounded-2xl bg-surface p-6 shadow-2xl';

  return (
    <div
      ref={containerRef}
      className={outerClass}
      data-testid="directory-browser"
      role="dialog"
      aria-modal="true"
      aria-labelledby="directory-browser-title"
    >
      {/* Backdrop — desktop only. M+ (b) 兑现: M4 kept the
          DirectoryBrowser as a flat panel without a scrim; the
          T08 modal化 adds a deep-slate 30% scrim with 3px blur
          to match the TokenModal / DialogHost backdrop family.
          Click fires `onCancel` (M4 click-out 既有行为保留).
          Mobile is full-screen → no backdrop needed. */}
      {!isMobile ? (
        <button
          type="button"
          aria-label="关闭对话框"
          onClick={onCancel}
          className="absolute inset-0 cursor-default border-0 bg-deep/30 backdrop-blur-[3px]"
        />
      ) : null}

      <div className={cardClass}>
        {/* Header — tinted icon block + title (D7 family). */}
        <div className="flex items-start gap-3">
          <div
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"
            aria-hidden="true"
          >
            <FolderOpen className="size-5" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3
              id="directory-browser-title"
              className="directory-browser-title m-0 text-base font-semibold tracking-tight text-text"
            >
              浏览目录
            </h3>
            <p
              className="directory-browser-path m-0 text-sm text-muted-3"
              data-testid="directory-browser-path"
            >
              当前路径：
              <code className="ml-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-accent">
                {path ?? '$HOME'}
              </code>
            </p>
          </div>
        </div>

        {/* Action row — 「上到 home」 / 「取消」 as a paired
            outlined button group. Same shape as T07 cancel
            buttons (white-on-surface outlined); `hover:bg-
            surface-2` is the only chrome additive compared to
            M5 (the rest buttons stayed solid surface). */}
        <div className="directory-browser-actions flex gap-2">
          <button
            type="button"
            onClick={goHome}
            disabled={path === null}
            data-testid="directory-browser-home"
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            上到 home
          </button>
          <button
            type="button"
            onClick={onCancel}
            data-testid="directory-browser-cancel"
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text hover:bg-surface-2"
          >
            取消
          </button>
        </div>

        {listError !== null ? (
          <p
            className="directory-browser-error m-0 rounded-md bg-state-offline/[0.08] px-3 py-2 text-sm text-state-offline"
            role="alert"
            data-testid="directory-browser-error"
          >
            {listError}
          </p>
        ) : null}

        {addError !== null ? (
          <p
            className="directory-browser-error m-0 rounded-md bg-state-offline/[0.08] px-3 py-2 text-sm text-state-offline"
            role="alert"
            data-testid="directory-browser-add-error"
          >
            {addError}
          </p>
        ) : null}

        {entries === null && listError === null ? (
          <p
            className="directory-browser-loading m-0 text-sm text-muted-3"
            data-testid="directory-browser-loading"
          >
            加载中…
          </p>
        ) : null}

        {entries !== null ? (
          <ul
            className="directory-browser-entries m-0 flex max-h-[50vh] list-none flex-col gap-2 overflow-y-auto p-0"
            data-testid="dir-entries"
          >
            {entries.entries.length === 0 ? (
              <li className="directory-browser-empty text-sm text-muted-3">（无子目录）</li>
            ) : (
              entries.entries.map((entry) => (
                <li
                  key={entry.path}
                  className="directory-browser-entry flex items-start gap-3 rounded-xl border border-border bg-surface p-2 hover:bg-surface-2"
                  data-testid="dir-entry"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className="directory-browser-entry-name truncate text-sm text-text"
                      data-testid="dir-entry-name"
                    >
                      {entry.name}
                    </span>
                    <span className="directory-browser-entry-path break-all font-mono text-xs text-muted-4">
                      <code>{entry.path}</code>
                    </span>
                  </div>
                  <div className="directory-browser-entry-actions flex shrink-0 gap-1.5">
                    <button
                      type="button"
                      onClick={() => navigateTo(entry.path)}
                      data-testid="dir-entry-open"
                      className="rounded-lg border border-border bg-surface px-2.5 py-1 text-xs text-text transition hover:bg-surface-2"
                    >
                      打开
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelect(entry.path)}
                      disabled={addingPath === entry.path}
                      data-testid="dir-entry-select"
                      className="rounded-lg border border-accent bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent transition hover:border-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {addingPath === entry.path ? '选择中…' : '选择'}
                    </button>
                  </div>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
    </div>
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
