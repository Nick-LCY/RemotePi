# M6 — Web UI 全量视觉重做（reference 蓝本，任务索引）

> 详见 [[prds/m6-visual-rebuild.md|M6 PRD]]。本目录 11 个任务——**全部 `status: todo`**（2026-09-22 用户裁定 D1-D12 全部定稿；前置 M5 第一块 + 第二块 2026-09-22 用户口头确认全部完成，单测基线 **977** / 全仓 **1502** / 集成 **32** / e2e **9 spec × 2**）。
>
> **范围说明**：纯 packages/web + docs 增量；协议 / worker / bridge / shared 零改动；testid 锚点零增零删；不破既有功能 / 交互语义。

## 任务列表

- [[tasks/m6/01-token-retranslation.md|01 — styles.css token 翻译（13 → 20+，reference 蓝本 + WCAG AA 校色）]] `todo`（无依赖）
- [[tasks/m6/02-css-full-migration.md|02 — ~1280 行 styles.css 全量迁 Tailwind utilities（按组件分批）+ `@source not` 精简 22 条未消费 utility]] `todo`（依赖 01）
- [[tasks/m6/03-app-shell-rebuild.md|03 — AppShell 桌面态双 elevated 卡 + sidebar 300px + 移动端 backdrop 风格化]] `todo`（依赖 01 / 02）
- [[tasks/m6/04-sidebar-brand-lucide.md|04 — 引 lucide-react + Sidebar 重写（brand 双行块 + session row + BridgeStatusBar reference「远端连接」卡）]] `todo`（依赖 01 / 02 / 03）
- [[tasks/m6/05-chatview-bubbles-inputbar.md|05 — MessageList 气泡化 + InputBar reference 形态 + 单一焦点指示]] `todo`（依赖 01-04）
- [[tasks/m6/06-token-modal.md|06 — TokenModal reference 形态（卡片 + backdrop + tinted icon block + input token 化）]] `todo`（依赖 01-04）
- [[tasks/m6/07-dialoghost-styling.md|07 — 4 类 DialogHost + toast 统一 reference modal（D7 分色表）+ footer 按钮形态]] `todo`（依赖 01-04）
- [[tasks/m6/08-directory-browser-modal.md|08 — DirectoryBrowser modal 化 + 路径条 inline code + 桌面端新增 backdrop（z-250）]] `todo`（依赖 01-04 / 06）
- [[tasks/m6/09-statusbar-choice-recovery.md|09 — SessionStatusBar + ChoiceLevel1/2Panel + RecoveryView reference 形态（仅样式，D12 / 雷区）]] `todo`（依赖 01-04）
- [[tasks/m6/10-e2e-validation-docs.md|10 — 全量验证（单测 / 集成 / e2e 9 spec × 2 / typecheck / lint / build / 体积记录）+ 文档收尾]] `todo`（依赖 01-09）
- [[tasks/m6/11-dark-contrast-a11y.md|11 — 暗色对比度 WCAG AA 单测 + R3 临界点校色 + focus 可及性]] `todo`（依赖 10）

## 依赖链

```
01 → 02 → (03, 04)
            ├─→ 05
            ├─→ 06 ──→ 08
            └─→ 07
03 / 04 → 09
01-09 → 10 → 11
```

- **01** 独立（CSS token 基础设施）；
- **02 → 01**（全量迁前置 token 落地）；
- **03 / 04 → 01 / 02**（双 elevated 卡 + Sidebar + lucide 引入）；
- **05 → 01-04**（气泡化与 InputBar 引用 token + Sidebar 已就绪）；
- **06 → 01-04**（TokenModal 引用 token）；
- **07 → 01-04**（DialogHost 引用 token）；
- **08 → 01-04 / 06**（DirectoryBrowser 引用 token + Modal 形态参考）；
- **09 → 01-04**（StatusBar / ChoicePanel / RecoveryView 引用 token；RecoveryView 逻辑零改动——D12 / 雷区）；
- **10 → 01-09**（全量验证 + 文档收尾）；
- **11 → 10**（暗色对比度单测 + 校色 + a11y 核对）。

**实施期串行执行**：`01 → 02 → (03 → 04) → 05 / 06 / 07 → 08 / 09 → 10 → 11`（避免 styles.css + App.tsx 冲突；03 / 04 逻辑独立但写盘顺序沿用先底层后上层）。

## 预估基线（M6 立项 2026-09-22）

> 本节给出任务 10 落地后预估基线（**仅供任务 10 全量验证时对照；实施期以实测为准**）。

- 单测 web **977 不回归** + 任务 01-11 新增合计 **+25 ~ +35**（任务 01 styles-token-resolution ~10 + 任务 02 assistant-message-body.test.tsx 12 处 regex + token-modal.test.ts 4 处 regex 适配 + 任务 03 app-shell 0 新增（既有 ≥30 适配）+ 任务 04 sidebar.test.tsx ≥5 + bridge-status e2e 0 新增 + 任务 05 input-bar-keydown 0 新增（既有 9 + use-auto-resize-textarea 0 新增（既有 7）+ 任务 06 token-modal 0 新增（既有 19 backdrop regex 适配）+ 任务 07 dialog 0 新增 + 任务 08 directory-browser 0 新增 + 任务 09 session-status-bar 0 新增（既有 ≥3）+ 任务 10 0 新增 + 任务 11 styles-token-contrast ~10）；
- 集成 **32 零回归**（bridge wire 零改动）；
- e2e **9 spec × 2 连跑全绿**（预期改动 ≤3 行：spec 09 / 04 className 字符串断言与新容器 class 对齐）；
- typecheck **4 包绿** / lint **0 error / 5 pre-existing warnings** / `pnpm -r build` **4 包绿**；
- web build 实测体积对比基线（entry 266.98 KB raw / 77.87 KB gzip + CSS 32.67 KB / 6.92 KB gzip）+ 懒加载 chunk 不变（markdown 170.57 KB + AssistantMessageBody 2.78 KB）——**D8 不设硬门槛，只记录**；
- testid 锚点零增零删（grep `data-testid="..."` 实证）；
- 协议 / worker / bridge / shared 零改动（git diff 实证）；
- M4 雷区零字节 diff（grep `useRecoveryGateMap | handleRefill | gateMapRef | RecoveryView | stem-refilled watcher` 仍仅命中既有位置）。

## 交付约定（沿用 M2 / M3 / M4 / M5）

所有任务（01-11）只在本地 commit，不 push。10 落地后用户本地验证 → 用户手动 `git push origin main` 触发 Actions CD → 服务器端 bridge 择机重启加载（与 push 同批动作即可合并触发）。

## 决策记录（D1-D12 全部定稿，2026-09-22 用户裁定）

详见 [[prds/m6-visual-rebuild.md#决策记录d1-d12-全部定稿2026-09-22-用户裁定|M6 PRD §决策记录]]。D1-D12 全部已定稿——不再保留「待裁定」字样。
