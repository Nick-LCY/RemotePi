# 0001. 三组件拓扑 + Cloudflare Durable Object 中转

- 日期：2026-09-03
- 状态：已接受
- 背景：
  服务器通常没有公网 IP（NAT/CGN、家庭宽带、企业防火墙），因此 web 端无法主动连回 bridge。同时业务要求支持"同一 token 多个 web 客户端同时连接"（手机 + 桌面同时挂一个 session）。需要一个中间层完成 **配对** 与 **转发**，并且能容纳多客户端广播。
- 决策：
  采用三组件 + Cloudflare Durable Object（DO）的中转拓扑：

  | 组件 | 角色 | 部署位置 |
  |------|------|----------|
  | `bridge` | Node.js + TypeScript 守护进程，管理 pi 子进程、转发 web 命令 | 用户自有服务器（无公网 IP），systemd |
  | `worker` | Cloudflare Worker + DO。DO = 按 token 配对的"房间" | Cloudflare 边缘网络 |
  | `web` | React + Vite 纯 SPA，聊天界面 | Cloudflare Pages |

  关键约束：
  1. **bridge 主动外连**：bridge 持有 token，通过 WSS 主动连到 worker（`wss://<host>/bridge`），不依赖入站端口。
  2. **DO 作为有状态房间**：web 端连到 worker（`wss://<host>/web`），按 token 哈希路由到同一 DO 实例；同一房间内的 web 连接与 bridge 连接消息双向转发。
  3. **DO 纯转发，不持久化**：DO 不存储 token、配置、session 数据；其"状态"仅是内存中的连接集合与转发逻辑。
  4. **多客户端广播**：同一房间允许多个 web 连接，worker 把任意 web 端发来的命令转发给该房间的 bridge（去重由 bridge 决定），把 bridge 回传的事件广播给所有 web 连接。

- 影响：
  - bridge 必须能出网（连到 Cloudflare 边缘），NAT/防火墙不影响部署；不需要 DDNS、不需要端口映射。
  - 容量受 Cloudflare DO 配额约束（单 DO 连接数、WebSocket 消息频次、CPU 时间），需要监控并在接近上限时讨论分片策略。
  - web 端无需任何 NAT 穿透或证书管理，全部由 CF 边缘承担。
  - token 一旦泄漏，任何人都能加入该房间并下发命令给 bridge → 见后续 PRD 阶段处理 token 颁发与吊销。
  - 相关条目：[[architecture/overview.md]]、[[architecture/decisions/0002-monorepo-and-tech-stack.md]]、[[architecture/decisions/0003-session-lifecycle-and-history-source.md]]、[[architecture/decisions/0004-extension-ui-dialog-forwarding.md]]。