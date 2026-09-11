---
prd: prds/m5-uiux.md
status: done
---
# 任务：InputBar textarea 升级（换行 + 自动增高 + IME 守卫）

## 目标
按 [[prds/m5-uiux.md|M5 PRD §4 + 验收标准 + D5]] 升级 InputBar：

1. **`<input type="text">` → `<textarea rows={1}>`**——基本形态切换；testid `input-field` **保留**（Playwright `.fill()` 兼容 textarea）。
2. **新建 `useAutoResizeTextarea` hook**（`packages/web/src/hooks/useAutoResizeTextarea.ts`）——`useLayoutEffect` + `scrollHeight` 计算 → `max-height: 200px` / `overflow-y: auto`；输入清空回单行；动态内容触发重算。
3. **`onKeyDown`**：
   - `Enter` 无 `Shift` 且 **非 IME 组合中（`event.nativeEvent.isComposing` 守卫）** → submit；
   - `Shift+Enter` 原生换行；
   - IME 组合期 `Enter` 走原生行为（候选上屏），不触发 submit；
   - `event.key === 'Enter'` + `shiftKey === false` + `!isComposing` 三件套同时满足才 submit。
4. **`styles.css .input-bar-field` 适配**：`resize: none` / `min-height: 32px` / `max-height: 200px` / `overflow-y: auto` / `align-items: center` 调整（textarea 对齐）。
5. **行为不变项**：`placeholders` / `disabled` / `commandError`（5s）/ `settledHint` 全部沿用；提交后清空逻辑不变；abort 按钮（`input-abort` testid）行为不变。

## 完成标准
- [x] `packages/web/src/components/InputBar.tsx`（或等价组件）：`<input type="text">` 替换为 `<textarea rows={1}>`；testid `input-field` 保留
- [x] **`onKeyDown`** 三件套守卫（Enter + !Shift + !isComposing → submit；Shift+Enter 换行；IME 组合期不 submit）
- [x] **新建 `packages/web/src/hooks/useAutoResizeTextarea.ts`**：`useLayoutEffect` + `scrollHeight` 计算 + `max-height: 200px` + `overflow-y: auto` + 清空回单行
- [x] `packages/web/src/styles.css`：`.input-bar-field` 适配（`resize: none` / `min-height` / `max-height: 200px` / `overflow-y: auto` / `align-items` 调整）；新增 `--input-max-height: 200px` 变量
- [x] **新增 `use-auto-resize-textarea.test.ts` ≥5 条**（空内容单行 / 1 行 / 多行未超 max / 多行超 max 触发滚动 / 清空回单行）+ **InputBar keyDown 单测 ≥3 条**（Enter send / Shift+Enter newline / IME isComposing 不 submit）
- [x] 既有 web **185 条不回归**
- [x] e2e fill/click 兼容——Playwright `.fill('input-field')` 对 textarea 兼容；既有 e2e 03 spec 不修改
- [x] **testid 锚点不动**：`input-field` / `input-send` / `input-abort` / `message-draft` 等锚点 0 增 0 删
- [x] `pnpm --filter @remotepi/web build` / `pnpm run lint` / `pnpm run typecheck` / `pnpm run test` 全绿
- [x] web build 变化 ≤ 5 KB（与 [[tasks/m5/01-web-markdown-render.md|01-web-markdown-render]] 累加后总 ≤ 350 KB）

## 依赖
- 无（web 单端改动；与 [[tasks/m5/01-web-markdown-render.md|01-web-markdown-render]] 零代码交集，串行执行避免 styles.css 冲突）

## 参考
- [[prds/m5-uiux.md|M5 PRD §4 + 验收标准 + D5]]
- [[tasks/m4/06-bridge-session-layer.md|tasks/m4/06]] 既有 web 185 条基线
- [[tasks/m4/10-e2e-and-validation.md|tasks/m4/10]] e2e 03 spec InputBar 基线

## 完成情况（2026-09-11）

