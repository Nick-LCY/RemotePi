# control 家族：连接与会话生命周期

> 状态：定稿（2026-09-05），协议版本 v1。字段与语义变更须走 [[architecture/protocol/envelope.md]] 的版本化流程。

## 家族定位

`control` 家族承载**连接建立、保活、在位状态与会话管理**，是控制面而非对话面。中间层只深度理解其中 3 个 type——`handshake`（鉴权）、`bridge_status`（自己生成）、`error`（自己生成）——其余一律原样转发。详见 [中间层处理规则](#中间层处理规则)。

共 8 个 type：`handshake` / `ping` / `pong` / `bridge_status` / `session_state` / `session_list` / `result` / `error`。

---

## 1. handshake

连上后的第一帧。

```json
{
  "v": 1,
  "kind": "control",
  "type": "handshake",
  "id": "…",
  "payload": {
    "role": "bridge",
    "token": "x9K…"
  }
}
```

- **方向**：web / bridge → 中间层
- **payload**：
  - `role`：`"web" | "bridge"`，必填。
  - `token`：string，必填，与连接升级时 WebSocket subprotocol 第 2 元素一致（见 [[architecture/protocol/envelope.md#锁版承诺v1-存续期内不可变]]）。
- **规则**：
  - 连接建立后 **5 秒内** 必须收到 handshake，超时则回 `error(auth_failed)` 并断开（见 [配套常量](#配套常量)）。
  - `role` 与连接入口路径（`/web` / `/bridge`）不符 → `error(auth_failed)`。
  - 同一 token 已有 bridge 在线，第二个 bridge → `error(duplicate_bridge)`。
- **备注**：token 颁发方式（bridge 启动时动态生成、网页经 URL 携带、吊销流程等）属**产品流程**，由后续 PRD 定义；本文档只约束 wire 行为。

---

## 2. ping

```json
{ "v": 1, "kind": "control", "type": "ping", "id": "…", "payload": { "nonce": "a1b2" } }
```

- **方向**：web / bridge 双方互发；中间层原样转发到对端。
- **payload**：`nonce`：string，可选但建议携带，用于配对 pong。
- **规则**：每 **20 秒** 发一次（见 [配套常量](#配套常量)）。

---

## 3. pong

```json
{ "v": 1, "kind": "control", "type": "pong", "id": "…", "payload": { "nonce": "a1b2" } }
```

- **方向**：web / bridge 收到 ping 后回发；中间层原样转发到对端。
- **payload**：`nonce`：原样带回对端 ping 的 `nonce`（nonce 即配对凭据，**不用** `reply_to`）。
- **规则**：**30 秒**未收到 pong 记一次超时；连续 **3 次** 认定对端已死，断开并广播 `bridge_status(reason=stale)`。
- **设计理由**：长连接可能被中间网络设备静默掐断且本端无感知，应用层互喊是唯一可靠的存在性探测。

---

## 4. bridge_status

bridge 在不在线（由中间层生成）。

```json
{
  "v": 1,
  "kind": "control",
  "type": "bridge_status",
  "id": "…",
  "payload": {
    "online": false,
    "changed_at": "2026-09-05T10:00:00Z",
    "reason": "stale"
  }
}
```

- **方向**：中间层 → 所有网页（广播）。
- **payload**：
  - `online`：boolean。
  - `changed_at`：ISO8601 时间戳。
  - `reason`：`"connected"`（连上）/ `"closed"`（连接断开）/ `"stale"`（心跳判死）。
- **触发时机**：bridge 完成 handshake / bridge 连接断开 / 心跳判死；新网页完成 handshake 后**立刻补发一条当前状态**。
- **设计理由**：由中间层发是因为 bridge 无法播报自己的死讯——崩溃、断网时它什么都发不出来。离线显示不区分正常停止与崩溃（用户不关心，故不设 bye 消息）。

---

## 5. session_state

某个会话的 pi 进程在哪个生命周期阶段（由 bridge 发）。

```json
{
  "v": 1,
  "kind": "control",
  "type": "session_state",
  "id": "…",
  "session": "…",
  "payload": { "phase": "idle" }
}
```

- **方向**：bridge → 所有网页（广播）。
- **会话字段**：一条消息对应一个 pi 进程；envelope `session` 字段区分；单进程阶段可省略。
- **payload**：
  - `phase`：`"spawning"`（启动中）/ `"ready"`（可用）/ `"running"`（干活中）/ `"idle"`（空闲）/ `"exited"`（已退出）。
- **规则**：一轮对话结束（pi 报 `agent_settled`）→ `idle`；空闲满 5 分钟 bridge 杀掉 pi 进程 → `exited`。
- **设计理由**：状态属于 pi 进程而不属于 bridge（一个 bridge 可能同时管理多个 pi 进程），故按会话一条。

---

## 6. session_list

拉取对话列表。

```json
{ "v": 1, "kind": "control", "type": "session_list", "id": "r1", "payload": {} }
```

- **方向**：web → bridge（中间层转发）。
- **payload**：当前为空对象 `{}`；将来支持多工作目录时再加过滤字段。
- **回执**：走 `result`（见 [§7](#7-result)）。

---

## 7. result

control 请求的通用回执。

```json
{
  "v": 1,
  "kind": "control",
  "type": "result",
  "id": "…",
  "reply_to": "r1",
  "payload": { "ok": true, "data": { "sessions": […] } }
}
```

- **方向**：bridge → web。
- **信封字段**：`reply_to` **必填**，指向请求的 `id`。
- **payload**：
  - `ok`：boolean。
  - `data`：成功时携带（结构随请求 type 而变）。
  - `error`：失败时携带 `{ code, message }`。
- **`session_list` 回执**：`data.sessions` 为数组，每项字段：

  | 字段 | 类型 | 说明 |
  |------|------|------|
  | `id` | string | 会话标识 |
  | `name` | string \| null | 会话名，可空 |
  | `cwd` | string | 工作目录 |
  | `created` | ISO8601 | 创建时间 |
  | `modified` | ISO8601 | 最后活跃时间 |
  | `message_count` | number | 消息数 |
  | `first_message` | string \| null | 首条消息摘要，可空 |
  | `running` | boolean | 该会话的 pi 进程是否存活（含空闲）；正在干活与否看 `session_state` |

---

## 8. error

出错定向发回肇事方（由中间层生成）。

```json
{
  "v": 1,
  "kind": "control",
  "type": "error",
  "id": "…",
  "payload": { "code": "duplicate_bridge", "message": "…", "terminal": true }
}
```

- **方向**：中间层 → 肇事连接，**不广播**。
- **payload**：
  - `code`：见下表，**全集只增不改、不复用**。
  - `message`：人类可读描述。
  - `terminal`：boolean。`true` 表示发完即断开 WebSocket（关闭码统一 `1008`，见 [配套常量](#配套常量)）；`false` 表示发完继续。
- **错误码全集**：

  | code | 触发条件 | terminal |
  |------|----------|----------|
  | `auth_failed` | token 不符 / handshake 超时 / role 与入口不符 | true |
  | `duplicate_bridge` | 同 token 已有 bridge 在线 | true |
  | `invalid_envelope` | 消息结构解析失败 | false |
  | `unsupported_version` | `v` 不是 `1` | true |
  | `unsupported_type` | type 不识别且无法转发处理时 | false |
  | `internal` | 中间层内部异常 | false |

---

## 配套常量

| 常量 | 数值 | 出处 |
|------|------|------|
| handshake 等待窗口 | 5 秒 | §1 |
| ping 间隔 | 20 秒 | §2 |
| pong 超时 | 30 秒 | §3 |
| 判死次数（连续 pong 超时） | 3 次 | §3 |
| fatal 关闭码（WebSocket） | `1008` | §8 / [[architecture/protocol/envelope.md#锁版承诺v1-存续期内不可变]] |
| 空闲杀进程倒计时 | 5 分钟 | §5 |

> 数值为初始经验值，实现时可调，调整属 [[conventions/README.md|实现约定]] 范畴。

## 中间层处理规则

中间层只深度处理以下 3 件事：

1. **handshake** —— 完成鉴权（token / role / 超时窗口 / duplicate 检测）。
2. **bridge_status** —— 自己生成，触发条件见 §4。
3. **error** —— 自己生成，触发条件见 §8。

其余消息一律原样转发：`ping` / `pong` / `session_list` / `result` / `session_state` 以及整个 [[architecture/protocol/pi.md|pi 家族]]。