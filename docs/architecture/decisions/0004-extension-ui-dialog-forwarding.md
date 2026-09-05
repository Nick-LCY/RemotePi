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
  - 相关条目：[[architecture/overview.md]]、[[architecture/decisions/0003-session-lifecycle-and-history-source.md]]、[[architecture/decisions/0001-three-component-topology-with-cf-do.md]]、[[architecture/decisions/0006-protocol-v1-get-state-unlock.md]]。

## 补注（M3 落地后回写，2026-09-05）

落地 [[prds/m3-single-session.md#§4 web 聊天 + 弹窗 + 恢复仪式|M3 PRD §4]] + [[tasks/m3/05-bridge-popup-core.md|tasks/05]] + [[tasks/m3/06-web-chat.md|tasks/06]] 后回写以下 4 段关键实现期裁定（任务 [[tasks/m3/08-docs-and-validation.md|08]] 落地）：

1. **弹窗模型升级为状态帧驱动**。原 §决策 "worker 再回传给 bridge，bridge 喂给 pi 子进程的 stdin 解除阻塞" 的隐含模型是"事件触发弹窗 / 事件触发关闭"，落地为更明确的 **session_state.blocked_on 唯一真相源**：
   - bridge 维护 `pending: Map<requestId, BlockedOnEntry>`（任务 [[tasks/m3/05-bridge-popup-core.md|05]] `ExtensionUIRouter` 独立类），每次写操作 / 相位迁移 / 阻塞变化时**重新组装** `session_state.payload.blocked_on` 并广播给所有 web 连接；
   - web 端 `WebState.blockedOn` 由 `session_state` 帧覆盖，弹窗组件的 `open / submitting / expired` 状态机**只读**该字段；
   - pi 入站 `extension_ui_request` 事件本身仅作"使 blockedOn 入列"的事件触发器，不被 web 端当作渲染直接信号——web 端不直接订阅 `extension_ui_request` 信封，而是等下一个 `session_state` 帧确认；
   - **info-only 性质**：web 端入站 `extension_ui_response` 事件（若 bridge 广播）是信息性的，仅供调试 / 未来多端 UI 协调；当前 web 端 `WsClient` 入站订阅不消费该事件本身（它只会从 `command_result` 收自己的回执）。

2. **无乐观 UI 规则**（H 决策）。本地任何操作（提交弹窗、发 prompt）→ 立刻显示"已提交待确认"暂态 → 等下一个事件 / 状态帧确认 → 才视为生效。具体落地：
   - 弹窗提交后：组件切 `open → submitting`，按当前 `blockedOn` 含该 id 维持显示；`session_state` 帧 `blocked_on` 不再含该 id → 自动收起（即使本地仍处 submitting）；任何中间态都由事件 / 状态帧驱动最终态；
   - prompt 提交后：输入框立刻 disable + 显示"已提交待确认"文案；`agent_settled`（工作量收敛信号）到达 → 输入框可用 + UI 显示"agent 已就绪（5 分钟后自动休眠）"；
   - 提交失败（`command_result{success: false, error.code === 'request_expired'}`）：弹窗组件 → toast + 自动收起；普通命令（prompt / steer / follow_up）→ 输入框临时错误提示（"pi 已不再处理该请求，可能是 idle 超时 kill"），不重发。

3. **并发多端"先答者胜"**。原 §影响 "建议以最先提交的为准并丢弃其余" 的措辞落地为精确语义：
   - 广播驱动：bridge 收到首个 `extension_ui_response{request_id}` 时 → 在 `pending` Map 中 `get` + `delete` 该 id（原子检查，配对操作）→ 通过 stdin 喂给 pi → 后续 `command_result{ok: true}` 广播；
   - 迟到者：bridge 收到同一 `request_id` 的后续 `extension_ui_response` → `pending.get(id) === undefined` → **不喂 pi** → 回执改发 `command_result{success: false, error.code: 'request_expired'}`（H 决策 + §2.4 翻译；web 端按无乐观 UI 规则显示错误 toast 并收起）；
   - 多 web 端同一 id 提交：worker 层广播转发到 bridge，bridge 端只接受首条；web 端弹窗组件按 `request_expired` 处理迟到者；
   - 与 [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] 协同：并发场景下 `agent_settled` 与 `extension_ui_request` 不会同时存在（阻塞期间不收敛工作量），idle 计时不被弹窗误触发（见 [[architecture/decisions/0003-session-lifecycle-and-history-source.md#补注m3-落地后回写|ADR-0003 补注 2]]）。

4. **`extension_ui_response` web wire 形状**。落地 wire（与 [[architecture/protocol/pi.md|pi.md]] §1.6 同步）：
   ```ts
   {
     request_id: string;
     cancelled: boolean;
     value?: string | boolean;   // cancelled=true 不附；cancelled=false 必填
   }
   ```
   - `cancelled: true` → 不附 `value` 字段（refine 拒 `cancelled=true + value 存在`）；
   - `cancelled: false` + `value: <string>` → select / input / editor 三类提交（select 必须是 options 之一，input/editor 是用户输入文本）；
   - `cancelled: false` + `value: <boolean>` → confirm 类提交；`value: true` 表示"确认"、`value: false` 表示"否"（R2 修正——原方案只能表达 true/false 二态，无法区分"取消"与"否"）；
   - bridge 翻译：见 [[tasks/m3/05-bridge-popup-core.md|tasks/05]] "wire 翻译三态"——cancelled:true → `{id, cancelled:true}`（不附 value）/ value:string → `{id, value: <string>}` / value:boolean → `{id, confirmed: <bool>}`（含 `value:false → confirmed:false` 独立用例）。
   - **ConfirmDialog 实际落地三按钮**（与 PRD §4.2 表的两按钮描述差异——见下"实现期挂账 ①"）。

## 实现期挂账（M3 已知偏差，2026-09-05）

① **ConfirmDialog 三按钮模型**（来自任务 [[tasks/m3/06-web-chat.md|06]] 完成情况挂账）。[[prds/m3-single-session.md#§4.2 弹窗组件（4 类）|PRD §4.2]] 表描述 confirm "渲染 title + message"，但落地为**三按钮**：Cancel=cancelled:true / No=value:false / Yes=value:true。"取消"与"否"语义正交——"取消"是"我不想回答这个请求"，"否"是"我回答了否"。此模型与 `extension_ui_response` web wire refine 完全对齐（cancelled 与 value 是正交维度），而 PRD §4.2 表隐含的两按钮（确认 / 取消）模型无法表达 confirm 的"否"路径。**M3 以三按钮模型为准**，[[architecture/protocol/pi.md|pi.md]] / 本 ADR / [[tasks/m3/06-web-chat.md|tasks/06]] 完成情况已同步；PRD §4.2 表的两按钮描述属 PRD 表述漂移，**不在 M3 范围修订 PRD 文本**（仅文档侧把模型写清）。

② **work_dir 降级显示**（来自任务 [[tasks/m3/06-web-chat.md|06]] 完成情况挂账）。[[prds/m3-single-session.md#§4.3 chat 界面|PRD §4.3]] 要求 `PhaseIndicator` 显示 phase + 当前 work_dir，但 v1 wire（[[architecture/protocol/pi.md|pi.md]] / [[architecture/protocol/control.md|control.md]]）**不携带 bridge 配置**——work_dir 不过协议，仅 bridge 本地读取。M3 实际 web 端 `PhaseIndicator` 仅显示 phase，无 work_dir。**修正路径**：在 `session_state.payload.data`（即 `get_state.data`）新增**可选** `work_dir` 字段——属 envelope 演进规则 (a) "新增可选字段"，与 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] 的 `get_state` 协同（`get_state.data` 当前 `{ phase, blocked_on? }` → M4 扩 `{ phase, blocked_on?, work_dir? }`）。**M3 不实现此演进**——M3 锁版控制 `get_state` 9 type 与 envelope (a) 边界，仅在文档侧（[[tasks/m3/08-docs-and-validation.md|tasks/08]] 验收纪要 + 本 ADR）注明偏差为 M4 / M+ 候选。

## 双向引用（M3 协同）

- [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] —— 阻塞期间不发 agent_settled → idle 计时不误触；并发多端先答者胜与桥调度协同。
- [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] —— `get_state` 回执中的 `blocked_on` 字段是本 ADR "弹窗模型状态帧驱动"的真相源之一（与事件流 `pi/event` 双路并行）。
- [[architecture/protocol/pi.md#§1.6 extension_ui_response web wire|pi.md §1.6]] —— web wire 形状的承载点；`value: string | boolean` refine 与 confirm 走 boolean 的契约。
- [[tasks/m3/05-bridge-popup-core.md|tasks/05]] —— `ExtensionUIRouter` 独立类实现 + wire 翻译三态 + 多 web 端先答者胜。
- [[tasks/m3/06-web-chat.md|tasks/06]] —— web 端 4 类弹窗组件 + DialogHost 状态机 + 无乐观 UI + 三按钮模型落地。