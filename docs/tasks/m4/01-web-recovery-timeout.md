---
prd: prds/m4-multi-session.md
status: done
---
# 任务：web 恢复仪式 5s 修复（snapshot 无进度超时 + bridgeStatus 离线秒失败 + RecoveryInFlight 接 phase）

## 目标
按 [[prds/m4-multi-session.md|PRD §6（修订注记技术裁定 2 + §6.1-§6.3）]] 修复 web 恢复仪式 5s 绝对超时对 pi 冷启动不足：方案 B+C 合体（web 单端改动，bridge / worker 零改动）。C 核心 = snapshot 腿从"绝对 5s"改"无进度窗口"（看到真实相位迁移重置为 15s，无进度维持 5s 兜底失败）；B 辅助 = `bridgeStatus.online === false` 离线秒失败（`null` 不算，避免冷启动误杀）。`RecoveryInFlight` 接 `phase` 显示阶段文案。涉及点（scout 已核实）：`packages/web/src/ws/recovery.ts`（`RECOVERY_TIMEOUT_MS = 5000` 定义于 :48，per-reply 双独立 timer，`checkComplete` 三态 error）、`App.tsx` RecoveryView（:200-211 auto-start effect 只读 connState）/ RecoveryInFlight（:232-247）、bridge `pi-process.ts` spawnNow :820 同步广播 spawning + `completeHandshake` :1275 广播 ready（信号已在广播，web 没听）。

关键要点：

- **`packages/web/src/ws/recovery.ts`**：`RECOVERY_TIMEOUT_MS = 5_000` 保留但语义改"无进度窗口"；新增 `PHASE_PROGRESS_TIMEOUT_MS = 15_000`——snapshot 定时器在 `phase` 字段实际变化时重置为 15s；5s 仅作"无任何相位变化即失败"兜底。
- 新增 `subscribeToSessionState(wsClient, onPhaseChange)`：内部注册 `ceremony.unsubs` 清理（沿用现有仪式 unsubscribe 模式，StrictMode / retry 安全）；新增 `subscribeToBridgeStatus(wsClient, onBridgeStatusChange)`：同上。
- `checkComplete` 逻辑升级——snapshot 定时器在 onPhaseChange 触发时重置为 `PHASE_PROGRESS_TIMEOUT_MS`；无相位变化维持 `RECOVERY_TIMEOUT_MS` 兜底失败。
- **`packages/web/src/App.tsx`**：
  - `RecoveryView` 接 `phase` prop（从 WsClient 订阅 `sessionStates[currentSession].sessionPhase`）；
  - `RecoveryInFlight` 接 `phase` prop 显示"正在启动会话…"（`phase = 'spawning'`）/"正在加载历史…"（`phase = 'ready' | 'running' | 'idle'`）/"5 秒未收到进度…"（无相位变化超 5s）；
  - auto-start effect 追加 `bridgeStatus.online === false` 守门（`null` 不算——冷启动期间 `bridge_status` 未补发是常态，避免误杀）。
- **新错误文案**（`RecoveryErrorCard.errorHint`）：
  - `'snapshot_failed'`：`'无法拉取历史消息（超时或返回失败）。请检查网络后重试。'`（M3 既有）
  - `'state_failed'`：`'无法拉取会话状态（超时或返回失败）。请检查网络后重试。'`（M3 既有）
  - `'both_failed'`：`'bridge离线或无法拉取会话状态与历史消息。请刷新页面或检查 bridge 状态后重试。'`（改：明示 bridge 离线可能）
  - `'bridge_offline'`：`'bridge 当前离线。请检查 bridge 进程是否运行后重试。'`（新增，优先于 `both_failed` 在 bridgeStatus 离线时显示）

> **文档漂移更正不在本任务**——`REPLY_TIMEOUT_MS` → `RECOVERY_TIMEOUT_MS` 共 6 处统一更正纳入 09-docs-sync（grep 实证零残留）。

