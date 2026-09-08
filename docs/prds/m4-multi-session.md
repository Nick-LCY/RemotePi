# M4 工作目录与会话管理（多会话并行 + 目录浏览 + 入口选择页）

> 状态：**定稿**（2026-09-08，用户裁定定稿并拆任务）。协议基线：[[architecture/protocol/README.md|隧道协议 v1]]（2026-09-05 定稿）。本 PRD 在 envelope 演进规则 (a) 范围内为 `session_list` payload 新增可选 `work_dir` 过滤参数、为 `session_state` payload 新增可选 `work_dir` 字段、为 `pi/prompt` payload 新增可选 `work_dir` 字段（**仅 `session:'new'` 携带**——裁定 A 方案 A，新会话第一条消息是唯一入口），并按"协议演进小节"在 control 家族新增 4 个 type（`list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`，破锁修订依据沿用 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] 先例——v1 无第三方消费者 + 三端锁步部署）。pi 家族**仅 envelope (a) 增字段、零新增 type**（每会话独立 pi 进程推论，见 §1.4）。
>
> **修订注记（2026-09-08，业务共识来源）**：2026-09-08 用户裁定 M4 八条业务共识，本 PRD 一字不偏离——
> 1. **并行多会话**（核心形态）：bridge 同时承载多个活跃对话；网页离开某会话 ≠ 关闭会话；idle 5min 回收按会话各自计时（M3 语义逐会话复制，回收后下次进入 / 发消息自动唤醒）。
> 2. **工作目录**：自由浏览（起点 home，不设范围限制）；形态为混合体——浏览是"添加"手段，添加后进入保存的清单，日常选择走清单；bridge 需新增自身持久化记录保存的目录清单（会话清单可从 pi 会话目录扫描获得，目录清单没人替我们记）。
> 3. **会话占用完全不检测**：无检测、无提示、无特殊处理（对齐 pi TUI 行为）。**此项正式关闭 [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] 留下的"M4 候选：检测共享模式下 session 是否被外部进程占用"挂账**——本 PRD 写入非目标，ADR-0007 §验证与后续段对应删除或标注"M4 不实施"。
> 4. **入口手动选择**：进网页先见"目录 → 会话"两级选择页，显式进入会话。
> 5. **多端各看各的**：每端自选自看的会话；多端看同一会话时同步（M3 广播语义保留）。
> 6. **URL传值**：URL hash 携带 token + session id；F5 恢复到正在看的会话（选择页只在首次进入 / 主动退出时出现）。
> 7. **后台会话存在感 = 列表状态可见**（跑着 / 空闲 / 等输入的简化状态），不做推送 / 角标通知。弹窗归属会话，只处理正在看的会话的弹窗，后台会话的弹窗等用户切过去再答（blocked_on 按会话隔离）。
> 8. **非目标**：多用户 / 账号体系；会话管理操作（重命名 / 删除 / 搜索 / 归档）；移动端专门优化。
>
> **修订注记（2026-09-08，技术裁定 1：每会话独立 pi 进程）**：M3 的 `PiProcessManager` 5 相位状态机逐会话实例化；崩溃隔离、idle 各自独立。**推论**：pi 原生 RPC 的 `new_session` / `switch_session` 命令**不需要**——切会话 = web 换视图（bridge 把命令路由到不同 manager），新会话 = bridge spawn 新进程不带 `--session`（让 pi 自己开新文件）。本 PRD 不引入这两条 pi 命令，避免无谓的协议 / 翻译层改动；该推论在 §1.4 详细论证。
>
> **修订注记（2026-09-08，技术裁定 2：恢复仪式 5s 超时修复纳入 M4，作为 web 链前置任务）**：方案已定（B+C 合体，web 单端改动，bridge / worker 零改动）——
> - **C（核心）**：snapshot 腿从"绝对 5s"改"无进度超时"——仪式内注册 `session_state` 监听（必须走现有 `ceremony.unsubs` 清理数组，防 StrictMode / retry 泄漏），看到真实相位迁移（`spawning` / `ready`）→ 重置 snapshot 定时器为 15s 窗口；无进度维持 5s 判失败；严格只认相位字段实际变化（`blocked_on`-only 广播不重置；`setSessionPhase` 浅相等守护天然挡重复帧）。
> - **B（辅助）**：`bridgeStatus.online === false`（**`null` 不算离线**，避免冷启动误杀；worker 握手后同步补发 `bridge_status`，`useBridgeStatus` hook 现成）→ 离线秒失败，错误文案区分"bridge 离线"与 `snapshot_failed`；顺带把"仪式进行中 WS 断线重连几乎必然失败"的暗坑变成确定性快速失败。
> - **UI**：`RecoveryInFlight` 接 `phase` 显示"正在启动会话… / 加载历史…"替代死文案"5 秒超时"。
> - **涉及点**（scout 已核实）：`packages/web/src/ws/recovery.ts`（`RECOVERY_TIMEOUT_MS = 5000` 定义于 :48，per-reply 双独立 timer，`checkComplete` 三态 error）、`App.tsx` RecoveryView（:200-211 auto-start effect 只读 connState）/ RecoveryInFlight（:232-247）、bridge `pi-process.ts` spawnNow :820 同步广播 spawning、`completeHandshake` :1275 广播 ready——**信号已在广播，web 没听**。
>
> **修订注记（2026-09-08，技术裁定 3：协议演进清单）**：见 §1 完整版——control 家族新增 4 type（`list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`），envelope (a) 增字段（`session_list.payload.work_dir` 过滤 / `session_state.payload.work_dir` 显示 / `pi/prompt.payload.work_dir` 仅 `session:'new'` 携带 / `result.data.work_dirs[]` 形状）；pi 家族仅 envelope (a) 增字段、零新增 type；envelope `session` 字段在多会话下"由 web / bridge 双方按惯例必填"，schema 仍 optional（wire兼容，零 schema 改动）。
>
> **修订注记（2026-09-08，文档漂移更正，纳入本 PRD）**：6 处文档写 `REPLY_TIMEOUT_MS`，源码实为 `RECOVERY_TIMEOUT_MS`——`docs/current-state.md` / `docs/tasks/m3/07-web-recovery.md` / `docs/tasks/m3/12-e2e-harness.md` / `docs/tasks/m3/13-e2e-scenarios.md` / `docs/architecture/decisions/0009-headless-browser-e2e.md` 等；随本任务统一更正为 `RECOVERY_TIMEOUT_MS`。
>
> **修订注记（2026-09-08，任务 06 实施修订，不改定稿正文）**：
> - **§1.5 实测修订**：pi 0.85.1 **无 `entry_appended` 事件**——探针实测（`tests/integration/probes/PROBE-SESSIONKEY-RESULT.md`，pin pi 版本 0.85.1 + 复跑命令 `pnpm tsx tests/integration/probes/sessionkey-probe.ts`）确认 `entry_appended` 字段始终为 `null`（pi 走裸 `message_update`/`message_end` 流而非 entry 序列化）。**stem 派生点改写**——原 PRD §1.5 候选信号「首个 `entry_appended` 或 ready 后第一次 `message_start`」不适用；实施期实测后实测结论为「**首个非 handshake stdout 事件**（即 `agent_start`）+ **agent_dir 扫描**」双保险策略。`sessionFile` 字段在 `agent_start` 帧内携带（绝对路径）——可作为 fast-path 直接消费；当前 bridge 实现走 agent_dir 扫描 fallback（更通用，应对未来 pi 版本不再携带该字段）。**两种 spawn 模式下 jsonl 出现时机不同**——withFlag（带 `--session`）jsonl 在 spawn 时已存在（spawnedAt 53ms 即预创建）；withoutFlag（无 `--session`）jsonl 在 `agent_start` 后 ~52ms 落盘；桥端必须能处理两种时序。「`pi/prompt.payload.work_dir` 仅 `session:'new'` 携带」裁定 A 方案 A 的 PRD 假设沿用，web 端契约不变。详见 [[tasks/m4/06-bridge-session-layer.md#完成情况|tasks/06 完成情况]]「探针实测结论」段。
> - **§2.7 路由表隐含第 6 分支补充**：「无 session + map 为空 + `defaultWorkDir` 已配置」→ auto-spawn 一个 `M3_LEGACY_KEY` 键 manager（M3 token-only URL `#<token>` 兼容路径；任务 06 commit `a19acc6` 修复 e2e 回归时引入）。**已知限制**：当 explicit session manager 与 M3-legacy manager 共存时，session-less 命令按插入序路由到任一 manager（order-dependent），M4 不修。**退役条件**：`BridgeSessionLayer.M3_LEGACY_KEY` / `resolveM3CompatManager` / `defaultWorkDir` 三处代码已加过渡性设计 JSDoc 互引——任务 [[tasks/m4/08-web-multi-session-store.md|08]] 落地后评估 M3-compat auto-spawn 是否退役（详见 [[tasks/m4/08-web-multi-session-store.md#任务-06-c2-移交义务最小侵入|08 任务 06 C2 移交义务]]）；web M4 流程的所有 pi 命令与 `get_state` 必须携带 session 字段（M3_LEGACY 兼容路径仅为 M3 token-only URL 存在；`m3-legacy` 键 manager 的 session_state 广播会带 `session:'m3-legacy'`，web 按 session 分桶时该桶无消费者——M4 正常流程不得依赖 session-less 命令）。
>
> **修订注记（2026-09-08，定稿前修订：用户裁定 A/B/C + 钉子收敛）**：
> - **裁定 A（产品形态变更）**：不再提供"所有 session 的列表"——用户必须先选 work_dir，才能看该目录下的会话列表。两级选择页语义强化为强制顺序：level1（选目录）→ level2（该目录的会话）。`session_list` 在 M4 操作惯例下**必带 work_dir**（schema 仍 optional 不破锁，缺省全量仅作 M3 兼容语义保留）；bridge 的 `listAllSessions()` 全量扫描相应弱化为按目录扫描。
> - **裁定 B**：URL hash 三字段全存：token、work_dir、session。兼容 M3：token 保持首位不加键名（`#<token>&work_dir=<...>&session=<...>`），老分享链接 `#<token>` 不失效。
> - **裁定 C**：idle 回收语义扩展到 ready 相位——ready 5min 无工作量（无任何写命令）也回收；ADR-0003 补注（任务 09 范围）。
> - **新会话携带 work_dir（方案 A）**：envelope 演进规则 (a) 给 pi 家族命令增可选 `work_dir` 字段——**仅 `session:'new'` 的 `prompt` 命令携带**（新会话的第一条消息是唯一入口），其他命令不带、bridge 忽略。bridge 收到 `session:'new'` + `work_dir` → 以该目录为 cwd spawn 不带 `--session` 的新 manager。
>
> **实现层钉子**（按以下默认口径落，决策记录对应追加）：
> 1. **hash 格式**：`#<token>&work_dir=<encoded>&session=<key|new>`；token 首位无键名；work_dir URL 编码。
> 2. **pending 新会话键控**：bridge 侧 `session:'new'` 按 work_dir 键控（`new:<work_dir>` 内部键），同一目录同时至多一个未落盘新会话；stem 派生后 map 键迁移为真实 stem 并广播 `session_state{session: <stem>}`，web 回填 hash。
> 3. **work_dir_remove 与活会话**：不做特殊处理——活 manager 不 kill 不打断，跑完 idle 自然回收；目录移除后其 level2 不可达。
> 4. **spawning 悬挂超时**：新增 `SPAWN_TIMEOUT_MS = 60_000`——spawning 相位超 60s 未完成握手 → 自主 kill（复用自主 kill 标记路径）→ exited 广播。ADR-0003 补注一并覆盖（ready idle + spawning 超时）。
> 5. **level2 会话列表刷新时机**：进入 level2 时查询一次 + 从 ChatView 退回 level2 时重查 + 新会话 stem 回填后重查；不做轮询。
> 6. **导航三态收敛（修复原 §4.2 歧义）**：渲染分派严格按 hash 三键——无 token → TokenPrompt；有 token 无 work_dir → level1；有 token+work_dir 无 session → level2；有 token+session（含 new）→ RecoveryView/ChatView。退出会话=清 session 留 work_dir（回 level2）；更换目录=清 work_dir+session（回 level1）。

## 背景

M3 收官（2026-09-08）。单 session 闭环已通：bridge 接 pi 子进程 + web 聊天界面 + 4 类阻塞弹窗 + 状态恢复 + ADR-0009 无头浏览器 E2E 三场景落地。M3 终点状态——浏览器只剩 TokenPrompt → RecoveryView → ChatView 三段式，看不到任何"选择"操作。

M4 是 roadmap §5第四步"工作目录与 session 切换 / 新建 / 恢复 / 切换 UI"的产品化落地，但用户裁定把这一步扩成了更宽的工作目录与会话管理（含自由浏览 / 保存清单 / 选择页 / URL hash 持久化 / 多端各看各的 / 后台会话状态可见）。M4 同时承担两项 M3 留下的挂账：(1) ADR-0009 挂在 current-state.md TODO 的"恢复仪式 5s 超时对 pi 冷启动不足"（用户裁定在 M4 修，方案 B+C 已在修订注记敲定）；(2) ADR-0007 验证与后续段挂的"会话被外部占用检测"（用户裁定关闭）。

本 PRD 与既有 ADR 的关系：
- 承接 [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]]（生命周期 / 5min idle / 历史来源）——逐会话复制语义，**不破锁**。
- 承接 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]]（弹窗转发）——blocked_on 按会话隔离，本会话语义对齐 §决策5 "先答者胜"。
- 承接 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]]（control 8 → 9 type 破锁先例）——本 PRD 增 4 type沿用同一破锁范式（v1 无第三方 + 三端锁步）。
- 承接 [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]]（宿主机共享 pi agent 目录）——本 PRD 不引入"外部占用检测"，正式关闭 ADR-0007 §验证与后续段对应挂账；其它承接不变（共享池扫描 / auth 缺失 warn / PI_CODING_AGENT_DIR 高级覆盖）。
- 承接 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]]（无头浏览器 E2E）——恢复仪式修复让 e2e retry 容错断言可简化（ADR-0009 §开放点 1 短期路径已落，长期路径在 M4 落实）；M4 增 e2e 场景 (d) 目录浏览 + 场景 (e) 多端各看各的 + 场景 (f) 跨会话 blocked_on 隔离。

