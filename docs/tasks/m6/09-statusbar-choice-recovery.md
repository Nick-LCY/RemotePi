---
prd: prds/m6-visual-rebuild.md
status: done
---
# 任务：SessionStatusBar + ChoiceLevel1/2Panel + RecoveryView reference 形态（仅样式，D12 / 雷区）

## 完成情况（2026-09-22，916998a + f1a4395 polish 范围）

- **commit**：`916998a` feat(web): M6 T09 — SessionStatusBar/ChoicePage/RecoveryView reference 形态 + session 状态色 token 化收尾 + `f1a4395` 紧跟 polish（ChoicePanel 窄体居中卡）。
- **做了什么**：白卡 pill 条 `rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 shadow-sm` + phase badge tinted 小方块（running 绿 `bg-emerald-soft` / idle 灰 `bg-[var(--surface-2)]` / spawning 蓝 `bg-accent-soft` / exited 红 `bg-state-offline/15` / unknown 灰）+ queue pills `bg-[var(--surface-2)] text-[var(--muted)] rounded-full px-2 py-0.5 text-[11px]`（follow-up / steering 分色） + session 名（`session === 'new'` 显「**新会话**」沿用）；ChoiceLevel1/2Panel 极简提示卡 `rounded-2xl border bg-[var(--surface)] p-8 max-w-[560px] mx-auto mt-12 shadow-sm` + 标题 + 副文 + 主 CTA 按钮（T07 形态沿用）——列表走 Sidebar，Panel 仅做提示与跳转；RecoveryView **in-flight 卡** + **error 卡** 卡片样式重做（`rounded-2xl border p-8 max-w-[480px] mx-auto mt-12 shadow-sm`） + error 卡 `border-[var(--state-offline)]/30` 描边。
- **RecoveryView 逻辑零改动**（D12 / 雷区）：`autoStartConsumedRef` / `useEffect` / `gateRef.current.retry()` 等语义全保留；M4 雷区五处（`useRecoveryGateMap` / `handleRefill` / `RecoveryView` effect / connect 语义 / stem-refilled watcher）零字节 diff（grep 实证：`gateMapRef / handleRefill / useRecoveryGateMap` 仍仅命中 `App.tsx`，未下移到 AppShell / Sidebar / 子组件）。
- **关键偏差**：ChoicePanel 文字大小由草案 `text-base` 落地 `text-[15px]`（f1a4395 polish 收尾——窄体居中卡用 text-[15px] 比 text-base 视觉密度更平衡，draft 未规定具体字号）。
- **关键候选**：ChoiceLevel1 双提示文案共存（T09——recovery 路径下既有「恢复会话」Banner 又走 ChoiceLevel1 Panel「请选择工作目录」，与 PRD 单一职责有微冲突；M+ 候选——统一收口到 ChoiceLevel1）。
- **testid 全保**：`phase-indicator[data-phase]` / `recovery-in-flight` / `recovery-error-card[data-error]` / `work-dir-list` / `session-list` / `new-session-button` 沿用——零增零删；`data-phase` / `data-error` 语义不变。
- **测试基线**：新增 `m6-statusbar-choice-recovery.test.tsx` **11 条**（phase badge 五态 + ChoicePanel CTA + RecoveryView in-flight/error 双卡）；既有 `session-status-bar.test.tsx` 12 条全绿。
- **M4 雷区**：零字节 diff（grep 实证）。
- **协议 / worker / bridge / shared**：零改动。

## 目标

按 [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 + G12 + D7 / D12 / 雷区]] 落地 StatusBar / ChoicePanels / RecoveryView reference 形态：

1. **SessionStatusBar reference 形态**（D7）：
   - 白卡 pill 条 + shadow-sm + rounded-2xl + 边框 + 内边距；
   - phase badge tinted 小方块（running 绿 / idle 灰 / spawning 蓝 / exited 红 / unknown 灰——按既有 `data-phase` 值映射 token 化 `--state-online` / `--muted` / `--accent` / `--state-offline` / `--muted`）；
   - queue pills 浅灰小 pill（`bg-[var(--surface-2)] text-[var(--muted)] rounded-full px-2 py-0.5 text-[11px]`）；
   - session 名（`session === 'new'` 显「**新会话**」沿用）。

2. **ChoiceLevel1Panel / ChoiceLevel2Panel 极简提示卡**（D7）：
   - 容器 `rounded-2xl border bg-[var(--surface)] p-8 max-w-[560px] mx-auto mt-12 shadow-sm`；
   - 标题 + 副文 + 主 CTA 按钮（沿用任务 07 形态）；
   - 移除自渲染列表（M5 任务 06 已收口）——本任务只重做 Panel 视觉，不动列表渲染职责（列表走 Sidebar）；
   - testid `work-dir-list` / `session-list` / `new-session-button` 沿用。

