---
prd: prds/m6-visual-rebuild.md
status: done
---
# 任务：4 类 DialogHost + toast 统一 reference modal（D7 分色表）+ footer 按钮形态

## 完成情况（2026-09-22，93cd6a9 范围）

- **commit**：`93cd6a9` feat(web): M6 T07 — 4 类阻塞弹窗 + toast reference 形态（tinted icon block 分色 + 倒计时 pill + footer 双按钮）。
- **做了什么**：4 类弹窗统一卡片 `rounded-2xl p-7 shadow-2xl max-w-[440px] bg-[var(--surface)]` + backdrop `bg-[#17202b]/45 backdrop-blur-[3px]`（与 TokenModal 一致）；**按类型 tinted icon block 分色**——confirm `<HelpCircle />` `bg-emerald-soft text-state-online`（绿 `#ecfdf5` / `#1f9d55`）+ select `<ListChecks />` `bg-amber-soft text-amber`（amber `#fef3c7` / `#d97706`）+ input `<PenLine />` / editor `<Edit3 />` `bg-accent-soft text-accent`（蓝 `#eef4ff` / `#245bc4`）；dark 族镜像（emerald `#022c22` / `#34d399` + amber `#422006` / `#fbbf24` + accent soft + `#6f9bff`），由实施期校色 + 任务 11 a11y 核对最终化；footer 按钮形态 primary 蓝填充 / cancel 白底描边 / destructive 红（复用 `--state-offline`）；**倒计时 pill** `bg-[var(--surface-2)] text-[var(--muted)] rounded-full`；toast 卡片 `rounded-2xl px-4 py-3 shadow-lg` + 左侧 icon block（`<Info />` / `<AlertTriangle />` / `<CheckCircle2 />`）+ 标题 + 正文，进场退场动画沿用既有 keyframes（保留在 `@layer components` 内）。
- **关键偏差**：toast 间距由草案 `m-2`（M5）落地 `mb-2`（draft 保留 `m-2` 但实施期 tiptoe 上下间距仅留底，避免顶部与 dialog-host 视觉粘连）；amber 字面色由原始 `text-amber` 落地为 token 化的 `--amber #d97706` / `--amber-soft #fef3c7`——T04 emerald 字面值与 T07 amber 字面值一起列入 M+ 候选 token 收编。
- **关键候选**：DialogHost **4 类弹窗 focus trap 缺失**（M5 既有缺漏，T07 仍未补；M+ 候选（mobile 抽屉 + 阻塞弹窗并存时焦点逃逸防护）由任务 11 兜底）。
- **props / dispatcher / 倒计时逻辑 / testid 全集零改动**（M5 D10 + D12 沿用）。
- **testid 全集**：`dialog-host` / `dialog-{type}` / `dialog-{type}-{action}` / `dialog-input-field` / `dialog-editor-field` / `dialog-error` / `dialog-host-toast` 沿用——零增零删。
- **测试基线**：新增 `dialogs-reference.test.tsx` **17 条**（4 类弹窗 tinted icon block 分色 + lucide 节点 + destructive 红按钮形态覆盖）。
- **M4 雷区**：零字节 diff。
- **协议 / worker / bridge / shared**：零改动。

## 目标

按 [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 + G10 + D7]] 落地 4 类 DialogHost 弹窗 + toast 统一 reference modal 形态：

1. **4 类弹窗统一 reference modal 形态**（D7）：
   - 卡片容器 `rounded-2xl p-7 shadow-2xl max-w-[440px] bg-[#ffffff]`（token 化 `bg-[var(--surface)]`）；
   - backdrop `bg-[#17202b]/45 backdrop-blur-[3px]`（与 TokenModal 一致）；
   - 头部 size-11 rounded-xl tinted icon block（按类型分色，见下表）；
   - 标题 `text-[16px] font-semibold text-[var(--text)]`；
   - 正文 `text-[14px] text-[var(--muted)] leading-6`；
   - footer 按钮形态（见 3）。

2. **按类型 tinted icon block 分色**（D7）：

   | 类型 | lucide 图标 | light bg | light icon | dark bg | dark icon |
   |------|-------------|----------|------------|---------|-----------|
   | **confirm** | `<HelpCircle />` | `#ecfdf5` | `#1f9d55` | 暗色绿族（`#022c22`） | `var(--state-online) #34d399` |
   | **select** | `<ListChecks />` | `#fef3c7` | `#d97706` | 暗色琥珀族（`#422006`） | `#fbbf24` |
   | **input** | `<PenLine />` | `#eef4ff` | `#245bc4` | `var(--accent-soft) #1c2742` | `var(--accent) #6f9bff` |
   | **editor** | `<Edit3 />` | `#eef4ff` | `#245bc4` | `var(--accent-soft) #1c2742` | `var(--accent) #6f9bff` |

   > **dark bg / icon 落地**：具体值由实施期校色 + 任务 11 a11y 核对最终化（destructive 红色保留 `--state-offline` 系）。