## 目标

1. **工作目录清单持久化**：bridge 新增 `state.json`（独立于用户手编的 `bridge.json`），记录用户保存的工作目录列表（增 / 删 / 列三动作）；M3 单 `work_dir` 配置自动迁移为清单第一项；启动时严格校验（沿用 M3 §2.1 三件套：存在 + 是目录 + 可读）。
2. **目录浏览（添加手段）**：bridge 新增 `control/list_directories`（按路径列子目录，立即返回）；web 在"添加目录"对话框调此命令浏览文件系统（起点 `home`，逐层下钻）。
3. **会话清单从 pi agent dir 扫描获得**（不存）：按 work_dir 过滤扫描（`session_list.payload.work_dir` 字段，**M4 操作惯例必带**——裁定 A；schema 仍 optional 兼容 M3），沿用 M3 §2.5 `encodeCwdForPi` + `findLatestSession` 路径，按 work_dir 列；返回字段含 bridge 自维护的简化状态字段（`status`: `exited` / `idle` / `running` / `unknown`，不携带 phase细节，避免与 session_state 重复）。
4. **每会话独立 pi 进程**：`PiProcessManager` 从单例到 `Map<sessionKey, manager>`，sessionKey 用 pi session 文件名 stem（`<timestamp>_<uuid>`）；bridge 出站按 session字段路由到对应 manager，入站按 session 字段路由回对应 web端（广播 + 过滤）。
5. **入口选择页（强制两级顺序，裁定 A）**：不再提供"所有 session 的列表"——用户必须先选 work_dir 才能看会话列表。web 进 TokenPrompt → ChoicePage；level1 列工作目录清单（含"浏览添加"入口），用户**必须**先选目录才能进 level2；level2 列该目录下会话清单（含"新建会话"入口）；选定会话后进入 ChatView（per-session 视图）。F5 / hash 携带完整三键（token + work_dir + session）时跳过 ChoicePage 直接进对应 ChatView；点"退出"清 session 留 work_dir 回 level2；点"更换目录"清 work_dir + session 回 level1。导航三态收敛详见 §4.2 与钉子 6。
6. **URL hash 携带 token + work_dir + session 三字段**（裁定 B）：格式 `#<token>&work_dir=<encoded>&session=<key|new>`；token 保持首位无键名；work_dir URL 编码；新会话占位 `&session=new`，bridge spawn 后回填实际 stem；M3 老分享链接 `#<token>` 不失效（视作"无 work_dir 无 session"→ level1）。
7. **多端各看各的 + 同看同步**：bridge 维持 M3 全广播语义；web 端 store 按 session 分桶，UI 只渲染当前 session 的视图；多端同看 = 广播收 + filter 取自己当前 session = 同步（与 M3 等价）。
8. **后台会话存在感 = 列表状态可见**：ChoicePage 会话清单的每行带状态徽章（exited / idle / running，等价于该 session 当前 PiProcessManager 的 phase简化）；不做推送 / 角标 / 桌面通知。**状态同步机制**：bridge 每次 phase迁移都广播 `session_state{session}`，web 在 ChoicePage 也会监听并更新列表行（无需进 ChatView 也在更新）。
9. **后台 blocked_on 隔离**：弹窗组件按 session 隔离——只处理当前 session 的 blocked_on；切到后台 session 时，dialog 暂存于 store 列表但不显示；切回时恢复显示并更新倒计时。
10. **恢复仪式 5s修复**（web 链前置任务01）：B+C 合体方案，详见修订注记技术裁定 2 与 §6；ADR-0009 §开放点 1 长期路径落实，e2e retry 容错断言可简化为纯等 ChatView。
11. **文档漂移更正**：`REPLY_TIMEOUT_MS` → `RECOVERY_TIMEOUT_MS` 共 6 处。
12. **idle 回收扩展到 ready 相位**（裁定 C）：ready 5min 无任何写命令（无 prompt / steer / follow_up 等写操作）也按 idle 回收路径处理（与 running/idle 一致进入 5min 倒计时）；仅 spawning / blocked_on 显式忙碌相位豁免。ADR-0003 §补注一并覆盖（任务 09 范围）。
13. **SPAWN_TIMEOUT_MS 60_000**（钉子 4）：spawning 相位超 60s 未完成握手（未收到 pi 的 `agent_start` / 首次 stdout entry） → 复用 PiProcessManager 既有自主 kill 标记路径（self-kill → exited 广播）；同时清理 map 键（含 pending `new:<work_dir>` 键同步 delete）。避免冷启动失败时 manager 永久停留在 spawning 相位。
14. **pending 新会话键控**（钉子 2）：bridge 侧 `session:'new'` 命令按 work_dir 键控（`new:<work_dir>` 内部键），同一目录同时至多一个未落盘新会话——若已有 pending 则复用（web 侧短时多次点击"新建会话"合并为同一个 pending）；stem 派生（首个 `entry_appended` 或 ready 后第一次 message_start）后 map 键迁移为真实 stem 并广播 `session_state{session: <stem>}`，web 收到后回填 hash `&session=<stem>`。
15. **导航三态收敛 + level2 刷新时机**（钉子 5/6）：渲染分派严格按 hash 三键（详见 §4.2 决策表）；退出会话=清 session 留 work_dir；更换目录=清 work_dir+session。level2 会话列表查询时机=进入 level2 时一次 / 从 ChatView 退回 level2 时重查 / 新会话 stem 回填后重查；不做轮询（避免 web 端无谓重渲染与 ws 带宽）。

## 非目标

- 多用户 / 账号体系（token 是房间密钥，不做用户维度）。
- 会话管理操作：重命名 / 删除 / 搜索 / 归档 / 标签（roadmap §6 待决问题挂账；M4 不做）。
- **"会话被外部进程占用"检测**（正式关闭 [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] §验证与后续段对应挂账——同会话双写由用户行为约定规避，与 pi TUI 对齐）。
- 跨设备 / 跨账号同步（work_dirs 清单存 bridge 本地 state.json，不云同步）。
- 移动端专门优化（响应式 CSS 不变，触控交互不在 M4 范围）。
- 自动 session 命名 / 摘要（保留 pi 默认 `null`，web侧只显示 first_message 摘要）。
- 增量流恢复 / 环形缓冲（roadmap §6 + ADR-0003 §3 仍 defer 到 M+）。
- bridge CLI 参数（`--worker-url`）与环境变量（`REMOTEPI_WORKER_URL`）的恢复（M3 current-state.md TODO 挂账；M4 不重启）。
- worker 改动（M3 已补 default 转发，M4 新增 control type 由 bridge实施期联调 worker DO 路由 `routeOpenMessage` 一并补 default 分支，零业务代码改动）。
- pi 家族新增 type（"每会话独立进程"推论，详见 §1.4；M4 仅 envelope (a) 增可选字段）。

## 方案

### §1 协议演进清单（envelope 演进 + ADR-0006 破锁先例）

#### §1.1 新增 control type（破锁 9 → 13，沿用 ADR-0006 范式）

control 家族新增 4 个 type（共 9 → 13）。理由同 ADR-0006：
1. v1 无第三方消费者，仅三端锁步部署；
2. 4 个 type 均是 web → bridge 的查询 / 命令（与 `get_state` / `session_list` 同形态，回执走 `result`），不引入新转发 /语义负担；
3. 不破锁则 web 端要么永不可见工作目录（只能靠配置写死），要么引入另种 envelope type（如 `pi/work_dir_*`）的双层映射。

| type | 方向 | payload | 回执 |
|------|------|---------|------|
| `list_directories` | web → bridge | `{ path?: string }`（可选，缺省列 `$HOME`） | `result.data = { entries: { name: string, path: string }[] }` |
| `work_dir_list` | web → bridge | `{}` | `result.data = { work_dirs: string[] }` |
| `work_dir_add` | web → bridge | `{ path: string }` | `result.ok = true` / `result.ok = false` + `error.code`（如非法路径） |
| `work_dir_remove` | web → bridge | `{ path: string }` | `result.ok = true` / `result.ok = false` + `error.code` |

