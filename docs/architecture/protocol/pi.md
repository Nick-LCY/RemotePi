# pi 家族：对话内容

> 状态：定稿（2026-09-05），协议版本 v1。字段与语义变更须走 [[architecture/protocol/envelope.md]] 的版本化流程。

## 定位

`pi` 家族承载**对话内容**，网页与 bridge 是唯一的两端；`kind=pi` 的消息中间层一律**原样转发**，中间层不解析、不重组。

`type` 命名镜像 pi 的命令名（v0.84.4），payload 字段尽量对齐 pi 原生形态——**实现时以 `rpc-types.d.ts` 为准核实字段名与形状**；本文档先记字段语义，不写死原生细节（凡标注「实现时核实」处须落地前与包内类型核对）。

共 9 个 type：命令 6 个（prompt / steer / follow_up / abort / get_messages / extension_ui_response）+ 回执 / 事件 3 个（command_result / snapshot / event），详见下文。

---

## 命令（网页 → bridge）

### prompt

正常发言。

```json
{ "v": 1, "kind": "pi", "type": "prompt", "id": "c1", "payload": { "content": "…" } }
```

- **payload**：`content`：string，用户输入文本。

### steer

干活中途插话。

```json
{ "v": 1, "kind": "pi", "type": "steer", "id": "c2", "payload": { "content": "…" } }
```

- **payload**：`content`：string，插入到当前轮次的引导文本。

### follow_up

排队追加。

```json
{ "v": 1, "kind": "pi", "type": "follow_up", "id": "c3", "payload": { "content": "…" } }
```

- **payload**：`content`：string，等当前轮结束后再投入。

### abort

停止。

```json
{ "v": 1, "kind": "pi", "type": "abort", "id": "c4", "payload": {} }
```

- **payload**：空对象。

### get_messages

拉取历史。

```json
{ "v": 1, "kind": "pi", "type": "get_messages", "id": "c5", "payload": { "since": "…" } }
```

- **payload**：`since`：可选，按消息时间戳或序号过滤；**缺省全量**。

### extension_ui_response

回应阻塞弹窗（web wire 形状）。

```json
{
  "v": 1,
  "kind": "pi",
  "type": "extension_ui_response",
  "id": "c6",
  "payload": { "request_id": "…", "cancelled": false, "value": "…" }
}
```

- **payload**（web wire 形状）：
  - `request_id`：弹窗请求事件中的 pi 原生 `id`，**原样带回**（pi v0.85.1 已实证所有 9 类 `extension_ui_request` 方法均携带稳定 UUID `id`，无须兜底关联）。
  - `cancelled`：boolean。`true` 表示用户取消（不附 `value`）；`false` 表示用户提交（`value` 必填）。
  - `value`：可选；类型为 `string | boolean`。`cancelled: true` 时不出现；`cancelled: false` 时必须出现：
    - `confirm` 走 `boolean`——`true` 确认、`false` 拒绝（这是 confirm 表达"否"的唯一通道，详见 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]]）；
    - `select` / `input` / `editor` 走 `string`。
- **bridge 翻译注记**：bridge 收 web wire 后翻译为 pi 原生三态（web 端统一布尔取消语义，pi 原生 schema 封装在 bridge 内部）：
  - `cancelled: true` → 写 `{ type: 'extension_ui_response', id, cancelled: true }`；
  - `cancelled: false` + 原 method 为 `confirm` → 写 `{ id, confirmed: value as boolean }`；
  - `cancelled: false` + 原 method 为 `select` / `input` / `editor` → 写 `{ id, value: value as string }`。

> `value` 类型放宽为 `string | boolean` 是为 confirm 的"否"提供语义通道（`value: false`）。shared 层不做 `confirm` / 其他方法的 `value` 类型区分——bridge 维护原 method 信息，按对应分支配对即可。

---

## 回应与事件（bridge → 网页）

### command_result

所有命令的通用回执。

```json
{
  "v": 1,
  "kind": "pi",
  "type": "command_result",
  "id": "…",
  "reply_to": "c1",
  "payload": { "command": "prompt", "success": true, "data": …, "error": … }
}
```

