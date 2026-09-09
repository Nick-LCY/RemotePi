---
prd: prds/m4-multi-session.md
status: done
---
# 任务：bridge BridgeSessionLayer 多 PiProcessManager Map 复数化（钉子 2 pending 键控 + 钉子 4 SPAWN_TIMEOUT_MS + 裁定 C ready 5min idle + 钉子 3 work_dir_remove 不 kill 活 manager）+ sessionKey 路由 + 真 pi 探针验证

## 目标
按 [[prds/m4-multi-session.md|PRD §1.5 + §2.3 + §2.4 + §2.6 + §2.7 + §9.2 + §9.3]] 实现 bridge 多会话管理核心：`BridgeSessionLayer`（新建 `packages/bridge/src/session-layer.ts`）持有 `Map<sessionKey, manager>`，sessionKey 用 pi session 文件名 stem（`<timestamp>_<uuid>`），pending 键控（钉子 2：`new:<work_dir>` 内部键），SPAWN_TIMEOUT_MS 60s（钉子 4），裁定 C ready 5min idle 回收，钉子 3 work_dir_remove 不 kill 活 manager，work_dir CRUD 命令完整落地（`work_dir_list` / `work_dir_add` / `work_dir_remove`），出入站路由全规则覆盖；**sessionKey 派生真 pi 探针验证**（实测验证点，凡未实测的落盘细节不可信）。

关键要点：

- **`BridgeSessionLayer`（新建 `packages/bridge/src/session-layer.ts`）**：
  ```ts
  class BridgeSessionLayer {
    private readonly managers = new Map<string, PiProcessManager>();
    // 键可能是 (a) 真实 sessionKey stem（已派生）或 (b) 'new:<work_dir>' pending 内部键
    // map 键迁移见 §1.5，迁移完成前 pending 键与真实 stem 不会共存
    private readonly workDirs: string[]; // 内存中，state.json 镜像（04-bridge-state-json 已就绪）
    handleEnvelope(env: Envelope): void { ... } // 入站路由
    listAllSessions(workDir: string): SessionListEntry[] { ... }
    listWorkDirs(): string[];
    addWorkDir(path: string): void;
    removeWorkDir(path: string): void; // 钉子 3：不 kill 活 manager
  }
  ```
- **构造参数**（从 BridgeConfig + state.json 派生）：
  - `agentDir`：沿用 `resolvePiAgentDir()`（M3 §2.5）
  - `idleTimeoutMs`：沿用 `IDLE_TIMEOUT_MS = 5 * 60_000`（M3 §2.3，每 manager 独立计时，**逐会话复制**）。**裁定 C 扩展**：ready 相位无任何写命令（prompt / steer / follow_up 等）也按 idle 路径倒计时（M3 §2.3 状态机仅 `running → idle` 起计时，裁定 C 补加 `ready → idle` 计时迁移）
  - `sigkillDelayMs`：沿用 `SIGKILL_DELAY_MS = 1000`（M3 §2.3）
  - `spawnTimeoutMs`：**新增** `SPAWN_TIMEOUT_MS = 60_000`（钉子 4）——spawning 相位超 60s 未完成握手 → 复用 PiProcessManager 既有自主 kill 标记路径 → exited 广播；同时 `BridgeSessionLayer` 同步 `managers.delete(<map键>)`（含 pending `new:<work_dir>` 键）
  - `onOutbound`：bridge client 的 broadcast 回调
  - `onStderr`：bridge 自己的 logger
- **sessionKey 计算规则**（PRD §1.5）：
  - 复用 M3 `encodeCwdForPi(cwd)` + `sessionSubdir(agentDir, cwd)` + `findLatestSession(subdir)`（详见 `packages/bridge/src/pi-cwd-encoder.ts`）
  - 已知会话：web 命令带 `session: <stem>` → bridge 在 map 里查找 → 命中复用，未命中则按 session 路径 spawn 新 manager（cwd = 该 session 所属 work_dir，`--session` = 该 stem 的 jsonl 路径）
  - **pending 键控（钉子 2）**：bridge 收到 `session:'new'` + `payload.work_dir` → 内部键 `new:<work_dir>`；先查 `managers.has('new:' + work_dir)` —— 命中复用（短时多次 new 请求合并为同一 pending），未命中则 spawn 新 manager（cwd = work_dir，**不带** `--session` 让 pi 自己开新 jsonl 文件）
  - manager 启动后：spawning 相位启动 SPAWN_TIMEOUT_MS 兜底；收到首个 `entry_appended` 或 ready 后第一次 message_start → 从 stdout / `--session-dir` 派生 stem → bridge 自行将 map 键迁移到真实 stem（`managers.delete('new:' + work_dir); managers.set(stem, manager)`） → 广播 `session_state{session: <stem>}`（web 收到后回填 hash `&session=<stem>`）
  - 钉子 2 边界：若 `session:'new'` 但 payload 缺 `work_dir` → 拒，回 `result.ok = false` + `error.code: 'invalid_envelope'`（M4 操作惯例下必带，缺省视为协议错）
