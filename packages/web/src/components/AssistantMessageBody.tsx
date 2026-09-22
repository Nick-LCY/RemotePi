// AssistantMessageBody — terminal-state renderer for assistant
// messages (react-markdown + remark-gfm + rehype-sanitize,
// folded thinking + toolCall pills; user / toolResult messages
// stay on the plain-text path in ChatView).
//
// Composition rules:
//   - `content: string` → plain text.
//   - `content: Array<...>` → dispatch by `piece.type`:
//       - `text` → ReactMarkdown (GFM + sanitize)
//       - `thinking` → `<details>` default folded, plain-text body
//       - `toolCall` → folded pill (summary = 🔧 + name; body =
//         参数 (stringifySafe(arguments)) + 结果 (`result.text` when
//         a `MergedToolResult` is attached; `result.isError` adds
//         `.message-tool-result-error` class)
//       - 未知 type → plain-text fallback (extractText path)
//   - `null` / `undefined` → empty container (the surrounding
//     `.message-body` anchor stays alive for the e2e testid
//     contract).
//
// Sanitize (rehype-sanitize default schema):
//   - rejects `<script>`
//   - strips `onerror` / `onclick` / … event handlers
//   - rewrites `href="javascript:…"` → `href` removed
//
// React 18 + Vite friendly: pure function (no hooks, no
// side-effects), serialises through `react-dom/server
// .renderToStaticMarkup` for the unit tests. The suite
// intentionally avoids pulling in a jsdom / happy-dom runtime.
//
// toolCall.result is shaped `{text, isError}` (MergedToolResult)
// — attached by `mergeToolResults` in ChatView before this
// component renders. When the result hasn't landed yet
// (assistant just emitted, toolResult still in flight), we show
// `pending…` — this is the exact transient semantic, not a bug.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { ReactNode } from 'react';

/** The assistant message body accepts an opaque `content` payload
 *  (the shared package treats `messages` as `unknown[]`) and
 *  narrows on render. The component is intentionally permissive
 *  on input — anything that doesn't match a known shape falls
 *  back to plain text so the user never sees a blank row when
 *  the wire format drifts. */
export interface AssistantMessageBodyProps {
  content: unknown;
}

export function AssistantMessageBody({ content }: AssistantMessageBodyProps): ReactNode {
  if (content === null || content === undefined) {
    // Empty container — the surrounding `.message-body` anchor
    // stays in the DOM so the e2e `data-testid` / className
    // contract is preserved.
    return null;
  }
  if (typeof content === 'string') {
    return renderPlainText(content);
  }
  if (Array.isArray(content)) {
    // `content` is `unknown` so the array items default to
    // `any` under strict TS settings. Pin the type to
    // `readonly unknown[]` so the `AssistantSegment` prop
    // type is honoured without an `any` leak through the
    // map callback.
    const segments: readonly unknown[] = content;
    return (
      <>
        {segments.map((piece, idx) => (
          <AssistantSegment key={idx} piece={piece} />
        ))}
      </>
    );
  }
  // Unknown shape — single plain-text fallback. Mirrors the
  // pre-M5 `extractText` fallback so a drift in the wire format
  // doesn't render blank rows.
  return renderPlainText(stringifySafe(content));
}

interface AssistantSegmentProps {
  piece: unknown;
}

