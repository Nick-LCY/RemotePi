// Vitest specs for `AssistantMessageBody` (M5 §1 + §2 —
// react-markdown / remark-gfm / rehype-sanitize + folded
// thinking + folded toolCall pill).
//
// Strategy: render via `react-dom/server.renderToStaticMarkup`
// against `vitest`'s default node environment (no jsdom /
// happy-dom — project policy, see `choice-page-flow.test.ts`
// header + ADR-0009 §决策 4). Static markup is sufficient for
// every assertion: structural (tag presence), attribute (class
// names, target/rel), and content (text inside the tags).
//
// Coverage targets:
//   - GFM elements (headings, lists, tables, links, code,
//     inline code, autolink).
//   - Thinking / toolCall folded structures.
//   - Sanitize three attack vectors:
//       * `<script>alert(1)</script>` → no <script> tag in output
//       * `<img onerror=…>` → no `onerror` attribute on rendered
//         elements (img itself is dropped or kept without attrs)
//       * `[click](javascript:alert(1))` → `href` is removed
//   - String content / unknown segment / null fallback.
//   - Link target=_blank rel=noreferrer.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AssistantMessageBody } from '../components/AssistantMessageBody.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the body to a static HTML string. Wraps the call so
 *  tests can call `render(content)` without repeating the
 *  import + render call. */
function render(content: unknown): string {
  return renderToStaticMarkup(<AssistantMessageBody content={content} />);
}

// ---------------------------------------------------------------------------
// GFM rendering
// ---------------------------------------------------------------------------

