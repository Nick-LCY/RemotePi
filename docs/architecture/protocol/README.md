# RemotePi 隧道协议规范

> 状态：定稿（2026-09-05），协议版本 v1。字段与语义变更须走 [[architecture/protocol/envelope.md]] 的版本化流程。

本目录是 RemotePi 隧道协议（web ↔ 中间层 ↔ bridge 的 WSS 信封）的**唯一真相源**。

## 定位

- 与 [[roadmap.md#4-pi-rpc-协议要点|roadmap §4 pi RPC 协议]] 的关系：那是 pi 自己的线路协议（bridge ↔ pi 子进程的 stdin / stdout JSONL），本目录是 RemotePi 在它外面套的 **JSON 隧道**协议——bridge 在 stdio 上与 pi 直接通信，隧道只承载 RemotePi 自己的信封与业务字段。两层不要混淆，bridge 负责转译。
- 拓扑角色由 [[architecture/decisions/0001-three-component-topology-with-cf-do.md|ADR-0001 三组件拓扑 + Cloudflare DO 中转]] 定义：web ↔ worker(DO) ↔ bridge；同房间所有连接共享隧道流。
- 协议的类型与运行时实现位于 `packages/shared/src/protocol/`。

## 协议总览

- **信封一句话**：所有消息共用 `{v, kind, type, id, session?, reply_to?, payload}` 外壳，详见 [[architecture/protocol/envelope.md]]。
- **两大家族**：

  | kind | 范围 | 本文 |
  |------|------|------|
  | `control` | 连接与会话生命周期（8 个 type） | [[architecture/protocol/control.md]] |
  | `pi` | 对话内容（9 个 type，镜像 pi 命令与事件） | [[architecture/protocol/pi.md]] |

- **中间层处理规则一句话**：只深度处理 `handshake`（鉴权）、`bridge_status` 与 `error`（自己生成），其余一律转发。
- **扩展原则**：将来扩展只往 `pi` 家族加 type；`control` 在 v1 内不再新增 type。

## 文档索引

- [[architecture/protocol/envelope.md]] —— 信封与版本化
- [[architecture/protocol/control.md]] —— 连接与会话生命周期
- [[architecture/protocol/pi.md]] —— 对话内容

## 相关

- 拓扑：[[architecture/decisions/0001-three-component-topology-with-cf-do.md|ADR-0001]]
- pi RPC 协议要点（不同层）：[[roadmap.md#4-pi-rpc-协议要点|roadmap §4]]
- 路线图：[[roadmap.md]]
- 词汇表：[[glossary.md]]