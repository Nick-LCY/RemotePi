# 信封规范与版本化

> 状态：定稿（2026-09-05），协议版本 v1。字段与语义变更须走 [[architecture/protocol/envelope.md]] 的版本化流程。
>
> **M4 修订注记（2026-09-08）**：control 家族从 9 增至 13 type（破锁依据见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]]，沿用 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] 范式）；envelope 演进规则 (a) 同步追加多个可选字段（详见 [演进规则](#演进规则v1-存续期内允许)）。

信封是 RemotePi 隧道协议所有消息的共用外壳。**任何 web ↔ 中间层 ↔ bridge 之间传递的消息都必须包成此信封**；非信封形态的消息视为 [[architecture/protocol/control.md#8-error|invalid_envelope]]。

## 信封示例

```json
{
  "v": 1,
  "kind": "control",
  "type": "handshake",
  "id": "…",
  "session": "…",
  "reply_to": "…",
  "payload": {}
}
```

## 字段表

| 字段 | 必填 | 说明 |
|------|------|------|
| `v` | 是 | 协议版本，固定 `1`。见 [版本化](#版本化) 节。 |
| `kind` | 是 | 消息家族，取值 `"control"` 或 `"pi"`。见 [[architecture/protocol/README.md#协议总览]]。 |
| `type` | 是 | 家族内的消息名（控制类见 [[architecture/protocol/control.md]]，对话类见 [[architecture/protocol/pi.md]]）。 |
| `id` | 是 | 发送方生成的唯一标识，用于请求-响应关联。uuid 即可，格式不强制。 |
| `session` | 否 | 仅 `session_state` 与 `pi` 家族使用，标明属于哪个会话；单会话阶段省略。 |
| `reply_to` | 否 | 仅回执类消息使用：control 的 `result`；pi 的 `command_result` 与 `snapshot`。 |
| `payload` | 是 | 结构由 `kind` + `type` 联合决定，见各家族文档。 |

## 命名与实现约定

- 类型定义位于 `packages/shared/src/protocol/`；运行时三个组件（web / worker / bridge）共同依赖。
- 命名契约沿用 [[prds/m1-infrastructure.md|M1 裁定]]：
  - envelope 的 Zod schema 与推导类型**同名**（`HandshakeEnvelope` / `PingEnvelope` / `PromptEnvelope` …）；
  - payload 的 Zod schema 带 **`Schema` 后缀**（`HandshakePayloadSchema`），推导类型**不带后缀**（`HandshakePayload`）；
  - M2 扩展新 type 时沿用同一约定。

> 此节为落地核对项——实现时须与 `packages/shared/src/protocol/` 的实际导出同步校对。

## 版本化

### 锁版承诺（v1 存续期内不可变）

v1 一旦发布，以下几项即固化，存续期内不再变更：

- 信封字段名：`v` / `kind` / `type` / `id` / `payload`（`session` / `reply_to` 为新增可选字段时不受此限）。
- `v` 字面量值：`1`。
- [[architecture/protocol/control.md]] 全部 13 个 type 名：
  - M2 锁定的 8 个（`handshake` / `ping` / `pong` / `bridge_status` / `session_state` / `session_list` / `result` / `error`）；
  - M3 破锁新增的 1 个（`get_state`，见 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]]）；
  - M4 破锁新增的 4 个（`list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`，见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]]）。

  13 个 type 的 **payload 必填字段集** 亦锁版；可选字段的增删按 [演进规则 (a)](#演进规则v1-存续期内允许)。
- 连接升级时 WebSocket subprotocol 携带格式：`["remotepi.v1", token]`——**位置 0** 为版本号，**位置 1** 为鉴权 token（与 [[architecture/protocol/control.md#1-handshake|handshake]] payload 中的 `token` 字段一致）。
- fatal 关闭的统一 WebSocket 关闭码：`1008`。

> **envelope `session` 字段启用规则（多会话下操作惯例必填，schema 仍 optional 不破锁）**：schema 维持 optional（v1 锁版承诺"session / reply_to 为新增可选字段时不受此限"）；多会话下的操作惯例：
> - **web → bridge**：所有 pi 家族命令 + `get_state` / `session_list` 必须带 `session` 字段（缺省视为"作用于 bridge 默认 session"——M3 兼容路径，但 M4 ChoicePage 强制带）。
> - **bridge → web**：所有 `session_state` / `command_result` / `snapshot` / `event` 必须带 `session` 字段（M3 兼容路径下可省略，但 M4 推荐始终带，便于 web 按 session 过滤）。
>
> 该惯例不破锁，schema 维持 optional；详见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]] §决策.3。

### 演进规则（v1 存续期内允许）

- **(a) 新增可选字段**：信封与各 type 的 payload 均可新增可选字段，已知消费者必须忽略未知字段。M3 依据本规则新增：`session_state.payload.blocked_on`（数组，可选；元素为 4 类 `extension_ui_request` 阻塞方法之一，见 [[architecture/protocol/control.md#5-session_state|control §5]]）；`result.data.phase` / `result.data.blocked_on`（`get_state` 回执新增可选字段，与 `session_state.payload` 同形状，见 [[architecture/protocol/control.md#65-get_state|control §6.5]]）。
  **M4 依据本规则追加**（全部为可选字段，schema 锁版承诺不变）：
  - `session_list.payload.work_dir?: string`——按 work_dir 过滤会话清单；**M4 操作惯例必带**（裁定 A：强制两级选择后 web UI 必传，schema 仍 optional 不破锁；缺省全量扫描仅作 M3 兼容语义保留，M4 web UI 不走此路径）。
  - `session_state.payload.work_dir?: string`——每条广播携带对应 work_dir，便于 web 在 `ChoicePage` 列表直接渲染（不查 `session_list`）。
  - `pi/prompt.payload.work_dir?: string`——**仅 `session:'new'` 的 prompt 携带**（裁定 A 方案 A：新会话的第一条消息是唯一入口）；其他 session 状态下的 prompt 不带、bridge 忽略。schema 仅标注 optional（不强制与 `session` 关联），web 端发命令时遵守。
  - `result.data.work_dirs?: string[]`——`work_dir_list` 回执字段。
  - `result.data.entries?: { name: string, path: string }[]`——`list_directories` 回执字段。
  - `result.data.sessions?: SessionListEntry[]`（M4 沿用 M3 `session_list` 回执 shape，**新增** `status` 字段：`'exited' | 'idle' | 'running' | 'spawning' | 'unknown'`，5 枚举 + `unknown` 语义；既有字段与 `running` boolean 语义保留）。
- **(b) 扩充 type 集合**：可向 `pi` 家族新增 type（见 [[architecture/protocol/pi.md]]）；`control` 家族 v1 内除已破锁的 `get_state` / `list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove` 外不再新增 type（M3 破锁依据见 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]]；M4 破锁依据见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]]；错误码 `unsupported_type` 触发时另议，见 [[architecture/protocol/control.md#8-error]]）。
- **(c) pi/event 的 event 名开放集合**：`event` 的 `event` 字段名集合开放，pi 升级新增事件无须改本协议。

### 未知项处理

- **未知 `type`**：中间层照常转发，对端忽略。开发模式下可在 console 输出诊断警告。
- **未知字段**：一律忽略，不报错。

### 版本升级流程（v1 → v2 触发时）

- `v` 字段升级必须连带 subprotocol 升级（如 `remotepi.v2`），握手前完成版本协商。
- 协商失败（任一端不支持对方版本）即 [[architecture/protocol/control.md#1-handshake|handshake 失败]]，连接断开。
- 老版本兼容期的灰度流程届时另定。

### 相关

- 破锁依据：
  - [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006（control 8 → 9 type）]]
  - [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010（control 9 → 13 type + envelope (a) 多字段）]]
- 与锁版承诺协同的家族文档：[[architecture/protocol/control.md]]（含 M3 `get_state` / `result.data.phase` / `result.data.blocked_on` + M4 4 新 type / `session_list.payload.work_dir` / `session_state.payload.work_dir` / `session_list` 回执 `status` 字段）、[[architecture/protocol/pi.md]]（含 M3 9 type + M4 `pi/prompt.payload.work_dir` 仅 `session:'new'` 携带 + 多会话扩展正式落地）