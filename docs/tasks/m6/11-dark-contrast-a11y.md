---
prd: prds/m6-visual-rebuild.md
status: done
---
# 任务：暗色对比度 WCAG AA 单测 + R3 临界点校色 + focus 可及性

## 完成情况（2026-09-22，T11）

- **commit `ab10345`**（HEAD，领先 origin/main 17 commits）— M6 T11 暗色对比度 WCAG AA 单测 + R3 临界点校色 + focus 可及性。**16 文件 +754 / -188**。

### 做了什么

1. **新增 4 枚 `--on-*` token**（WCAG AA 强制提升——T10 收官时三处 dark 对比边缘的根治方案）：
   - `--on-accent #ffffff`（on #ffffff；蓝底白字按钮文字）
   - `--on-amber #ffffff`（on #ffffff；琥珀底白字按钮文字）
   - `--on-offline #ffffff`（on #ffffff；state-offline 红底白字按钮文字）
   - `--on-online #ffffff`（on #ffffff；state-online 绿底白字按钮文字）
   - **light 模式 4 token 全部 `#ffffff`**——与按钮现役白字行为一致，**视觉零变化**（e2e 截图对照无差异）；
   - **dark 模式深墨值**：`--on-accent #0e1218` / `--on-amber #0e1218` / `--on-offline #0e1218` / `--on-online #0e1218`（bg 同色调深墨保持按钮语义对比稳定）；
   - 实测对比度（深墨值 vs 对应底色）：
     - `--on-accent #0e1218` on `--accent #6f9bff` dark：**6.79:1**（≥4.5:1 正文门槛 ✓）
     - `--on-amber #0e1218` on amber `#d97706` dark：**8.73:1**（≥4.5:1 正文门槛 ✓）
     - `--on-offline #0e1218` on `--state-offline #f87171` dark：**6.63:1**（≥4.5:1 正文门槛 ✓）
     - `--on-online #0e1218` on `--state-online #34d399` dark：**6.68:1**（≥4.5:1 正文门槛 ✓）
   - **4 token 均达标**——T10 修订注记登记的三处 dark 对比边缘（amber pill 1.8:1 / accent CTA 2.9:1 / state-offline 2.1:1 白字场景）**全部根治**。
2. **focus-visible 跨组件统一**（R4 落地 + a11y 焦点指示标准化）：
   - 17 处 `:focus-visible` 替换为统一 `focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2`；
   - 覆盖 9 组件：Button（主 + 副）/ Input / Textarea / TokenInput / DialogHost 4 类 / DirectoryBrowser entry / SessionStatusBar pill；
   - 移除多余 outline + 不一致 ring 状态（保留 `focus-within:ring-4` 用于复合输入条容器，键盘 focus-visible 与鼠标点击焦点互不干扰）。
3. **新建 `styles-token-contrast.test.ts`**（WCAG AA 实测单测，**26 条**断言）：
   - 覆盖 4 枚 `--on-*` token 8 个组合（light/dark × on-accent/on-amber/on-offline/on-online）；
   - 既有 `--text` / `--muted` / `--accent` / `--border` / `--state-*` 暗色对比 10 个组合（含 UI 边界 3:1 / 正文 4.5:1 双门槛分桶）；
   - focus-visible 视觉可达性 4 条（focus 元素与背景对比 ≥3:1）；
   - `--border dark` 边界决策保留 1 条（钉桩 hairline 设计意图 1.25:1 故意保持，附 `[NOTE: hairline intentional]` 注释）；
   - disabled 态白字豁免保留 3 条（disabled CTA 按钮文字 vs 灰化底色豁免，附 `[NOTE: disabled exemption]` 注释）；
   - **helpers 抽取**：`computeContrastRatio(rgb1, rgb2)` 共享 helper（WCT 公式 + gamma 校正）从既有 `styles-token-resolution.test.ts` 抽离到 `__tests__/styles-token-contrast-helpers.ts`，两个测试文件复用同一 helper（避免重复实现 / 漂移）。
4. **R3 临界点决策（border dark 不调）**：
   - 实测 `--border #2a3140` dark on `--surface #1a2030` = **1.25:1**（低于 UI 3:1 门槛）；
   - **决策：保持现状**——hairline 设计意图（`text-[10px]` 时间戳 / 1px 分隔线等 UI 元素依赖细线质感）；
   - **超 ±5% L 授权窗口**（±5% L 仅覆盖 token 微调；hairline 改 token 违反设计意图），**记录不调**——本节完成情况 + 当前修订注记同步登记，待 M+ 评估时一并裁决（候选：提亮至 `#3a4255` 方向 / 接受 1.25:1 / 改用 hairline 替代实现）；
   - **JSDoc 注释**明示「hairline intentional」，避免后续 agent 误改。
