// ConfirmDialog — render the pi `confirm` extension UI request.
//
// The "no" path is the canonical wire shape fix (PRD §4.2 / R2):
// the user clicking the decline button MUST emit
//   { request_id, cancelled: false, value: false }
// — `value` is `false` (boolean), not a string. The web wire shape
// is documented in `ExtensionUIResponsePayloadSchema`: `confirm`
// uses `value: boolean`, while select / input / editor use
// `value: string`. Bridge translates this to pi's native
// `confirmed: boolean` at the bridge boundary (PRD §1.6 / §2.4).
//
// Two paths emit a value:
//   - "Confirm" (true)  → { cancelled: false, value: true }
//   - "Decline" (false) → { cancelled: false, value: false }
// The "Cancel" button emits:
//   - { cancelled: true }    (no value — schema refine requires it)
//
// ## Reference visual shape (M6 task 07 — D7 emerald family)
//
//   - **Card** (desktop): `rounded-2xl bg-surface shadow-2xl
//     w-full max-w-[420px]` (T07 reference; matches TokenModal's
//     T06 reference card shell).
//   - **Header** tinted icon block:
//     `size-11 rounded-xl bg-state-online/10 text-state-online`
//     with a lucide `<HelpCircle size={20} />` glyph (D7
//     emerald family reserved for confirm — the green tint
//     distinguishes "yes / no" from "pick one" / "type" / "edit").
//   - **Title**: `text-base font-semibold tracking-tight`.
//   - **Footer**: primary `Confirm` (accent blue), `Decline`
//     uses the destructive state-offline family (PRD §4.5
//     destructive pattern), and `Cancel` uses the white-outline
//     secondary. Destructive variant keeps the
//     `dialog-confirm-destructive` semantic anchor unused on
//     the styling front — the existing testid surface still
//     pins `dialog-confirm-yes` / `dialog-decline` /
//     `dialog-cancel`.
//
// ## testids (zero add / zero drop vs M5 baseline)
//
//   - `dialog-confirm` — container.
//   - `dialog-confirm-yes` / `dialog-decline` / `dialog-cancel` —
//     footer buttons (yes is the primary affirmative; decline is
//     the destructive No; cancel is the wire-shape cancel).
//   - `dialog-confirm-message` / `dialog-error` — body
//     text / error banner.

import { HelpCircle } from 'lucide-react';

import { DialogHeader } from './shared.js';

import type { BlockedOnEntryPayload } from '@remotepi/shared';

export interface ConfirmDialogProps {
  entry: Extract<BlockedOnEntryPayload, { method: 'confirm' }>;
  /** `Date.now()` at the moment the entry arrived via
   *  `session_state`. Drives the countdown math so a
   *  switch-back to a background dialog resumes at the correct
   *  point — see `useCountdown` JSDoc in `SelectDialog.tsx`. */
  enqueuedAt: number;
  pending: boolean;
  errorMessage: string | null;
  onSubmit: (payload: { request_id: string; cancelled: false; value: boolean }) => void;
  onCancel: (payload: { request_id: string; cancelled: true }) => void;
  onTimeout: () => void;
}

export function ConfirmDialog({
  entry,
  enqueuedAt,
  pending,
  errorMessage,
  onSubmit,
  onCancel,
  onTimeout,
}: ConfirmDialogProps) {
  const handleConfirm = () => {
    if (pending || errorMessage !== null) return;
    // value: true — accept the prompt.
    onSubmit({ request_id: entry.id, cancelled: false, value: true });
  };

  const handleDecline = () => {
    if (pending || errorMessage !== null) return;
    // Canonical "no" path: `value: false` (boolean), not a string,
    // not a cancel. The bridge translates to pi's
    // `{ confirmed: false }`.
    onSubmit({ request_id: entry.id, cancelled: false, value: false });
  };

  const handleCancel = () => {
    if (pending) return;
    onCancel({ request_id: entry.id, cancelled: true });
  };

  const buttonsDisabled = pending || errorMessage !== null;

  return (
    // `dialog` + `dialog-confirm` retained as semantic anchors.
    // `pointer-events-auto` is needed because the parent
    // `.dialog-host` paints `pointer-events: none` (clicks
    // pass through to the chat) and the actual dialog must
    // re-enable pointer events on itself. Container chrome
    // shifted from M5 `rounded-lg border border-border
    // shadow-[0_8px_28px_...]` → T07 reference
    // `rounded-2xl bg-surface shadow-2xl` (no border —
    // shadow-2xl carries the elevation).
    <div
      className="dialog dialog-confirm pointer-events-auto m-2 flex w-[min(420px,92vw)] flex-col rounded-2xl bg-surface p-0 text-text shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`confirm-title-${entry.id}`}
      data-testid="dialog-confirm"
    >
      <DialogHeader
        id={`confirm-title-${entry.id}`}
        title={entry.title}
        timeoutMs={entry.timeout}
        enqueuedAt={enqueuedAt}
        onTimeout={onTimeout}
        icon={<HelpCircle className="size-5" />}
        iconClassName="size-11 rounded-xl flex items-center justify-center bg-state-online/10 text-state-online"
      />
      {errorMessage !== null ? (
        <p className="dialog-error m-0 border-b border-border bg-state-offline/10 px-4 py-2 text-[0.85rem] text-state-offline" role="alert" data-testid="dialog-error">
          {errorMessage}
        </p>
      ) : null}
      <div className="dialog-body flex flex-col gap-3 px-5 pb-5 pt-1">
        <p className="dialog-confirm-message m-0 text-sm leading-6 text-muted">{entry.message}</p>
        <div className="dialog-footer flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={handleCancel}
            disabled={pending}
            className="dialog-button dialog-button-cancel inline-flex h-10 items-center justify-center rounded-xl border border-border-2 bg-surface px-4 text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:bg-accent-disabled disabled:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
            data-testid="dialog-cancel"
          >
            Cancel
          </button>
          {/* Decline keeps the M4 destructive paint (`bg-state-
              offline` family) — a `Yes`/`No` confirm is the one
              context where a red "No" button reads as an
              alternative affirmative, not an error (PRD §4.5
              destructive pattern). The red colour does NOT use
              `bg-state-offline/[0.08]` — the destructive button
              wears the full-strength token so the "No" still
              reads as the same destructive family as
              `.dialog-error`. Hover darkens via
              `hover:bg-state-offline/90`. */}
          <button
            type="button"
            onClick={handleDecline}
            disabled={buttonsDisabled}
            className="dialog-button dialog-button-decline inline-flex h-10 items-center justify-center rounded-xl bg-state-offline px-4 text-sm font-semibold text-on-offline transition hover:bg-state-offline/90 disabled:cursor-not-allowed disabled:bg-accent-disabled focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
            data-testid="dialog-decline"
          >
            No
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={buttonsDisabled}
            className="dialog-button dialog-button-submit dialog-confirm-destructive inline-flex h-10 items-center justify-center rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-accent-disabled focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
            data-testid="dialog-confirm-yes"
          >
            Yes
          </button>
        </div>
      </div>
    </div>
  );
}