`CONTROL_TYPES` 字面量同步追加：13 项 `['handshake', 'ping', 'pong', 'bridge_status', 'session_state', 'session_list', 'get_state', 'result', 'error', 'list_directories', 'work_dir_list', 'work_dir_add', 'work_dir_remove']`。

#### §1.2 envelope 演进规则 (a)：session_list / session_state / result / pi 增可选字段

- `session_list.payload.work_dir?: string`：按 work_dir 过滤会话清单。**M4 操作惯例必带**（web ChoicePage level=2 进入时查询必带 work_dir，bridge 按目录扫描该 work_dir 下的会话）；schema 仍 optional 不破锁，**缺省全量扫描仅作 M3 兼容语义保留**——M4 web UI 不再走此路径（裁定 A：强制两级选择后物理上不存在"未选目录直接看全量会话"的入口）。
- `session_state.payload.work_dir?: string`：每条广播携带对应 work_dir，便于 web 在 ChoicePage 列表直接渲染（不查 session_list）；与 §1.4 每会话独立进程协同。
- `pi/prompt.payload.work_dir?: string`：**仅 `session:'new'` 的 `prompt` 命令携带**（裁定 A 方案 A——新会话的第一条消息是唯一入口），其他 session 状态下的 prompt 命令不带、bridge 忽略；bridge 收到 `session:'new'` + `work_dir` → 以该目录为 cwd spawn 不带 `--session` 的新 manager（钉子 2 pending 键控见 §1.5）。
- `result.data.work_dirs?: string[]`：`work_dir_list` 回执。
- `result.data.entries?: { name: string, path: string }[]`：`list_directories` 回执。

均沿用 envelope 演进规则 (a) "新增可选字段"——已知消费者忽略未知字段，零破坏。

#### §1.3 session_list 回执字段扩展（保留 `data.sessions[]` + 增简化状态字段）

沿用 M3 §7 `result.data.sessions[]` 字段集（`id` / `name` / `cwd` / `created` / `modified` / `message_count` / `first_message` / `running`），**新增一个字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `running` | boolean | M3 已定义——该会话的 pi 进程是否存活（含空闲）；保留语义 |
| `status` | `"exited"` \| `"idle"` \| `"running"` \| `"spawning"` \| `"unknown"` | **新增**——当前 PiProcessManager 的 phase 简化映射；`unknown` = 未在 bridge 内存中（无活跃 manager，可能从未被该 bridge 看过）；会话被外部 pi 占用时也返回 `unknown`（**不做检测**，对齐业务共识 3） |

`status === 'unknown'` 时 web 在 ChoicePage 列表行显示"未加载"徽章（不显示 phase 细节）；点击进入触发该 session 的 spawn（带 `--session`）→ 走恢复仪式。

#### §1.4 envelope `session` 字段启用规则（多会话下必填，schema 仍 optional）

schema 维持 envelope.md锁版承诺（`session` 字段 optional，不破锁）。**多会话下操作惯例**：
- **web → bridge**：所有 pi 家族命令 + `get_state` / `session_list` 必须带 `session` 字段（缺省视为"作用于 bridge 默认 session"——M3 兼容路径，但 M4 ChoicePage 强制带）。
- **bridge → web**：所有 `session_state` / `command_result` / `snapshot` / `event` 必须带 `session` 字段（M3 兼容路径下可省略，但 M4 推荐始终带，便于 web 按 session 过滤）。
- **session_state 列表广播**：bridge 在每个 manager 的 phase 迁移时各广播一次（各自带 session 字段），web 收 N 个 session_state 各 update 自己的桶。

**为什么不引入 `new_session` / `switch_session` pi 命令**（推论完整论证）：
- "新会话" = bridge spawn 新 PiProcessManager（不带 `--session`，让 pi 自己开新 jsonl 文件）；触发点是 web 在 ChoicePage 点"新建会话"→ web 发 `pi/prompt`（带 `session: 'new'` 占位 + `payload.work_dir`，裁定 A 方案 A）→ bridge 收到后按 §1.5 pending 键控（`new:<work_dir>`）路由；首次 prompt 写入触发 spawn，spawning → ready 后 bridge 在下一个 session_state 广播里携带 session 字段（实际 stem，如 `2026-09-08T10-30-00_a3f9b2c1.jsonl` 的 stem）。
- "切会话" = web 改 URL hash，bridge 不感知；web 后续命令携带新 session 字段，bridge 路由到对应 manager。
- 这两条语义都被 web URL hash + bridge router 完整表达，无需在 pi RPC 协议里新增 type；新增 `new_session` / `switch_session` 会让协议多两个 bridge → pi 的翻译命令（bridge 不知道 pi 何时创建 session 文件，需要先 round-trip 查 session 文件名再喂 `--session`，徒增复杂度）。
- ADR-0007 留下的"取最新"逻辑在 M4 不变：bridge 收到 spawn触发命令时，若 sessionKey 不在 map，按 §1.5 sessionKey 计算规则（cwd 编码 + 扫描）+ 是否带 `--session` 决策。

#### §1.5 sessionKey 计算规则 + pending 键控

`sessionKey` = pi session 文件名 stem（如 `2026-09-08T10-30-00_a3f9b2c1-4d5e-...`）。
- 复用 M3 `encodeCwdForPi(cwd)` + `sessionSubdir(agentDir, cwd)` + `findLatestSession(subdir)`（详见 `packages/bridge/src/pi-cwd-encoder.ts`）。
- 已知会话：web 命令带 `session: <stem>` → bridge 在 map 里查找 → 命中复用，未命中则按 session 路径 spawn 新 manager（cwd = 该 session 所属 work_dir，`--session` = 该 stem 的 jsonl 路径）。
- 未知 / `new` 占位会话：**新会话第一条 prompt 携带 `work_dir`**（裁定 A 方案 A）→ bridge 收到 `session:'new'` + `payload.work_dir`：
  - **pending 键控（钉子 2）**：map 内部键 `new:<work_dir>`；先查 `managers.has('new:' + work_dir)` —— 命中则复用 pending manager（短时多次 new 请求合并为同一个）；未命中则 spawn 新 manager（cwd = work_dir，**不带** `--session`，让 pi 自己开新 jsonl 文件）。
  - manager 启动后：spawning 相位启动 SPAWN_TIMEOUT_MS（§2.3）兜底；收到首个 `entry_appended` 或 ready 后第一次 message_start → 从 stdout / `--session-dir` 派生 stem → bridge 自行将 map 键迁移到真实 stem（`managers.delete('new:' + work_dir); managers.set(stem, manager)`） → 广播 `session_state{session: <stem>}`（web 收到后回填 hash `&session=<stem>`）。
  - 钉子 2 边界：若 `session:'new'` 但 payload 缺 `work_dir` → 拒，回 `result.ok = false` + `error.code: 'invalid_envelope'`（M4 操作惯例下必带，缺省视为协议错）。

> **实测验证点（PRD落盘前必做）**：(a) bridge 是否能在 pi 完成首次 jsonl 写入前读出文件名？答：不能——pi 是 lazy 创建文件的（首次 `agent_start` / 首次 stdout entry写入后才落盘）。M4 必须接受这一窗口——spawning → ready 期间 web 命令的 `session: 'new'` 占位（map 内 pending键 `new:<work_dir>`），bridge 在收到首个 `entry_appended` 事件时（或 ready 后第一次 message_start）从 stdout / `--session-dir` 派生 stem 并广播 `session_state{session: <stem>}`。**凡未实测的落盘细节不可信**——任务06 实施期跑真 pi 探针（沿用 tasks/m3/10 假 LLM 套件）确认事件时序与 stem 派生点。

#### §1.6 bridge → web 列表同步机制（每 manager 各 broadcast session_state）

沿用 M3 §2.7 "广播原则"：写操作 +状态迁移触发 `session_state` 广播。M4 在此基础上**每个 manager 各自 broadcast**（各带自己的 `session` 字段）——web 收 N 个 session_state 按 session 分桶更新。ChoicePage 列表行通过订阅 `useWsState` 的 `sessionStates` Map（key = sessionKey，value = latest payload）渲染 status徽章。

### §2 bridge：state.json + 多 manager + 目录浏览

#### §2.1 独立 state.json（与 bridge.json 分离）

```
~/.config/remotepi/state.json     # bridge 运行时写，**用户手编会丢**
~/.config/remotepi/bridge.json    # 用户手编，仅 bridge 启动读
```

state.json 格式：
```jsonc
{
  "schema_version": 1,
  "work_dirs": ["/abs/path/a", "/abs/path/b"]
}
```

读写时机：
- **读**：bridge 启动时一次性加载到内存 `workDirs: string[]`；后续 `work_dir_list` / `work_dir_add` / `work_dir_remove` 命令操作这份内存。
- **写**：每次 `work_dir_add` / `work_dir_remove` 成功后**同步**写回 state.json（`fs.writeFileSync` + atomic rename：先写 `state.json.tmp` → `rename`覆盖，防并发写半截）。失败 → 回滚内存 + log error + 回 `result.ok = false` + `error.code: 'state_write_failed'`（沿用 control.md §86 个 code 集合，不新增；用 `internal` 兜底）。
- **M3 迁移**：bridge 启动时若 state.json 不存在但 bridge.json 有 `work_dir`字段 → 自动把该字段写入 state.json 作为第一项，**不回写** bridge.json（用户手编配置不被运行时污染）。一次性迁移，迁移完成后打印日志 "migrated work_dir from bridge.json → state.json"。

文件路径解析（沿用 M3 §2.1）：XDG `XDG_CONFIG_HOME` 优先，否则 `~/.config/remotepi/state.json`。

#### §2.2 CLI / env 移除清单
- 沿用 M3 §2.2：CLI 仅 `--config <path>`，未知 flag 静默忽略。
- 不新增 CLI 参数（state.json 路径沿用 XDG 默认，不暴露）。

#### §2.3 PiProcessManager 复数化（Map<sessionKey, manager> + pending 键 + SPAWN_TIMEOUT_MS + ready idle）

`BridgeSessionLayer`（新文件 `packages/bridge/src/session-layer.ts`）持有：

```ts
class BridgeSessionLayer {
  private readonly managers = new Map<string, PiProcessManager>();
  // 注：键可能是 (a) 真实 sessionKey stem（已派生）或 (b) 'new:<work_dir>' pending 内部键（钉子 2）；
  //    map 键迁移见 §1.5，迁移完成前 pending 键与真实 stem 不会共存
  private readonly workDirs: string[]; // 内存中，state.json 镜像
  // 入站路由：按 session 字段分发到对应 manager（含 pending 键解析）
  handleEnvelope(env: Envelope): void { ... }
  
  // 出站回调：每个 manager 的 onOutbound 经 fan-out 广播到所有 web 连接
  // （复用 M3 bridge client 的广播机制）
  
  // 列表查询：按 work_dir 扫描该目录下会话（裁定 A 弱化为按目录扫描）
  listAllSessions(workDir: string): SessionListEntry[] { ... }
  
  // work_dir CRUD：操作内存 + state.json 持久化
  listWorkDirs(): string[];
  addWorkDir(path: string): void;
  removeWorkDir(path: string): void; // 钉子 3：不 kill 活 manager，跑完 idle 自然回收
}
```

