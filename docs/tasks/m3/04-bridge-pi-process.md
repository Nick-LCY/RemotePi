---
prd: prds/m3-single-session.md
status: todo
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
- [ ] `packages/bridge/src/pi-process.ts` 落地：5 相位状态机 / 自管 stdin/stdout 缓冲 / 启动握手（get_state 写读）/ idle 5min 计时 / 自主 kill 标记（先置位再发 SIGTERM→1s→SIGKILL）/ exit 处理三路径（标记在→不重启 / 标记不在+code≠0→重启 / 标记不在+code=0→不重启）/ 广播 session_state（每次相位迁移）/ auth.json 缺失 stderr 提示
- [ ] `packages/bridge/src/pi-cwd-encoder.ts` 落地：`encodeCwdForPi(cwd)` 函数；与真实 pi 启动比对落盘路径一致（不通过则不收尾）
- [ ] session 目录扫描：合法路径（ISO 时间戳字典序）+ 同时间戳 mtime 最新 + 空目录走 spawn 不带 `--session`
- [ ] §2.7 exited 语义：spawn 触发集命令在 exited 时触发 spawn 计数 +1；get_state 在 exited 时由内存回答不 spawn；abort 在 exited 时回 `command_result{success:true}` 不 spawn
- [ ] bridge 与 pi 包零依赖：`grep -R "earendil-works" packages/bridge/` 零结果
- [ ] `pnpm --filter @remotepi/bridge test` 全绿（任务 05 集成测试覆盖 10+ 条新测试：状态机迁移序列 / 自主 kill 三路径 / session 扫描多文件 / cwd 编码 / exited 触发集 / get_state 不 spawn / abort no-op；具体清单见任务 05）
- [ ] `pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿
- [ ] bridge 启动日志含 `PI_CODING_AGENT_DIR` 路径 + auth.json 状态提示（无 auth.json 时打 stderr warn 但不退出）

## 依赖
- 依赖 [[tasks/m3/01-shared-protocol-v2.md|01-shared-protocol-v2]]（需要 session_state payload 含 phase / blocked_on 字段）
- 依赖 [[tasks/m3/03-bridge-config-file.md|03-bridge-config-file]]（config 提供 work_dir + 隔离目录路径）
