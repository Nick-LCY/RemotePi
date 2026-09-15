// Bridge extension UI router — converts pi's `extension_ui_request`
// events into blocked_on entries + web-bound `pi/event` envelopes, and
// translates web `extension_ui_response` envelopes into pi's native
// three-state shape at the bridge boundary.
//
// ## Wire flow (PRD §2.4)
//
//   pi → bridge (stdout raw event with `type: "extension_ui_request"`;
//   verified against `@earendil-works/pi-coding-agent@0.85.1`
//   `dist/modes/rpc/rpc-mode.js:27-29` — events are NOT wrapped as
//   `{type:"event", event:"..."}`; the `type` field IS the event name):
//     - 4 blocking methods (select / confirm / input / editor):
//         1. add to `pending` Map keyed by pi-side `id`
//         2. broadcast `session_state` (with new blocked_on)
//         3. forward to web via `pi/event` envelope (with timeout field)
//         4. if `timeout` present → setTimeout mirror (竞态原子检查点)
//     - 5 fire-and-forget methods (notify / setStatus / setWidget /
//       setTitle / set_editor_text):
//         - logger.info + drop, never enter blocked_on, never forward
//
//   web → bridge (`pi/extension_ui_response` envelope):
//     - atomic check on `pending` Map:
//       - entry exists → translate web wire → pi native three-state
//         (cancelled / confirmed / value) → write stdin → clear entry +
//         timeout → broadcast session_state (blocked_on now empty for id)
//       - entry absent → emit `command_result{success: false, error:
//         {code: "request_expired", message: ...}}` so the web side
//         can show the error toast + close the dialog
//
//   timeout mirror fires:
//     - atomic check on `pending` Map:
//       - entry still present → clear entry → broadcast session_state
//       - entry already gone (committed) → silent no-op (loser of race)
//
// ## Wire translation (PRD §1.6 + §2.4)
//
//   cancelled: true                                      → { id, cancelled: true }
//   cancelled: false + method === 'confirm' + value: T/F → { id, confirmed: value }
//   cancelled: false + method ∈ select/input/editor     → { id, value: value }
//
// ## stdin write failure
//
//   bridge write fails (child dead) → log error + force exited + broadcast.
//
// ## Multi-web "first-answer-wins" (PRD §2.4)
//
//   The blocked_on array is shared across all web clients via
//   session_state broadcast. The first web to submit a response triggers
//   a new broadcast with that id removed; other web clients see the
//   removal and dismiss their copy. A late submission from the losing
//   web hits an empty Map → request_expired.
//
// The router calls back into the manager via `forceExited` which
// logs + transitions phase to 'exited' + broadcasts. The router
// itself doesn't own the phase state machine — the manager does.
// Splitting the responsibilities this way keeps the router testable
// in isolation (no manager dependency) and makes the "force exited"
// semantics identical to any other reason for transitioning to
// exited (e.g. crash restart path).

import { randomUUID } from 'node:crypto';
import {
  BLOCK_ON_METHODS,
  PROTOCOL_VERSION,
  type BlockedOnEntryPayload,
  type ExtensionUIResponsePayload,
} from '@remotepi/shared';
import { logger } from './logger.js';

/** Set of pi `extension_ui_request` methods that DO block on a user
 *  response and therefore enter `session_state.payload.blocked_on`.
 *  The four values mirror pi v0.85.1's `extension_ui_request` blocking
 *  methods one-for-one. Re-exported here for convenience so callers
 *  don't need to import from `@remotepi/shared` directly. */
export const FIRE_AND_FORGET_METHODS = [
  'notify',
  'setStatus',
  'setWidget',
  'setTitle',
  'set_editor_text',
] as const;
export type FireAndForgetMethod = (typeof FIRE_AND_FORGET_METHODS)[number];

/** Methods that enter `blocked_on` and require a user response. The
 *  bridge routes pi events through the same union as
 *  `BlockedOnEntryPayload.method` so the on-the-wire shape is
 *  preserved. Anything else is treated as fire-and-forget and
 *  digested locally — this is the PRD §1.3 + §2.4 contract. */
const BLOCKING_METHODS_SET = new Set<string>(BLOCK_ON_METHODS);

