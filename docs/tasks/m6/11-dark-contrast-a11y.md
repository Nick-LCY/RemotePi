---
prd: prds/m6-visual-rebuild.md
status: todo
---
# 任务：暗色对比度 WCAG AA 单测 + R3 临界点校色 + focus 可及性

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

- [ ] **`styles-token-contrast.test.ts` ~10 条**（WCAG AA 实测 + 校色后值更新）
- [ ] **`styles-token-resolution.test.ts` 校色后值同步**（任务 01 单测）
- [ ] **`focus-visible` 键盘路径单测**（input-bar / token-modal / dialog 各 1 条）

## 完成标准

- [ ] `styles-token-contrast.test.ts` 新建 ≥10 条，全部 WCAG AA 实测绿
- [ ] R3 已知临界点校色落地（dark border / accent-on-soft 微调 ±5% L 范围）
- [ ] focus 可及性核对（单一焦点指示 + focus-visible 键盘路径）
- [ ] 装饰性 lucide 图标 `aria-hidden="true"` 标记 + 语义图标 `aria-label` 完善
- [ ] `.visually-hidden` 类用于 sr-only 文案
- [ ] 既有 web **977 不回归**
- [ ] typecheck / lint / `pnpm --filter @remotepi/web build` 全绿
- [ ] commit 不 push（沿用 M2 / M3 / M4 / M5 交付约定）

## 依赖

- 依赖 [[tasks/m6/10-e2e-validation-docs.md|10-e2e-validation-docs]]（10 全量验证通过后再做 a11y 校色，避免重复跑全量）

## 参考

- [[prds/m6-visual-rebuild.md|M6 PRD §6 暗色 / G13 / 决策 D2 / 风险 R3]]
- [[tasks/m6/01-token-retranslation.md|01-token-retranslation]] styles-token-resolution 单测基线
- [[tasks/m6/05-chatview-bubbles-inputbar.md|05-chatview-bubbles-inputbar]] focus 单一指示基线（R4）
- WCAG 2.1 AA 标准：正文 ≥4.5:1 / UI ≥3:1
