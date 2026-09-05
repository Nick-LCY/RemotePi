// DialogHost — the layered container for one-or-more extension UI
// dialogs. Sits on top of the chat view (CSS z-index handles the
// layer stack) and renders one dialog per entry in `blockedOn`.
//
// Local state (M3 PRD §4.2 关闭规则 + §4.5 提交失败处理):
//   `Map<request_id, DialogState>` — tracks each dialog's local
//   status:
//     - 'open'        — entry is in blockedOn, no action taken yet
//     - 'submitting'  — outbound extension_ui_response sent; we're
//                       waiting for either:
//                        * session_state.blocked_on drops the id
//                          (bridge confirmed → unmount)
//                        * command_result{success:false,
//                          error.code:'request_expired'} arrives
//                          (bridge says we were too late → mark
//                          expired → unmount on next session_state)
//     - 'expired'     — request_expired arrived; show inline error
//                       banner + unmount as soon as session_state
//                       drops the id (which it does, because the
//                       bridge already cleared the pending entry
//                       when it issued the request_expired).
//
// Auto-close: DialogHost observes `useBlockedOn()` on every render.
// When an entry's id is no longer in the array, the dialog
// unmounts. This satisfies PRD §4.2 关闭规则: "session_state 帧
// blocked_on 不含该 id → 自动收起（即使本地'已提交待确认'）".
//
// Optimistic UI: OFF (H decision). The 'submitting' state disables
// the dialog buttons to avoid double-submit but does not advance
// any visual state — the user still sees the dialog until the
// bridge confirms via the next session_state frame.
//
// Local-timeout branch (W3 review): when `useCountdown` expires in
// the dialog's header BEFORE the bridge mirrors its own timer,
// the previous implementation flipped the dialog's local Map state
// to `expired`. That was effectively invisible: the bridge's
// mirrored timer fires ~immediately after (within the same tick
// in practice) and the next `session_state` drops the id — so React
// unmounts the dialog on key change before the user can see the
// expired banner. Per reviewer feedback, we now DO NOT mutate the
// Map on the local timer; instead we surface a brief global toast
// ("弹窗已超时") that the host owns, so the UX is decoupled from
// whichever dialog fired. The countdown UI keeps rendering until
// the bridge confirms via session_state, which is the source of
// truth.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  useBlockedOn,
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
  const entries = useBlockedOn();
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
  // React's `key` matching in the render loop below.
  useEffect(() => {
    const seen = new Set<string>();
    for (const entry of entries) seen.add(entry.id);
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

  // Subscribe to request_expired notices (PRD §4.5). Match by
  // outboundId — the dialog that submitted the response is the
  // one to flag as expired.
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

  // Helper: record submission state. Called by the dialog callbacks
  // below. We extract the submission handler logic into shared
  // functions so each dialog can use the same bookkeeping.
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

  // W3 — local-timeout handler no longer mutates the dialog's local
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
      for (const entry of entries) {
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
    <div className="dialog-host" aria-label="Pending dialogs">
      {entries.map((entry) => {
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
            pending={pending}
            errorMessage={errorMessage}
            submit={submit}
            onCancel={(payload) => submit(entry, payload)}
            onTimeout={() => handleTimeout(entry)}
          />
        );
      })}
      {timeoutToast !== null ? (
        <div className="dialog-host-toast" role="status" aria-live="polite">
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
  pending: boolean;
  errorMessage: string | null;
  submit: (entry: BlockedOnEntryPayload, payload: ExtensionUIResponsePayload) => void;
  onCancel: (payload: ExtensionUIResponsePayload) => void;
  onTimeout: () => void;
}

function DialogEntry({
  entry,
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