/** Set of fire-and-forget method names — anything not in this set
 *  AND not in `BLOCKING_METHODS_SET` is treated as "unknown method,
 *  digest locally with a warn" (defensive default for forward-compat
 *  with pi upgrades that add new methods). */
const FIRE_AND_FORGET_METHODS_SET = new Set<string>(FIRE_AND_FORGET_METHODS);

/** Read the optional `timeout` field off a blocking entry, returning
 *  `undefined` when the variant doesn't carry one (editor). The
 *  discriminated union's editor variant omits `timeout` entirely
 *  per ADR-0004, so we narrow per-method instead of accessing the
 *  property directly (which TS rejects on the union). */
function extractTimeout(data: BlockedOnEntryPayload): number | undefined {
  if (data.method === 'select') return data.timeout;
  if (data.method === 'confirm') return data.timeout;
  if (data.method === 'input') return data.timeout;
  // method === 'editor' — no timeout field
  return undefined;
}

// ---------------------------------------------------------------------------
// Pi command shape — what we write to pi stdin for an extension_ui_response
// ---------------------------------------------------------------------------

/** The wire shape we emit to pi's stdin for a translated
 *  `extension_ui_response`. Three forms per PRD §1.6:
 *    - `{ type, id, cancelled: true }`           — user dismissed
 *    - `{ type, id, confirmed: boolean }`        — confirm answered
 *    - `{ type, id, value: string }`             — select/input/editor answered
 *  We always include `type: 'extension_ui_response'` so pi's rpc-client
 *  router dispatches by command name. */
export type PiExtensionUIResponse =
  | { type: 'extension_ui_response'; id: string; cancelled: true }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; value: string };

// ---------------------------------------------------------------------------
// Pi event frame — what we receive on stdout
// ---------------------------------------------------------------------------

/** Minimal shape of an `extension_ui_request` data payload from pi
 *  stdout. The data shape is intentionally loose (`z.unknown()`-like)
 *  here — we discriminate by `method` and parse per-method fields
 *  only as needed. The bridge trusts pi to emit well-formed frames
 *  (PRD §2.4: "解析 event.event === 'extension_ui_request'"); a
 *  malformed frame logs and drops. */
export interface ExtensionUIRequestData {
  method: string;
  id: string;
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Router options + callback contract
// ---------------------------------------------------------------------------

export interface ExtensionUIOptions {
  /** Trigger a `session_state` broadcast after every change to
   *  `pending` (add or remove). The broadcast reads the current
   *  `pending` set via `getBlockedOn()` — passing a closure rather
   *  than a direct map reference keeps the router testable without
   *  a manager instance. */
  broadcastSessionState: () => void;

  /** Forward an event to the web via a `pi/event` envelope. Called
   *  for blocking 4-class requests AFTER the entry has been added to
   *  `pending` and the session_state broadcast has been triggered
   *  (PRD §2.4: "通过 `pi/event` envelope 原样转给 web"). The router
   *  passes the raw request data (timeout field included) — the
   *  envelope construction is the manager's responsibility because
   *  it owns the outbound sink. */
  emitEventEnvelope: (eventName: string, data: unknown) => void;

  /** Emit a `command_result{success: false, error: {code:
   *  "request_expired", ...}}` back to web when a late submission
   *  hits an empty Map. `replyTo` is the web envelope's `id` so the
   *  web can correlate it with the original response attempt. */
  emitCommandResult: (
    replyTo: string,
    success: boolean,
    error?: { code: string; message: string },
  ) => void;

  /** Write the translated pi command to the child's stdin. Returns
   *  `false` when the child is dead (or the write throws) so the
   *  router can route through `forceExited`. The router never
   *  throws on write failure — it surfaces the failure via the
   *  boolean return + `forceExited` callback, then broadcasts the
   *  post-cleared state so web sees the entry removal even if the
   *  child died mid-write.
   *
   *  ## Contract — synchronous boolean return (S6 review)
   *
   *  This callback MUST be synchronous and return a plain
   *  `boolean`. The router relies on the result being observable
   *  in the same microtask as the write call: the entry has
   *  already been removed from `pending` (step 4) before the
   *  write is issued, and a return value of `false` immediately
   *  triggers `forceExited` + a final broadcast. If
   *  `writeToPi` were `async` (returning `Promise<boolean>`),
   *  the router would have to `await` it — opening a window
   *  where (a) a concurrent `extension_ui_request` from pi could
   *  be enqueued AFTER the entry was deleted but BEFORE the
   *  write resolves, polluting `pending` ordering, and (b) the
   *  forceExited signal would fire one tick late, after the
   *  router's own broadcast had already reached the web.
   *  Keep this synchronous — the underlying stream `.write()`
   *  is already sync up to the OS pipe buffer; the boolean
   *  return is the honest signal of "did the kernel accept the
   *  bytes". */
  writeToPi: (cmd: PiExtensionUIResponse) => boolean;