构造参数（从 BridgeConfig + state.json 派生）：
- `agentDir`：沿用 `resolvePiAgentDir()`（M3 §2.5）。
- `idleTimeoutMs`：沿用 `IDLE_TIMEOUT_MS = 5 * 60_000`（M3 §2.3，每个 manager 独立计时，**逐会话复制**）。**裁定 C 扩展**：ready 相位无任何写命令（prompt / steer / follow_up 等）也按 idle 路径倒计时——M3 §2.3 状态机仅 `running → idle` 起计时，裁定 C 补加 `ready → idle` 计时迁移（条件=ready 后5min 无写命令）；仅 spawning / blocked_on 显式忙碌相位豁免。
- `sigkillDelayMs`：沿用 `SIGKILL_DELAY_MS = 1000`（M3 §2.3）。
- `spawnTimeoutMs`：**新增** `SPAWN_TIMEOUT_MS = 60_000`（钉子 4）——spawning 相位超 60s 未完成握手（未收到 pi 的 `agent_start` / 首次 stdout entry） → 复用 PiProcessManager 既有自主 kill 标记路径（先置位再发 SIGTERM→1s→SIGKILL；exit 回调三路径走"标记在→不重启"，M3 tasks/m3/04 已落地） → exited 广播；同时 `BridgeSessionLayer` 同步 `managers.delete(<map键>)`（含 pending `new:<work_dir>` 键）。
- `onOutbound`：bridge client 的 broadcast 回调。
- `onStderr`：bridge 自己的 logger。

> **并行进程数无软上限**：单用户场景下，并发进程数受 idle 5min 回收兜底（用户离开 ChoicePage 切走会话后，后台会话5min idle 自动回收——裁定 C 下 ready 相位同等计入）；不设 N 限制。

#### §2.4 会话扫描：按 work_dir 列（裁定 A 弱化全量）

- `listAllSessions(workDir: string)`：**裁定 A 后全量扫描弱化为按目录扫描**——调用方必传 work_dir（web ChoicePage level=2 查询即"目录下的会话"，物理上不再存在"全量列"调用入口）。沿用 M3 §2.5 `sessionSubdir(agentDir, workDir)` + `readdirSync` → 列出 `<timestamp>_<uuid>.jsonl` 文件名 → 派生 sessionKey。
- `session_list` 命令按 payload.work_dir 路由到对应目录扫描（**M4 操作惯例必带**，web ChoicePage level=2 路径）；缺省 work_dir 时回退全量扫描（仅 schema 兼容 M3 路径，**M4 web UI 不走此路径**——裁定 A 强制两级选择顺序自然兜底）。
- 性能：每次 `session_list` 触发单 work_dir fs 扫描；单用户场景工作目录数 ≪ 100，单次< 10ms（沿用 M3 `findLatestSession` 同步实现）；无需缓存。
- 返回字段沿用 §1.3：`status` 字段按 manager.phase 简化映射（'unknown' = 未在 bridge 内存中，无活跃 manager）。

#### §2.5 目录浏览（`list_directories`）

```
web → bridge:  { "v": 1, "kind": "control", "type": "list_directories", "id": "...", "payload": { "path": "/home/sankabox" } }
bridge → web:  result.ok=true, data = { "entries": [{"name": "code", "path": "/home/sankabox/code"}, ...] }
```

实现细节（推荐）：
- `path` 缺省 = `$HOME`（即 `os.homedir()`）；不传 path视为列 home；web UI 提供"上到 home"按钮调 `path = $HOME`。
- `path` 提供时 → `path.resolve(path)` 规范化（处理 `..` / 多斜杠 / 相对路径转绝对）。
- **不设范围限制**（对齐业务共识 2 "起点 home，不设范围限制"）：任何合法路径都可列；单用户自用，无 traversal 安全顾虑。
- 列子目录（`withFileTypes: true` →过滤 `dirent.isDirectory()`），**不含文件**（"添加手段"场景下文件无意义）。
- 路径不存在 / 不可读 / 不是目录 → `result.ok = false` + `error.code: 'invalid_path'`（沿用 control.md §8 6 个 code 集合；选 `internal` 兜底，或复用 `invalid_envelope`——实施期选最贴切的）。
- ENOENT / EACCES / ENOTDIR 各分支错误码独立（M3 §2.1 配置校验的同类做法）。

#### §2.6 work_dir CRUD（`work_dir_list` / `work_dir_add` / `work_dir_remove`）

- `work_dir_list`：`result.ok = true, data = { work_dirs: [...] }`（内存中快照）。
- `work_dir_add`：参数 `path: string` → 规范化 →校验（存在 + 是目录 + 可读，与 M3 §2.1 同三件套）→ 内存 push → 同步写 state.json → 回执。重复添加 =幂等（已存在则 no-op，回 `ok: true`）。
- `work_dir_remove`：参数 `path: string` → 内存 filter → 同步写 state.json → 回执。注意：**不**清理 agent dir 的会话文件（用户可能想保留以备再用），仅从清单移除。**钉子 3**：不做特殊处理——活 manager（cwd = 该 work_dir）不 kill 不打断，跑完 idle 自然回收（裁定 C 扩展下 ready 5min 也计入）；目录从清单移除后 web ChoicePage level=2 不再列该 work_dir 下的会话（即 level2 不可达），但已在 ChatView 看的会话不受影响、用户可继续聊完 / 退出。
- **写入失败处理**：写 state.json 失败 → 回滚内存（remove重新 push / add 重新 pop）→ log error → `result.ok = false` + `error.code: 'internal'`。

#### §2.7 出入站路由（含 pending 键控 + work_dir 提取）

- **入站（web → bridge）**：BridgeClient 现有 `onEnvelope` 回调 → BridgeSessionLayer.handleEnvelope → 按 env.session 字段路由：
  - `session: <stem>`（非 'new'）+ map 命中（含已迁移的真实 stem）→ 该 manager.handleEnvelope。
  - `session: <stem>`（非 'new'）+ map 未命中 → 查找 sessionKey 对应 jsonl 路径（从 listAllSessions 缓存或扫描获取）→ 新建 PiProcessManager 注册到 map（键 = stem）→ 转发。
  - `session: 'new'`：
    - **必带 `payload.work_dir`**（裁定 A 方案 A；envelope (a) 仅 session:'new' 的 prompt 携带，其他命令不带、bridge 忽略——见 §1.2）；
    - 提取 `env.payload.work_dir` → 查 pending 键 `new:<work_dir>` —— 命中复用（钉子 2：同 work_dir 短时多次 new合并为同一 pending），未命中新建 manager（不带 `--session`，cwd = work_dir）→ `managers.set('new:' + work_dir, manager)` → 转发 prompt；
    - 若 `session: 'new'` 但 payload 缺 `work_dir` → 拒绝，回 `result.ok = false` + `error.code: 'invalid_envelope'`（M4 操作惯例下必带，缺省视为协议错）。
  - 无 session + map 里只有 1 个 manager（M3 兼容路径）→ 转发到该 manager。
  - 无 session + map 里 > 1 个 manager（M4 多 manager 后歧义）→ 报错 `error.code: 'invalid_envelope'`。
- control `list_directories` / `work_dir_*` / `session_list` / `get_state` → BridgeSessionLayer 自身处理（不经 manager）；`session_list` 必带 work_dir 路由到 `listAllSessions(workDir)`（裁定 A）。
- **出站（bridge → web）**：每个 manager 的 onOutbound 经 BridgeSessionLayer 广播给所有 web 连接（沿用 M3 bridge client 广播机制；filter 由 web 端做）。pending 键 manager 在派生 stem 后广播 `session_state{session: <stem>}`，web 收到后回填 hash（详见 §1.5）。

### §3 worker：协议搬运工（零业务改动）

worker 维持 M3 行为，本里程碑**零业务代码改动**：
- 转发 web 入站到 bridge（含 M4 新增 4 个 control type）；
- 转发 bridge广播到所有 web；
- handshake / bridge_status / error 自己生成；
- DO 路由 `routeOpenMessage` 补 default 转发分支（M3 task 修复 `1c86aca` 同类——实施期任务 02 实施时一并补；不改协议层逻辑，只补 if/switch 分支）。

### §4 web：选择页 + 多会话 store + URL hash

#### §4.1 URL hash 三字段格式（裁定 B）

```
https://remote-pi.sankabox.com/#<token>&work_dir=<encoded>&session=<key|new>
https://remote-pi.sankabox.com/#<token>&work_dir=<encoded>             # 进入 level2 但未选会话
https://remote-pi.sankabox.com/#<token>                                # M3 兼容：仅 token，老分享链接不失效
```

格式说明（裁定 B + 钉子 1）：
- `token`：**首位无键名**（与 M3 同），是房间密钥。
- `work_dir`：必填 URL 编码（`encodeURIComponent`）；值为绝对路径字符串；缺省视为"未选目录"→ level1。
- `session`：可选；值为真实 sessionKey stem 或字面量 `new`（pending）；缺省视为"未选会话"→ level2。

`readAuthFromHash()` 从 M3 单 token 升级为 token + work_dir + session 三字段解析：解 URLSearchParams 风格，解析顺序 token → work_dir（`decodeURIComponent`）→ session；缺字段视作对应阶段空。F5 / back / forward 由 `hashchange` 事件统一驱动（沿用 M3 App.tsx 既有结构）。

**M3 兼容路径**（裁定 B 必保）：老分享链接 `#<token>` 不失效——web 解析后视作"无 work_dir 无 session"→ level1（强制两级选择顺序自然兜底，老链接命中后用户从 level=1 重新走一遍目录 → 会话选择流程）。

#### §4.2 ChoicePage 三态分派（裁定 A + 钉子 6，修复原歧义）

```
<App>
  ├─ !token                                              → <TokenPrompt />            (M3 既有)
  ├─ token + !work_dir                                   → <ChoicePage level=1>      (新，裁定 A 强制两级起点)
  │    ├─ 顶部: "选择工作目录"
  │    ├─ 中部: work_dirs 列表 (data-testid="work-dir-list")
  │    │   ├─ 每行: path + 删除按钮 (data-testid="work-dir-remove")
  │    │   └─ 底部: "浏览添加"按钮 → 弹 <DirectoryBrowser>
  │    │        ├─ 当前路径 + "上到 home" 按钮
  │    │        ├─ 子目录列表 (data-testid="dir-entries")
  │    │        └─ 每行: name + "选择" 按钮 (触发 work_dir_add)
  ├─ token + work_dir + !session                         → <ChoicePage level=2>      (新)
  │    ├─ 顶部: "选择会话" + 当前 work_dir 路径 + "更换目录"按钮(钉子 6)
  │    ├─ 中部: sessions列表 (data-testid="session-list")
  │    │   ├─ 每行: created / first_message 摘要 / status 徽章
  │    │   └─ 顶部: "新建会话" 按钮 → 跳 ChatView with session=new
  └─ token + work_dir + session                          → <RecoveryView gate=<RecoveryGate for session>> (M3 既有)
                                                            → <ChatView session=<key>> (新，按 session 分桶)
```

