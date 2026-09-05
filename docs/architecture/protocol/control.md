# control 家族：连接与会话生命周期

> 状态：定稿（2026-09-05），协议版本 v1。字段与语义变更须走 [[architecture/protocol/envelope.md]] 的版本化流程。

## 家族定位

`control` 家族承载**连接建立、保活、在位状态与会话管理**，是控制面而非对话面。中间层只深度理解其中 3 个 type——`handshake`（鉴权）、`bridge_status`（自己生成）、`error`（自己生成）——其余一律原样转发。详见 [中间层处理规则](#中间层处理规则)。

共 9 个 type：`handshake` / `ping` / `pong` / `bridge_status` / `session_state` / `session_list` / `get_state` / `result` / `error`。M3 起 `get_state` 加入（破锁 control 家族 v1 内不再新增 type 的承诺，理由见 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]]）。

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
  - 服务端在 101 升级响应中必须回显 Sec-WebSocket-Protocol: remotepi.v1（RFC 6455：客户端带 subprotocol 而服务端不回显/回显多项，浏览器会判握手失败——已实测 workerd 默认不回显，需显式设置；2026-09-05 M2 联调确认）。
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

> 备注：中间层亦可主动向连接发送 ping 用于自身判死（如 bridge 心跳超时判定 stale）；这不改变 ping/pong 的转发语义，也不新增 wire 字段。（v1 兼容补充，2026-09-05）

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
  "payload": {
    "phase": "idle",
    "blocked_on": [
      { "method": "confirm", "id": "…", "title": "…", "message": "…", "timeout": 30000 }
    ]
  }
}
```

- **方向**：bridge → 所有网页（广播）。
- **会话字段**：一条消息对应一个 pi 进程；envelope `session` 字段区分；单进程阶段可省略。
- **payload**：
  - `phase`：`"spawning"`（启动中）/ `"ready"`（可用）/ `"running"`（干活中）/ `"idle"`（空闲）/ `"exited"`（已退出）。
  - `blocked_on`（M3 新增，可选）：未决阻塞弹窗数组；缺省视为空数组。每项是 [[architecture/protocol/pi.md#extension_ui_request|4 类 `extension_ui_request` 阻塞方法]]之一（`select` / `confirm` / `input` / `editor`），形状与 pi 原生 `extension_ui_request` 对应阻塞方法同形（`method` / `id` / `title` / 方法专属字段 / 可选 `timeout`，editor 无 `timeout`）；fire-and-forget 5 类（`notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`）不入此数组，详见 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]]。
- **规则**：一轮对话结束（pi 报 `agent_settled`）→ `idle`；空闲满 5 分钟 bridge 杀掉 pi 进程 → `exited`。`blocked_on` 在弹窗出现 / 提交 / 超时时同步增删。
- **设计理由**：状态属于 pi 进程而不属于 bridge（一个 bridge 可能同时管理多个 pi 进程），故按会话一条。`blocked_on` 与 session_state 同帧广播是为了让 web 端弹窗组件仅由状态帧驱动渲染（无乐观 UI），详见 ADR-0004。

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

## 6.5 get_state

拉取当前会话的 pi 进程状态 + 未决阻塞弹窗（由 bridge 发，回执走 `result`）。

```jsonc
// web → bridge
{ "v": 1, "kind": "control", "type": "get_state", "id": "g1", "payload": {} }

// bridge → web（result 回执）
{
  "v": 1,
  "kind": "control",
  "type": "result",
  "id": "g2",
  "reply_to": "g1",
  "payload": {
    "ok": true,
    "data": {
      "phase": "ready",
      "blocked_on": [
        // 可选；与 session_state.payload.blocked_on 同形状
        { "method": "input", "id": "…", "title": "…", "placeholder": "…" }
      ]
    }
  }
}
```

- **方向**：web → bridge（中间层转发到 bridge），bridge → web 走 `result`（与 `session_list` 同形态）。
- **payload**：当前为空对象 `{}`；将来加过滤字段时按 [[architecture/protocol/envelope.md#演进规则v1-存续期内允许|envelope 演进规则 (a)]] 新增可选字段。
- **回执**：`result.data = { phase: SessionPhase, blocked_on?: BlockedOnEntry[] }`；`phase` 取值沿用 [§5](#5-session_state) 已锁版的 5 相位枚举（不破锁）；`blocked_on` 与 `session_state.payload.blocked_on` 同形状（可选数组，元素为 4 类 `extension_ui_request` 阻塞方法之一），缺省视为空数组。
- **回执失败**：`result.ok = false` 时 `error.code` 复用 [§8](#8-error) 已锁版的 6 个 code 集合（不允许新增）。
- **exited 语义**：bridge 永远由内存作答（phase / blocked_on 的当前值），**永不 spawn**——即使当前 phase 为 `exited`，也即时回执不触发重启；详见 ADR-0003 末尾 "exited 状态 spawn 触发集"。
- **破锁依据**：M3 新增，破锁 control 家族 v1 内不再新增 type 的承诺，理由见 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]]。

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
- **`get_state` 回执**（M3 新增）：`data = { phase, blocked_on? }`；`phase` 取值见 [§5](#5-session_state) 5 相位枚举；`blocked_on` 与 `session_state.payload.blocked_on` 同形状（可选数组，元素为 4 类 `extension_ui_request` 阻塞方法之一）。

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

其余消息一律原样转发：`ping` / `pong` / `session_list` / `get_state` / `result` / `session_state` 以及整个 [[architecture/protocol/pi.md|pi 家族]]。其中 `get_state` 由 web 发到 bridge，bridge 用本地内存作答（phase / blocked_on 的当前值），中间层不参与；result 是其回执。