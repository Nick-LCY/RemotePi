// ChatView — M3 main chat surface (PRD §4.3).
//
// Composition:
//   <PhaseIndicator />   — StatusBar-below row showing current phase.
//                          `work_dir` source: not part of v1 wire
//                          surface (only bridge config knows it);
//                          we display only phase and note the gap in
//                          the dev report (PRD §4.3 wording allows
//                          this fallback).
//   <MessageList />      — History + streaming draft (typing effect).
//   <QueueIndicator />   — Steering + followUp queue lengths.
//   <InputBar />         — Text input + send + abort.
//   <DialogHost />       — Layered dialog renderer over the chat.
//
// State source: WsClient. ChatView reads exclusively from useWsState
// hooks (no local state that could drift from the protocol) — the
// only React state local to this subtree is the controlled-input
// value in InputBar.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';

import {
  useCommandErrorSubscription,
  useMessages,
  useQueue,
  useSessionPhase,
  useStreamingDraft,
  useWsClient,
} from '../ws/WsClientContext.js';
import { DialogHost } from './dialogs/DialogHost.js';

// ---------------------------------------------------------------------------
// ChatView
// ---------------------------------------------------------------------------

export function ChatView() {
  return (
    <div className="chat-view" data-testid="chat-view">
      <PhaseIndicator />
      <MessageList />
      <QueueIndicator />
      <InputBar />
      <DialogHost />
    </div>
  );
}

// ---------------------------------------------------------------------------
// PhaseIndicator
// ---------------------------------------------------------------------------

/** Small row below the StatusBar showing the current pi subprocess
 *  phase. The 5-value enum maps to 5 distinct visual states so the
 *  user can spot the transition between "agent thinking" and
 *  "ready for input" at a glance.
 *
 *  `work_dir` is intentionally NOT shown: the v1 wire surface does
 *  not carry bridge-side configuration to the web client, and the
 *  task brief authorises the phase-only fallback ("若无来源则以
 *  phase 为准并在汇报中说明"). The dev report covers this gap. */
function PhaseIndicator() {
  const phase = useSessionPhase();
  const label = phase ?? 'unknown';
  const hint = phaseHint(phase);
  return (
    <div className="phase-indicator" aria-live="polite" data-phase={phase ?? 'unknown'}>
      <span className={`phase-badge phase-${phase ?? 'unknown'}`}>{label}</span>
      {hint !== null ? <span className="phase-hint">{hint}</span> : null}
    </div>
  );
}

