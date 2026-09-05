---
prd: prds/m3-single-session.md
status: todo
---
# 任务：web 双查询恢复仪式 + F5 恢复 + phase / blocked_on / queue_update UI 接线

## 目标
按 [[prds/m3-single-session.md|M3 PRD §4.4]] 落地 web 端握手后**无 ack** 即并行发双查询（`pi/get_messages` 拉历史 + `control/get_state` 拉会话态）+ 两条都到才渲染 + 任意一条失败显示"重试"+ F5 刷新走完全相同路径。同时把 session_phase / blocked_on / queue_update 接入现有组件。

关键要点：

- **新增 `packages/web/src/ws/recovery.ts`**：
  - `interface RecoveryGate { ready: boolean; error: 'snapshot_failed' | 'state_failed' | 'both_failed' | null }`
  - 维护两路 promise：`snapshotPromise: Promise<Envelope | null>`（等 `pi/snapshot` reply_to 对应 id）+ `statePromise: Promise<Envelope | null>`（等 `control/result` reply_to 对应 id）
  - `initiateRecovery(wsClient)`：握手成功后 → 生成两个 id（`m1` 与 `g1`）→ **并行**发 `pi/get_messages { id: m1, payload: {} }` 与 `control/get_state { id: g1, payload: {} }` → 注册 onMessage 钩子按 reply_to 分流 → 两 promise 都 resolve 后 `ready: true`
  - 失败处理：任一超时（5s，可调）或 `ok: false` / `success: false` → 该 promise resolve null → 恢复仪式 `ready: false` + `error` 设置；显示"恢复失败，请重试"按钮（点击重发双查询）；**不静默丢**
  - `get_messages` 在 phase === `exited` 时会触发 bridge 侧 spawn（PRD §2.7）—— 恢复仪式无需特殊处理，等 snapshot 回来即可
- **改 `packages/web/src/ws/WsClient.ts`**：
  - 暴露 `sendEnvelope(envelope)` 给恢复仪式用（已有 `send(envelope)`，复用）
  - 入站按 reply_to 路由到 recovery.ts 的 promise resolvers
  - 收 `session_state` 帧 → 更新 `sessionPhase` + `blockedOn`（同步到 ChatView 组件）
  - 收 pi/event `queue_update` → 更新 queue.steering / queue.followUp
- **改 `packages/web/src/App.tsx`**：
  - token 存在 → 渲染 `<RecoveryView />`（包装 recovery.ts 的 gate）→ `ready: true` 时渲染 `<ChatView />`；`ready: false + error` 时渲染"恢复失败"卡片 + 重试按钮
  - F5 = token 仍在 URL hash（沿用 M2 仅内存 + hash 约定）→ 走完全相同路径：App mount → connect → 握手 → 双查询 → 渲染
- **handshake 后无 ack 即并行发双查询**：handshake 是 web→worker 单向，**无 ack 机制**（PRD §4.4）；合法性由连接存活保证；bridge 在线与否以 `bridge_status` 补发为准（沿用 M2）
- **不持久化 token**：F5 后 URL hash 仍带 token 故实际不需要重输（仅在 hash 被手动清掉时需重输，沿用 M2 行为）

## 完成标准
- [ ] `packages/web/src/ws/recovery.ts` 新建：`RecoveryGate` interface + `initiateRecovery(wsClient)` 函数 + 双 promise 等 reply_to 分流 + 5s 超时 + error 状态设置
- [ ] `packages/web/src/ws/WsClient.ts`：暴露 sendEnvelope 复用；session_state 入站更新 sessionPhase + blockedOn；pi/event queue_update 入站更新 queue
- [ ] `packages/web/src/App.tsx`：token 存在 → `<RecoveryView />` → ready 后 `<ChatView />`；error 时显示重试按钮
- [ ] F5 刷新走完全相同路径（无 localStorage / cookie；hash 仍在即不重输）
- [ ] `pnpm --filter @remotepi/web build` 成功产出 `dist/`；`pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿
- [ ] `grep -R "localStorage\|sessionStorage" packages/web/src/ws/` 零结果（沿用 M2）
- [ ] 组件逻辑验证：按 PRD §6.4 双查询恢复仪式清单逐条手测（与任务 08 三端联调手测验收合并执行）

## 依赖
- 依赖 [[tasks/m3/01-shared-protocol-v2.md|01-shared-protocol-v2]]（需要 get_state / get_messages / snapshot schema）
- 依赖 [[tasks/m3/06-web-chat.md|06-web-chat]]（恢复仪式 ready 后挂载 ChatView）
