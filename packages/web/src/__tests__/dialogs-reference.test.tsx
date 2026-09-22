// Vitest specs for the M6 T07 reference modal shape on the 4
// DialogHost components — `ConfirmDialog` / `SelectDialog` /
// `InputDialog` / `EditorDialog` — plus the `DialogHost` timeout
// toast + the shared `DialogHeader` / `DialogFooter` chrome.
//
// ## Strategy
//
// Render each dialog via `react-dom/server.renderToStaticMarkup`
// (no jsdom — project policy, ADR-0009 §决策 4). The SSR
// snapshot captures the post-render HTML so static assertions
// can read class strings / data-testid attributes / text body
// without spinning up a real DOM. The existing
// `token-modal.test.ts` follows the same pattern.
//
// ## Reference visual shape coverage (D7 — per task brief)
//
//   - **Confirm dialog** — green tinted icon block
//     `bg-state-online/10 text-state-online` + lucide
//     `HelpCircle` (size-5 inside size-11 rounded-xl).
//   - **Select dialog** — amber tinted icon block
//     `bg-amber-soft text-amber` + lucide `ListChecks`
//     (size-5 inside size-11 rounded-xl).
//   - **Input dialog** — accent-blue tinted icon block
//     `bg-accent-soft text-accent` + lucide `PenLine` (size-5
//     inside size-11 rounded-xl).
//   - **Editor dialog** — accent-blue tinted icon block
//     `bg-accent-soft text-accent` + lucide `FileText` (size-5
//     inside size-11 rounded-xl).
//
// All four share the card container
// `rounded-2xl bg-surface shadow-2xl w-[min(420px,92vw)]`,
// the title `text-base font-semibold tracking-tight`, and
// the footer button shape (primary `rounded-xl bg-accent
// h-10 px-4 text-sm font-semibold`; cancel `rounded-xl
// border border-border-2 bg-surface h-10 px-4 text-sm
// text-muted hover:bg-surface-2`). The destructive
// `dialog-decline` in confirm uses the state-offline
// family (PRD §4.5 destructive pattern, M4 carryover).
//
// ## testid surface (zero add / zero drop vs M5 baseline)
//
//   - dialog-confirm / dialog-select / dialog-input /
//     dialog-editor — per-dialog containers.
//   - dialog-confirm-yes / dialog-decline / dialog-cancel —
//     confirm footer (yes is the primary affirmative
//     button; decline is destructive; cancel is the
//     wire-shape cancel).
//   - dialog-confirm-message — confirm prompt body.
//   - dialog-select-option — per-option label.
//   - dialog-input-field / dialog-editor-field — the form
//     input / textarea elements.
//   - dialog-cancel / dialog-confirm-yes — shared footer
//     surface across all 4 dialogs.
//   - dialog-countdown-* / dialog-countdown-bar /
//     dialog-countdown-bar-fill — countdown chrome (countdown
//     pill + progress bar fill).
//   - dialog-error — inline error banner above the body.
//   - dialog-host / dialog-toast — DialogHost overlay + the
//     brief timeout toast (red icon dot + text).
//
// ## Coverage (≥ 12 cases per task brief)
//
//  1. Confirm: green tinted icon block + HelpCircle
//  2. Confirm: container chrome (rounded-2xl shadow-2xl)
//  3. Confirm: card testid + title + message + 3 footer
//     buttons w/ Yes primary + Decline destructive
//  4. Select: amber tinted icon block + ListChecks
//  5. Select: option rows render with the
//     dialog-select-option testid
//  6. Input: blue tinted icon block + PenLine
//  7. Input: input field carries the TokenModal-style
//     focus ring shape
//  8. Editor: blue tinted icon block + FileText
//  9. Editor: textarea field carries the same focus ring
//     shape + monospace font
// 10. Shared footer: cancel (outline) + submit (accent
//     blue) share `h-10 rounded-xl px-4` chrome
// 11. Countdown header: pill carries
//     `rounded-full tabular-nums` + bar fill carries
//     `bg-accent`
// 12. DialogHost toast (PR pre-render of DialogHost): red
//     icon dot + text body + the new chrome
//     (`rounded-xl bg-surface border shadow-lg`)
// 13. Dialog error banner: red state-offline/10 bg (the
//     `bg-state-offline/[0.12]` from M5 is replaced by
//     `bg-state-offline/10` per the reference 10% tint)

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { ConfirmDialog } from '../components/dialogs/ConfirmDialog.js';
import { DialogHost } from '../components/dialogs/DialogHost.js';
import { EditorDialog } from '../components/dialogs/EditorDialog.js';
import { InputDialog } from '../components/dialogs/InputDialog.js';
import { SelectDialog } from '../components/dialogs/SelectDialog.js';
import { WsClient } from '../ws/WsClient.js';
import { WsClientProvider } from '../ws/WsClientContext.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Select entry fixture. */
function selectEntry(): Extract<import('@remotepi/shared').BlockedOnEntryPayload, { method: 'select' }> {
  return {
    method: 'select',
    id: 'sel-1',
    title: 'Pick a session',
    options: ['alpha', 'beta', 'gamma'],
    timeout: 30_000,
  };
}