- **`work_dir` CRUD**（PRD §2.6）：
  - `work_dir_list`：`result.ok = true, data = { work_dirs: [...] }`（内存中快照）
  - `work_dir_add`：参数 `path: string` → 规范化 → 校验（存在 + 是目录 + 可读，与 M3 §2.1 同三件套）→ 内存 push → 同步写 state.json → 回执；重复添加 = 幂等（已存在则 no-op，回 `ok: true`）
  - `work_dir_remove`：参数 `path: string` → 内存 filter → 同步写 state.json → 回执；**钉子 3**：不清理 agent dir 会话文件（用户可能想保留以备再用），仅从清单移除；**不 kill 不打断**活 manager（cwd = 该 work_dir）—— 跑完 idle 自然回收（裁定 C 下 ready 5min 也计入）；目录从清单移除后 web ChoicePage level=2 不再列该 work_dir 下的会话（level2 不可达），但已在 ChatView 看的会话不受影响
  - **写入失败处理**：写 state.json 失败 → 回滚内存（remove 重新 push / add 重新 pop）→ log error → `result.ok = false` + `error.code: 'internal'`
  - **`StateError` 捕获义务（任务 [[tasks/m4/04-bridge-state-json.md|04]] S2 移交）**：control `work_dir_list` / `work_dir_add` / `work_dir_remove` 命令接线时，`WorkDirStore.add` / `remove` / `list` 抛出的 `StateError`（`code: 'parse_failed' | 'invalid_state'`）必须捕获并映射为 `result.ok = false` + `error.code: 'internal'` + 人类可读 `error.message`（沿用 [[architecture/protocol/control.md#8-error|control.md §8]] 既有 6 code 集合，不新增；PRD §2.1 原文"用 internal 兜底"）。注意范围超出原子写失败——三件套校验拒、load 阶段 schema 拒、strict 未知键拒都走此路径；统一一个 try/catch 映射点足够（无需按 StateError.code 分支）。**实施期钉桩**：在 BridgeSessionLayer 处理这三条命令的分支顶部 `try { ... } catch (err) { if (err instanceof StateError) return { ok: false, error: { code: 'internal', message: err.message } }; throw err; }`。测试：注入 mock `WorkDirStore` 抛 `StateError` → 断言 result 回执 `error.code === 'internal'` + message 透传原 StateError.message
  - **`list_directories` handler 迁移 + 接线测试随迁义务（任务 [[tasks/m4/05-bridge-list-directories.md|05]] S1 移交）**：把 `control/list_directories` 从 `pi-process.ts` `handleEnvelope` 临时宿主迁入 `BridgeSessionLayer`（与 `work_dir_*` + `session_list` 一并接管；任务 05 已把 `list_directories` 接线暂放在 `pi-process.ts` 并标注迁移 TODO）时，`__tests__/list-directories.test.ts` 的 **15a-15e 五条接线测试**（dispatcher 接到 envelope → 调 `listDirectories` → 映射 → 组装 `result` 回 web envelope 形状 / 不触发 spawn / session 字段透传 / 失败回执 envelope 形状 / message 透传）应**随 handler 一起迁移到 session-layer 测试**（如 `__tests__/session-layer-list-directories.test.ts` 或并入 `session-layer.test.ts` 的 list_directories 段），避免删 `pi-process.ts` 的 `handleListDirectories` 分支后这五项测试因 mock target 失效而误报。**纯函数模块 `list-directories.ts` 不动**，pure-function 测试（约 24 条 happy-path / 错误码 / dotfile / 排序 / 规范化等）继续在 `__tests__/list-directories.test.ts`。控制.md §6.6 已由任务 05 review 修复轮 W1 落档到位，本任务不重写 §6.6；任务 [[tasks/m4/09-docs-sync.md|09 docs-sync]] 校对"控制.md §6.6 与 PRD §2.5 表述差异"作为破锁依据引用即可
- **出入站路由全规则**（PRD §2.7）：
  - **入站（web → bridge）**：BridgeClient 现有 `onEnvelope` 回调 → BridgeSessionLayer.handleEnvelope → 按 env.session 字段路由
    - `session: <stem>`（非 'new'）+ map 命中 → manager.handleEnvelope
    - `session: <stem>`（非 'new'）+ map 未命中 → 查找 sessionKey 对应 jsonl 路径 → 新建 PiProcessManager 注册到 map → 转发
    - `session: 'new'` + 必带 `payload.work_dir` → pending 键控（钉子 2）
    - `session: 'new'` + 缺 `work_dir` → 拒 + `invalid_envelope`
    - 无 session + map 1 个 manager（M3 兼容）→ 转发
    - 无 session + map > 1 个 manager（M4 多 manager 后歧义）→ 报错 `invalid_envelope`
  - control `list_directories` / `work_dir_*` / `session_list` / `get_state` → BridgeSessionLayer 自身处理（不经 manager）；`session_list` 必带 work_dir 路由到 `listAllSessions(workDir)`（裁定 A）
  - **出站（bridge → web）**：每个 manager 的 onOutbound 经 BridgeSessionLayer 广播给所有 web 连接（沿用 M3 bridge client 广播机制；filter 由 web 端做）
- **每 manager 各 broadcast session_state**（PRD §1.6）：每个 manager 的 phase 迁移时各广播一次（各自带 session 字段），web 收 N 个 session_state 按 session 分桶更新
- **`session_list` 回执 status 字段**（PRD §1.3）：返回字段含 `status` 简化映射（`exited` / `idle` / `running` / `spawning` / `unknown`）；`unknown` = 未在 bridge 内存中（无活跃 manager，可能从未被该 bridge 看过）
- **`listAllSessions(workDir)`**（PRD §2.4）：裁定 A 下全量扫描弱化为按目录扫描——调用方必传 work_dir（web ChoicePage level=2 查询即"目录下的会话"）；沿用 M3 §2.5 `sessionSubdir(agentDir, workDir)` + `readdirSync` → 列出 `<timestamp>_<uuid>.jsonl` 文件名 → 派生 sessionKey
- **sessionKey 派生真 pi 探针验证**（PRD §1.5 实测验证点）：实施期跑真 pi 探针（沿用 [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]] 假 LLM 套件 helper）确认事件时序与 stem 派生点（推荐候选：收到首个 `entry_appended` 事件时扫 agent dir 找最新 jsonl；或 `--session-dir` 显式注入让 pi 立刻创建文件）；**凡未实测的落盘细节不可信**

## 完成标准
- [ ] `packages/bridge/src/session-layer.ts` 新建：`BridgeSessionLayer` 类（含 `managers: Map` + `workDirs: string[]` + `handleEnvelope` + `listAllSessions` + `listWorkDirs` + `addWorkDir` + `removeWorkDir`）
- [ ] sessionKey 派生真 pi 探针验证（PRD §1.5）：跑真 pi 两次确认 stem 派生点——实施期记录"派生时机：<实测结论>"到任务评审纪要
- [ ] **钉子 2**：pending 键控（`new:<work_dir>` 内部键）+ 同 work_dir 短时多次 `session:'new'` 合并 + pending → 真实 stem 迁移（map 键迁移 + 广播 `session_state{session:<stem>}`）
- [ ] **钉子 4**：`SPAWN_TIMEOUT_MS = 60_000` 接入 PiProcessManager spawning 相位；超 60s 触发自主 kill 标记路径（先置位再发 SIGTERM→1s→SIGKILL）→ exited 广播；同时 BridgeSessionLayer 同步 `managers.delete(<map键>)`（含 pending `new:<work_dir>` 键）
- [ ] **裁定 C**：ready 相位无写命令（prompt / steer / follow_up 等）5min 后按 idle 路径倒计时（同 running → idle 同一计时器逻辑复用）；spawning / blocked_on 显式忙碌相位豁免；ready 期间收到写命令 → 重置计时器
- [ ] **钉子 3**：`work_dir_remove` 不 kill 不打断活 manager（cwd = 该 work_dir）；自然 idle 回收（裁定 C ready 5min 也计入）；目录移除后 `session_list` 不再列该目录入口（web UI 层面不可达）
- [ ] `work_dir_list` / `work_dir_add` / `work_dir_remove` 命令处理完整落地（payload 校验 → 内存操作 → 同步写 state.json → 错误码独立）
- [ ] `BridgeSessionLayer.handleEnvelope` 路由规则 6 类全覆盖：有 session + 命中 / 有 session + 未命中 / session:'new' + work_dir / session:'new' 缺 work_dir / 无 session + map 1 / 无 session + map > 1
- [ ] `session_list` 按 work_dir 扫描 + `status` 字段映射（manager.phase / 'unknown'）；裁定 A 下接口签名必填 work_dir
- [ ] 跨 manager 广播隔离：A manager 出站不污染 B manager 的 web 视图（每个 manager 各 broadcast 自己的 session_state）
- [ ] 测试（PRD §9.2 + §9.3）：钉子 2 pending 键控 / 钉子 4 SPAWN_TIMEOUT_MS / 裁定 C ready idle / 钉子 3 work_dir_remove / work_dir CRUD / BridgeSessionLayer 路由 6 类 / listAllSessions 按 work_dir / 跨 manager 广播隔离 / pending → stem 迁移端到端 / **sessionKey 派生真 pi 探针**（≥ 30 条）
- [ ] bridge 测试基线（M3 终态 281 条）+ M4 新增 ≥ 30 条全绿
- [ ] `pnpm --filter @remotepi/bridge build` / `pnpm --filter @remotepi/bridge typecheck` / `pnpm --filter @remotepi/bridge test` 全绿
- [ ] `pnpm test:integration`（沿用 ADR-0008 假 LLM 套件）全绿——`tests/integration/` 既有 30 条零回归 + M4 新增端到端用例

## 依赖
- 依赖 [[tasks/m4/02-shared-protocol-v3.md|02-shared-protocol-v3]]（协议层 4 新 type + envelope (a) 字段已落）
- 依赖 [[tasks/m4/03-shared-tests.md|03-shared-tests]]（schema 消费前置）
- 依赖 [[tasks/m4/04-bridge-state-json.md|04-bridge-state-json]]（state.json 持久化）
- 依赖 [[tasks/m4/05-bridge-list-directories.md|05-bridge-list-directories]]（目录浏览命令处理）

## 参考
- [[prds/m4-multi-session.md|PRD §1.5 sessionKey 计算规则 + pending 键控]]
- [[prds/m4-multi-session.md|PRD §2.3 PiProcessManager 复数化]]
- [[prds/m4-multi-session.md|PRD §2.4 会话扫描按 work_dir]]
- [[prds/m4-multi-session.md|PRD §2.6 work_dir CRUD]]
- [[prds/m4-multi-session.md|PRD §2.7 出入站路由]]
- [[prds/m4-multi-session.md|PRD §9.2 bridge 测试 + §9.3 integration]]
- [[tasks/m3/04-bridge-pi-process.md|tasks/m3/04]] PiProcessManager 5 相位状态机 + 自主 kill 标记路径基线
- [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]] 假 LLM 套件 + 真 pi 集成测试基建