3. **RecoveryView 卡片样式重做 + 逻辑零改动**（D12 / 雷区）：
   - **in-flight 卡**：`rounded-2xl border bg-[var(--surface)] p-8 max-w-[480px] mx-auto mt-12 shadow-sm` + spinner + 标题「正在恢复会话...」+ 副文；
   - **error 卡**：`rounded-2xl border border-[var(--state-offline)]/30 bg-[var(--surface)] p-8 max-w-[480px] mx-auto mt-12 shadow-sm` + 错误 icon + 标题 + retry 按钮；
   - **逻辑零改动**（D12 / 雷区）：
     - `autoStartConsumedRef` / `useEffect` / `gateRef.current.retry()` 等语义全保留；
     - M4 雷区五处（`useRecoveryGateMap` / `handleRefill` / `RecoveryView` effect / connect 语义 / stem-refilled watcher）零字节 diff；
     - `gateMapRef` / `handleRefill` **不下移**到 AppShell / Sidebar / 任何子组件（沿用 M5 任务 06 既有约束）。
4. **testid 与 data-* 全保**：
   - `phase-indicator[data-phase]` / `recovery-in-flight` / `recovery-error-card[data-error]` 沿用；
   - `phase-indicator` 的 `data-phase` 语义不变；
   - `recovery-error-card` 的 `data-error` 语义不变。
5. **`styles.css` 触碰处顺手迁**（任务 02 已全量迁，09 仅确认无遗留）。

## 测试义务

- [ ] **`session-status-bar.test.tsx` 既有 ≥3 例 0 回归**：
   - phase badge 五态各自渲染（`running` / `idle` / `spawning` / `exited` / `unknown`）；
   - session === 'new' 显「**新会话**」（与 M4 既有 `'new'` 渲染对齐）；
   - queue pills 显示当前 queue 长度（0 → 不显示 / ≥1 → 显示数字 pill）。
- [ ] **`recovery-view.test.tsx` 既有 ≥N 例 0 回归**（具体数量以 M5 任务 06/07/08 落地为准——本任务以既有基线 977 不回归为门槛；逻辑零改动守护）
- [ ] **grep 实证**：`useRecoveryGateMap | handleRefill | gateMapRef | RecoveryView | stem-refilled watcher` 五处代码块**零字节 diff**（commit message 注明，CI / review 验证）。

## 完成标准

- [ ] `packages/web/src/components/SessionStatusBar.tsx` 白卡 pill 条 + phase badge tinted + queue pills 浅灰小 pill
- [ ] `packages/web/src/components/ChoiceLevel1Panel.tsx` / `ChoiceLevel2Panel.tsx` 极简提示卡（不动列表渲染职责）
- [ ] `packages/web/src/components/RecoveryView.tsx` 卡片样式重做（in-flight / error 双卡）
- [ ] **RecoveryView 逻辑零改动**（D12 / 雷区——`autoStartConsumedRef` / `useEffect` / `gateRef.current.retry()` 等语义全保留）
- [ ] **M4 雷区零字节 diff**（grep 实证五处代码块不动）
- [ ] testid 锚点零增零删（`phase-indicator[data-phase]` / `recovery-in-flight` / `recovery-error-card[data-error]` 等沿用）
- [ ] 既有 web **977 不回归**
- [ ] e2e **9 spec × 2 连跑全绿**（任务 10 真跑验证——recovery 路径无回归）
- [ ] typecheck / lint / `pnpm --filter @remotepi/web build` 全绿
- [ ] commit 不 push（沿用 M2 / M3 / M4 / M5 交付约定）

## 依赖

- 依赖 [[tasks/m6/01-token-retranslation.md|01-token-retranslation]]
- 依赖 [[tasks/m6/02-css-full-migration.md|02-css-full-migration]]
- 依赖 [[tasks/m6/03-app-shell-rebuild.md|03-app-shell-rebuild]]
- 依赖 [[tasks/m6/04-sidebar-brand-lucide.md|04-sidebar-brand-lucide]]

## 参考

- [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 / G12 / 决策 D7 / D12 / 雷区]]
- [[tasks/m5/06-app-shell-sidebar.md|tasks/m5/06]] SessionStatusBar / ChoicePage 收口 / BridgeStatusBar 基线
- [[tasks/m5/07-mobile-drawer.md|tasks/m5/07]] RecoveryView 移动端 sheet 沿用
- [[tasks/m4/08-web-multi-session-store.md|tasks/m4/08]] SessionBucket + 雷区代码清单 + handleRefill 闭包稳定性约束
- [[tasks/m4/01-web-recovery-timeout.md|tasks/m4/01]] RecoveryView 基线 + 5s 修复路径