任务完成，**2 笔本地 commit 未 push**（沿用 M2 / M3 / M4 交付约定，本任务入档后与 01 / 03 同列，**M5 第一块全部 5 笔代码 commit 在 03 验收后由用户 push** 触发 Actions CD；详见 [[current-state.md#活跃需求|活跃需求]] M5 行）。

### Commit 链

- **`f28295f`** feat(web): M5 任务02 —— InputBar textarea 升级（换行 + 自动增高 + IME 守卫）（落地 `input→textarea rows={1}` + `decideKeyDownAction` 纯函数抽离 + `useAutoResizeTextarea` hook + `computeTargetHeight` 纯函数 + styles.css `--input-max-height: 200px` + 9 条 `input-bar-keydown.test.ts` + 7 条 `use-auto-resize-textarea.test.ts`）。
- **`0594767`** fix(web): 任务02 review 收尾 —— 测例去重 + Safari 229 防御 + 契约措辞校准。

### 实施要点

- **`input→textarea rows={1}`**——基本形态切换；testid `input-field` **保留**（Playwright `.fill()` 同时支持 input / textarea，e2e 03 spec 等 5 个 spec 既有用例零修改通过）。
- **`decideKeyDownAction` 纯函数**（`packages/web/src/components/inputBarKeydown.ts` 新建，PRD §4 字面未细化文件名）——把 keyDown 决策从 `InputBar.tsx` 抽离成纯函数（输入 `{ key, shiftKey, isComposing, keyCode? }` → 输出 `'submit' | 'newline' | 'ignore'`），便于单测覆盖（9 条）；同时给 03 spec 等 e2e 边界（keyCode 229 legacy WebKit）一致判据。
- **`onKeyDown`** 三件套守卫：`event.key === 'Enter'` + `shiftKey === false` + `!isComposing` → submit；`Shift+Enter` 原生换行；IME 组合期 `Enter` 走原生行为（候选上屏），不触发 submit；**新增 Safari keyCode 229 守卫**（legacy WebKit IME composition 路径即使 `isComposing === false` 也视为组合中——实测部分 macOS Safari 版本在中文拼音输入完成瞬间 `isComposing` 已归零但浏览器内部仍按 IME 组合路径发送 keyCode 229 Enter）→ `keyCode === 229` 一律 `ignore`。
- **`useAutoResizeTextarea` hook**（`packages/web/src/hooks/useAutoResizeTextarea.ts` 新建）——`useLayoutEffect` + `scrollHeight` 计算 → `max-height: 200px`（导出常量 `DEFAULT_TEXTAREA_MAX_HEIGHT = 200` 与 styles.css `--input-max-height` 配对，单测 2.1 钉桩 JS/CSS 契约）/ `overflow-y: auto`；输入清空回单行（`scrollHeight === 0` → `height = 0`）；动态内容触发重算（监听 `value` 变化与 `ResizeObserver` 兜底）。
- **`computeTargetHeight` 纯函数**（同文件）——`clamp(scrollHeight, 0, maxHeight)`；7 条单测覆盖 0 / 32 / 96 / 200 / 280 / 自定义 80 等边界。
- **`styles.css` `.input-bar-field` 适配**——`resize: none` / `min-height: 32px` / `max-height: var(--input-max-height)` / `overflow-y: auto` / `align-items: flex-end`（textarea 多行态对齐收益换来的——见「设计注记」）；新增 `--input-max-height: 200px` 变量（与 `DEFAULT_TEXTAREA_MAX_HEIGHT` 契约钉桩）。
- **行为不变项**：`placeholders` / `disabled` / `commandError`（5s）/ `settledHint` 全部沿用；提交后清空逻辑不变；abort 按钮（`input-abort` testid）行为不变。

### Review 轮次

- **Round1**（reviewer 4 项：0C / 4W）：
  - **W1（warning，修改）**：`input-bar-keydown.test.ts` 测例与既有 `web-state-bucket` IME 相关测例重复（`isComposing` 三件套断言覆盖重复）→ 合并去重到 `input-bar-keydown.test.ts §3` 段并删除 web-state-bucket 端冗余。
  - **W2（warning，修改）**：决策函数 JSDoc 措辞过强（"Enter submit 与否由本函数独占决策"暗示 web 其他入口不触发）→ 措辞校准为 "本函数封装 InputBar 内的 onKeyDown 决策；web 其他事件源（点击按钮、剪贴板粘贴）不在范围"。
  - **W3（warning，记录）**：单行态 Send/Abort 按钮较原 center 对齐下移 2-4px（textarea `align-items: flex-end` 带来的视觉微移）→ **已接受**为多行态对齐收益（flex-end 与 textarea 多行底沿对齐，center 与 input 单行对齐）。
  - **W4（warning，修改）**：Safari keyCode 229 legacy WebKit IME composition 路径 `isComposing === false` 但仍按 IME 组合发送 Enter——首版漏覆盖 → 加 `keyCode === 229` 一律 `ignore` 守卫 + §3.2 钉桩。
- **Round2**（5 项全过）：S1 措辞校准 + S2 `DEFAULT_TEXTAREA_MAX_HEIGHT` 导出（JS / CSS 契约可单测）+ S3 文档加注 Safari 229 路径 + S4 commit `0594767` 收尾测例去重 + S5 契约措辞软化。

### 关键数字

- **单测**：基线 704 → **765**（+61 含本任务 9 + 7 = 16 条），30 文件全绿。
- **集成 / typecheck / lint / build / e2e**：与 [[tasks/m5/01-web-markdown-render.md|01]] 同口径（详见 [[tasks/m5/03-e2e-and-validation.md#关键数字终验2026-09-11|03 关键数字]]）。
- **`testid` 锚点零改动**：grep `data-testid="input-field|input-send|input-abort"` 命中 0 增 0 删。
- **e2e**：8 spec × 2 连跑全绿，03 spec `page.fill('input-field')` 对 textarea 兼容（Playwright `.fill()` 跨 input/textarea 一致接口）。

### 设计注记（实施期发现 / 备查）

1. **单行态 Send/Abort 按钮视觉微移 2-4px（下移）**——textarea `align-items: flex-end` 让单行态按钮较原 `<input>` `align-items: center` 对齐下移。**取舍**：多行态 `flex-end` 与 textarea 底沿对齐（更整齐）；单行态 `center` 与 `<input>` 居中对齐（按钮水平居中）。**已接受**为多行态对齐收益；M+ 候选：CSS `:has(textarea:placeholder-shown)` 切换 `align-items` 走单行/多行两态——目前 2-4px 微移不影响可读性 / 可点击区域，登记备查。
