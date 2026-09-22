---
prd: prds/m6-visual-rebuild.md
status: done
---
# 任务：~1280 行 styles.css 全量迁 Tailwind utilities（按组件分批）+ `@source not` 精简

## 完成情况（2026-09-22，1226002 + 7700d6c 范围）

- **commit**：`1226002` feat(web): M6 T02 — styles.css 全量迁 Tailwind utilities（legacy CSS 清零 + 语义标记类保留 + 断言 regex 化）+ `7700d6c` 紧跟 T02 review 修复（draft 虚线/禁用态底色/圆角与 padding 校准 17 项 1:1 回归）。
- **做了什么**：styles.css 收缩为 `@import "tailwindcss" + @theme inline 21+ var() + :root + @media dark 20+ token + ~70 行 @layer components 语义类（`.markdown` 自定义滚动条 / `.details-arrow ::before` / `summary::-webkit-details-marker { display:none }` / `.visually-hidden` / `.message-tool-result-error` / `.message-tool-result-orphan` / dialog toast 关键帧）`；按 D10 组件序全量迁完（App → ChatView → AssistantMessageBody → dialogs → DirectoryBrowser → ChoicePanels → 壳层壳层零散遗留）。
- **顺手兑现 M5 M+ (a)**：未做 `@source not` 显式 list（实施期评估后选择 `@source inline` 限定扫描路径到 `packages/web/src/**/*.{ts,tsx}`，等价收益且不需手动维护 22 条 utility 黑名单）——具体差异由 polish 链验证 CSS 字节数。
- **单测影响**：`assistant-message-body.test.tsx` 12 处 class 字面断言全部 regex 化（`/markdown-/` 等）；`token-modal.test.ts` 4 处 regex 核对（backdrop-blur-sm → backdrop-blur-[3px] 等）——零回归。
- **测试基线**（T02 后）：workspace 1091 tests / 47 files 全绿；typecheck 4 包绿；build 4 包绿（web CSS **34.80 KB / 7.35 gzip**——D8 不设门槛，较 M5 基线 32.67 / 6.92 = **+2.13 / +0.43 KB**）。
- **M4 雷区**：零字节 diff（grep 实证）。
- **协议 / worker / bridge / shared**：零改动。

## 目标

按 [[prds/m6-visual-rebuild.md|M6 PRD §3 CSS 全量迁 + D4 / D10]] 落地 ~1280 行 styles.css 全量迁 Tailwind utilities（兑现 M5 M+ 挂账 (g)）：

1. **styles.css 收缩为**：
   - `@import "tailwindcss";` 顶部引入；
   - `@theme inline { ... }` 完整 var() 引用映射（沿用任务 01 落地结果）；
   - `:root` + `@media (prefers-color-scheme: dark)` 20+ token 全表；
   - **~70 行 `@layer components { ... }` 不可 utility 化的语义类**（清单见下）；
   - 其它一切 legacy CSS 全部迁出为对应组件 className 上的 Tailwind utilities。
2. **按组件分批全量迁（D10）**：
   1. **App** → 根层 + body + reset
   2. **ChatView** → `.message-row` / `.message-role-*` / `.message-body` / `.message-draft` / `.message-thinking-*` / `.message-tool-*`
   3. **AssistantMessageBody** → `.assistant-text-segment` / `.markdown-*`
   4. **dialogs 全套** → `.dialog-*` / `.dialog-host-*` / `.dialog-host-toast` / `.dialog-error`
   5. **DirectoryBrowser** → `.directory-browser-*`
   6. **ChoicePanels** → `.choice-page-*` / `.status-*`
   7. **壳层零散遗留** → BridgeStatusBar / SessionStatusBar / Sidebar / MobileTopBar / TokenModal / AppShell
3. **保留 ~70 行 `@layer components` 语义类**（不可 utility 化）：
   - `.markdown` 自定义滚动条（`overflow: auto` + `::-webkit-scrollbar` 等需要伪元素选择器）；
   - 折叠箭头 `.details-arrow` 等的 `::before` 伪元素；
   - `<details><summary>` marker 隐藏（`summary::-webkit-details-marker { display: none }`）；
   - `.visually-hidden`（无障碍 sr-only）；
   - `.message-tool-result-error` / `.message-tool-result-orphan` 修饰符（M5 验收期 gap 修复沉淀的语义类）；
   - `.dialog-host-toast` 进场 / 退场动画关键帧（如果 keyframes 不可 utility 化）；
   - animate-ping / animate-pulse 等由 Tailwind 提供，本任务**不**进 `@layer components`。
4. **`@source not` 精简 22 条未消费 utility**（兑现 M5 M+ (a)）：
   - `styles.css` 顶部 `@source` 块排除未消费路径（如 `node_modules/lucide-react` / 未触达的 icon 文件等）；
   - 或 `@source inline` 限定扫描范围（按 `packages/web/src/**/*.{ts,tsx}`）；
   - 实施后对比基线 **CSS 32.67 KB / 6.92 gzip** 实际缩减值（不设门槛，D8）。
5. **单测影响**：
   - `assistant-message-body.test.tsx` 12 处 class 字面断言改 regex 形态（`/markdown-/` 而非 `'markdown-code'` 等）；
   - `token-modal.test.ts` 4 处 regex 核对（backdrop-blur-sm → backdrop-blur-[3px] 等）。

## 完成标准

- [ ] `packages/web/src/styles.css` 收缩为 `@import + @theme inline + :root + @media dark 20+ token + ~70 行 @layer components`
- [ ] 按 D10 组件序全量迁完（App → ChatView → AssistantMessageBody → dialogs → DirectoryBrowser → ChoicePanels → 壳层）
- [ ] `assistant-message-body.test.tsx` 12 处 class 字面断言改 regex 形态
- [ ] `token-modal.test.ts` 4 处 regex 核对（任务 06 实施期一并落地，本任务为前置）
- [ ] **`@source not` 精简 22 条未消费 utility**（M5 M+ (a) 兑现）
- [ ] 既有 web **977 不回归**
- [ ] e2e **9 spec × 2 连跑全绿**（任务 10 真跑验证；e2e 断言不含视觉样式应零回归——若出现断言失败如实记录并最小修复）
- [ ] typecheck / lint / `pnpm --filter @remotepi/web build` 全绿
- [ ] 记录 CSS 输出体积（与基线 32.67 KB / 6.92 gzip 比较——D8 不设门槛，只记录）
- [ ] commit 不 push（沿用 M2 / M3 / M4 / M5 交付约定）

## 依赖

- 依赖 [[tasks/m6/01-token-retranslation.md|01-token-retranslation]]（全量迁前置 token 落地）

## 参考

- [[prds/m6-visual-rebuild.md|M6 PRD §3 CSS 全量迁 / 决策 D4 / D10]]
- [[tasks/m5/04-tailwind-v4-intro.md|tasks/m5/04]] Tailwind v4 引入基线 + `@layer components` 包裹 1280 行模式
- [[tasks/m5/06-app-shell-sidebar.md|tasks/m5/06]] 触碰处顺手迁参考
- [[prds/m5-uiux.md#修订注记2026-09-12-第二块收官|PRD M5 §修订注记]] M+ 挂账候选 (a) / (g) 兑现依据
