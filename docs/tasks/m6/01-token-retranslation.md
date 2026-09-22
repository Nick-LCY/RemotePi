---
prd: prds/m6-visual-rebuild.md
status: todo
---
# 任务：styles.css token 翻译（13 → 20+，reference 蓝本 + WCAG AA 校色）

## 目标

按 [[prds/m6-visual-rebuild.md|M6 PRD §1 token 翻译 + §6 暗色 + D1 / D2]] 落地 styles.css token 全表重做：

1. **`:root` light 块全板换 reference 冷色**（D1 + D2）：
   - `--bg #f6f7f9`
   - `--surface #ffffff`
   - `--surface-2 #f5f7f9`
   - `--text #17202b`
   - `--muted #687482`
   - `--accent #245bc4`（替换现 `#2c5cff` / `#6c8cff`）
   - `--accent-hover #194da9`
   - `--accent-soft #f0f5ff`
   - `--accent-ring #eef4ff`
   - `--border #e4e8ed`
   - **新增** `--border-2 #dfe4e9` / `--border-3 #edf0f3` / `--code-bg #ffffff` / `--state-connecting #87919d`
   - **state 保留**：`--state-online #1f9d55` / `--state-offline #c0392b`
   - **新增** `--shadow-card 0 4px 18px rgba(23,32,43,0.06)`（InputBar / Card 卡片阴影）
   - **`--sidebar-width 280px → 300px`**（D5 沿用，但本任务先不动，03 任务一并落地）
   - **新增灰阶 token**：`--muted-2 #4d5966` / `--muted-3 #74808c` / `--muted-4 #87919d` / `--muted-5 #9aa3ad`（命名落地时自定但要成体系——消息正文 / 时间戳 / 占位等分级）
2. **`@media (prefers-color-scheme: dark)` 暗色块按 D2 提案全表落地**：
   - `--bg #0e1218`
   - `--surface #1a2030`
   - `--surface-2 #222837`
   - `--text #e6e9ee`
   - `--muted #9aa3ad`
   - `--accent #6f9bff`（替换现 dark accent 派生色）
   - `--accent-hover #8aaeff`
   - `--accent-soft #1c2742`
   - `--accent-ring #1c2742`
   - `--border #2a3140`（R3 临界，由任务 11 校色）
   - `--border-2 #353c4a` / `--border-3 #202632`
   - `--code-bg #222837`
   - `--state-connecting #74808c` / `--state-online #34d399`（emerald 调）/ `--state-offline #f87171`
   - `--shadow-card 0 4px 18px rgba(0,0,0,0.4)`
   - 灰阶 token：`--muted-2 #cbd0d6` / `--muted-3 #a3acb5` / `--muted-4 #8b95a0` / `--muted-5 #6f7a85`
3. **`@theme inline` 全部 var() 引用映射**（M5 编排者修正延续）——新 token 也暴露 `--color-*` 命名空间（`--color-bg: var(--bg); ...` 形式），保证 `:root` 与暗色块的 20+ 变量真值源仍是 styles.css 顶部的 `:root` 与 `@media` 块；避免 `@theme` 引入字面值副本破坏遗留暗色适配。
4. **新增 styles-token-resolution 单测 ~10 条**（`getComputedStyle` 校 token）：
   - `:root` 解析出 `--accent === #245bc4`（D1）/ `--accent-hover === #194da9` / `--accent-soft === #f0f5ff` 等；
   - `@media (prefers-color-scheme: dark)` 模拟下，token 重写为暗色变体（D2）；
   - 灰阶 token `--muted-2 ~ --muted-5` 在 light / dark 各解析出对应值；
   - `--shadow-card` 解析为非空字符串；
   - `--border / --border-2 / --border-3` 三层边 token 区分；
   - `@theme inline` 暴露的 `--color-bg: var(--bg)` 命名空间可消费。

## 完成标准

- [ ] `packages/web/src/styles.css` `:root` light 块按 reference 蓝本重写 20+ token（D1 + D2）
- [ ] `packages/web/src/styles.css` `@media (prefers-color-scheme: dark)` 块按 D2 全表落地
- [ ] `packages/web/src/styles.css` `@theme inline` 块用 `var()` 引用映射所有 20+ 变量（含新增灰阶 / border-2 / border-3 / shadow-card / sidebar-width）
- [ ] 既有 13 变量真值源保持 var() 引用形式（编排者修正延续）——保护暗色机制不被 `@theme` 字面值副本破坏
- [ ] **新增 `styles-token-resolution.test.ts` ≥10 条**（getComputedStyle 校 token）
- [ ] 既有 web **977 不回归**
- [ ] typecheck / lint / `pnpm --filter @remotepi/web build` 全绿
- [ ] commit 不 push（沿用 M2 / M3 / M4 / M5 交付约定）

## 依赖

- 无（CSS token 基础设施；与 02 衔接，02 全量迁前置 token 落地）

## 参考

- [[prds/m6-visual-rebuild.md|M6 PRD §1 token 翻译 / §6 暗色 / 决策 D1 / D2]]
- [[prds/m5-uiux.md#§第二块-g8-tailwind-v4-intro|M5 PRD §第二块 G8 / 方案 §3 / D11]]（`@theme` var() 引用映射基线 + 编排者修正）
- [[tasks/m5/04-tailwind-v4-intro.md|tasks/m5/04]] Tailwind v4 引入基线
