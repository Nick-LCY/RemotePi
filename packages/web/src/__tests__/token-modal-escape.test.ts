// Vitest specs for the M5 task 08 review W2 fix on TokenModal —
// **单一 keydown 监听源** (single keydown listener source).
//
// ## What this guards against
//
// 任务 07 落地时，TokenModal 组件内有两个独立的 Escape 处理源：
//
//   1. `useFocusTrap({ active: !required, containerRef, onEscape:
//      !required ? onClose : undefined })` — document 级 keydown
//      listener，由 `useFocusTrap` 内部 useEffect 挂载，Escape
//      触发 `onEscape` 回调（即 onClose）。
//   2. 一个独立的 `useEffect(() => { window.addEventListener(
//      'keydown', ...); return () => removeEventListener })` —
//      window 级 keydown listener，Escape 也触发 `onClose?.()`。
//
// 两个 listener 在 closable 模式下都激活 → 一次 Escape 键触发
// onClose **两次**（modal 第一次关闭 onClose → 第二次关闭时
// onClose 已是 undefined；即便不崩，也是双触发污染）。
//
// 修法（task 08 W2）：删独立 useEffect，`useFocusTrap` 作为
// Escape 的唯一入口（required 模式本就无 Escape — Trap 的
// `active=false` 路径不挂 listener）。
//
// ## 覆盖方式 (如实记录)
//
// 项目 ADR-0009 §决策 4 明确「无 jsdom / happy-dom web 测试
// 基建」——hook 行为通过抽取的纯函数（`runFocusTrapKeydown`）测
// 试；DOM 集成由 e2e suite 覆盖（Playwright 真浏览器）。
//
// 本测试走**结构钉桩**路径（structural pin），验证：
//
//   1. TokenModal 源码**不包含**任何独立挂载 keydown listener
//      的 `window.addEventListener` / `document.addEventListener`
//      调用（除注释中解释历史的字面提及外）。
//   2. TokenModal 仍调用 `useFocusTrap` 并把 `onEscape` 接到
//      `onClose`（closable 模式契约）。
//   3. required 模式下 `useFocusTrap` 的 `active=false`（Escape
//      listener 不挂载 — D10 「不可关闭」语义）。
//
// 行为层「Escape 在 closable 模式下恰好触发一次 onClose」的真
// 实验证由以下两层承担：
//
//   - **单元层**：`use-focus-trap.test.ts` 已覆盖
//     `runFocusTrapKeydown` 在 Escape 上调 onEscape 一次（5.5
//     「Escape 触发 onEscape 回调」单测钉桩）。本组件把 onClose
//     接到 onEscape 是同形接线（5.6 「Escape 无 onEscape 回调
//     → 不抛异常」也是同钉桩）。
//   - **e2e 层**：`tests/e2e/specs/09-mobile-drawer.spec.ts`
//     step 6 写明「若 closable 路径在 e2e 可达（settings 按钮
//     路径若可达；不可达则标注留待手测），验证 Esc 恰好关一次
//     modal」（任务书 §b.6）。
//
// 综合：源码钉桩 + useFocusTrap 行为单测 + e2e 步骤，三层覆盖。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve relative to this test file (lives in
// packages/web/src/__tests__/). The component source is two
// directories up at `components/TokenModal.tsx`.
const TOKEN_MODAL_SOURCE_PATH = fileURLToPath(
  new URL('../components/TokenModal.tsx', import.meta.url),
);

/** Read the TokenModal source once at module load. The fix is
 *  structural, so we just need a fresh read per test invocation
 *  (vitest re-imports the module on `pnpm test`, so this is fine). */
function readTokenModalSource(): string {
  return readFileSync(TOKEN_MODAL_SOURCE_PATH, 'utf8');
}

// ---------------------------------------------------------------------------
// W2 — 单一 keydown 监听源（structural pin）
// ---------------------------------------------------------------------------

