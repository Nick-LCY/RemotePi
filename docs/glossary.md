# 词汇表

统一人与 AI 沟通时对项目术语的理解。每条一个术语：「词 — 在本项目中的解释」。

## 格式
- **术语** — 在本项目中的含义。

## 组件类

- **bridge** — 跑在用户自有服务器上的 Node.js + TypeScript 守护进程（systemd 管理）。职责：管理 pi 子进程、转发 web 命令、回传 pi 事件流；通过 WSS 主动外连 worker（无需入站端口/公网 IP）。代码位于 `packages/bridge`。
- **worker** — 部署在 Cloudflare 边缘的 Worker + Durable Object，承担 web 与 bridge 之间的隧道/房间路由。代码位于 `worker/`。
- **web** — React + Vite 纯 SPA，运行在用户浏览器中，部署在 Cloudflare Pages。代码位于 `packages/web`。
- **DO（Durable Object）** — Cloudflare Workers 上的有状态原语。RemotePi 把每个 token 哈希成一个 DO 实例，作为"房间"持有 WebSocket 连接集合、做转发。**DO 不持久化任何业务数据**（见 [[architecture/decisions/0003-session-lifecycle-and-history-source.md]]）。
- **pi** — RemotePi 复用的上游 AI coding agent 运行时（[pi-mono](https://github.com/badlogic/pi-mono)），以 `--mode rpc` 子进程方式被 bridge 调用。

## 运行时与协议

- **session** — pi 的一个对话会话，对应磁盘上一个 JSONL 文件（`~/.pi/agent/sessions/--<cwd 编码>--/<时间戳>_<uuid>.jsonl`）。RemotePi 沿用 pi "按工作目录组织 session" 的模型；bridge 通过 `SessionManager.list(cwd)` 列出与读取。
- **token（配对凭证）** — 一串共享密钥，web 端与 bridge 端各持一份相同字符串；worker 按其哈希路由到同一 DO 实例，实现配对。token 的颁发、存储、吊销细节见 [[roadmap.md\|roadmap 待决问题]]。
- **envelope（隧道信封）** — RemotePi 三段链路（web ↔ worker ↔ bridge）统一的消息包装格式，定义在 `packages/shared`。
- **JSONL 线路协议** — pi `--mode rpc` 在 stdin/stdout 上使用的逐行 JSON 协议（不是 JSON-RPC）。**不要用 Node `readline`** 解析——见 [[roadmap.md\|roadmap 协议要点]]。
- **agent_settled** — pi 发出的一次任务轮次稳定结束事件。**用它判定 session 是否进入 idle**（开始 5 min 空闲计时）；不要用 `agent_end`（auto-retry 时会反复出现，不可靠）。见 [[architecture/decisions/0003-session-lifecycle-and-history-source.md]]。
- **extension UI 请求（`extension_ui_request`）** — pi 在执行中发出的需要用户做选择/输入的阻塞事件，类型有 `select` / `confirm` / `input` / `editor`。RemotePi 通过 worker 中转到 web 弹窗，用户提交后回传 `extension_ui_response` 解除阻塞。见 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md]]。
- **message_update / message_end** — pi 流式输出事件对。`message_update` 携带 `text_delta` 等增量（**不要靠它累计消息本体**），`message_end.message` 是该条消息的完整权威快照。

## 部署与运维

- **systemd** — bridge 在服务器上的进程管理器；bridge unit 文件的提供方式见 [[roadmap.md\|roadmap 待决问题]]。
- **WSS** — WebSocket over TLS；bridge 与 web 端到 worker 的传输层。
- **Cloudflare Pages** — web SPA 的托管平台。
- **Terraform（`infra/`）** — Cloudflare 域名、Pages、Worker 路由的 IaC。

## 状态与生命周期

- **idle kill** — 收到 `agent_settled` 后 5 分钟内无新任务，bridge kill pi 子进程；计时窗口内收到新任务则重置。见 [[architecture/decisions/0003-session-lifecycle-and-history-source.md]]。
- **多客户端广播** — 同一 token 允许多个 web 连接同时挂在同一房间；worker 把 bridge 回传的事件广播给所有 web 连接，把任意 web 端的命令转发给 bridge（去重/合并由 bridge 负责）。

## 相关
- 路线图与里程碑：[[roadmap.md]]
- 系统总览：[[architecture/overview.md]]
- ADR 清单：[[architecture/decisions/README.md]]