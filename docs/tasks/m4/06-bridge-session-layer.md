---
prd: prds/m4-multi-session.md
status: todo
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