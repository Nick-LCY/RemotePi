# RemotePi 隧道协议规范

> bridge / DO / web 三方在 RemotePi 隧道里发送的消息格式与交互规则。**本目录是该协议的唯一真相源。**

## 定位

- 与 [[roadmap.md#4-pi-rpc-协议要点|roadmap §4 pi RPC 协议]] 的关系：那是 pi 自己的线路协议（stdin / stdout JSONL），本目录是 RemotePi 在它外面套的 **JSON 隧道**协议——bridge 在 stdio 上与 pi 直接通信，隧道只承载 RemotePi 自己的信封与业务字段，不要把两层混为一谈。
- 拓扑角色由 [[architecture/decisions/0001-three-component-topology-with-cf-do.md|ADR-0001 三组件拓扑 + Cloudflare DO 中转]] 定义：web ↔ worker(DO) ↔ bridge；同房间所有连接共享隧道流。
- 协议的类型与运行时实现位于 `packages/shared/src/protocol/`（M1 创建）。
- **本目录规范随 M1 / M2 的 PRD 设计逐步填充**——M1 起草 envelope 与握手骨架，M2 校齐 token 配对 / 业务消息类型 / 错误码 / 版本化。M1 / M2 的 PRD 落地后，本目录相应章节会替换下方占位，并把完整规范沉淀下来。

## 章节骨架

- **信封格式 (envelope)** —— 顶层 JSON 结构、必选 / 可选字段、消息 ID、版本号。（待 M1 PRD 填充）
- **连接与握手** —— web 与 bridge 的连接建立顺序、keepalive / 心跳、关闭顺序、断连清理。（待 M1 PRD 填充）
- **token 配对** —— token 如何映射到 DO 实例；握手时的鉴权顺序；颁发与吊销流程。（待 M2 PRD 填充）
- **业务消息类型** —— 工作目录列表、session 列表（list）、新建（`new_session`）、切换（`switch_session`）、`prompt`、流式 delta、`abort`、历史回看（`get_messages`）、扩展 UI 中转（`extension_ui_request` / `extension_ui_response`）等。（待 M1 / M2 PRD 填充）
- **错误码** —— 一致的错误枚举、错误传递方向（bridge 上行 vs worker 下行）、各端如何向上汇报。（待 M2 PRD 填充）
- **版本化策略** —— envelope `v` 字段、向下兼容与废弃流程、客户端 / 服务端协商。（待 M1 PRD 填充）

## 相关

- 拓扑：[[architecture/decisions/0001-three-component-topology-with-cf-do.md|ADR-0001]]
- pi RPC 协议要点（不同层）：[[roadmap.md#4-pi-rpc-协议要点|roadmap §4]]
- 路线图：[[roadmap.md]]
