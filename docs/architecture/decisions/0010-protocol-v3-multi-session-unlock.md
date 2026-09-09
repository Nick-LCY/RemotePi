# 0010. 协议 v3 多会话解锁：control 9 → 13 type + envelope (a) 多字段 + envelope `session` 字段启用规则 + pending 键控 + SPAWN_TIMEOUT_MS

- 日期：2026-09-08
- 状态：已接受
- 背景：
  协议 v1（envelope / control / pi）锁版承诺"v1 存续期内 control 家族不再新增 type"——M3 因新增 `get_state` 已破锁一次（[[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]]）；M4 PRD [[prds/m4-multi-session.md]] §1 / §5 / §7 / §8 要求在此基础上再次破锁（9 → 13），同时落 envelope (a) 多个可选字段扩展、envelope `session` 字段多会话启用规则、sessionKey 计算、pending 键控决策（钉子 2）、SPAWN_TIMEOUT_MS 决策（钉子 4）。

  本 ADR 沿用 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] 的破锁范式（v1 无第三方消费者 + 三端锁步部署），并补充 M4 多会话特有的若干决策。

- 决策：
  1. **control 9 → 13 type 破锁**：control 家族新增 4 个 type——`list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`；详见 M4 PRD §1.1。破锁依据与 ADR-0006 同：v1 无第三方消费者（仅三端锁步部署）；4 个新 type 均是 web → bridge 的查询/命令（与 `get_state` / `session_list` 同形态，回执走 `result`），不引入新转发/语义负担；envelope 演进规则 (b) 同步修订为"control 家族 v1 内除已破锁的 `get_state` + 4 个 M4 type 外不再新增 type"。
  2. **envelope (a) 字段扩展清单**（全部为可选字段，不破锁）：
     - `session_list.payload.work_dir?: string`——按 work_dir 过滤会话清单；M4 操作惯例必带（裁定 A：强制两级选择后 web UI 必传，schema 仍 optional 不破锁；缺省全量扫描仅作 M3 兼容语义保留）。
     - `session_state.payload.work_dir?: string`——每条广播携带对应 work_dir，便于 web 在 `ChoicePage` 列表直接渲染。
     - `pi/prompt.payload.work_dir?: string`——**仅 `session:'new'` 的 prompt 携带**（裁定 A 方案 A：新会话的第一条消息是唯一入口），其他 session 状态下的 prompt 不带、bridge 忽略；schema 仅标注 optional（不强制与 `session` 关联），web 端发命令时遵守。
     - `result.data.work_dirs?: string[]`——`work_dir_list` 回执字段。
     - `result.data.entries?: { name: string, path: string }[]`——`list_directories` 回执字段。
     - `session_list` 回执 `data.sessions[]` 新增 `status` 字段（5 枚举 `'exited' | 'idle' | 'running' | 'spawning' | 'unknown'` + `unknown` 语义）；既有字段与 `running` boolean 语义保留。
  3. **envelope `session` 字段启用规则（多会话下操作惯例必填，schema 仍 optional 不破锁）**：schema 维持 optional（v1 锁版承诺"session / reply_to 为新增可选字段时不受此限"）；多会话下的操作惯例：
     - web → bridge：所有 pi 家族命令 + `get_state` / `session_list` 必须带 `session` 字段（缺省视为"作用于 bridge 默认 session"——M3 兼容路径，但 M4 ChoicePage 强制带）。
     - bridge → web：所有 `session_state` / `command_result` / `snapshot` / `event` 必须带 `session` 字段（M3 兼容路径下可省略，但 M4 推荐始终带，便于 web 按 session 过滤）。
     - 该惯例不破锁，schema 维持 optional；违反时不强制 wire 错（peer 仍可忽略缺字段帧），仅靠实施期对端协商补全。
  4. **每会话独立 pi 进程推论（不引入 `new_session` / `switch_session` / `list_directories` pi 命令）**：M3 的 `PiProcessManager` 5 相位状态机逐会话实例化（每 manager 独立 idle 计时 + 崩溃隔离）。推论："新会话" = bridge spawn 新 manager（不带 `--session`，让 pi 自己开新 jsonl 文件），触发点是 web 在 `ChoicePage` 点"新建会话" → web 发 `pi/prompt`（`session: 'new'` + `payload.work_dir`）→ bridge 收到后按 pending 键控（见 §5）路由；首次 prompt 写入触发 spawn；"切会话" = web 改 URL hash，bridge 不感知；web 后续命令携带新 `session` 字段，bridge 路由到对应 manager。这两条语义都被 web URL hash + bridge router 完整表达，无需在 pi RPC 协议里新增 type；新增 `new_session` / `switch_session` 会让协议多两个 bridge → pi 的翻译命令（bridge 不知道 pi 何时创建 session 文件，需要先 round-trip 查 session 文件名再喂 `--session`，徒增复杂度），故不引入。
  5. **sessionKey 计算规则 + pending 键控（钉子 2）**：`sessionKey` = pi session 文件名 stem（如 `2026-09-08T10-30-00_a3f9b2c1-4d5e-...`）；复用 M3 `encodeCwdForPi(cwd)` + `sessionSubdir(agentDir, cwd)` + `findLatestSession(subdir)`。**pending 键控决策**：bridge 侧 `session:'new'` 按 work_dir 键控（内部键 `'new:' + work_dir`），同一目录同时至多一个未落盘新会话；同 work_dir 短时多次 new 请求合并为同一个 pending；stem 派生后 map 键迁移为真实 stem（`managers.delete('new:' + work_dir); managers.set(stem, manager)`）并广播 `session_state{session: <stem>}`（web 收到后回填 hash `&session=<stem>`）。`session:'new'` 但 payload 缺 `work_dir` → 拒，回 `result.ok = false` + `error.code: 'invalid_envelope'`。

   **stem 派生点（实测修订）**——[[tasks/m4/06-bridge-session-layer.md|任务 06]] 实施期真 pi 探针实测（`tests/integration/probes/PROBE-SESSIONKEY-RESULT.md`，pin pi 版本 **0.85.1**，复跑命令 `pnpm tsx tests/integration/probes/sessionkey-probe.ts`）：原 PRD §1.5 候选信号"首个 `entry_appended` 或 ready 后第一次 `message_start`"**不适用**——pi 0.85.1 无 `entry_appended` 事件（探针 `firstEntryAppended` 始终 `null`，pi 走裸 `message_update` / `message_end` 流而非 entry 序列化）。**实测派生点**：**首个非 handshake stdout 事件**（即 `agent_start`）+ **agent_dir 扫描**双保险策略。`agent_start` 帧内携带 `sessionFile` 字段（绝对路径）可作为 fast-path 消费；当前 bridge 实现走 agent_dir 扫描 fallback（更通用，应对未来 pi 版本不再携带该字段）。**两种 spawn 模式下 jsonl 出现时机不同**——withFlag（带 `--session`）spawnedAt 53ms 预创建；withoutFlag（无 `--session`）spawnedAt 2ms → agentStartAt 8005ms → sessionFileFirstSeen 8057ms；桥端必须能处理两种时序。详见 [[architecture/protocol/pi.md#多会话扩展正式落地|pi.md §多会话扩展正式落地]] §pending 键控实测验证点段 + [[tasks/m4/06-bridge-session-layer.md|任务 06]] 完成情况探针实测结论。
  6. **SPAWN_TIMEOUT_MS = 60_000（钉子 4）**：spawning 相位超 60s 未完成握手（未收到 pi 的 `agent_start` / 首次 stdout entry）→ 复用 `PiProcessManager` 既有自主 kill 标记路径（先置位再发 SIGTERM→1s→SIGKILL；exit 回调走"标记在→不重启"路径，M3 tasks/m3/04 已落地）→ exited 广播；同时 `BridgeSessionLayer` 同步 `managers.delete(<map键>)`（含 pending `'new:<work_dir>'` 键同步 delete）。避免冷启动失败时 manager 永久停留在 spawning 相位。60s 在慢机器 / 冷启动机器（IO 慢 / 首启）下可能不够——任务 06 实施期实测真 pi 冷启动时长覆盖 P95 后再定，必要时调整上限；超时后通过自主 kill 标记路径保证不悬挂（不依赖外部 GC）。
  7. **worker 零业务改动 + DO 路由 `routeOpenMessage` default 兜底补漏**：M3 教训（commit `1c86aca`）——协议破锁增 type 时必须同步补 worker `routeOpenMessage` switch 的 default 转发分支，否则新 type 会被 worker 静默丢弃。本决策落地时严格走 default 兜底——`routeOpenMessage` 的 `default` 分支对所有 13 control type + 9 pi type 的转发已是同一代码路径（`forwardToOpposite`），新 4 type 自动落入 default 转发；worker 零业务代码改动，仅同步模块头注释 + `routeOpenMessage` switch 注释。
  8. **错误码集合不扩展**：复用 control.md §8 已锁版的 6 个 code 集合（`auth_failed` / `duplicate_bridge` / `invalid_envelope` / `unsupported_version` / `unsupported_type` / `internal`）；4 个新 type 失败时复用 `invalid_envelope` / `internal` / `unsupported_type`（按实施期最贴切选）；不新增 code。

- 影响：
  - shared 协议 v3 落地：control 4 新 envelope + payload schema + `session_list.payload.work_dir` / `session_state.payload.work_dir` / `pi/prompt.payload.work_dir` 可选字段 + `session_list` 回执 `status` 字段；envelope `session` 字段维持 optional 不破锁；`CONTROL_TYPES` 字面量同步追加（13 项）。详见 [[architecture/protocol/envelope.md]] / [[architecture/protocol/control.md]] / [[architecture/protocol/pi.md]] 同步修订。
  - shared 测试扩展（任务 03）：4 新 payload schema 合法/缺字段/非法类型拒；envelope (a) 增字段；`session_list.status` 5 枚举 + `unknown`；`CONTROL_TYPES` 长度 13；`pi/prompt.work_dir` 携带语义注释测试。
  - bridge 多 manager 复数化（任务 06）：`BridgeSessionLayer` 持有 `Map<sessionKey, PiProcessManager>` + pending 键控 + SPAWN_TIMEOUT_MS 60s + 跨 manager 广播隔离 + sessionKey 派生真 pi 探针验证。sessionKey 派生时机（实测验证点）：bridge 在 pi spawn 后何时能从 stdout / `--session-dir` 派生 sessionKey？任务 06 实施期跑真 pi 探针（沿用 tasks/m3/10 假 LLM 套件 helper）确认事件时序与 stem 派生点。
  - worker 零业务改动；`routeOpenMessage` switch 注释更新反映 13 control type + 9 pi type 的 default 转发语义。
  - 与 ADR-0003 协同：idle 计时逐会话复制 / session_state 每 manager 各 broadcast / 跨会话 idle 互不干扰；裁定 C：ready 5min 无写命令也按 idle 路径倒计时（仅 spawning / blocked_on 显式忙碌相位豁免）；SPAWN_TIMEOUT_MS 60_000 复用自主 kill 标记路径（钉子 4）；详见 ADR-0003 §补注（M4 多会话化补注，由任务 09 落盘）。
  - 与 ADR-0006 协同：两者均为 control 家族破锁（ADR-0006：8→9 加 `get_state`；本 ADR：9→13 加 4 个 work-dir 相关 type），共同证明 envelope.md 演进规则 (b) 修订为"control 家族 v1 内除已破锁的 `get_state` + 4 个 M4 type 外不再新增 type"。
  - 与 ADR-0007 协同：本 ADR 不引入"会话被外部进程占用"检测；正式关闭 ADR-0007 §验证与后续段对应挂账（PRD 写入非目标）。**ADR-0007 §验证与后续段"会话被外部占用检测"挂账的删除已由 [[tasks/m4/09-docs-sync.md|任务 09 docs-sync]] 同步落盘**（2026-09-08 任务 09 完成情况，含"正式关闭"备注 + ADR-0007 决策 §5 同步修订为"M4 不引入检测"+ §影响段同步 + §双向引用 / §验证与后续段同步；详见 [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] 当前态）。
  - 与 ADR-0009 协同：恢复仪式修复（任务 01）让 E2E retry 容错断言可简化（ADR-0009 §开放点 1 长期路径已落）；M4 增 e2e 场景（任务 10）。

## 双向引用

- [[architecture/protocol/envelope.md#锁版承诺v1-存续期内不可变]] —— 锁版承诺清单（control 9 → 13 type）与演进规则 (a)/(b) 同步修订的承载点。
- [[architecture/protocol/envelope.md#演进规则v1-存续期内允许]] —— envelope (a) 字段扩展清单（`session_list.payload.work_dir` / `session_state.payload.work_dir` / `pi/prompt.payload.work_dir` / `result.data.work_dirs` / `result.data.entries` / `session_list` 回执 `status`）。
- [[architecture/protocol/control.md#6-session_list]] / [[architecture/protocol/control.md#7-result]] / [[architecture/protocol/control.md#65-list_directories]] / [[architecture/protocol/control.md#66-work_dir_list]] / [[architecture/protocol/control.md#67-work_dir_add]] / [[architecture/protocol/control.md#68-work_dir_remove]] —— 4 个新 type 的 wire 细节 + `session_list` payload / 回执 M4 修订。
- [[architecture/protocol/pi.md#多会话扩展正式落地]] —— 多会话扩展节正式落地：每会话独立进程 + envelope `session` 字段启用规则 + sessionKey 计算 + pending 键控 + `pi/prompt.payload.work_dir` 仅 `session:'new'` 携带。
- [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] —— 破锁先例范式（control 8 → 9 type）；本 ADR 沿用其论据（v1 无第三方消费者 + 三端锁步部署）。
- [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] —— 末尾"M4 多会话化补注"补全：idle 计时逐会话复制 / session_state 每 manager 各 broadcast / 跨会话 idle 互不干扰 / 裁定 C（ready 5min 无写命令回收）/ 钉子 4（spawning 60s 超时自主 kill）。
- [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] —— §验证与后续段删除"会话被外部进程占用检测"挂账（正式关闭，由任务 09 落盘）。
- [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] —— §开放点 1 长期路径落实（恢复仪式修复由任务 01 落地，让 E2E retry 容错断言可简化）。
- [[prds/m4-multi-session.md|M4 PRD]] §1 协议演进清单 / §5 shared schema 扩展 / §7 worker default 分支补漏 / §8 文档同步表 ADR-0010 行 / §9.1 测试基线。
- [[tasks/m4/02-shared-protocol-v3.md|任务 02]] —— 本 ADR 的落地任务；本任务完成后 ADR 落盘。
- [[tasks/m4/03-shared-tests.md|任务 03]] —— shared 测试扩展（30+ 条 + CONTROL_TYPES 13 项 + pi/prompt.work_dir 携带语义注释测试）。
- [[tasks/m4/06-bridge-session-layer.md|任务 06]] —— `BridgeSessionLayer` 多 manager 复数化（钉子 2 pending 键控 / 钉子 4 SPAWN_TIMEOUT_MS 60_000 / 裁定 C ready 5min idle / 钉子 3 work_dir_remove 不 kill 活 manager）+ sessionKey 路由 + 跨 manager 广播隔离 + sessionKey 派生真 pi 探针验证。
- [[tasks/m4/09-docs-sync.md|任务 09]] —— ADR-0003 / ADR-0007 补注落地 + 文档同步收尾。
