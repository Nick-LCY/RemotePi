# 系统总览

> RemotePi 的稳定层架构总览。很少变更；变更需经过 ADR。

## 概述

RemotePi 让用户在浏览器中远程使用跑在自有服务器上的 pi coding agent（参见 [[glossary.md]]）。用户在服务器装 bridge（守护进程），在网页输入相同 token 完成配对，选择工作目录和 session，然后在聊天界面与 pi 交互——支持流式输出、历史回看、发送命令、扩展 UI 对话框。

## 架构

三组件 + 中转层。bridge 没有公网 IP，主动通过 WSS 外连 Cloudflare Worker；Worker 的 Durable Object 按 token 把同一房间的 web 连接和 bridge 连接路由到一起，做纯转发（不持久化任何业务数据）。

```
┌──────────────┐  WSS   ┌─────────────────────────┐  WSS   ┌──────────────────────────┐
│  浏览器 web   │◄──────►│  Cloudflare 边缘         │◄──────►│  用户服务器 (无公网 IP)    │
│ packages/web │        │  Worker + Durable Object │        │   packages/bridge         │
│ (CF Pages托管)│        │  按 token 配对房间        │        │   systemd 守护进程         │
└──────────────┘        │  纯转发·不持久化·多端广播  │        └────────────┬─────────────┘
                        └─────────────────────────┘                     │ spawn (stdin/stdout JSONL)
                                                                          ▼
                                                              ┌──────────────────────────┐
                                                              │  pi --mode rpc 子进程     │
                                                              │  sessions → 本地磁盘       │
                                                              │  ~/.pi/agent/sessions/…   │
                                                              └──────────────────────────┘
```

## 核心模块

- **`packages/bridge`**（Node.js + TypeScript 守护进程）
  - systemd 单元；通过 WSS 主动连到 worker。
  - 管理 pi 子进程（spawn / 启动握手 / 崩溃重启 / idle kill）。
  - 解析 pi 的 JSONL 线路协议，封装为 RemotePi 隧道信封。
  - 读取本地 pi session 文件，提供历史回看与列表。

- **`packages/web`**（React + Vite 纯 SPA）
  - 部署在 Cloudflare Pages。
  - 提供 token 登录、目录与 session 列表、聊天界面、扩展 UI 弹窗组件。
  - 通过 WSS 与 worker 通信；断线后通过协议拉取 session 状态恢复。

- **`packages/shared`**（协议类型）
  - 隧道信封（envelope）：web ↔ worker ↔ bridge 三段统一的消息包装。
  - pi RPC 类型转译（与 pi `rpc-types.d.ts` 对齐的子集）。
  - 单一协议真相源，三个运行时组件共同依赖。

- **`worker/`**（Cloudflare Worker + Durable Object）
  - Worker 入口：接受 web 与 bridge 的 WSS，按 token 哈希路由到 DO 实例。
  - DO：内存中保存连接集合；web ↔ bridge 双向转发；多 web 端广播。
  - **不持久化任何业务数据**（见 ADR 0003）。

- **`infra/`**（Terraform）
  - Cloudflare 域名、Pages 项目、Worker 路由与 Secrets。

## 关键决策

| ADR | 标题 |
|-----|------|
| [[architecture/decisions/0001-three-component-topology-with-cf-do.md\|0001]] | 三组件拓扑 + Cloudflare Durable Object 中转 |
| [[architecture/decisions/0002-monorepo-and-tech-stack.md\|0002]] | 采用 pnpm workspaces monorepo |
| [[architecture/decisions/0003-session-lifecycle-and-history-source.md\|0003]] | DO 不持久化；session 生命周期与历史来源 |
| [[architecture/decisions/0004-extension-ui-dialog-forwarding.md\|0004]] | 扩展 UI 对话框转发到 web 弹窗 |
| [[architecture/decisions/0005-unified-domain-with-worker-static-assets-and-actions-cd.md\|0005]] | 部署形态：主域统一 + Worker Static Assets + GitHub Actions CD |

完整清单与模板见 [[architecture/decisions/README.md]]。

## 相关

- 隧道协议规范：[[architecture/protocol/README.md]]
- 术语表：[[glossary.md]]