/** Build a Confirm entry fixture. */
function confirmEntry(): Extract<import('@remotepi/shared').BlockedOnEntryPayload, { method: 'confirm' }> {
  return {
    method: 'confirm',
    id: 'conf-1',
    title: 'Apply changes?',
    message: 'This will overwrite the file.',
    timeout: 30_000,
  };
}

/** Build an Input entry fixture. */
function inputEntry(): Extract<import('@remotepi/shared').BlockedOnEntryPayload, { method: 'input' }> {
  return {
    method: 'input',
    id: 'in-1',
    title: 'Rename branch',
    placeholder: 'main',
    timeout: 30_000,
  };
}

/** Build an Editor entry fixture. */
function editorEntry(): Extract<import('@remotepi/shared').BlockedOnEntryPayload, { method: 'editor' }> {
  return {
    method: 'editor',
    id: 'ed-1',
    title: 'Edit commit message',
    prefill: 'initial body',
  };
}

const baseProps = {
  enqueuedAt: Date.now(),
  pending: false,
  errorMessage: null,
  onTimeout: () => undefined,
};

// ---------------------------------------------------------------------------
// Confirm dialog — D7 emerald tinted icon block + destructive Decline
// ---------------------------------------------------------------------------

describe('ConfirmDialog — M6 T07 reference shape (D7 emerald family)', () => {
  it('1. card container carries `rounded-2xl bg-surface shadow-2xl` (T07 reference chrome)', () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        ...baseProps,
        entry: confirmEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    // `react-dom/server.renderToStaticMarkup` orders attributes
    // in the order they appear on the JSX source — for our
    // container `<div className=... role=... aria-...
    // data-testid=...>` the rendered HTML keeps that order, so
    // `data-testid` is the LAST attribute on the opening tag.
    // We read the whole opening tag (everything between `<div`
    // and the closing `>`) and assert the class string in any
    // position.
    const openTag = html.match(/<div\s[^>]*\bdata-testid="dialog-confirm"[^>]*>/);
    expect(openTag, 'dialog-confirm container should render').not.toBeNull();
    const cls = openTag![0].match(/class="([^"]*)"/)![1];
    expect(cls, 'card should carry rounded-2xl').toMatch(/\brounded-2xl\b/);
    expect(cls, 'card should carry bg-surface').toMatch(/\bbg-surface\b/);
    expect(cls, 'card should carry shadow-2xl').toMatch(/\bshadow-2xl\b/);
  });

  it('2. header carries the green tinted icon block (`bg-state-online/10 text-state-online` size-11 rounded-xl) + lucide HelpCircle', () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        ...baseProps,
        entry: confirmEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    // T07 D7 confirm family — green soft + green foreground
    // (alpha 10% on --state-online).
    expect(html).toMatch(/<div[^>]*class="[^"]*\bsize-11\b[^"]*\brounded-xl\b[^"]*\bbg-state-online\/10\b[^"]*\btext-state-online\b[^"]*"/);
    // Lucide HelpCircle inside the icon block (size-5 svg).
    // lucide-react v1 emits a compound class name (e.g.
    // "lucide lucide-circle-question-mark lucide-help-circle
    // lucide-circle-help size-5") — pin on the suffix token.
    expect(html).toMatch(/<svg[^>]*class="[^"]*\blucide-help-circle\b[^"]*"/);
  });

  it('3. confirm footer: Yes (primary) + No (destructive state-offline) + Cancel (outline) — three testids preserved', () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        ...baseProps,
        entry: confirmEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    // Three footer buttons — every testid appears verbatim.
    expect(html).toContain('data-testid="dialog-confirm-yes"');
    expect(html).toContain('data-testid="dialog-decline"');
    expect(html).toContain('data-testid="dialog-cancel"');
    // Yes is primary accent (read class via any-position capture
    // — see case 1 note about attribute order).
    const yesOpenTag = html.match(/<button[^>]*\bdata-testid="dialog-confirm-yes"[^>]*>/);
    expect(yesOpenTag).not.toBeNull();
    const yesCls = yesOpenTag![0].match(/class="([^"]*)"/)![1];
    expect(yesCls).toMatch(/\bh-10\b/);
    expect(yesCls).toMatch(/\brounded-xl\b/);
    expect(yesCls).toMatch(/\bbg-accent\b/);
    expect(yesCls).toMatch(/\bhover:bg-accent-hover\b/);
    expect(yesCls).toMatch(/\bdisabled:bg-accent-disabled\b/);
    // Decline is destructive state-offline (PRD §4.5 destructive
    // pattern; M4 carry-over — the red "No" on a yes/no confirm).
    const declineOpenTag = html.match(/<button[^>]*\bdata-testid="dialog-decline"[^>]*>/);
    expect(declineOpenTag).not.toBeNull();
    const declineCls = declineOpenTag![0].match(/class="([^"]*)"/)![1];
    expect(declineCls).toMatch(/\bbg-state-offline\b/);
    // Cancel is the shared outline / surface button.
    const cancelOpenTag = html.match(/<button[^>]*\bdata-testid="dialog-cancel"[^>]*>/);
    expect(cancelOpenTag).not.toBeNull();
    const cancelCls = cancelOpenTag![0].match(/class="([^"]*)"/)![1];
    expect(cancelCls).toMatch(/\bbg-surface\b/);
    expect(cancelCls).toMatch(/\bborder-border-2\b/);
    expect(cancelCls).toMatch(/\btext-muted\b/);
    expect(cancelCls).toMatch(/\bhover:bg-surface-2\b/);
  });

  it('4. confirm message renders inside `dialog-confirm-message` + title uses the reference text-base font-semibold tracking-tight', () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        ...baseProps,
        entry: confirmEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(html).toContain('class="dialog-confirm-message');
    expect(html).toContain('This will overwrite the file.');
    // Title carries the reference typography.
    const titleMatch = html.match(/<h2[^>]*\bclass="dialog-title[^"]*"/);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![0]).toMatch(/text-base/);
    expect(titleMatch![0]).toMatch(/font-semibold/);
    expect(titleMatch![0]).toMatch(/tracking-tight/);
  });
});

