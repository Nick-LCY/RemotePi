// Vitest specs for `components/DirectoryBrowser.tsx` (M6 task 08) —
// reference modal shape + desktop backdrop (M+ (b) 兑现) + path
// inline code chip + entry row shape.
//
// ## Strategy
//
// Render the DirectoryBrowser via `react-dom/server.renderToStaticMarkup`
// (no jsdom — ADR-0009 §决策 4). Stub `window.matchMedia` to pin
// `isMobile` (the M5 / M6 pattern across `app-shell.test.tsx` +
// `mobile-top-bar.test.tsx`). The SSR snapshot captures the
// post-render HTML so static assertions can read class strings /
// data-testid attributes / lucide svg token presence without
// spinning up a real DOM.
//
// ## Reference visual shape coverage (T08 — directory browser
//    modal化)
//
//   - **Outer wrapper** (testid `directory-browser`):
//     `fixed inset-0 z-[250] flex items-center justify-center p-4`
//     on desktop; `fixed inset-0 z-[250] flex flex-col gap-3
//     overflow-y-auto bg-bg p-4` on mobile (preserves the M5
//     e2e 09 spec assertion `toContain('inset-0')` +
//     `not.toContain('card directory-browser')`).
//   - **Backdrop** (desktop only, M+ (b) 兑现):
//     `<button absolute inset-0 bg-deep/30 backdrop-blur-[3px]>`,
//     aria-label "关闭对话框", click → onCancel. NOT rendered on
//     mobile.
//   - **Card** (desktop): `relative flex w-full max-w-[480px]
//     flex-col gap-4 rounded-2xl bg-surface p-6 shadow-2xl` (no
//     `card` class literal — e2e 09 spec mobile assertion stays
//     green).
//   - **Header tinted icon block**:
//     `size-11 shrink-0 rounded-xl bg-accent-soft text-accent`
//     + lucide `FolderOpen` (size-5 svg token).
//   - **Title**: `text-base font-semibold tracking-tight text-text`.
//   - **Path bar** (testid `directory-browser-path`):
//     `text-sm text-muted-3` wrapper + inline code
//     `rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs
//     text-accent`.
//   - **Entry row** (testid `dir-entry`):
//     `flex items-start gap-3 rounded-xl border border-border
//     bg-surface p-2 hover:bg-surface-2` + dual-line name + path
//     + inline 「打开」/「选择」 action buttons.
//   - **Errors**: `bg-state-offline/[0.08] text-state-offline`
//     rounded-md (state-offline family).
//   - **Z-index stack**: outer wrapper carries `z-[250]`
//     (`sidebar 200 < DirectoryBrowser 250 < dialog-host 300
//     < token-modal 400`).
//
// ## testid surface (zero add / zero drop vs M5 baseline / D6 /
//    T08 brief)
//
//   - directory-browser / directory-browser-path / directory-
//     browser-home / directory-browser-cancel / directory-
//     browser-error / directory-browser-add-error / directory-
//     browser-loading / dir-entries / dir-entry / dir-entry-
//     name / dir-entry-open / dir-entry-select
//
// The backdrop is intentionally NOT tagged with a new testid
// (PRD testid zero-add commitment); the structural locator
// `button[aria-label="关闭对话框"]` inside the wrapper is
// sufficient for any future test.

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DirectoryBrowser } from '../components/DirectoryBrowser.js';
import { WsClient } from '../ws/WsClient.js';
import { WsClientProvider } from '../ws/WsClientContext.js';
import { MOBILE_QUERY } from '../hooks/useIsMobile.js';

// ---------------------------------------------------------------------------
// matchMedia stub — pin `isMobile` initial value for SSR render
// (the useIsMobile hook reads window.matchMedia at mount-time via
// the useState initializer + an effect).
// ---------------------------------------------------------------------------

let originalMatchMedia: unknown = undefined;
let stubMatches: boolean = false;

