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
  - 相关条目：[[architecture/overview.md]]、[[architecture/decisions/0001-three-component-topology-with-cf-do.md]]、[[architecture/decisions/0002-monorepo-and-tech-stack.md]]、[[architecture/decisions/0004-extension-ui-dialog-forwarding.md]]、[[architecture/decisions/0006-protocol-v1-get-state-unlock.md]]、[[architecture/decisions/0007-host-shared-pi-agent-dir.md]]。

## 补注（M3 落地后回写，2026-09-05）

落地 [[prds/m3-single-session.md|M3 PRD §2]] + [[tasks/m3/04-bridge-pi-process.md|tasks/04]] + [[tasks/m3/07-web-recovery.md|tasks/07]] 后回写以下 4 段关键实现期裁定（任务 [[tasks/m3/08-docs-and-validation.md|08]] 落地）：

1. **恢复措辞与"双查询恢复仪式"对齐**。原 §3 "web 断线重连后由 bridge 推送 session 状态快照"的措辞落地为 web 端**握手后无 ack 即并行**发两条命令：`pi/get_messages`（拉历史，无 `since` 全量）与 `control/get_state`（拉会话态 + blocked_on；后者由 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] 破锁增补）。两条都到才渲染聊天视图（任务 [[tasks/m3/07-web-recovery.md|07]] `RecoveryGate` 状态机），任意一条失败（超时 / `ok:false`）显示"恢复失败，请重试"按钮，不静默丢。F5 刷新走完全相同路径（web 端无 localStorage，刷新 = 重新走 WSS + 仪式）。`get_messages` 在当前 `phase === 'exited'` 时由 bridge 触发带 `--session <path>` 的 spawn（§2.7 exited 语义——见第 4 段），`get_state` 由 bridge 内存作答（**不**触发 spawn）。**双查询超时上限统一 5s**（含 exited 时 spawn 余量：web send → bridge 收 → spawn pi → 加载 → bridge 转发 → web 收 整链路实测 2-3s + 1-2s 余量），常量集中在 `REPLY_TIMEOUT_MS = 5000`（任务 [[tasks/m3/07-web-recovery.md|07]] 单点）。

2. **idle 计时不会被阻塞弹窗误触发**。与 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] 协同：阻塞期间 pi 不会发 `agent_settled`，bridge 仅识别 `agent_settled` 作为 idle 计时启动判据——任何 `extension_ui_request` / blocked_on 状态变化都不迁移 `running → idle`，计时器不启动 / 不刷新。**额外边界**：实现期发现 idle 计时器起跳前需守门 `phase === 'running'`（而非原 §3 "收到 agent_settled 事件"无相位的写法），避免 ready 阶段意外事件误触——见补注第 4 段 ready 阶段忽略 `agent_settled` 的裁定。

3. **自主 kill 标记规则**（原 §3 "子进程崩溃（exit ≠ 0）→ 重启"未区分自主 kill 与崩溃）。落地：bridge 维护 `selfKillFlag: boolean`，触发序列严格 **先置位再发信号**——idle 超时 → `selfKillFlag = true` → `child.kill('SIGTERM')` → `setTimeout(1000, () => if (still alive) child.kill('SIGKILL'))` → exit 回调读标记。exit 回调走三条路径：
   - 标记在（任意 exit code）→ 清标记 → 广播 `session_state{phase: 'exited'}` → **不**重启（自主 kill 路径）；
   - 标记不在 + code !== 0 → 广播 `session_state{phase: 'exited'}` → 立即 spawn 新子进程（崩溃重启；spawn 计数 +1）；
   - 标记不在 + code === 0 → 广播 `session_state{phase: 'exited'}` → **不**自动重启（stdin EOF 等合法关闭路径；用户操作 EOF / pi 自身 graceful close）。

   该规则覆盖原 §3 "子进程崩溃（exit ≠ 0）→ 重启"未表达的"自主 kill 退出码非零应被识别为非崩溃"语义——SIGTERM 默认 exit code 143、SIGKILL 默认 137，两者均非 0，若无标记会被原 §3 误判为崩溃而触发不合语义的重启。

4. **exited 状态 spawn 触发集**（原 §3 / §4 未显式定义）。落地：
   - **写操作触发 spawn**：`pi/prompt` / `pi/steer` / `pi/follow_up` 三类写命令到达 → bridge 触发 `exited → spawning` 迁移（spawn 计数 +1）；
   - **读+历史触发 spawn**：`pi/get_messages` 走 pi RPC 需活进程——bridge 触发 `exited → spawning` + spawn 时加 `--session <latest.jsonl>` 恢复上下文（无候选 → spawn 不带 `--session`），恢复仪式必走此路径；
   - **`control/get_state` 永由内存作答、永不 spawn**——`phase` / `blocked_on` / 当前 `child` 状态全在 bridge 内存中，`result{ok: true, data: {phase, blocked_on?}}` 即时回执；
   - **`pi/abort` 在 exited 为 no-op**——回 `command_result{success: true}` 不 spawn 不改状态（web UI 上按钮可点但状态不变）。

   **广播原则**：`session_state` 广播**仅由写操作触发**（prompt / steer / follow_up / abort / extension_ui_response 处理后）+ 状态迁移（相位变化、blocked_on 变化）；`get_messages` 是读，永不触发广播；`get_state` 是读，永不触发广播。

## 补注（实现期裁定，2026-09-05）

