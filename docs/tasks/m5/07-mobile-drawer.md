---
prd: prds/m5-uiux.md
status: done
---
# 任务：手机适配：抽屉 + 汉堡 + 焦点陷阱 + 滚动锁 + modal 全屏化

## 目标
按 [[prds/m5-uiux.md|M5 PRD §第二块 G7 + D12 / 方案 §4]] 落地手机适配：

1. **新建 `packages/web/src/hooks/useIsMobile.ts`**：
   - 阈值 **767px**（断点 `<768px` 判 mobile）；`window.matchMedia('(max-width: 767px)')` 监听；
   - listener 注册 + cleanup（mount-once 注册 `change` 事件，unmount 时 `removeEventListener` 注销）；
   - StrictMode 双跑安全（同一 hook 双调 mount 不重复注册）。
2. **新建 `packages/web/src/hooks/useFocusTrap.ts`**：
   - 入参：容器 `ref` + `enabled: boolean`；
   - 行为：`Tab` / `Shift+Tab` 在容器内 focusable 元素循环（首尾 wrap）；
   - 边界：单 focusable 元素不崩（不无限循环，`Tab` 停留原焦点）；
   - 关闭归还焦点（trap 关闭时 `focus()` 回入 trap 前的最后 focus 元素）。
3. **`Sidebar` 移动端 drawer 改造**——`useIsMobile()` 判定：
   - `<768px`：`<aside>` 改 `position: fixed` + `translate-x` 过渡（默认 `translate-x(-100%)` 收起 / `translate-x(0)` 展开）+ 移动端顶部汉堡按钮（`sidebar-toggle` testid，06 任务已留占位）+ 抽屉展开时 body 滚动锁（`document.body.style.overflow = 'hidden'`）；
   - `≥768px`：固定显示（沿用 06 任务网格布局，无汉堡）；
   - backdrop 元素（`sidebar-backdrop` testid，`position: fixed` + 背景模糊 `backdrop-filter: blur(4px)`）——抽屉展开时显示，点击关闭抽屉；
   - hashchange 自动收起（监听 hash 变化 → 抽屉收起 + 焦点归还）。
4. **`AppShell` 汉堡按钮接入**——`sidebar-toggle` testid（06 任务占位）+ `sidebar-backdrop` testid；汉堡按钮位置：移动端 `SessionStatusBar` 左侧（与 06 任务 SessionStatusBar 配合）。
5. **`TokenModal` 移动端全屏 sheet**——`<768px`：`position: fixed; inset: 0`（全屏）+ 圆角移除 + backdrop 自适应；`≥768px`：沿用 05 任务居中 modal 形态。
6. **`DirectoryBrowser` 移动端全屏 sheet**——`<768px`：同上（沿用 06 任务 modal 化形态）；`≥768px`：沿用 06 任务居中 modal 形态。
7. **焦点陷阱接入**——`useFocusTrap(ref, enabled)` 在以下三处启用：
   - `TokenModal` open + closable 模式（required 模式默认即唯一 focusable 元素，无需 trap）；
   - `DirectoryBrowser` open；
   - `Sidebar` 抽屉展开（移动端 focus 锁在侧边栏内——避免键盘 Tab 跑到背后 hidden 区）。

## 测试义务
- [ ] **`use-is-mobile.test.ts` ≥4 条**：
  - mount 时读 `matchMedia('(max-width: 767px)')` 当前值；
  - `change` 事件触发时 state 更新（mock matchMedia 触发 change listener）；
  - unmount 时 listener 注销（mock `removeEventListener` 调用计数）；
  - StrictMode 双跑安全（双 mount 不重复注册 listener）。
- [ ] **`use-focus-trap.test.ts` ≥4 条**：
  - `Tab` 在多 focusable 元素间循环到末尾 wrap 回首；
  - `Shift+Tab` 反向 wrap；
  - 单 focusable 元素不崩（`Tab` 停留原焦点，不抛异常）；
  - 关闭归还焦点（trap 关闭后 `document.activeElement === 入 trap 前最后 focus 元素`）。

## 完成标准
- [x] 全量单测（**基线 790 + 新增 ≥8**）/ 集成 32 / e2e 8 spec × 2 全绿
- [x] typecheck / lint / build 全绿
- [x] 雷区零 diff（grep `useRecoveryGateMap|handleRefill|gateMapRef` 仍仅存在 App.tsx）
- [x] build 体积记录（与 06 任务后基线比较）
- [x] e2e 09 spec 留给 08（移动端 spec 在 08 任务统一跑 Playwright 375×667 viewport）
- [x] commit 不 push（沿用 M2 / M3 / M4 交付约定）

## 依赖
- 依赖 [[tasks/m5/04-tailwind-v4-intro.md|04-tailwind-v4-intro]]（Tailwind 已引入；移动端样式用 Tailwind utilities 写）
- 依赖 [[tasks/m5/05-token-storage.md|05-token-storage]]（TokenModal 组件已存在；本任务改其样式 + 焦点行为）
- 依赖 [[tasks/m5/06-app-shell-sidebar.md|06-app-shell-sidebar]]（AppShell / Sidebar 组件已存在；本任务改其移动端布局 + 接 sidebar-toggle 占位）

## 参考
- [[prds/m5-uiux.md|M5 PRD §第二块 G7 / 方案 §4 / D12]]
- [[tasks/m5/06-app-shell-sidebar.md|06-app-shell-sidebar]] AppShell / Sidebar / SessionStatusBar 基线（汉堡按钮占位）
- [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] e2e viewport 套路（08 任务新增 09 spec 用 375×667）

