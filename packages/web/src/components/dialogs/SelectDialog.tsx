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
// showing "remaining Ns" pill + a progress bar. On expiry call
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
//
// ## Reference visual shape (M6 task 07 — D7 amber family)
//
//   - **Card** (desktop): `rounded-2xl bg-surface shadow-2xl
//     w-full max-w-[420px]` (tokenized; matches TokenModal's
//     T06 reference card shell).
//   - **Header** tinted icon block:
//     `size-11 rounded-xl bg-amber-soft text-amber` with a
//     lucide `<ListChecks size={20} />` glyph (D7 amber family
//     reserved for select — distinguishes "pick one of N" from
//     confirm/input/editor).
//   - **Title**: `text-base font-semibold tracking-tight`.
//   - **Body**: `text-sm leading-6 text-muted` continuation
//     of the entry message.
//   - **Footer** buttons (shared across all 4 dialogs via the
//     exported `DialogFooter`): primary `rounded-xl bg-accent
//     h-10 px-4 text-sm font-semibold text-white
//     hover:bg-accent-hover disabled:bg-accent-disabled
//     disabled:cursor-not-allowed`; cancel `rounded-xl border
//     border-border-2 bg-surface h-10 px-4 text-sm text-muted
//     hover:bg-surface-2 disabled:bg-accent-disabled
//     disabled:cursor-not-allowed`.
//
// ## testids (zero add / zero drop vs M5 baseline)
//
//   - `dialog-select` — container.
//   - `dialog-select-option` — per-option label (and the radio
//     input lives inside it).
//   - `dialog-cancel` / `dialog-confirm-yes` — footer buttons
//     (shared testid surface so DialogFooter can be reused).
//   - `dialog-countdown*` / `dialog-error` — header countdown
//     / error banner (D7 family of the existing testid surface).

