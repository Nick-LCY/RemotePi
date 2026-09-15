// InputDialog — single-line text input for pi's `input` extension UI
// request. Submits `{ request_id, cancelled: false, value: <text> }`.
// Cancel button emits `{ request_id, cancelled: true }` per PRD §4.2.

import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import { DialogHeader, DialogFooter } from './shared.js';

import type { BlockedOnEntryPayload } from '@remotepi/shared';

export interface InputDialogProps {
  entry: Extract<BlockedOnEntryPayload, { method: 'input' }>;
  /** See `ConfirmDialog` JSDoc. */
  enqueuedAt: number;
  pending: boolean;
  errorMessage: string | null;
  onSubmit: (payload: { request_id: string; cancelled: false; value: string }) => void;
  onCancel: (payload: { request_id: string; cancelled: true }) => void;
  onTimeout: () => void;
}

export function InputDialog({
  entry,
  enqueuedAt,
  pending,
  errorMessage,
  onSubmit,
  onCancel,
  onTimeout,
}: InputDialogProps) {
  const [value, setValue] = useState('');

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setValue(event.target.value);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || errorMessage !== null) return;
    onSubmit({ request_id: entry.id, cancelled: false, value });
    // Defensive: clear locally so a re-render before unmount
    // doesn't surface stale text. The parent unmounts us on the
    // next session_state frame.
    setValue('');
  };

  const handleCancel = () => {
    if (pending) return;
    onCancel({ request_id: entry.id, cancelled: true });
  };

  const submitDisabled = pending || errorMessage !== null;

  return (
    <dialog
      className="dialog dialog-input"
      open
      aria-labelledby={`input-title-${entry.id}`}
      data-testid="dialog-input"
    >
      <DialogHeader
        id={`input-title-${entry.id}`}
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
      <form onSubmit={handleSubmit} className="dialog-body">
        <input
          type="text"
          className="dialog-input-field"
          data-testid="dialog-input-field"
          value={value}
          onChange={handleChange}
          placeholder={entry.placeholder ?? ''}
          autoFocus
          disabled={submitDisabled}
        />
        <DialogFooter
          onCancel={handleCancel}
          submitLabel="Submit"
          submitDisabled={submitDisabled}
        />
      </form>
    </dialog>
  );
}
