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
      className="dialog dialog-editor"
      open
      aria-labelledby={`editor-title-${entry.id}`}
      data-testid="dialog-editor"
    >
      {/* Editor never carries a timeout — the prop is undefined and
          DialogHeader renders the title-only variant. */}
      <DialogHeader id={`editor-title-${entry.id}`} title={entry.title} onTimeout={onTimeout} />
      {errorMessage !== null ? (
        <p className="dialog-error" role="alert" data-testid="dialog-error">
          {errorMessage}
        </p>
      ) : null}
      <form onSubmit={handleSubmit} className="dialog-body">
        <textarea
          className="dialog-editor-field"
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