function AssistantSegment({ piece }: AssistantSegmentProps): ReactNode {
  if (piece === null || typeof piece !== 'object') {
    return renderPlainText(stringifySafe(piece));
  }
  const obj = piece as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : 'unknown';
  switch (type) {
    case 'text': {
      const text = typeof obj.text === 'string' ? obj.text : '';
      return (
        // `assistant-text-segment` retained as a semantic anchor
        // — used by `assistant-message-body.test.tsx` 1.6 to
        // verify the renderer produced a `data-testid` on the
        // segment wrapper. The vertical rhythm (top / bottom
        // margins trimmed at edges) is now a Tailwind utility on
        // the segment itself; the descendant heading / paragraph
        // / list / GFM-table / code / blockquote / hr paint is
        // expressed by the `markdownComponents` map below.
        <div className="assistant-text-segment my-1 first:mt-0 last:mb-0 space-y-1.5" data-testid="assistant-text-segment">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
            components={markdownComponents}
          >
            {text}
          </ReactMarkdown>
        </div>
      );
    }
    case 'thinking': {
      const thinking = typeof obj.thinking === 'string' ? obj.thinking : '';
      return (
        // `message-thinking-details` + `assistant-thinking`
        // retained as the dual-class anchors the spec 3.1
        // asserts on. Chroming utilities match the streaming
        // draft branch in ChatView.tsx.
        <details
          className="message-thinking-details assistant-thinking my-1 rounded-md border border-border bg-surface-2"
          data-testid="assistant-thinking"
        >
          <summary className="thinking-summary cursor-pointer px-3 py-1 text-[0.85rem] text-muted">思考过程</summary>
          <div className="thinking-body whitespace-pre-wrap break-words border-t border-border px-3 pb-2 pt-2 text-[0.88rem] text-muted">{thinking}</div>
        </details>
      );
    }
    case 'toolCall': {
      const name = typeof obj.name === 'string' ? obj.name : 'tool';
      const args = obj.arguments;
      const result = obj.result;
      const mergedResult = readMergedToolResult(result);
      return (
        // `message-tool-details` + `assistant-tool-call` retained
        // as the dual-class anchors the spec 3.2 asserts on.
        <details
          className="message-tool-details assistant-tool-call my-1 rounded-md border border-border bg-surface-2"
          data-testid="assistant-tool-call"
        >
          <summary className="message-tool-pill inline-flex cursor-pointer items-center gap-1 px-3 py-1 text-[0.88rem] text-text">
            <span aria-hidden="true">🔧</span> {name}
          </summary>
          <div className="message-tool-body flex flex-col gap-1 border-t border-border px-3 pb-2 pt-2 text-[0.88rem]">
            <strong className="text-[0.78rem] font-semibold uppercase tracking-[0.05em] text-muted">参数</strong>
            <pre className="message-tool-args m-0 overflow-auto whitespace-pre-wrap break-words rounded bg-code-bg p-2 font-mono text-[0.82em]">{stringifySafe(args ?? {})}</pre>
            {mergedResult !== null ? (
              <>
                <strong className="text-[0.78rem] font-semibold uppercase tracking-[0.05em] text-muted">结果</strong>
                <pre
                  className={
                    (mergedResult.isError
                      ? 'message-tool-result message-tool-result-error'
                      : 'message-tool-result') +
                    ' m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border-t border-border bg-code-bg p-2 font-mono text-[0.82em]'
                  }
                  data-testid={mergedResult.isError ? 'assistant-tool-result-error' : 'assistant-tool-result'}
                >
                  {mergedResult.text}
                </pre>
              </>
            ) : (
              <p className="message-tool-pending m-0 text-[0.82rem] italic text-muted">pending…</p>
            )}
          </div>
        </details>
      );
    }
    default:
      // Unknown segment type — plain-text fallback so content
      // isn't silently dropped.
      return renderPlainText(stringifySafe(piece));
  }
}

/** Custom renderers for `react-markdown`. The default `a` opens
 *  in the same tab and is missing `rel="noreferrer"` — both are
 *  security smells for user-supplied link content (markdown
 *  bodies can come straight from a model reply). We force
 *  `target="_blank" rel="noreferrer"` so links open in a new
 *  tab and the browser doesn't leak the referrer.
 *
 *  The `code` / `pre` renderers apply the `.markdown-code` /
 *  `.markdown-pre` classes (defined in styles.css) so the code
 *  block background matches the `--code-bg` CSS variable for
 *  theme parity. Without these overrides the default browser
 *  styling would clash with the chat surface. Inline vs block
 *  code differentiation: react-markdown v9 dropped the
 *  `inline` boolean — it now relies on `node.parent.tagName`
 *  (the `node` extra prop). We inspect `node` to tell inline
 *  (parent is NOT `pre`) from fenced blocks (parent IS `pre`).
 *  When `node` is unavailable (unusual but possible) we fall
 *  back to the block class — safer default because fenced
 *  blocks carry `className="language-…"` which would still
 *  get the `.markdown-code` decoration. */
