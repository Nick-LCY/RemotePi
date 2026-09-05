// SelectDialog — render the pi `select` extension UI request as a list
// of single-choice buttons (PRD §4.2). The component is purely a
// view layer — it owns local UI state (which option is being
// submitted, transient "submitted" status) and delegates all wire
// I/O to the parent via the `onSubmit` / `onCancel` callbacks.
//
// Wire shape on confirm (PRD §4.2):
//   { request_id, cancelled: false, value: <option string> }
// Wire shape on cancel:
//   { request_id, cancelled: true }   (no `value`)
//
// Countdown (PRD §4.2 / §1.3):
//   - When `entry.timeout` is present, render a header showing
//     "remaining Ns" + a progress bar (1s tick). When it expires,
//     call `onTimeout()` so the parent can drop the dialog. The
//     bridge mirrors its own timeout; whichever fires first wins
//     and the loser is a no-op (PRD §2.4).
//   - When `entry.timeout` is absent (this method always carries
//     one in practice, but the type allows omission), do NOT render
//     a countdown.

import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';

import type { BlockedOnEntryPayload } from '@remotepi/shared';

export interface SelectDialogProps {
  entry: Extract<BlockedOnEntryPayload, { method: 'select' }>;
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
    <dialog className="dialog dialog-select" open aria-labelledby={`select-title-${entry.id}`}>
      <DialogHeader
        id={`select-title-${entry.id}`}
        title={entry.title}
        timeoutMs={entry.timeout}
        onTimeout={onTimeout}
      />
      {errorMessage !== null ? (
        <p className="dialog-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <form onSubmit={handleSubmit} className="dialog-body">
        <fieldset className="dialog-select-options" disabled={pending || errorMessage !== null}>
          <legend className="visually-hidden">Options</legend>
          {entry.options.map((option, idx) => {
            const id = `select-${entry.id}-${idx}`;
            return (
              <label key={option} htmlFor={id} className="dialog-select-option">
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
  timeoutMs?: number;
  onTimeout: () => void;
}

export function DialogHeader({ id, title, timeoutMs, onTimeout }: DialogHeaderProps) {
  // Local countdown state — kept in seconds. We avoid re-rendering
  // every millisecond (would be janky); 1Hz is enough granularity
  // for a human-facing timer and matches the PRD wording ("每秒
  // 更新").
  const remainingMs = useCountdown(timeoutMs, onTimeout);
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
      <button type="button" onClick={onCancel} className="dialog-button dialog-button-cancel">
        Cancel
      </button>
      <button
        type="submit"
        disabled={submitDisabled}
        className="dialog-button dialog-button-submit"
      >
        {submitLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// useCountdown — local timer that calls `onTimeout` exactly once
// ---------------------------------------------------------------------------

/** Drive the countdown header. Returns the remaining milliseconds,
 *  updated 1×/second (S6 review — default cadence). When the
 *  deadline is short (< 5s) we keep the legacy 250ms cadence so
 *  the very last ticks stay smooth — the seconds-display still
 *  jumps in 1s steps, but the width-bar fill keeps moving between
 *  jumps. Calls `onTimeout()` exactly once when the deadline
 *  elapses — the parent is expected to drop the dialog from its
 *  render tree in response (PRD §4.2 关闭规则: the bridge will
 *  also broadcast a session_state with the id removed; the local
 *  timer just gives the user feedback while the wire catches up).
 *
 *  Note: we deliberately do NOT optimistically close the dialog on
 *  timeout — the parent listens to both the local timer (for UX)
 *  AND the session_state broadcast (for the source of truth). If
 *  the local timer fires first, the parent calls onTimeout() which
 *  surfaces the W3 timeout toast; the next session_state frame
 *  then unmounts the dialog normally. If the broadcast arrives
 *  first, the dialog unmounts before the timer fires and the
 *  cleanup function cancels the interval (no leaked callbacks). */
function useCountdown(timeoutMs: number | undefined, onTimeout: () => void): number {
  const [remainingMs, setRemainingMs] = useState(() =>
    typeof timeoutMs === 'number' ? timeoutMs : Number.POSITIVE_INFINITY,
  );

  useEffect(() => {
    if (timeoutMs === undefined) {
      setRemainingMs(Number.POSITIVE_INFINITY);
      return undefined;
    }
    setRemainingMs(timeoutMs);
    const start = Date.now();
    // 1Hz ticks are enough granularity for a human-facing timer and
    // match the PRD wording ("每秒更新"). The legacy 250ms cadence
    // is kept for the short-deadline tail (< 5s) so the progress bar
    // doesn't look frozen between seconds-jumps.
    const tickMs = timeoutMs < 5_000 ? 250 : 1_000;
    const id = window.setInterval(() => {
      const elapsed = Date.now() - start;
      const left = timeoutMs - elapsed;
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
  }, [timeoutMs]);

  return remainingMs;
}
