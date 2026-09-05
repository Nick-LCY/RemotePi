---
prd: prds/m3-single-session.md
status: done
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
- [x] `packages/web/src/ws/recovery.ts` 新建：`RecoveryGate` interface + `initiateRecovery(wsClient)` 函数 + 双 promise 等 reply_to 分流 + 5s 超时 + error 状态设置
- [x] `packages/web/src/ws/WsClient.ts`：暴露 sendEnvelope 复用；session_state 入站更新 sessionPhase + blockedOn；pi/event queue_update 入站更新 queue
- [x] `packages/web/src/App.tsx`：token 存在 → `<RecoveryView />` → ready 后 `<ChatView />`；error 时显示重试按钮
- [x] F5 刷新走完全相同路径（无 localStorage / cookie；hash 仍在即不重输）
- [x] `pnpm --filter @remotepi/web build` 成功产出 `dist/`；`pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿
- [x] `grep -R "localStorage\|sessionStorage" packages/web/src/ws/` 零结果（沿用 M2）
- [x] 组件逻辑验证：按 PRD §6.4 双查询恢复仪式清单逐条手测（与任务 08 三端联调手测验收合并执行）

## 依赖
- 依赖 [[tasks/m3/01-shared-protocol-v2.md|01-shared-protocol-v2]]（需要 get_state / get_messages / snapshot schema）
- 依赖 [[tasks/m3/06-web-chat.md|06-web-chat]]（恢复仪式 ready 后挂载 ChatView）

## 完成情况

任务完成，commit `cbeea2e`。web 双查询恢复仪式 + F5 同路径 + session_phase/blocked_on/queue_update 接线全量落地：`recovery.ts` 新建（`RecoveryGate` + `initiateRecovery`：resolver 注册先于 send，per-reply 5s timer，stale 标志覆盖所有异步入口，三态 error `snapshot_failed`/`state_failed`/`both_failed`，retry + dispose 双路径）+ `WsClient.registerReplyResolver` 一次性 resolver 注册（reply_to 分流不依赖 event 类型）+ result 集中处理（`SessionStatePayloadSchema` 校验后同步 sessionPhase + blockedOn）+ App 三态渲染（`RecoveryInFlight` spinner / `ChatView` ready / `RecoveryErrorCard` 重试）+ F5 同路径（token 走 URL hash，无持久化）。

reviewer **「需修复后通过」**；**5 项 Warning 全修**：

1. **token 切换重发仪式（PRD §4.4 重连语义）** — 旧实现：token 变更走 `connect()` 路径会 reuse 未 dispose 的旧 gate，`pendingReplyResolvers` 残留 + onclose 钩子泄漏。修复：token 切换 → `dispose()` 旧 gate（清空 resolvers + 标 stale + 关闭条件回调）→ 再 `initiateRecovery()`；onclose 路径对称 dispose。新增 `useRef` gate + `useEffect` cleanup 对称（StrictMode 双挂载也安全）。
2. **replyResolvers JSDoc 失真** — 注释写"按 reply_to 路由"，实际是「一次性 resolver，命中即 delete」——文档与代码语义错位。修复：JSDoc 重写，明确「一次性使用 / 单 reply_to 单 resolver / 命中后从 Map 删除 / 兜底 stale 检查」。
3. **`setBlockedOn` 浅相等守护** — 旧实现：每次 session_state 都 `setBlockedOn(newArray)`，React reconciliation 当数组浅不相等时（即便内容一致）触发下游重渲染。修复：浅相等检查 `prev.length === next.length && prev.every((e, i) => e.id === next[i].id)` 才更新；session_phase 同理。
4. **4 处静默吞异常补 `warn`** — `parseSnapshot` / `parseGetStateResult` / `session_state` 帧 / reply resolver 兜底分支，全部 `catch {}` → `console.warn('[recovery]', e)`，便于联调时从 console 捕获 zod 漂移。
5. **`tryDecodeGetStateData` 共享解码** — `WsClient` 与 `recovery.ts` 各自重复 `SessionStatePayloadSchema.safeParse` 逻辑；提取 `decodeSessionStatePayload(raw)` 单点函数（zod 错误统一 warn 形态），两处复用。

**4 项 Suggestion 全落地**：

- **useRef / useCallback 类成员** — `RecoveryView` 内部 gate 改用 `useRef` 持有（不参与 React 渲染）+ `useCallback` 包装 retry dispose 回调，避免每次渲染重建 gate 导致 resolver 失效。
- **ConnState 类型** — `WsClient` 连接态由裸 `'connecting'|'open'|'closed'` 字符串 → 判别联合 `type ConnState = { status: 'connecting' } | { status: 'open' } | { status: 'closed'; code?: number; reason?: string }`，closed 态附 close code/reason，`App.tsx` 失败态可读 code 决定文案。
- **CSS selector 合并** — `RecoveryInFlight` / `RecoveryErrorCard` / `ChatView` 三处 `.recovery-` 类合并为单一 `.recovery-view` + `[data-state="..."]` 属性选择器，CSS 文件行数 -30%。
- **`autoStartConsumedRef` 改名** — 旧名暗示"自动启动消费"，实际语义是"StrictMode 双挂载吸收"，改名 `strictModeMountAbsorbedRef`（自解释 + JSDoc 钉死用途）。

web build **232 KB**（较 06 的 227.6 KB +4.4 KB：recovery.ts + 三态组件 + WsClient registerReplyResolver + ConnState 改造）；工作区全量 **237 条测试不变**（web 包 M2 起无 vitest，沿用范围不变）。

### 三个合理偏差（reviewer 认可）

1. **result 集中处理保持 store 同步** — 旧设计：recovery.ts 内部消化 result 不进 WsClient，store 需另起一条路径同步。修复：`WsClient` 暴露 `registerReplyResolver` 注册一次性回调，recovery.ts 注册两个 resolver 后 result 同时更新 WsClient 内部 store（sessionPhase + blockedOn + messages 三态），保证「recovery ready」与「store 已就绪」原子同步；避免 ready=true 但 store 仍空的撕裂态。
2. **`connState` 门控防 send 静默丢** — `WsClient.sendEnvelope` 在 `connState !== 'open'` 时不再 throw，直接 `console.warn('[ws] send dropped, connection not open')` + return；App 层用 `connState` 判别决定是否启用输入框（避免用户输入后静默丢失）。这是双查询仪式的边界条件——握手成功后到 ready 之间窗口期用户可能误输入 prompt。
3. **`useRef` gate 防 StrictMode 双挂载** — React StrictMode 开发模式故意双挂载组件测试 cleanup；旧实现用 `useState` 持 gate 会被双 mount 触发两次 `initiateRecovery`，resolver 注册两次导致第二条回复命中旧 resolver 而新 gate 永远 pending。修复：`useRef` 持 gate（跨 mount 同一引用）+ `useEffect` cleanup 对称 dispose + `strictModeMountAbsorbedRef` 吸收首挂载副作用。

### 5s 超时含 exited spawn 场景余量说明

PRD §非目标明确"环形缓冲补发"归 M+，故 5s 超时设计不留补发余地，但**已为 exited 触发 spawn 场景留余量**：

- `exited` 状态时 bridge 收 `get_messages` 触发带 `--session` 的 spawn（PRD §2.7，任务 04 已落）；spawn 启动 pi 子进程 + 加载历史可能耗时 1-2s（本地实测），bridge 处理 snapshot + 转发 envelope 再 0.5-1s。
- 5s timer 给整条链路（web send → bridge 收 → spawn → pi 加载 → bridge 转发 → web 收）预留 2-3s 真实业务耗时 + 1-2s 余量。
- 若超时真触发 → `error: 'snapshot_failed'`（或 `state_failed`）→ `RecoveryErrorCard` 显示「重试」按钮，用户可手动重发；不会卡死或静默丢。
- 5s 常量集中在 `recovery.ts` 顶部 `const REPLY_TIMEOUT_MS = 5000`（任务内单点，调参改一处），未暴露配置项（M3 范围内无此需求）。

### web 链 06→07 收官

- 任务 06（[[tasks/m3/06-web-chat.md|06-web-chat]]）交付 ChatView / 4 类弹窗 / WsClient 状态机；
- 任务 07（本任务）交付双查询恢复仪式 + reply_to 分流 + 失败重试 + F5 同路径；
- 二者接缝：`App.tsx` 在 token 存在 → `RecoveryView` ready → `ChatView`；ready 失败显示 `RecoveryErrorCard` 含重试按钮（点重试 → dispose + initiate）。
- 任务 08（[[tasks/m3/08-docs-and-validation.md|08-docs-and-validation]]）接手：ADR-0003/0004 补注（任务 06 两条挂账 work_dir 降级显示 / ConfirmDialog 三按钮表述）+ pi.md 三按钮模型写清 + current-state TODO + getting-started §3.5 配置 JSON 字段说明 + 三端联调手测验收 14 条（合并 §6.1/§6.2/§6.3/§6.4）。