**三态分派决策表（钉子 6，渲染分派严格按 hash 三键）**：

| token | work_dir | session | 渲染 |
|-------|----------|---------|------|
| — | — | — | TokenPrompt |
| ✓ | — | — | ChoicePage level=1（裁定 A：强制两级起点；M3 老链接 `#<token>` 也命中此行） |
| ✓ | ✓ | — | ChoicePage level=2 |
| ✓ | ✓ | ✓ | RecoveryView/ChatView |

**导航动作（钉子 6）**：
- **退出会话**：清 `session` 留 `work_dir` → 回 level=2（hash变 `#<token>&work_dir=<encoded>`）。已修改 hash 触发 `session_list` 重查（钉子 5）。
- **更换目录**：清 `work_dir` + `session` → 回 level=1（hash 变 `#<token>`）。用户从 level=1 重新选目录 / 浏览添加。
- **新建会话**（level=2 内）：点"新建会话" → 写 hash `#<token>&work_dir=<encoded>&session=new` → 进 ChatView pending；bridge 收到 `session:'new'` + `work_dir` 启动 pending 键控（§1.5 / §2.7）；stem 派生后 bridge 广播 `session_state{session:<stem>}` → web 收到回填 hash `&session=<stem>`，**同时**触发 level=2 重查（钉子 5：确保新建的会话出现在列表中——但用户此时已在 ChatView，重查仅供返回时可见）。

**level2 会话列表刷新时机（钉子 5）**：
- 进入 level2 时查询一次（首次 mount）；
- 从 ChatView 退回 level2 时重查（点击"退出会话"按钮 / hash 切回 level2 时）；
- 新会话 stem 回填后重查（pending → 真实 stem 时连带一次，确保新建的会话出现在列表中）；
- **不做轮询**——避免 web 端无谓重渲染与 ws 带宽。

状态机（沿用 M3 的 RecoveryGate 但 per-session）：
- 每个 sessionKey 独立一份 RecoveryGate（Map<sessionKey, RecoveryGate>）；进入该 session 时创建，离开不销毁（暂存以备切回时避免重发仪式）。
- "未加载"（`status: 'unknown'`）的 session：进入触发新仪式（与 M3 同路径：exited 时 get_messages 触发带 `--session` 的 spawn）。

#### §4.3 store 按 session 分桶

`WebState`（M3 §4.1）从单会话字段升级为按 session 分桶：

```ts
interface WebState {
  // 全局
  bridgeStatus: BridgeStatusInfo | null;
  connState: ConnState;
  workDirs: string[]; // 镜像 bridge state.json
  currentWorkDir: string | null; // 镜像当前 hash 的 work_dir，供出站自动填 session_list 等命令

  // 按 session 分桶
  sessions: Record<sessionKey, SessionBucket>;
  sessionList: SessionListEntry[];  // ChoicePage level=2 用（仅当前 work_dir 下会话）
  // （目录浏览 responses 是命令-响应模式，不入 store；WebState 持有 transient entries map）
}

interface SessionBucket {
  messages: AgentMessage[];
  streamingDraft: StreamingDraft | null;
  queue: QueueState;
  sessionPhase: SessionPhase;
  blockedOn: BlockedOnEntryPayload[];
  workDir: string; // 镜像 session_state.payload.work_dir
  recovery: 'pending' | 'ready' | 'error'; // 该 session 的 RecoveryGate 状态
}
```

入站分发：WsClient 在 `case 'session_state':` / `case 'snapshot':` / `case 'command_result':` / `case 'event':` 时按 `envelope.session` 字段写入 `sessions[<key>]`（无 session 字段时回退 M3 单桶行为）。

出站组装：所有 pi 命令 / control `get_state` / `session_list` 自动从当前 `currentSessionKey`（来自 hash）填 `session` 字段；`session_list` 自动从 `currentWorkDir` 填 `payload.work_dir`（裁定 A 操作惯例必带）。

#### §4.4 多端各看各的 + 同看同步

- 广播语义不变（沿用 M3）；web store 入站按 `envelope.session` 写入对应桶。
- A端看 session X、B 端看 session Y →各自 UI 只渲染自己的 `sessions[X]` / `sessions[Y]`（互不可见）。
- A / B 同看 session X → 各自 UI 渲染同一桶 =同步（与 M3 等价）。
- ChoicePage level=2 列表行 status 徽章由 `sessions[<key>].sessionPhase` 派生（每收到对应 session 的 session_state 都更新）——不需要轮询。

#### §4.5 弹窗归属会话（blocked_on 隔离）

- DialogHost（M3 §4.2）从单 blockedOn 数组升级为按 session 分桶：`Record<sessionKey, BlockedOnEntryPayload[]>`。
- 当前 session 的弹窗按 M3 既有逻辑显示；切到后台 session 时该 session 的 blockedOn 入桶但 UI 不显示（沿用 M3 "无乐观 UI" 规则：dialog 提交 /取消 / 超时后才移除）。
- 切回该 session 时 DialogHost 重新 mount弹窗（按 blockedOn 当前快照渲染），倒计时按 `Date.now() - entryEnqueuedAt - timeout` 计算（剩余时间，需在 session_state 入桶时记录 enqueuedAt 时间戳——可选字段）。
- **多端先答者胜**（沿用 ADR-0004 §补注 3）：多端同看 session X，A 先提交 → bridge 处理 → broadcast session_state（blocked_on移除该 id）→ B 端的桶也移除 → B 端 dialog 自动收起 +收 `request_expired`。

#### §4.6 ChatView per-session

ChatView（M3 §4.3）接 `session: sessionKey` prop，所有 store 读写走 `sessions[session]`；输入框禁用 / 可用、agent_settled 提示、queue_update 显示、abort / steer / follow_up 按钮全部 per-session。

### §5 shared：schema 扩展（按 §1 落到代码）

```
packages/shared/src/protocol/
  control.ts        # 4 个新 envelope（list_directories / work_dir_list / work_dir_add / work_dir_remove）+ 4 payload schema
                    # session_list payload 加 work_dir? 可选字段（裁定 A：M4 操作惯例必带，schema 仍 optional 兼容 M3）
                    # session_state payload 加 work_dir? 可选字段
                    # result payload data形状由 z.unknown() 不变（具体形状由 caller 用 SessionListPayload / SessionStatePayload 等独立 schema 二次校验）
  pi.ts             # pi/prompt payload 加 work_dir? 可选字段（裁定 A 方案 A——schema 仅标注 optional，注释说明仅 session:'new' 携带；其他 pi 命令零改动）
                    # 无新增 type（pi 家族零新增沿用 §1.4 推论）
  envelope.ts       # 无 schema改动（lock-version envelope 不变）
  literals.ts       # CONTROL_TYPES 列表追加 4 个 literal（共 13 项）
  block-on.ts       # 无改动
```

新文件（若 result.data 二次校验需要单独 schema）：
```
packages/shared/src/protocol/
  work-dirs.ts      # ListDirectoriesPayloadSchema / WorkDirListPayloadSchema / WorkDirAddPayloadSchema / WorkDirRemovePayloadSchema
                    # + ListDirectoriesResultSchema / WorkDirListResultSchema
                    # + PiPromptPayloadWorkDirSchema（可选字段 + 仅 session:'new' 携带的注释；不强制 session 关联以保留 schema 简洁，实施期靠 web 端发命令时遵守）
  session-list.ts   # SessionListEntrySchema（含 status 字段）+ SessionListResultSchema（result.data.sessions 数组二次校验）
```

shared 测试追加（任务 03）：
- 4 个新 payload合法 / 缺字段拒 / 非法类型拒；
- session_list.work_dir 可选（缺省 / 提供）；
- session_state.work_dir 可选；
- **pi/prompt.work_dir 可选字段合法 / 缺字段 / 提供**（注释说明仅 session:'new' 携带，schema 不强制）；
- session_list result.data.sessions 形状（含 status 字段合法 + 5 status枚举值）；
- work_dir_list result.data.work_dirs 形状；
- list_directories result.data.entries 形状；
- CONTROL_TYPES 字面量长度 13 + 新 type 名称对齐。

### §6 恢复仪式 5s 修复（web 链前置任务 01，方案 B+C 完整版）

沿用修订注记技术裁定 2 的方案要点，本节为落地细节。

#### §6.1 改动文件清单

- `packages/web/src/ws/recovery.ts`：`RECOVERY_TIMEOUT_MS` 常量保留为 5_000，但语义从"绝对超时"改为"无进度窗口"——snapshot定时器在 `phase` 字段实际变化时重置为 15_000（`PHASE_PROGRESS_TIMEOUT_MS = 15_000`）；5_000 仍作为"无任何相位变化即失败"的兜底。
- `packages/web/src/App.tsx`：
  - `RecoveryView` 接 `phase` prop（从 WsClient 订阅 `sessionStates[currentSession].sessionPhase`）；
  - `RecoveryInFlight` 接 `phase` prop 显示"正在启动会话…"（phase = 'spawning'）/"正在加载历史…"（phase = 'ready' | 'running' | 'idle'）/"5 秒未收到进度…"（无相位变化超 5s）；
  - auto-start effect 追加 `bridgeStatus.online === false` 守门（`null` 不算——冷启动期间 `bridge_status` 未补发是常态，避免误杀）。
- `packages/web/src/ws/recovery.ts`：
  - 新增 `subscribeToSessionState(wsClient, onPhaseChange)`：内部注册 `ceremony.unsubs` 清理（沿用现有仪式 unsubscribe 模式，StrictMode / retry 安全）；
  - 新增 `subscribeToBridgeStatus(wsClient, onBridgeStatusChange)`：同上；
  - `checkComplete` 逻辑升级——snapshot 定时器在 onPhaseChange 触发时重置为 `PHASE_PROGRESS_TIMEOUT_MS`；无相位变化维持 `RECOVERY_TIMEOUT_MS` 兜底失败。
- `packages/web/src/ws/recovery.ts` JSDoc + `App.tsx` 文案更新。

#### §6.2 新错误文案
```
RecoveryErrorCard.errorHint:
  'snapshot_failed':   '无法拉取历史消息（超时或返回失败）。请检查网络后重试。' （M3 既有）
  'state_failed':      '无法拉取会话状态（超时或返回失败）。请检查网络后重试。' （M3 既有）
  'both_failed':       'bridge离线或无法拉取会话状态与历史消息。请刷新页面或检查 bridge 状态后重试。'（改：明示 bridge 离线可能）
  'bridge_offline':    'bridge 当前离线。请检查 bridge 进程是否运行后重试。'（新增，优先于 both_failed 在 bridgeStatus 离线时显示）
```

#### §6.3 测试
- 恢复仪式 timeout 修复：mock WsClient 模拟相位变化触发 → snapshot 定时器重置验证；
- 离线秒失败：mock bridgeStatus.online = false 在仪式进行中到达 → 立即失败 +错误文案验证；
- StrictMode / retry 不泄漏监听器：ceremony.unsubs 数组验证（沿用 M3 tasks/m3/07 review 思路）；
- 文案区分：errorHint 单元测试。