## 完成情况

任务完成，5 笔本地 commit：**`5276d1a`**（真 pi 探针：sessionKey 派生时机实测结论前置验证）+ **`bd8b49f`**（BridgeSessionLayer Map 复数化实现全集）+ **`eba60c2`**（32 单测 + 2 集成——session-layer 路由 / 钉子 / 裁定端到端）+ **`a19acc6`**（M3-compat auto-spawn + get_state session-less 路由回归修复）+ **`8200068`**（review 修复轮——C1 ready→idle 直接测试 / C2 m3-legacy 契约文档化 / 迁移去双播 / wrapper 注入语义钉桩 / 编码碰撞首匹配语义 JSDoc / 探针产物转发现记录 / web 485 全绿）。reviewer 初审结论 **2 Critical / 7 Warning / 9 Suggestion**——**全部处置**（S15/S17/S18 三项合理跳过）。测试基线 **单测 446 → 485** / **集成 30 → 32** / **e2e 3 场景全绿**；typecheck / lint / build 全绿；web build 236.38 KB 零增长。

### 探针实测结论（pi 0.85.1，commit `5276d1a`）—— 任务 06 前置验证

**任务 PRD §1.5「实测验证点」落地**——实施期跑真 pi 探针（沿用 [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]] 假 LLM 套件 helper）确认事件时序与 stem 派生点。**探针产物已从 `probe-result.json` 转 `tests/integration/probes/PROBE-SESSIONKEY-RESULT.md` 发现记录**（避免 git 跟踪二进制制品，pin 住 pi 版本 0.85.1 + 复跑命令 `pnpm tsx tests/integration/probes/sessionkey-probe.ts`；详见 commit `8200068` W7）。**实测结论三条**：