function phaseHint(phase: ReturnType<typeof useSessionPhase>): string | null {
  switch (phase) {
    case 'spawning':
      return 'spawning pi…';
    case 'ready':
      return 'ready';
    case 'running':
      return 'agent is working — input disabled';
    case 'idle':
      return 'agent settled — 5 min idle timer running';
    case 'exited':
      return 'exited — next message will respawn pi';
    case null:
      return 'awaiting first session_state…';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// MessageList
// ---------------------------------------------------------------------------

/** Renders the authoritative message history + the in-flight streaming
 *  draft as a single scrolling list. `message_end` events clear the
 *  matching draft via `messageId` (WsClient owns this matching), so
 *  the UI doesn't need to deduplicate.
 *
 *  Each message is rendered via a small renderer that picks out a
 *  `role` and a text body when the shape carries one. Anything that
 *  doesn't match the renderer pattern falls back to a
 *  `<pre>{JSON.stringify(...)}</pre>` so the user can still see what
 *  pi emitted (the shared package treats messages as opaque). */
function MessageList() {
  const messages = useMessages();
  const draft = useStreamingDraft();

  // No virtualization for now — the MESSAGES_CAP of 1k keeps the DOM
  // small enough that simple flex layout outperforms virtualized lists
  // (which add runtime + accessibility complexity we don't need yet).
  // If a session outgrows this, swap to a virtualized list — the
  // shape below (item = role + text) is the right abstraction.
  const items = useMemo(() => {
    const list: { key: string; role: string; text: string; isDraft: boolean }[] = [];
    for (let i = 0; i < messages.length; i += 1) {
      list.push(messageToItem(messages[i], i, false));
    }
    if (draft !== null && draft.text.length > 0) {
      list.push({
        key: `draft:${draft.messageId ?? 'live'}`,
        role: draft.role ?? 'assistant',
        text: draft.text,
        isDraft: true,
      });
    }
    return list;
  }, [messages, draft]);

  return (
    <section className="card message-list" aria-label="Conversation">
      {items.length === 0 ? (
        <p className="empty">No messages yet — send a prompt to start.</p>
      ) : (
        <ol className="message-list-items">
          {items.map((item) => (
            <li
              key={item.key}
              className={`message-row message-role-${item.role}${item.isDraft ? ' message-draft' : ''}`}
            >
              <div className="message-role">{item.role}</div>
              <div className="message-body">
                {item.text.split('\n').map((line, idx, arr) => (
                  <span key={idx}>
                    {line}
                    {idx < arr.length - 1 ? <br /> : null}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Coerce a pi-native message shape into a uniform `{ role, text }`
 *  item. Falls back to a JSON dump for shapes we don't recognise —
 *  the shared package treats `messages` as `unknown[]`, so we never
 *  throw on an unfamiliar element. */
function messageToItem(
  raw: unknown,
  index: number,
  isDraft: boolean,
): { key: string; role: string; text: string; isDraft: boolean } {
  const key = isDraft ? 'draft' : stableKey(raw, index);
  if (raw === null || typeof raw !== 'object') {
    // Defensive stringification: primitives get String(); null/undefined
    // become the literal empty string. Avoid `String(raw ?? '')` which
    // would trigger Object's default toString for object fallthroughs.
    let primitiveText: string;
    if (raw === null || raw === undefined) {
      primitiveText = '';
    } else if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      primitiveText = String(raw);
    } else {
      primitiveText = extractJson(raw);
    }
    return { key, role: 'unknown', text: primitiveText, isDraft };
  }
  const obj = raw as Record<string, unknown>;
  const role = typeof obj.role === 'string' ? obj.role : 'unknown';
  const text = extractText(obj.content) ?? extractText(obj.text) ?? extractJson(raw);
  return { key, role, text, isDraft };
}

/** A stable string key for React rendering — uses the messageId when
 *  available, then a JSON fingerprint, and finally falls back to the
 *  caller's index (S3 review: `Math.random()` made the fallback
 *  unstable across renders, which inflated React's reconciliation
 *  cost for unknown-shape rows; `'idx:' + index` is stable per mount
 *  and sufficient because every unknown-shape row either has a real
 *  id or it falls into a small fixed tail). */
function stableKey(raw: unknown, index: number): string {
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const k of ['messageId', 'message_id', 'id']) {
      if (typeof obj[k] === 'string') return String(obj[k]);
    }
  }
  try {
    return 'idx:' + JSON.stringify(raw).slice(0, 64);
  } catch {
    return 'idx:' + index;
  }
}

/** Extract a text payload from the common pi-native `content`
 *  variants:
 *    - string                  → use as-is
 *    - `{ text: string }`      → use the text field
 *    - `[{ type:'text', text:'…' }, …]` → join text fields
 *  Returns `undefined` for shapes we don't recognise so the caller
 *  can fall back to JSON rendering. */
function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  if (Array.isArray(value)) {
    const joined = value
      .map((piece) => {
        if (piece === null || typeof piece !== 'object') return null;
        const text = (piece as Record<string, unknown>).text;
        return typeof text === 'string' ? text : null;
      })
      .filter((s): s is string => s !== null)
      .join('');
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

function extractJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable message]';
  }
}

// ---------------------------------------------------------------------------
// QueueIndicator
// ---------------------------------------------------------------------------

/** Tiny footer showing the steering + follow_up queue depths. Hidden
 *  when both queues are empty to keep the chat surface uncluttered
 *  (most of the time the queues are empty). */
function QueueIndicator() {
  const queue = useQueue();
  const total = queue.steering.length + queue.followUp.length;
  if (total === 0) return null;
  return (
    <div className="queue-indicator" role="status" aria-live="polite">
      <span
        className="queue-pill"
        title="Messages currently steering the running turn (mid-run inserts)"
      >
        steering: <strong>{queue.steering.length}</strong>
      </span>
      <span className="queue-pill" title="Messages queued for after the current turn settles">
        follow-up: <strong>{queue.followUp.length}</strong>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InputBar
// ---------------------------------------------------------------------------

/** Bottom-of-screen input bar. Behaviour rules (PRD §4.3):
 *    - send prompt (Enter or click) → `client.sendPrompt(value)`
 *      and clears the local input.
 *    - abort button — live (red, clickable) when `phase === 'running'`
 *      (the bridge forwards abort to pi). Clicking while idle / ready
 *      / exited calls `sendAbort()` anyway — bridge handles the
 *      no-op for `exited` (returns command_result{success:true}) and
 *      for `idle` aborts the next pending turn start.
 *    - input disabled while `phase === 'running'` (PRD §4.3: "abort
 *      按钮活态于 phase === 'running'"; the symmetric rule is the
 *      input stays disabled until `agent_settled` brings the agent
 *      back to idle). PRD §4.3 also notes that exited → spawning is
 *      triggered by sending a prompt — we therefore keep the input
 *      editable in `exited` so the user can start a new turn.
 *
 *  Optimistic UI is OFF by design (H decision): we do not flip a
 *  local "submitting" flag after send. The next event / state frame
 *  (session_state.phase change, message_update, etc.) is what the
 *  UI listens to. The clear-on-send here is a convenience for the
 *  user — the UI doesn't change state semantics because of it.
 *
 *  PRD §4.5 ordinary-command failure UX: when a prompt /
 *  steer / follow_up comes back as `command_result{success:false}`
 *  (the WsClient only fires this when the failing envelope id
 *  matches one we sent), show a temporary error banner and DO NOT
 *  retry. The banner auto-hides after 5s and the user can correct
 *  the input manually. */
function InputBar() {
  const client = useWsClient();
  const phase = useSessionPhase();
  const [value, setValue] = useState('');
  // Tracks the most recent agent_settled timestamp so we can show the
  // "agent settled" hint for a few seconds after each turn (PRD §4.3
  // wording: "UI 显示 'agent 已就绪（5 分钟后自动休眠）'"). The
  // session_state broadcast brings phase to `idle` on the same turn
  // end — we treat that as the source of truth.
  const [settledHintVisible, setSettledHintVisible] = useState(false);
  // §4.5 failure banner. We keep the message string in state and use
  // a ref to manage the auto-hide timer so a fast succession of
  // failures resets the 5s window rather than overlapping.
  const [commandError, setCommandError] = useState<string | null>(null);
  const commandErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to pi/event envelopes for the agent_settled hint. We
  // can't put this in a top-level ChatView effect because agent_settled
  // is per-turn and the InputBar owns the hint UI.
  useEffect(() => {
    const unsub = client.on('event', (envelope) => {
      if (envelope.kind !== 'pi' || envelope.type !== 'event') return;
      const payload = envelope.payload;
      if (payload.event === 'agent_settled') {
        setSettledHintVisible(true);
      }
    });
    return unsub;
  }, [client]);

  // Hide the hint once we leave the idle phase (i.e. user sent
  // another prompt). The hint reappears on the next agent_settled.
  useEffect(() => {
    if (phase !== 'idle') {
      setSettledHintVisible(false);
    }
  }, [phase]);

  // §4.5 failure banner subscription. Each failure resets the 5s
  // hide-timer so the message stays visible long enough to be read
  // even if multiple failures arrive in quick succession. We always
  // clear the timer on unmount so a stale hide doesn't fire on a
  // remounted InputBar (the next session's failure will set up its
  // own timer fresh).
  useCommandErrorSubscription(
    useCallback((notice) => {
      const display = `pi 已不再处理该请求（${notice.code}: ${notice.message}），可能是 idle 超时 kill`;
      setCommandError(display);
      if (commandErrorTimerRef.current !== null) {
        clearTimeout(commandErrorTimerRef.current);
      }
      commandErrorTimerRef.current = setTimeout(() => {
        commandErrorTimerRef.current = null;
        setCommandError(null);
      }, 5_000);
    }, []),
  );

  useEffect(() => {
    return () => {
      if (commandErrorTimerRef.current !== null) {
        clearTimeout(commandErrorTimerRef.current);
        commandErrorTimerRef.current = null;
      }
    };
  }, []);

  const inputDisabled = phase === 'running' || phase === 'spawning';
  const abortLive = phase === 'running';

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    setValue(event.target.value);
  };

  /** The shared send path used by both the form's onSubmit and the
   *  input's onKeyDown (S7 review). Extracting it removes the
   *  `event as unknown as FormEvent<...>` cast that the previous
   *  version needed because onKeyDown synthesised a fake form-event
   *  to call onSubmit. Now both call sites just pass a plain string
   *  — no synthetic events, no casts. */
  const submitText = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    client.sendPrompt(trimmed);
    setValue('');
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitText(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter without Shift — submit. Shift+Enter falls through to the
    // default newline behaviour (currently no-op since we render a
    // single-line input, but the rule is documented so a future
    // textarea swap doesn't accidentally lose newlines).
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitText(value);
    }
  };

  const onAbort = () => {
    // Always send — the bridge handles the no-op for `exited` /
    // `idle` (returns command_result{success:true}).
    client.sendAbort();
  };

  return (
    <form className="input-bar" onSubmit={onSubmit} aria-label="Send a prompt">
      <input
        className="input-bar-field"
        type="text"
        placeholder={
          inputDisabled
            ? 'agent is working — abort to take over'
            : phase === 'exited'
              ? 'send a prompt to respawn pi…'
              : 'send a prompt…'
        }
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        disabled={inputDisabled}
        aria-label="Prompt"
        autoComplete="off"
        spellCheck={false}
      />
      <button type="submit" disabled={inputDisabled || value.trim().length === 0}>
        Send
      </button>
      <button
        type="button"
        className={abortLive ? 'abort-button abort-live' : 'abort-button'}
        onClick={onAbort}
        disabled={!abortLive}
        title={
          abortLive
            ? 'Abort the running turn'
            : phase === 'exited'
              ? 'No active turn (bridge will no-op)'
              : 'No active turn'
        }
      >
        Abort
      </button>
      {settledHintVisible && phase === 'idle' ? (
        <p className="input-bar-hint">agent settled — 5 minutes until auto-shutdown</p>
      ) : null}
      {commandError !== null ? (
        <p className="input-bar-error" role="alert">
          {commandError}
        </p>
      ) : null}
    </form>
  );
}