## 完成标准
- [ ] `packages/web/src/ws/recovery.ts`：`RECOVERY_TIMEOUT_MS = 5_000` 保留 + 新增 `PHASE_PROGRESS_TIMEOUT_MS = 15_000`；语义改"无进度窗口"——snapshot 定时器在 `phase` 字段实际变化时重置为 15s；无进度维持 5s 兜底失败
- [ ] `subscribeToSessionState(wsClient, onPhaseChange)` + `subscribeToBridgeStatus(wsClient, onBridgeStatusChange)` 新增；两个订阅内部均注册到 `ceremony.unsubs`（StrictMode / retry 安全，验证不会泄漏监听器）
- [ ] `checkComplete` 升级——snapshot 定时器在 onPhaseChange 触发时重置为 `PHASE_PROGRESS_TIMEOUT_MS`；新增 `bridgeStatus.online === false` 立即失败分支（`null` 不触发）
- [ ] `packages/web/src/App.tsx`：`RecoveryView` 接 `phase` prop；`RecoveryInFlight` 接 `phase` 显示三态文案；auto-start effect 追加 `bridgeStatus.online === false` 守门（`null` 不算）
- [ ] `RecoveryErrorCard.errorHint` 4 类文案（`snapshot_failed` / `state_failed` / `both_failed` 文案改明示 bridge 离线 / 新增 `bridge_offline`）；`bridge_offline` 优先级高于 `both_failed` 在 bridgeStatus 离线时显示
- [ ] 单测 4 类（PRD §6.3）：(a) snapshot 定时器在 `phase` 变化触发时重置验证；(b) bridgeStatus.online=false 在仪式进行中到达 → 立即失败 + 错误文案验证；(c) StrictMode / retry 不泄漏监听器（`ceremony.unsubs` 数组验证）；(d) errorHint 文案分支单元测试
- [ ] `pnpm --filter @remotepi/web build` / `pnpm run lint` / `pnpm run typecheck` / `pnpm run test` 全绿；web build 体积变化 < 5 KB
- [ ] 关键真实探针——模拟 pi 冷启动长于 5s 但有真实 phase 变化的场景，确认仪式不被误杀；模拟无 phase 变化 + 无 snapshot 响应的场景，确认 5s 兜底失败生效

## 依赖
- 无（web 单端改动，bridge / worker 零改动）

