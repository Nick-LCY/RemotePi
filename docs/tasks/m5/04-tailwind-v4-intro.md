---
prd: prds/m5-uiux.md
status: done
---
# 任务：Tailwind v4 引入（preflight 全开 + `@layer components` 包裹存量 CSS）

## 目标
按 [[prds/m5-uiux.md|M5 PRD §第二块 G8 + D11]] 落地 Tailwind v4，作为后续 06 / 07 / 08 任务的基础：

1. **依赖引入**——`packages/web/package.json` 加 `tailwindcss@^4` + `@tailwindcss/vite@^4`（devDependencies）；`pnpm install` 锁 `pnpm-lock.yaml`。
2. **vite 插件接入**——`packages/web/vite.config.ts` 加 `tailwindcss()` 插件（v4 官方 `@tailwindcss/vite`，零配置）。
3. **styles.css 顶层改造**——顶部插入 `@import "tailwindcss";` + `@theme` 块（**13 存量 CSS 变量映射** + 新增 `--sidebar-width: 280px`）+ `@media (prefers-color-scheme: dark)` 暗色变体保留；**`@theme` 块之外的存量 1280 行 CSS 整体包入 `@layer components { ... }`**（层叠顺序：preflight(base) < 存量(components) < utilities——渐进迁移标准结构，新组件 utilities 可覆盖遗留全局规则）。
4. **preflight 全开**——**用户裁定**：v4 preflight（CSS reset）全开，不在 `@import "tailwindcss"` 后追加任何 `corePlugins: { preflight: false }` 类的关停选项；preflight 可能造成依赖 UA 默认样式的元素（如 h1 字号、button 默认 padding、input outline 等）被 reset，**已接受的过渡期视觉差异清单**写入完成情况备查。
5. **暗色模式保留**——`@media (prefers-color-scheme: dark)` 块原样保留（13 变量暗色变体），不引入 `dark:` 类策略（M+ 候选）。
6. **双轨渐进（不强制全量迁移）**——存量 CSS 触碰处顺手迁（migrate 时由 06 / 07 触碰组件时顺手用 utility 固化），本任务不强制全量重写 1280 行。

## 完成标准
- [x] `pnpm --filter @remotepi/web add -D tailwindcss@^4 @tailwindcss/vite@^4` 成功；`pnpm-lock.yaml` 更新
- [x] `packages/web/vite.config.ts` 接入 `@tailwindcss/vite` 插件
- [x] `packages/web/src/styles.css` 顶部新增 `@import "tailwindcss";` + `@theme` 块（13 存量 var + `--sidebar-width: 280px`）+ 暗色 `@media` 保留 + **存量 1280 行（除顶部新增块）整体包入 `@layer components { ... }`**
- [x] preflight **全开**（用户裁定，无关停选项）
- [x] `pnpm --filter @remotepi/web build` 绿且 CSS 输出含 preflight 与 utilities 层（`grep "*, ::before, ::after"` 命中 preflight；`grep "tailwind"` 命中 utilities 注入点）
- [x] 暗色模式生效：`@media (prefers-color-scheme: dark)` 块原样保留，13 变量在 dark 媒体查询下覆盖
- [x] **全量单测 790 全绿**（零回归）/ 集成 32 / **e2e 8 spec × 2 全绿**（e2e 本任务跑 1 轮即可；preflight 可能造成依赖 UA 默认样式的视觉差异，e2e 断言不含视觉样式应零回归——若出现断言失败如实记录并最小修复）
- [x] typecheck / lint 全绿
- [x] 记录 CSS 输出体积（含 preflight + utilities 增量；与基线 16.33 KB 比较）
- [x] **已接受的视觉差异清单**（如 h1 字号变化 / button 默认 padding 移除 / list bullet 重置等）写入完成情况备查
- [x] 雷区零 diff（grep `useRecoveryGateMap|handleRefill|gateMapRef|RecoveryView` 仅存在于既有 App.tsx，不新增）
- [x] commit 不 push（沿用 M2 / M3 / M4 交付约定）

## 依赖
- 无（web 单端构建链 + CSS 基础设施改动；与协议 / worker / bridge / shared 零交集）

## 参考
- [[prds/m5-uiux.md|M5 PRD §第二块 G8 / 方案 §3 / D11]]
- [[tasks/m5/01-web-markdown-render.md|01-web-markdown-render]] markdown 三件套体积基线（chunk 切包 + 懒加载）
- [[tasks/m5/02-web-input-textarea.md|02-web-input-textarea]] styles.css 触碰基线（`--input-max-height: 200px`）
- [[tasks/m5/03-e2e-and-validation.md|03-e2e-and-validation]] 测试基线 **790** / e2e 8 spec × 2
- Tailwind v4 官方文档：`@import "tailwindcss"` + `@theme` 块 + `@tailwindcss/vite` 插件

## 完成情况（2026-09-12）

任务完成，1 笔代码 commit 在本任务验收后由用户 push（沿用 M2 / M3 / M4 交付约定）。

### Commit 链

- `ec5b8e3` feat(web): M5 任务04 —— Tailwind v4 引入（preflight 全开 + `@layer components` 双轨地基）

### Review 轮次与裁决

本任务 1 轮 review 落地：**0C / 1W / 2S**。W1 落地（preflight 全开后文案微调）；S 落地（注释校准 + 文档对齐）。

