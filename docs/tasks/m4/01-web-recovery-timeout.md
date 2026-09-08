---
prd: prds/m4-multi-session.md
status: todo
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