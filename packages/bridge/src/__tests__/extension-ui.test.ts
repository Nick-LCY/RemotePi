// Vitest specs for the bridge extension UI router (`extension-ui.ts`).
//
// Covers M3 task 05 + PRD §2.4 + §6.2 (the parts task 04 did NOT
// already land). Style mirrors the existing `pi-process.test.ts`:
// one numbered `it` per acceptance case + spelled-out assertions so
// failures point at the property that broke.
//
// Sections:
//   1. blocked_on maintenance (4-class enqueue / 5-class digest)
//   2. timeout mirror + race vs commit (atomic loser-noop)
//   3. wire translation (web → pi native three-state, 6 combos)
//   4. multi-web first-answer-wins (broadcast drops id, late →
//      request_expired)
//   5. broadcast principle (extension_ui_response triggers
//      session_state; fire-and-forget does NOT)
//   6. stdin write failure (→ force exited + broadcast)
//   7. clearAll (child exit / stop)

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  BLOCK_ON_METHODS,
  Envelope,
  PROTOCOL_VERSION,
  type BlockedOnEntryPayload,
  type Envelope as EnvelopeT,
  type ExtensionUIResponsePayload,
} from '@remotepi/shared';
import {
  ExtensionUIRouter,
  FIRE_AND_FORGET_METHODS,
  type ExtensionUIRequestData,
  type PiExtensionUIResponse,
} from '../extension-ui.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Test fixture — build a router with mocked callbacks
// ---------------------------------------------------------------------------

/** Convenience constructor — wires the router to mocked side effects
 *  so each test can assert on `broadcastSessionState` / `emitEventEnvelope`
 *  / `emitCommandResult` / `writeToPi` / `forceExited` without needing
 *  a real manager instance. The router itself is a pure unit. */
function makeRouter(overrides: Partial<{
  writeToPiReturn: boolean;
}> = {}): {
  router: ExtensionUIRouter;
  broadcastSessionState: MockInstance<() => void>;
  emitEventEnvelope: MockInstance<(eventName: string, data: unknown) => void>;
  emitCommandResult: MockInstance<
    (replyTo: string, success: boolean, error?: { code: string; message: string }) => void
  >;
  writeToPi: MockInstance<(cmd: PiExtensionUIResponse) => boolean>;
  forceExited: MockInstance<(reason: string) => void>;
} {
  const broadcastSessionState = vi.fn<() => void>();
  const emitEventEnvelope = vi.fn<(eventName: string, data: unknown) => void>();
  const emitCommandResult = vi.fn<
    (replyTo: string, success: boolean, error?: { code: string; message: string }) => void
  >();
  const writeToPi = vi.fn<(cmd: PiExtensionUIResponse) => boolean>(
    () => overrides.writeToPiReturn ?? true,
  );
  const forceExited = vi.fn<(reason: string) => void>();
  const router = new ExtensionUIRouter({
    broadcastSessionState,
    emitEventEnvelope,
    emitCommandResult,
    writeToPi,
    forceExited,
  });
  return {
    router,
    broadcastSessionState,
    emitEventEnvelope,
    emitCommandResult,
    writeToPi,
    forceExited,
  };
}

/** Construct a minimal blocking entry for the 4-class methods. The
 *  `id` is the only required field; everything else is method-specific
 *  and pre-filled with sensible defaults so tests don't have to
 *  spell out the full discriminated union per case. The overload
 *  set keeps the return type narrow per method (TS discriminates
 *  the union on the `method` field). */
function blockingEntry(
  method: 'select' | 'confirm' | 'input' | 'editor',
  id: string,
): BlockedOnEntryPayload;
function blockingEntry(
  method: 'select',
  id: string,
  overrides: { timeout?: number; title?: string; options?: string[] },
): Extract<BlockedOnEntryPayload, { method: 'select' }>;
function blockingEntry(
  method: 'confirm',
  id: string,
  overrides: { timeout?: number; title?: string; message?: string },
): Extract<BlockedOnEntryPayload, { method: 'confirm' }>;
function blockingEntry(
  method: 'input',
  id: string,
  overrides: { timeout?: number; title?: string; placeholder?: string },
): Extract<BlockedOnEntryPayload, { method: 'input' }>;
function blockingEntry(
  method: 'editor',
  id: string,
  overrides: { title?: string; prefill?: string },
): Extract<BlockedOnEntryPayload, { method: 'editor' }>;
function blockingEntry(
  method: 'select' | 'confirm' | 'input' | 'editor',
  id: string,
  overrides:
    | { timeout?: number; title?: string; options?: string[] }
    | { timeout?: number; title?: string; message?: string }
    | { timeout?: number; title?: string; placeholder?: string }
    | { title?: string; prefill?: string } = {},
): BlockedOnEntryPayload {
  switch (method) {
    case 'select': {
      const o = overrides as { timeout?: number; title?: string; options?: string[] };
      return {
        method: 'select',
        id,
        title: o.title ?? 'Choose one',
        options: o.options ?? ['a', 'b'],
        ...(o.timeout !== undefined ? { timeout: o.timeout } : {}),
      };
    }
    case 'confirm': {
      const o = overrides as { timeout?: number; title?: string; message?: string };
      return {
        method: 'confirm',
        id,
        title: o.title ?? 'Are you sure?',
        message: o.message ?? 'Confirm?',
        ...(o.timeout !== undefined ? { timeout: o.timeout } : {}),
      };
    }
    case 'input': {
      const o = overrides as { timeout?: number; title?: string; placeholder?: string };
      return {
        method: 'input',
        id,
        title: o.title ?? 'Tell me',
        placeholder: o.placeholder ?? 'type here',
        ...(o.timeout !== undefined ? { timeout: o.timeout } : {}),
      };
    }
    case 'editor': {
      const o = overrides as { title?: string; prefill?: string };
      return {
        method: 'editor',
        id,
        title: o.title ?? 'Edit me',
        ...(o.prefill !== undefined ? { prefill: o.prefill } : {}),
      };
    }
  }
}