1. **`agent_start` 是 session jsonl 文件同步出现的可靠信号**——pi 0.85.1 在 `agent_start` 触发的同帧/微秒内创建 `<agentDir>/sessions/--<encodedWorkDir>--/<timestamp>_<uuid>.jsonl`。bridge 实现采用「`agent_start` 事件触发 + agent_dir 扫描」双保险策略（fast-path：消费 `agent_start.sessionFile` 字段；fallback：扫 agent_dir）。
2. **`entry_appended` 事件在 pi 0.85.1 wire 上不存在**——探针脚本中 `firstEntryAppended` 字段始终为 `null`（pi 走裸 `message_update`/`message_end` 流而非 entry 序列化）。**PRD §1.5 候选信号（首个 `entry_appended` 或 ready 后第一次 `message_start`）不适用**——实施期实测后派生点改写为「首个非 handshake stdout 事件 + agent_dir 扫描」。「`pi/prompt.payload.work_dir` 仅 `session:'new'` 携带」裁定 A 方案 A 的 PRD 假设沿用，web 端契约不变。
3. **`sessionFile` 字段在 `agent_start` 帧内携带**（绝对路径）——可作为 fast-path 直接消费；bridge 当前实现走 agent_dir 扫描 fallback（更通用，应对未来 pi 版本不再携带该字段），`sessionFile` 字段留作 M+ 优化候选。

**附带时序数据**（原始数据嵌入 `tests/integration/probes/PROBE-SESSIONKEY-RESULT.md`）：withFlag（带 `--session`）jsonl 在 spawn 时已存在（spawnedAt 53ms 即预创建）；withoutFlag（无 `--session`）jsonl 在 `agent_start` 后 ~52ms 落盘（spawnedAt 2ms → agentStartAt 8005ms → sessionFileFirstSeen 8057ms）。**两种 spawn 模式下 jsonl 出现时机不同，桥端必须能处理两种时序**——否则恢复路径会因等待不可能到来的 `agent_start` 而误路由。

### `bd8b49f` BridgeSessionLayer 实现（任务主体）

`packages/bridge/src/session-layer.ts` 新建——`BridgeSessionLayer` 类全集：

- **Map 复数化**——`private readonly managers = new Map<string, PiProcessManager>()`；键可能是 (a) 真实 sessionKey stem（已派生）或 (b) `'new:<work_dir>'` pending 内部键（钉子 2）；map 键迁移见 §入站路由，迁移完成前 pending 键与真实 stem 不会共存。
- **入站路由 6 类全覆盖**（PRD §2.7）——`handleEnvelope(env)` 按 `env.session` 字段路由：
  1. `session: <stem>`（非 'new'）+ map 命中（含已迁移的真实 stem）→ 转发到该 manager。
  2. `session: <stem>`（非 'new'）+ map 未命中 → 查找 sessionKey 对应 jsonl 路径 + 新建 `PiProcessManager` 注册到 map（键 = stem）+ 转发。
  3. `session: 'new'` + 必带 `payload.work_dir` → 钉子 2 pending 键控（见下）。
  4. `session: 'new'` + 缺 `work_dir` → 拒，回 `result.ok = false` + `error.code: 'invalid_envelope'`（M4 操作惯例下必带，缺省视为协议错）。
  5. 无 session + map 1 个 manager（M3 兼容）→ 转发到该 manager。
  6. 无 session + map > 1 个 manager（M4 多 manager 后歧义）→ 报错 `error.code: 'invalid_envelope'`。
- **钉子 2 pending 键控**——`session:'new'` 按 work_dir 键控（`new:<work_dir>` 内部键）；先查 `managers.has('new:' + work_dir)` —— 命中复用（短时多次 new 请求合并为同一 pending），未命中新建 manager（cwd = work_dir，**不带** `--session`，让 pi 自己开新 jsonl 文件）；manager 启动后，spawning 相位启动 `SPAWN_TIMEOUT_MS` 兜底；收到首个非 handshake stdout 事件（即探针实测的 `agent_start`）→ 从 stdout / agent_dir 派生 stem → bridge 自行将 map 键迁移到真实 stem（**W3 修复轮去双播**：`{migrated, broadcastedPhase}` 二元组保证迁移与 phase 广播原子化，避免期间被命令误路由）→ 广播 `session_state{session: <stem>}`。
- **control 自答**——`BridgeSessionLayer.handleEnvelope` 自身处理 control 命令（不经 manager）：
  - **`list_directories`** —— 由 [[tasks/m4/05-bridge-list-directories.md|任务 05]] 临时宿主迁入（`handleListDirectories` 移至 session-layer.ts）；**15a-15e 接线测试随迁**（S1 移交义务落地：`__tests__/list-directories.test.ts` 的 5 条 dispatcher 接线测试并入 `__tests__/session-layer.test.ts` 的 list_directories 段，避免删 `pi-process.ts` 分支后 mock target 失效误报）；纯函数模块 `list-directories.ts` 不动。
  - **`work_dir_list` / `work_dir_add` / `work_dir_remove`** —— 接 `WorkDirStore`（[[tasks/m4/04-bridge-state-json.md|任务 04]] seam）；**S2 移交义务落地**：try/catch 包裹 `StateError` 捕获 → 映射 `result.error.code: 'internal'` + message 透传原 `StateError.message`（沿用 control.md §8 既有 6 code 集合不新增）。
  - **`session_list`** —— 按 `payload.work_dir`（裁定 A 操作惯例必带）路由到 `listAllSessions(workDir)`；status 字段映射 manager.phase（`exited` / `idle` / `running` / `spawning` / `unknown` 5 枚举）。**unknown = 未在 bridge 内存中**（无活跃 manager，可能从未被该 bridge 看过，会话被外部 pi 占用时也返回 unknown，**不做检测**对齐业务共识 3）。
  - **`get_state`** —— M3 兼容路径下 session-less 命令无 manager 时按 `defaultWorkDir` auto-spawn 一个 `M3_LEGACY_KEY` 键 manager；sessionful 路径回退到 manager 状态机。