import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { ListChecks } from 'lucide-react';

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
    <div
      className="dialog dialog-select pointer-events-auto m-2 flex w-[min(420px,92vw)] flex-col rounded-2xl bg-surface p-0 text-text shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`select-title-${entry.id}`}
      data-testid="dialog-select"
    >
      <DialogHeader
        id={`select-title-${entry.id}`}
        title={entry.title}
        timeoutMs={entry.timeout}
        enqueuedAt={enqueuedAt}
        onTimeout={onTimeout}
        icon={<ListChecks className="size-5" />}
        iconClassName="size-11 rounded-xl flex items-center justify-center bg-amber-soft text-amber"
      />
      {errorMessage !== null ? (
        <p className="dialog-error m-0 border-b border-border bg-state-offline/10 px-4 py-2 text-[0.85rem] text-state-offline" role="alert" data-testid="dialog-error">
          {errorMessage}
        </p>
      ) : null}
      <form onSubmit={handleSubmit} className="dialog-body flex flex-col gap-3 px-5 pb-5 pt-1">
        <fieldset className="dialog-select-options m-0 flex flex-col gap-1.5 border-0 p-0" disabled={pending || errorMessage !== null}>
          <legend className="visually-hidden">Options</legend>
          {entry.options.map((option, idx) => {
            const id = `select-${entry.id}-${idx}`;
            return (
              <label
                key={option}
                htmlFor={id}
                className={
                  // `dialog-select-option` retained as a
                  // semantic anchor. The `:has(input:checked)`
                  // paint from the legacy rule is now expressed
                  // via Tailwind v4's arbitrary `:has()`
                  // descendant variant (`[&:has(input:checked)]:border-accent`).
                  'dialog-select-option flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text [&:has(input:checked)]:border-accent [&:has(input:checked)]:bg-accent-soft'
                }
                data-testid="dialog-select-option"
              >
                <input
                  id={id}
                  type="radio"
                  name={`select-${entry.id}`}
                  value={option}
                  checked={chosen === option}
                  onChange={onChange}
                  className="accent-accent"
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
    </div>
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
  /** Lucide node rendered inside the tinted icon block (each
   *  dialog passes the D7 family icon — HelpCircle /
   *  ListChecks / PenLine / Edit3). Sized by the call site's
   *  `iconClassName`; the header itself doesn't impose a size. */
  icon: React.ReactNode;
  /** Per-dialog tinted icon block classes (D7: bg-state-online/
   *  10 text-state-online for confirm, bg-amber-soft text-amber
   *  for select, bg-accent-soft text-accent for input/editor).
   *  Kept per-call-site rather than centralised here because
   *  D7 explicitly assigns a different colour family per
   *  method. */
  iconClassName: string;
}

export function DialogHeader({ id, title, timeoutMs, enqueuedAt, onTimeout, icon, iconClassName }: DialogHeaderProps) {
  const remainingMs = useCountdown(timeoutMs, enqueuedAt, onTimeout);
  if (timeoutMs === undefined) {
    return (
      // T07 reference header: tinted icon block + title row.
      // When no timeout is set, we render the title-only variant
      // (editor never carries a timeout per PRD §4.2 + ADR-0004).
      <header className="dialog-header flex items-start gap-3 px-5 pb-3 pt-5">
        <div
          className={iconClassName}
          aria-hidden="true"
        >
          {icon}
        </div>
        <h2 id={id} className="dialog-title m-0 flex-1 text-base font-semibold tracking-tight text-text">
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
    // T07 reference header w/ countdown: tinted icon block on
    // the left, title in the middle (truncates gracefully), and
    // a `rounded-full` "remaining Ns" pill on the right (above
    // the accent-filled progress bar that lives on the row
    // below). The pill stays visually subordinate via the
    // surface-2 background + tabular-nums + small text size,
    // so it reads as a "timer chip" rather than a primary
    // action.
    <header className="dialog-header flex flex-col gap-2 px-5 pb-3 pt-5">
      <div className="flex items-start gap-3">
        <div
          className={iconClassName}
          aria-hidden="true"
        >
          {icon}
        </div>
        <h2 id={id} className="dialog-title m-0 flex-1 text-base font-semibold tracking-tight text-text">
          {title}
        </h2>
        <div
          className="dialog-countdown inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium tabular-nums text-muted"
          role="timer"
          aria-live="off"
        >
          <span className="dialog-countdown-label uppercase tracking-[0.05em] text-[0.65rem] text-muted-5">剩</span>
          <span className="dialog-countdown-value font-semibold text-text">{remainingSec}s</span>
        </div>
      </div>
      <div className="dialog-countdown-bar h-1 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        <div
          className="dialog-countdown-bar-fill h-full bg-accent transition-[width] duration-[250ms] ease-linear"
          style={{ width: `${pct}%` }}
        />
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
    // T07 reference footer: cancel (white outline) + submit
    // (accent blue). Both buttons share `h-10 px-4 rounded-xl`
    // for a consistent pair (cancel `border-border-2 bg-surface
    // text-muted hover:bg-surface-2`; submit `bg-accent text-
    // white hover:bg-accent-hover`; both flip to
    // `bg-accent-disabled` when `disabled` to keep the disabled
    // signal consistent with the rest of the chrome).
    <div className="dialog-footer flex justify-end gap-2 pt-1">
      <button
        type="button"
        onClick={onCancel}
        // M6 T11 — focus-visible ring 2px / accent-ring / 1px
        // surface offset on the Cancel button. Disabled variant
        // keeps the ring (the disabled:bg-accent-disabled swap
        // does not strip focus-visible; WCAG exempts disabled
        // controls from contrast requirements, so the muted
        // disabled paint is acceptable).
        className="dialog-button dialog-button-cancel inline-flex h-10 items-center justify-center rounded-xl border border-border-2 bg-surface px-4 text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:bg-accent-disabled disabled:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
        data-testid="dialog-cancel"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={submitDisabled}
        className="dialog-button dialog-button-submit inline-flex h-10 items-center justify-center rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-accent-disabled focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
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
