// InputDialog — single-line text input for pi's `input` extension UI
// request. Submits `{ request_id, cancelled: false, value: <text> }`.
// Cancel button emits `{ request_id, cancelled: true }` per PRD §4.2.
//
// ## Reference visual shape (M6 task 07 — D7 accent-blue family)
//
//   - **Card** (desktop): `rounded-2xl bg-surface shadow-2xl
//     w-full max-w-[420px]` (T07 reference; matches TokenModal's
//     T06 reference card shell).
//   - **Header** tinted icon block:
//     `size-11 rounded-xl bg-accent-soft text-accent` with a
//     lucide `<PenLine size={20} />` glyph (D7 accent-blue
//     family shared with editor — distinguishes "type a
//     one-line value" from "pick one" / "yes-no" / "edit a
//     longer value").
//   - **Title**: `text-base font-semibold tracking-tight`.
//   - **Input field**: token-aligned paint —
//     `h-11 rounded-xl border border-border-2 bg-surface-2
//     px-3 text-sm outline-none transition
//     placeholder:text-muted-5 focus:border-accent
//     focus:ring-4 focus:ring-accent-ring` (matches the
//     TokenModal input — D7 single-focus indicator idiom).
//   - **Footer**: shared `DialogFooter` (cancel outline +
//     submit accent).
//
// ## testids (zero add / zero drop vs M5 baseline)
//
//   - `dialog-input` — container.
//   - `dialog-input-field` — the input element.
//   - `dialog-cancel` / `dialog-confirm-yes` — footer buttons.

import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { PenLine } from 'lucide-react';

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
    <div
      className="dialog dialog-input pointer-events-auto m-2 flex w-[min(420px,92vw)] flex-col rounded-2xl bg-surface p-0 text-text shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`input-title-${entry.id}`}
      data-testid="dialog-input"
    >
      <DialogHeader
        id={`input-title-${entry.id}`}
        title={entry.title}
        timeoutMs={entry.timeout}
        enqueuedAt={enqueuedAt}
        onTimeout={onTimeout}
        icon={<PenLine className="size-5" />}
        iconClassName="size-11 rounded-xl flex items-center justify-center bg-accent-soft text-accent"
      />
      {errorMessage !== null ? (
        <p className="dialog-error m-0 border-b border-border bg-state-offline/10 px-4 py-2 text-[0.85rem] text-state-offline" role="alert" data-testid="dialog-error">
          {errorMessage}
        </p>
      ) : null}
      <form onSubmit={handleSubmit} className="dialog-body flex flex-col gap-3 px-5 pb-5 pt-1">
        <input
          type="text"
          className="dialog-input-field h-11 rounded-xl border border-border-2 bg-surface-2 px-3 text-sm outline-none transition placeholder:text-muted-5 focus:border-accent focus:ring-4 focus:ring-accent-ring"
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
    </div>
  );
}
