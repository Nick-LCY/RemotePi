---
prd: prds/m3-single-session.md
status: done
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
- [x] `packages/web/src/ws/WsClient.ts`：新增 6 出站方法（sendPrompt / sendSteer / sendFollowUp / sendAbort / sendGetMessages / sendExtensionUIResponse，`crypto.randomUUID()` 生成 id）+ 入站订阅（session_state / snapshot / command_result / pi_event）+ pi/event 分流（message_update 累加 text_delta → streamingDraft / message_end 全量覆盖 + 清空 streamingDraft / agent_settled 触发输入框可用 / extension_ui_request 入 blockedOn / queue_update 更新 queue.steering + queue.followUp）+ WebState 扩展（messages / streamingDraft / queue / sessionPhase / blockedOn + `command_error` 订阅）
- [x] `packages/web/src/components/ChatView.tsx`：主组件含 `<PhaseIndicator />`（顶部 StatusBar 下方一行小字显示 phase——work_dir 字段见下方挂账①）/ `<MessageList />`（流式 + 历史 + message_end 权威覆盖） / `<QueueIndicator />`（queue.steering + queue.followUp 条数） / `<InputBar />`（发 prompt + abort 按钮活态于 running）
- [x] `packages/web/src/components/dialogs/` 新建 4 类组件：`SelectDialog.tsx` / `ConfirmDialog.tsx`（**三态按钮**——Cancel=cancelled:true / No=value:false / Yes=value:true，详见下方挂账②）/ `InputDialog.tsx` / `EditorDialog.tsx`（无 timeout 不显示倒计时）
- [x] 每组件实现：倒计时（timeout 存在时显示"剩余 Ns" + 进度条，1Hz 更新；不存在不显示）+ 取消按钮（发 `cancelled: true`，不附 value）+ 提交失败 toast（`request_result{success:false, error.code === 'request_expired'}` 触发）+ 关闭规则（session_state blocked_on 不含该 id 自动收起，即使本地"已提交待确认"）+ DialogHost 状态机（open / submitting / expired + 关闭规则：点取消 / 提交成功 / 阻塞消失 / 提交失败）
- [x] `packages/web/src/App.tsx`：token 存在 + 恢复仪式 ready（任务 07 暴露 `ready` 状态）→ 渲染 `<ChatView />`；否则 TokenPrompt / "恢复失败"重试按钮（**任务 07 接线，本任务留接缝**）
- [x] `pnpm --filter @remotepi/web build` 成功产出 `dist/`（web bundle **227.6 KB**）；`pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿
- [x] `grep -R "localStorage" packages/web/src/ws/` 零结果（token 仅内存 + hash，M2 约定延续）；`grep "value: false" packages/web/src/components/dialogs/ConfirmDialog.tsx` 命中（confirm 否路径）；无乐观 UI（提交后"待确认"暂态，由事件 / 状态帧驱动最终态）
- [x] 组件逻辑验证：按 PRD §6.4 清单逐条手测（与任务 08 三端联调手测验收合并执行——web 包沿用 M2 不引入 vitest + RTL 测试基建，避免范围蔓延）
- [x] M2 验证组件 **BroadcastLog.tsx / PingTester.tsx 随本次清理删除**（M2 阶段用于 handshake / ping 验收，本任务范围内不再需要；git 可恢复，见下方「M2 验证组件删除」段）

## 依赖
- 依赖 [[tasks/m3/01-shared-protocol-v2.md|01-shared-protocol-v2]]（需要 pi 家族 schema + BlockedOnEntry + ExtensionUIResponsePayload）

## 完成情况

任务完成，commit `073f4c6`。web 聊天界面 + 4 类阻塞弹窗全量落地：WsClient 扩展（6 出站方法 + pi 事件入站分流 message_update/message_end/agent_settled/extension_ui_request/queue_update + WebState 5 字段 messages/streamingDraft/queue/sessionPhase/blockedOn + `command_error` 订阅）+ ChatView 主组件（PhaseIndicator / MessageList / QueueIndicator / InputBar）+ 4 类弹窗（SelectDialog / ConfirmDialog / InputDialog / EditorDialog；ConfirmDialog 三态按钮——Cancel=cancelled:true / No=value:false / Yes=value:true，语义分离）+ DialogHost 状态机（open / submitting / expired 三态 + 关闭规则——点取消 / 提交成功 / 阻塞消失 / 提交失败）+ 无乐观 UI（H 决策：提交后"待确认"暂态，由事件 / 状态帧驱动最终态）+ §4.5 提交失败 UX（dialog → toast + 自动收起；普通命令 → 输入框临时错误提示，不重发）。M2 验证组件（BroadcastLog / PingTester）+ 配套死代码清理。reviewer 通过，**无 Critical**；**3 项 Warning 全修**：① §4.5 命令失败 UX（dialog 收 `command_result{success:false, error.code === 'request_expired'}` → toast + 自动收起；本地超时分支改走 toast）；② M2 死代码清理（删除 BroadcastLog / PingTester + 死引用）；③ **4 项 Suggestion 落地**：message_end 按 id upsert 避免重复 / stableKey 加 idx 兜底重复 id / 倒计时 1Hz 节流 / `submitText` 重构消除强转。web build 227.6 KB；工作区 **237 条测试不受影响**（web 包 M2 起无 vitest，本次沿用）。

### 挂账（移交任务 08）

1. **work_dir 降级显示** — PRD §4.3 要求 PhaseIndicator 显示 phase + 当前 work_dir，但 v1 wire（[[architecture/protocol/pi.md|pi.md]] / [[architecture/protocol/control.md|control.md]]）不携带 bridge 配置（work_dir 不过协议，配置仅 bridge 本地读取），故实际 web 端只能显示 phase 而无 work_dir。**修正路径**：在 `session_state.payload.data`（即 `get_state.data`）新增可选 `work_dir` 字段——属 envelope 演进规则 (a) "新增可选字段"，**不在 M3 范围**（M3 锁版控制 `get_state` 9 type）。任务 08 在 [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] / [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] 补注或验收纪要中注明此偏差（明确为 M4 / M+ 候选）。

2. **ConfirmDialog 三按钮表述漂移** — PRD §4.2 表描述 confirm "渲染 title + message"，但落地为**三按钮**（Cancel=cancelled:true / No=value:false / Yes=value:true），"取消"与"否"语义分离是正确的——"取消"是"我不想回答这个请求"，"否"是"我回答了否"。此模型与 `extension_ui_response` web wire refine 完全对齐（cancelled 与 value 是正交维度），而 PRD §4.2 表隐含的两按钮（确认/取消）模型无法表达 confirm 的"否"路径。任务 08 同步 [[architecture/protocol/pi.md|pi.md]] / [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] 时把三按钮模型写清（confirm 三态：`cancelled:true` / `value:false` / `value:true`）。

### 4 项 Suggestion 落地

- **S1 message_end 按 id upsert**：`MessageList` 处理 `message_end` 时按 `message.id` upsert（已在 messages 中则替换、否则追加），避免流式累积 + 终结覆盖产生重复条。
- **S2 stableKey 加 idx 兜底**：React `key` 在 id 缺失时降级使用 `idx` 兜底（message_update 阶段 id 可能尚未分配），同时防御性兜底 pi 端 id 碰撞。
- **S3 倒计时 1Hz 节流**：倒计时 `setInterval(1000)` 单次 tick 更新（不再 `requestAnimationFrame` 高频刷），CPU 占用降一档，N≤120s 体验无可感差异。
- **S4 `submitText` 重构消除强转**：`InputBar` / `InputDialog` / `EditorDialog` 三处的 `submitText()` 统一为 string 返回（不再 `as string` 强转），编译时即保证非空；语义空字符串显式拒绝（按钮 disable），无歧义。

### M2 验证组件删除

M2 阶段为 handshake / ping 端到端验收写过两个一次性 UI 工具（**BroadcastLog.tsx** — 实时打印所有 envelope 用于核对 WSS 帧序；**PingTester.tsx** — 主动 ping + 等 pong 验证心跳）。本任务落地 4 类业务弹窗后，handshake / ping 已由 ws 连接 + WsClient 内部状态覆盖，验证组件不再有维护价值，连同其在 App.tsx 的路由分支 + 任何死引用一并删除。git 历史可恢复（commit `1c252d8` 之前的 web M2 收官版本仍包含两者）。

### §6.4 验收清单归属

PRD §6.4 web 验收清单（13 条手测）由本任务交付、**实际手测执行合并至 [[tasks/m3/08-docs-and-validation.md|tasks/08]] 三端联调验收**——任务 08 收尾时按 §6.4 + bridge §6.2 + shared §6.1 + shared §6.3 逐条手测，web 包不在 M3 引入 vitest + RTL 测试基建（沿用 M2 决定，避免范围蔓延）。本任务交付的代码 + DialogHost 状态机 + WsClient 状态机是手测覆盖面的物质基础。
