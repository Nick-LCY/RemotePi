// Vitest specs for the M6 T05 bubble layout in
// `ChatView.tsx` — AI-row avatar + name + bubble + user-row
// right-aligned blue bubble + draft dashed border + InputBar
// reference chrome (single-focus-indicator shell + deep-slate
// send button + red abort button + bottom helper row).
//
// ## Strategy
//
// The ChatView subtree uses the WsClient context for per-session
// reads (`useMessagesFor`, `useStreamingDraftFor`,
// `useSessionPhaseFor`, `useCommandErrorSubscription`). We
// render via `renderToStaticMarkup` against a stubbed
// `globalThis.WebSocket` (so `new WsClient(...)` doesn't open a
// real socket). The WsClient's `useSyncExternalStore` server
// snapshot reads from the same client instance, so static
// markup sees the messages we push into the per-session bucket
// directly via the public `bucketFor(sessionKey).messages`
// array (mutations are reflected on the next render because
// the store re-emits).
//
// The InputBar lives inside the same ChatView subtree, so
// static markup of `<ChatView session={...} workDir="" />`
// exercises both the MessageList bubble layout AND the
// InputBar chrome — a single render covers everything.
//
// The `AssistantMessageBody` component (used for terminal
// markdown rendering) is `React.lazy`-loaded with a
// `<Suspense fallback={<span/>}>`. In static markup the
// unresolved lazy renders the empty span fallback, so the
// inline-code paint (M6 T05 reference inline-code look) is
// pinned in `assistant-message-body.test.tsx` instead — see the
// test 1.6 + 1.6b there.
//
// ## Coverage (cases per task 05 spec)
//
//   1.1 AI row carries avatar block + Zap icon + name row +
//       bubble chrome (D11)
//   1.2 AI bubble carries `message-body` class +
//       `data-testid="message-body"` (D6 / e2e contract)
//   2.1 User row is `flex justify-end` + `max-w-[80%]` + accent
//       blue bubble + white text
//   3.1 `<li>` shell preserves `message-row` + `message-role-*`
//       class tokens verbatim (D6 / e2e 02 contract)
//   3.2 `<li>` carries `data-testid="message-row"` (terminal) or
//       `data-testid="message-draft"` (in-flight stream) — testid
//       surface zero-add-zero-remove (D6)
//   4.1 Draft bubble carries the `border-dashed opacity-85`
//       expression + `message-draft` class on the `<li>`
//   6.1 InputBar outer shell carries the reference chrome
//       (rounded-2xl border shadow-card focus-within:ring-4)
//       with `input-field` / `input-send` / `input-abort` testid
//       anchors (D6 / R4 single-focus-indicator)
//   6.2 textarea carries `outline-none` (R4 — single focus
//       indicator on outer shell); negative pin: NO legacy
//       `outline-2` outline class on the textarea
//   6.3 send button is size-8 rounded-xl bg-deep + Send icon;
//       abort button is size-8 rounded-xl + Square icon (red
//       when live, accent-disabled when idle)
//   6.4 bottom helper row carries the
//       `Enter 发送 · Shift + Enter 换行` text + the security
//       helper below the shell carries `ShieldCheck`

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect as expectFn, it } from 'vitest';

import { ChatView } from '../components/ChatView.js';
import { WsClient } from '../ws/WsClient.js';
import { WsClientProvider } from '../ws/WsClientContext.js';

// ---------------------------------------------------------------------------
// Test helpers — stub the WsClient.
// ---------------------------------------------------------------------------

class StubWebSocket {
  static OPEN = 1;
  readyState = StubWebSocket.OPEN;
  send(_data: string): void {
    /* no-op */
  }
  close(): void {
    /* no-op */
  }
  addEventListener(): void {
    /* no-op */
  }
  removeEventListener(): void {
    /* no-op */
  }
}

let wsStub: StubWebSocket | null = null;

