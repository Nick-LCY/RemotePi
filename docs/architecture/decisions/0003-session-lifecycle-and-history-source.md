# 0003. DO 不持久化；session 生命周期与历史来源

- 日期：2026-09-03
- 状态：已接受
- 背景：
  系统的"事实状态"应该归属在哪一层，是 RemotePi 设计中影响最大的问题之一：
  - 若把历史/会话数据放进 DO，会引发持久化成本、跨区域同步、隐私（用户在自有服务器上的代码片段流入 CF 边缘存储）等问题。
  - 若 session 生命周期与 web 连接状态强绑定，会出现"手机关掉屏幕 session 就被杀掉"的糟糕体验。
  - 多 web 端同时连接同一 bridge 时，消息语义（广播？单播？以哪个为准？）必须明确。
- 决策：
  1. **DO 不持久化任何业务数据**。
      - 配置、token 映射、session 历史、用户偏好一律不进 DO 存储。
      - DO 只持有"内存中的 WebSocket 连接集合"和转发逻辑；DO 实例被驱逐/重启后，下一次连接按 token 哈希路由会自然落到新实例，业务不感知。
  2. **历史记录来源 = bridge 本地 pi session 文件**。
      - pi 的 session 落盘路径形如 `~/.pi/agent/sessions/--<cwd编码>--/<时间戳>_<uuid>.jsonl`。
      - bridge 通过 `SessionManager.list(cwd)`（直接 import pi 包）列出会话；通过 `get_messages` RPC 读取会话内容。
      - web 断线重连后由 bridge 推送 session 状态快照，不依赖任何云端缓冲。
  3. **pi 子进程调度规则**：
      - 收到第一个任务 → spawn pi 子进程（`PI_CODING_AGENT_DIR=<bridge专属目录> pi --mode rpc ...`）。
      - 启动握手：`get_state` 命令成功响应 → 就绪。
      - 任务完成信号：`agent_settled` 事件（**不是** `agent_end`，后者在 auto-retry 时会反复出现，不可作为 idle 判据）。
      - 收到 `agent_settled` 后开始 5 分钟空闲计时；计时窗口内收到新任务则重置；超时 kill（参考 pi 官方 rpc-client.js：SIGTERM → 1s → SIGKILL）。
      - 子进程崩溃（exit ≠ 0） → 重启。
  4. **session 生命周期与 web 连接状态解耦**。
      - web 关闭 / 断网 / 切后台 → 不杀 session；session 在 bridge 侧按上面规则独立运转。
      - 重连后 web 端拉取 session 当前状态（消息历史 + 进行中任务标记）作为恢复视图。
  5. **多 web 客户端广播语义**：
      - bridge → worker 的事件原样转发给该房间内所有 web 连接（广播）。
      - web → worker 的命令转发给 bridge；bridge 负责去重/合并（多端同时输入的语义在 PRD 中敲定，目前倾向于"以最早到达的为准、其余作为 follow_up 排队"）。

- 影响：
  - bridge 是事实源（source of truth），可观测、可备份、可离线运行；DO 故障不丢数据。
  - "在浏览器关闭后仍在跑"的体验与本地 pi 一致；session 资源占用可控（5 min idle kill）。
  - web 端实现复杂度集中在"重连后状态恢复"协议（增量流 vs 全量快照，待决问题）。
  - 多端冲突处理需要在 PRD 阶段做交互原型（乐观 UI？以服务端最后一致为准？）。
  - 相关条目：[[architecture/overview.md]]、[[architecture/decisions/0001-three-component-topology-with-cf-do.md]]、[[architecture/decisions/0002-monorepo-and-tech-stack.md]]、[[architecture/decisions/0004-extension-ui-dialog-forwarding.md]]。