- **钉子 2 三步原子迁移**（review W3 修复轮）——`attemptPendingMigration` 在每个 `pi/event` 上尝试迁移，首次成功即 agent_start（探针实测）；**去双播**：`{migrated: boolean, broadcastedPhase: boolean}` 二元组保证 map 键迁移 + `session_state` 广播在一次调用内完成，期间不会被其他命令误路由。
- **钉子 4 SPAWN_TIMEOUT_MS 60_000 watchdog**——`spawnTimeoutMs` 构造参数（默认 60_000）传入每个 manager；spawning 相位超 60s 未完成握手 → 复用 PiProcessManager 既有自主 kill 标记路径（先置位再发 SIGTERM→1s→SIGKILL；exit 回调走「标记在→不重启」）→ exited 广播；BridgeSessionLayer 同步 `managers.delete(<map键>)`（含 pending `new:<work_dir>` 键同步 delete）。**arm 时机**：在 `writeHandshakeGetState` 处 arm（spawn 后立即同步写 handshake get_state 时启动 watchdog，与 spawn 起步对齐，避免冷启动阶段就计时）；**清理时机**：completeHandshake / forceExited / handleExit / stop 四路径统一清理（避免 watchdog 误触发自主 kill）。
- **裁定 C startReadyIdleTimer**——ready 相位无任何写命令（prompt / steer / follow_up 等）5min 后按 idle 路径倒计时（同 running → idle 同一计时器逻辑复用 `IDLE_TIMEOUT_MS = 5 * 60_000`）；spawning / blocked_on 显式忙碌相位豁免；ready 期间收到写命令 → 重置计时器；manager 构造参数 `idleTimeoutMs` 默认 5*60_000，**逐 manager 独立计时**。

### `eba60c2` 测试（**+32 单测 / +2 集成**）

- **32 单测** (`__tests__/session-layer.test.ts` 新建)：
  - **入站路由 6 类**——`session + 命中 / 未命中 / 'new' + work_dir / 'new' 缺 work_dir / 无 session + map 1 / 无 session + map > 1`，6 条 + 各分支边界共 8 条。
  - **钉子 2 pending 键控**——同 work_dir 短时多次 `session:'new'` 合并（同一 map 键命中复用）/ 不同 work_dir `session:'new'` 各 spawn（多键并存）/ pending → 真实 stem 迁移（map 键迁移 + `session_state` 广播）/ `session:'new'` 缺 `work_dir` 拒 invalid_envelope，4 条。
  - **钉子 4 SPAWN_TIMEOUT_MS**——mock spawning > 60s 未握手 → 自主 kill + exited 广播 + map 键清理（含 pending `new:<work_dir>` 键）；spawning < 60s 内完成 → 不触发超时，正常 ready，2 条。
  - **裁定 C ready 5min idle**——ready → 5min 无写命令 → idle 回收路径（同 running → idle 复用计时器）；ready 期间收到 prompt/steer/follow_up → 重置计时器；spawning/blocked_on 显式忙碌相位豁免，3 条。
  - **钉子 3 work_dir_remove 活 manager**——work_dir_remove 不 kill 不打断活 manager，cwd = 该 work_dir；自然 idle 回收（裁定 C ready 5min 也计入）；目录移除后 `session_list` 不再列该目录入口，3 条。
  - **work_dir CRUD**——add / remove / list / 重复添加幂等 / 写入失败回滚 / `StateError` 映射 `internal`，6 条。
  - **`session_list` 按 work_dir 扫描 + status 5 枚举映射**——manager.phase 映射 / `'unknown'`（无活跃 manager）/ 非法 status 拒，4 条。
  - **跨 manager 广播隔离**——A manager 出站不污染 B manager 的 web 视图（每个 manager 各 broadcast 自己的 session_state），2 条。
- **2 集成**（`tests/integration/` 沿用 ADR-0008 假 LLM 套件 helper）：
  - **pending → stem 迁移端到端**——fake LLM + session:'new' + work_dir → bridge pending 键 manager spawn → fake LLM 模拟 pi stdout 输出首个 agent_start → bridge 派生 stem → map 键迁移 + `session_state{session:<stem>}` 广播 + 后续同 session_id 命令命中真实 stem 键。
  - **多 work_dir 并行**——fake LLM + 2 个 work_dir + 各自 prompt → 各自 ready → `session_list` 各 work_dir 隔离扫描 + status 字段独立。

### `a19acc6` 实施期发现的 M3-compat 回归修复

**根因**：e2e 3 场景（ADR-0009 MVP 三场景）的 M3 token-only URL（`#<token>` 无 work_dir / session）回放时，session-less `get_state` / `get_messages` 命令被误判「map 为空 + 无 work_dir」路由而拒绝；e2e 场景依赖 M3 单会话行为。**修复**：新增 `M3_LEGACY_KEY = 'm3-legacy'` map 键 + `defaultWorkDir` 构造参数（index.ts 接 `config.work_dir`）→ session-less 命令无 manager 时按 `defaultWorkDir` auto-spawn 一个 M3-compat manager；sessionful 路径回退到正常路由。**`M3_LEGACY_KEY` 出站 wrapper**——pending `m3-legacy` 键 manager 派生 stem 前不会触发 map 键迁移（`m3-legacy` 是固定键），其 `session_state` 广播携带 `session: 'm3-legacy'`（web 端按 session 分桶时该桶无消费者——M3-compat 路径仅保留 M3 token-only URL 兼容语义）。**新增导出 `BridgeSessionLayer.M3_LEGACY_KEY` 常量 + `defaultWorkDir` 选项 + JSDoc 互引**（review C2 文档化），见下方「过渡性设计」段。

### `8200068` review 修复轮（**2C / 7W / 9S 全部处置**，S15/S17/S18 合理跳过）

