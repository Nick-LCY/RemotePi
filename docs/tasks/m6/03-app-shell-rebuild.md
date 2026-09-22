---
prd: prds/m6-visual-rebuild.md
status: done
---
# 任务：AppShell 桌面态双 elevated 卡 + sidebar 300px + 移动端 backdrop 风格化

## 完成情况（2026-09-22，c52d9f0 + f1a4395 review 范围）

- **commit**：`c52d9f0` feat(web): M6 T03 — AppShell 双 elevated 卡布局（sidebar 300px + rounded-2xl shadow-sm + 深石板 backdrop token 化）+ `f1a4395` 紧跟 T03-T09 review 收尾（mobile-top-bar backdrop 透传修正 + ChoicePanel 窄体居中卡）。
- **做了什么**：AppShell 桌面态 `bg-bg lg:p-4` + sidebar 容器 `lg:rounded-2xl lg:border lg:shadow-[var(--shadow-card)]` + main 容器 `lg:ml-4 lg:rounded-2xl lg:border lg:bg-[var(--surface)] lg:shadow-[var(--shadow-card)]`；`--sidebar-width` 280 → **300px**（沿用变量落地，零组件改动）；移动端 backdrop `bg-black/40 backdrop-blur-sm` → `bg-[#17202b]/20 backdrop-blur-[3px]`（深石板族，与 TokenModal / DirectoryBrowser backdrop 同族）。
- **关键偏差**：D3 深石板族 backdrop 透明度 `45%` vs 移动端 sidebar backdrop `20%`——实施期分层（modal backdrop 60 / sidebar 20），手感更轻盈不抢焦点。
- **testid 全保**：`app-shell` / `app-shell-main` / `sidebar-toggle` / `sidebar-backdrop` 沿用；D6 零增零删承诺兑现。
- **测试基线**：`app-shell.test.tsx` 由 0 新增到 **33 条**（既有 30+ 用例全部 regex 化 + 新增 3 条桌面态 lg 断点形态断言）。
- **基线**（T03 后）：workspace 1091 tests / 47 files 全绿；typecheck 4 包绿；build 4 包绿。
- **M4 雷区**：零字节 diff（grep 实证）。
- **协议 / worker / bridge / shared**：零改动。

## 目标

按 [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 + G5 + D5]] 落地 AppShell 桌面态双 elevated 卡形态：

1. **AppShell 桌面态改 reference 双 elevated 卡**：
   - 外层 `bg-[#f6f7f9] lg:p-4`（用 token 化 bg：`bg-bg` 或 `bg-[var(--bg)]`，落地时二选一统一）；
   - sidebar `lg:rounded-2xl lg:border lg:shadow-sm`（token 化：`rounded-2xl border-border shadow-[var(--shadow-card)]`）；
   - main `lg:ml-4 lg:rounded-2xl lg:border lg:bg-white lg:shadow-sm`；
   - 移动端不应用 lg:（沿用 M5 任务 06 + 07 落地形态）。
2. **`--sidebar-width` 280px → 300px**（D5）：
   - 落地选项 A：保留 `--sidebar-width` 变量字面改 300px（推荐，最小改动）；
   - 落地选项 B：删 `--sidebar-width` 变量，全部直接写 `w-[300px]`；
   - 二选一实施期视全量迁成本决定。
3. **移动端 backdrop 风格化**：
   - `bg-black/40 backdrop-blur-sm` → 深石板族 `bg-[#17202b]/20 backdrop-blur-[3px]`（与 TokenModal backdrop 同族——D6 一致性）；
   - 抽屉 shadow-xl（保持）。
4. **testid 全保**：
   - `app-shell` / `app-shell-main` / `sidebar-toggle` / `sidebar-backdrop` 沿用；
   - `data-*` 属性也全保。
5. **`styles.css` 触碰处顺手迁**（任务 02 已全量迁，03 仅确认无遗留）。

## 测试义务

- [ ] **`app-shell.test.tsx` 既有 30+ 用例 0 回归**：
   - 无 token → TokenModal 优先渲染（覆盖 AppShell 内容区）；
   - token + 无 workdir → WorkDirs tab + ChoiceLevel1Panel；
   - token + workdir → Sessions tab + ChoiceLevel2Panel + 右区 ChatView；
   - 设置按钮点击 → TokenModal closable 打开；
   - Sidebar tabs 切换（Sessions ↔ WorkDirs）渲染正确；
   - 移动端抽屉 / backdrop 形态断言（mobile drawer 渲染类名 + backdrop 透明度断言——token 化后 regex 形态）。
- [ ] **`app-shell.test.tsx` 新增 ≥3 条**（桌面态双 elevated 卡形态）：
   - 桌面态 lg 断点下，外层有 `p-4` 类（token 化 bg）；
   - 桌面态下 sidebar 容器有 `rounded-2xl border shadow-sm` 类（token 化）；
   - 桌面态下 main 容器有 `ml-4 rounded-2xl border bg-white shadow-sm` 类。

## 完成标准

- [ ] `packages/web/src/components/AppShell.tsx` 桌面态改双 elevated 卡形态
- [ ] `--sidebar-width` 280 → 300px（二选一落地）
- [ ] 移动端 backdrop 由 `bg-black/40 backdrop-blur-sm` → `bg-[#17202b]/20 backdrop-blur-[3px]`
- [ ] testid 锚点零增零删（app-shell / app-shell-main / sidebar-toggle / sidebar-backdrop 沿用）
- [ ] 既有 web **977 不回归**
- [ ] e2e **9 spec × 2 连跑全绿**（任务 10 真跑验证）
- [ ] typecheck / lint / `pnpm --filter @remotepi/web build` 全绿
- [ ] build 首屏 entry 实测体积记录（D8 不设门槛，只记录）
- [ ] commit 不 push（沿用 M2 / M3 / M4 / M5 交付约定）

## 依赖

- 依赖 [[tasks/m6/01-token-retranslation.md|01-token-retranslation]]
- 依赖 [[tasks/m6/02-css-full-migration.md|02-css-full-migration]]

## 参考

- [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 / G5 / 决策 D5]]
- [[tasks/m5/06-app-shell-sidebar.md|tasks/m5/06]] AppShell 基线（280px / h1 品牌位 / 既有 testid 锚点）
