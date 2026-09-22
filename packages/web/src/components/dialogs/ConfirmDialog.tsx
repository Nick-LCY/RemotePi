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
    // re-enable pointer events on itself.
    <dialog
      className="dialog dialog-confirm pointer-events-auto m-2 flex w-[min(420px,92vw)] flex-col rounded-lg border border-border bg-surface p-0 text-text shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
      open
      aria-labelledby={`confirm-title-${entry.id}`}
      data-testid="dialog-confirm"
    >
      <DialogHeader
        id={`confirm-title-${entry.id}`}
        title={entry.title}
        timeoutMs={entry.timeout}
        enqueuedAt={enqueuedAt}
        onTimeout={onTimeout}
      />
      {errorMessage !== null ? (
        <p className="dialog-error m-0 border-b border-border bg-state-offline/[0.12] px-3 py-2 text-[0.85rem] text-state-offline" role="alert" data-testid="dialog-error">
          {errorMessage}
        </p>
      ) : null}
      <div className="dialog-body flex flex-col gap-[0.65rem] px-[0.95rem] py-[0.85rem]">
        <p className="dialog-confirm-message m-0 text-[0.95rem] text-text">{entry.message}</p>
        <div className="dialog-footer flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={pending}
            className="dialog-button dialog-button-cancel rounded-md border border-border bg-surface px-3 py-1.5 font-[inherit] text-text disabled:cursor-not-allowed disabled:bg-accent-disabled disabled:border-accent-disabled"
            data-testid="dialog-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDecline}
            disabled={buttonsDisabled}
            className="dialog-button dialog-button-decline rounded-md border border-border bg-surface px-3 py-1.5 font-[inherit] text-text disabled:cursor-not-allowed disabled:bg-accent-disabled disabled:border-accent-disabled"
            data-testid="dialog-decline"
          >
            No
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={buttonsDisabled}
            className="dialog-button dialog-button-submit rounded-md border border-accent bg-accent px-3 py-1.5 font-[inherit] text-white disabled:cursor-not-allowed disabled:bg-accent-disabled disabled:border-accent-disabled"
            data-testid="dialog-confirm-yes"
          >
            Yes
          </button>
        </div>
      </div>
    </dialog>
  );
}
