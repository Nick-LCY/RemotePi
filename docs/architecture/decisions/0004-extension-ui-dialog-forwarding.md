# 0004. 扩展 UI 对话框转发到 web 弹窗

- 日期：2026-09-03
- 状态：已接受
- 背景：
  pi 在执行任务时可能发出 **阻塞式 extension UI 请求**（`extension_ui_request`），需要用户做选择/输入才能继续，例如：
  - `select` — 从若干选项中选一个
  - `confirm` — 确认/取消
  - `input` — 自由文本输入
  - `editor` — 多行编辑

  这些请求会 **阻塞 pi 子进程**直到收到 `extension_ui_response`。如果 bridge 不处理，session 会永久卡住；如果自动取消/超时失败，则破坏扩展的语义（很多 confirm 是不可逆操作，自动失败会让 agent 走错分支）。
- 决策：
  把 `extension_ui_request` 通过 worker 中转到当前房间内的 web 端，渲染为弹窗组件；用户在 web 端完成选择/输入后回传 `extension_ui_response`，worker 再回传给 bridge，bridge 喂给 pi 子进程的 stdin 解除阻塞。

  链路：`pi → bridge → worker → web（弹窗）→ user → web（提交）→ worker → bridge → pi`。

  备选方案已否决：
  - **自动取消/超时失败**：破坏扩展语义（confirm 失败可能让 agent 删除不该删的东西）。
  - **在 bridge 上做 CLI/TUI 提示**：bridge 是无 UI 守护进程，没有终端；硬塞 stdin TUI 会破坏 systemd 运行假设。
  - **要求所有扩展禁用 UI**：违背 pi 生态，"远程用 pi"就丧失了部分扩展能力。

  等待期间 pi 子进程阻塞（低 CPU/内存占用），session 仍处于"运行中"状态，符合 [[architecture/decisions/0003-session-lifecycle-and-history-source.md]] 的调度规则（空闲计时不会被误触发——计时器识别 `agent_settled`，阻塞 UI 不会发出该事件）。

- 影响：
  - web 端需要实现 4 类弹窗组件（select/confirm/input/editor），并且要适配 pi 扩展传递的 schema（具体字段以 pi `rpc-types.d.ts` 为准）。
  - `packages/shared` 需要把 pi 的 extension UI 类型转译成 web 友好的 schema（避免 web 端直接依赖 pi 包）。
  - 多 web 端同时弹窗时的语义需要敲定：建议"广播给所有客户端，以最先提交的为准并丢弃其余"，避免多端同时操作引发竞态。
  - web 关闭期间收到 extension UI 请求 → 暂存或挂起；恢复策略在 PRD 阶段定。
  - 相关条目：[[architecture/overview.md]]、[[architecture/decisions/0003-session-lifecycle-and-history-source.md]]、[[architecture/decisions/0001-three-component-topology-with-cf-do.md]]。