// Assertion helpers for outbound envelopes.
//
// These wrap common patterns (find envelope by predicate, extract
// session_state sequence, verify absence) so each test case stays
// readable. The underlying types come from `@remotepi/shared`; the
// helpers are thin and avoid narrowing magic that obscures intent.

import type { Envelope as EnvelopeT, SessionPhase } from '@remotepi/shared';

/** Return all envelopes matching the predicate, in arrival order. */
export function envelopesOfType<T extends EnvelopeT['type']>(
  outbound: EnvelopeT[],
  kind: EnvelopeT['kind'],
  type: T,
): Extract<EnvelopeT, { kind: typeof kind; type: T }>[] {
  return outbound.filter(
    (e): e is Extract<EnvelopeT, { kind: typeof kind; type: T }> =>
      e.kind === kind && e.type === type,
  );
}

/**
 * Extract the sequence of `phase` values across all session_state
 * envelopes. Useful for asserting the full state-machine path (e.g.
 * `['spawning','ready','running','idle']`) without naming each
 * individual envelope.
 */
export function sessionStates(outbound: EnvelopeT[]): SessionPhase[] {
  return envelopesOfType(outbound, 'control', 'session_state').map((e) => e.payload.phase);
}

/**
 * Snapshot of the most recent session_state envelope's payload. Returns
 * `null` if no session_state has been emitted yet (e.g. the manager
 * has not yet started). The `blocked_on` field is preserved when
 * present.
 */
export function lastSessionState(
  outbound: EnvelopeT[],
): { phase: SessionPhase; blocked_on?: ReadonlyArray<{ method: string; id: string; [k: string]: unknown }> } | null {
  const states = envelopesOfType(outbound, 'control', 'session_state');
  const last = states[states.length - 1];
  return last ? { phase: last.payload.phase, blocked_on: last.payload.blocked_on } : null;
}

/**
 * Assert no envelope in `outbound` matches the predicate. Useful for
 * negative-coverage cases like "the fire-and-forget notify did NOT
 * produce a blocked_on entry". The optional `context` string is
 * included in the failure message so the assertion self-documents.
 */
export function assertNoEnvelopeMatching(
  outbound: EnvelopeT[],
  predicate: (env: EnvelopeT) => boolean,
  context: string,
): void {
  for (const env of outbound) {
    if (predicate(env)) {
      throw new Error(
        `assertNoEnvelopeMatching: unexpected envelope matched (${context}): ${JSON.stringify(env).slice(0, 200)}`,
      );
    }
  }
}

/**
 * Find the first command_result envelope whose `reply_to` equals the
 * given id. Returns `null` if no such envelope has been emitted.
 */
export function findCommandResult(
  outbound: EnvelopeT[],
  replyTo: string,
): Extract<EnvelopeT, { kind: 'pi'; type: 'command_result' }> | null {
  for (const env of outbound) {
    if (env.kind === 'pi' && env.type === 'command_result' && env.reply_to === replyTo) {
      return env;
    }
  }
  return null;
}

/**
 * Concatenate all text_delta payloads from message_update events that
 * belong to a single response (across all content blocks). The pi RPC
 * stream emits `message_update{assistantMessageEvent:{type:'text_delta',
 * delta:'...'}}` — we pluck out the deltas and join them.
 *
 * The result is the "final assistant text" the user would see in the
 * UI. Empty string when no text deltas were seen.
 */
export function collectAssistantText(outbound: EnvelopeT[]): string {
  const out: string[] = [];
  for (const env of outbound) {
    if (env.kind !== 'pi' || env.type !== 'event' || env.payload.event !== 'message_update') {
      continue;
    }
    const data = env.payload.data;
    if (data === null || typeof data !== 'object') continue;
    const ev = (data as { assistantMessageEvent?: unknown }).assistantMessageEvent;
    if (ev === null || typeof ev !== 'object') continue;
    const evt = ev as { type?: unknown; delta?: unknown };
    if (evt.type === 'text_delta' && typeof evt.delta === 'string') {
      out.push(evt.delta);
    }
  }
  return out.join('');
}

/**
 * Find all tool_execution_end events that match a given toolCallId.
 * Used for asserting on extension tool results in the dialog tests.
 */
export function toolExecutionEnds(
  outbound: EnvelopeT[],
): Array<{ toolCallId: string; toolName: string; resultText: string; isError: boolean }> {
  const out: Array<{ toolCallId: string; toolName: string; resultText: string; isError: boolean }> = [];
  for (const env of outbound) {
    if (env.kind !== 'pi' || env.type !== 'event' || env.payload.event !== 'tool_execution_end') {
      continue;
    }
    const data = env.payload.data;
    if (data === null || typeof data !== 'object') continue;
    const d = data as { toolCallId?: unknown; toolName?: unknown; result?: unknown; isError?: unknown };
    if (typeof d.toolCallId !== 'string' || typeof d.toolName !== 'string') continue;
    let resultText = '';
    if (typeof d.result === 'object' && d.result !== null) {
      const content = (d.result as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
            const t = (part as { text?: unknown }).text;
            if (typeof t === 'string') resultText += t;
          }
        }
      }
    }
    out.push({
      toolCallId: d.toolCallId,
      toolName: d.toolName,
      resultText,
      isError: d.isError === true,
    });
  }
  return out;
}
