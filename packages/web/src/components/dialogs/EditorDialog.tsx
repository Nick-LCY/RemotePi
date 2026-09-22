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
// when the prefill is empty. The user can resize vertically with the
// standard browser textarea grip.
//
// ## Reference visual shape (M6 task 07 — D7 accent-blue family)
//
//   - **Card** (desktop): `rounded-2xl bg-surface shadow-2xl
//     w-full max-w-[420px]` (T07 reference; matches TokenModal's
//     T06 reference card shell).
//   - **Header** tinted icon block:
//     `size-11 rounded-xl bg-accent-soft text-accent` with a
//     lucide `<FileText size={20} />` glyph (D7 accent-blue
//     family shared with input — distinguishes "edit a longer
//     multi-line value" from "type a one-line value" via the
//     glyph swap PenLine → FileText).
//   - **Title**: `text-base font-semibold tracking-tight`.
//   - **Editor field**: token-aligned paint —
//     `min-h-36 resize-y rounded-xl border border-border-2
//     bg-surface-2 px-3 py-2.5 font-mono text-sm text-text
//     outline-none transition placeholder:text-muted-5
//     focus:border-accent focus:ring-4 focus:ring-accent-ring`
//     (matches the input field — D7 single-focus indicator
//     idiom).
//   - **Footer**: shared `DialogFooter` (cancel outline +
//     submit accent).
//
// ## testids (zero add / zero drop vs M5 baseline)
//
//   - `dialog-editor` — container.
//   - `dialog-editor-field` — the textarea element.
//   - `dialog-cancel` / `dialog-confirm-yes` — footer buttons.

import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { FileText } from 'lucide-react';

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
    <div
      className="dialog dialog-editor pointer-events-auto m-2 flex w-[min(420px,92vw)] flex-col rounded-2xl bg-surface p-0 text-text shadow-2xl"
      role="dialog"
      aria-modal="true"
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
        icon={<FileText className="size-5" />}
        iconClassName="size-11 rounded-xl flex items-center justify-center bg-accent-soft text-accent"
      />
      {errorMessage !== null ? (
        <p className="dialog-error m-0 border-b border-border bg-state-offline/10 px-4 py-2 text-[0.85rem] text-state-offline" role="alert" data-testid="dialog-error">
          {errorMessage}
        </p>
      ) : null}
      <form onSubmit={handleSubmit} className="dialog-body flex flex-col gap-3 px-5 pb-5 pt-1">
        <textarea
          className="dialog-editor-field min-h-36 resize-y rounded-xl border border-border-2 bg-surface-2 px-3 py-2.5 font-mono text-sm text-text outline-none transition placeholder:text-muted-5 focus:border-accent focus:ring-4 focus:ring-accent-ring"
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
    </div>
  );
}