- **C1** ready→idle 直接测试补充——原测试 3.1 名不副实走 `running → idle`（裁定 C 是 `ready → idle`）；补 ready 相位无写命令 5min 后判 idle 路径的三条直接测试 + 写命令重置计时器两条 + spawning/blocked_on 豁免两条，**3.1 名实相符**。
- **C2** **方案 a**——**`M3_LEGACY_KEY` 导出常量 + 过渡性设计 JSDoc + 已知限制 order-dependent**；三处加 JSDoc 互引：`M3_LEGACY_KEY` 常量块（导出 + 三个使用点解释）/ `BridgeSessionLayerOptions.defaultWorkDir` 字段块（用户面 knob）/ `makeOutboundWrapper` outbound 注释（出站 `session: 'm3-legacy'` 标记语义）；并通过 `export const M3_LEGACY_KEY = 'm3-legacy'` 让 `index.ts` 可消费同一 key 避免字面量漂移。**known limitation**：当 explicit session manager 与 M3-legacy manager 共存时，session-less 命令按插入序路由到任一 manager（order-dependent），M4 不修，**任务 08 落地后该路径退役**。
- **W3** 迁移去双播——`attemptPendingMigration` 返回 `{migrated, broadcastedPhase}` 二元组，保证 map 键迁移 + `session_state` 广播在一次调用内完成，避免「删除旧键 → 期间被新命令查 → 找不到 → 重建失败 → 设置新键」窗口被误路由。
- **W4** wrapper 注入语义钉桩——`makeOutboundWrapper(holder, manager)` 二参构造 + 钉 `holder.current` 是唯一真相源（每个 outbound envelope 读 holder.current 一次，不缓存）；原单参版本会被 manager phase 广播把 `holder.current` 隐式改写，**注入语义修正**让 phase 迁移事件不会污染出站 wrapper。
- **W5** 编码碰撞首匹配语义 JSDoc + 双钉桩——`sessionSubdir` 多 work_dir 共享编码名（如 `/mnt/a/x` 与 `/mnt/b/x` 编码后可能冲突）的「首匹配」语义显式声明（fs.readdirSync 自然顺序）；helper 与 `attemptPendingMigration` 双钉桩；测试补碰撞用例两条验证首匹配行为。
- **W7** 探针产物转发现记录——`tests/integration/probes/probe-result.json`（git 跟踪二进制制品）转 `tests/integration/probes/PROBE-SESSIONKEY-RESULT.md`（人类可读 + 探针脚本写 `.tmp/` 而非 git 跟踪路径），pin 住 pi 版本 0.85.1 + 复跑命令 + 升级体检比对清单；`.gitignore` 加 `tests/integration/probes/.tmp/`。
- **W8** web 485 全绿 + build 236.38 KB 零增长——e2e 3 场景全绿（`pnpm test:e2e`）；web build 0 字节增长（M4 任务 06 仅 bridge 侧，web 侧任务 07/08 增量）；`pnpm run typecheck` / `pnpm run lint` / `pnpm run build` 全绿。
- **S11** 探针脚本 stdout/stderr 净化——避免测试输出污染。
- **S12** session-layer.test.ts `describe` 命名统一（入站路由 6 / 钉子 2 / 钉子 4 / 裁定 C / 钉子 3 / work_dir CRUD / session_list / 跨 manager 广播 八组）。
- **S13** `Map.values().next().value` 注释明确「非确定性插入序」+ 测试钉桩（任务 06 不修，M4 不允 session-less 命令有多 manager 歧义，到 reject 路径走 `invalid_envelope`）。
- **S14** M3_LEGACY_KEY 路径集成测试补——fake LLM + `#<token>` token-only URL → bridge auto-spawn `m3-legacy` 键 manager → session_state 携带 `session: 'm3-legacy'` 出站 + sessionful 命令走 normal manager 互不干扰。
- **S16** `migration_completed` 单测补——map 键迁移完成后新 `session:'new'` + 同 work_dir 命令应创建**新** pending 键而非复用已迁移的 stem 键（防 migration 副作用把 pending 状态「冻结」成 stem）。
- **S15/S17/S18 合理跳过**——S15 e2e 不动（含 web 行为，仅依赖 M3 token-only URL 兼容存在）；S17 探针 helper 不拆（`sessionkey-probe.ts` 单一职责，不为单测重构）；S18 e2e 模拟层不引入（e2e 沿用 ADR-0009 既有 3 场景不扩张）。

### 5 项边界决策要点

1. **Map 键迁移原子化**（W3 修复）——`attemptPendingMigration` 在收到首个 `agent_start` 事件时一次完成 `delete('new:<work_dir>') + set(stem, manager) + broadcast session_state(session: stem)` 三步，**返回 `{migrated, broadcastedPhase}` 二元组**让上层（`onOutbound` sink）可以幂等地过滤「重复 broadcastedPhase」事件（W3 教训：原实现删键与广播分离被中间命令误路由）。
2. **`m3-legacy` 键 manager 不参与 pending 迁移**——`M3_LEGACY_KEY` 是固定 map 键（无 work_dir 派生语义），其 manager spawn 后不会走 `attemptPendingMigration`（无 pending 状态可迁移）；`session_state` 广播携带 `session: 'm3-legacy'` 让 web 端按 session 分桶时该桶无消费者；M3 兼容路径仅服务于 M3 token-only URL（`#<token>` 无 work_dir / session），**M4 正常 web 流程不得依赖**——web 任务 08 落地后该路径退役。
3. **SPAWN_TIMEOUT_MS 四路径清理**——watchdog arm 在 `writeHandshakeGetState` 处（spawn 后立即同步写 handshake get_state 时启动 watchdog）；清理在 `completeHandshake` / `forceExited` / `handleExit` / `stop` 四路径统一清理（避免 watchdog 误触发自主 kill）。manager 复用既有自主 kill 标记路径（不引入新 kill 模式），BridgeSessionLayer 在 `forceExited` 回调处同步 `managers.delete(<map键>)` 清理 pending 键。
4. **`defaultWorkDir` 是用户面 knob，`M3_LEGACY_KEY` 是内部 sentinel**——前者由 index.ts 注入（来自 config.work_dir，M3 兼容），后者由 BridgeSessionLayer 内部持有（map 键字面量）。两者协同启用/禁用 M3-compat auto-spawn 路径，**任务 08 落地后两个一起退役**。
5. **work_dir CRUD 错误码统一 `internal`**（任务 04 S2 移交义务落地）——`StateError`（`parse_failed` / `invalid_state`）经 try/catch 映射为 `result.error.code: 'internal'` + message 透传原 message；沿用 control.md §8 既有 6 code 集合不新增；测试钉桩注入 mock `WorkDirStore` 抛 `StateError` → 断言回执 shape。

### C2 移交义务（任务 [[tasks/m4/08-web-multi-session-store.md|08]] 接收）

