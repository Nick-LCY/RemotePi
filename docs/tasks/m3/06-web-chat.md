---
prd: prds/m3-single-session.md
status: todo
---
# 任务：web 聊天界面（消息流 + 队列 + abort + 4 类弹窗组件 + 倒计时 + 关闭规则 + 提交失败处理）

## 目标
按 [[prds/m3-single-session.md|M3 PRD §4.1 / §4.2 / §4.3 / §4.5]] 落地 web 端聊天界面 + 4 类阻塞弹窗组件。`WsClient` 扩展 pi 家族入站分流；新增 `<ChatView />` 主组件 + `<MessageList />` / `<InputBar />` / `<QueueIndicator />` + 4 类 `<XxxDialog />`（SelectDialog / ConfirmDialog / InputDialog / EditorDialog）+ `<PhaseIndicator />`。所有状态仅由事件 / 状态帧驱动（无乐观 UI，H 决策）。

关键要点：

- **扩展 `packages/web/src/ws/WsClient.ts`**：
  - 新增出站方法：`sendPrompt(content)` / `sendSteer(content)` / `sendFollowUp(content)` / `sendAbort()` / `sendGetMessages(since?)` / `sendExtensionUIResponse({request_id, cancelled, value?})` —— 用 `crypto.randomUUID()` 生成 id（沿用既有 `makeId`）
  - 新增入站订阅：`on('session_state')` / `on('snapshot')` / `on('command_result')` / `on('pi_event')` 等
  - 入站状态机：handle pi/event 时按 `payload.event` 分流（`message_update` → streamingDraft 累加 text_delta；`message_end` → messages 收敛 + 清空 streamingDraft；`agent_settled` → 输入框可用 + UI 提示；`extension_ui_request` → blockedOn 入列；`queue_update` → 更新 queue.steering / queue.followUp）
  - 新增状态字段：`messages: AgentMessage[]` / `streamingDraft: AgentMessage | null` / `queue: { steering: string[]; followUp: string[] }` / `sessionPhase: SessionPhase` / `blockedOn: BlockedOnEntry[]`（沿用 PRD §4.1 WebState）
- **新增 `packages/web/src/components/ChatView.tsx`**：
  - 顶部 `<PhaseIndicator />`：StatusBar 下方一行小字显示 phase（spawning / ready / running / idle / exited）+ 当前 work_dir（从配置元数据或 StatusBar 透传）
  - 中部 `<MessageList />`：流式渲染 streamingDraft + 历史 messages；`message_end` 用权威 message 全量覆盖
  - `<QueueIndicator />`：显示 `queue.steering.length` + `queue.followUp.length`
  - 底部 `<InputBar />`：输入框 + abort 按钮（活态于 `phase === 'running'`）；发 prompt 调用 `sendPrompt`；agent_settled 后输入框可用 + UI 提示"agent 已就绪（5 分钟后自动休眠）"
- **新增 4 类弹窗组件 `packages/web/src/components/dialogs/`**：
  - **`SelectDialog.tsx`**：渲染 title + options 单选列表；提交 `{ request_id, cancelled: false, value: <option string> }`
  - **`ConfirmDialog.tsx`**：渲染 title + message + "确认" / "取消" 按钮；提交 `{ request_id, cancelled: false, value: true | false }`（**"否" = `value: false`，R2 修正；confirm 的 value 始终为 boolean**）
  - **`InputDialog.tsx`**：渲染 title + placeholder 输入框；提交 `{ request_id, cancelled: false, value: <text> }`
  - **`EditorDialog.tsx`**：渲染 title + prefill 多行 textarea；提交 `{ request_id, cancelled: false, value: <text> }`
  - **倒计时**：timeout 存在 → 头部显示 `剩余 Ns` + 进度条（每秒更新）；不存在（仅 editor）→ 不显示倒计时（接受为已知行为，PRD 决策 8）
  - **取消按钮**：所有 4 类都有"取消"按钮 → 发 `{ request_id, cancelled: true }`（**不附 value**）
  - **关闭规则**：session_state 帧 blocked_on 不含该 id → 自动收起（即使本地"已提交待确认"）；组件维护本地 `Map<request_id, DialogState>`
- **提交失败处理（§4.5）**：
  - 弹窗组件：收到 `command_result{success:false, error.code === 'request_expired'}` → 显示错误 toast + 自动收起
  - 普通命令（prompt / steer / follow_up）：输入框临时显示错误提示（"pi 已不再处理该请求，可能是 idle 超时 kill"），不重发
- **无乐观 UI（H 决策）**：本地任何操作（提交弹窗、发 prompt）→ 立刻显示"已提交待确认"暂态 → 等下一个事件 / 状态帧确认 → 才视为生效
- **并发多弹窗**：按 id 独立显示在主界面之上的层叠容器（罕见；协议不假设至多一个）
- **App.tsx 路由**：token 存在 + 恢复仪式完成（任务 07 暴露 `ready` 状态）→ 渲染 `<ChatView />`；否则 TokenPrompt / "恢复失败"重试按钮
- **exited 状态**：发 prompt / steer / follow_up 或由恢复仪式发 get_messages 都会触发 spawn，UI 显示 `exited → spawning` 过渡态；abort 在 exited 为 no-op（按钮可点但回 `command_result{success: true}` 不改变状态）

## 完成标准
- [ ] `packages/web/src/ws/WsClient.ts`：新增 send* 出站方法 + pi/event 入站分流（message_update 累加 / message_end 覆盖 / agent_settled 触发输入框可用 / extension_ui_request 入 blockedOn / queue_update 更新 queue）+ 新增状态字段
- [ ] `packages/web/src/components/ChatView.tsx`：主组件含 `<PhaseIndicator />` / `<MessageList />` / `<QueueIndicator />` / `<InputBar />`
- [ ] `packages/web/src/components/dialogs/` 新建 4 类组件：SelectDialog / ConfirmDialog（含 `value: false` 提交路径）/ InputDialog / EditorDialog（无 timeout 不显示倒计时）
- [ ] 每组件实现：倒计时（timeout 存在时）+ 取消按钮 + 提交失败 toast（`request_expired` 触发）+ 关闭规则（session_state blocked_on 不含该 id 收起）
- [ ] `packages/web/src/App.tsx`：token 存在 + 恢复仪式 ready（任务 07 暴露）→ 渲染 `<ChatView />`
- [ ] `pnpm --filter @remotepi/web build` 成功产出 `dist/`；`pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿
- [ ] `grep -R "localStorage" packages/web/src/ws/` 零结果（token 仅内存 + hash）；`grep "value: false" packages/web/src/components/dialogs/ConfirmDialog.tsx` 命中（confirm 否路径）
- [ ] 组件逻辑验证：按 PRD §6.4 清单逐条手测（与任务 08 三端联调手测验收合并执行——web 包沿用 M2 不引入 vitest + RTL 测试基建，避免范围蔓延）

## 依赖
- 依赖 [[tasks/m3/01-shared-protocol-v2.md|01-shared-protocol-v2]]（需要 pi 家族 schema + BlockedOnEntry + ExtensionUIResponsePayload）