describe('TokenModal — W2 单一 keydown 监听源 (structural pin)', () => {
  it('1. 组件源码内不存在独立的 window.addEventListener("keydown", ...) 调用', () => {
    // 删除独立 useEffect 的判据：历史上该模式为
    //   useEffect(() => {
    //     window.addEventListener('keydown', (event) => {
    //       if (event.key === 'Escape') onClose?.();
    //     });
    //     ...
    //   }, [...]);
    // 任何「真实的」window/document keydown 注册调用都应通过
    // useFocusTrap 路径（其内部 useEffect 已抽到
    // use-focus-trap.ts），本组件体不再含这类调用。
    //
    // 注意：本断言排除注释行（含历史修复说明的字符串提及）。
    const source = readTokenModalSource();
    // 拆成行，剔除 `//` 注释 + JSDoc 块，避免误伤。
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
    const codeBody = codeLines.join('\n');
    // 正则匹配「真实的」addEventListener 调用（不在注释/字符串
    // 提及中）。`window.addEventListener('keydown', ...)` 形态
    // 是修复前的历史代码模式。
    const windowKeydownPattern = /window\.addEventListener\(\s*['"]keydown['"]/;
    const documentKeydownPattern = /document\.addEventListener\(\s*['"]keydown['"]/;
    expect(
      windowKeydownPattern.test(codeBody),
      'TokenModal.tsx still contains a window.addEventListener("keydown", ...) call — ' +
        'this would double-fire onClose on Escape. The W2 fix should remove any such listener ' +
        'and rely on useFocusTrap as the single Escape source.',
    ).toBe(false);
    expect(
      documentKeydownPattern.test(codeBody),
      'TokenModal.tsx still contains a document.addEventListener("keydown", ...) call — ' +
        'this would double-fire onClose on Escape. The W2 fix should remove any such listener ' +
        'and rely on useFocusTrap as the single Escape source.',
    ).toBe(false);
  });

  it('2. 组件仍调用 useFocusTrap（closable 模式下 Escape 通过 trap 路径触发）', () => {
    // 修法的另一面：删独立 listener ≠ 完全去掉 Escape 支持。
    // closable 模式下 Escape 必须仍能关闭 modal — 这是
    // useFocusTrap 的 `onEscape` 路径。
    const source = readTokenModalSource();
    // useFocusTrap 调用存在（导入 + 调用）。
    expect(source).toMatch(/import\s*\{[^}]*useFocusTrap[^}]*\}\s*from\s*['"][^'"]*useFocusTrap/);
    // 关键契约：useFocusTrap 调用中包含 `onEscape: !required ? onClose : undefined`
    // 形态（closable 模式接线，required 模式显式 undefined 跳过）。
    expect(source).toMatch(/useFocusTrap\s*\(\s*\{[\s\S]*?onEscape\s*:\s*!required\s*\?\s*onClose\s*:\s*undefined/);
  });

  it('3. required 模式下 useFocusTrap 的 active=false (Escape listener 不挂载 — D10 不可关闭)', () => {
    // D10 明确：required 模式不可关闭（无 Esc / 无遮罩 / 无 X）。
    // useFocusTrap 的 `active=false` 路径内部 useEffect 不挂
    // document keydown listener（详见 use-focus-trap.ts hook
    // 实现）。
    const source = readTokenModalSource();
    // 关键契约：`active: !required` — required=true → false
    // （Escape listener 不挂）；required=false → true。
    expect(source).toMatch(/useFocusTrap\s*\(\s*\{[\s\S]*?active\s*:\s*!required\b/);
  });

  it('4. 组件内不残留任何 Escape key 处理 if 分支（除注释外）', () => {
    // 双重保护：即便未来有人不小心又加上 window.addEventListener
    // 但忘了 import / 没触发，也可能以 `if (event.key === 'Escape')`
    // 形态出现。本断言确保 body 代码不包含 `if (event.key === 'Escape')`
    // / `if (event.key === "Escape")` 分支。
    const source = readTokenModalSource();
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
    const codeBody = codeLines.join('\n');
    expect(
      /if\s*\(\s*event\.key\s*===?\s*['"]Escape['"]/.test(codeBody),
      'TokenModal.tsx body still contains an Escape key handling branch — ' +
        'all Escape handling should be delegated to useFocusTrap (single source).',
    ).toBe(false);
  });
});