### §7 worker（零业务改动 + 实施期一处 default 分支补漏）

详见 §3。任务 02 实施期 worker DO 路由 `routeOpenMessage` 补 4 个新 control type 的 default 转发（与 M3 task `1c86aca` 同类——M3 任务 01 review 误放行的教训，本任务实施时严格走 default 兜底）。

### §8 文档同步

| 文件 | 改动 |
|------|------|
| `docs/architecture/protocol/envelope.md` | 锁版承诺 control 9 → 13 type（备注破锁依据沿用 ADR-0006）；演进规则 (a) 列出 M4 新增可选字段：`session_list.payload.work_dir`（裁定 A 语义备注：M4 操作惯例必带，schema optional）/ `session_state.payload.work_dir` / `pi/prompt.payload.work_dir`（裁定 A 方案 A备注：仅 `session:'new'` 携带）/ `result.data.work_dirs[]` / `result.data.entries[]` |
| `docs/architecture/protocol/control.md` | §6 session_list payload 加 `work_dir` 可选（M4 操作惯例必带，schema optional）；§7 session_list 回执加 `status` 字段；新增 §6.5/6.6/6.7/6.8（`list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`，每个含 payload + 回执 + 失败码）；type 列表 13 项 |
| `docs/architecture/protocol/pi.md` | "多会话扩展（预留）"节正式落地：明确每会话独立进程 + envelope `session` 字段启用规则 + sessionKey 计算 + **pending 键控**（钉子 2：`new:<work_dir>` 内部键 + map 迁移 + 短时合并语义）；新增 `pi/prompt.payload.work_dir` 字段说明（**仅 `session:'new'` 携带**，裁定 A 方案 A）；删除"将向 pi 家族新增 new_session / switch_session / list_directories"占位 |
| `docs/architecture/decisions/0003-session-lifecycle-and-history-source.md` | 末尾追加"M4 多会话化补注"——idle 计时逐会话复制 / session_state 每 manager 各 broadcast / 跨会话 idle 互不干扰 / **ready 相位无写命令 5min 回收**（裁定 C：`ready → idle` 计时迁移） / **spawning 相位 60s 超时自主 kill**（钉子 4：复用自主 kill 标记路径 + exited 广播 +清理 map 键） |
| `docs/architecture/decisions/0007-host-shared-pi-agent-dir.md` | §验证与后续段删除"会话被外部进程占用检测"挂账（正式关闭） |
| ADR-0010（任务 02 落盘，暂未创建） | **新增 ADR**——记录 control 9 → 13 type 破锁决策（沿用 ADR-0006 范式）+ envelope (a) 字段扩展清单（含 `pi/prompt.payload.work_dir` 裁定 A 方案 A 备注）+ envelope session 字段启用规则 + sessionKey 计算 + 每会话独立进程推论 + **pending 键控决策**（钉子 2：`new:<work_dir>` 内部键 + map 迁移时序）+ **SPAWN_TIMEOUT_MS 决策**（钉子 4：60_000 + 复用自主 kill 路径） |
| `docs/current-state.md` | 活跃需求追加 M4 PRD 链接；TODO 删"会话被外部占用检测"（已关单）+ 删"恢复仪式 5s 超时"（M4 任务 01 修）；任务看板增 M4 行 |
| `docs/tasks/m3/{07,12,13}*.md`、`docs/architecture/decisions/0009-headless-browser-e2e.md`、`docs/current-state.md` | **`REPLY_TIMEOUT_MS` → `RECOVERY_TIMEOUT_MS` 共 6 处统一更正**（grep 实证：`grep -rn REPLY_TIMEOUT_MS docs/` 应零结果） |
| `getting-started.md` | bridge 配置章节增 state.json 说明 + M3 work_dir 自动迁移提示；网页使用流程补"目录 → 会话"两级选择说明（含裁定 A 强制两级顺序 + URL hash 三字段格式示例） |

### §9 测试

#### §9.1 shared（vitest）

预计新增 30+ 条（按 §5 末节清单）：
- 4 个新 payload schema 合法 / 缺字段拒；
- session_list / session_state 加 work_dir 缺省 + 提供双向；
- **pi/prompt.work_dir 可选字段合法 / 缺字段 / 提供**（注释说明仅 session:'new' 携带，schema 不强制）；
- session_list result.data.sessions 形状（含 status 5枚举合法 + 非法 status 拒）；
- work_dir_list / list_directories result.data 形状；
- CONTROL_TYPES 字面量长度 13 + 新 type 名对齐；
- envelope `session` 字段仍 optional（验证未误改 lock-version）。

#### §9.2 bridge（vitest）

- state.json 加载：合法 / JSON错 / 缺 schema_version / 缺 work_dirs；
- state.json 写入：atomic rename 验证（模拟并发写）；
- M3 迁移：bridge.json 有 work_dir + state.json 不存在 → 迁移到 state.json；
- work_dir CRUD：add / remove / list路径校验三件套（存在 / 是目录 / 可读）；
- 写入失败回滚（mock fs.writeFileSync throw）；
- 重复添加幂等；
- **钉子 3：work_dir_remove 活会话不受影响**：活 manager 在 map 中 + cwd = 该 work_dir → work_dir_remove 后 manager phase 不变、不 kill；idle 倒计时正常推进（裁定 C ready 5min 也计入）；自然 exited 广播后 map 键清理；work_dir 移除后 `session_list` 不再列该目录入口（web UI 层面不可达）。
- **钉子 2：pending 键控**：同 work_dir 连续两次 `session:'new'` + work_dir → 仅第一个 spawn 新 manager，第二个复用 pending（同 map键 `new:<work_dir>` 命中）；不同 work_dir `session:'new'` → 各 spawn 各的 pending 键（map 中并存多键）；pending → 真实 stem 迁移：mock 首次 entry_appended → 派生 stem → map 键迁移 → 广播 `session_state{session:<stem>}`；`session:'new'` 但缺 work_dir → 拒 + `error.code: 'invalid_envelope'`。
- **钉子 4：SPAWN_TIMEOUT_MS 60_000**：mock spawning 持续 > 60s 未完成握手 → manager self-kill（复用自主 kill 标记）→ 广播 exited；期间 pending `new:<work_dir>` 键同步 delete；spawning < 60s 内完成 handshake → 不触发超时，正常 ready。
- **裁定 C：ready 5min idle 回收**：mock manager 进入 ready 后无写命令持续 5min → 进入 idle 回收路径 → exited 广播（同 running → idle 路径）；ready 期间收到 prompt / steer / follow_up → 重置计时器；spawning / blocked_on 显式忙碌相位不计入 idle 回收。
- BridgeSessionLayer handleEnvelope 路由：有 session + 命中 → 转发；有 session + 未命中 → 扫描建 manager；session: 'new' + work_dir → pending 键控（见上）；session: 'new' 缺 work_dir → 拒 + invalid_envelope；无 session + map 1 个 → M3 兼容；无 session + map > 1 个 → 报错（M4 不允许歧义）。
- listAllSessions：按 work_dir 扫描 + status 字段映射（manager.phase / 'unknown'）；裁定 A 下接口签名必填 work_dir；
- list_directories：home 起点 / 任意路径 / 不存在 / 不是目录 / 不可读 各分支；
- 跨 manager 广播隔离：A manager 出站不污染 B manager 的 web 视图（每个 manager 各 broadcast 自己的 session_state）。

#### §9.3 integration（vitest，假 LLM 套件沿用 ADR-0008）

- 多 work_dir 列表扫描（fixture 写 2 个 work_dir 的假 session 文件 + bridge BridgeSessionLayer.listAllSessions 验证返回顺序）；
- spawn 多 manager（fake LLM + 2 个 work_dir + 各自 prompt → 各自 ready）；
- **pending键 → stem 迁移端到端**：fake LLM 模拟 pi stdout 输出首个 entry → bridge 派生 stem → 广播 session_state + map 键迁移 + 后续同 session_id 命令命中真实 stem 键；
- **裁定 C ready idle 端到端**：fake LLM 模拟 manager ready 后无写命令 → 5min 后自然 exited；
- **钉子 4 spawning 超时端到端**：fake LLM 模拟 pi 卡在 spawning 不输出 entry → 60s 后自主 kill + exited；
- **实测验证点**（PRD落盘前必做）：spawn 后何时能从 pi stdout 派生 sessionKey？真 pi 跑两次测验证（沿用 tasks/m3/10 假 LLM 套件 helper）。

#### §9.4 worker / DO

- 零新增（M3 已有测试覆盖转发；default 分支补漏走冒烟）。

#### §9.5 web

- **钉子 1：hash 三键解析**：readAuthFromHash 解析 `#<token>&work_dir=<encoded>&session=<key>` / `#<token>&work_dir=<encoded>` / `#<token>&session=<key>` / `#<token>` / `#<token>&work_dir=<encoded>&session=new` 多种形态；work_dir `decodeURIComponent` 正确还原（含特殊字符 `&` `#` `+` `%` 路径）；M3 老链接 `#<token>` 兼容（视作无 work_dir 无 session → level1）。
- **裁定 A 三态分派**：单元测试 mock readAuthFromHash 返回值 × 决策表，验证渲染分派函数命中正确组件。
- ChoicePage level=1：work_dirs 渲染 / 删除按钮 / 浏览添加（DirectoryBrowser 调 list_directories 往返）；
- ChoicePage level=2：sessions 渲染 / status 徽章 / 新建会话跳 ChatView；
- **钉子 5：level2 列表刷新时机**：进入 level2 触发一次 session_list 查询；从 ChatView 退回 level2（退出会话按钮 / hash 变化清 session）触发 session_list 重查；pending stem 回填后触发 session_list 重查；无轮询触发（mock timer 不应触发 session_list）；
- URL hash 更新：选定工作目录 → 写 `#<token>&work_dir=<encoded>`；选定会话 → 追加 `&session=<key>`；退出会话 → 清 session 留 work_dir；更换目录 → 清 work_dir+session；F5 → 携带三键直接进 ChatView；
- 新会话：选 work_dir → level2 → 点"新建会话" → hash 写入 `&session=new` → ChatView → bridge 派生 stem → 广播 session_state{session:<stem>} → web 回填 hash `&session=<stem>`；
- store 按 session 分桶：多 session 并行各自 phase / messages / blockedOn 独立；
- 切会话：dialog 归属切换（前台 → 后台 dialog 暂存 / 后台 → 前台 dialog 恢复）；
- 离线秒失败：mock bridgeStatus.online=false 在仪式进行中到达 → 立即 error='bridge_offline'；
- 无进度超时：mock session_state 持续无相位变化 → 5s 兜底失败；
- 有进度超时：mock session_state 持续给相位变化 → snapshot 定时器持续重置直至 15s 兜底；
- RecoveryInFlight 文案按 phase 切换。

#### §9.6 E2E（Playwright，沿用 ADR-0009 / tasks/m3/12/13）