### 关键数字（终验 2026-09-12，与 d290be6 终版一致）

- **CSS 输出体积**：16.68 KB（基线）→ **25.37 KB**（+8.69 KB，**远低于预算上限 +30 KB**）。
- **单测**：基线 790 → **888**（+98；本任务零新单测，+98 来自任务 06/07 同步新增，详见 [[#与下游任务的实施顺序说明|与下游任务的实施顺序说明]]）。
- **集成**：32/32 零回归。
- **e2e**：8 spec × 2 全绿（e2e 断言不含视觉样式，preflight 全开未引发回归）。
- **typecheck**：4 包绿。
- **lint**：0 error / 5 pre-existing warnings。
- **build**：4 包绿（web 首屏 entry 与基线持平，详见 [[tasks/m5/08-e2e-and-validation.md#完成情况2026-09-12|任务 08 完成情况]]）。

### 实施要点

- **依赖**：`tailwindcss@^4` + `@tailwindcss/vite@^4`（devDependencies），锁 `pnpm-lock.yaml`。
- **`vite.config.ts`**：注入 `tailwindcss()` 插件（零额外配置）。
- **`styles.css` 改造**：
  - 顶部 `@import "tailwindcss"`；
  - `@theme` 块 **13 存量 CSS var 全映射 + 新增 `--sidebar-width: 280px`**；
  - `@media (prefers-color-scheme: dark)` 暗色变体保留；
  - **存量 1280 行（除顶部新增块）整体包入 `@layer components { ... }`**（byte-perfect 验证——存量 CSS 字节零变动，仅外层包了一层 `@layer` 包裹）。
- **preflight 全开**（用户裁定 D11）：preflight 是 Tailwind v4 默认 reset，关掉即失去 utilities 体系优势；planner 初稿的 reference/关 preflight 方案被用户修订否决。
- **`@theme` 用 `var()` 引用映射**（**编排者修正**，非按 planner 初稿的字面值映射）：通过 `--color-bg: var(--bg); ...` 形式引用而非 `--color-bg: #fff;`，保证 `:root` 与暗色块的 **13 变量真值源仍是 styles.css 顶部的 `:root` 与 `@media (prefers-color-scheme: dark)` 块**，避免 `@theme` 引入字面值副本破坏遗留暗色适配。编排者主动修正此点，避免 planner 初稿方案与既有暗色机制冲突。

### 已接受的过渡期视觉差异清单（D11 边界）

preflight 全开后 UA 默认样式被 reset，本地不部署 / 视觉修缮在收尾任务或组件触碰处统一处理：

1. `h1` 字号缩为 UA 默认——`Sidebar` 顶部品牌位 `<h1>RemotePi</h1>` 受影响；
2. `button` 默认 padding 移除——侧边栏 / 弹窗 / 输入栏所有 `<button>` 受影响；
3. `input` 默认 outline / 字号重置——TokenModal / DirectoryBrowser / InputBar 受影响；
4. `ul/ol` list bullet 重置——markdown 渲染的列表 + work_dir / session 列表受影响；
5. `a` 链接下划线移除——markdown 渲染的链接受影响；
6. `code`/`pre` 默认 UA 配色重置——markdown 代码块配色由 `@layer components` 内 `.markdown-code` 覆盖；
7. `hr` 默认样式移除——markdown 分割线受影响。

上述 **7 项视觉差异已在任务 06（AppShell + Sidebar + SessionStatusBar + DirectoryBrowser modal 化视图重组）中通过 Tailwind utility 固化消化**——例如 Sidebar 顶部 `<h1>` 用 Tailwind class 显式设定字号 / button 用 utility 显式设 padding。

### 雷区零 diff 实证

- `grep useRecoveryGateMap|handleRefill|gateMapRef|RecoveryView packages/web/src/` 仍仅命中既有 App.tsx；
- `packages/shared` / `packages/bridge` / `packages/worker` git diff 实证空；
- `App.tsx` 本任务零字节改动（沿用至下游任务 06 才动手）。

### 与下游任务的实施顺序说明

按立项时承诺 `04 → 05 → 06 → 07 → 08` 串行执行；任务 04 收官时基线 790 → 实测 888（**+98**）——本任务自身**零新单测**，+98 全部来自任务 06 / 07 同步落地的 AppShell / Sidebar / SessionStatusBar / ChoiceLevel{1,2}Panel / useIsMobile / useFocusTrap / tokenStorage / TokenModal / BridgeStatusBar 等组件单测。本任务验证轮跑全量单测时**任务 05-08 已同步落地**（worker 跨任务串行写盘 + 每任务跑全量验证），最终基线以 d290be6 终版 **977**（web）为准，详见 [[tasks/m5/08-e2e-and-validation.md#完成情况2026-09-12|任务 08 完成情况]]。

### 交付约定

- **本地 commit 不 push**（沿用 M2 / M3 / M4）：本任务 1 笔代码 commit（`ec5b8e3`）由用户手动 `git push origin main` 触发 Actions CD（沿用 M4 deploy.yml）。
- **M5 第二块收官标记**：本任务 done + 任务 05-08 done → M5 第二块全部 5 个任务 done，**M5 第二块 ✅ 实施收官（2026-09-12）**——待用户 push + 线上手测验收（含新形态全量手测：侧边栏双 tab / token 设置弹窗 / 手机抽屉 / 移动全流程）。
