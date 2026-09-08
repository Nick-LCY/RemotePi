// Test extension loaded by `pi --mode rpc` from the fixture agent-dir
// (`<agentDir>/extensions/test-ext.ts`). Pi discovers this file via its
// global extension loader (`agent-dir/extensions/`), loads it with
// `jiti` + virtualModules, and exposes the `pi.registerTool` API.
//
// ## Why this lives in a TypeScript file
//
// Pi's extension loader (`@earendil-works/pi-coding-agent@0.85.1`
// `dist/core/extensions/loader.js`) is jiti-based and reads source as
// `.ts` directly. We deliberately keep the source as `.ts` rather than
// pre-compiling to `.js` because (a) jiti handles transpilation inline
// so no build step is needed in tests, and (b) the `.ts` extension is
// the canonical convention for pi extensions — the loader filters on
// `extension.ts` / `index.ts` filenames (see `resolveExtensionEntries`
// in the loader) and silently skips files without those suffixes.
//
// ## Why we use plain JSON-Schema objects (not typebox)
//
// `pi.registerTool.parameters` accepts a `TSchema` (TypeBox) but pi
// only reads `.properties` + `.required` off the value when sending
// to the Anthropic SDK (`pi-ai/providers/anthropic-messages.js`
// `convertTools`). A plain JSON-Schema object with the same shape
// passes through unchanged. This sidesteps the "typebox bare import
// resolution from inside `agent-dir/extensions/`" concern entirely:
// no node_modules walk is needed because the file has no bare imports.
//
// If a future test case needs typebox for richer schema features
// (unions, refinements), pi's loader exposes it as a virtualModule
// (`jiti`'s `virtualModules` option maps `typebox` → pi's bundled
// typebox at the loader level — see loader.js:20) so the import
// resolves without the host filesystem needing `node_modules/typebox`.
//
// ## Tool API surface (verified against loader.js + types.d.ts)
//
// `pi.registerTool({name,label,description,parameters,execute})`:
//   - `execute(toolCallId, params, signal, onUpdate, ctx)` — `ctx.ui.*`
//     has 4 blocking methods (select/confirm/input/editor) that emit
//     `extension_ui_request` events on stdout, plus fire-and-forget
//     helpers (notify/setStatus/setWidget/setTitle/set_editor_text).
//
// ## Triggering UI dialogs from a tool call
//
// The fake LLM server scripts a tool_use block that calls
// `trigger_dialog(kind: 'select' | ...)`. The extension maps the kind
// to the matching `ctx.ui.*` method and returns a text block whose
// payload makes the dialog result observable (e.g. `selected=alpha`,
// `confirmed=true`, `input=hello`). The test cases pin the result
// text so any drift in pi's `extension_ui_request` ↔ bridge ↔ web
// round-trip is caught immediately.
//
// ## Cancelled semantics
//
// pi 0.85.1 (`rpc-mode.js`) maps `cancelled: true` to `undefined`
// for select/input/editor and `false` for confirm — the extension
// mirrors this so the resulting tool text carries the right suffix
// (`selected=undefined` would look like a bug, so we explicitly
// spell out `cancelled`). The bridge's `translateToPiNative`
// (`packages/bridge/src/extension-ui.ts`) is the canonical place that
// defines this mapping; the extension mirrors it intentionally.
//
// ## Type annotations
//
// We deliberately DON'T import from `@earendil-works/pi-coding-agent`:
// the extension runs inside pi's loader (not under tsconfig of the
// tests/integration project) and adding that import would also force
// the typebox dep. The shapes below are minimal structural types —
// just enough for static checking in the tests/integration tsconfig.
// At runtime, pi passes plain objects; the type annotations are
// purely cosmetic.

// ---------------------------------------------------------------------------
// Minimal extension API types (intentionally narrow — see file header)
// ---------------------------------------------------------------------------

interface ExtensionAPI {
  registerTool(tool: ToolDefinition): void;
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

interface ExtensionContext {
  ui: ExtensionUIContext;
}

interface ExtensionUIContext {
  select(
    title: string,
    options: string[],
    opts?: { timeout?: number },
  ): Promise<string | undefined>;
  confirm(
    title: string,
    message: string,
    opts?: { timeout?: number },
  ): Promise<boolean>;
  input(
    title: string,
    placeholder?: string,
    opts?: { timeout?: number },
  ): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: string[] | undefined,
    options?: { placement?: string },
  ): void;
  setTitle(title: string): void;
  setEditorText(text: string): void;
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

type DialogKind = 'select' | 'confirm' | 'input' | 'editor' | 'echo';

function readKind(raw: unknown): DialogKind {
  if (
    raw === 'select' ||
    raw === 'confirm' ||
    raw === 'input' ||
    raw === 'editor' ||
    raw === 'echo'
  ) {
    return raw;
  }
  throw new Error(`trigger_dialog: unknown kind "${String(raw)}"`);
}

function readOptionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

function readOptionalStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((v): v is string => typeof v === 'string');
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['select', 'confirm', 'input', 'editor', 'echo'],
      description: 'which dialog kind to trigger (or "echo" for no dialog)',
    },
    title: { type: 'string', description: 'dialog title (where applicable)' },
    options: {
      type: 'array',
      items: { type: 'string' },
      description: 'options for select',
    },
    message: { type: 'string', description: 'message for confirm' },
    placeholder: { type: 'string', description: 'placeholder for input' },
    prefill: { type: 'string', description: 'prefill for editor' },
  },
  required: ['kind'],
};

async function executeTriggerDialog(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((u: unknown) => void) | undefined,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const kind = readKind(params['kind']);
  const title = readOptionalString(params['title']) ?? 'Test dialog';
  switch (kind) {
    case 'select': {
      const options = readOptionalStringArray(params['options']) ?? ['a', 'b', 'c'];
      const v = await ctx.ui.select(title, options);
      // pi returns undefined on cancel; mirror that to the test text.
      return { content: [{ type: 'text', text: `selected=${v ?? 'cancelled'}` }] };
    }
    case 'confirm': {
      const v = await ctx.ui.confirm(title, readOptionalString(params['message']) ?? 'ok?');
      // pi returns false on cancel; the text is the boolean verbatim so
      // both the "yes" and "no" paths are observable.
      return { content: [{ type: 'text', text: `confirmed=${v}` }] };
    }
    case 'input': {
      const v = await ctx.ui.input(title, readOptionalString(params['placeholder']));
      return { content: [{ type: 'text', text: `input=${v ?? 'cancelled'}` }] };
    }
    case 'editor': {
      const v = await ctx.ui.editor(title, readOptionalString(params['prefill']));
      return { content: [{ type: 'text', text: `editor=${v ?? 'cancelled'}` }] };
    }
    case 'echo': {
      // No-dialog branch — returns a sentinel text. Used by the
      // fire-and-forget coverage test that fires notify/setStatus and
      // expects the tool result to flow back without entering blocked_on.
      return { content: [{ type: 'text', text: 'echo:ok' }] };
    }
  }
}

export default function register(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'trigger_dialog',
    label: 'Trigger Dialog',
    description:
      'Test extension tool: opens one of 4 blocking UI dialogs (select / confirm / input / editor) or returns an echo sentinel for fire-and-forget coverage.',
    parameters: PARAMETERS,
    execute: executeTriggerDialog,
  });
}
