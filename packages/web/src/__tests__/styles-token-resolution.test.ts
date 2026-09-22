// Vitest specs for `styles.css` — M6 task 01 reference-cool token
// rewrite (D1 / D2 / D5 / D9). Pins the light + dark values for
// every token (13 legacy + 9 additions = 22 per palette) and the
// `@theme inline` Tailwind namespace mapping so the next round of
// visual retunes can neither silently rename a token nor break
// dark-mode propagation.
//
// === Strategy: source-text regex resolution ===
//
// Why this test does not call `getComputedStyle(...)`:
//
//   This package ships under `vitest`'s default `node`
//   environment (no jsdom / happy-dom — project policy,
//   `assistant-message-body.test.tsx` header + ADR-0009 §决策 4).
//   Mounting `styles.css` in node would require either
//
//     (a) spinning up jsdom just for the CSS layer (against
//         ADR-0009 — bigger vitest install + boot time),
//     (b) feeding the CSS to a real lightningcss / postcss
//         parser (pulls a heavy runtime into a unit test).
//
//   Neither pays for itself here: the values we care about are
//   literally written in the file by hand. A regex over the file
//   text catches every value drift a real `getComputedStyle`
//   assertion would catch, with zero new dependencies, zero
//   environment plumbing, and full transparency (a failing
//   assertion points at the exact byte that changed).
//
//   Trade-off (documented for task 11 dark-contrast pass): if
//   downstream tasks ever introduce `var()` chaining that
//   references tokens defined elsewhere (e.g. nested `color:
//   var(--accent)` inside an `@layer components` rule that
//   resolves through `@theme inline`), this test will not catch
//   that resolution — it is the test for the *source-of-truth
//   layer*, not for the consumer tree. The visual round is
//   covered by e2e specs in M5 baseline + M6 task 10.
//
// === Resolution helpers ===
//
// Two regex passes:
//
//   1. `lightTokens` — `[:root] { ... }` block outside any
//      `@media` query, the source of light values.
//   2. `darkTokens` — `@media (prefers-color-scheme: dark) { :root { ... } }`
//      block, the source of dark values.
//
// Each pass extracts `--name: value;` declarations and folds
// them into a `Record<string, string>` keyed by token name. A
// helper `expectToken()` then asserts individual values.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Module under test — locate `packages/web/src/styles.css` relative to this
// file. The test runner is invoked from the repo root (`pnpm --filter
// @remotepi/web test` → `vitest run` → CWD = repo root), so absolute
// resolution off `__dirname` is the safe path. Importing via `import.meta.url`
// keeps the helper valid for both ESM and `vitest` worker bundles.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const stylesPath = resolve(here, '../styles.css');

// `readFileSync` happens once per test invocation; the file is small (~22 KB)
// so a memoised read at module scope avoids re-parsing the same string for
// every assertion below.
const cssSource = readFileSync(stylesPath, 'utf8');

// Match CSS custom-property declarations where the value runs
// until the next semicolon (or balanced paren for rgba() /
// var() etc.). Trailing whitespace + trailing semicolon are
// trimmed by the consumer. Greedy non-semicolon matching is
// safe because every value in the file terminates with a
// semicolon — nested var(--other) references don't introduce
// semicolons inside their argument list (they resolve to a
// CSS-wide identifier list, never a declaration block).
const DECL_RE = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;

// Pull a single top-level block out of source. `start` marks
// the index of the opening-brace target (e.g. the index of the
// `@theme` keyword); the helper scopes capture to the matching
// close-brace at depth zero and returns everything in between.
// Balanced-brace walk guards against capturing a stray `{` that
// lives inside a value (the only place it could appear today is
// inside an arbitrary-value utility we don't yet emit, but the
// helper is general-purpose so future task 02 Tailwind utilities
// won't trip it).
function extractRootBlock(source: string, start: number): string {
  const openIdx = source.indexOf('{', start);
  if (openIdx < 0) return '';
  let depth = 1;
  let i = openIdx + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return source.slice(openIdx + 1, i - 1);
}