**`ready` 阶段收到 `agent_settled` 被忽略**。任务 [[tasks/m3/04-bridge-pi-process.md|04]] review 捕获：原 §3 "收到 `agent_settled` 后开始 5 分钟空闲计时"未限制相位，但 [[prds/m3-single-session.md#§2.3 pi 子进程状态机|PRD §2.3]] 状态机只定义 `running → idle`（`agent_settled` 是工作量收敛信号，`ready` 阶段尚无工作量，谈不上 idle）。**裁定**：`ready` 阶段收到 `agent_settled` 事件 → 静默忽略（不迁移 `ready → idle`，不起 5min 计时器）；计时器仅在 `running → idle` 迁移时起 `setTimeout(IDLE_TIMEOUT_MS)`。这与 [[prds/m3-single-session.md|PRD §2.3]] 字面一致，也与 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] 的"5 相位枚举不破锁"承诺一致。

## 补注（child error 事件处理策略，2026-09-07）

按用户手测发现 + commit `52557fb` 落地。原 §3 “子进程崩溃（exit ≠ 0）→ 重启”未覆盖 child process `error` 事件路径（例如 spawn 时 `ENOENT`、权限拒绝、`spawn EPERM` 等），未挂 handler 会触发 Node 默认未捕获异常（`uncaughtException`）→ bridge `process.exit(1)`，整个桥接进程意外崩—比“崩溃重启”更严重。落地策略：

- **handler 永远挂**：spawn pi 后无条件 `child.on('error', handler)`（与 exit 并列），handler 三步——(a) **广播** `session_state{phase:'exited'}`（与原 §3 第 1 路径 “标记在”同形状，下同）；(b) **队列丢弃**：清除 outstanding 表中所有该 child 的 bridgeInitiated + web 入站命令记 warn（不发命令结果—web 端连接可能已断）；(c) **永不自动重启**。
- **“永不自动重启”区别于 exit≠0 崩溃重启路径**：child `error` 是持续性错误（缺可执行 / 缺权限 / 路径不存在 / 系统级限制），退避机制下反复重试依然会 `error`—无价值、不限于 1-2 次。退出 `exited` 状态后，下一次 spawn 触发集命令（prompt / steer / follow_up / get_messages）抵达时再唤醒（与 §补注 4 “exited spawn 触发集”一致），get_state 永由内存回答。
- **反向事件序竞态守卫**（review 捕获 W-1）：Node 某些场景 `exit` 与 `error` 可能反向到达（一个错误后子进程退出），若 exit handler 在错误前先走“崩溃重启”路径、之后 error handler 再走本策略，会“误杀”刚重启的新 spawn。裁定：exit / error handler 入口均以 **child 身份比对** 守卫（`handler(event)` 首个参数 = child 与 `this.child === child` 比对），不匹配则视为 “已进入新 child” 静默丢弃—双重保险。
- **测试补盲区**：原任务 04 / 05 测试均为“灌响应”式（mock pi 主动 stdout），无人测“bridge 应主动写 stdin / 挂 error handler”。补 4 测试——handshake 写入断言（spawn 后须有 stdin write get_state）+ cwd 传递（spawn opts 含 `cwd: workDir`）+ child error handler 触发 + 反向事件序守卫（exit→error 与 error→exit 两种顺序都不误杀新 child）。

**双向引用**：本策略与原 §3 三路径互补但语义独立—exit 三路径（标记在 / 标记不在 + code≠0 / 标记不在 + code=0）覆盖“正常退出”面，本补注覆盖“spawn/运行期异常”面，两者均走 `exited` 广播；区别仅在“永不自动重启”vs“崩溃重启”。代码 commit `52557fb`，相关文档最近变更见 [[current-state.md|current-state 2026-09-07 条目]]。

## 补注（去隔离改造，2026-09-05）

按 [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] 用户裁定（commit `1985fbd`）落地：session 扫描基准由历史隔离目录 `<configDir>/pi-agent/` 改为宿主机共享 agent 目录（`resolvePiAgentDir()` 解析：`PI_CODING_AGENT_DIR` 优先 / tilde 展开 / 默认 `~/.pi/agent`，与 pi `getAgentDir()` 一致）。本 ADR §2 第 3 条“session 落盘路径”仍准确；§3 第 1 条中“bridge 专属目录”表述为历史状态，修订为：spawn 不注入 `PI_CODING_AGENT_DIR`、子进程继承宿主环境，使 web 端能接管同一 `work_dir` 最近会话（含终端里正在聊的）。已接受的设计后果（同会话双写 / 非官方布局局限）详见 ADR-0007 与 [[tasks/m3/09-host-shared-agent-dir.md|tasks/09]]。

## 双向引用（M3 协同）

- [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] —— session 扫描基准已由历史隔离目录修订为宿主机 agent 目录；共享池的“取最新”与同会话双写后果见该 ADR。
- [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] —— control 8 → 9 type 破锁，`get_state` 是恢复仪式中两条命令之一。
- [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] —— 阻塞弹窗不触发 `agent_settled` → idle 计时不误触；并发多端“先答者胜”语义。
- [[architecture/protocol/envelope.md#锁版承诺v1-存续期内不可变|envelope.md 锁版承诺]] —— control type 数量与演进规则 (a)/(b) 同步修订的承载点。
- [[tasks/m3/04-bridge-pi-process.md|tasks/04]] —— 5 相位状态机 + 自主 kill 标记 + exited 触发集 + ready 忽略 agent_settled 裁定。
- [[tasks/m3/07-web-recovery.md|tasks/07]] —— 双查询仪式 + 5s 超时常量 + F5 同路径。