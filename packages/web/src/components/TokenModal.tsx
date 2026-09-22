// TokenModal — access-token entry dialog.
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
//     (the App layer wires this to `client.connect(newToken)`).
//
// testids:
//   - `token-input` / `token-submit` — carried over from the M3
//     `TokenPrompt` (e2e 03 asserts on these).
//   - `token-modal` / `token-modal-backdrop` /
//     `token-modal-close` — new (dialog container + dismiss
//     targets).
//
// Focus: closable mode installs `useFocusTrap` (Escape closes);
// required mode has the input as the only focusable element,
// handled by `autoFocus`. Escape handling is centralised in the
// focus trap — the component does NOT attach its own keydown
// listener (a previous duplicate listener was removed).

import { useCallback, useEffect, useRef, useState } from 'react';

import { useFocusTrap } from '../hooks/useFocusTrap.js';
import { useIsMobile } from '../hooks/useIsMobile.js';

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
   *  reports the trimmed string. */
  onSubmit: (token: string) => void;
  /** Required when `required === false`. The component calls this
   *  from each of the three close paths (Esc / backdrop / X). The
   *  TypeScript signature requires `onClose` in closable mode so
   *  the consumer can't accidentally mount an un-closable modal
   *  that has nowhere to escape to. In `required` mode `onClose`
   *  is not consulted — the dialog is un-closable. */
  onClose?: () => void;
  /** Optional banner copy at the top of the dialog. Used by the
   *  legacy-bookmark path to surface "旧书签 token 已失效" UX.
   *  Default empty string keeps the dialog compact for the
   *  Settings → 更换 Token path. */
  bannerHint?: string;
  /** Optional inline error banner — surfaced when
   *  `tokenStorage.write` returned `false` (privacy mode /
   *  quota exceeded / SecurityError). The App-level submit handler
   *  sets this so the user sees feedback on a write failure.
   *  Default `null` keeps the dialog compact for the happy path. */
  storageError?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TokenModal(props: TokenModalProps): JSX.Element {
  const { required, onSubmit, onClose, bannerHint, storageError } = props;
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isMobile = useIsMobile();
  // useFocusTrap target. Closable mode enables the trap; required
  // mode has the input as the only focusable element, handled by
  // autoFocus.
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Closable mode installs the focus trap; Escape calls onClose.
  // No returnFocusRef here — token modal is a full-screen overlay
  // and the focus-restore target depends on the call site
  // (settings button, direct URL route, etc.); the App-level
  // caller decides.
  useFocusTrap({
    active: !required,
    containerRef,
    onEscape: !required ? onClose : undefined,
  });

  // Focus the input on mount. Uses BOTH the React `autoFocus` prop
  // AND a `.focus()` call in an effect — the latter handles the
  // StrictMode double-mount case where the autofocus attribute can
  // be consumed by the first mount and the effect fires after the
  // second mount, ensuring focus lands on the visible input.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
      ref={containerRef}
      className={`fixed inset-0 z-[400] ${isMobile ? 'flex flex-col' : 'flex items-center justify-center p-4'}`}
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

      <div className={isMobile
        ? 'relative flex h-full w-full flex-col overflow-y-auto bg-bg p-4'
        : 'relative w-full max-w-md rounded-lg border border-border bg-bg p-6 shadow-xl'
      }>
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
            quota exceeded / SecurityError). `bg-state-offline/[0.08]`
            is the canonical Tailwind v4 alpha-channel modifier for
            the `--state-offline` token (works because the @theme
            inline block already maps the colour namespace). */}
        {storageError !== undefined && storageError !== null && storageError.length > 0 ? (
          <div
            className="mb-4 rounded border border-state-offline bg-state-offline/[0.08] px-3 py-2 text-sm text-state-offline"
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