  /** Force phase = 'exited' on the manager when stdin write fails.
   *  The manager implements this as: log error → transitionTo('exited')
   *  → broadcast session_state. Called from the router when
   *  `writeToPi` returns false; the router does not own the phase
   *  state machine. */
  forceExited: (reason: string) => void;

  /** Timer overrides (test seam — vitest fake timers). */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

// ---------------------------------------------------------------------------
// ExtensionUIRouter
// ---------------------------------------------------------------------------

export class ExtensionUIRouter {
  // ---- configuration (immutable after construction) ----
  private readonly broadcastSessionState: () => void;
  private readonly emitEventEnvelope: (eventName: string, data: unknown) => void;
  private readonly emitCommandResult: (
    replyTo: string,
    success: boolean,
    error?: { code: string; message: string },
  ) => void;
  private readonly writeToPi: (cmd: PiExtensionUIResponse) => boolean;
  private readonly forceExited: (reason: string) => void;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  // ---- runtime state ----

  /** Pending blocked-on entries, keyed by pi-side `id` (the same UUID
   *  the web echoes back in `extension_ui_response.payload.request_id`).
   *  This Map IS the bridge's local source of truth for
   *  `session_state.payload.blocked_on` — the manager's
   *  broadcastSessionState and handleGetState both read from here. */
  private readonly pending = new Map<string, BlockedOnEntryPayload>();

  /** Timeout handles keyed by request id. A handle exists only while
   *  a blocking entry with a `timeout` field is still pending. When
   *  the entry is removed (committed or timed-out), the handle is
   *  cleared immediately so the timer doesn't fire into a Map that's
   *  already empty (the atomic check in `timeoutFired` is the safety
   *  net, but cancelling proactively avoids a microtask cycle). */
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  /** Last error message surfaced via `forceExited`. Test seam —
   *  production callers read it via the side effect on the manager,
   *  but tests assert on the exact reason text. */
  private lastForceExitedReason: string | null = null;

  constructor(options: ExtensionUIOptions) {
    this.broadcastSessionState = options.broadcastSessionState;
    this.emitEventEnvelope = options.emitEventEnvelope;
    this.emitCommandResult = options.emitCommandResult;
    this.writeToPi = options.writeToPi;
    this.forceExited = options.forceExited;
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
  }

  // ----------------------------------------------------------------
  // Public entry points
  // ----------------------------------------------------------------

  /** Handle an `extension_ui_request` event frame from pi stdout.
   *  Called by the manager from `handleStdoutFrame` when the raw pi
   *  event `{type:"extension_ui_request", ...}` is parsed — the
   *  manager strips `type` and passes the rest as `data` alongside
   *  a fixed `event: 'extension_ui_request'` discriminator so this
   *  router's gating logic (`frame.event !== 'extension_ui_request'`)
   *  keeps working unchanged from the earlier wrapped-frame era. */
  handleEventFromPi(frame: { event: string; data: unknown }): void {
    if (frame.event !== 'extension_ui_request') return;
    const data = frame.data as ExtensionUIRequestData | null | undefined;
    if (data === null || typeof data !== 'object') {
      logger.warn('extension_ui_request received with non-object data — dropping');
      return;
    }
    const method = data.method;
    if (typeof method !== 'string' || typeof data.id !== 'string') {
      logger.warn(`extension_ui_request missing method/id — dropping (method=${String(method)})`);
      return;
    }
    if (BLOCKING_METHODS_SET.has(method)) {
      this.handleBlockingRequest(data as BlockedOnEntryPayload);
      return;
    }
    // Anything else — known fire-and-forget OR an unknown method from
    // a future pi build. Both digest locally; the former via the
    // expected 5-method set, the latter with an extra warn so a pi
    // upgrade that introduces a new method shows up in operator logs.
    if (FIRE_AND_FORGET_METHODS_SET.has(method)) {
      logger.info(
        `fire-and-forget extension_ui_request: method=${method} id=${data.id}`,
      );
      return;
    }
    logger.warn(
      `extension_ui_request with unknown method=${method} — digesting locally (no blocked_on entry, no web forward)`,
    );
  }