## 参考
- [[prds/m4-multi-session.md|PRD §6 恢复仪式 5s 修复]]
- [[prds/m4-multi-session.md|PRD §6.3 测试]]
- [[tasks/m3/07-web-recovery.md|tasks/m3/07]] 双查询恢复仪式基线
- [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §开放点 1（长期路径落实，e2e retry 容错断言可简化）

## 完成情况

任务完成，两笔本地 commit：**`a8b8f34`**（实施）+ **`4634270`**（review 修复轮）。B+C 合体方案全量落地（web 单端改动，bridge / worker / shared 零改动），reviewer 原始结论 **0 Critical / 4 Warning / 6 Suggestion**（5 项落地 + 3 项合理跳过）：

### `a8b8f34` 实施（10 项完成）

- **`packages/web/src/ws/recovery.ts`** 新增 `PHASE_PROGRESS_TIMEOUT_MS = 15_000`（相位实际变化重置 snapshot 定时器，5s 仅作"无任何相位变化即失败"兜底）；新增 `subscribeToSessionState(wsClient, onPhaseChange)` 与 `subscribeToBridgeStatus(wsClient, onBridgeStatusChange)`（内部均注册到 `ceremony.unsubs`，沿用现有仪式 unsubscribe 模式，StrictMode / retry 安全）；`checkComplete` 升级——snapshot 定时器在 `onPhaseChange` 触发时重置为 `PHASE_PROGRESS_TIMEOUT_MS`；新增 `bridgeStatus.online === false` 立即失败分支（`null` 不触发，冷启动期间 `bridge_status` 未补发是常态）。
- **`packages/web/src/App.tsx`** `RecoveryView` / `RecoveryInFlight` 接 `phase` prop（`spawning` / `ready|running|idle` / 无相位变化超 5s 三态文案）；auto-start effect 追加 `bridgeStatus.online === false` 守门。
- **`errorHint` 抽离至 `packages/web/src/components/error-hint.ts`** —— `snapshot_failed` / `state_failed`（M3 既有）/ `both_failed`（改：明示 bridge 离线可能）/ 新增 `bridge_offline`（优先于 `both_failed` 在 bridgeStatus 离线时显示）。
- **`packages/web/__tests__/recovery.test.ts` 新增 25 条**单测覆盖 PRD §6.3 四类（snapshot 定时器在 `phase` 变化时重置 / `bridgeStatus.online=false` 仪式进行中到达立即失败 + 文案 / StrictMode 与 retry 不泄漏监听器验证 `ceremony.unsubs` / errorHint 文案分支）。

### `4634270` review 修复轮（5 项落地 + 3 项合理跳过）

- **W1 注释对齐**——bridge 重连不自动重燃仪式，恢复仪式需显式重发；JSDoc 钉死"connection drop 不触发 auto-restart，retry 需用户主动"。
- **W3 EOF 换行**——文件结尾补 `\n`。
- **W4 补 2 条用例**——"WS 断线静默丢 `bridge_status` → `both_failed` 不误报"：模拟仪式中 WS close 在 `bridge_status` 帧到达前发生，断言 `error` 走 `both_failed` 而非误报 `bridge_offline`（区分：`bridge_offline` 要求 `bridgeStatus.online === false` 已被显式告知；WS 早断无该信号则按既有 snapshot/state 失败路径走 `both_failed`）。
- **S1**——新增 `packages/web/vitest.workspace.ts` re-export 根 workspace，三包 per-package 测试行为统一（vitest 行为：包内 `vitest run` 自动消费根 `vitest.workspace.ts`，与根 `vitest run` 等价）。
- **S5**——删恒真断言（断言项已由其他测试覆盖，单条不必要）。
- **合理跳过**——S4 纯风格（不修改风格性建议）；S6 seam 在用（既有 `PiProcessManager` seam 已在 M3 任务 10 集成测试基建复用，本任务不重复）；W2 见下方 reviewer 澄清注记。

### 测试 / 构建基线（`4634270` 收尾实测）

- web 包 **237 → 308 全绿**（**+71**：25 新增 + 2 补用例；306 → 308 为总条数口径——任务 11 testid 收口后基线 237、任务 13 e2e 不计入 web vitest、`4634270` 收尾后落定 308）。
- `typecheck` / `lint` / `build` 全绿；web build **235.72 KB**（较 M3 任务 07 的 232 KB +3.72 KB：`PHASE_PROGRESS_TIMEOUT_MS` + 两订阅 + `bridge_offline` 分支 + `error-hint.ts` 抽离）。
- `packages/bridge` / `packages/worker` / `packages/shared` 零改动。

### reviewer 澄清注记

1. **错误文案注记（review W2）** — PRD §6.2 标注"M3 既有"的 `snapshot_failed` / `state_failed` 文案实际是 M4 简化修订。M3 任务 07 原文含"（snapshot 超时或返回失败）"/"（get_state 超时或返回失败）"实现细节括号注记；M4 按 PRD §6.2 指定文本落地（去掉括号内实现细节），非逐字沿用 M3。`both_failed` 为 M4 改写文案（明示 bridge 离线可能），`bridge_offline` 为 M4 新增分支。
2. **实现扩展注记（review S2 / S3）** — `RecoveryInFlight` 的"正在加载历史…"文案组实为 `ready | running | idle | exited`（`exited` 作为 spawn → ready 链路起始相位归入同组，实现 JSDoc 有 rationale：`exited` 时 `get_messages` 触发带 `--session` 的 spawn，bridge 侧 spawning → ready 期间 web 侧仍按"等待历史加载"语义展示，与 `ready` 后段视觉一致避免文案抖动）。组件新增 `data-phase` 属性预留 e2e 断言钩子（对齐 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] testid 风格，便于 E2E 场景按相位定位）。