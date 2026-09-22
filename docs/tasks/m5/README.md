# M5 — UIUX 优化轮（任务索引）

> 详见 [[prds/m5-uiux.md|M5 PRD]]。本目录 8 个任务——**第一块 3 个全部 done**（2026-09-11 实施收官，2026-09-22 用户口头确认全部完成；5 commits + 1 gap 修复 → 单测基线 **790**）；**第二块 5 个全部 done**（2026-09-12 实施收官，2026-09-22 用户口头确认全部完成；10 个 web commit + 用户并行 ADR-0013 bridge 修复 → 单测基线 **977** / 全仓 **1502**）。

## 任务列表

### 第一块（3/3 done，2026-09-11）

- [[tasks/m5/01-web-markdown-render.md|01 — web 渲染层结构化 + markdown 渲染 + thinking/tool 可折叠（含流式分段存储）]] ✅ done（2026-09-11，commits `926ae9c` + `1d08230` + `b1041e8`；**验收期 gap 修复 +2 commit `1fa3b82` + `d9c4409`**——toolResult 归并进 toolCall pill（isError 样式 + orphan 折叠），详见任务 01 [[tasks/m5/01-web-markdown-render.md#验收期-gap-注记-2026-09-11-toolresult-归并修复|§验收期 gap 注记]]）
- [[tasks/m5/02-web-input-textarea.md|02 — InputBar textarea 升级（换行 + 自动增高 + IME 守卫）]] ✅ done（2026-09-11，commits `f28295f` + `0594767`）
- [[tasks/m5/03-e2e-and-validation.md|03 — E2E × 2 + 全量验证 + 文档收尾]] ✅ done（2026-09-11，无新 commit，验证 + 文档收尾即本体）

### 第二块（5/5 done，2026-09-12 实施收官，2026-09-22 用户口头确认全部完成）

- [[tasks/m5/04-tailwind-v4-intro.md|04 — Tailwind v4 引入（preflight 全开 + `@layer components` 包裹存量 CSS）]] ✅ done（2026-09-12，commit `ec5b8e3`，CSS 16.68→25.37KB 远低于 +30KB 预算）
- [[tasks/m5/05-token-storage.md|05 — tokenStorage + TokenModal + hash 模型收缩（彻底删除 token 维度）]] ✅ done（2026-09-12，commit `efe265f`，D9 用户裁定彻底删除 + D10 两模式 + W1 隐私模式移交任务 06）
- [[tasks/m5/06-app-shell-sidebar.md|06 — AppShell 双栏 + Sidebar + SessionStatusBar + DirectoryBrowser modal 化 + ChoicePage 收口]] ✅ done（2026-09-12，commits `14897e1` + `cc27d02` + `d6ed7be`，review 抓出 3 处重复 testid + activeTab 脱钩 + 双 connect 全部修复）
- [[tasks/m5/07-mobile-drawer.md|07 — 手机适配：抽屉 + 汉堡 + 焦点陷阱 + 滚动锁 + modal 全屏化]] ✅ done（2026-09-12，commits `a6fd9ef` + `b6a6564`，hamburger gap worker 自曝后 MobileTopBar 按 view 分派修复）
- [[tasks/m5/08-e2e-and-validation.md|08 — e2e 改写（localStorage seeding）+ 移动端新 spec + 全量验证 + 文档收尾]] ✅ done（2026-09-12，commits `be2d894` + `d290be6`，e2e 9 spec × 2 = 19.2s/19.1s 全绿；build 双预算 entry +13.54 / CSS +16.34 均达标）

## 依赖链

### 第一块

- **01** 独立（流式分段存储 + 渲染层结构化 + markdown 渲染）；
- **02** 独立（InputBar textarea 升级，与 01 零代码交集）；
- 01 与 02 **相互独立、串行执行**（避免 styles.css 冲突）—— 实施期先 01 后 02 顺序写盘；
- **03 → 01 / 02**（E2E × 2 连跑 + 全量验证 + 文档收尾）。

### 第二块（2026-09-11 立项 D8-D13）

- **04** 独立（CSS 基础设施：Tailwind v4 + `@layer components` 包裹存量）；
- **05** 独立（token 模型：localStorage + TokenModal + hash 收缩）；
- **04** 与 **05** **相互独立、可并行**（CSS 与 token 模型正交）；
- **06 → 04 / 05**（AppShell / Sidebar 等新组件用 Tailwind only 写；TokenModal 组件存在后才能装配）；
- **07 → 04 / 05 / 06**（移动端样式用 Tailwind；接 sidebar-toggle 占位 + TokenModal / DirectoryBrowser 改样式 + 焦点行为）；
- **08 → 04 / 05 / 06 / 07**（E2E × 2 连跑 + 全量验证 + 文档收尾）。

**实施期串行执行**：`04 → 05 → 06 → 07 → 08`（避免 styles.css + App.tsx 冲突；04 / 05 逻辑独立但写盘顺序沿用先底层后上层）。

## 测试基线（2026-09-12 M5 第二块收官后，d290be6 终版）

- 单测 **1502**（shared 136 + bridge **378** 含用户 ADR-0013 +6 / web **977** 42 文件 / worker 11）；演进链：M4 收官 236 → M5 第一块 +35（markdown + textarea） → 验收期 gap 不变 → 任务 06 后 888 → 任务 07 后 963 → 任务 08 后 978 → polish 删 1 条同义反复 → **977**；
- 集成 **32**（零回归）；
- e2e **9 spec × 2 连跑全绿**（两轮各 19.2s/19.1s，无 flaky 无重跑；含新 09-mobile-drawer 12 test）；
- web build **首屏 entry 266.98 KB raw / 77.87 KB gzip**（vs M4 基线 253.44 → **+13.54 KB**，**双预算达标**）+ **CSS 32.67 KB / 6.92 gzip**（vs M4 基线 16.33 → **+16.34 KB**，**双预算达标**）；懒加载 chunk：markdown **170.57 KB** 不变 + AssistantMessageBody **2.78 KB**。