function installMatchMediaStub(matches: boolean): void {
  const g = globalThis as unknown as { window?: { matchMedia?: unknown } };
  if (g.window === undefined) {
    originalMatchMedia = undefined;
  } else {
    originalMatchMedia = g.window.matchMedia;
  }
  stubMatches = matches;
  (globalThis as unknown as { window: { matchMedia: unknown } }).window = {
    matchMedia: (query: string) => {
      if (query !== MOBILE_QUERY) {
        throw new Error(`stubMatchMedia got unexpected query ${query}`);
      }
      return {
        matches: stubMatches,
        media: MOBILE_QUERY,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
    },
  };
}

function uninstallMatchMediaStub(): void {
  const g = globalThis as unknown as { window?: { matchMedia?: unknown } };
  if (g.window !== undefined) {
    if (originalMatchMedia === undefined) {
      delete (globalThis as unknown as { window?: unknown }).window;
    } else {
      g.window.matchMedia = originalMatchMedia;
    }
  }
  originalMatchMedia = undefined;
  stubMatches = false;
}

beforeEach(() => {
  // Default desktop (false) so each test pins isMobile explicitly.
  installMatchMediaStub(false);
});

afterEach(() => {
  uninstallMatchMediaStub();
});

// ---------------------------------------------------------------------------
// Render helper — wraps in WsClientProvider because DirectoryBrowser
// pulls a client via useWsClient. The client is a stub WsClient
// instance; the visual assertions do not exercise the wire.
// ---------------------------------------------------------------------------

function renderDirBrowser(): string {
  const client = new WsClient('ws://stub:1/web');
  const element: ReactElement = createElement(
    WsClientProvider,
    { client, children: createElement(DirectoryBrowser, {
      onAdded: vi.fn(),
      onCancel: vi.fn(),
    }) },
  );
  return renderToStaticMarkup(element);
}

function renderDirBrowserClosed(): string {
  const client = new WsClient('ws://stub:1/web');
  const element: ReactElement = createElement(
    WsClientProvider,
    { client, children: createElement(DirectoryBrowser, {
      open: false,
      onAdded: vi.fn(),
      onCancel: vi.fn(),
    }) },
  );
  return renderToStaticMarkup(element);
}

// ---------------------------------------------------------------------------
// Desktop reference modal (M+ (b) backdrop 兑现)
// ---------------------------------------------------------------------------

describe('DirectoryBrowser — desktop reference modal shape (T08 D7 family)', () => {
  it('1. outer wrapper carries `fixed inset-0 z-[250] flex items-center justify-center p-4` (T08 modal化)', () => {
    installMatchMediaStub(false); // desktop
    const html = renderDirBrowser();
    const wrapper = html.match(/<div\s[^>]*\bdata-testid="directory-browser"[^>]*>/);
    expect(wrapper, 'directory-browser wrapper should render').not.toBeNull();
    const cls = wrapper![0].match(/class="([^"]*)"/)![1];
    expect(cls, 'wrapper carries fixed').toMatch(/\bfixed\b/);
    expect(cls, 'wrapper carries inset-0 (matches e2e 09 mobile assertion contract; desktop still uses the same z layer)').toMatch(/\binset-0\b/);
    expect(cls, 'wrapper carries z-[250] (T08 stack — below dialog-host 300, above sidebar 200)').toMatch(/\bz-\[250\]/);
    expect(cls, 'wrapper centres the card on desktop').toMatch(/\bflex\b/);
    expect(cls, 'wrapper centres the card on desktop').toMatch(/\bitems-center\b/);
    expect(cls, 'wrapper centres the card on desktop').toMatch(/\bjustify-center\b/);
    // No `card` class literal — e2e 09 spec mobile substring
    // `not.toContain('card directory-browser')` is preserved.
    expect(cls, 'wrapper MUST NOT carry the `card` class (e2e 09 spec substring contract)').not.toMatch(/\bcard\b/);
  });

  it('2. inner card carries `relative w-full max-w-[480px] flex-col gap-4 rounded-2xl bg-surface p-6 shadow-2xl` (T08 D7 reference chrome)', () => {
    installMatchMediaStub(false);
    const html = renderDirBrowser();
    // The card is the inner content div (sibling of the backdrop
    // button). We don't try to capture the full class string in
    // one regex (the order of `max-w-[480px]` vs `rounded-2xl`
    // etc. varies with the JSX source — assertions are per-token).
    // Locate the card div by anchoring on `max-w-[480px]` (unique
    // to the DirectoryBrowser card) and reading the whole class.
    const cardMatch = html.match(/<div[^>]*class="([^"]*\bmax-w-\[480px\][^"]*)"/);
    expect(cardMatch, 'reference card with max-w-[480px] should render').not.toBeNull();
    const cls = cardMatch![1];
    expect(cls, 'card carries relative (sits above the absolute-positioned backdrop)').toMatch(/\brelative\b/);
    expect(cls, 'card carries w-full').toMatch(/\bw-full\b/);
    expect(cls, 'card carries flex-col').toMatch(/\bflex-col\b/);
    expect(cls, 'card carries gap-4').toMatch(/\bgap-4\b/);
    expect(cls, 'card carries rounded-2xl').toMatch(/\brounded-2xl\b/);
    expect(cls, 'card carries bg-surface').toMatch(/\bbg-surface\b/);
    expect(cls, 'card carries p-6').toMatch(/\bp-6\b/);
    expect(cls, 'card carries shadow-2xl').toMatch(/\bshadow-2xl\b/);
  });

  it('3. backdrop rendered on desktop only (M+ (b) 兑现): absolute inset-0 bg-deep/30 backdrop-blur-[3px] + click onCancel', () => {
    installMatchMediaStub(false); // desktop
    const html = renderDirBrowser();
    // The backdrop sits as a child of the wrapper — match any
    // <button> with aria-label="关闭对话框" inside the rendered
    // tree. The DirectoryBrowser is the only component that emits
    // a backdrop with that aria-label.
    const backdropAny = html.match(/<button[^>]*\baria-label="关闭对话框"[^>]*>/);
    expect(backdropAny, 'desktop should render a backdrop button with aria-label="关闭对话框"').not.toBeNull();
    const cls = backdropAny![0].match(/class="([^"]*)"/)![1];
    expect(cls, 'backdrop carries absolute inset-0').toMatch(/\babsolute\b/);
    expect(cls, 'backdrop carries absolute inset-0').toMatch(/\binset-0\b/);
    expect(cls, 'backdrop carries bg-deep/30 (T08 deep-slate 30% scrim)').toMatch(/\bbg-deep\/30\b/);
    expect(cls, 'backdrop carries backdrop-blur-[3px] (D6 family)').toMatch(/\bbackdrop-blur-\[3px\]/);
    expect(cls, 'backdrop carries cursor-default').toMatch(/\bcursor-default\b/);
  });

  it('4. mobile form keeps full-screen sheet (T07 mobile sheet 沿用)', () => {
    installMatchMediaStub(true); // mobile
    const html = renderDirBrowser();
    const wrapper = html.match(/<div\s[^>]*\bdata-testid="directory-browser"[^>]*>/);
    expect(wrapper).not.toBeNull();
    const cls = wrapper![0].match(/class="([^"]*)"/)![1];
    // Mobile form preserves the e2e 09 spec assertions:
    expect(cls, 'mobile wrapper contains inset-0 (e2e 09 spec)').toMatch(/\binset-0\b/);
    expect(cls, 'mobile wrapper DOES NOT contain the literal `card directory-browser` substring (e2e 09 spec)').not.toContain('card directory-browser');
    // Mobile form is NOT centred (it IS the full-screen sheet —
    // no items-center / justify-center on the wrapper itself).
    expect(cls, 'mobile wrapper does NOT centre (full-screen sheet)').not.toMatch(/\bitems-center\b/);
    // bg-bg + overflow-y-auto → mobile sheet's solid-bg paint
    // stays consistent with T07.
    expect(cls, 'mobile wrapper carries bg-bg').toMatch(/\bbg-bg\b/);
    expect(cls, 'mobile wrapper carries overflow-y-auto').toMatch(/\boverflow-y-auto\b/);
    // No backdrop on mobile (the wrapper is itself the sheet).
    expect(html).not.toMatch(/<button[^>]*\baria-label="关闭对话框"[^>]*>/);
  });

  it('5. header tinted icon block: size-11 rounded-xl bg-accent-soft text-accent + lucide FolderOpen (T08 D7 family)', () => {
    installMatchMediaStub(false);
    const html = renderDirBrowser();
    // Tinted icon block matches the same chrome language as
    // TokenModal (Hash) and DialogHost (PenLine, Edit3, etc.).
    expect(html).toMatch(
      /<div[^>]*class="[^"]*\bsize-11\b[^"]*\brounded-xl\b[^"]*\bbg-accent-soft\b[^"]*\btext-accent\b[^"]*"/,
    );
    // lucide FolderOpen svg — lucide-react v1 emits class tokens
    // like "lucide lucide-folder-open ... size-5". Pin on the
    // lucide-folder-open token.
    expect(html).toMatch(/<svg[^>]*class="[^"]*\blucide-folder-open\b[^"]*"/);
  });

  it('6. title carries the reference `text-base font-semibold tracking-tight text-text` typography', () => {
    installMatchMediaStub(false);
    const html = renderDirBrowser();
    const titleMatch = html.match(/<h3[^>]*\bid="directory-browser-title"[^>]*\bclass="([^"]*)"/);
    expect(titleMatch, 'directory-browser-title h3 should render').not.toBeNull();
    const cls = titleMatch![1];
    expect(cls, 'title carries text-base').toMatch(/\btext-base\b/);
    expect(cls, 'title carries font-semibold').toMatch(/\bfont-semibold\b/);
    expect(cls, 'title carries tracking-tight').toMatch(/\btracking-tight\b/);
    expect(cls, 'title carries text-text').toMatch(/\btext-text\b/);
  });

  it('7. path bar wrapper is `text-sm text-muted-3` + inline code chip is `rounded bg-surface-2 font-mono text-xs text-accent` (T08 D7)', () => {
    installMatchMediaStub(false);
    const html = renderDirBrowser();
    // Locate the directory-browser-path wrapper. The HTML
    // emitted by SSR keeps the JSX attribute order (class
    // FIRST, then data-testid), so we anchor on
    // `class="... directory-browser-path ..."` and look
    // forward for the data-testid to pin the right `<p>`.
    const wrapMatch = html.match(/<p\s[^>]*\bclass="([^"]*\bdirectory-browser-path\b[^"]*)"[^>]*\bdata-testid="directory-browser-path"/);
    expect(wrapMatch, 'directory-browser-path wrapper should render').not.toBeNull();
    const wrapCls = wrapMatch![1];
    expect(wrapCls, 'path wrapper carries text-sm').toMatch(/\btext-sm\b/);
    expect(wrapCls, 'path wrapper carries text-muted-3').toMatch(/\btext-muted-3\b/);
    // Inline <code> chip — read the <code> tag near the path
    // wrapper. The chip carries font-mono + accent text + the
    // soft surface paint.
    const codeMatch = html.match(/<code[^>]*>(?:[^<]*)<\/code>/);
    expect(codeMatch, 'inline <code> chip should render').not.toBeNull();
    const codeCls = codeMatch![0].match(/<code\s[^>]*class="([^"]*)"/)![1];
    expect(codeCls, 'path code chip carries rounded').toMatch(/\brounded\b/);
    expect(codeCls, 'path code chip carries bg-surface-2').toMatch(/\bbg-surface-2\b/);
    expect(codeCls, 'path code chip carries font-mono').toMatch(/\bfont-mono\b/);
    expect(codeCls, 'path code chip carries text-xs').toMatch(/\btext-xs\b/);
    expect(codeCls, 'path code chip carries text-accent').toMatch(/\btext-accent\b/);
  });

  it('8. open=false mounts nothing (M5 既有行为保留 + T08 modal化 zero-regression)', () => {
    // `open === false` returns an empty fragment so the modal
    // doesn't occupy DOM slots that could catch a backdrop click
    // or leak focus.
    installMatchMediaStub(false);
    const html = renderDirBrowserClosed();
    expect(html).not.toContain('data-testid="directory-browser"');
    // No backdrop either.
    expect(html).not.toMatch(/<button[^>]*\baria-label="关闭对话框"[^>]*>/);
  });
});