describe('AssistantMessageBody — GFM rendering', () => {
  it('1.1 renders headings (# ## ###) as <h1>/<h2>/<h3>', () => {
    const html = render([{ type: 'text', text: '# H1\n## H2\n### H3' }]);
    expect(html).toContain('<h1>H1</h1>');
    expect(html).toContain('<h2>H2</h2>');
    expect(html).toContain('<h3>H3</h3>');
  });

  it('1.2 renders unordered lists (- / *) as <ul><li>', () => {
    const html = render([{ type: 'text', text: '- a\n- b\n- c' }]);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<li>b</li>');
    expect(html).toContain('<li>c</li>');
    expect(html).toContain('</ul>');
  });

  it('1.3 renders ordered lists (1. 2.) as <ol><li>', () => {
    const html = render([{ type: 'text', text: '1. one\n2. two\n3. three' }]);
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  it('1.4 renders GFM tables with <table><thead><tbody>', () => {
    const html = render([
      {
        type: 'text',
        text: '| col1 | col2 |\n| ---- | ---- |\n| a    | b    |\n| c    | d    |',
      },
    ]);
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<th>col1</th>');
    expect(html).toContain('<th>col2</th>');
    expect(html).toContain('<td>a</td>');
    expect(html).toContain('<td>d</td>');
  });

  it('1.5 renders fenced code blocks (```) as <pre><code>', () => {
    const html = render([{ type: 'text', text: '```js\nconst x = 1;\n```' }]);
    expect(html).toContain('<pre');
    expect(html).toContain('<code');
    expect(html).toContain('const x = 1;');
  });

  it('1.6 renders inline `code` with the inline-code class', () => {
    const html = render([{ type: 'text', text: 'use `npm install`' }]);
    // react-markdown v9 still tags the inline `<code>` with our
    // custom renderer. The renderer is keyed off the `inline` prop
    // which v9 exposes; verify the inline class is present.
    expect(html).toContain('markdown-code-inline');
    expect(html).toContain('npm install');
  });

  it('1.7 renders bold (**) and italic (*) emphasis', () => {
    const html = render([{ type: 'text', text: '**bold** and *italic*' }]);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('1.8 renders explicit links [text](url)', () => {
    const html = render([{ type: 'text', text: '[example](https://example.com)' }]);
    // target=_blank + rel=noreferrer enforced.
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('>example</a>');
  });

  it('1.9 renders bare URLs as autolinks via remark-gfm', () => {
    const html = render([{ type: 'text', text: 'visit https://example.com today' }]);
    expect(html).toContain('href="https://example.com"');
  });
});

// ---------------------------------------------------------------------------
// Sanitize (D1 — three attack vectors)
// ---------------------------------------------------------------------------

describe('AssistantMessageBody — sanitize (D1)', () => {
  it('2.1 <script>alert(1)</script> produces NO <script> tag in output', () => {
    const html = render([{ type: 'text', text: '<script>alert(1)</script>' }]);
    expect(html.toLowerCase()).not.toContain('<script');
    // The literal text "alert(1)" may survive (text content is
    // preserved); what matters is no executable <script> tag.
    expect(html).not.toContain('<script>alert');
  });

  it('2.2 <img src=x onerror=alert(1)> strips the onerror attribute', () => {
    const html = render([{ type: 'text', text: '<img src="x" onerror="alert(1)" />' }]);
    // rehype-sanitize default schema drops the <img> tag entirely
    // (not in the allowed list). If a tag survived, the onerror
    // attribute must not be present in any form.
    expect(html.toLowerCase()).not.toContain('onerror');
    expect(html.toLowerCase()).not.toContain('onclick');
    expect(html.toLowerCase()).not.toContain('onload');
  });

  it('2.3 [click](javascript:alert(1)) removes the javascript: href', () => {
    const html = render([
      { type: 'text', text: '[click](javascript:alert(1))' },
    ]);
    // rehype-sanitize strips the href entirely when the protocol
    // is non-http(s). The link text "click" is preserved as a
    // plain span (or the <a> is dropped entirely — both safe).
    expect(html.toLowerCase()).not.toContain('javascript:');
    // No href starting with javascript:
    expect(html).not.toMatch(/href\s*=\s*["']?javascript:/i);
  });

  it('2.4 <a href="data:text/html,…"> is sanitised (no data: href allowed)', () => {
    const html = render([
      { type: 'text', text: '<a href="data:text/html,<script>alert(1)</script>">x</a>' },
    ]);
    // data: protocol is not in the default schema's safe list;
    // the href should be removed or rewritten.
    expect(html.toLowerCase()).not.toContain('data:text/html');
  });

  it('2.5 <iframe> and <style> tags are dropped entirely', () => {
    const html = render([
      {
        type: 'text',
        text: '<iframe src="https://evil.example.com"></iframe><style>body{}</style>',
      },
    ]);
    expect(html.toLowerCase()).not.toContain('<iframe');
    expect(html.toLowerCase()).not.toContain('<style');
  });
});

// ---------------------------------------------------------------------------
// Thinking + toolCall folding (D3 + D4)
// ---------------------------------------------------------------------------

describe('AssistantMessageBody — folded segments', () => {
  it('3.1 thinking segment renders inside <details> with the default-folded summary', () => {
    const html = render([
      { type: 'thinking', thinking: 'reasoning text' },
    ]);
    expect(html).toContain('<details');
    expect(html).toContain('class="message-thinking-details assistant-thinking"');
    expect(html).toContain('<summary');
    expect(html).toContain('思考过程');
    expect(html).toContain('reasoning text');
    // `<details>` without the `open` attribute is the default-folded
    // state — that's what we want (D3 + G3).
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it('3.2 toolCall segment renders a folded pill with name + JSON args + result', () => {
    // M5 验收期 gap — the `result` shape is now `MergedToolResult`
    // (`{text, isError}`) attached by `mergeToolResults` in the
    // rendering layer; see `components/toolResultMerge.ts`. The
    // pre-fix test used an arbitrary object (`{stdout, code}`)
    // which stringifySafe would have rendered as JSON; the new
    // shape renders `result.text` as plain text with isError
    // styling. We pin the new shape here so a future drift in
    // the merge contract trips this test loudly.
    const html = render([
      {
        type: 'toolCall',
        name: 'bash',
        arguments: { cmd: 'ls' },
        result: { text: 'stdout: file.txt\ncode: 0', isError: false },
      },
    ]);
    // Pill summary with the tool name + emoji.
    expect(html).toContain('<details');
    expect(html).toContain('class="message-tool-details assistant-tool-call"');
    expect(html).toContain('<summary');
    expect(html).toContain('message-tool-pill');
    expect(html).toContain('🔧');
    expect(html).toContain('bash');
    // Args + result (D4 — untruncated). `renderToStaticMarkup`
    // HTML-escapes `"` to `&quot;`, so we assert on substrings
    // that survive escaping.
    expect(html).toContain('参数');
    expect(html).toContain('结果');
    // Arguments still serialised via stringifySafe.
    expect(html).toContain('cmd');
    expect(html).toContain('ls');
    // Result rendered as plain text from `result.text`.
    expect(html).toContain('stdout: file.txt');
    expect(html).toContain('code: 0');
    // Success path does NOT carry the error styling.
    expect(html).toContain('class="message-tool-result"');
    expect(html).not.toContain('message-tool-result-error');
    expect(html).not.toContain('data-testid="assistant-tool-result-error"');
    // Not open by default.
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it('3.2b toolCall with isError: true result applies the error styling', () => {
    // M5 验收期 gap — error results carry the
    // `.message-tool-result-error` class so the CSS border /
    // background flags the failure. The data-testid also flips
    // to `assistant-tool-result-error` for e2e targeting.
    const html = render([
      {
        type: 'toolCall',
        name: 'bash',
        arguments: { cmd: 'rm /missing' },
        result: { text: 'rm: cannot remove /missing: No such file or directory', isError: true },
      },
    ]);
    expect(html).toContain('结果');
    expect(html).toContain('class="message-tool-result message-tool-result-error"');
    expect(html).toContain('data-testid="assistant-tool-result-error"');
    expect(html).toContain('cannot remove /missing');
    // Success-variant testids are absent.
    expect(html).not.toContain('data-testid="assistant-tool-result"');
  });

  it('3.3 toolCall without result shows the "pending…" hint', () => {
    const html = render([
      { type: 'toolCall', name: 'read', arguments: { path: '/x' } },
    ]);
    expect(html).toContain('read');
    // Quotes are HTML-escaped — match unescaped substrings
    // rather than exact literal JSON.
    expect(html).toContain('path');
    expect(html).toContain('/x');
    expect(html).toContain('pending');
    // No "结果" header when result is missing.
    expect(html).not.toContain('结果');
  });

  it('3.4 text segment between two folded segments renders in render order', () => {
    const html = render([
      { type: 'thinking', thinking: 'thinkingA' },
      { type: 'text', text: 'answer' },
      { type: 'toolCall', name: 'x', arguments: {} },
    ]);
    // Render order: thinking block first, text block middle, tool last.
    const thinkIdx = html.indexOf('thinkingA');
    const textIdx = html.indexOf('answer');
    const toolIdx = html.indexOf('class="message-tool-details');
    expect(thinkIdx).toBeGreaterThan(-1);
    expect(textIdx).toBeGreaterThan(thinkIdx);
    expect(toolIdx).toBeGreaterThan(textIdx);
  });
});

// ---------------------------------------------------------------------------
// Fallback paths (string / unknown / null)
// ---------------------------------------------------------------------------

describe('AssistantMessageBody — fallbacks', () => {
  it('4.1 string content renders as plain text with <br> for newlines', () => {
    const html = render('plain\ntext');
    expect(html).toContain('plain');
    expect(html).toContain('<br');
    expect(html).toContain('text');
    // No markdown container when content is a string.
    expect(html).not.toContain('class="markdown-pre"');
  });

  it('4.2 unknown content shape (object, no recognised type) renders as plain text fallback', () => {
    const html = render({ weird: 'shape' });
    // stringifySafe renders the JSON inside <pre>... wait — no,
    // renderPlainText splits on \n; for a JSON object stringified
    // we expect the literal text content of the JSON. The
    // fallback never enters the markdown path so the only safe
    // assertion is that the string is present in some form.
    expect(html).toContain('weird');
    expect(html).toContain('shape');
  });

  it('4.3 null content renders an empty container (no crash, no body text)', () => {
    const html = render(null);
    // Empty container — the surrounding `.message-body` anchor is
    // owned by the parent; the body component returns null.
    expect(html).toBe('');
  });

  it('4.4 undefined content also renders empty', () => {
    const html = render(undefined);
    expect(html).toBe('');
  });

  it('4.5 empty array content renders empty (no segments)', () => {
    const html = render([]);
    expect(html).toBe('');
  });

  it('4.6 unknown segment type falls back to plain-text (no content lost)', () => {
    const html = render([{ type: 'mystery', payload: 'x' }]);
    // stringifySafe renders the JSON string — the literal text is
    // present somewhere in the output.
    expect(html).toContain('mystery');
    expect(html).toContain('payload');
    expect(html).toContain('x');
  });

  it('4.7 empty text segment renders the wrapper with no inner content', () => {
    // react-markdown always wraps its output in a container
    // (the wrapping `<div class="assistant-text-segment">` we
    // own), so even an empty markdown source produces an empty
    // wrapper. The contract we pin here is "no <p>, no text
    // content", which matches what an empty assistant message
    // should look like.
    const html = render([{ type: 'text', text: '' }]);
    expect(html).not.toContain('<p>');
    expect(html).not.toContain('markdown-code');
    expect(html).not.toContain('markdown-pre');
  });
});

// ---------------------------------------------------------------------------
// Link safety + custom renderers
// ---------------------------------------------------------------------------

describe('AssistantMessageBody — link safety + custom renderers', () => {
  it('5.1 links always carry target="_blank" + rel="noreferrer"', () => {
    const html = render([{ type: 'text', text: '[a](https://a.example) [b](https://b.example)' }]);
    // Both anchors present.
    const aCount = (html.match(/<a /g) ?? []).length;
    expect(aCount).toBe(2);
    // Every anchor has target + rel.
    const anchorPattern = /<a [^>]*href="https:\/\/(a|b)\.example"[^>]*>/g;
    const anchors = html.match(anchorPattern) ?? [];
    expect(anchors.length).toBe(2);
    for (const a of anchors) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noreferrer"');
    }
  });

  it('5.2 fenced code block <pre> + <code> carry the markdown-* classes', () => {
    const html = render([{ type: 'text', text: '```\nhello\n```' }]);
    expect(html).toContain('class="markdown-pre"');
    // Inside the <pre> there should be a <code class="markdown-code …">
    expect(html).toMatch(/<code class="markdown-code/);
  });

  it('5.3 mailto: links do NOT carry target="_blank" / rel="noreferrer" (S3)', () => {
    // M5 review S3 — opening a mailto: in a new tab is
    // pointless (the browser hands off to the OS mail client,
    // not a tab handle) and produces a useless blank tab the
    // user has to close. The default in-tab behaviour is what
    // we want for mailto:; http(s):// still get the hardening.
    const html = render([{ type: 'text', text: '[email me](mailto:a@example.com)' }]);
    const aMatch = html.match(/<a [^>]*href="mailto:a@example\.com"[^>]*>/);
    expect(aMatch).not.toBeNull();
    const anchor = aMatch![0];
    expect(anchor).not.toContain('target="_blank"');
    expect(anchor).not.toContain('rel="noreferrer"');
    // The href is preserved so the browser's default mailto
    // handling kicks in.
    expect(anchor).toContain('href="mailto:a@example.com"');
  });
});