function makeFakeWsClient(): WsClient {
  wsStub = new StubWebSocket();
  function StubWebSocketCtor(this: unknown): StubWebSocket {
    return wsStub!;
  }
  StubWebSocketCtor.OPEN = StubWebSocket.OPEN;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = StubWebSocketCtor;
  return new WsClient('ws://test/web');
}

/** Render `<ChatView>` with a fresh stub WsClient. */
function renderChatView(session: string): string {
  const client = makeFakeWsClient();
  return renderToStaticMarkup(
    createElement(
      WsClientProvider,
      { client, children: createElement(ChatView, { session, workDir: '' }) },
    ),
  );
}

/** Render `<ChatView>` with a pre-seeded WsClient (so the
 *  caller can push messages into the bucket before the
 *  snapshot reads them via `useSyncExternalStore`). */
function renderChatViewWithClient(client: WsClient, session: string): string {
  return renderToStaticMarkup(
    createElement(
      WsClientProvider,
      { client, children: createElement(ChatView, { session, workDir: '' }) },
    ),
  );
}

beforeEach(() => {
  wsStub = null;
});

afterEach(() => {
  delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  wsStub = null;
});

// Alias `expect` for vitest clarity.
const expect = expectFn;

// ---------------------------------------------------------------------------
// AI bubble layout
// ---------------------------------------------------------------------------

