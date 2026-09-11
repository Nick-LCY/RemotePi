// TokenModal — the access-token entry dialog. M5 §第二块 G6 / D10
// 落地。
//
// ## Two render modes
//
//   - **`required` (no token cached)** — full-screen modal with
//     backdrop blur; **不可关闭** (no Esc / no backdrop click / no
//     close button). Submission triggers `tokenStorage.write(value)`
//     followed by `window.location.reload()` to re-derive the
//     App's `auth.token` from localStorage and proceed through the
//     normal recovery ceremony path.
//
//   - **`closable` (token cached; opened from Settings)** —
//     same modal layout but **可关闭** through three independent
//     paths: Esc key, backdrop click, X button. Submission triggers
//     `tokenStorage.write(value)` + `onSubmit(value)` callback
//     (the App layer wires this to `client.connect(newToken)` which
//     follows the existing teardown + swap + openSocket semantics).
//
// ## Two submit flows (per D10)
//
//   - **required submit** — the App-level `onSubmit` callback
//     receives the value, calls `tokenStorage.write(value)` +
//     `window.location.reload()`. Hard reload triggers App.tsx to
//     re-derive auth from localStorage; if the user re-enters a
//     valid token, App's `auth.token !== null` branch fires and
//     the recovery ceremony takes over.
//
//   - **closable submit** — the App-level `onSubmit` callback
//     receives the value, calls `tokenStorage.write(value)` +
//     `client.connect(value)`. The existing
//     `WsClient.connect(token)` semantics cover teardown of the
//     old socket + opening a new one with `token` in subprotocol
//     slot 1 — auto-reconnect backoff is reset on connect, so a
//     freshly-cached token will be used by all subsequent
//     outbound envelopes.
//
// ## testid surface (task brief + D10 / task 05 §b)
//
//   - `token-input` (carried over from M3 TokenPrompt —
//     e2e 03 spec asserts on this anchor).
//   - `token-submit` (carried over from M3 TokenPrompt).
//   - `token-modal` (NEW — the dialog container).
//   - `token-modal-backdrop` (NEW — the click target for
//     backdrop-dismiss in closable mode).
//   - `token-modal-close` (NEW — only rendered in closable mode;
//     the X button at the top-right of the dialog).
//
// ## Styling
//
// Tailwind v4 only (任务 04 已就绪：`bg-bg` / `text-text` /
// `border-border` / `backdrop-blur-sm` 等 utility 已经映射到
// 13 个 legacy CSS var via `@theme inline` 块 — D11 落地后所有
// 新组件走 Tailwind，存量 1280 行不触碰）。手机全屏 sheet 形
// 态留任务 07，本任务仅做桌面居中卡片。
//
// ## Focus management (deferred)
//
// 任务 07 才实现完整 `useFocusTrap` + `useFocusOnClose` + 焦点
// 归还。本任务只 `autoFocus` 输入框（required 模式 mount 即聚
// 焦；closable 模式 mount 即聚焦，便于用户立即键入）。Esc 键关闭
// 已经在 closable 模式下实现（keydown 监听器）。
//
// ## Migration note (D9)
//
// M3/M4 的 `TokenPrompt.tsx` 把 token 写到 `location.hash`；本
// 组件是它的继承者——写到 `localStorage` + App 层 reload。
// `TokenPrompt.tsx` 已在 M5 任务 05 中删除（彻底删除，不留 deprecated
// 副本——D9 明确不允许向后兼容迁移；旧书签 `#<token>&work_dir=...`
// 形态会被 App 的 `auth.token === null` 路由到本组件的 required
// 模式，提示用户重新粘贴新 token）。本组件是当前唯一入口。

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TokenModalProps {
  /** When true, the modal is un-closable — no Esc / no backdrop / no
   *  X button. The user MUST submit a value (or close the page).
   *  Use this for the first-touch `auth.token === null` path.
   *
   *  When false, the modal is closable — three independent close
   *  paths (Esc / backdrop / X) call `onClose`. Use this for the
   *  Settings → 「更换 Token」 flow. */
  required: boolean;
  /** Called when the user submits the form. The component itself
   *  does NOT persist the value (that's the App's job) — it just
   *  reports the trimmed string. The required-mode callback in
   *  production wires `tokenStorage.write(value)` +
   *  `window.location.reload()`; the closable-mode callback wires
   *  `tokenStorage.write(value)` + `client.connect(value)`. */
  onSubmit: (token: string) => void;
  /** Required when `required === false`. The component calls this
   *  from each of the three close paths (Esc / backdrop / X). The
   *  TypeScript signature requires `onClose` in closable mode so
   *  the consumer can't accidentally mount an un-closable modal
   *  that has nowhere to escape to.
   *
   *  In `required` mode, `onClose` is not consulted — the dialog
   *  is un-closable. Pass `undefined` (or omit) when `required`
   *  is true. */
  onClose?: () => void;
  /** Optional banner copy displayed at the top of the dialog.
   *  Used by the legacy-bookmark path to surface "旧书签 token 已
   *  失效，请粘贴新 token" — the App reads the current hash shape
   *  and passes an appropriate hint here when required=true. The
   *  default empty string keeps the dialog compact for the
   *  Settings → 更换 Token path. */
  bannerHint?: string;
  /** Optional inline error banner — surfaced when `tokenStorage.write`
   *  returned `false` (privacy mode / quota exceeded / SecurityError).
   *  M5 task 05 review W1 — without this, the App-level submit
   *  handler would silently no-op on write failure and the user
   *  would see no feedback. Inline render at the top of the dialog
   *  (visually below the optional bannerHint) with the bridge-error
   *  colour family so the operator learns one "red = something
   *  failed" signal across all surfaces (mirrors `.dialog-error` /
   *  `.input-bar-error`). Default `null` keeps the dialog compact
   *  for the happy path. */
  storageError?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TokenModal(props: TokenModalProps): JSX.Element {
  const { required, onSubmit, onClose, bannerHint, storageError } = props;
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // autoFocus the input on mount (required mode → user pastes
  // immediately; closable mode → user can tab to it but
  // autoFocus saves a click). Deferred focus-trap implementation
  // lives in task 07 (no Tab-cycling / no single-focusable edge
  // cases yet).
  //
  // We use the React-idiomatic `autoFocus` prop (HTML `autofocus`
  // attribute at mount) AND a `useEffect` `.focus()` call as a
  // belt-and-suspenders — the latter handles the StrictMode
  // double-mount case where the autofocus attribute can be
  // consumed by the first mount and the effect fires after the
  // second mount, ensuring focus lands on the visible input.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Closable-mode close handler — bound to Esc keydown on the
  // modal root. Required mode ignores Esc entirely (D10).
  useEffect(() => {
    if (required) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [required, onClose]);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      onSubmit(trimmed);
    },
    [value, onSubmit],
  );

  const handleBackdropClick = useCallback((): void => {
    if (required) return;
    onClose?.();
  }, [required, onClose]);

  const handleCloseButtonClick = useCallback((): void => {
    if (required) return;
    onClose?.();
  }, [required, onClose]);

  const trimmed = value.trim();
  const submitDisabled = trimmed.length === 0;

  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center p-4"
      data-testid="token-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="token-modal-title"
    >
      {/* Backdrop — blur + dim. Closable mode renders a clickable
          button under it; required mode still renders the backdrop
          for visual depth but it has no click handler. */}
      <button
        type="button"
        aria-label="关闭对话框"
        data-testid="token-modal-backdrop"
        onClick={handleBackdropClick}
        disabled={required}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm cursor-default disabled:cursor-default"
      />

      <div className="relative w-full max-w-md rounded-lg border border-border bg-bg p-6 shadow-xl">
        {/* Close button — only rendered in closable mode (D10). */}
        {!required ? (
          <button
            type="button"
            aria-label="关闭"
            data-testid="token-modal-close"
            onClick={handleCloseButtonClick}
            className="absolute right-3 top-3 text-muted hover:text-text text-xl leading-none"
          >
            ×
          </button>
        ) : null}

        {/* Optional banner — used for the legacy-bookmark UX hint. */}
        {bannerHint !== undefined && bannerHint.length > 0 ? (
          <div
            className="mb-4 rounded border border-border bg-surface-2 px-3 py-2 text-sm text-muted"
            data-testid="token-modal-banner"
            role="note"
          >
            {bannerHint}
          </div>
        ) : null}

        {/* Inline storage-error banner — surfaced when
            `tokenStorage.write` returned false (privacy mode /
            quota exceeded / SecurityError). Renders with the same
            bridge-error colour family as `.dialog-error` / `.input-
            bar-error` so the operator learns one "red = something
            failed" signal across all surfaces. The literal
            `rgba(...)` is hard-coded to mirror `.input-bar-error`'s
            8%-alpha offline tint; using a Tailwind opacity modifier
            on `bg-state-offline/10` would require a Tailwind v4
            `<alpha-value>` channel rewrite of the `var(--state-offline)`
            definition, which would ripple to every other surface —
            not worth it for one inline banner. */}
        {storageError !== undefined && storageError !== null && storageError.length > 0 ? (
          <div
            className="mb-4 rounded border border-state-offline px-3 py-2 text-sm text-state-offline"
            style={{ backgroundColor: 'rgba(192, 57, 43, 0.08)' }}
            data-testid="token-modal-storage-error"
            role="alert"
          >
            {storageError}
          </div>
        ) : null}

        <h2
          id="token-modal-title"
          className="mb-2 text-lg font-semibold text-text"
        >
          {required ? '连接 Bridge' : '更换访问令牌'}
        </h2>
        <p className="mb-4 text-sm text-muted">
          {required
            ? '粘贴你的访问令牌以连接 Bridge。令牌仅保存在浏览器本地存储，不会出现在 URL 或服务器日志中。'
            : '粘贴新的访问令牌以切换 Bridge 连接。'}
        </p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="token-input" className="block text-sm font-medium text-text mb-1">
            访问令牌
          </label>
          <input
            id="token-input"
            ref={inputRef}
            type="password"
            data-testid="token-input"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="paste token"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-text outline-none focus:border-accent"
          />
          <button
            type="submit"
            data-testid="token-submit"
            disabled={submitDisabled}
            className="mt-4 w-full rounded bg-accent px-3 py-2 text-white font-medium hover:bg-accent disabled:bg-accent-disabled disabled:cursor-not-allowed"
          >
            {required ? '连接' : '保存'}
          </button>
        </form>
      </div>
    </div>
  );
}