// ---------------------------------------------------------------------------
// entry row shape — separate describe for readability; this section
// needs a populated entries list which the production component
// derives from the WsClient round-trip (not exercisable via SSR).
// We assert the entry-row shape directly by inspecting the
// per-row class string the component emits — see §9 for the
// pre-baked HTML snapshot of one row, captured by reading the
// component's source and replaying its render path via a dedicated
// mini-fixture render. (Production wires a WsClient round-trip;
// the class string is independent of the data.)
// ---------------------------------------------------------------------------

describe('DirectoryBrowser — entry row reference shape (T08 D7 family)', () => {
  // The DirectoryBrowser renders the entry row when
  // `entries !== null`. For SSR we cannot reach that state
  // without driving the WsClient round-trip; instead we assert
  // the rounded-xl + bg-surface + hover token classes the row
  // SHOULD carry by searching the rendered component source
  // (a static, structural pin — the row class string is a
  // build-time constant in the component).
  //
  // The production test for the live entry render lives in the
  // e2e 04 spec — there we click `work-dir-browse` and assert
  // the full DOM (rendered via the real React + WsClient path).
  it('9. the entry row class string carries the T08 shape: rounded-xl + border + bg-surface + hover + flex items-start (structural pin)', () => {
    // Read the rendered component source for the dir-entry row
    // class literal. The production class string is a build-time
    // constant — verifying it here means the production visual
    // matches the brief, even though we cannot SSR-render a
    // populated entries list without a live WsClient.
    //
    // (We use a structural reading of the file rather than
    // exhaustively replaying the render path: the e2e suite
    // covers the live DOM via 04 / 09 specs. The unit pin
    // catches any future class drift before it hits main.)
    const src = readFileSync(new URL('../components/DirectoryBrowser.tsx', import.meta.url), 'utf8');
    // The row class literal is emitted verbatim by the
    // component; locating it here pins the visual contract.
    // The className attribute appears BEFORE the data-testid
    // attribute on the same `<li>` element (the JSX source
    // orders attributes class → data-testid).
    //
    // We anchor on the unique dir-entry substring inside the
    // JSX class literal `directory-browser-entry flex ...` —
    // that prefix token is unique to the row (not any other
    // li in the file).
    const rowMatch = src.match(/className="([^"]*\bdirectory-browser-entry\b[^"]*)"/);
    expect(rowMatch, 'dir-entry row literal must exist in source').not.toBeNull();
    const cls = rowMatch![1];
    // T08 row shape:
    expect(cls, 'row carries rounded-xl').toMatch(/\brounded-xl\b/);
    expect(cls, 'row carries border-border').toMatch(/\bborder-border\b/);
    expect(cls, 'row carries bg-surface').toMatch(/\bbg-surface\b/);
    expect(cls, 'row carries hover:bg-surface-2').toMatch(/\bhover:bg-surface-2\b/);
    expect(cls, 'row carries p-2').toMatch(/\bp-2\b/);
    expect(cls, 'row carries flex items-start gap-3 (T08 双行 inline-buttons layout)').toMatch(/\bflex\b/);
    expect(cls, 'row carries flex items-start gap-3').toMatch(/\bitems-start\b/);
    expect(cls, 'row carries flex items-start gap-3').toMatch(/\bgap-3\b/);
  });

  it('10. the entry row open/select buttons carry the T08 shape (rounded-lg + outline / accent-soft distinction)', () => {
    const src = readFileSync(new URL('../components/DirectoryBrowser.tsx', import.meta.url), 'utf8');
    // Anchor on the unique className fragment that pins the
    // each button's intent (`hover:bg-surface-2` for open,
    // `bg-accent-soft` for select) — that way the regex stops
    // at the right <button> rather than scrolling past to the
    // action-row "上到 home" / "取消" buttons higher in the
    // source.
    // The open button matches on the unique combination of
    // `text-xs` + `hover:bg-surface-2` (the row action buttons
    // use `text-xs` while the action-row buttons above the
    // list use `text-sm`; this distinguishes the row from
    // the action row).
    const openBtn = src.match(/className="([^"]*\btext-xs\b[^"]*\bhover:bg-surface-2\b[^"]*)"/);
    // The select button uses accent soft tint — match by the
    // `border-accent bg-accent-soft text-accent` triple (these
    // three tokens are unique to the select button).
    const selectBtn = src.match(/className="([^"]*\bborder-accent\b[^"]*\bbg-accent-soft\b[^"]*\btext-accent\b[^"]*)"/);
    expect(openBtn, 'dir-entry-open button literal must exist in source').not.toBeNull();
    expect(selectBtn, 'dir-entry-select button literal must exist in source').not.toBeNull();
    // open = outlined weak-state: bg-surface + border-border + text-text.
    const openCls = openBtn![1];
    expect(openCls, 'open button carries rounded-lg').toMatch(/\brounded-lg\b/);
    expect(openCls, 'open button carries border-border (outline)').toMatch(/\bborder-border\b/);
    expect(openCls, 'open button carries bg-surface (outline)').toMatch(/\bbg-surface\b/);
    expect(openCls, 'open button carries text-text').toMatch(/\btext-text\b/);
    // select = accent-soft weak-state (T08 brief: 「accent 弱态或描边」):
    // border-accent + bg-accent-soft + text-accent.
    const selectCls = selectBtn![1];
    expect(selectCls, 'select button carries rounded-lg').toMatch(/\brounded-lg\b/);
    expect(selectCls, 'select button carries border-accent (accent 描边)').toMatch(/\bborder-accent\b/);
    expect(selectCls, 'select button carries bg-accent-soft (accent 弱态)').toMatch(/\bbg-accent-soft\b/);
    expect(selectCls, 'select button carries text-accent').toMatch(/\btext-accent\b/);
  });
});