新增 e2e 场景（5 条）：
- **(d) 目录浏览 + 添加**：从 TokenPrompt → ChoicePage level=1 → "浏览添加" → DirectoryBrowser 选 home下的子目录 → work_dirs列表新增 → ChoicePage level=2 列该 work_dir 会话；
- **(e) 多端各看各的**：双 context 同 token → A 端看 session X、B 端看 session Y → A 发 prompt → B 端 ChatView 不显示该消息；
- **(f) 跨会话 blocked_on 隔离**：A 端看 session X、B 端看 session Y，X 触发 select 弹窗 → A 端显示 / B 端后台 dialog 暂存；切 B 到 X 后 dialog 恢复 + 倒计时；
- **(g) 钉子 3 work_dir_remove 活会话**：活 manager 在 work_dir 下 spawn → work_dir_remove → 该 manager 仍在 ChatView 可用（自然 idle 回收前不被 kill）→ 自然 exited 后 manager 清理；
- **(h) 钉子 2 pending 键控**：双 context 同一 work_dir 短时多次点"新建会话" → 同一目录仅一个 pending manager → stem 派生后两个 context 都看到新会话入列表。

回归：现有3 场景 (a)(b)(c) 全绿；恢复仪式 retry 容错断言简化为纯等 ChatView（技术裁定 2 + ADR-0009 §开放点 1 长期路径落实）。

### §10 用户手测清单口径
- 真实环境（`https://remote-pi.sankabox.com/#<token>`）：能完成"目录浏览 → 添加 → 选目录 → 列会话 → 选会话 → 聊天"全链路（裁定 A 强制两级顺序自然兜底老链接）；
- 多端各看各的：两个浏览器标签同 token，选不同会话，互不干扰；
- URL hash 持久化：F5 / back / forward 维持正在看的会话（三字段 `#<token>&work_dir=<encoded>&session=<key>` 直接进 ChatView；切走会话 hash 同步更新）；
- 后台会话状态：ChoicePage level=2 列表行 status 徽章实时更新（无需进 ChatView）；
- 离线秒失败：kill bridge → 恢复仪式秒失败 + "bridge 离线" 文案；
- 无进度超时：bridge 启动后仪式在 5s 内未收到 session_state → 失败 + "5 秒未收到进度" 文案；
- 有进度超时：bridge 持续给相位变化但 snapshot 不回 → 15s 后失败；
- **裁定 C ready idle**：会话 ready 后不聊 / 不发消息，5min 后 ChatView 显示"会话已退出"（同 idle 路径）；
- **钉子 4 spawning 超时**：pi 卡在 spawning → 60s 后 ChatView 显示"会话启动失败"（exited 广播）；
- **钉子 3 work_dir_remove 活会话**：活 manager 在 work_dir 下 → web 端移除该 work_dir → 继续在 ChatView 聊 → 自然 idle 后退出（不被打断）；
- **钉子 2 pending 键控**：同 work_dir 短时多次点"新建会话" → 实际只产生一个 pending manager，stem 派生后一个会话入列表；
- **M3 老链接兼容**：老分享链接 `#<token>` 打开 → 进 level=1 重新走流程（不报错 / 不白屏）。

## 任务拆分

| # | 标题 | 依赖 |
|---|------|------|
| 01 | web 恢复仪式 5s 修复（snapshot 无进度超时 + bridgeStatus 离线秒失败 + RecoveryInFlight 接 phase 文案） | — |
| 02 | shared 协议 v3（control 4 新 type + session_list/session_state/result 可选字段 + **pi/prompt.payload.work_dir 仅 session:'new' 携带** + session_list.status + envelope session 启用规则）+ worker default 转发兜底 + ADR-0010 | — |
| 03 | shared 测试扩展（30+ 条 + CONTROL_TYPES 13 项 + pi/prompt.work_dir 携带语义注释测试） | 02 |
| 04 | bridge state.json 持久化（独立文件 + atomic write + 写入失败回滚）+ M3 bridge.json work_dir 自动迁移 | — |
| 05 | bridge 目录浏览 control/list_directories（home 起点 + 路径规范化 + 三件套校验 + 错误码） | 03/04 |
| 06 | bridge work_dir_list/add/remove control + BridgeSessionLayer 多 PiProcessManager Map复数化（含**钉子 2 pending 键控 `new:<work_dir>`** / **钉子 4 SPAWN_TIMEOUT_MS 60_000** / **裁定 C ready 5min idle** / **钉子 3 work_dir_remove 不 kill 活 manager**）+ sessionKey 路由 + 跨 manager广播隔离 + **sessionKey 派生真 pi 探针验证** | 03/04/05 |
| 07 | web readAuthFromHash **三字段**（**钉子 1**）+ URL hash token/work_dir/session + ChoicePage **三态分派**（**钉子 6**）+ level1/level2 + DirectoryBrowser组件 + store work_dirs 镜像 + **level2 列表刷新时机**（**钉子 5**） | 03/04 |
| 08 | web WebState 按 session 分桶 + 入站按 session 路由 + 出站自动带 session（**裁定 A**：session_list 自动带 currentWorkDir）+ ChatView per-session + RecoveryGate per-session + 跨会话 blocked_on 隔离 | 03/06/07 |
| 09 | docs 同步（envelope/control/pi/ADR-0003 [补注**裁定 C + 钉子 4**：ready idle + spawning 超时]/0007/0010 + current-state + getting-started [URL hash 三字段示例]）+ `REPLY_TIMEOUT_MS` 6 处更正 | 02 |
| 10 | E2E 场景 (d) 目录浏览 + (e) 多端各看各的 + (f) 跨会话 blocked_on 隔离 + **(g) 钉子 3 work_dir_remove 活会话** + **(h) 钉子 2 pending 键控** + 场景 (a)(b) retry 容错断言简化 + 三端联调手测清单（含裁定 A/B/C + 钉子 1-6 全覆盖） | 08/09 |

依赖链：
- **01** 是 web 链前置，与 02/03/04 可并行（web 单端改动，bridge / worker 零改动）；
- **02** 是协议根任务，所有改造的锁版依据；
- **03 → 02**（测试必跟协议）；
- **04** 独立（持久化形态独立确定）；
- **05 → 03/04**（目录浏览依赖新 type + state.json）；
- **06 → 03/04/05**（多 manager 复数化是 05 的下游，且依赖 sessionKey 派生探针；本任务覆盖裁定 C + 钉子 2/3/4 的 bridge 实现）；
- **07 → 03/04**（web 端协议层 + state.json 镜像；本任务覆盖钉子 1/5/6 的 web 实现）；
- **08 → 03/06/07**（web 端 store + UI 接线，依赖 bridge 多 manager + web 选择页）；
- **09 → 02**（文档同步跟协议；本任务覆盖 ADR-0003 补注裁定 C + 钉子 4）；
- **10 → 08/09**（E2E 扩展 + 手测清单）；
- 03/04 与 02 可并行起步；05/06/07/08 形成 web + bridge 双链，最后 09 收尾 + 10 验收。

总计 10 个任务（区间 8-12 内）；规模与 M3 任务链可比（M3 是 13 个任务，含 4 个集成 / E2E / 文档 / 验收收尾，本 M4 集成测试沿用 ADR-0008 基建不单列，故略少 3 个）。

## 交付约定