describe('ChatView — AI bubble layout (D11)', () => {
  it('1.1 AI row carries avatar block + Zap icon + name row + bubble chrome', () => {
    const client = makeFakeWsClient();
    client.bucketFor('s1').messages.push({ role: 'assistant', content: 'hi from agent' });
    const html = renderChatViewWithClient(client, 's1');
    // Avatar block — `flex size-8 shrink-0 items-center
    // justify-center rounded-lg bg-deep text-white`. We assert
    // on a contiguous class string on a single element (the
    // avatar wrapper); the test won't be fooled by individual
    // tokens that may appear on unrelated elements.
    expect(html).toMatch(/class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-deep text-white"/);
    // Zap lucide icon — lucide renders an `<svg>` with the
    // `lucide-zap` class on the inner shape.
    expect(html).toMatch(/<svg[^>]*lucide-zap/);
    // Name row — `RemotePi` + `text-xs font-semibold text-text`.
    expect(html).toContain('RemotePi');
    // Bubble chrome — `rounded-2xl rounded-tl-sm bg-surface-2
    // px-4 py-3 text-sm leading-6 text-muted-2`.
    expect(html).toMatch(/class="rounded-2xl rounded-tl-sm bg-surface-2 px-4 py-3 text-sm leading-6 text-muted-2 message-body/);
    // The body text lands inside `.message-body`.
    expect(html).toContain('hi from agent');
    expect(html).toMatch(/<div[^>]*message-body[^>]*data-testid="message-body"[^>]*>[^<]*<span>hi from agent<\/span>/);
  });

  it('1.2 AI bubble carries `data-testid="message-body"` + `message-body` class (D6)', () => {
    const client = makeFakeWsClient();
    client.bucketFor('s1').messages.push({ role: 'assistant', content: 'x' });
    const html = renderChatViewWithClient(client, 's1');
    // message-body class + data-testid on the bubble.
    const bubbleClassMatch = html.match(/<div[^>]*\bmessage-body\b[^>]*data-testid="message-body"[^>]*>/);
    expect(bubbleClassMatch).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// User bubble layout
// ---------------------------------------------------------------------------

describe('ChatView — user bubble layout (D11)', () => {
  it('2.1 user row uses flex justify-end + max-w-[80%] + accent blue bubble + white text', () => {
    const client = makeFakeWsClient();
    client.bucketFor('s1').messages.push({ role: 'user', content: 'hello agent' });
    const html = renderChatViewWithClient(client, 's1');
    // Outer `<li>` for the user row uses `flex justify-end`.
    // The class tokens land on the same element as
    // `message-row message-role-user`.
    expect(html).toMatch(/<li[^>]*\bmessage-row\b[^"]*\bmessage-role-user\b[^>]*flex justify-end[^>]*data-testid="message-row"/);
    // max-w-[80%] + accent + white text + rounded-tr-sm on the
    // bubble. The bubble class set lives on a descendant of
    // the user `<li>` — we assert on the substring presence
    // (the exact order matches the emitted class string).
    expect(html).toMatch(/class="max-w-\[80%\] rounded-2xl rounded-tr-sm bg-accent px-4 py-3 text-sm leading-6 text-white message-body/);
    // The body text appears inside the bubble.
    expect(html).toContain('hello agent');
  });
});

// ---------------------------------------------------------------------------
// Contract — `message-row` + `message-role-*` + testid surface
// ---------------------------------------------------------------------------

describe('ChatView — contract pins (D6 / e2e 01 / 02)', () => {
  it('3.1 `<li>` shell preserves the `message-row` + `message-role-{role}` class tokens verbatim', () => {
    // D6 — e2e 02 uses
    // `classList.find((c) => c.startsWith('message-role-'))`
    // to find the role token; it relies on the token being a
    // STANDALONE classList entry. The regex below asserts the
    // token pair appears as discrete entries.
    const client = makeFakeWsClient();
    client.bucketFor('s1').messages.push(
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    );
    const html = renderChatViewWithClient(client, 's1');
    // User row.
    expect(html).toMatch(/<li[^>]*\bmessage-row\b[^>]*\bmessage-role-user\b/);
    // Assistant row.
    expect(html).toMatch(/<li[^>]*\bmessage-row\b[^>]*\bmessage-role-assistant\b/);
  });

  it('3.2 `<li>` carries `data-testid="message-row"` for terminal messages and `data-testid="message-draft"` for in-flight streams', () => {
    // D6 — testid anchor zero-add-zero-remove. Terminal rows
    // (history) get `message-row`; in-flight streams get
    // `message-draft`. The spec uses the same selector for
    // both to count rows + read the body.
    const client = makeFakeWsClient();
    client.bucketFor('s1').messages.push({ role: 'user', content: 'p' });
    client.bucketFor('s1').streamingDraft = {
      messageId: 'draft-1',
      role: 'assistant',
      segments: [{ type: 'text', text: 'partial' }],
    };
    const html = renderChatViewWithClient(client, 's1');
    // Terminal user row.
    expect(html).toContain('data-testid="message-row"');
    // In-flight draft row.
    expect(html).toContain('data-testid="message-draft"');
  });
});

// ---------------------------------------------------------------------------
// Draft styling
// ---------------------------------------------------------------------------

describe('ChatView — draft styling', () => {
  it('4.1 draft row carries the `border-dashed opacity-85` expression + `message-draft` class on the `<li>`', () => {
    // The task spec keeps the existing draft visual expression
    // (dashed border + 85% opacity) on the bubble div (the
    // `<li>` no longer carries a border, so the dashed chrome
    // moves to the bubble itself). The `message-draft` class
    // stays on the `<li>` so the e2e `classList` filter can
    // still distinguish drafts from terminal rows.
    const client = makeFakeWsClient();
    client.bucketFor('s1').streamingDraft = {
      messageId: 'draft-2',
      role: 'assistant',
      segments: [{ type: 'text', text: 'live' }],
    };
    const html = renderChatViewWithClient(client, 's1');
    // message-draft on the `<li>` (the AI bubble variant —
    // `message-row message-role-assistant flex items-start gap-3`).
    expect(html).toMatch(/<li[^>]*\bmessage-row\b[^>]*\bmessage-role-assistant\b[^>]*\bmessage-draft\b/);
    // border-dashed + opacity-85 + the bubble base classes
    // land on the bubble div (descendant of the `<li>`).
    expect(html).toMatch(/<div[^>]*\bborder-dashed\b[^>]*\bopacity-85\b/);
    // The streaming draft text appears inside the draft bubble.
    expect(html).toContain('live');
  });
});

// ---------------------------------------------------------------------------
// InputBar reference chrome (focus-within single indicator)
// ---------------------------------------------------------------------------

describe('ChatView — InputBar reference chrome (R4 single-focus-indicator)', () => {
  it('6.1 InputBar outer shell carries rounded-2xl + border-2 + shadow-card + focus-within ring + accent border', () => {
    const html = renderChatView('s1');
    // The reference shell — `rounded-2xl` + `border-border-2`
    // + `bg-surface` + `p-2` + `shadow-[var(--shadow-card)]` +
    // `focus-within:border-accent` + `focus-within:ring-4` +
    // `focus-within:ring-accent-ring` — all on the form
    // carrying the `input-bar` class.
    expect(html).toMatch(/<form[^>]*\binput-bar\b[^>]*\brounded-2xl\b[^>]*\bborder-border-2\b[^>]*\bbg-surface\b[^>]*p-2\b[^>]*shadow-\[var\(--shadow-card\)\][^>]*focus-within:border-accent\b[^>]*focus-within:ring-4\b[^>]*focus-within:ring-accent-ring\b/);
  });

  it('6.2 textarea carries `outline-none` (R4 — single focus indicator on outer shell)', () => {
    const html = renderChatView('s1');
    // Extract the textarea opening tag by anchoring on
    // `input-field` testid (the JSX-emitted attribute order
    // varies — we read the class string directly rather than
    // pattern-matching on attribute order).
    const textareaTagMatch = html.match(/<textarea\b[^>]*data-testid="input-field"[^>]*>/);
    expect(textareaTagMatch).not.toBeNull();
    const textareaTag = textareaTagMatch![0];
    expect(textareaTag).toContain('input-bar-field');
    expect(textareaTag).toContain('outline-none');
    // Negative pin — the legacy `outline-2` outline class must
    // NOT be on the textarea. A regression that re-added the
    // 2px outline would re-introduce the double focus
    // indicator R4 explicitly forbids.
    expect(textareaTag).not.toContain('outline-2');
  });

  it('6.3 send button is size-8 rounded-xl bg-deep + Send icon; abort button is size-8 rounded-xl + Square icon (red when live, accent-disabled when idle)', () => {
    const html = renderChatView('s1');
    // Reference send button class set.
    expect(html).toMatch(/<button[^>]*data-testid="input-send"[^>]*class="flex size-8 items-center justify-center rounded-xl bg-deep text-white transition hover:bg-deep-hover disabled:cursor-not-allowed disabled:opacity-30"/);
    // Send icon present (lucide `Send`).
    expect(html).toMatch(/<svg[^>]*lucide-send/);
    // Abort button — same shape (size-8 rounded-xl). The red
    // paint flips between `bg-state-offline` (live) and
    // `bg-accent-disabled` (idle); in static markup with no
    // active session, phase is null → abortLive=false → the
    // disabled token wins. We accept both as long as the
    // testid + shape tokens land.
    const abortMatch = html.match(/<button[^>]*data-testid="input-abort"[^>]*class="([^"]*)"/);
    expect(abortMatch).not.toBeNull();
    const abortTag: string = abortMatch?.[1] ?? '';
    expect(abortTag).toContain('size-8');
    expect(abortTag).toContain('rounded-xl');
    // Either red (live) or accent-disabled (idle) — both are
    // correct, both pass the visual contract.
    expect(abortTag.includes('bg-state-offline') || abortTag.includes('bg-accent-disabled')).toBe(true);
    // Square icon present.
    expect(html).toMatch(/<svg[^>]*lucide-square/);
  });

  it('6.4 bottom helper row carries the `Enter 发送 · Shift + Enter 换行` text + the security helper below the shell carries `ShieldCheck`', () => {
    // Reference's helper row inside the shell carries the
    // Enter / Shift+Enter hint at `text-[10px] text-muted-5`.
    // The security helper below the shell carries
    // `ShieldCheck` + the "消息通过已配对的安全连接发送"
    // caption.
    const html = renderChatView('s1');
    expect(html).toContain('Enter 发送');
    expect(html).toContain('Shift + Enter 换行');
    expect(html).toContain('消息通过已配对的安全连接发送');
    expect(html).toMatch(/<svg[^>]*lucide-shield-check/);
  });
});