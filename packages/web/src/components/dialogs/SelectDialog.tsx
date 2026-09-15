// SelectDialog — render the pi `select` extension UI request as a
// list of single-choice buttons. Pure view layer — owns local UI
// state (which option is being submitted) and delegates wire I/O
// to the parent via `onSubmit` / `onCancel`.
//
// Wire shape on confirm: `{ request_id, cancelled: false,
// value: <option string> }`. On cancel: `{ request_id,
// cancelled: true }` (no `value`).
//
// Countdown (when `entry.timeout` is present): render a header
// showing "remaining Ns" + a progress bar. On expiry call
// `onTimeout()` — the bridge mirrors its own timeout; whichever
// fires first wins and the loser is a no-op.
//
// Countdown math: deadline = `enqueuedAt + timeoutMs` (an
// absolute wall-clock instant) rather than mount-time +
// timeoutMs. The two are identical for a dialog foregrounded
// from t=0; they diverge when a session switch makes a
// background dialog the foreground — the countdown then resumes
// at the correct point (remaining = (enqueuedAt + timeoutMs) -
// now) instead of restarting from `timeoutMs`.

import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';

import type { BlockedOnEntryPayload } from '@remotepi/shared';

export interface SelectDialogProps {
  entry: Extract<BlockedOnEntryPayload, { method: 'select' }>;
  /** `Date.now()` at the moment the entry arrived via
   *  `session_state` broadcast (the WsClient stamps it on
   *  inbound). Drives the countdown math so a switch-back to a
   *  background dialog resumes at the correct point (PRD §4.5). */
  enqueuedAt: number;
  /** `true` once the parent has the dialog marked as
   *  "submitted, awaiting confirmation" (optimistic UI off by
   *  design, but we still want to disable the buttons to avoid
   *  double-submit before the bridge confirms via blocked_on
   *  removal). */
  pending: boolean;
  /** If non-null, render an inline error banner above the dialog
   *  body and disable all buttons. */
  errorMessage: string | null;
  onSubmit: (payload: { request_id: string; cancelled: false; value: string }) => void;
  onCancel: (payload: { request_id: string; cancelled: true }) => void;
  onTimeout: () => void;
}

export function SelectDialog({
  entry,
  enqueuedAt,
  pending,
  errorMessage,
  onSubmit,
  onCancel,
  onTimeout,
}: SelectDialogProps) {
  const [chosen, setChosen] = useState<string | null>(null);

  // Reset the chosen selection if the entry is re-rendered with a
  // different id (defensive — the parent already keys by id, but
  // this guards against hot-reload surprises).
  useEffect(() => {
    setChosen(null);
  }, [entry.id]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (chosen === null || pending) return;
    onSubmit({ request_id: entry.id, cancelled: false, value: chosen });
  };

  const handleCancel = () => {
    if (pending) return;
    onCancel({ request_id: entry.id, cancelled: true });
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    setChosen(event.target.value);
  };

  return (
    <dialog
      className="dialog dialog-select"
      open
      aria-labelledby={`select-title-${entry.id}`}
      data-testid="dialog-select"
    >
      <DialogHeader
        id={`select-title-${entry.id}`}
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
        <fieldset className="dialog-select-options" disabled={pending || errorMessage !== null}>
          <legend className="visually-hidden">Options</legend>
          {entry.options.map((option, idx) => {
            const id = `select-${entry.id}-${idx}`;
            return (
              <label
                key={option}
                htmlFor={id}
                className="dialog-select-option"
                data-testid="dialog-select-option"
              >
                <input
                  id={id}
                  type="radio"
                  name={`select-${entry.id}`}
                  value={option}
                  checked={chosen === option}
                  onChange={onChange}
                />
                <span>{option}</span>
              </label>
            );
          })}
        </fieldset>
        <DialogFooter
          onCancel={handleCancel}
          submitLabel="Confirm"
          submitDisabled={chosen === null || pending || errorMessage !== null}
        />
      </form>
    </dialog>
  );
}

// Shared pieces below — used by every dialog so they share the
// header / countdown / footer markup without re-implementing.

export interface DialogHeaderProps {
  id: string;
  title: string;
  /** Original `entry.timeout` in milliseconds. Countdown math
   *  uses `enqueuedAt` to compute `remaining = (enqueuedAt +
   *  timeoutMs) - now` — see `useCountdown` below. */
  timeoutMs?: number;
  /** `Date.now()` at the moment the entry arrived via
   *  `session_state` (the WsClient stamps it on inbound). */
  enqueuedAt: number;
  onTimeout: () => void;
}

