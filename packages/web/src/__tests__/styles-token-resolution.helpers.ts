// Shared source-text parsing helpers for `styles.css`. Extracted
// into a separate file so both `styles-token-resolution.test.ts`
// (T01 source-of-truth pins) and `styles-token-contrast.test.ts`
// (T11 WCAG contrast pass) consume the same parse output —
// avoiding two copies of the block-walk logic drifting apart.
//
// Why not a real CSS parser:
//   Same rationale as the bodies — vitest runs in `node`
//   (no jsdom / happy-dom, ADR-0009 §决策 4). The values we
//   care about are literally written in the file by hand; the
//   regex-based extraction is transparent (a failing assertion
//   points at the exact byte that changed) and zero-cost at
//   boot.
//
// Exposed surface:
//   - `cssPath`        — absolute path to `packages/web/src/styles.css`
//   - `cssSource`      — raw file text (verbatim, comments intact)
//   - `cssNoComments`  — same text with all `/* … */` blocks stripped
//   - `lightTokens`    — `Record<string, string>` of the
//                        `:root { ... }` block (before `@media`)
//   - `darkTokens`     — `Record<string, string>` of the
//                        inner `:root { ... }` of the dark media
//                        query
//   - `themeInlineBody` — verbatim `@theme inline { ... }` body
//
// Both stem from a single `readFileSync` so a typo in either test
// file fails loudly rather than silently disagreeing about the
// source byte.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const cssPath = resolve(here, '../styles.css');

export const cssSource = readFileSync(cssPath, 'utf8');

const DECL_RE = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;

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

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

export const cssNoComments = stripComments(cssSource);

function parseTokens(blockText: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of blockText.matchAll(DECL_RE)) {
    const name = match[1] ?? '';
    const value = match[2]?.trim() ?? '';
    if (name) tokens[name] = value;
  }
  return tokens;
}

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

function findDarkBlock(source: string): string {
  const mediaStart = source.indexOf('@media (prefers-color-scheme: dark)');
  if (mediaStart < 0) return '';
  const mediaBlock = extractRootBlock(source, mediaStart);
  const innerStart = mediaBlock.indexOf(':root');
  if (innerStart < 0) return '';
  return extractRootBlock(mediaBlock, innerStart);
}

export const lightTokens = parseTokens(findLightBlock(cssNoComments));
export const darkTokens = parseTokens(findDarkBlock(cssNoComments));

export function findThemeInlineBlock(source: string): string {
  const re = /@theme\s+inline\s*\{/g;
  const m = re.exec(source);
  if (!m) return '';
  return extractRootBlock(source, m.index);
}
export const themeInlineBody = findThemeInlineBlock(cssNoComments);