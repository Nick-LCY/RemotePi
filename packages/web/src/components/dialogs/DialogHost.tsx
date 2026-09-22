// DialogHost — the layered container for one-or-more extension UI
// dialogs. Sits on top of the chat view (CSS z-index handles the
// layer stack) and renders one dialog per entry in the current
// session's `blockedOn` bucket.
//
// Per-session isolation:
//   - Reads `useBlockedOnFor(currentSessionKey)` — entries are
//     `BlockedOnEntry[]` (each `{ entry, enqueuedAt }`) so the
//     countdown math can read `enqueuedAt`.
//   - Background sessions' dialogs are stored in their own bucket
//     but not rendered here — DialogHost is keyed by the current
//     session via `currentSessionKey`. Switching sessions unmounts
//     the foreground dialogs; switching back re-mounts them with
//     the same `enqueuedAt` so the countdown resumes from where
//     it would have been (remaining = timeout - (Date.now() -
//     enqueuedAt)).
//   - The local `Map<id, DialogLocalState>` is keyed by the
//     payload's `id` (not the bucket's array index) so a
//     `session_state` broadcast that REORDERS the blocked_on
//     array doesn't desync the local state from the dialog.
//
// Local `Map<id, DialogLocalState>` per dialog:
//   - 'open'       — entry is in blockedOn, no action taken yet
//   - 'submitting' — outbound extension_ui_response sent; waiting
//                    for session_state to drop the id (bridge
//                    confirmed) or `request_expired` to land.
//   - 'expired'    — request_expired arrived; show inline error
//                    banner + unmount on the next session_state.
//
// Auto-close: when an entry's id is no longer in the array, the
// dialog unmounts (React's `key` matching drops the component).
//
// Optimistic UI: OFF. The 'submitting' state disables dialog
// buttons to avoid double-submit but does not advance visual
// state — the user still sees the dialog until the bridge
// confirms via the next session_state frame.
//
// Local-timeout branch: the dialog's `useCountdown` may expire
// before the bridge mirrors its own timer; rather than flip the
// dialog's local Map state to `expired` (effectively invisible —
// the next session_state un-mounts the dialog before the user
// can see the inline banner), the host surfaces a brief global
// toast that auto-hides. The countdown UI keeps rendering until
// the bridge confirms via session_state — that's the source of
// truth.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  useBlockedOnFor,
  useCurrentSessionKey,
  useDialogExpiredSubscription,
  useWsClient,
} from '../../ws/WsClientContext.js';

import type { BlockedOnEntryPayload, ExtensionUIResponsePayload } from '@remotepi/shared';

import { ConfirmDialog } from './ConfirmDialog.js';
import { EditorDialog } from './EditorDialog.js';
import { InputDialog } from './InputDialog.js';
import { SelectDialog } from './SelectDialog.js';

/** Per-dialog local status. We track the outbound envelope id so we
 *  can correlate a late `command_result{success:false,
 *  error.code:'request_expired'}` (which uses `reply_to` against
 *  the outbound envelope id) back to the originating dialog. */
interface DialogLocalState {
  status: 'open' | 'submitting' | 'expired';
  outboundId: string | null;
  /** Inline error banner — set on the expired path (request_expired
   *  arrived) OR on the local-timeout path (we show the same
   *  message either way per the PRD §4.2 wording). */
  errorMessage: string | null;
}