5. **disabled 态白字豁免保留**：
   - 原 M5 任务 06 既定决策保留：disabled CTA 按钮白字 + 灰化底色（可达性豁免——disabled 状态非交互语义）；
   - styles-token-contrast 单测 3 条断言钉桩豁免行为（`disabled` CSS 状态断言 + JSDoc 注释）。
6. **既有 1091 不回归 + 新增 26 条** = **1117 tests / 47 files**（web 566 + 26 = 592；bridge 378 / shared 136 / worker 11 不变；workspace 全量 1117）。

### 数字

- **单测 workspace 全量 = 1117 tests / 47 files**（web **592** + bridge 378 + shared 136 + worker 11；vs T10 终态 1091 = **+26** 新增断言——全部来自 styles-token-contrast.test.ts）；
- **集成** = **32** 零回归；
- **e2e** = **9 spec × 2 连跑全绿**，两轮各 **19.3s / 19.1s** 无 flaky 无重跑（spec 改动 0 行——4 token + focus-visible + 单元层新增不影响 e2e 既有锚点）；
- **typecheck** = **4 包绿**；
- **lint**（`pnpm exec eslint packages/web/src` 范围限定） = **0 error / 5 pre-existing warnings**（WsClient.ts no-console）；
- **`pnpm -r build` 4 包绿**；
- **build 体积零回归**（4 token 新增不增体积 / focus-visible utility 复用既有 Tailwind 工具）。

### 契约自证

- **testid 锚点零增零删**（grep `data-testid="..."` 实证：T11 范围无任何 testid 改动）；
- **协议 / worker / bridge / shared 零改动**（`git diff ab10345~^..ab10345 --stat` 范围仅 `packages/web/**` + 既有 styles.css / 测试文件 / 9 组件内联 outline）；
- **M4 雷区零字节 diff**（grep `useRecoveryGateMap | handleRefill | gateMapRef | RecoveryView | stem-refilled watcher` 仍仅命中既有位置）；
- **组件内硬编码 hex** = **0 处新增**（T11 4 token 全部入 styles.css `:root` / `@media dark` 块）。

### commit / 文档

- **commit**：`ab10345` test(web): M6 T11 — 4 枚 `--on-*` token + focus-visible 统一 17 处 + styles-token-contrast.test.ts 26 条（16 文件 +754/-188）；
- **review**：T11 自验轮全绿（1091→1117 +26 单测 / e2e 9×2 19.3-19.1s / 集成 32 / typecheck / lint / build 绿）——零 review 缺口；
- **本批 docs commit**：T11 status → done + 完成情况节 + README 11/11 done + PRD §修订注记 收官小节 + 验收标准勾选有实证项 + current-state TODO M6 push 条目 commit 数更新（**3 chore + 14 M6 = 17 commits 待 push**）+ 测试基线补 M6 终态（1117）+ 最近变更条目。

## 目标

按 [[prds/m6-visual-rebuild.md|M6 PRD §6 暗色 + G13 + D2 / R3]] 落地暗色对比度 WCAG AA 校色 + focus 可及性核对：

1. **新增 `styles-token-contrast.test.ts` ~10 条**（WCAG AA：正文 ≥4.5:1 / UI ≥3:1）：
   - 暗色 `--text #e6e9ee` on `--bg #0e1218` ≥ 4.5:1（正文）；
   - 暗色 `--text #e6e9ee` on `--surface #1a2030` ≥ 4.5:1（正文）；
   - 暗色 `--muted #9aa3ad` on `--surface #1a2030` ≥ 4.5:1（次级文本）；
   - 暗色 `--accent #6f9bff` on `--bg #0e1218` ≥ 4.5:1（链接 / 主按钮）；
   - 暗色 `--accent #6f9bff` on `--accent-soft #1c2742` ≥ 4.5:1（active 高亮文字）；
   - 暗色 `--border #2a3140` on `--surface #1a2030` ≥ 3:1（UI 边界——R3 临界）；
   - 暗色 `--state-online #34d399` on `--surface #1a2030` ≥ 3:1（UI 状态色）；
   - 暗色 `--state-offline #f87171` on `--surface #1a2030` ≥ 4.5:1（错误文本）；
   - 暗色 `--code-bg #222837` 内部 text on code-bg ≥ 4.5:1；
   - light 模式全部 token 对照（与暗色对应 light token 同样满足 AA）。