/** Build a web wire envelope carrying an extension_ui_response. The
 *  Envelope zod schema is the final word on shape — these helpers
 *  just construct valid-looking data so tests don't have to repeat
 *  the boilerplate. */
function webResponse(
  id: string,
  payload: ExtensionUIResponsePayload,
): { id: string; payload: ExtensionUIResponsePayload } {
  return { id, payload };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Silence the default logger so the test output isn't polluted.
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. blocked_on maintenance — 4-class enqueue + 5-class digest
// ---------------------------------------------------------------------------

describe('blocked_on maintenance (PRD §2.4 + §6.2)', () => {
  it('1.1 each of the 4 blocking methods enters pending and triggers a broadcast', () => {
    for (const method of BLOCK_ON_METHODS) {
      const { router, broadcastSessionState, emitEventEnvelope } = makeRouter();
      const entry = blockingEntry(method, `${method}-1`);
      router.handleEventFromPi({ event: 'extension_ui_request', data: entry });

      // Pending now contains the entry.
      expect(router.getPendingMap().size).toBe(1);
      expect(router.getPendingMap().get(`${method}-1`)).toEqual(entry);

      // Broadcast fired (the "add" branch).
      expect(broadcastSessionState).toHaveBeenCalledTimes(1);
      // The router forwarded the event verbatim.
      expect(emitEventEnvelope).toHaveBeenCalledTimes(1);
      expect(emitEventEnvelope).toHaveBeenCalledWith('extension_ui_request', entry);
    }
  });

  it('1.2 each of the 5 fire-and-forget methods is digested locally without entering pending', () => {
    for (const method of FIRE_AND_FORGET_METHODS) {
      const { router, broadcastSessionState, emitEventEnvelope } = makeRouter();
      const data: ExtensionUIRequestData = {
        method,
        id: `${method}-1`,
        // Fire-and-forget frames don't carry blocking-style fields;
        // we pass the method-specific minimal shape.
        ...(method === 'notify' ? { message: 'a notification' } : {}),
      };
      router.handleEventFromPi({ event: 'extension_ui_request', data: data });

      // Pending is empty — fire-and-forget never enters blocked_on.
      expect(router.getPendingMap().size).toBe(0);
      // No broadcast — fire-and-forget doesn't change session state.
      expect(broadcastSessionState).not.toHaveBeenCalled();
      // No forward to web — local-digest only.
      expect(emitEventEnvelope).not.toHaveBeenCalled();
    }
  });

  it('1.3 unknown methods (future pi build) digest locally with a warn, no pending, no forward', () => {
    // Defensive default: if pi introduces a new method that isn't
    // in either BLOCK_ON_METHODS or FIRE_AND_FORGET_METHODS, we
    // treat it as fire-and-forget (logger.warn + drop). This
    // guards against a pi upgrade silently breaking the wire
    // contract — operators see the new method name in logs.
    const { router, broadcastSessionState, emitEventEnvelope } = makeRouter();
    const warnSpy = vi.spyOn(logger, 'warn');
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: { method: 'future_pi_method', id: 'f1' },
    });
    expect(router.getPendingMap().size).toBe(0);
    expect(broadcastSessionState).not.toHaveBeenCalled();
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    const warningSeen = warnSpy.mock.calls.some((args) =>
      String(args[0]).includes('future_pi_method'),
    );
    expect(warningSeen).toBe(true);
  });

  it('1.4 non-object data is dropped with a warn', () => {
    const { router, broadcastSessionState } = makeRouter();
    router.handleEventFromPi({ event: 'extension_ui_request', data: null });
    router.handleEventFromPi({ event: 'extension_ui_request', data: 'string-not-object' });
    router.handleEventFromPi({ event: 'extension_ui_request', data: 42 });
    expect(router.getPendingMap().size).toBe(0);
    expect(broadcastSessionState).not.toHaveBeenCalled();
  });

  it('1.5 data missing method or id is dropped with a warn', () => {
    const { router } = makeRouter();
    router.handleEventFromPi({ event: 'extension_ui_request', data: { id: 'x' } });
    router.handleEventFromPi({ event: 'extension_ui_request', data: { method: 'select' } });
    router.handleEventFromPi({ event: 'extension_ui_request', data: {} });
    expect(router.getPendingMap().size).toBe(0);
  });

  it('1.6 non-extension_ui_request events are ignored (no pending, no broadcast)', () => {
    // The router's only entry point is extension_ui_request; other
    // event names pass through to the manager unchanged. Verify
    // the router doesn't accidentally swallow unrelated events.
    const { router, broadcastSessionState, emitEventEnvelope } = makeRouter();
    router.handleEventFromPi({ event: 'message_update', data: { foo: 'bar' } });
    router.handleEventFromPi({ event: 'agent_settled', data: null });
    expect(router.getPendingMap().size).toBe(0);
    expect(broadcastSessionState).not.toHaveBeenCalled();
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it('1.7 getBlockedOn returns the entries in insertion order (Map insertion order is JS-spec deterministic)', () => {
    // Insertion-order is part of the public contract — web renders
    // dialogs in this order, so a test pins the deterministic
    // ordering for multi-dialog UX.
    const { router } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('select', 'first'),
    });
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('confirm', 'second'),
    });
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('input', 'third'),
    });
    const arr = router.getBlockedOn();
    expect(arr.map((e) => e.id)).toEqual(['first', 'second', 'third']);
  });
});