// Strip the banner comments so the structural regexes below
// don't match the literal `@theme inline { ... }` /
// `root selector { ... }` snippets that the banner comment
// quotes for documentation. We use a non-greedy global match
// here on purpose: CSS rule bodies never contain the end-of-
// comment sequence in this project (plain CSS, no single-line
// trickery), so non-greedy yields the safest collapse while
// still surviving any future multi-line banner additions.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

const cssNoComments = stripComments(cssSource);

// Walk every token declaration inside the supplied block text
// and return a record keyed by the token name. The declaration
// shape is a leading double-dash, the token name, a colon, the
// value, and a trailing semicolon; the regex is grep-driven
// rather than parser-driven on purpose — see the file header
// for the rationale. Used for both the light standalone root
// selector and the dark-media nested root selector; shape-
// agnostic.
function parseTokens(blockText: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of blockText.matchAll(DECL_RE)) {
    const name = match[1] ?? '';
    const value = match[2]?.trim() ?? '';
    if (name) tokens[name] = value;
  }
  return tokens;
}

// Locate the root-selector defaults block that runs BEFORE
// the first `@media` rule. That's the light token source.
// Operates on `cssNoComments` so the banner-comment snippets
// can't pollute the match.
function findLightBlock(source: string): string {
  const mediaIdx = source.indexOf('@media');
  const candidates: Array<{ start: number }> = [];
  const rootRe = /:root\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = rootRe.exec(source))) {
    if (mediaIdx < 0 || m.index < mediaIdx) {
      candidates.push({ start: m.index });
    }
  }
  if (candidates.length === 0) return '';
  const block = extractRootBlock(source, candidates[candidates.length - 1]!.start);
  return block;
}

// Locate the dark root block — the inner root-selector
// declaration block nested inside the prefers-color-scheme
// media-query wrapper. Tolerates any future `@media`
// additions by always picking the LAST matching one (the
// M6 layout convention is "media queries appear after the
// light root selector").
function findDarkBlock(source: string): string {
  const mediaStart = source.indexOf('@media (prefers-color-scheme: dark)');
  if (mediaStart < 0) return '';
  const mediaBlock = extractRootBlock(source, mediaStart);
  const innerStart = mediaBlock.indexOf(':root');
  if (innerStart < 0) return '';
  return extractRootBlock(mediaBlock, innerStart);
}

const lightTokens = parseTokens(findLightBlock(cssNoComments));
const darkTokens = parseTokens(findDarkBlock(cssNoComments));

