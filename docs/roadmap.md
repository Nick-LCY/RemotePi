# RemotePi 路线图

> 长期文件。里程碑经过 2026-09-04 用户定稿，从早先 M0–M5 草案改为 **M1–M4 四步走**（基建 → 通路 → 单 session 闭环 → 多 session 管理）；下一步逐个拆为 [[prds/README.md|PRD]]，本文档在拆分期间保持稳定，作为项目愿景与决策的唯一参考。

## 1. 愿景

让用户在浏览器里远程使用跑在自有服务器上的 pi coding agent：在服务器装 bridge（守护进程），在网页输入相同 token 完成配对，选择工作目录和 session，然后在聊天界面与 pi 交互（流式输出、历史回看、发送命令、扩展 UI 对话框）。

RemotePi 不替代 pi 本地体验，而是把"有可访问的服务器、能跑长任务"这个场景做到与本地体验一致——server 端不需要公网 IP，用户不需要 SSH。

## 2. 架构总览

三组件 + Cloudflare Durable Object 中转。bridge 没有公网 IP，主动通过 WSS 外连 worker；Worker 的 Durable Object 按 token 把同一房间的 web 连接和 bridge 连接路由到一起，做纯转发（不持久化任何业务数据），支持多 web 端广播。

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

详细系统总览见 [[architecture/overview.md]]。

## 3. 已确认决策摘要

| 决策 | ADR |
|------|-----|
| 三组件拓扑（bridge / worker / web）+ Cloudflare DO 中转 | [[architecture/decisions/0001-three-component-topology-with-cf-do.md\|0001]] |
| pnpm monorepo：bridge / shared / web / worker / GitHub Actions / CF Pages | [[architecture/decisions/0002-monorepo-and-tech-stack.md\|0002]] |
| DO 不持久化业务数据；历史来自 bridge 本地；session 生命周期由 agent_settled + 5 min idle 调度 | [[architecture/decisions/0003-session-lifecycle-and-history-source.md\|0003]] |
| pi 阻塞式 extension UI 请求中转到 web 弹窗 | [[architecture/decisions/0004-extension-ui-dialog-forwarding.md\|0004]] |

## 4. pi RPC 协议要点（scout 已核实，版本 pi v0.84.4）

> 本节是后续 PRD 拆分的协议真相源。**陷阱类事实已用 ⚠ 标注**，实现时必须遵守。

### 4.1 启动与握手

- **启动命令**：
  ```
  PI_CODING_AGENT_DIR=<bridge专属目录> pi --mode rpc [--session-dir <dir>] [--session <path>]
  ```
- ⚠ **`PI_CODING_AGENT_DIR` 必须隔离**：bridge 用专属目录，避免污染用户本地 `~/.pi/agent`（认证、设置会被读取）。
- **启动握手**：启动后 stdout 会先到达一组扩展 `setStatus` 事件，但**就绪信号以 `get_state` 命令成功响应为准**——拿到 `get_state` 响应后再开始发业务命令。

### 4.2 线路协议