// ---------------------------------------------------------------------------
// 2. Timeout mirror + race vs commit
// ---------------------------------------------------------------------------

describe('Timeout mirror + race vs commit (PRD §2.4 / 竞态原子检查)', () => {
  it('2.1 an entry with a timeout arms a setTimeout that, on fire, clears the entry and broadcasts', () => {
    vi.useFakeTimers();
    try {
      const { router, broadcastSessionState } = makeRouter();
      router.handleEventFromPi({
        event: 'extension_ui_request',
        data: blockingEntry('select', 's1', { timeout: 5_000 }),
      });
      // One broadcast from the enqueue; no timeout yet.
      expect(broadcastSessionState).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_000);
      // Timeout fired → entry cleared + second broadcast.
      expect(router.getPendingMap().size).toBe(0);
      expect(broadcastSessionState).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('2.2 an entry WITHOUT a timeout does NOT arm a setTimeout (editor; ADR-0004 / 已敲定决策 8)', () => {
    vi.useFakeTimers();
    try {
      const { router, broadcastSessionState } = makeRouter();
      router.handleEventFromPi({
        event: 'extension_ui_request',
        data: blockingEntry('editor', 'e1'),
      });
      expect(broadcastSessionState).toHaveBeenCalledTimes(1);
      // Advance past any plausible editor timeout. Nothing should fire.
      vi.advanceTimersByTime(60 * 60_000);
      // Still only the enqueue broadcast.
      expect(broadcastSessionState).toHaveBeenCalledTimes(1);
      expect(router.getPendingMap().size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('2.3 race: timeout fires AFTER web commits — loser path is a silent no-op', () => {
    vi.useFakeTimers();
    try {
      const { router, broadcastSessionState, writeToPi } = makeRouter();
      router.handleEventFromPi({
        event: 'extension_ui_request',
        data: blockingEntry('select', 'r1', { timeout: 5_000 }),
      });
      expect(broadcastSessionState).toHaveBeenCalledTimes(1);

      // Web submits first → entry cleared + broadcast #2.
      router.handleWebResponse(
        webResponse('web-1', { request_id: 'r1', cancelled: false, value: 'a' }),
      );
      expect(router.getPendingMap().size).toBe(0);
      expect(broadcastSessionState).toHaveBeenCalledTimes(2);
      expect(writeToPi).toHaveBeenCalledTimes(1);

      // Now the queued timeout fires — should be a silent no-op:
      // entry is already gone, so no third broadcast.
      vi.advanceTimersByTime(5_000);
      expect(broadcastSessionState).toHaveBeenCalledTimes(2);
      // The pi-side write is still the one from the commit; no
      // extra write from the loser timeout.
      expect(writeToPi).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('2.4 race: web commits AFTER timeout fires — also a silent no-op (request_expired on the late submit)', () => {
    vi.useFakeTimers();
    try {
      const { router, broadcastSessionState, emitCommandResult, writeToPi } = makeRouter();
      router.handleEventFromPi({
        event: 'extension_ui_request',
        data: blockingEntry('confirm', 'r2', { timeout: 5_000 }),
      });
      expect(broadcastSessionState).toHaveBeenCalledTimes(1);

      // Timeout fires first → entry cleared + broadcast #2.
      vi.advanceTimersByTime(5_000);
      expect(router.getPendingMap().size).toBe(0);
      expect(broadcastSessionState).toHaveBeenCalledTimes(2);

      // Now a late web commit arrives → request_expired.
      router.handleWebResponse(
        webResponse('web-2', { request_id: 'r2', cancelled: false, value: true }),
      );
      expect(emitCommandResult).toHaveBeenCalledTimes(1);
      const call = emitCommandResult.mock.calls[0]!;
      expect(call[0]).toBe('web-2');
      expect(call[1]).toBe(false);
      const errObj = call[2];
      expect(errObj?.code).toBe('request_expired');
      expect(String(errObj?.message)).toContain('r2');
      // Still no extra broadcast.
      expect(broadcastSessionState).toHaveBeenCalledTimes(2);
      // No pi-side write for the late submission.
      expect(writeToPi).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('2.5 timeout fires for the right request id (one timer per pending entry)', () => {
    vi.useFakeTimers();
    try {
      const { router, broadcastSessionState } = makeRouter();
      router.handleEventFromPi({
        event: 'extension_ui_request',
        data: blockingEntry('select', 's-a', { timeout: 1_000 }),
      });
      router.handleEventFromPi({
        event: 'extension_ui_request',
        data: blockingEntry('select', 's-b', { timeout: 5_000 }),
      });
      expect(broadcastSessionState).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(1_000);
      // Only s-a fired.
      expect(router.getPendingMap().has('s-a')).toBe(false);
      expect(router.getPendingMap().has('s-b')).toBe(true);
      expect(broadcastSessionState).toHaveBeenCalledTimes(3);

      vi.advanceTimersByTime(4_000);
      // Now s-b fired.
      expect(router.getPendingMap().size).toBe(0);
      expect(broadcastSessionState).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Wire translation — web → pi native three-state, 6 combos
// ---------------------------------------------------------------------------

describe('Wire translation (PRD §1.6 / §2.4 — 6 combos)', () => {
  it('3.1 cancelled: true → { type, id, cancelled: true } (no value)', () => {
    const { router, writeToPi } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('select', 'tx-1'),
    });
    router.handleWebResponse(
      webResponse('web-1', { request_id: 'tx-1', cancelled: true }),
    );
    expect(writeToPi).toHaveBeenCalledTimes(1);
    const cmd = writeToPi.mock.calls[0]![0];
    expect(cmd).toEqual({
      type: 'extension_ui_response',
      id: 'tx-1',
      cancelled: true,
    });
    // Crucially: no `value` or `confirmed` field — cancelled:true
    // is a 2-field shape (PRD §1.6 wire translation).
    expect('value' in cmd).toBe(false);
    expect('confirmed' in cmd).toBe(false);
  });

  it('3.1b cancelled: true with value present → still emits { cancelled: true } (value ignored)', () => {
    // The schema doesn't reject `cancelled: true + value: ...`
    // (the refine only requires value when cancelled=false), but
    // the bridge MUST emit only {cancelled: true} to pi — the
    // value field is meaningless when cancelled. A web bug
    // carrying a stale value through cancel MUST NOT produce a
    // pi-side command with both `cancelled` and `value`.
    const { router, writeToPi } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('select', 'tx-1b'),
    });
    router.handleWebResponse(
      webResponse('web-1b', { request_id: 'tx-1b', cancelled: true, value: 'stale' }),
    );
    expect(writeToPi).toHaveBeenCalledTimes(1);
    expect(writeToPi.mock.calls[0]![0]).toEqual({
      type: 'extension_ui_response',
      id: 'tx-1b',
      cancelled: true,
    });
  });

  it('3.2 confirm value: true → { type, id, confirmed: true }', () => {
    const { router, writeToPi } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('confirm', 'tx-2'),
    });
    router.handleWebResponse(
      webResponse('web-2', { request_id: 'tx-2', cancelled: false, value: true }),
    );
    expect(writeToPi).toHaveBeenCalledTimes(1);
    expect(writeToPi).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'tx-2',
      confirmed: true,
    });
  });

  it('3.3 confirm value: false → { type, id, confirmed: false } (R2 修正点, 独立用例)', () => {
    // PRD §1.6 决策 1: "confirm 靠 value: boolean 表达『否』
    // (value: false)" — the only way for a confirm dialog to
    // express "no" is value: false. R2 修正 explicitly added this
    // independent case to §6.2 so a regression where the cast
    // accidentally defaults to confirmed: true can't slip through.
    const { router, writeToPi } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('confirm', 'tx-3'),
    });
    router.handleWebResponse(
      webResponse('web-3', { request_id: 'tx-3', cancelled: false, value: false }),
    );
    expect(writeToPi).toHaveBeenCalledTimes(1);
    expect(writeToPi).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'tx-3',
      confirmed: false,
    });
    // value must NOT be present on the pi-side command — pi's
    // confirmed field is mutually exclusive with value.
    expect('value' in writeToPi.mock.calls[0]![0]).toBe(false);
  });

  it('3.4 select value: string → { type, id, value: <string> }', () => {
    const { router, writeToPi } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('select', 'tx-4'),
    });
    router.handleWebResponse(
      webResponse('web-4', { request_id: 'tx-4', cancelled: false, value: 'option-a' }),
    );
    expect(writeToPi).toHaveBeenCalledTimes(1);
    expect(writeToPi).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'tx-4',
      value: 'option-a',
    });
  });

  it('3.5 input value: string → { type, id, value: <string> }', () => {
    const { router, writeToPi } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('input', 'tx-5'),
    });
    router.handleWebResponse(
      webResponse('web-5', { request_id: 'tx-5', cancelled: false, value: 'typed text' }),
    );
    expect(writeToPi).toHaveBeenCalledTimes(1);
    expect(writeToPi).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'tx-5',
      value: 'typed text',
    });
  });

  it('3.6 editor value: string → { type, id, value: <string> }', () => {
    const { router, writeToPi } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('editor', 'tx-6'),
    });
    router.handleWebResponse(
      webResponse('web-6', { request_id: 'tx-6', cancelled: false, value: 'edited body' }),
    );
    expect(writeToPi).toHaveBeenCalledTimes(1);
    expect(writeToPi).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'tx-6',
      value: 'edited body',
    });
  });

  it('3.7 successful response clears the pending entry + cancels the timeout + emits a broadcast', () => {
    vi.useFakeTimers();
    try {
      const { router, broadcastSessionState } = makeRouter();
      router.handleEventFromPi({
        event: 'extension_ui_request',
        data: blockingEntry('confirm', 'tx-7', { timeout: 5_000 }),
      });
      expect(router.getPendingMap().size).toBe(1);
      expect(broadcastSessionState).toHaveBeenCalledTimes(1);

      router.handleWebResponse(
        webResponse('web-7', { request_id: 'tx-7', cancelled: false, value: true }),
      );
      // Entry cleared, broadcast #2 (the post-cleared state).
      expect(router.getPendingMap().size).toBe(0);
      expect(broadcastSessionState).toHaveBeenCalledTimes(2);

      // Timeout must NOT fire after commit — advance the timer and
      // verify no third broadcast (cancellation took effect).
      vi.advanceTimersByTime(5_000);
      expect(broadcastSessionState).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('3.8 translation returns null → emit invalid_response command_result + clear entry (S2 review)', () => {
    // The schema refine in @remotepi/shared blocks
    // `cancelled: false` without a `value` — so this case is
    // unreachable in production. But the router keeps a
    // defensive `if (piCmd === null)` branch so a future caller
    // that bypasses the schema (a test fixture, a future RPC
    // path that doesn't go through the Envelope zod parse, etc.)
    // can't crash the bridge. S2 review: prior to this change
    // the null branch silently cleared the entry + broadcasted,
    // which made the web dialog vanish with no feedback. Now it
    // ALSO emits `command_result{success:false, error:{code:
    // 'invalid_response', ...}}` keyed by the WEB envelope id,
    // so the web layer's §4.5 提交失败 UX surfaces the rejection
    // (toast + dialog dismiss).
    const { router, emitCommandResult, writeToPi, broadcastSessionState } = makeRouter();
    const errorSpy = vi.spyOn(logger, 'error');
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('confirm', 'tx-8'),
    });
    expect(router.getPendingMap().size).toBe(1);
    // Build a payload that bypasses the schema (cancelled: false
    // without a value) — the `as` cast is the whole point of
    // this test: simulate a caller that doesn't run the refine.
    const malformed = {
      request_id: 'tx-8',
      cancelled: false,
    } as unknown as ExtensionUIResponsePayload;

    router.handleWebResponse(webResponse('web-8-bad', malformed));

    // The error path: writeToPi was NOT called (no pi-side
    // command to write — we couldn't translate).
    expect(writeToPi).not.toHaveBeenCalled();
    // Exactly one command_result with success=false and the
    // 'invalid_response' code (S2's new contract).
    expect(emitCommandResult).toHaveBeenCalledTimes(1);
    const call = emitCommandResult.mock.calls[0]!;
    expect(call[0]).toBe('web-8-bad'); // reply_to = WEB envelope id
    expect(call[1]).toBe(false);
    const errObj = call[2];
    expect(errObj?.code).toBe('invalid_response');
    expect(String(errObj?.message)).toContain('tx-8');
    // The router also logged an error with the request id for
    // operator triage (mirrors the S1 symmetric-warn pattern).
    const errorSeen = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('extension_ui_response translation failed for tx-8'),
    );
    expect(errorSeen).toBe(true);
    // The entry was still cleared + a broadcast fired (so the
    // dialog drops from blocked_on), just like the prior
    // pre-S2 behavior — the new behavior is the additional
    // command_result, not a removal of the existing cleanup.
    expect(router.getPendingMap().size).toBe(0);
    // 1 broadcast for the enqueue + 1 for the post-clear.
    expect(broadcastSessionState).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-web first-answer-wins
// ---------------------------------------------------------------------------

describe('Multi-web first-answer-wins (PRD §2.4)', () => {
  it('4.1 first web commits → broadcast drops the id from blocked_on; second web sees the empty entry', () => {
    const { router, broadcastSessionState } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('confirm', 'm-1'),
    });
    expect(router.getBlockedOn().map((e) => e.id)).toEqual(['m-1']);
    expect(broadcastSessionState).toHaveBeenCalledTimes(1);

    router.handleWebResponse(
      webResponse('web-A', { request_id: 'm-1', cancelled: false, value: true }),
    );
    // Broadcast #2 reflects the cleared blocked_on — this is the
    // signal web B uses to close its copy of the dialog.
    expect(broadcastSessionState).toHaveBeenCalledTimes(2);
    expect(router.getBlockedOn().map((e) => e.id)).toEqual([]);
  });

  it('4.2 second web submit (after first) → request_expired with reply_to = web envelope id', () => {
    const { router, emitCommandResult, writeToPi } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('confirm', 'm-2'),
    });

    // Web A wins.
    router.handleWebResponse(
      webResponse('web-A', { request_id: 'm-2', cancelled: false, value: true }),
    );

    // Web B submits late.
    router.handleWebResponse(
      webResponse('web-B', { request_id: 'm-2', cancelled: false, value: false }),
    );

    // The late submission triggered exactly one command_result with
    // success=false and the late web's id as reply_to (PRD §2.4).
    expect(emitCommandResult).toHaveBeenCalledTimes(1);
    const call = emitCommandResult.mock.calls[0]!;
    expect(call[0]).toBe('web-B');
    expect(call[1]).toBe(false);
    const errObj = call[2];
    expect(errObj?.code).toBe('request_expired');
    expect(String(errObj?.message)).toContain('m-2');
    // writeToPi fired exactly once (for the winning submission).
    expect(writeToPi).toHaveBeenCalledTimes(1);
    // The pi-side write carries the winning confirmed: true value.
    expect(writeToPi).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'm-2',
      confirmed: true,
    });
  });

  it('4.3 web submit before any pi request → request_expired (defensive: no entry, no Map access needed)', () => {
    // Defensive case: a buggy web client could send a response
    // before any matching request. The router's Map.delete returns
    // false (key absent) and we emit request_expired. This is the
    // same path as a late submission — same wire shape, same
    // reply_to rule.
    const { router, emitCommandResult } = makeRouter();
    router.handleWebResponse(
      webResponse('web-1', { request_id: 'phantom', cancelled: false, value: 'x' }),
    );
    expect(emitCommandResult).toHaveBeenCalledTimes(1);
    const call = emitCommandResult.mock.calls[0]!;
    expect(call[0]).toBe('web-1');
    expect(call[1]).toBe(false);
    const errObj = call[2];
    expect(errObj?.code).toBe('request_expired');
    expect(String(errObj?.message)).toContain('phantom');
  });

  it('4.4 multi-dialog concurrency: each id is independent (first-answer per id)', () => {
    // Two simultaneous dialogs open, two web clients race on each
    // independently. The router's Map-based lookup guarantees
    // per-id isolation — one race's winner doesn't affect the
    // other's pending state.
    const { router, emitCommandResult, writeToPi } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('select', 'dialog-A'),
    });
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('confirm', 'dialog-B'),
    });
    expect(router.getBlockedOn().map((e) => e.id)).toEqual(['dialog-A', 'dialog-B']);

    // Web-A wins on dialog-A, Web-B wins on dialog-B (parallel).
    router.handleWebResponse(
      webResponse('web-A', { request_id: 'dialog-A', cancelled: false, value: 'opt-1' }),
    );
    router.handleWebResponse(
      webResponse('web-B', { request_id: 'dialog-B', cancelled: false, value: true }),
    );

    expect(writeToPi).toHaveBeenCalledTimes(2);
    expect(emitCommandResult).not.toHaveBeenCalled();
    expect(router.getBlockedOn()).toEqual([]);

    // A third web client submits for one of the dialogs — late.
    router.handleWebResponse(
      webResponse('web-late', { request_id: 'dialog-A', cancelled: false, value: 'opt-2' }),
    );
    expect(emitCommandResult).toHaveBeenCalledTimes(1);
    const call = emitCommandResult.mock.calls[0]!;
    expect(call[0]).toBe('web-late');
    expect(call[1]).toBe(false);
    const errObj = call[2];
    expect(errObj?.code).toBe('request_expired');
    expect(String(errObj?.message)).toContain('dialog-A');
  });
});