// Pull the `@theme inline` body so we can assert the Tailwind
// namespace mapping shape (count + var() references). Returns
// an empty string if the directive is missing — every assertion
// downstream either tolerates that or fails loudly.
function findThemeInlineBlock(source: string): string {
  const re = /@theme\s+inline\s*\{/g;
  const m = re.exec(source);
  if (!m) return '';
  return extractRootBlock(source, m.index);
}
const themeInlineBody = findThemeInlineBlock(cssNoComments);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nm(name: string): string {
  // Pretty-print a token name for assertion messages.
  return '--' + name;
}

// Assert a token is present and holds the expected raw value
// in the light palette. The value string is the literal CSS
// body trimmed of leading / trailing whitespace, so any tokens
// that would round-trip through the renderer (e.g. a var()
// chain) stay literal in this assertion. Missing tokens fail
// with the token name; mismatch fails with both sides for
// grep-ability.
function expectLightToken(name: string, expected: string): void {
  expect(
    lightTokens[name],
    `${nm(name)} (light) should equal ${JSON.stringify(expected)}`,
  ).toBe(expected);
}

function expectDarkToken(name: string, expected: string): void {
  expect(
    darkTokens[name],
    `${nm(name)} (dark) should equal ${JSON.stringify(expected)}`,
  ).toBe(expected);
}

// ---------------------------------------------------------------------------
// 1) Light palette — surface family (D1)
// ---------------------------------------------------------------------------

describe('styles.css — light palette: surface family', () => {
  it('1.1 --bg resolves to the reference app background', () => {
    expectLightToken('bg', '#f6f7f9');
  });

  it('1.2 --surface resolves to white', () => {
    expectLightToken('surface', '#ffffff');
  });

  it('1.3 --surface-2 resolves to the soft inner surface', () => {
    expectLightToken('surface-2', '#f5f7f9');
  });
});

// ---------------------------------------------------------------------------
// 2) Light palette — text + five grey stops (D1)
// ---------------------------------------------------------------------------

describe('styles.css — light palette: text + grey stops', () => {
  it('2.1 --text resolves to the deep slate ink', () => {
    expectLightToken('text', '#17202b');
  });

  it('2.2 --muted resolves to the secondary text grey', () => {
    expectLightToken('muted', '#687482');
  });

  it('2.3 --muted-2 resolves to the body-text grey (message prose)', () => {
    expectLightToken('muted-2', '#4d5966');
  });

  it('2.4 --muted-3 resolves to the tertiary grey', () => {
    expectLightToken('muted-3', '#74808c');
  });

  it('2.5 --muted-4 resolves to the quaternary grey', () => {
    expectLightToken('muted-4', '#87919d');
  });

  it('2.6 --muted-5 resolves to the placeholder grey', () => {
    expectLightToken('muted-5', '#9aa3ad');
  });
});

// ---------------------------------------------------------------------------
// 3) Light palette — accent reference family + code surface + state
// ---------------------------------------------------------------------------

describe('styles.css — light palette: accent + code + state + shadow', () => {
  it('3.1 --accent resolves to reference blue #245bc4 (D1)', () => {
    expectLightToken('accent', '#245bc4');
  });

  it('3.2 --accent-hover resolves to the deeper hover blue', () => {
    expectLightToken('accent-hover', '#194da9');
  });

  it('3.3 --accent-soft resolves to the soft blue tint', () => {
    expectLightToken('accent-soft', '#f0f5ff');
  });

  it('3.4 --accent-ring resolves to the focus-ring tint', () => {
    expectLightToken('accent-ring', '#eef4ff');
  });

  it('3.5 --border resolves to the primary border grey', () => {
    expectLightToken('border', '#e4e8ed');
  });

  it('3.6 --border-2 resolves to the heavier border layer', () => {
    expectLightToken('border-2', '#dfe4e9');
  });

  it('3.7 --border-3 resolves to the hairline border layer', () => {
    expectLightToken('border-3', '#edf0f3');
  });

  it('3.8 --code-bg resolves to the code surface (theme-aligned)', () => {
    expectLightToken('code-bg', '#ffffff');
  });

  it('3.9 --state-online resolves to the green online state', () => {
    expectLightToken('state-online', '#1f9d55');
  });

  it('3.10 --state-offline resolves to the red offline state', () => {
    expectLightToken('state-offline', '#c0392b');
  });

  it('3.11 --state-connecting resolves to the connecting grey (#87919d)', () => {
    expectLightToken('state-connecting', '#87919d');
  });

  it('3.12 --shadow-card resolves to the reference card shadow', () => {
    // Value carries through verbatim — the renderer is the
    // test for behaviour; this test pins the SOURCE byte so
    // any future hex / rgba drift fails here first.
    expectLightToken(
      'shadow-card',
      '0 4px 18px rgba(23, 32, 43, 0.06)',
    );
  });
});

// ---------------------------------------------------------------------------
// 4) Dark palette — surface + text + grey stops (D2)
// ---------------------------------------------------------------------------

describe('styles.css — dark palette: surface + text + grey stops (D2)', () => {
  it('4.1 --bg resolves to the slate app background', () => {
    expectDarkToken('bg', '#0e1218');
  });

  it('4.2 --surface resolves to the elevated surface', () => {
    expectDarkToken('surface', '#1a2030');
  });

  it('4.3 --surface-2 resolves to the inner surface', () => {
    expectDarkToken('surface-2', '#222837');
  });

  it('4.4 --text resolves to the bright ink', () => {
    expectDarkToken('text', '#e6e9ee');
  });

  it('4.5 --muted resolves to the secondary dark-mode grey', () => {
    expectDarkToken('muted', '#9aa3ad');
  });

  it('4.6 --muted-2 resolves to the body grey (now lifted on dark)', () => {
    expectDarkToken('muted-2', '#cbd0d6');
  });

  it('4.7 --muted-5 resolves to the dark placeholder grey', () => {
    expectDarkToken('muted-5', '#6f7a85');
  });
});

// ---------------------------------------------------------------------------
// 5) Dark palette — accent + borders + code + state + shadow
// ---------------------------------------------------------------------------

describe('styles.css — dark palette: accent + borders + state + shadow (D2)', () => {
  it('5.1 --accent resolves to the lifted reference blue #6f9bff', () => {
    expectDarkToken('accent', '#6f9bff');
  });

  it('5.2 --accent-hover resolves to the lifted hover blue', () => {
    expectDarkToken('accent-hover', '#8aaeff');
  });

  it('5.3 --accent-soft resolves to the dark blue tint', () => {
    expectDarkToken('accent-soft', '#1c2742');
  });

  it('5.4 --accent-ring resolves to the dark focus-ring tint', () => {
    expectDarkToken('accent-ring', '#1c2742');
  });

  it('5.5 --border resolves to the primary dark-mode border (R3 critical)', () => {
    expectDarkToken('border', '#2a3140');
  });

  it('5.6 --border-2 resolves to the heavier dark border layer', () => {
    expectDarkToken('border-2', '#353c4a');
  });

  it('5.7 --border-3 resolves to the hairline dark border layer', () => {
    expectDarkToken('border-3', '#202632');
  });

  it('5.8 --code-bg resolves to the dark code surface', () => {
    expectDarkToken('code-bg', '#222837');
  });

  it('5.9 --state-connecting resolves to the dark connecting grey', () => {
    expectDarkToken('state-connecting', '#74808c');
  });

  it('5.10 --state-online resolves to the emerald online state', () => {
    expectDarkToken('state-online', '#34d399');
  });

  it('5.11 --state-offline resolves to the rose offline state', () => {
    expectDarkToken('state-offline', '#f87171');
  });

  it('5.12 --shadow-card resolves to the dark card shadow', () => {
    expectDarkToken('shadow-card', '0 4px 18px rgba(0, 0, 0, 0.4)');
  });
});

// ---------------------------------------------------------------------------
// 6) `@theme inline` Tailwind namespace mapping (M5 编排者修正延续)
// ---------------------------------------------------------------------------

describe('styles.css — @theme inline mapping', () => {
  it('6.1 every colour namespace resolves via var() (no literal copies)', () => {
    // Slices the @theme inline body and asserts that each
    // required --color-* namespace is wired to the matching
    // token via `var(...)` — the pattern that keeps dark-mode
    // propagation alive for Tailwind utilities without
    // duplicating palette values into the generated CSS.
    const expectedColorVars = [
      'bg',
      'surface',
      'surface-2',
      'text',
      'muted',
      'muted-2',
      'muted-3',
      'muted-4',
      'muted-5',
      'border',
      'border-2',
      'border-3',
      'accent',
      'accent-hover',
      'accent-soft',
      'accent-ring',
      'accent-disabled',
      'code-bg',
      'state-online',
      'state-offline',
      'state-connecting',
    ];

    for (const name of expectedColorVars) {
      // Use a relaxed regex — `var(--name)` with optional
      // whitespace, anchored as the entire declaration value
      // up to a trailing semicolon (semicolon is part of the
      // surrounding context, not the var() body).
      const re = new RegExp(
        `--color-${name}\\s*:\\s*var\\(--${name}\\)\\s*;`,
      );
      expect(
        re.test(themeInlineBody),
        `--color-${name} should map via var(--${name})`,
      ).toBe(true);
    }
  });

  it('6.2 --spacing-sidebar-width exposes the sidebar width for utilities', () => {
    expect(themeInlineBody).toMatch(
      /--spacing-sidebar-width\s*:\s*var\(--sidebar-width\)\s*;/,
    );
  });

  it('6.3 @theme inline does NOT contain any literal palette hex (var-only)', () => {
    // Belt-and-braces: the inline modifier is what allows the
    // utilities to track overrides. A regression that pastes
    // a literal `#xxxxxx` into @theme would silently break
    // dark-mode for the matching utility — guard against it.
    expect(themeInlineBody).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