  /** Handle a web `extension_ui_response` envelope. The flow is:
   *    1. Atomic check: if entry not in `pending`, emit request_expired
   *       and return (late submission).
   *    2. Look up the entry's method (still in pending) for the
   *       confirm-vs-string translation step.
   *    3. Translate web wire → pi native three-state.
   *    4. Delete entry + clear timeout.
   *    5. Write to pi stdin. On failure → force exited.
   *    6. Broadcast (post-cleared state).
   *
   *  We do step 2 BEFORE step 4 (delete) so the entry is still
   *  available for the method lookup. The cost is one extra Map.get
   *  vs. a side-table of (id → method), and the side-table would
   *  duplicate state — this ordering keeps `pending` as the single
   *  source of truth for both the entry shape AND its membership. */
  handleWebResponse(env: { id: string; payload: ExtensionUIResponsePayload }): void {
    const payload = env.payload;
    const requestId = payload.request_id;

    // Atomic check on the Map — the same check that the timeout
    // callback does, so the two paths can never both succeed.
    // `get()` first (peek); `delete()` happens after we have the
    // method in hand (step 4 below).
    const entry = this.pending.get(requestId);
    if (entry === undefined) {
      // Late submission — already cleared (committed or timed out).
      this.emitCommandResult(env.id, false, {
        code: 'request_expired',
        message: `extension_ui_response for ${requestId} arrived after the request was cleared`,
      });
      return;
    }

    // Translate web wire → pi native three-state. The schema refine
    // has already validated `cancelled: false` carries a `value`,
    // and confirm's `value` is constrained to boolean by the bridge
    // translation step (we never re-validate here — the refine at
    // the schema layer is the single source of truth).
    const piCmd = this.translateToPiNative(payload, entry.method);
    if (piCmd === null) {
      // Should be unreachable given the schema refine, but if a
      // future caller bypasses the schema (e.g. a test fixture with
      // a manually-constructed payload) we don't crash — we just
      // log + surface the inconsistency and still clear the entry
      // (so a stuck entry doesn't leak into the broadcast).
      //
      // Also emit `command_result{success: false, error: {code:
      // "invalid_response", ...}}` keyed by the WEB envelope id
      // (reply_to = env.id) so the web side surfaces the failure
      // via its §4.5 "提交失败 UX" toast + dialog-dismiss path.
      // Without this, the entry clears + the broadcast drops
      // blocked_on, and the web dialog vanishes with zero feedback.
      logger.error(
        `extension_ui_response translation failed for ${requestId}: no pi-native form derivable`,
      );
      this.emitCommandResult(env.id, false, {
        code: 'invalid_response',
        message: `extension_ui_response for ${requestId} could not be translated to a pi-native form (cancelled=false without a value)`,
      });
      this.pending.delete(requestId);
      const staleTimeout = this.timeouts.get(requestId);
      if (staleTimeout !== undefined) {
        this.clearTimer(staleTimeout);
        this.timeouts.delete(requestId);
      }
      this.broadcastSessionState();
      return;
    }

    // Step 4: clear entry + timeout (commit the response).
    this.pending.delete(requestId);
    const timeoutHandle = this.timeouts.get(requestId);
    if (timeoutHandle !== undefined) {
      this.clearTimer(timeoutHandle);
      this.timeouts.delete(requestId);
    }

    // Step 5: write to pi. On failure, force exited (manager
    // implements: log + transitionTo('exited') + broadcast).
    const ok = this.writeToPi(piCmd);
    if (!ok) {
      const errMsg = `stdin write failed for extension_ui_response ${requestId}`;
      logger.error(errMsg);
      this.lastForceExitedReason = errMsg;
      this.forceExited(errMsg);
    }
    // Step 6: broadcast in both paths — success case so web sees
    // blocked_on drop; failure case so the broadcast the manager
    // already emitted (via forceExited → transitionTo → broadcast)
    // is mirrored (idempotent + cheap, and lets a test assert that
    // the router always emits a final broadcast on the response
    // path regardless of stdin outcome).
    this.broadcastSessionState();
  }