- ⚠ **自定义 JSONL，不是 JSON-RPC**。stdin 写命令/响应，stdout 收响应/事件，每行一条 JSON，`\n` 分行。
- ⚠ **不要用 Node `readline`**：它会按 U+2028 / U+2029（JSON 合法字符）拆行，破坏 JSON 解析。用 `StringDecoder` + `indexOf('\n')` 自管缓冲。
- **stdin（bridge → pi）**：命令，`prompt` / `steer` / `follow_up` / `abort` / `new_session` / `switch_session` / `get_state` / `get_messages` / `get_entries(since?)` / `get_session_stats` / `set_model` / `compact` 等；对话框回应 `extension_ui_response`。
- **stdout（pi → bridge）**：与命令配对的 `response`（`{type:"response", command, success, data?|error}`）；事件流 `agent_start` / `agent_end` / `agent_settled` / `turn_start` / `turn_end` / `message_start` / `message_update` / `message_end` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end` / `queue_update` / `entry_appended` 等；以及阻塞式 `extension_ui_request`（方法：`select` / `confirm` / `input` / `editor` / `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`）。

### 4.3 任务完成信号

- ⚠ **用 `agent_settled`，不要用 `agent_end`**：`agent_end` 在 auto-retry 场景下会反复出现，不可靠；`agent_settled` 是"agent 完成一次轮次"的稳定信号，用于触发 idle 计时（详见 [[architecture/decisions/0003-session-lifecycle-and-history-source.md]]）。

### 4.4 流式输出

- `message_update.assistantMessageEvent` 携带 `text_delta` / `thinking_delta` / `toolcall_delta`，按 `contentIndex` 累积。
- ⚠ **不要靠 `message_update` 累计消息本体**——流式是增量的，**完整快照以 `message_end.message` 为准**。web 端 UI 渲染必须以 `message_end` 收敛。
- `message_update` 顶层会带 `usage`（token 统计），与 `message_end` 不同步。

### 4.5 扩展 UI 阻塞对话框

- ⚠ `extension_ui_request` **阻塞 pi 子进程**直到收到 `extension_ui_response`。如果桥接层不处理，session 永久卡住。
- 类型：`select` / `confirm` / `input` / `editor`，具体 schema 见 pi 包内 `rpc-types.d.ts`。
- 必须经 worker 中转到 web 弹窗，用户提交后回传——见 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md]]。

### 4.6 Session 存储

- 路径格式：`~/.pi/agent/sessions/--<cwd 编码>--/<时间戳>_<uuid>.jsonl`，**一文件一 session**。
- 列出会话：bridge 直接 `import { SessionManager } from "@earendil-works/pi-coding-agent"`（pi v0.84.4 的 npm 包名）；`SessionManager.list(cwd)` 位于包内 `dist/core/session-manager.js`，返回 `SessionInfo[]`（含 `path` / `id` / `cwd` / `name` / `created` / `modified` / `messageCount` / `firstMessage`）。
- 读取消息：通过 RPC 命令 `get_messages`（按 session id）或 `get_entries(since?)`（增量）。

### 4.7 崩溃恢复

- ⚠ pi **没有心跳**——靠子进程 `exit` 事件感知崩溃。
- 官方优雅关闭（参考 `rpc-client.js`）：先 `SIGTERM`，1 秒后未退则 `SIGKILL`。
- ⚠ **stdin EOF 也是合法关闭路径**（pi 退码 0）；但若想确保业务命令都送达，应在主动关闭前用 `abort` 命令。

### 4.8 认证

- 优先级：`auth.json` > 环境变量 > `--api-key`。
- bridge 通过 `PI_CODING_AGENT_DIR` 隔离目录，**在该目录内放 `auth.json`** 即可，不污染用户本地配置。

## 5. 里程碑

**2026-09-04 由用户定稿，替代早先 M0–M5 草案。** 四步顺序体现"基建 → 通路 → 单 session 闭环 → 多 session 管理"的递进；每步一句话目标 + 验收方向。**待拆分为 [[prds/README.md|PRD]]**，拆分时可调整顺序与粒度，但保持 M1–M4 的四步框架。

| ID | 标题 | 一句话目标 | 验收方向 |
|----|------|----------|---------|
| M1 | 基础设施基座 | monorepo 脚手架（pnpm workspaces：`packages/bridge`、`packages/web`、`packages/shared`、`worker/`、`infra/`）+ shared 隧道信封类型雏形 + Terraform 管理 CF（域名 / Pages / Worker 路由）+ GitHub Actions CI 骨架 | `pnpm -r build` 通过；`terraform plan/apply` 可管理 CF 资源；CI 跑 lint/test；`wrangler dev` 本地可起 worker — ✅ 代码侧完成（2026-09-05，CI 双绿；apply 待用户凭据） |
| M2 | 通路（web ↔ worker ↔ bridge） | 双向 WSS 打通：Pages 上的 web 经 worker 与 bridge 互连；token 配对路由到同一 DO 实例；web 显示 bridge 在线状态；ping / echo 级双向消息互通；多客户端广播；心跳与断连清理 | web 输入 token 后看到 bridge 在线（配对成功）；两端可互发 ping/echo；两个浏览器标签同时收到广播；杀掉 bridge 进程后 web 状态变离线 |
| M3 | 单 session 信息往来 | bridge 对固定工作目录自动恢复 / 新建最新 session（不做选择 UI）；prompt → 流式 delta → agent_settled 全链路；abort；历史回看（`get_messages`）；`agent_settled` 后 5 分钟 idle kill；崩溃恢复；扩展 UI 阻塞对话框转发为 web 弹窗 | 浏览器完成"发消息 → 流式输出 → 任务完成"闭环；F5 刷新后状态恢复；abort 生效；空闲 5 分钟 pi 进程被 kill；select / confirm / input / editor 弹窗可交互且 agent 行为符合预期 |
| M4 | 工作目录与 session 切换 | 工作目录列表、session 列表 / 新建 / 恢复 / 切换（`new_session` / `switch_session`）及对应 UI | 可列出目录与 session；新建、切换、恢复全链路可用 |

**补充说明：**

- M3 的"固定工作目录 + 最新 session"是桥接测试手段，选择能力在 M4 补齐。
- 扩展 UI 对话框转发（[[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]]）并入 M3，不单列里程碑。

## 6. 待决问题（PRD 阶段逐个敲定）

> 这些问题不阻塞所在里程碑的启动，但对应里程碑出 PR 前必须有结论或显式 defer。

| 待决问题 | 归属 |
|----------|------|
| bridge 分发与安装方式（npm 全局包 / `curl \| sh` 安装脚本 / GitHub Release 二进制 + systemd unit 提供方式） | M2 |
| Cloudflare 套餐与 DO 配额确认（多端广播、并发连接数、消息频次上限；必要时讨论分片策略） | M2 |
| token 安全细节（token 如何哈希映射到 DO id；web 端存储：localStorage / cookie / 内存；wss 鉴权握手时序；颁发/吊销流程） | M2 |
| monorepo 细节（`worker/` 与 `packages/` 目录关系；`packages/shared` 版本引用方式：workspace `*` 还是固定版本号） | M1 |
| pi 版本锁定策略（bridge 对 pi 哪个版本起兼容承诺；升级 / 降级策略；CI 矩阵） | M1（依赖锁定）/ M3（兼容性承诺，以 M3 为主） |
| 断线重连的增量流恢复（最小方案：重连后 `get_messages` 拉全量快照，进行中 delta 丢失可接受；进阶方案：bridge 侧环形缓冲补发） | M3 |
| 多 web 端并发操作语义（并发 prompt / abort；extension UI 多端同时弹窗；候选语义："最先到达的为准、其余 follow_up 排队"） | M3 |

## 7. 相关

- 系统总览：[[architecture/overview.md]]
- 术语表：[[glossary.md]]
- ADR 清单：[[architecture/decisions/README.md]]
- 协议规范：[[architecture/protocol/README.md]]
- PRD 占位：[[prds/README.md]]
- 任务占位：[[tasks/README.md]]
- 当前状态：[[current-state.md]]