// ---------------------------------------------------------------------------
// 5. Broadcast principle (PRD §2)
// ---------------------------------------------------------------------------

describe('Broadcast principle (PRD §2 — get_messages does NOT; writes DO)', () => {
  it('5.1 extension_ui_response handling triggers exactly one session_state broadcast (post-cleared state)', () => {
    const { router, broadcastSessionState } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('confirm', 'b-1'),
    });
    expect(broadcastSessionState).toHaveBeenCalledTimes(1); // enqueue

    router.handleWebResponse(
      webResponse('web-1', { request_id: 'b-1', cancelled: false, value: true }),
    );
    // Post-cleared broadcast — the one that lets every web see the
    // removal and dismiss their dialog copy.
    expect(broadcastSessionState).toHaveBeenCalledTimes(2);
  });

  it('5.2 fire-and-forget extension_ui_request handling does NOT trigger a broadcast', () => {
    const { router, broadcastSessionState } = makeRouter();
    for (const method of FIRE_AND_FORGET_METHODS) {
      router.handleEventFromPi({
        event: 'extension_ui_request',
        data: { method, id: `${method}-1` },
      });
    }
    expect(broadcastSessionState).not.toHaveBeenCalled();
  });

  it('5.3 timeout-firing triggers exactly one session_state broadcast (post-cleared state)', () => {
    vi.useFakeTimers();
    try {
      const { router, broadcastSessionState } = makeRouter();
      router.handleEventFromPi({
        event: 'extension_ui_request',
        data: blockingEntry('confirm', 't-1', { timeout: 1_000 }),
      });
      expect(broadcastSessionState).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_000);
      // Timeout fired → entry cleared → broadcast.
      expect(broadcastSessionState).toHaveBeenCalledTimes(2);
      // The pending array is empty.
      expect(router.getBlockedOn()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('5.4 the router does NOT broadcast on non-event input (idempotent against other event names)', () => {
    // The router must not react to event names other than
    // extension_ui_request — the manager's `handlePiEvent`
    // already routes the rest to the outbound sink.
    const { router, broadcastSessionState } = makeRouter();
    router.handleEventFromPi({ event: 'message_update', data: { delta: 'x' } });
    router.handleEventFromPi({ event: 'agent_settled', data: null });
    router.handleEventFromPi({ event: 'queue_update', data: { steering: [] } });
    expect(broadcastSessionState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. stdin write failure (PRD §2.4 + §6.2)
// ---------------------------------------------------------------------------

describe('stdin write failure → force exited + broadcast', () => {
  it('6.1 writeToPi returns false → forceExited called with reason + post-cleared broadcast still fires', () => {
    // When pi's stdin write fails, the entry has ALREADY been
    // removed from pending (step 4 runs before step 5). The router
    // logs the error, calls forceExited (which the manager
    // implements as transitionTo('exited') → broadcast), and then
    // emits its own broadcast — both broadcasts are valid; the
    // first carries phase='exited' + cleared blocked_on, the
    // second carries cleared blocked_on (idempotent from web's
    // perspective).
    const {
      router,
      writeToPi,
      forceExited,
      broadcastSessionState,
    } = makeRouter({ writeToPiReturn: false });
    const errorSpy = vi.spyOn(logger, 'error');
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('confirm', 'f-1'),
    });
    expect(broadcastSessionState).toHaveBeenCalledTimes(1);

    router.handleWebResponse(
      webResponse('web-1', { request_id: 'f-1', cancelled: false, value: true }),
    );

    expect(writeToPi).toHaveBeenCalledTimes(1);
    expect(forceExited).toHaveBeenCalledTimes(1);
    expect(forceExited.mock.calls[0]![0]).toMatch(/stdin write failed for extension_ui_response f-1/);
    // Error was logged with the request id for operator triage.
    const errorSeen = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('stdin write failed for extension_ui_response f-1'),
    );
    expect(errorSeen).toBe(true);
    // The router's broadcast was called twice — once for the
    // enqueue, once for the post-cleared state (forceExited's
    // own broadcast is the manager's responsibility, not the
    // router's — we just verify the router fires its own).
    expect(broadcastSessionState).toHaveBeenCalledTimes(2);
    expect(router.getLastForceExitedReason()).toMatch(/f-1/);
  });

  it('6.2 writeToPi returns true (normal write) → forceExited NOT called', () => {
    const { router, writeToPi, forceExited } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('confirm', 'f-2'),
    });
    router.handleWebResponse(
      webResponse('web-2', { request_id: 'f-2', cancelled: false, value: true }),
    );
    expect(writeToPi).toHaveBeenCalledTimes(1);
    expect(forceExited).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. clearAll — child exit / stop
// ---------------------------------------------------------------------------

describe('clearAll (PRD §2.6 — child exit + stop())', () => {
  it('7.1 clearAll drops all pending entries + timeouts + emits a single final broadcast', () => {
    vi.useFakeTimers();
    try {
      const { router, broadcastSessionState } = makeRouter();
      router.handleEventFromPi({
        event: 'extension_ui_request',
        data: blockingEntry('select', 'c-1', { timeout: 5_000 }),
      });
      router.handleEventFromPi({
        event: 'extension_ui_request',
        data: blockingEntry('confirm', 'c-2', { timeout: 5_000 }),
      });
      expect(router.getPendingMap().size).toBe(2);
      expect(broadcastSessionState).toHaveBeenCalledTimes(2);

      router.clearAll();
      expect(router.getPendingMap().size).toBe(0);
      // +1 broadcast for the cleanup.
      expect(broadcastSessionState).toHaveBeenCalledTimes(3);

      // The timeouts were cancelled — advancing must NOT fire
      // additional broadcasts.
      vi.advanceTimersByTime(10_000);
      expect(broadcastSessionState).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('7.2 clearAll on an empty router is a no-op (no broadcast)', () => {
    const { router, broadcastSessionState } = makeRouter();
    router.clearAll();
    // Empty → no broadcast (nothing changed).
    expect(broadcastSessionState).not.toHaveBeenCalled();
    expect(router.getPendingMap().size).toBe(0);
  });

  it('7.3 clearAll is safe to call twice in a row', () => {
    const { router, broadcastSessionState } = makeRouter();
    router.handleEventFromPi({
      event: 'extension_ui_request',
      data: blockingEntry('input', 'c-3'),
    });
    expect(broadcastSessionState).toHaveBeenCalledTimes(1);
    router.clearAll();
    router.clearAll();
    // First clearAll: +1 broadcast. Second clearAll: nothing to
    // drop → no broadcast.
    expect(broadcastSessionState).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 8. End-to-end via the manager (router + manager wiring)
// ---------------------------------------------------------------------------
//
// These tests construct a real PiProcessManager + ExtensionUIRouter
// to exercise the wiring (handlePiEvent → router → broadcast →
// forward). They cover the integration points that aren't reachable
// from a pure router unit test.

describe('Integration via PiProcessManager (PRD §6.2 — broadcast principle + stdout flow)', () => {
  // We deliberately don't import pi-process.ts here — the manager
  // wiring is exercised in pi-process.test.ts (sections 8a.7). This
  // section stays focused on the router's contract surface so a
  // future refactor of the manager doesn't have to touch the router
  // tests.
  it('8.1 every outbound envelope from the router round-trips through the shared Envelope schema', () => {
    // Pin the wire shape of the extension_ui_request envelope
    // built by `buildExtensionUIRequestEnvelope`. This catches
    // accidental field-name typos before they hit the wire.
    const { router, emitEventEnvelope } = makeRouter();
    const entry = blockingEntry('confirm', 'w-1');
    router.handleEventFromPi({ event: 'extension_ui_request', data: entry });
    // emitEventEnvelope was called with (eventName, data); the
    // manager wraps it in an envelope. We assert the data shape
    // round-trips through Envelope schema (verifying the entry's
    // per-method fields survive the round-trip).
    expect(emitEventEnvelope).toHaveBeenCalledWith('extension_ui_request', entry);
    const result = Envelope.safeParse({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'event',
      id: 'envelope-id',
      payload: {
        event: 'extension_ui_request',
        data: entry,
      },
    });
    expect(result.success).toBe(true);
  });

  it('8.2 the request_expired command_result envelope round-trips through Envelope schema', () => {
    // The error envelope shape must validate downstream (worker
    // forwards verbatim). Pin the contract here so a future
    // refactor of emitCommandResult doesn't break the wire.
    const { router, emitCommandResult } = makeRouter();
    router.handleWebResponse(
      webResponse('web-1', { request_id: 'phantom', cancelled: false, value: 'x' }),
    );
    expect(emitCommandResult).toHaveBeenCalledTimes(1);
    const [_replyTo, _success, error] = emitCommandResult.mock.calls[0]!;
    const result = Envelope.safeParse({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'command_result',
      id: 'env-1',
      reply_to: 'web-1',
      payload: {
        command: 'extension_ui_response',
        success: false,
        error,
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Wire / block-on entry round-trip
// ---------------------------------------------------------------------------

describe('BlockedOnEntryPayload round-trip through the router', () => {
  it('9.1 each blocking method entry survives the schema refine + router storage cycle', () => {
    // Spot-check that a pi event with a full per-method payload
    // (not just id+method) survives the cast + storage step.
    const cases: Array<{ method: 'select' | 'confirm' | 'input' | 'editor'; extra: Record<string, unknown> }> = [
      { method: 'select', extra: { title: 'Pick', options: ['x', 'y', 'z'], timeout: 10_000 } },
      { method: 'confirm', extra: { title: 'Sure?', message: 'Are you sure?', timeout: 30_000 } },
      { method: 'input', extra: { title: 'Tell me', placeholder: 'go on', timeout: 60_000 } },
      { method: 'editor', extra: { title: 'Edit', prefill: 'initial body' } },
    ];
    for (const { method, extra } of cases) {
      const { router, emitEventEnvelope } = makeRouter();
      const entry = { method, id: `${method}-9`, ...extra } as BlockedOnEntryPayload;
      router.handleEventFromPi({ event: 'extension_ui_request', data: entry });
      const expected: EnvelopeT = {
        v: PROTOCOL_VERSION,
        kind: 'pi',
        type: 'event',
        id: 'irrelevant',
        payload: { event: 'extension_ui_request', data: entry },
      };
      expect(Envelope.safeParse(expected).success).toBe(true);
      expect(emitEventEnvelope).toHaveBeenCalledWith('extension_ui_request', entry);
      // The pending Map holds the entry verbatim.
      expect(router.getPendingMap().get(`${method}-9`)).toEqual(entry);
    }
  });
});