3. **footer 按钮形态**：
   - **primary 蓝填充**：`bg-[#245bc4] text-white rounded-xl px-4 py-2.5` + hover `bg-[#194da9]`（token 化）；
   - **cancel 白底描边**：`bg-white text-[var(--text)] border border-[var(--border)] rounded-xl px-4 py-2.5` + hover `bg-[var(--surface-2)]`；
   - destructive 形态（`dialog-confirm-destructive`）按 M4 既有红色按钮形态（`bg-[var(--state-offline)] text-white`）保留；
   - 间距 `gap-2`（按钮间距）。

4. **toast 统一形态**：
   - 卡片 `rounded-2xl px-4 py-3 shadow-lg` + 左侧 icon block（`Info` / `AlertTriangle` / `CheckCircle2` 按 toast 类型映射）+ 标题 + 正文；
   - 进场 / 退场动画沿用既有（`@layer components` 内 keyframes，任务 02 已保留）；
   - testid `dialog-host-toast` 沿用。

5. **props 接口 / dispatcher / 倒计时逻辑 / testid 全集零改动**（M5 D10 + D12 沿用）：
   - props 接口（M4 既有）零改动；
   - 倒计时逻辑（M3 既有）零改动；
   - testid 全集：`dialog-host` / `dialog-{type}` / `dialog-{type}-{action}` / `dialog-input-field` / `dialog-editor-field` / `dialog-error` 等沿用。

6. **`styles.css` 触碰处顺手迁**（任务 02 已全量迁，07 仅确认无遗留）。

## 测试义务

- [ ] **dialog-host / dialog 各类型既有 ≥N 例 0 回归**（具体数量以 M5 任务 06/07/08 落地为准——本任务以既有基线 977 不回归为门槛）
- [ ] **dialog-host / 各类型新增 ≥2 条 / 类型**（tinted icon block 分色）：
   - confirm 弹窗渲染 `bg-[#ecfdf5] text-[#1f9d55]` icon block（regex 形态）+ HelpCircle 节点；
   - select 弹窗渲染 `bg-[#fef3c7] text-[#d97706]` icon block（regex 形态）+ ListChecks 节点；
   - input 弹窗渲染 `bg-[#eef4ff] text-[#245bc4]` icon block（regex 形态）+ PenLine 节点；
   - editor 弹窗渲染 `bg-[#eef4ff] text-[#245bc4]` icon block（regex 形态）+ Edit3 节点。

## 完成标准

- [ ] `packages/web/src/components/dialogs/*` 4 类弹窗统一 reference modal 形态
- [ ] 按类型 tinted icon block 分色（confirm 绿 / select 琥珀 / input 蓝 / editor 蓝）
- [ ] footer 按钮形态（primary 蓝填充 / cancel 白底描边 / destructive 红）
- [ ] toast 统一形态（icon block + 标题 + 正文 + 进场退场动画）
- [ ] props 接口 / dispatcher / 倒计时逻辑 / testid 全集零改动
- [ ] 既有 web **977 不回归**
- [ ] e2e **9 spec × 2 连跑全绿**（任务 10 真跑验证；e2e 03 / 06 confirm + select 已覆盖路径兼容）
- [ ] typecheck / lint / `pnpm --filter @remotepi/web build` 全绿
- [ ] commit 不 push（沿用 M2 / M3 / M4 / M5 交付约定）

## 依赖

- 依赖 [[tasks/m6/01-token-retranslation.md|01-token-retranslation]]
- 依赖 [[tasks/m6/02-css-full-migration.md|02-css-full-migration]]
- 依赖 [[tasks/m6/03-app-shell-rebuild.md|03-app-shell-rebuild]]（backdrop 一致性）
- 依赖 [[tasks/m6/04-sidebar-brand-lucide.md|04-sidebar-brand-lucide]]（lucide 已引入；dialog / toast 图标）

## 参考

- [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 / G10 / 决策 D7]]
- [[tasks/m3/06-web-chat.md|tasks/m3/06]] web 聊天界面 + 4 类弹窗组件 + testid 基线
- [[tasks/m5/06-app-shell-sidebar.md|tasks/m5/06]] AppShell 装配基线 + DialogHost 在 AppShell 内挂载
- [[prds/m5-uiux.md#修订注记2026-09-12-第二块收官|PRD M5 §修订注记]] M+ 挂账候选（d）/（g）等