- **信封字段**：`reply_to` **必填**，指回命令 `id`。
- **payload**：
  - `command`：被回执的命令 type 名。
  - `success`：boolean。
  - `data`：成功时携带，结构由具体命令决定。
  - `error`：失败时携带 `{ code, message }`。

### snapshot

`get_messages` 的回执——完整消息数组，网页用它**收敛整个对话视图**。

```json
{
  "v": 1,
  "kind": "pi",
  "type": "snapshot",
  "id": "…",
  "reply_to": "c5",
  "payload": { "messages": [ … ] }
}
```

- **信封字段**：`reply_to` **必填**。
- **payload**：`messages`：消息数组，每项结构与 pi 原生消息一致。

### event

pi 事件原样装填。

```json
{
  "v": 1,
  "kind": "pi",
  "type": "event",
  "id": "…",
  "payload": { "event": "message_update", "data": { … } }
}
```

- **payload**：
  - `event`：事件名，**集合开放**——pi 升级新增事件无须改本协议，未识别事件网页端忽略。
  - `data`：事件负载，结构随事件名变化。

常见事件名（与 pi v0.85.1 对齐，已实证存在）：

| 事件 | 含义 |
|------|------|
| `agent_start` / `agent_end` / `agent_settled` | agent 进程粒度的起止与一轮对话结束（agent_settled 触发 bridge 启动 5min idle 计时，详见 ADR-0003） |
| `turn_start` / `turn_end` | 一轮 turn 的起止 |
| `message_start` / `message_update` / `message_end` | 一条消息的起 / 流式增量（text_delta 等，仅用于打字机暂显）/ 终（权威覆盖） |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | 一次工具调用的起 / 流式增量 / 终 |
| `queue_update` | steering + follow_up 队列变化（web 端据比显示队列条数） |
| `entry_appended` | 日志条目追加 |
| `extension_ui_request` | 阻塞式弹窗请求（要求网页响应；所有 9 类方法携带稳定 UUID `id` 字段） |
| `ui_prompt_start` / `ui_prompt_end` | 一次阻塞交互的起 / 终（与 `extension_ui_request` 互补；用于 UI 帧状态补全） |

> 上述集合**不封闭**：pi 升级新增事件无须改协议，未识别事件网页忽略。

---

## 关联规则

| 关联场景 | 用什么字段 | 说明 |
|----------|-----------|------|
| control 请求 ↔ 回执 | envelope `reply_to` | 见 [[architecture/protocol/control.md#7-result]] |
| pi 命令 ↔ `command_result` | envelope `reply_to` | 见上文 |
| `get_messages` ↔ `snapshot` | envelope `reply_to` | 见上文 |
| pi 内部：流式增量 ↔ 所属消息 | payload `data.messageId`（pi 原生） | message_update / tool_execution_update 携带 |
| 弹窗请求 ↔ 回应 | payload `request_id` | extension_ui_request ↔ extension_ui_response |
| ping ↔ pong | payload `nonce` | **不用** `reply_to` |

> 信封级 `reply_to` 只用于 `command_result` 与 `snapshot`——自家协议只关联自家事务；pi 内部的关联用 pi 原生 id 放 payload。

## 渲染规则（网页实现必须遵守）

- **`message_update` 携带的增量**（如 `text_delta` 等）**只用于打字机式暂显**——它是不完整快照。
- **`message_end` 里的完整消息是权威内容**，可随时覆盖重画，丢弃之前的 `message_update` 暂显态。
- **`agent_settled` 表示一轮结束**，网页须：恢复输入框可用、开始空闲计时（bridge 会在空闲 5 分钟后回收 pi 进程，经 [[architecture/protocol/control.md#5-session_state|session_state]] 播报）。

## 多会话扩展（预留）

多会话阶段将：

- 在 `pi` 家族新增 type（如 `new_session` / `switch_session` / `list_directories` 等）及其 `command_result` 回执。
- envelope `session` 字段**必填**以区分会话。
- `control` 家族 v1 内除已破锁的 `get_state` 外不再新增 type（破锁依据见 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]]；会话列表 session_list 已在其内）；会话的新建 / 切换 / 目录浏览等操作在 `pi` 家族内表达。