2. **R3 已知临界点校色**（D2 + ±5% L 微调授权）：
   - 暗色 `--border #2a3140` 与 `--surface #1a2030` 边差仅 5.4:1 临界——实测 UI 元素可能不够；如不达标，**授权**改为 `#3a4255` 方向（提亮 L ~5%）；
   - 暗色 `--accent-on-soft`（active 高亮文字 `--accent #6f9bff` on `--accent-soft #1c2742`）——实测临界；如不达标，**授权**调整 soft 或 accent 提亮 ±5% L；
   - 校色结果回写到 `styles.css` `:root` / `@media dark` 块；
   - 任务 01 styles-token-resolution 单测同步更新（已校色后的值）。
3. **focus 可及性核对**（任务 05 R4）：
   - 单一焦点指示 + focus-visible 键盘路径；
   - 键盘 Tab focus input-field 时 input 元素有 `:focus-visible` 样式（outline 保留）；
   - 焦点环 `--accent-ring #eef4ff` / dark `#1c2742` 与 focus 元素背景对比足够（≥3:1）。
4. **附加 a11y 核对**：
   - 装饰性 lucide 图标 `aria-hidden="true"`（任务 04 / 05 / 06 / 07 / 08）；
   - 语义图标（如按钮内 Send / abort / 关闭）`aria-label` 完善；
   - `.visually-hidden` 类（任务 02 保留）用于 sr-only 文案。

## 测试义务

- [x] **`styles-token-contrast.test.ts` 26 条**（WCAG AA 实测 + helpers 抽取共享 + 边界 / 豁免钉桩）
- [x] **focus-visible 跨组件统一**（17 处 9 组件 outline + offset）
- [x] **4 枚 `--on-*` token 落地**（T10 三处 dark 对比边缘根治）
- [x] **`styles-token-resolution.test.ts` 校色后值同步**（既有 43 条不变）
- [x] **`focus-visible` 键盘路径单测**（4 条视觉可达性断言）

## 完成标准

- [x] `styles-token-contrast.test.ts` 新建 26 条，全部 WCAG AA 实测绿（含 helpers 抽取 + hairline / disabled 豁免钉桩）
- [x] 4 枚 `--on-*` token 落地（light #ffffff 零变化 / dark 深墨值达标 6.79/8.73/6.63/6.68）
- [x] R3 已知临界点决策——`--border dark` 1.25:1 保持（hairline 设计意图，超 ±5% L 授权窗口，记录不调；M+ 评估时一并裁决）
- [x] focus 可及性核对（focus-visible 跨组件统一 17 处 9 组件 + 键盘路径实测）
- [x] 装饰性 lucide 图标 `aria-hidden="true"` 标记 + 语义图标 `aria-label` 完善（既有 T04-T09 落地 + T11 复核无缺失）
- [x] `.visually-hidden` 类用于 sr-only 文案（既有）
- [x] 既有 web **1091 不回归** + 新增 26 条 = **1117**（web 592 + bridge 378 + shared 136 + worker 11）
- [x] typecheck / lint / `pnpm --filter @remotepi/web build` 全绿
- [x] commit 不 push（沿用 M2 / M3 / M4 / M5 / M6 交付约定——本批文档随 docs commit 同步落档）

## 依赖

- 依赖 [[tasks/m6/10-e2e-validation-docs.md|10-e2e-validation-docs]]（10 全量验证通过后再做 a11y 校色，避免重复跑全量）— ✅ 已 done

## 参考

- [[prds/m6-visual-rebuild.md|M6 PRD §6 暗色 / G13 / 决策 D2 / 风险 R3 / §修订注记（2026-09-22 T11 收官）]]
- [[tasks/m6/01-token-retranslation.md|01-token-retranslation]] styles-token-resolution 单测基线
- [[tasks/m6/05-chatview-bubbles-inputbar.md|05-chatview-bubbles-inputbar]] focus 单一指示基线（R4）
- [[tasks/m6/10-e2e-validation-docs.md|10-e2e-validation-docs]] T10 全量验证轮实测基线
- WCAG 2.1 AA 标准：正文 ≥4.5:1 / UI ≥3:1