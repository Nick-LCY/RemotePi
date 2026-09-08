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
  /** M4 §4.5 (tasks/m4/08): `Date.now()` at the moment the entry
   *  arrived via `session_state` (the WsClient stamps it on
   *  inbound). Drives the countdown math so a switch-back to a
   *  background dialog resumes at the correct point — see
   *  `useCountdown` JSDoc in `SelectDialog.tsx` for the full
   *  rationale. */
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
    // value: false — decline. THIS is the canonical "no" path on
    // the wire (R2 fix): the web emits `value: false` (boolean),
    // not a string, not a cancel. The bridge translates to
    // pi's `{ confirmed: false }`.
    onSubmit({ request_id: entry.id, cancelled: false, value: false });
  };

  const handleCancel = () => {
    if (pending) return;
    onCancel({ request_id: entry.id, cancelled: true });
  };

  const buttonsDisabled = pending || errorMessage !== null;

  return (
    <dialog
      className="dialog dialog-confirm"
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
        <p className="dialog-error" role="alert" data-testid="dialog-error">
          {errorMessage}
        </p>
      ) : null}
      <div className="dialog-body">
        <p className="dialog-confirm-message">{entry.message}</p>
        <div className="dialog-footer">
          <button
            type="button"
            onClick={handleCancel}
            disabled={pending}
            className="dialog-button dialog-button-cancel"
            data-testid="dialog-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDecline}
            disabled={buttonsDisabled}
            className="dialog-button dialog-button-decline"
            data-testid="dialog-decline"
          >
            No
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={buttonsDisabled}
            className="dialog-button dialog-button-submit"
            data-testid="dialog-confirm-yes"
          >
            Yes
          </button>
        </div>
      </div>
    </dialog>
  );
}
