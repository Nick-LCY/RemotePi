// AssistantMessageBody — terminal-state renderer for assistant
// messages (M5 §1 + §2 — react-markdown + remark-gfm +
// rehype-sanitize, folded thinking + toolCall pills, D6 keeps
// user / toolResult on the old plain-text path).
//
// Composition rules:
//   - `content: string` → plain text (D6 — user / toolResult
//     messages stay on this path; assistant messages with a
//     string content take the same path for backward compat).
//   - `content: Array<...>` → dispatch by `piece.type`:
//       - `text` → ReactMarkdown (GFM + sanitize)
//       - `thinking` → `<details>` default folded, plain-text body
//       - `toolCall` → folded pill (summary = 🔧 + name; body =
//         参数 (stringifySafe(arguments)) + 结果 (`result.text` 当
//         有 MergedToolResult; D4 裁定 keeps the result
//         untruncated); `result.isError === true` 时结果区加
//         `.message-tool-result-error` 样式)
//       - 未知 type → 纯文本 fallback (extractText path)
//   - `null` / `undefined` → empty container (the user sees no
//     body — this matches the M3 "missing content" fallback and
//     keeps the surrounding `.message-body` anchor alive for the
//     e2e testid contract).
//
// Sanitize (D1 — rehype-sanitize default schema):
//   - rejects `<script>` (no script tag in output)
//   - strips `onerror` / `onclick` / … event handlers
//   - rewrites `href="javascript:…"` → `href` removed
//
// React 18 + Vite friendly: the component is a pure function
// (no hooks, no side-effects) and serialises through
// `react-dom/server.renderToStaticMarkup` for the unit tests —
// the suite intentionally avoids pulling in a jsdom / happy-dom
// runtime (project policy, see `choice-page-flow.test.ts` header
// + ADR-0009 §决策 4).
//
// M5 验收期 gap — toolResult 渲染层归并：
//   - `toolCall.result` 形状从过去的任意对象收紧为 `MergedToolResult`
//     （`{text: string, isError: boolean}`），由 `mergeToolResults`
//     在 ChatView 层挂到 toolCall 块上；本组件只读取它，不做任何
//     推断或回退。
//   - `result` 未到（assistant 刚落地、toolResult 还在路上）→ 保留
//     现有 `pending…` 提示（此为精确的瞬态语义，不是缺陷）。

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
        <div className="assistant-text-segment" data-testid="assistant-text-segment">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
            // The `markdownComponents` object is typed as a
            // plain `Record<string, unknown>` (see comment
            // above) — `ReactMarkdown` accepts a strict
            // `Components` shape keyed by HTML tag names, but
            // the per-component prop types don't match the
            // hast-Element-aware strict shape without dragging
            // in a `hast` types dep. TS infers the broader
            // `Record<string, unknown>` as compatible at the
            // call site.
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
        <details
          className="message-thinking-details assistant-thinking"
          data-testid="assistant-thinking"
        >
          <summary className="thinking-summary">思考过程</summary>
          <div className="thinking-body">{thinking}</div>
        </details>
      );
    }
    case 'toolCall': {
      const name = typeof obj.name === 'string' ? obj.name : 'tool';
      const args = obj.arguments;
      const result = obj.result;
      // M5 验收期 gap fix — `result` shape is the `MergedToolResult`
      // attached by `mergeToolResults` (see
      // `components/toolResultMerge.ts`): `{text, isError}`.
      // Anything else (older test fixtures that pass an arbitrary
      // object, drift in the wire shape) falls through to the
      // `pending…` hint rather than rendering an unexpected
      // structure — the merge function is the single source of
      // truth for `result` shape today.
      const mergedResult = readMergedToolResult(result);
      return (
        <details
          className="message-tool-details assistant-tool-call"
          data-testid="assistant-tool-call"
        >
          <summary className="message-tool-pill">
            <span aria-hidden="true">🔧</span> {name}
          </summary>
          <div className="message-tool-body">
            <strong>参数</strong>
            <pre className="message-tool-args">{stringifySafe(args ?? {})}</pre>
            {mergedResult !== null ? (
              <>
                <strong>结果</strong>
                <pre
                  className={
                    mergedResult.isError
                      ? 'message-tool-result message-tool-result-error'
                      : 'message-tool-result'
                  }
                  data-testid={mergedResult.isError ? 'assistant-tool-result-error' : 'assistant-tool-result'}
                >
                  {mergedResult.text}
                </pre>
              </>
            ) : (
              <p className="message-tool-pending">pending…</p>
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
const markdownComponents: Record<string, unknown> = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    // M5 review S3 — `mailto:` links should NOT open in a new
    // tab. The browser routes them to the OS mail client
    // (which a tab/window handle can't reach anyway), and
    // forcing `target="_blank"` would spawn a useless blank
    // tab the user has to close. Same idea for any other
    // protocol the browser doesn't open inline — we let the
    // browser follow its default behaviour. The
    // `target="_blank" rel="noreferrer"` hardening is only
    // applied to http(s):// URLs, which are the actually-
    // navigable targets where referrer leakage + tab-jacking
    // are real risks.
    const isExternal = href !== undefined && /^(https?:)/i.test(href);
    return (
      <a
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
      return <code className="markdown-code-inline">{children}</code>;
    }
    return (
      <code className={['markdown-code', className].filter(Boolean).join(' ')}>{children}</code>
    );
  },
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="markdown-pre">{children}</pre>
  ),
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