// `markdownComponents` is intentionally typed as a plain object —
// react-markdown's `Components` type expects each entry to
// accept the full HTMLAttributes + the hast `Element` extra
// prop. We narrow `node.parent.tagName` via a runtime cast
// rather than pulling in the hast types (hast is a transitive
// dep of react-markdown but isn't exported from the package
// directly; the `node` shape is documented in react-markdown's
// `ExtraProps`). The final `as Record<string, unknown>` cast
// at the call site lets us pass through to `ReactMarkdown`'s
// strict `Components` type without needing to model the full
// hast Element shape.
//
// M6 T02 review note: every `className` prop in
// `markdownComponents` is injected by React at JSX render time
// (after `rehype-sanitize` has already produced the hast
// tree). rehype-sanitize operates on the post-render tree and
// has no view of the className strings we attach here, so its
// schema's `className` whitelist (which would normally gate
// arbitrary attribute values) is irrelevant to the Tailwind
// utility classes we use. This means we can attach any
// utility class without conflicting with the sanitize schema
// — sanitize doesn't constrain class values, only the raw
// HTML attributes on user-supplied content.
const markdownComponents: Record<string, unknown> = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    // `mailto:` links should NOT open in a new tab. The browser
    // routes them to the OS mail client (which a tab/window
    // handle can't reach anyway), and forcing `target="_blank"`
    // would spawn a useless blank tab the user has to close.
    // Same idea for any other protocol the browser doesn't open
    // inline — we let the browser follow its default behaviour.
    // The `target="_blank" rel="noreferrer"` hardening is only
    // applied to http(s):// URLs, which are the actually-
    // navigable targets where referrer leakage + tab-jacking are
    // real risks.
    const isExternal = href !== undefined && /^(https?:)/i.test(href);
    return (
      <a
        className="text-accent underline hover:no-underline"
        href={href ?? '#'}
        {...(isExternal ? { target: '_blank', rel: 'noreferrer' } : {})}
      >
        {children}
      </a>
    );
  },
  code: ({
    node,
    className,
    children,
  }: {
    node?: { parent?: { tagName?: string } };
    className?: string;
    children?: ReactNode;
  }) => {
    const parentTag = node?.parent?.tagName;
    const isBlock = parentTag === 'pre';
    if (!isBlock) {
      // Inline code — a parent other than <pre> (typically a
      // paragraph). Use the dedicated inline class so the CSS
      // can render a tighter background than the block variant.
      return <code className="markdown-code-inline rounded-sm bg-code-bg px-1.5 py-0.5 font-mono text-[0.9em]">{children}</code>;
    }
    return (
      <code className={['markdown-code', className].filter(Boolean).join(' ') + ' font-mono text-[0.9em]'}>{children}</code>
    );
  },
  pre: ({ children }: { children?: ReactNode }) => (
    // `.markdown-pre` retained as a semantic anchor — the
    // WebKit scrollbar pseudo-elements (`::-webkit-scrollbar*`)
    // in styles.css style the slim horizontal scrollbar the
    // user agent shows for long lines. Tailwind preflight
    // strips the default scrollbar; utilities can't paint
    // `::-webkit-scrollbar` pseudo-elements, hence the rule
    // is preserved in `@layer components`.
    <pre className="markdown-pre mb-1 mt-2 overflow-x-auto rounded-md border border-border bg-code-bg px-3 py-2 text-[0.88em]">{children}</pre>
  ),
  // GFM table paint (M5 M+ (R3) — the original `.assistant-text-
  // segment table / th / td` rule) lives here so it travels with
  // the renderer; utilities can't reach table-cell borders via
  // table-shorthand compositions cleanly.
  table: ({ children }: { children?: ReactNode }) => (
    <table className="my-2 w-auto max-w-full border-collapse text-[0.9em]">{children}</table>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="border border-border bg-surface-2 px-2 py-1 text-left align-top font-semibold">{children}</th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="border border-border px-2 py-1 text-left align-top">{children}</td>
  ),
  // Heading paint — the legacy rule pinned `h1: 1.15em`, `h2:
  // 1.05em`, `h3/h4: 1em` to keep a long answer compact. We
  // preserve the same scale here with arbitrary em-based
  // text-size utilities.
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="first:mt-0 mb-1 mt-2 text-[1.15em] font-semibold">{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="first:mt-0 mb-1 mt-2 text-[1.05em] font-semibold">{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="first:mt-0 mb-1 mt-2 font-semibold">{children}</h3>
  ),
  h4: ({ children }: { children?: ReactNode }) => (
    <h4 className="first:mt-0 mb-1 mt-2 font-semibold">{children}</h4>
  ),
  // Paragraph, list, blockquote, hr — descendant paint
  // applied at the renderer level (the segment wrapper alone
  // can't reach these without descendant selectors).
  p: ({ children }: { children?: ReactNode }) => (
    <p className="first:mt-0 my-[0.4rem] last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="my-[0.4rem] list-disc pl-6">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="my-[0.4rem] list-decimal pl-6">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li className="my-0.5">{children}</li>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="my-2 border-l-[3px] border-border pl-3 text-muted">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-0 border-t border-border" />,
};

function renderPlainText(text: string): ReactNode {
  if (text === '') return null;
  return text.split('\n').map((line, idx, arr) => (
    <span key={idx}>
      {line}
      {idx < arr.length - 1 ? <br /> : null}
    </span>
  ));
}

function stringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}

/** Narrow a `toolCall.result` value to the `MergedToolResult`
 *  shape that `mergeToolResults` attaches. Returns `null` for
 *  any shape that doesn't match — the caller falls back to the
 *  `pending…` hint, which is the correct user-visible state for
 *  "no result yet" (and also for "result arrived in an
 *  unexpected shape", which is a wire-format drift we don't want
 *  to render in a way that misleads the operator).
 *
 *  Contract:
 *    - `result` must be an object (not a string, number, etc.)
 *    - `text` must be a string (the joined toolResult content)
 *    - `isError` is optional; defaults to `false` when missing.
 *
 *  Pure function; no side effects; cheap enough to call inline
 *  per toolCall block (each assistant message carries at most a
 *  handful). The shape is exported from `toolResultMerge.ts` so
 *  this helper is the only spot in the web package that does the
 *  narrowing — future changes to the result shape ripple through
 *  here + the merge function (one source of truth for the wire
 *  side, one source of truth for the render side). */
function readMergedToolResult(value: unknown): { text: string; isError: boolean } | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.text !== 'string') return null;
  return {
    text: obj.text,
    isError: typeof obj.isError === 'boolean' ? obj.isError : false,
  };
}
