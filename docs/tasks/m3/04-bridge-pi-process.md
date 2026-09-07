---
prd: prds/m3-single-session.md
status: done
---
# 任务：bridge pi 子进程状态机 + session 目录扫描 + exited 语义

## 目标
按 [[prds/m3-single-session.md|M3 PRD §2.3 / §2.5 / §2.6 / §2.7]] 落地 bridge 端 pi 子进程管理：`PI_CODING_AGENT_DIR` 隔离目录 + session 目录扫描（最新文件判定）+ 5 相位状态机（spawning → ready → running → idle → exited）+ 启动握手（spawn → 忽略首组扩展 setStatus → 发 get_state → 响应即 ready）+ 5min idle kill（SIGTERM → 1s → SIGKILL）+ 自主 kill 标记机制（R1 修正：先置位再发信号；exit 回调三路径）+ 崩溃重启 + §2.7 exited 语义（spawn 触发集 / get_state 不 spawn / abort no-op）。

关键要点：

- **新增 `packages/bridge/src/pi-process.ts`**：单例 pi 子进程管理器（桥接 ADR-0003）：
  - 5 相位：`spawning` / `ready` / `running` / `idle` / `exited`（复用 `SESSION_PHASES` 字面量）
  - 内部状态：`phase` / `child: ChildProcess | null` / `selfKillFlag: boolean`（**先置位再发信号**，避免 exit 回调与信号之间的竞态）/ `idleTimer: NodeJS.Timeout | null` / `pendingExtensionUIs: Map<requestId, BlockedOnEntry>`（任务 05 详细实现）
  - 启动命令：`spawn('pi', ['--mode', 'rpc'], { env: { ...process.env, PI_CODING_AGENT_DIR: <isolationDir> }, stdio: ['pipe', 'pipe', 'pipe'] })`；stdio 用 `StringDecoder('utf8')` + 自管 `\n` 缓冲（**不**用 readline，roadmap §4.2 ⚠ 拆行保护）
  - 启动握手：spawn → 忽略 stdout 第一组 setStatus 事件流 → bridge 写 `get_state` 命令到 stdin → 等响应 `{ type: 'response', command: 'get_state', success: true, data: RpcSessionState }` → 标记 ready → 广播 `session_state{phase:'ready'}`
  - 状态机迁移（PRD §2.3 精确化）：
    - `exited → spawning`：spawn 触发集（prompt / steer / follow_up / get_messages）到达时（**延迟**到首任务触发，不预热）
    - `spawning → ready`：get_state 响应成功
    - `ready → running`：收到首个 prompt / steer / follow_up
    - `running → idle`：收到 `agent_settled` 事件 → 启动 5min 计时（代码常量 `IDLE_TIMEOUT_MS = 5 * 60_000`）
    - `running → running`：running 期间收新 prompt / steer / follow_up 不迁移（steer / follow_up 按 pi 语义处理）
    - `idle → exited`（**走自主 kill 标记路径**）：idle 超时 → `selfKillFlag = true`（先置位）→ `child.kill('SIGTERM')` → `setTimeout(1000, () => { if (still alive) child.kill('SIGKILL') })` → exit 回调查标记
    - `spawning / running → spawning`：exit ≠ 0 且 `!selfKillFlag`（崩溃重启；spawn 计数 +1）
    - `spawning / running → exited`：exit === 0 且 `!selfKillFlag`（stdin EOF 等合法关闭路径，不重启）
    - `idle / exited → exited`：标记在 + 任意 exit code（自主 kill 路径，不重启）
  - session 目录扫描（PRD §2.5）：路径 `<PI_CODING_AGENT_DIR>/sessions/--<cwd编码>--/<时间戳>_<uuid>.jsonl`；cwd 编码实现先 `encodeURIComponent(cwd).replace(/%/g, '')`，再用真实 pi 启动一次 + 落盘路径回归比对，不通过则不收尾
    - 扫描：`fs.readdirSync(<sessionSubdir>).filter(name => name.endsWith('.jsonl'))`
    - 最新判定：按文件名时间戳字典序（ISO = 时间序）；同时间戳多文件取 mtime 最新（`fs.statSync(mtimeMs)` 倒序取第一）
    - 候选 → spawn 时加 `--session <path>`；无候选 → spawn 不带 `--session`
  - exit 处理（PRD §2.6 完整规则）：标记在 → 清除标记 → exited（广播）→ 不重启；标记不在 + code !== 0 → 广播 exited → 立即 spawn 新子进程；标记不在 + code === 0 → 广播 exited → 不自动重启
  - §2.7 exited 语义：spawn 触发集 = prompt / steer / follow_up / get_messages（`get_messages` 走 pi RPC 必须有活进程——恢复仪式必触发带 `--session` 恢复的 spawn）；control `get_state` 永远由内存作答、永不 spawn；abort 在 exited 时为 no-op（`command_result{success: true}` 回执）