export function DialogHost() {
  const currentSessionKey = useCurrentSessionKey();
  const entries = useBlockedOnFor(currentSessionKey);
  const client = useWsClient();
  const [local, setLocal] = useState<Map<string, DialogLocalState>>(initialLocalState);
  // W3 — brief global toast shown when a dialog's local countdown
  // timer expires. The host owns the toast so multi-dialog races
  // don't pile up local banners. Auto-hides after `TIMEOUT_TOAST_MS`;
  // each timer firing resets the window so the user can still read
  // it even when several timeouts stack.
  const [timeoutToast, setTimeoutToast] = useState<string | null>(null);
  const timeoutToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // React to session_state-driven entry removal: if an id disappears
  // from blockedOn, prune it from our local map so the Map doesn't
  // grow unbounded. The dialog itself unmounts automatically via
  // React's `key` matching in the render loop below. The entries
  // are `BlockedOnEntry[]` (entry + enqueuedAt); we key by the
  // payload's id so the local map stays decoupled from the bucket's
  // enqueuedAt timestamps (which are replaced wholesale on every
  // session_state broadcast).
  useEffect(() => {
    const seen = new Set<string>();
    for (const { entry } of entries) seen.add(entry.id);
    setLocal((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of prev.keys()) {
        if (!seen.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [entries]);

  // Subscribe to request_expired notices. Match by outboundId —
  // the dialog that submitted the response is the one to flag as
  // expired.
  useDialogExpiredSubscription(
    useCallback((notice) => {
      setLocal((prev) => {
        let changed = false;
        const next = new Map(prev);
        // Match by outbound id (the bridge issues command_result
        // with reply_to = the outbound envelope id we generated).
        for (const [id, state] of prev) {
          if (state.outboundId === notice.replyTo) {
            next.set(id, {
              status: 'expired',
              outboundId: state.outboundId,
              errorMessage:
                'request_expired: this dialog has already been cleared (timeout or another tab answered first)',
            });
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, []),
  );

  const submit = useCallback(
    (entry: BlockedOnEntryPayload, payload: ExtensionUIResponsePayload) => {
      const outboundId = client.sendExtensionUIResponse(payload);
      setLocal((prev) => {
        const next = new Map(prev);
        next.set(entry.id, { status: 'submitting', outboundId, errorMessage: null });
        return next;
      });
    },
    [client],
  );

  // Local-timeout handler no longer mutates the dialog's local
  // Map state. The bridge's mirrored timer fires within the same
  // tick in practice, so the next `session_state` un-mounts the
  // dialog via React key matching before the user could see an
  // inline `expired` banner. Instead we surface a brief global
  // toast (auto-hide via the ref-managed timer below) so the user
  // has at least one visible signal that something timed out,
  // without coupling it to a specific dialog that may already be
  // gone. The dialog's countdown UI continues to render until the
  // bridge confirms via session_state — that's the source of truth.
  const handleTimeout = useCallback((entry: BlockedOnEntryPayload) => {
    setTimeoutToast(`弹窗已超时：${entry.title}`);
    if (timeoutToastTimerRef.current !== null) {
      clearTimeout(timeoutToastTimerRef.current);
    }
    timeoutToastTimerRef.current = setTimeout(() => {
      timeoutToastTimerRef.current = null;
      setTimeoutToast(null);
    }, TIMEOUT_TOAST_MS);
  }, []);

  // Clear the toast timer on unmount so a stale hide doesn't fire on
  // a remounted DialogHost.
  useEffect(() => {
    return () => {
      if (timeoutToastTimerRef.current !== null) {
        clearTimeout(timeoutToastTimerRef.current);
        timeoutToastTimerRef.current = null;
      }
    };
  }, []);

  // Lazy initial state helper — make sure every current entry has a
  // default 'open' state. New entries that arrive after mount get
  // initialised in the effect below.
  useEffect(() => {
    setLocal((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const { entry } of entries) {
        if (!next.has(entry.id)) {
          next.set(entry.id, { status: 'open', outboundId: null, errorMessage: null });
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [entries]);

  // Render: a stacked column of dialogs. Each dialog is keyed by
  // its entry id so React unmounts automatically when blockedOn
  // drops the id (the next render simply doesn't include the
  // component for that key). The W3 timeout toast is rendered as a
  // sibling — it lives in the same overlay container so it's
  // visible above the chat surface and below the dialog stack.
  return (
    // `dialog-host` retained as a semantic anchor (no styling
    // remains under it; the fixed + centred stack + z-index-100
    // positioning now live on the Tailwind utilities).
    <div className="dialog-host pointer-events-none fixed inset-0 z-[100] flex items-start justify-center pt-8" aria-label="Pending dialogs" data-testid="dialog-host">
      {entries.map(({ entry, enqueuedAt }) => {
        const state = local.get(entry.id) ?? {
          status: 'open',
          outboundId: null,
          errorMessage: null,
        };
        const pending = state.status === 'submitting';
        // W3: after the local-timeout refactor the only path that
        // still sets a non-null `errorMessage` is the request_expired
        // subscription. The local-timer path no longer touches this
        // field — the toast replaces it.
        const errorMessage = state.status === 'expired' ? state.errorMessage : null;
        return (
        <DialogEntry
          key={entry.id}
          entry={entry}
          enqueuedAt={enqueuedAt}
          pending={pending}
          errorMessage={errorMessage}
          submit={submit}
          onCancel={(payload) => submit(entry, payload)}
          onTimeout={() => handleTimeout(entry)}
        />
      );
      })}
      {timeoutToast !== null ? (
        // `dialog-host-toast` retained as a semantic anchor. The
        // toast paint uses the same "red = something failed"
        // colour family as `.dialog-error` /
        // `.input-bar-error` — achieved via `text-state-offline`
        // + the canonical 16%-alpha shadow token.
        <div className="dialog-host-toast pointer-events-none mx-2 mb-2 max-w-[min(360px,80vw)] self-end rounded-md border border-border bg-surface px-3 py-2 text-[0.88rem] text-state-offline shadow-[0_6px_18px_rgba(0,0,0,0.16)]" role="status" aria-live="polite" data-testid="dialog-toast">
          {timeoutToast}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DialogEntry — dispatcher that picks the right renderer per method
// ---------------------------------------------------------------------------

interface DialogEntryProps {
  entry: BlockedOnEntryPayload;
  /** `Date.now()` at the moment the entry arrived via
   *  `session_state`. Dialog components read this for the
   *  countdown math (PRD §4.5: remaining = timeout -
   *  (Date.now() - enqueuedAt)) so a switch-back to a background
   *  session resumes the countdown at the correct point. */
  enqueuedAt: number;
  pending: boolean;
  errorMessage: string | null;
  submit: (entry: BlockedOnEntryPayload, payload: ExtensionUIResponsePayload) => void;
  onCancel: (payload: ExtensionUIResponsePayload) => void;
  onTimeout: () => void;
}

function DialogEntry({
  entry,
  enqueuedAt,
  pending,
  errorMessage,
  submit,
  onCancel,
  onTimeout,
}: DialogEntryProps) {
  switch (entry.method) {
    case 'select':
      return (
        <SelectDialog
          entry={entry}
          enqueuedAt={enqueuedAt}
          pending={pending}
          errorMessage={errorMessage}
          onSubmit={(p) => submit(entry, p)}
          onCancel={onCancel}
          onTimeout={onTimeout}
        />
      );
    case 'confirm':
      return (
        <ConfirmDialog
          entry={entry}
          enqueuedAt={enqueuedAt}
          pending={pending}
          errorMessage={errorMessage}
          onSubmit={(p) => submit(entry, p)}
          onCancel={onCancel}
          onTimeout={onTimeout}
        />
      );
    case 'input':
      return (
        <InputDialog
          entry={entry}
          enqueuedAt={enqueuedAt}
          pending={pending}
          errorMessage={errorMessage}
          onSubmit={(p) => submit(entry, p)}
          onCancel={onCancel}
          onTimeout={onTimeout}
        />
      );
    case 'editor':
      return (
        <EditorDialog
          entry={entry}
          enqueuedAt={enqueuedAt}
          pending={pending}
          errorMessage={errorMessage}
          onSubmit={(p) => submit(entry, p)}
          onCancel={onCancel}
          onTimeout={onTimeout}
        />
      );
    default: {
      // Defensive: future pi methods that the bridge forwards but we
      // don't yet render fall through here. Log + render a minimal
      // fallback so the user isn't silently stuck.
      const _exhaustive: never = entry;
      void _exhaustive;
      return null;
    }
  }
}

const initialLocalState = (): Map<string, DialogLocalState> => new Map();

/** Auto-hide window for the W3 timeout toast. Long enough to read
 *  comfortably on a phone; short enough that a fast succession of
 *  timeouts doesn't pin the toast on screen for minutes. */
const TIMEOUT_TOAST_MS = 3_000;