**m3-legacy 路径退役条件**——任务 08 落地后评估 M3-compat auto-spawn 是否退役：
- **web 端强制 envelope `session` 字段**——任务 08 落地后，web M4 流程的所有 pi 命令与 get_state **必须携带 session 字段**。`M3_LEGACY_KEY` 兼容路径仅为 M3 token-only URL（`#<token>` 无 work_dir / session）存在；`m3-legacy` 键 manager 的 session_state 广播会带 `session:'m3-legacy'`，web 按 session 分桶时该桶无消费者——**M4 正常流程不得依赖 session-less 命令**。
- **退役评估点**——任务 08 完成后：① 检查 `M3_LEGACY_KEY` map 键 manager 是否仍存在（M3 token-only URL 仅 E2E 3 场景用）；② 若 E2E 已迁移到带 session 字段 → 删除 `BridgeSessionLayer.M3_LEGACY_KEY` / `resolveM3CompatManager` / `defaultWorkDir` 三处代码（JSDoc 已加互引方便移除）；③ 同步更新 [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]] §影响段 + [[prds/m4-multi-session.md|PRD §修订注记]]（2026-09-08 任务 06 实施修订 2026-09-08 任务 08 退役评估）。
- **过渡性设计 JSDoc 互引**——`BridgeSessionLayer.M3_LEGACY_KEY` / `resolveM3CompatManager` / `defaultWorkDir` 三处 JSDoc 已加互引注释（commit `8200068` C2），每个 call site 都能看到「这是过渡性设计，任务 08 退役」提示。
- **e2e 迁移路径**——E2E 3 场景（沿用 ADR-0009 MVP）当前依赖 `#<token>` token-only URL 触发 M3-compat 路径；任务 08 完成后应迁移到 `session` 字段显式带值（task 10 E2E 扩展范围）。

### 测试 / 构建基线

- 全仓 **单测 446 → 485**（+39：session-layer.test.ts +32 单测 + list_directories 接线 5 条随迁 + work_dir CRUD 增量 2 条）；既有 446 测试零回归。
- 集成 **30 → 32**（+2：pending → stem 迁移端到端 + 多 work_dir 并行）；既有 30 集成零回归。
- **e2e 3 场景全绿**（任务 06 commit `8200068` W8 实证）。
- `pnpm run typecheck` / `pnpm run lint` / `pnpm run build` 全绿；`packages/web` build 236.38 KB **零增长**（任务 06 仅 bridge 侧）。
- `packages/bridge` 文件清单：1 文件新建（`src/session-layer.ts`）+ 2 文件新建测试（`__tests__/session-layer.test.ts` / `__tests__/list-directories.test.ts` 仅迁移 5 条接线测试，纯函数模块不动）+ 1 文件改（`src/pi-process.ts` 删除 `handleListDirectories` 临时宿主分支 + 移除 `handleGetState` 等迁出逻辑）+ 1 文件改（`src/index.ts` 接线 `BridgeSessionLayer` + 注入 `defaultWorkDir`）；`packages/shared` / `packages/web` / `packages/worker` 零改动（协议层任务 02 已锁版）。

### 与 [[tasks/m4/05-bridge-list-directories.md|任务 05]] / [[tasks/m4/04-bridge-state-json.md|任务 04]] / [[tasks/m4/02-shared-protocol-v3.md|任务 02]] 对照

| 维度 | M4 任务 [[tasks/m4/02-shared-protocol-v3.md\|02]] | M4 任务 [[tasks/m4/04-bridge-state-json.md\|04]] | M4 任务 [[tasks/m4/05-bridge-list-directories.md\|05]] | M4 任务 06（本任务） |
|------|---------------------------------|---------------------------------|---------------------------------|---------------------|
| 测试基线 | shared 308 不变 | 361 → 417 | 417 → 446 | 446 → **485 单测** / **32 集成** |
| 新建核心文件 | `work-dirs.ts` / `session-list.ts` | `state.ts` | `list-directories.ts` | `session-layer.ts` |
| 关键 seam | envelope `session` 启用规则（schema 仍 optional）+ ADR-0010 | `WorkDirStore` + `StateError` | 纯函数 + 单点映射 | `BridgeSessionLayer` 多 manager Map + SPAWN_TIMEOUT_MS + ready idle + pending 键控 |
| review 结论 | 0C / 4W / 7S（6 项落地 + 3 项递延任务 09）| **1C 闭合 / 6W 全修 / 4S**（S2 转任务 06 义务：StateError→internal 映射）| 0C / 4W / 8S（S1 转任务 06：list_directories 接线随迁）| **2C / 7W / 9S 全部处置**（C2 m3-legacy 文档化转任务 08 退役评估；S15/S17/S18 三项合理跳过）|
| 教训承接 | M3 `1c86aca` worker 转发链教训 | M3 `config.ts` 三件套模式 + atomic write POSIX 语义 | M3 `normalizeCommandError` 同类「domain-level outcome + wire-level 翻译」分层 | M3 `get_messages.reply_to` 翻译层教训 + M3 `completeHandshake` 握手写入教训 + **真 pi 探针铁律**（凡未实测的落盘细节不可信）|

### 勘误注记（2026-09-09，验收期）

**任务 06 `scanSessionsForWorkDir` 三字段（`message_count: 0` / `first_message: null` / `name: null`）原为占位实现——JSDoc 自述"does not currently parse jsonl"**——任务 06 review 时被定性为"forward compat"放行（**该放行定性错误**：[[prds/m4-multi-session.md|PRD §4.2]] level2 列表行**明确要求显示 first_message 摘要作为用户识别会话的主线索**，占位即不可用，非"延后实现"语义）。用户验收实测发现 level2 列表全部 `first_message: null` → 会话列表对几十～上百条会话完全无摘要可辨，强制用户逐条点进 ChatView 才能识别——**违反 PRD §4.2 level2 设计意图**。

**修复（commit `1d934de`，bridge 侧 worker 未提交）**——新增 `packages/bridge/src/session-summary.ts`（tiny + isolated helper，无 bridge / worker / shared 依赖）：