沿用 [[prds/m2-tunnel.md#交付约定|M2 / M3 交付约定]]：所有任务（01–09）只在本地 commit，不 push。10（E2E 扩展 + 三端联调手测验收）落地后，用户本地验证（lint / typecheck / test / build + e2e 全绿 + 三端手测通过）→ 用户手动 `git push origin main` → Actions 首跑 CD（沿用 M2 deploy.yml）。

## 用户操作清单

- **配置 bridge**：`~/.config/remotepi/bridge.json` 仍只需 `worker_url` / `web_base_url`；`work_dir` 字段在 M4 启动时被自动迁移到 `state.json`（首次启动后即可从 bridge.json 删除该字段，下次启动自动迁移幂等 no-op）；新工作目录通过网页"浏览添加"添加，无需手编 state.json。
- **认证**：沿用 M3（pi TUI `/login` 或复制 auth.json；详见 [[getting-started.md#3.5 配置文件 JSON 字段说明|getting-started §3.5]]）。
- **启动 bridge**：`bridge`（默认配置路径）或 `bridge --config <path>`。
- **首次访问**：浏览器开 `https://remote-pi.sankabox.com/#<bridge启动时打印的 token>` → ChoicePage level=1（工作目录选择，裁定 A 强制两级起点）→ "浏览添加" 或选已有 → ChoicePage level=2（该目录下的会话选择）→ 选会话或新建 → ChatView。
- **F5 / 书签**：URL hash 携带完整三字段 `#<token>&work_dir=<encoded>&session=<key>` → 直接进该会话；缺字段则按裁定 A 三态分派（仅 token → level=1；token+work_dir 无 session → level=2；全有 → ChatView）。
- **联调手测**：按 §10 用户手测清单逐条验过。

## 风险与实现时核实

- **sessionKey 派生时机**（实测验证点）：bridge 在 pi spawn 后何时能从 stdout / `--session-dir` 派生 sessionKey？**任务 06 实施期跑真 pi 探针**（沿用 tasks/m3/10 假 LLM 套件 helper）确认事件时序与 stem 派生点（推荐候选：收到首个 `entry_appended` 事件时扫 agent dir 找最新 jsonl；或 `--session-dir` 显式注入让 pi 立刻创建文件）。**凡未实测的落盘细节不可信**——本风险点必须实测后才落代码。**钉子 2 配套**：pending 键 `new:<work_dir>` 的派生时机同上，stem 派生后 map 键迁移时序必须严格（删除旧键 + 设置新键 + 广播 session_state 三步原子，避免期间被命令误路由）。
- **跨 manager 广播隔离**：N 个 manager 各 broadcast session_state 时，`WsClient` 入站分发必须按 `envelope.session` 严格路由——错路由会导致 A session 的消息误入 B session 的桶。**任务 08 实施期覆盖回归测试**（沿用 M3 任务 06 "事件提取器对齐真实 wire + stableKey 位置键" 同思路）。
- **目录浏览路径安全**：单用户自用，不设范围限制（业务共识 2）；但 bridge 实现仍做基本 `path.resolve` 规范化 + 三件套校验。**不**试图做 symlink 环检测（用户自担风险）。
- **state.json 并发写**：atomic rename（先写 tmp → rename覆盖）规避半截状态；写入失败回滚内存。
- **M3 bridge.json work_dir 自动迁移**：迁移完成后不回写 bridge.json（用户手编配置不被运行时污染）；首次启动打印日志提示。
- **多会话 idle 计时**：每 manager 各自 5min 计时（裁定 C 扩展：ready 相位无写命令也按 idle 路径倒计时，与 running → idle 同一计时器逻辑）；用户离开 ChoicePage 切走会话后后台会话正常进入 5min 回收路径；与 spawning / blocked_on 显式忙碌相位不冲突（豁免）。
- **SPAWN_TIMEOUT_MS 60_000 边界**（钉子 4）：60s 在慢机器 / 冷启动机器（IO 慢 / 首启）下可能不够——任务 06 实施期实测真 pi 冷启动时长覆盖 P95 后再定，必要时调整上限；超时后通过自主 kill 标记路径保证不悬挂（不依赖外部 GC）。
- **pending 键控边界**（钉子 2）：同 work_dir 短时多次 `session:'new'` 请求合并语义对 web 端"误触"友好；但若用户短时间在 level=2 选 A work_dir 点新建、立刻又选 B work_dir 点新建，两个 pending map 键并存是预期行为；web 端需通过回填 hash 区分各自 stem。
- **work_dir URL 编码/解码边界**（钉子 1）：路径含 `&` `#` `+` `%` 空格等特殊字符时 `encodeURIComponent` / `decodeURIComponent` 必须成对正确——任务 07 实施期覆盖特殊字符路径的 fixture 测试（含 macOS `/Users/foo bar/`、Linux `/mnt/data&backup/`、URL fragment 边界）。
- **ready 5min 与自动响应会话误杀**（裁定 C）：若会话处于 ready 但 agent 在等待用户后续输入（无写命令但用户随时可能发），5min 后会被回收——这与 M3 行为不同（M3 ready 不起计时），用户感受从"会话长期可用"变为"5min 不聊就回收"，需在用户操作清单 / getting-started 明确告知，避免"我刚切走它怎么没了"的疑惑；UI 层 ChatView 在 ready 状态显示"5分钟后无输入将自动退出"提示（沿用 M3 agent_settled 倒计时 UI 风格，实施期定）。
- **弹窗跨会话隔离**：DialogHost per-session 分桶；后台 dialog 暂存时间戳（enqueuedAt）以保证切回时倒计时准确（剩余 = timeout - (Date.now() - enqueuedAt)）。
- **URL hash 长度**：token ≈ 36字符 + work_dir 编码后约 50-200 字符（依路径深度）+ session ≈ 50 字符；hash 总长 < 400 字符（极端长路径），在主流浏览器 URL 长度限制内；任务 07 实施期对极深路径做 fixture 验证。
- **level2 列表不轮询的取舍**（钉子 5）：不轮询 = 后台会话 phase 变化无法主动反映到 level=2 列表行 status 徽章；但 ChoicePage 仅在用户实际进入时刷新 + stem 回填触发 → 用户实际可观测性 OK；后台跨会话状态更新走 session_state 广播兜底（用户切回 level=2 看到的是实时快照，详见 §4.4）。如后续要后台实时状态，需引入定向订阅（M4 defer）。
- **worker DO 路由 default 转发兜底**：任务 02 实施期严格走 default 兜底补 4 个新 control type；M3 任务 01 review 误放行教训（M3 联调 hotfix `1c86aca`），本任务实施时对应补漏——worker DO `routeOpenMessage` switch 必须含全部 13 control type + 全部 9 pi type 的 default 分支。
- **ADR-0010 与 envelope.md 锁版承诺描述同步**：破锁修订需在 envelope.md 与 ADR 双向引用，确保后续维护者找到决策源头。
- **REPLY_TIMEOUT_MS 文档漂移**：grep 全仓库确认 6 处全部更正；grep 验证 `REPLY_TIMEOUT_MS` 零结果。
- **文档维护两 PRD 风格统一**：M4 PRD 与 M3 PRD 同样以"决策导向、给 ADR / 协议文档留引用锚位"为准；不为 M4 创新文档格式。

## 相关

[[architecture/protocol/README.md|协议 v1]] / [[architecture/protocol/envelope.md]] / [[architecture/protocol/control.md]] / [[architecture/protocol/pi.md]] / [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] / [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] / [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] / [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] / [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] / ADR-0010（任务 02 落盘，暂未创建） / [[roadmap.md#5-里程碑|M4 行]] / [[prds/m3-single-session.md|M3 PRD]] / [[current-state.md]] / [[getting-started.md]]

## 已敲定决策记录（2026-09-08）

1. **每会话独立 pi 进程**：M3 的 `PiProcessManager` 5 相位状态机逐会话实例化；崩溃隔离、idle 各自独立。pi 原生 RPC 的 `new_session` / `switch_session` 命令**不需要**——切会话 = web 换视图，新会话 = bridge spawn 新进程不带 `--session`（详见 §1.4 推论）。
2. **state.json 与 bridge.json 分离**：bridge 运行时写 `state.json`（含 work_dirs 清单），不污染用户手编的 `bridge.json`；M3 单 `work_dir` 自动迁移为清单第一项。
3. **恢复仪式 5s 修复 = B+C 合体**：web 单端改动，bridge / worker 零改动。C核心 = snapshot 腿从绝对5s 改无进度超时（`session_state.phase` 变化重置 snapshot 定时器为 15s；无变化维持 5s 兜底失败）；B 辅助 = `bridgeStatus.online === false` 离线秒失败（`null` 不算，避免冷启动误杀）。`useBridgeStatus` hook 现成复用。
4. **传输模型 = 全广播 + web 按 session 过滤**：envelope `session` 字段已预留，多会话下按惯例必填；schema 维持 optional（wire 兼容，零 schema 改动）；定向订阅留作后置优化。
5. **sessionKey = pi session 文件名 stem**（`<timestamp>_<uuid>`）；复用 M3 `encodeCwdForPi` + `findLatestSession`。
6. **多会话 idle 5min 计时 = 逐 manager 各自计时**（每会话独立 PiProcessManager 副产物）。
7. **并行进程数无软上限**：idle 5min 回收兜底，单用户场景下无 N 限制。
8. **目录浏览 = 列子目录（不含文件）；起点 home；不设范围限制**；bridge 实现仍做 `path.resolve` 规范化 + 三件套校验。
9. **协议破锁：control 9 → 13 type**（新增 `list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`），envelope.md 演进规则同步修订；ADR-0010 记录决策源头（沿用 ADR-0006 范式）。
10. **envelope (a) 增字段**：`session_list.payload.work_dir?` / `session_state.payload.work_dir?` / `result.data.work_dirs[]` / `result.data.entries[]`；`session_list` 回执增 `status` 字段（5 枚举）；均不破锁。
11. **pi 家族零新增**：每会话独立进程推论下，`new_session` / `switch_session` / `list_directories` 均无引入必要（详见 §1.4）。
12. **worker 零业务改动**，仅 DO 路由 `routeOpenMessage` 补 4 个新 control type default 转发分支（与 M3 task `1c86aca` 同类教训）。
13. **会话占用完全不检测**：正式关闭 ADR-0007 §验证与后续段"会话被外部占用检测"M4 候选挂账，PRD 写入非目标。
14. **URL hash 格式**：`#<token>&session=<sessionKey>`；新会话占位 `&session=new`，bridge spawn 后回填实际 stem。（后被决策 20/22 修订为三字段格式）
15. **弹窗归属会话**：blocked_on 按 session 隔离；后台 dialog 暂存 +切回时恢复（含倒计时）；多端先答者胜沿用 ADR-0004 §补注 3。
16. **后台会话状态可见**：ChoicePage level=2 列表行 status 徽章由 `session_state.payload.phase` 派生，不做推送 / 角标 / 桌面通知。
17. **文档漂移更正**：`REPLY_TIMEOUT_MS` → `RECOVERY_TIMEOUT_MS` 共 6 处统一更正，纳入任务 09。
18. **E2E 扩展**：新增 3 场景（目录浏览 / 多端各看各的 / 跨会话 blocked_on 隔离）；现有场景 (a)(b) retry 容错断言在恢复仪式修复后简化为纯等 ChatView。
19. **裁定 A（强制两级选择 + session_list 必带 work_dir）**：不再提供"所有 session 的列表"——用户必须先选 work_dir 才能看会话列表。`session_list` 操作惯例必带 work_dir；schema 仍 optional兼容 M3；bridge `listAllSessions()` 全量扫描弱化为按目录扫描。配合新会话携带 work_dir（裁定 A 方案 A）：envelope (a) 给 pi 家族 `prompt` payload 增可选 `work_dir` 字段，**仅 `session:'new'` 的 prompt 携带**（新会话第一条消息是唯一入口），其他命令不带、bridge 忽略；bridge 收到后以该目录为 cwd spawn 不带 `--session` 的新 manager。
20. **裁定 B（URL hash 三字段全存）**：格式 `#<token>&work_dir=<encoded>&session=<key|new>`；token 首位无键名（与 M3 同）；work_dir URL 编码；M3 老分享链接 `#<token>` 不失效——web 解析后视作"无 work_dir 无 session"→ level1 强制两级顺序自然兜底。
21. **裁定 C（idle 回收扩展到 ready 相位）**：ready 5min 无任何写命令（prompt / steer / follow_up 等）也按 idle 路径倒计时（与 running → idle 同一计时器逻辑复用）；仅 spawning / blocked_on 显式忙碌相位豁免。ADR-0003 §补注一并覆盖（任务 09）。
22. **钉子 1（hash 格式三字段具体化）**：`#<token>&work_dir=<encoded>&session=<key|new>`；token 首位无键名；work_dir `encodeURIComponent`编码；M3 老链接 `#<token>` 兼容视作 level1。
23. **钉子 2（pending 新会话键控）**：bridge 侧 `session:'new'` 按 work_dir 键控（`new:<work_dir>` 内部键），同一目录同时至多一个未落盘新会话（短时多次 new 请求合并）；stem 派生后 map 键迁移（`managers.delete('new:' + work_dir); managers.set(stem, manager)`）+广播 `session_state{session: <stem>}`，web 回填 hash；`session:'new'` 缺 work_dir → 拒 + invalid_envelope。
24. **钉子 3（work_dir_remove 与活会话自然回收）**：`work_dir_remove` 不 kill 不打断活 manager（cwd = 该 work_dir），跑完 idle 自然回收（裁定 C 下 ready 5min 也计入）；目录从清单移除后 level2 不可达，但已在 ChatView 的会话不受影响、可继续聊完。
25. **钉子 4（spawning 悬挂超时 SPAWN_TIMEOUT_MS）**：`SPAWN_TIMEOUT_MS = 60_000`——spawning 相位超 60s 未完成握手（未收到 pi 的 `agent_start` / 首次 stdout entry） → 复用 PiProcessManager 既有自主 kill 标记路径（先置位再发 SIGTERM→1s→SIGKILL；exit 回调走"标记在→不重启"）→ exited 广播；同时 BridgeSessionLayer 清理 map 键（含 pending `new:<work_dir>` 键同步 delete）。ADR-0003 §补注一并覆盖（任务 09）。
26. **钉子 5（level2 会话列表刷新时机）**：进入 level2 时一次 / 从 ChatView 退回 level2 时重查 / 新会话 stem 回填后重查；**不做轮询**——避免 web 端无谓重渲染与 ws 带宽。
27. **钉子 6（导航三态收敛）**：渲染分派严格按 hash 三键——无 token → TokenPrompt；有 token 无 work_dir → level1；有 token+work_dir 无 session → level2；有 token+session（含 new）→ RecoveryView/ChatView。退出会话=清 session 留 work_dir（回 level2）；更换目录=清 work_dir+session（回 level1）。原 §4.2 歧义由三态分派决策表明确收敛。