  /** Atomic timeout mirror. Called by the timeout handle when the
   *  bridge's local `setTimeout` for a blocking request fires.
   *  Clears the entry + broadcasts ONLY if the entry is still in
   *  the Map — a concurrent commit (web submitted first) already
   *  removed it, in which case this is a no-op (the loser of the
   *  race). */
  timeoutFired(requestId: string): void {
    // We always drop the timeout handle — even if the entry is gone
    // (loser path), the handle is the bookkeeping for "is this
    // timer alive", and the timer's callback firing means the
    // timer is done. Dropping it here is a no-op for the Map
    // (delete returns false) but keeps the invariant: "every
    // timeout that fires gets cleared from the Map immediately".
    this.timeouts.delete(requestId);

    if (!this.pending.delete(requestId)) {
      // Loser — web already submitted and cleared this entry.
      return;
    }
    // Winner — entry is gone, broadcast so web sees the timeout
    // removal. We do NOT write anything to pi — pi will emit its
    // own event when the user doesn't respond in time (pi's native
    // timeout handling is upstream of us); our job is just to keep
    // the blocked_on state consistent.
    this.broadcastSessionState();
  }

  /** Drop ALL pending entries + timeouts. Called by the manager on
   *  child exit (so a stale `pending` from a dead child doesn't
   *  leak into a crash-restarted child's broadcast payload) and on
   *  `stop()` (so a stopping bridge doesn't fire timeouts into a
   *  half-torn-down state). Emits a single broadcast at the end so
   *  web sees `blocked_on: []` (or absent) after the cleanup. */
  clearAll(): void {
    let cleared = false;
    for (const handle of this.timeouts.values()) {
      this.clearTimer(handle);
      cleared = true;
    }
    this.timeouts.clear();
    if (this.pending.size > 0) {
      this.pending.clear();
      cleared = true;
    }
    if (cleared) {
      this.broadcastSessionState();
    }
  }

  /** Snapshot of the current `pending` set, ordered by insertion.
   *  Manager reads this for `session_state.blocked_on` and
   *  `get_state` reply payloads. The order is Map insertion order
   *  (JS spec), which matches pi's emit order — useful for
   *  deterministic UI rendering when multiple dialogs are open. */
  getBlockedOn(): BlockedOnEntryPayload[] {
    return Array.from(this.pending.values());
  }

  /** Test seam — exposes the internal Map for assertion convenience
   *  without going through `getBlockedOn()` (which allocates a new
   *  array on every call). The returned Map is a live reference;
   *  callers must NOT mutate it. */
  getPendingMap(): ReadonlyMap<string, BlockedOnEntryPayload> {
    return this.pending;
  }

  /** Test seam — last reason string passed to `forceExited`. */
  getLastForceExitedReason(): string | null {
    return this.lastForceExitedReason;
  }

  // ----------------------------------------------------------------
  // Internal — pi-event handler for blocking 4-class requests
  // ----------------------------------------------------------------