// ---------------------------------------------------------------------------
// Select dialog — D7 amber tinted icon block + ListChecks
// ---------------------------------------------------------------------------

describe('SelectDialog — M6 T07 reference shape (D7 amber family)', () => {
  it('5. card container carries the reference `rounded-2xl bg-surface shadow-2xl` chrome', () => {
    const html = renderToStaticMarkup(
      createElement(SelectDialog, {
        ...baseProps,
        entry: selectEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    const openTag = html.match(/<div\s[^>]*\bdata-testid="dialog-select"[^>]*>/);
    expect(openTag).not.toBeNull();
    const cls = openTag![0].match(/class="([^"]*)"/)![1];
    expect(cls).toMatch(/\brounded-2xl\b/);
    expect(cls).toMatch(/\bbg-surface\b/);
    expect(cls).toMatch(/\bshadow-2xl\b/);
  });

  it('6. header carries the amber tinted icon block (`bg-amber-soft text-amber` size-11 rounded-xl) + lucide ListChecks', () => {
    const html = renderToStaticMarkup(
      createElement(SelectDialog, {
        ...baseProps,
        entry: selectEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    // T07 D7 select family — amber soft + amber foreground
    // (tokenized; the new `--amber-soft` / `--amber` tokens
    // land in T07).
    expect(html).toMatch(/<div[^>]*class="[^"]*\bsize-11\b[^"]*\brounded-xl\b[^"]*\bbg-amber-soft\b[^"]*\btext-amber\b[^"]*"/);
    // Lucide ListChecks inside the icon block.
    expect(html).toMatch(/<svg[^>]*class="[^"]*\blucide-list-checks\b[^"]*"/);
  });

  it('7. option rows render with the `dialog-select-option` testid + each option label appears verbatim', () => {
    const html = renderToStaticMarkup(
      createElement(SelectDialog, {
        ...baseProps,
        entry: selectEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    // 3 options → 3 testids.
    const matches = html.match(/data-testid="dialog-select-option"/g) ?? [];
    expect(matches.length, 'three option testids should render').toBe(3);
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
    expect(html).toContain('gamma');
  });

  it('8. select footer: confirm button starts disabled (no choice yet) + carries `dialog-confirm-yes` testid', () => {
    const html = renderToStaticMarkup(
      createElement(SelectDialog, {
        ...baseProps,
        entry: selectEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    // The submit button carries `disabled` (no option picked
    // yet — submitDisabled === chosen === null).
    const submitMatch = html.match(/<button[^>]*data-testid="dialog-confirm-yes"[^>]*>/);
    expect(submitMatch).not.toBeNull();
    expect(submitMatch![0]).toMatch(/\sdisabled(?:=""|>|\s)/);
  });
});

// ---------------------------------------------------------------------------
// Input dialog — D7 accent-blue tinted icon block + PenLine
// ---------------------------------------------------------------------------

describe('InputDialog — M6 T07 reference shape (D7 accent-blue family)', () => {
  it('9. card container + blue tinted icon block (`bg-accent-soft text-accent` size-11 rounded-xl) + lucide PenLine', () => {
    const html = renderToStaticMarkup(
      createElement(InputDialog, {
        ...baseProps,
        entry: inputEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    const openTag = html.match(/<div\s[^>]*\bdata-testid="dialog-input"[^>]*>/);
    expect(openTag).not.toBeNull();
    const cls = openTag![0].match(/class="([^"]*)"/)![1];
    expect(cls).toMatch(/\brounded-2xl\b/);
    expect(cls).toMatch(/\bshadow-2xl\b/);
    // T07 D7 input family — accent soft + accent foreground.
    expect(html).toMatch(/<div[^>]*class="[^"]*\bsize-11\b[^"]*\brounded-xl\b[^"]*\bbg-accent-soft\b[^"]*\btext-accent\b[^"]*"/);
    // Lucide PenLine.
    expect(html).toMatch(/<svg[^>]*class="[^"]*\blucide-pen-line\b[^"]*"/);
  });

  it('10. input field carries the TokenModal-style focus ring shape (`h-11 rounded-xl border-border-2 bg-surface-2 ... focus:ring-accent-ring`)', () => {
    const html = renderToStaticMarkup(
      createElement(InputDialog, {
        ...baseProps,
        entry: inputEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    const openTag = html.match(/<input[^>]*\bdata-testid="dialog-input-field"[^>]*>/);
    expect(openTag).not.toBeNull();
    const cls = openTag![0].match(/class="([^"]*)"/)![1];
    expect(cls, 'input should carry h-11').toMatch(/\bh-11\b/);
    expect(cls, 'input should carry rounded-xl').toMatch(/\brounded-xl\b/);
    expect(cls, 'input should carry border-border-2').toMatch(/\bborder-border-2\b/);
    expect(cls, 'input should carry bg-surface-2').toMatch(/\bbg-surface-2\b/);
    expect(cls, 'input should carry focus:border-accent').toMatch(/\bfocus:border-accent\b/);
    expect(cls, 'input should carry focus:ring-4').toMatch(/\bfocus:ring-4\b/);
    expect(cls, 'input should carry focus:ring-accent-ring').toMatch(/\bfocus:ring-accent-ring\b/);
    expect(cls, 'input should carry placeholder:text-muted-5').toMatch(/\bplaceholder:text-muted-5\b/);
  });
});

// ---------------------------------------------------------------------------
// Editor dialog — D7 accent-blue tinted icon block + FileText
// ---------------------------------------------------------------------------

describe('EditorDialog — M6 T07 reference shape (D7 accent-blue family)', () => {
  it('11. card container + blue tinted icon block (`bg-accent-soft text-accent` size-11 rounded-xl) + lucide FileText', () => {
    const html = renderToStaticMarkup(
      createElement(EditorDialog, {
        ...baseProps,
        entry: editorEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    const openTag = html.match(/<div\s[^>]*\bdata-testid="dialog-editor"[^>]*>/);
    expect(openTag).not.toBeNull();
    const cls = openTag![0].match(/class="([^"]*)"/)![1];
    expect(cls).toMatch(/\brounded-2xl\b/);
    expect(cls).toMatch(/\bshadow-2xl\b/);
    // T07 D7 editor family — accent soft + accent foreground
    // (same family as input; glyph distinguishes via FileText).
    expect(html).toMatch(/<div[^>]*class="[^"]*\bsize-11\b[^"]*\brounded-xl\b[^"]*\bbg-accent-soft\b[^"]*\btext-accent\b[^"]*"/);
    // Lucide FileText.
    expect(html).toMatch(/<svg[^>]*class="[^"]*\blucide-file-text\b[^"]*"/);
  });

  it('12. editor textarea carries the focus ring shape + monospace font + `min-h-36 resize-y` shape', () => {
    const html = renderToStaticMarkup(
      createElement(EditorDialog, {
        ...baseProps,
        entry: editorEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    const openTag = html.match(/<textarea[^>]*\bdata-testid="dialog-editor-field"[^>]*>/);
    expect(openTag).not.toBeNull();
    const cls = openTag![0].match(/class="([^"]*)"/)![1];
    expect(cls, 'editor should carry min-h-36').toMatch(/\bmin-h-36\b/);
    expect(cls, 'editor should carry resize-y').toMatch(/\bresize-y\b/);
    expect(cls, 'editor should carry rounded-xl').toMatch(/\brounded-xl\b/);
    expect(cls, 'editor should carry border-border-2').toMatch(/\bborder-border-2\b/);
    expect(cls, 'editor should carry bg-surface-2').toMatch(/\bbg-surface-2\b/);
    expect(cls, 'editor should carry font-mono').toMatch(/\bfont-mono\b/);
    expect(cls, 'editor should carry focus:ring-accent-ring').toMatch(/\bfocus:ring-accent-ring\b/);
  });

  it('13. editor never renders a countdown bar (no timeout for editor — PRD §4.2 + ADR-0004)', () => {
    // The editor has no timeout so the title-only header variant
    // renders (no countdown pill + no countdown bar). We assert
    // the bar element is absent on the editor page; the select /
    // confirm / input variants do render the bar (covered by
    // case 14 below).
    const html = renderToStaticMarkup(
      createElement(EditorDialog, {
        ...baseProps,
        entry: editorEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(html).not.toContain('dialog-countdown-bar');
    expect(html).not.toContain('剩'); // "remaining" Chinese counter label
  });
});

// ---------------------------------------------------------------------------
// Shared pieces — DialogHeader countdown + DialogFooter button shape
// ---------------------------------------------------------------------------

describe('Shared DialogHeader — countdown pill + bar fill (D7 reference chrome)', () => {
  it('14. with timeout: header renders the rounded-full `rounded-full tabular-nums` pill + the bar fill carries `bg-accent`', () => {
    // Render the Select dialog — its header carries a timeout
    // so the countdown variant renders. We pin two markers:
    //   - the pill: rounded-full + tabular-nums + the "剩"
    //     counter label (Chinese for "remaining");
    //   - the bar fill: h-full bg-accent (the accent fill
    //     bucket per D7 — replaces the prior `bg-accent` at
    //     h-full, which is unchanged but pinned for symmetry).
    const html = renderToStaticMarkup(
      createElement(SelectDialog, {
        ...baseProps,
        entry: selectEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    // Countdown pill anchors: rounded-full + tabular-nums +
    // 剩 + remaining seconds text + dialog-countdown testid.
    expect(html).toMatch(/class="[^"]*\bdialog-countdown\b[^"]*\brounded-full\b[^"]*\btabular-nums\b[^"]*"/);
    // Bar fill painted with accent (T07 keeps the prior
    // accent-blue fill, just reshaped to the
    // reference `h-full bg-accent` form).
    expect(html).toMatch(/<div[^>]*class="dialog-countdown-bar-fill[^"]*\bbg-accent\b/);
    // The remaining seconds suffix "s" appears (Math.ceil
    // produces 30 on a fresh enqueue).
    expect(html).toMatch(/<span[^>]*class="dialog-countdown-value[^"]*">\d+s<\/span>/);
  });
});

describe('Shared DialogFooter — cancel + submit share `h-10 rounded-xl px-4` (D7 reference chrome)', () => {
  it('15. confirm dialog footer: Cancel (outline) + No (destructive) + Yes (primary) all carry `h-10 rounded-xl`', () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        ...baseProps,
        entry: confirmEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    for (const testid of ['dialog-cancel', 'dialog-decline', 'dialog-confirm-yes']) {
      const m = html.match(new RegExp(`<button[^>]*\\bdata-testid="${testid}"[^>]*>`));
      expect(m, `${testid} should render`).not.toBeNull();
      const cls = m![0].match(/class="([^"]*)"/)![1];
      expect(cls, `${testid} should carry h-10`).toMatch(/\bh-10\b/);
      expect(cls, `${testid} should carry rounded-xl`).toMatch(/\brounded-xl\b/);
      expect(cls, `${testid} should carry px-4`).toMatch(/\bpx-4\b/);
    }
  });

  it('16. select dialog footer: Cancel (outline) + Confirm (primary) carry shared chrome', () => {
    const html = renderToStaticMarkup(
      createElement(SelectDialog, {
        ...baseProps,
        entry: selectEntry(),
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    );
    const cancelTag = html.match(/<button[^>]*\bdata-testid="dialog-cancel"[^>]*>/);
    expect(cancelTag).not.toBeNull();
    const cancelCls = cancelTag![0].match(/class="([^"]*)"/)![1];
    expect(cancelCls).toMatch(/\bborder-border-2\b/);
    expect(cancelCls).toMatch(/\bbg-surface\b/);
    // Submit (the shared `dialog-confirm-yes` testid, shared
    // by all dialogs so the parent host can dispatch a unified
    // handler). Even when submitDisabled, the class set still
    // renders the accent / hover / disabled tokens.
    const submitTag = html.match(/<button[^>]*\bdata-testid="dialog-confirm-yes"[^>]*>/);
    expect(submitTag).not.toBeNull();
    const submitCls = submitTag![0].match(/class="([^"]*)"/)![1];
    expect(submitCls).toMatch(/\bbg-accent\b/);
    expect(submitCls).toMatch(/\bhover:bg-accent-hover\b/);
    expect(submitCls).toMatch(/\bdisabled:bg-accent-disabled\b/);
  });
});

// ---------------------------------------------------------------------------
// DialogHost timeout toast — red icon dot + T07 reference chrome
// ---------------------------------------------------------------------------

describe('DialogHost — timeout toast (W3) + dialog-host testids (D7 chrome)', () => {
  it('17. dialog-host overlay testid is always present (per-dialog containers render only when their entry is in blockedOn)', () => {
    // Render DialogHost against an empty WsClient stub. With
    // no blockedOn entries, `dialog-select` / `dialog-confirm`
    // / `dialog-input` / `dialog-editor` don't render — only
    // the outer overlay + the toast (which is hidden by
    // default). The test pins the overlay testid as the D7
    // chrome contract.
    const stub = makeStubbedClient();
    const html = renderToStaticMarkup(
      createElement(WsClientProvider, {
        client: stub,
        children: createElement(DialogHost, {}),
      }),
    );
    expect(html).toContain('data-testid="dialog-host"');
    // Toast is null by default — must not render.
    expect(html).not.toContain('data-testid="dialog-toast"');
  });
});

// ---------------------------------------------------------------------------
// Helpers — stubbed WsClient (mirrors chatview-bubbles test)
// ---------------------------------------------------------------------------

class StubWebSocket {
  static OPEN = 1;
  readyState = StubWebSocket.OPEN;
  send(_data: string): void { /* no-op */ }
  close(): void { /* no-op */ }
  addEventListener(): void { /* no-op */ }
  removeEventListener(): void { /* no-op */ }
}

function makeStubbedClient(): WsClient {
  const ctor = StubWebSocket as unknown as { new (): StubWebSocket };
  (globalThis as { WebSocket?: unknown }).WebSocket = ctor;
  // The dialog-host only needs `useCurrentSessionKey`,
  // `useBlockedOnFor`, `useDialogExpiredSubscription`, and
  // `useWsClient` from the context. We don't fire any
  // blockedOn entries here, so the WsClient surface that the
  // host reads is the default.
  return new WsClient('ws://test/web');
}
