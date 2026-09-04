# 信封规范与版本化

> 状态：定稿（2026-09-05），协议版本 v1。字段与语义变更须走 [[architecture/protocol/envelope.md]] 的版本化流程。

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
- [[architecture/protocol/control.md]] 全部 8 个 type 名及其 payload 字段集。
- 连接升级时 WebSocket subprotocol 携带格式：`["remotepi.v1", token]`——**位置 0** 为版本号，**位置 1** 为鉴权 token（与 [[architecture/protocol/control.md#1-handshake|handshake]] payload 中的 `token` 字段一致）。
- fatal 关闭的统一 WebSocket 关闭码：`1008`。

### 演进规则（v1 存续期内允许）

- **(a) 新增可选字段**：信封与各 type 的 payload 均可新增可选字段，已知消费者必须忽略未知字段。
- **(b) 扩充 type 集合**：可向 `pi` 家族新增 type（见 [[architecture/protocol/pi.md]]）；`control` 家族 v1 内不再新增 type（错误码 `unsupported_type` 触发时另议，见 [[architecture/protocol/control.md#8-error]]）。
- **(c) pi/event 的 event 名开放集合**：`event` 的 `event` 字段名集合开放，pi 升级新增事件无须改本协议。

### 未知项处理

- **未知 `type`**：中间层照常转发，对端忽略。开发模式下可在 console 输出诊断警告。
- **未知字段**：一律忽略，不报错。

### 版本升级流程（v1 → v2 触发时）

- `v` 字段升级必须连带 subprotocol 升级（如 `remotepi.v2`），握手前完成版本协商。
- 协商失败（任一端不支持对方版本）即 [[architecture/protocol/control.md#1-handshake|handshake 失败]]，连接断开。
- 老版本兼容期的灰度流程届时另定。