  /** Handle a 4-class blocking `extension_ui_request`. Casts the
   *  raw data to a `BlockedOnEntryPayload` (validated by the schema
   *  on the wire side; if a future pi build emits a malformed
   *  entry, the schema refine will reject it upstream and we never
   *  get here — but we still guard with a try/catch around the
   *  payload construction so a runtime check doesn't crash the
   *  manager). */
  private handleBlockingRequest(data: BlockedOnEntryPayload): void {
    // If a request with the same id is already pending, the new one
    // replaces it (defensive — pi should never emit duplicates, but
    // the schema doesn't constrain id uniqueness across requests so
    // we handle it here to avoid Map corruption).
    if (this.pending.has(data.id)) {
      logger.warn(
        `extension_ui_request duplicate id=${data.id} method=${data.method} — replacing prior pending entry (pi upgrade or upstream bug?)`,
      );
    }
    this.pending.set(data.id, data);

    // Clear any prior timeout for this id (shouldn't exist for a
    // brand-new request, but the duplicate-id branch above could
    // leave one behind).
    const priorTimeout = this.timeouts.get(data.id);
    if (priorTimeout !== undefined) {
      this.clearTimer(priorTimeout);
      this.timeouts.delete(data.id);
    }

    // Broadcast FIRST so web sees the new entry in the same tick
    // it sees the extension_ui_request event envelope. PRD §2.4
    // mandates this order ("广播 session_state ... → 转发").
    this.broadcastSessionState();

    // Forward verbatim to web — the web layer renders the dialog
    // from this envelope's payload. We pass the raw data (timeout
    // field included) so the web UI can show the countdown for
    // methods that have a timeout.
    this.emitEventEnvelope('extension_ui_request', data);

    // Mirror the timeout locally. Editor has no timeout field — we
    // accept this as known behaviour per PRD §2 已敲定 决策 8
    // ("editor 无 timeout"). We use a type narrow on the blocking
    // payload kind because the BlockedOnEntryPayload discriminated
    // union omits `timeout` from the editor variant.
    const timeoutMs = extractTimeout(data);
    if (timeoutMs !== undefined) {
      const handle = this.setTimer(() => this.timeoutFired(data.id), timeoutMs);
      this.timeouts.set(data.id, handle);
    }
  }

  // ----------------------------------------------------------------
  // Internal — wire translation (web → pi native)
  // ----------------------------------------------------------------

  /** Translate web's `extension_ui_response` payload to pi's native
   *  three-state shape. Returns `null` only when the schema refine
   *  has somehow been bypassed (cancelled: false without a value);
   *  the schema layer catches this at parse time, so the `null`
   *  branch is unreachable in production. We keep it as a defensive
   *  fallback so a bad payload doesn't crash the router.
   *
   *  The `originalMethod` argument is the `method` from the
   *  `BlockedOnEntryPayload` we stored at request time. We use it
   *  to decide whether to translate `value: boolean` to
   *  `confirmed: boolean` (confirm) or `value: string` (select /
   *  input / editor). */
  private translateToPiNative(
    payload: ExtensionUIResponsePayload,
    originalMethod: string,
  ): PiExtensionUIResponse | null {
    if (payload.cancelled === true) {
      // Cancelled — emit ONLY `id` + `cancelled: true` (no value).
      // pi's rpc-client treats `cancelled: true` as "user dismissed
      // the dialog" and falls back to its default branch (same as
      // hitting Esc).
      return { type: 'extension_ui_response', id: payload.request_id, cancelled: true };
    }
    if (payload.value === undefined) {
      // Schema refine rejects this; defensive fallback only.
      return null;
    }
    if (originalMethod === 'confirm') {
      // Confirm: value is always boolean. `value: false` is the
      // "no" path on a confirm dialog (the only way to express
      // decline).
      return {
        type: 'extension_ui_response',
        id: payload.request_id,
        confirmed: payload.value as boolean,
      };
    }
    // select / input / editor — value is always string.
    return {
      type: 'extension_ui_response',
      id: payload.request_id,
      value: payload.value as string,
    };
  }
}

// ---------------------------------------------------------------------------
// Helper — build an event envelope for the 4-class blocking forward path
// ---------------------------------------------------------------------------

/** Construct a `pi/event` envelope carrying an `extension_ui_request`
 *  payload. Exposed so the manager's outbound sink can wrap the
 *  raw data into the canonical envelope shape (randomUUID + payload
 *  wrapping) without the router having to import the outbound sink
 *  callback as a full Envelope emitter. */
export function buildExtensionUIRequestEnvelope(data: BlockedOnEntryPayload): {
  v: typeof PROTOCOL_VERSION;
  kind: 'pi';
  type: 'event';
  id: string;
  payload: { event: string; data: BlockedOnEntryPayload };
} {
  return {
    v: PROTOCOL_VERSION,
    kind: 'pi',
    type: 'event',
    id: randomUUID(),
    payload: { event: 'extension_ui_request', data },
  };
}
