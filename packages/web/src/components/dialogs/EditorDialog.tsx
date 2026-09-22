// EditorDialog — multi-line textarea for pi's `editor` extension UI
// request. Submits `{ request_id, cancelled: false, value: <text> }`.
// Cancel button emits `{ request_id, cancelled: true }` per PRD §4.2.
//
// Known behaviour: editor has NO `timeout` field in the wire shape
// (PRD §4.2 + ADR-0004 — editor blocks indefinitely; the agent
// only emits `agent_settled` after the user submits). We therefore
// do not render the countdown header for this method, and the
// `timeoutMs` prop on DialogHeader is undefined.
//
// The textarea is rendered with a min-height so it doesn't collapse
// when the prefill is empty. The user can resize vertically with
// the standard browser textarea grip.

import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import { DialogHeader, DialogFooter } from './shared.js';

import type { BlockedOnEntryPayload } from '@remotepi/shared';

export interface EditorDialogProps {
  entry: Extract<BlockedOnEntryPayload, { method: 'editor' }>;
  /** See `ConfirmDialog` JSDoc. Editor does not timeout so the
   *  countdown UI never renders; the field is accepted for
   *  shape consistency with the other dialogs and is unused. */
  enqueuedAt: number;
  pending: boolean;
  errorMessage: string | null;
  onSubmit: (payload: { request_id: string; cancelled: false; value: string }) => void;
  onCancel: (payload: { request_id: string; cancelled: true }) => void;
  /** Editor does not timeout — DialogHeader will receive
   *  `undefined` and skip the countdown bar. We still accept the
   *  prop so the signature matches the other dialogs (the host
   *  passes a no-op for editor). */
  onTimeout: () => void;
}

export function EditorDialog({
  entry,
  enqueuedAt,
  pending,
  errorMessage,
  onSubmit,
  onCancel,
  onTimeout,
}: EditorDialogProps) {
  const [value, setValue] = useState(entry.prefill ?? '');

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(event.target.value);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || errorMessage !== null) return;
    onSubmit({ request_id: entry.id, cancelled: false, value });
  };

  const handleCancel = () => {
    if (pending) return;
    onCancel({ request_id: entry.id, cancelled: true });
  };

  const submitDisabled = pending || errorMessage !== null;

  return (
    <dialog
      className="dialog dialog-editor pointer-events-auto m-2 flex w-[min(420px,92vw)] flex-col rounded-md border border-border bg-surface p-0 text-text shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
      open
      aria-labelledby={`editor-title-${entry.id}`}
      data-testid="dialog-editor"
    >
      {/* Editor never carries a timeout — DialogHeader receives
          undefined and renders the title-only variant. */}
      <DialogHeader
        id={`editor-title-${entry.id}`}
        title={entry.title}
        enqueuedAt={enqueuedAt}
        onTimeout={onTimeout}
      />
      {errorMessage !== null ? (
        <p className="dialog-error m-0 border-b border-border bg-state-offline/[0.12] px-3 py-2 text-[0.85rem] text-state-offline" role="alert" data-testid="dialog-error">
          {errorMessage}
        </p>
      ) : null}
      <form onSubmit={handleSubmit} className="dialog-body flex flex-col gap-2 px-3 py-2">
        <textarea
          className="dialog-editor-field min-h-36 resize-y rounded border border-border bg-surface-2 px-2 py-1.5 font-mono text-[0.9rem] text-text outline outline-2 outline-offset-1 outline-accent focus:outline"
          data-testid="dialog-editor-field"
          value={value}
          onChange={handleChange}
          rows={10}
          autoFocus
          disabled={submitDisabled}
          spellCheck={false}
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