export function DialogHeader({ id, title, timeoutMs, enqueuedAt, onTimeout }: DialogHeaderProps) {
  const remainingMs = useCountdown(timeoutMs, enqueuedAt, onTimeout);
  if (timeoutMs === undefined) {
    return (
      <header className="dialog-header">
        <h2 id={id} className="dialog-title">
          {title}
        </h2>
      </header>
    );
  }
  const totalMs = timeoutMs;
  const elapsedMs = totalMs - remainingMs;
  const pct = Math.max(0, Math.min(100, (elapsedMs / totalMs) * 100));
  const remainingSec = Math.ceil(remainingMs / 1000);
  return (
    <header className="dialog-header">
      <h2 id={id} className="dialog-title">
        {title}
      </h2>
      <div className="dialog-countdown" role="timer" aria-live="off">
        <span className="dialog-countdown-label">remaining</span>
        <span className="dialog-countdown-value">{remainingSec}s</span>
        <div className="dialog-countdown-bar" aria-hidden="true">
          <div className="dialog-countdown-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </header>
  );
}

export interface DialogFooterProps {
  onCancel: () => void;
  submitLabel: string;
  submitDisabled: boolean;
}

export function DialogFooter({ onCancel, submitLabel, submitDisabled }: DialogFooterProps) {
  return (
    <div className="dialog-footer">
      <button
        type="button"
        onClick={onCancel}
        className="dialog-button dialog-button-cancel"
        data-testid="dialog-cancel"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={submitDisabled}
        className="dialog-button dialog-button-submit"
        data-testid="dialog-confirm-yes"
      >
        {submitLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// useCountdown — local timer that calls `onTimeout` exactly once
// ---------------------------------------------------------------------------

/** Drive the countdown header. Returns the remaining
 *  milliseconds, updated 1×/second by default. When the deadline
 *  is short (< 5s) we keep a faster 250ms cadence so the very
 *  last ticks stay smooth — the seconds display still jumps in
 *  1s steps but the width-bar fill keeps moving between jumps.
 *  Calls `onTimeout()` exactly once when the deadline elapses.
 *
 *  Takes `enqueuedAt` so the deadline is `enqueuedAt + timeoutMs`
 *  (an absolute wall-clock instant) rather than mount-time +
 *  timeoutMs. The two are identical for a dialog foregrounded
 *  from t=0; they diverge when a session switch makes a
 *  background dialog the foreground — the countdown then resumes
 *  at the correct point (remaining = (enqueuedAt + timeoutMs) -
 *  now) instead of restarting from `timeoutMs`. The hook treats
 *  `enqueuedAt` as a dep so a later session_state broadcast that
 *  replaces the entry (with a new enqueuedAt) restarts the
 *  countdown against the new deadline.
 *
 *  We do NOT optimistically close the dialog on timeout — the
 *  parent listens to both the local timer (for UX feedback) and
 *  the session_state broadcast (for the source of truth). If
 *  the local timer fires first, the parent surfaces the timeout
 *  toast; the next session_state frame then unmounts the
 *  dialog. If the broadcast arrives first, the dialog unmounts
 *  before the timer fires and the cleanup function cancels the
 *  interval. */
function useCountdown(
  timeoutMs: number | undefined,
  enqueuedAt: number,
  onTimeout: () => void,
): number {
  const [remainingMs, setRemainingMs] = useState(() => {
    if (timeoutMs === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, enqueuedAt + timeoutMs - Date.now());
  });

  useEffect(() => {
    if (timeoutMs === undefined) {
      setRemainingMs(Number.POSITIVE_INFINITY);
      return undefined;
    }
    const deadline = enqueuedAt + timeoutMs;
    setRemainingMs(Math.max(0, deadline - Date.now()));
    const remaining = Math.max(0, deadline - Date.now());
    const tickMs = remaining < 5_000 ? 250 : 1_000;
    const id = window.setInterval(() => {
      const left = deadline - Date.now();
      if (left <= 0) {
        setRemainingMs(0);
        window.clearInterval(id);
        onTimeout();
        return;
      }
      setRemainingMs(left);
    }, tickMs);
    return () => window.clearInterval(id);
    // onTimeout is intentionally not a dep — re-binding the timer
    // every time the parent re-creates the callback would defeat
    // the "fire once" guarantee. The parent is expected to pass a
    // stable handler (via useCallback) or accept the rare edge
    // case where a stale callback fires.
    // enqueuedAt is in the dep array so a later session_state
    // broadcast that replaces the entry (with a new enqueuedAt)
    // restarts the countdown against the new deadline.
  }, [timeoutMs, enqueuedAt]);

  return remainingMs;
}