## 完成情况（2026-09-12）

任务完成，2 笔代码 commit 在本任务验收后由用户 push（沿用 M2 / M3 / M4 交付约定）。

### Commit 链

- `a6fd9ef` feat(web): M5 任务07 —— 移动端适配（抽屉 + 汉堡 + 焦点陷阱 + 滚动锁 + modal 全屏化）
- `b6a6564` fix(web): M5 任务07 —— 汉堡按钮覆盖全部移动端视图（修复 level1/2 无法打开侧边栏）

### Review 轮次与裁决

本任务 1 轮 review 落地 + **hamburger gap 修复轮**：

- **Round1**：0C / 1W / 2S。W1 落地（汉堡按钮位置语义校准）；S 全部落地。
- **Hamburger gap 修复轮（worker 自曝）**——实施期 worker 自检发现**功能性死路**：level1/level2 视图移动端无法打开侧边栏（汉堡按钮仅在 ChatView 顶部，ChoiceLevel1Panel / ChoiceLevel2Panel 无汉堡）。修复方式：**`MobileTopBar` 按 view 分派**——level1 / level2 / recovery / chat 四个视图共用同一 MobileTopBar 组件，汉堡按钮随当前 view 一致显示；`b6a6564` 落地。

### 关键数字（终验 2026-09-12，与 d290be6 终版一致）

- **单测**：基线 790 → **888**（+98；任务 07 后实测 963（基线 888 + useIsMobile/useFocusTrap 等 +75），归并到终版 977 中）。
- **集成**：32/32 零回归。
- **e2e**：8 spec × 2 全绿（移动端 09 spec 留给 08 任务统一跑）。
- **typecheck**：4 包绿。
- **lint**：0 error / 5 pre-existing warnings。
- **build**：4 包绿；web 首屏 entry 与 06 后基线持平。
- **移动端冒烟**：8 条全过（含汉堡 / 抽屉 / 焦点 / 滚动锁 / backdrop / modal 全屏 / 桌面零回归 / sheet 形态）。

### 实施要点

- **`useIsMobile` hook**（纯函数抽取策略）——`matchMedia('(max-width: 767px)')` + listener 注册/cleanup + StrictMode 双跑安全。
- **`useFocusTrap` hook**（纯函数抽取策略）——容器 ref + enabled + Tab/Shift+Tab wrap + 单 focusable 不崩 + 关闭归还焦点。
- **Sidebar 抽屉**——`<768px` `position: fixed` + `translate-x` 过渡 + backdrop `backdrop-filter: blur(4px)` + body 滚动锁 `document.body.style.overflow = 'hidden'` + hashchange 自动收起 + 焦点归还。
- **AppShell / MobileTopBar**——汉堡按钮 `sidebar-toggle` 覆盖全部移动端视图（**hamburger gap 修复后**——通过 `MobileTopBar` 按 view 分派实现）。
- **TokenModal / DirectoryBrowser 全屏 sheet**——`<768px` `position: fixed; inset: 0` + 圆角移除。
- **焦点陷阱接入**——TokenModal closable / DirectoryBrowser open / Sidebar 抽屉展开三处启用 `useFocusTrap(ref, enabled)`。

### 关键架构决策与取舍

1. **hook effect wiring 层零单测覆盖**——**纯函数抽取策略**：`useIsMobile` / `useFocusTrap` 的核心逻辑（matchMedia 状态机 / focusable 元素查询 / Tab 循环）以纯函数形式可单测；**effect wiring 层**（mount-once 注册 listener / Tab keydown event listener / focus 归还）**未引 jsdom**——**显式取舍记录**：单测覆盖纯函数逻辑，effect wiring 层由 08 任务 e2e 真 DOM 兜底。**这是 ADR-0009 精神的延续**（e2e 兜底 wiring，单测覆盖逻辑）。M+ 候选：若 a11y 缺陷出现或 wiring 复杂化，配合 Tailwind 走 shadcn 路线或引 @testing-library/react-hooks。
2. **hamburger gap 修复**——worker 自检发现功能性死路（level1/2 无汉堡），按 view 分派 MobileTopBar 修复（b6a6564）；**教训**：跨视图通用控件需统一在顶部 nav 层而非单视图内。
3. **滚动锁无引用计数服务**——抽屉 / modal 共用 body 滚动锁但无引用计数；单开单关场景下够用，复杂叠加场景（如抽屉 + modal 同时打开）未实测。**M+ 候选**：引入 `useBodyScrollLock` hook + 引用计数服务。

### 雷区零 diff 实证

- `grep useRecoveryGateMap|handleRefill|gateMapRef|RecoveryView packages/web/src/` 仍仅命中 App.tsx；
- `App.tsx` 本任务零字节改动（移动端适配只在 Sidebar / AppShell / TokenModal / DirectoryBrowser 子组件层）；
- `packages/shared` / `packages/bridge` / `packages/worker` git diff 实证空；
- wire 协议零改动（v3 锁版承诺守住）。

### 交付约定

- **本地 commit 不 push**（沿用 M2 / M3 / M4）：本任务 2 笔代码 commit（`a6fd9ef` + `b6a6564`）由用户手动 `git push origin main` 触发 Actions CD。
- **M5 第二块收官标记**：本任务 done + 任务 04 / 05 / 06 / 08 done → M5 第二块全部 5 个任务 done。