- **first_message 解析**：扫文件首 `FIRST_MESSAGE_BYTE_LIMIT` 字节 ∪ 首 `FIRST_MESSAGE_LINE_LIMIT` 行（whichever 先到），命中首条 `{"type":"message", ..., "message":{"role":"user", ...}}` 行 → 取 `content[]` 中 `type:"text"` 元素按序拼接 + `FIRST_MESSAGE_TEXT_MAX_CHARS` 码点级硬截断（**无省略号后缀**——码点级而非字符级，代理对不孤悬，W1 修复 `Array.from(...).length` 正确处理 CJK / emoji）；窗口外停止查找（**不**扫整文件——16MB+ jsonl 不应为列表行摘要做全量解析）
- **message_count 解析**：扫整文件但 `MESSAGE_COUNT_LINE_CAP` 行上限封顶；O(file-size) 受 50k 行 cap 保护；非 `type:"message"` 行不计；坏行静默跳过（**不抛**——一条坏 jsonl 不能让整个 `session_list` 回执失败）
- **`name` 维持 `null`**——pi jsonl 不携带 session name 字段，PRD §非目标明确不做自动命名；wire `name` 字段保持 `null` + JSDoc 钉桩（防未来"好心"实现误造）
- **24 条单测**（`packages/bridge/src/__tests__/session-summary.test.ts` 新建，6 个 describe 组：happy-path / content-shape / role-semantics / messageCount / tolerance / window）+ **session-layer.test.ts 6.5–6.7 三条端到端钉桩**（钉桩 6.5 真 pi jsonl 形状三字段真化 / 钉桩 6.6 仅 assistant 无 user → first_message null 语义 / 钉桩 6.7 不可读 / 空 jsonl → `message_count: 0` + `first_message: null` 不抛）

**边界决策表**（写代码即定档于 helper 头注 JSDoc，验收期落地后值守边界）：

| 维度 | 上限 | 触发语义 |
|------|------|----------|
| `first_message` 扫描窗口 | 首 64KB ∪ 首 200 行（先到） | 典型 pi jsonl 首条 user 消息在 5–10 行内（`session` / `model_change` / `thinking_level_change` 元数据之后），64KB/200 行是宽松安全余量 |
| `first_message` 文本截断 | 200 码点（codepoint 级，无省略号） | 列表行摘要够用即可，长文回 ChatView 看 |
| `message_count` 行上限 | 50 000 行 | 极端大会话文件（数 MB）不卡 `session_list`；超过后语义为"+ many more"近似值（web 列表行徽章可接受）|
| 坏 JSON 行容忍 | 静默跳过 + count 继续 | 一行截断 / fs 损坏不能击穿整次回执 |
| `name` 字段 | 恒 `null` | pi jsonl 不携带 + PRD 非目标 |

**测试基线（验收期修复后）**：单测 **629 → 656**（+24 session-summary + 3 session-layer 钉桩）/ 集成 **32**（零回归）/ e2e **8/8 全绿 × 2 次连跑** / typecheck 4 包 / lint 0 错 / build 4 包（web 252.91 KB 零增长）。

**review 修复轮（worker 未提交）**——W1 / W2 / W4 / W5 / S6 共 6 项落地：
- **W1** 代理对截断修复——`first_message` 截断从字符级 `.length` 改码点级 `Array.from(...).length`，CJK 字符 / emoji 代理对不孤悬、不半截；测试 2.4b（199 ASCII + 😀 边界）钉桩
- **W2** JSDoc 澄清——`scanSessionsForWorkDir` 头注与 helper 顶部段从"does not currently parse jsonl / returns hardcoded zeros"改写为"delegates to `readSessionSummary` (see `./session-summary.ts`) — every line parsed by the helper"
- **W4** JSDoc 澄清——helper 头注"Encoding notes"段扩写 chunk 边界多字节 UTF-8 替换字符代价（first_message 不受影响，message_count 可能有 off-by-one under-count 但 cap 50k 不可见）
- **W5** `--metadata` 措辞软化——helper 头注"past the window we stop looking — for typical pi jsonls the first user message appears within the first 5–10 lines (after `session` / `model_change` / `thinking_level_change` metadata)" 改"after `session` / `model_change` / `thinking_level_change` events"——避免硬指 metadata 段（pi 不同版本可能改名 / 重组）
- **S6** cap 断言健壮化（655 → 656）——session-summary 4.4 cap 测试补一条边界用例（恰好 cap + 1 行 + 后续坏行不影响），测试基线 655 → 656；其余 5 项 review 处置钉桩于代码 / 测试

**教训一句**（与 [[tasks/m3/04-bridge-pi-process.md|任务 04 cwd 编码勘误]] / M3 bridge→pi 翻译层修复同款铁律再次验证）：**凡未实测的 wire / 落盘细节均不可信**——本次属**review 层也未实测字段真实性**（实施 + review 双层均未真正读 jsonl 内容，错把占位放行）；占位 vs 实测的偏差存活到联调后用户验收期才被戳穿。任务 04 cwd 编码勘误是实施层同类偏差（占位实现与 pi 真实算法错位存活到联调），M3 bridge→pi 翻译层修复是 wire 层同类偏差（旧测试 §1.3 长期断言错误 wire 形状使字段名 bug 存活到联调），本次属 review 层同类偏差——**三层（实施 / 测试 / review）任一层放行都会让偏差存活到验收期**，唯一可靠防线是验收期真实环境实测。三笔独立 commit 反复验证这条铁律，不再独立成段。

**任务书原文推荐实现（占位三字段 + "forward compat"放行口径）不再成立**。本轮修复落地后任务 06 `scanSessionsForWorkDir` 三字段真化（受上述边界决策表保护），PRD §2.4 性能预算注释同步在 [[prds/m4-multi-session.md|M4 PRD]] §修订注记追加（"单次 < 10ms 基于纯 readdir 假设，验收期缺口修复后每行解析为 O(file-size) 受 50k 行 cap 保护，实际约束为 web 侧 `SESSION_LIST_TIMEOUT_MS = 5_000` 看门狗"——PRD 主体未改）。