- **新增 `packages/bridge/src/pi-cwd-encoder.ts`**：`encodeCwdForPi(cwd)` 函数；与真实 pi 启动比对落盘路径一致（不通过则不收尾）
- **改 `packages/bridge/src/index.ts`**：start() 加载 config 后创建 `PiProcessManager` 实例（共享给 client.ts 处理 web 入站，任务 04 + 05 协同）
- **`PI_CODING_AGENT_DIR` = `<configDir>/pi-agent/`**（与配置文件同根）；bridge 启动时若 `<dir>/auth.json` 缺失 → stderr 提示用户跑 `pi login`（**不**自动登录）
- **bridge 不 import `@earendil-works/pi-coding-agent` 包**：用 `child_process.spawn('pi', ...)` 调外部二进制（任务 03 已删 peerDeps）

## 完成标准
- [x] `packages/bridge/src/pi-process.ts` 落地（**922 行**）：5 相位状态机 / 自管 stdin/stdout 缓冲（`StringDecoder('utf8')` + `indexOf('\n')`，规避 U+2028/U+2029 拆行）/ 启动握手（spawn → 忽略首组扩展 setStatus → 写 `get_state` → 等响应 → 标记 ready）/ idle 5min 计时（常量 `IDLE_TIMEOUT_MS`）/ 自主 kill 标记（先置位再发 SIGTERM→1s→SIGKILL；exit 回调三路径：标记在→不重启 / 标记不在+code≠0→重启 / 标记不在+code=0→不重启）/ 广播 session_state（每次相位迁移）/ auth.json 缺失 stderr 提示；**outstanding 命令表**（web 入站 id → 入站信封，reply_to 回显反查用）
- [x] `packages/bridge/src/pi-cwd-encoder.ts` 落地：`encodeCwdForPi(cwd)` 函数；先 `encodeURIComponent(cwd).replace(/%/g, '')`，与真实 pi 启动比对落盘路径留为**任务 08 回归项**（PRD §2.5 钉桩）
- [x] session 目录扫描：合法路径（ISO 时间戳字典序）+ 同时间戳 mtime 最新（`fs.statSync` mtimeMs 倒序）+ 空目录走 spawn 不带 `--session`；**文件名时间戳形态校验**作为 S 落地（Suggestion 6）
- [x] §2.7 exited 语义：spawn 触发集（prompt/steer/follow_up/get_messages）在 exited 时触发 spawn 计数 +1；control `get_state` 在 exited 时由内存回答不 spawn；abort 在 exited 时回 `command_result{success:true}` 不 spawn
- [x] bridge 与 pi 包零依赖：`grep -R "earendil-works" packages/bridge/` 零结果
- [x] `pnpm --filter @remotepi/bridge test` 全绿（bridge **41 → 87 条**，新增 46 条覆盖状态机迁移序列 / 自主 kill 三路径 / session 扫描多文件 / cwd 编码 / exited 触发集 / get_state 不 spawn / abort no-op / wire 修复回归 / onEnvelope 接线等；任务 05 集成测试清单仍在任务 05 单独追踪）
- [x] `pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿；工作区全量 **189 条**测试全绿
- [x] bridge 启动日志含 `PI_CODING_AGENT_DIR` 路径（`<configDir>/pi-agent/`）+ auth.json 状态提示（无 auth.json 时打 stderr warn 但不退出）；`index.ts` 组装：`PI_CODING_AGENT_DIR` 取自 configDir 同根、`BridgeClient` 接入 `onEnvelope` sink → `PiProcessManager` 处理 pi 入站 → 转发 web

## 依赖
- 依赖 [[tasks/m3/01-shared-protocol-v2.md|01-shared-protocol-v2]]（需要 session_state payload 含 phase / blocked_on 字段）
- 依赖 [[tasks/m3/03-bridge-config-file.md|03-bridge-config-file]]（config 提供 work_dir + 隔离目录路径）

## 完成情况
任务完成，commit `75fad56`。bridge pi 子进程管理全量落地：`pi-process.ts`（922 行，5 相位状态机 / 启动握手 / 5min idle kill SIGTERM→1s→SIGKILL / 自主 kill 标记 / exit 三路径 / session 扫描 / **outstanding 命令表**）+ `pi-cwd-encoder.ts` + `client.ts` 最小接线（onEnvelope sink）+ `index.ts` 组装（`PI_CODING_AGENT_DIR=<configDir>/pi-agent/`，auth.json 缺失 stderr 提示）。reviewer 通过，**无 Critical**；**7 项 Warning 全修**（含**两条 wire 硬伤**，详见下）+ **6 项 Suggestion 落地**（U+2028 断言加强 / onEnvelope+wiring 测试 / blocked_on 缺省断言 / WRITES-READS 常量 / 崩溃丢队警告 / 文件名时间戳形态校验）。bridge 测试 **41 → 87 条**（新增 46 条），工作区全量 **189 条全绿**。

### 两条 wire 语义硬伤（review 捕获并修复）

1. **`get_messages` 回执改走 `snapshot` envelope**：原实现误用 `command_result` 回执，不符合 PRD §1.5 / `pi.md` 定义的 `snapshot` 形状（`snapshot` 携带 `messages: Message[]`，是 web 端历史渲染的权威数据源）。修复后 `get_messages` 在 bridge 侧转发 `pi/get_messages` 给子进程 → 收到子进程 `snapshot` → 直接转发给 web 端（不经过 `command_result` 包装），与 [[prds/m3-single-session.md#§4.4 恢复仪式（双查询）|PRD §4.4 恢复仪式]] 一致。
2. **`reply_to` 改为回显 web 命令 id（outstanding 表反查）**：原实现为 `command_result + 随机 UUID` 的 `reply_to` 字段——这会**破坏任务 07 双查询恢复仪式**（web 端用 `reply_to === requestId` 把 `result` 绑回握手期发出的 `get_messages` / `get_state`；若 bridge 侧随机生成 UUID 替换回执 id，web 端的请求-回执配对完全对不上）。修复：bridge 在入站 web 信封时把 `id` 写入 `outstanding` 表（`Map<requestId, Envelope>`），子进程回执到达时反查原 web id，写回 `reply_to`。这是任务 04 与任务 07 之间的关键协议一致性钉子。

### 其他 Warning 修复（5 项）

- **idle timer 守门 `running`**：原 idle 计时器无条件启动——若 ready 阶段到来意外事件可能误触；改为仅在 `running → idle` 迁移时起 `setTimeout`，与 PRD §2.3 一致。
- **`ready` 阶段忽略 `agent_settled`**：PRD §2.3 状态机只定义 `running → idle`（`agent_settled` 是工作量收敛信号，`ready` 阶段尚无工作量，谈不上 idle）。裁定：ready 阶段收到 `agent_settled` 事件 → 静默忽略（不迁移、不起计时器），与 [[prds/m3-single-session.md#§2.3 pi 子进程状态机|PRD §2.3]] 字面一致。
- **`auth.json` 缺失提示切 stderr**：与 [[tasks/m3/03-bridge-config-file.md|tasks/03]] 行为变更同步——`logger.error` 走 stderr（运维按流分离）；无 auth.json 时打 stderr warn 但**不退出**，留给用户手动 `pi login`。
- **`since` 透传 + TODO(M+)**：web 端 `get_messages` 可携带 `since`（增量查询），当前 M3 不消费但透传不丢；留 TODO(M+) 待 M4 增量流恢复协议落地时启用。
- **`extension_ui_response` 桩 TODO(task 05)**：本任务只搭入站 plumbing（pi → bridge），web 入站 `extension_ui_response` 的翻译（`confirm value:false → confirmed:false` 等）留任务 05 落地。

### Suggestion 落地（6 项）

- U+2028/U+2029 拆行断言加强（`StringDecoder` + `indexOf('\n')` 路径的 monkey-patch 模拟）；
- `onEnvelope` + wiring 集成测试（验证 bridge 端三层装配：client.ts onEnvelope → pi-process.ts 入站 → worker 转发）；
- `blocked_on` 缺省断言（web wire refine 的 `cancelled: false + value 缺省` 走 refine 拒，确保不会漏翻译）；
- `WRITES-READS` 常量提取（区分"写操作触发 spawn"与"读操作永走内存"的命令集，避免 §2.7 语义散落）；
- 崩溃丢队警告（子进程非自主 kill 退出且 outstanding 表非空 → stderr 警告，告知用户提交未投递）；
- 文件名时间戳形态校验（session 扫描时拒绝非 ISO 时间戳前缀，避免误拾杂项文件）。

### 未在本任务收尾的项（移交）

- **`extension_ui_response` web 入站翻译**：弹窗回执 → pi 原生三态 → `command_result` 广播——留 [[tasks/m3/05-bridge-popup-core.md|tasks/05]] 落地。

### 勘误注记（2026-09-07）

**cwd 编码占位实现（`encodeURIComponent` 路线）已于 2026-09-07 实测否决并替换为 pi 真实算法转写**——任务书原文中"先 `encodeURIComponent(cwd).replace(/%/g,'')`，再用真实 pi 启动一次 + 落盘路径回归比对"那段推荐实现与 pi `session-manager.js` 的 `getDefaultSessionDirPath`（`path.resolve` → 去单开头分隔符 → `/` `\` `:` 映射为 `-`）不一致；占位实现编出 `--2Fhome2Fsankabox--`，pi 真实落盘 `--home-sankabox--`，bridge 扫描落空导致 idle 5min kill 后 spawn 均为新 session（用户实测：再对话接不回同一 session）。commit `cc00a3f` 落盘 3 行精确转写 + 测试翻转（旧断言钉的是错误形状）+ 地面真值回归（断言编码命中磁盘真实目录，宿主无该目录则跳过）；bridge 测试 269 → 281 全绿。**任务书原文 `encodeURIComponent` 推荐路线不再成立**。详见 [[prds/m3-single-session.md|M3 PRD]] 顶部 2026-09-07 修订注记 + [[current-state.md#最近变更|current-state 2026-09-07]] 条目。原"cwd 编码真实 pi 比对回归"挂账已由本轮实测完成比对、占位实现被否决而清账。
