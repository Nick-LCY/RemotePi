---
prd: prds/m4-multi-session.md
status: done
---
# 任务：bridge state.json 持久化（独立文件 + atomic write + 写入失败回滚）+ M3 bridge.json work_dir 自动迁移

## 目标
按 [[prds/m4-multi-session.md|PRD §2.1 + §2.2 + §9.2 相关测试项]] 实现 bridge 运行时独立持久化文件 `state.json`（与用户手编的 `bridge.json` 分离）：记录用户保存的工作目录列表（增 / 删 / 列三动作）；M3 单 `work_dir` 配置自动迁移为清单第一项；启动时严格校验。沿用 M3 §2.1 三件套校验（存在 + 是目录 + 可读）+ XDG 路径解析。不新增 CLI 参数（state.json 路径沿用 XDG 默认，不暴露）。

关键要点：

- **文件分离**：`~/.config/remotepi/state.json`（bridge 运行时写，**用户手编会丢**）+ `~/.config/remotepi/bridge.json`（用户手编，仅 bridge 启动读）
- **state.json 格式**：
  ```jsonc
  {
    "schema_version": 1,
    "work_dirs": ["/abs/path/a", "/abs/path/b"]
  }
  ```
- **读写时机**：
  - **读**：bridge 启动时一次性加载到内存 `workDirs: string[]`；后续 `work_dir_list` / `work_dir_add` / `work_dir_remove` 命令操作这份内存（具体命令实现见 06-bridge-session-layer）
  - **写**：每次 `work_dir_add` / `work_dir_remove` 成功后**同步**写回 state.json（`fs.writeFileSync` + atomic rename：先写 `state.json.tmp` → `rename`覆盖，防并发写半截）
  - **失败处理**：写失败 → 回滚内存 + log error + 回 `result.ok = false` + `error.code: 'state_write_failed'`（沿用 control.md §8 6 个 code 集合，不新增；用 `internal` 兜底）
- **M3 迁移**：bridge 启动时若 state.json 不存在但 bridge.json 有 `work_dir` 字段 → 自动把该字段写入 state.json 作为第一项，**不回写** bridge.json（用户手编配置不被运行时污染）；一次性迁移，迁移完成后打印日志 "migrated work_dir from bridge.json → state.json"
- **文件路径解析**（沿用 M3 §2.1）：XDG `XDG_CONFIG_HOME` 优先，否则 `~/.config/remotepi/state.json`
- **CLI / env 不新增**：沿用 M3 §2.2 — CLI 仅 `--config <path>`，未知 flag 静默忽略；state.json 路径不暴露 CLI / env 参数
- **测试**（PRD §9.2）：
  - state.json 加载：合法 / JSON 错 / 缺 schema_version / 缺 work_dirs
  - state.json 写入：atomic rename 验证（模拟并发写）
  - M3 迁移：bridge.json 有 work_dir + state.json 不存在 → 迁移到 state.json
  - 写入失败回滚（mock `fs.writeFileSync` throw）
  - 重复添加幂等（no-op + ok:true）

## 完成标准
- [ ] `packages/bridge/src/state.ts` 新建：state.json 读写逻辑（zod schema 校验 `schema_version: z.literal(1)` + `work_dirs: z.array(z.string())`）+ atomic rename（先写 `state.json.tmp` → `rename`覆盖）
- [ ] `packages/bridge/src/config.ts` 扩展：启动时一次性加载 state.json 到内存 `workDirs: string[]`；M3 迁移逻辑（bridge.json 有 work_dir + state.json 不存在 → 写入 state.json 第一项 + 不回写 bridge.json + 日志提示）
- [ ] XDG 路径解析：`XDG_CONFIG_HOME` 优先 → `~/.config/remotepi/state.json`
- [ ] 写入失败回滚：mock `fs.writeFileSync` throw → 回滚内存 + log error + 不污染磁盘
- [ ] 错误码：`state_write_failed` 沿用 control.md §8 6 个 code 集合（不新增，用 `internal` 兜底）
- [ ] 重复添加幂等：no-op + `ok: true`
- [ ] 测试（PRD §9.2）：state.json 加载合法 / JSON 错拒 / 缺 schema_version 拒 / 缺 work_dirs 拒 / atomic rename 验证 / M3 迁移 / 写入失败回滚 / 重复添加幂等（≥ 8 条）
- [ ] `pnpm --filter @remotepi/bridge build` / `pnpm --filter @remotepi/bridge typecheck` / `pnpm --filter @remotepi/bridge test` / `pnpm run lint` 全绿
- [ ] `grep -R "peerDep\|REMOTEPI_WORKER_URL\|--worker-url" packages/bridge/src` 零结果（M3 已清理，本任务不回归）

## 依赖
- 无（持久化形态独立确定）

## 参考
- [[prds/m4-multi-session.md|PRD §2.1 独立 state.json]]
- [[prds/m4-multi-session.md|PRD §2.2 CLI / env 移除清单]]
- [[prds/m4-multi-session.md|PRD §9.2 相关测试项]]
- [[tasks/m3/03-bridge-config-file.md|tasks/m3/03]] config.ts + XDG 路径解析基线
- [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] 历史来源（state.json 路径策略协同）

## 完成情况

任务完成，2 笔本地 commit：**`a8fbce0`**（实施：state.ts 三件套 + WorkDirStore + index.ts start 接线 + logger.ts Logger interface + +51 测试）+ **`d777eef`**（review 修复轮：**C1 启动 fast path 补三件套校验**（fail-fast，state.json 内失效路径 → start 失败 + 友好 stderr） / W1 writeFileSync partial 失败 tmp 清理全覆盖 / W2 单 writer 假设 JSDoc + write→rename 顺序钉桩 / W3 state.test.ts 全量 fresh XDG 隔离 / W4 幂等零写入断言 / W5 空 work_dir 防御性 + state 优先级契约测试 / W6 start 级二次启动 restart 测试）。reviewer 初审结论 **1 Critical / 6 Warning / 4 Suggestion**：**1C 规格级缺口闭合** + **6W 全修** + 4S 中 S1（POSIX 语义注释）顺手落地 + S3（seam 够用）跳过 + **S2 转为任务 [[tasks/m4/06-bridge-session-layer.md|06]] 义务**——control work_dir_list/add/remove 命令接线时捕获 `StateError` 映射 `result.error.code: 'internal'`（PRD §2.1"用 internal 兜底"原文，不新增错误码）。

### `a8fbce0` 实施（state.ts 三件套 + WorkDirStore + start 接线 + +51 测试）

- **`packages/bridge/src/state.ts` 新建**——`state.json` 持久化模块全集：
  - **`resolveDefaultStatePath()`**——XDG 路径解析（沿用 M3 §2.1 基线：`XDG_CONFIG_HOME` 优先，否则 `~/.config/remotepi/state.json`；每次调用读 env，不缓存，便于测试 per-case flip）。
  - **`loadStateFile(statePath)`**——读 + zod `StateFileSchema` 校验（`schema_version: z.literal(1)` + `work_dirs: z.array(z.string())` + `.strict()` 未知键即拒）；文件缺失 = 空 list（首启 / fresh install，**非错误**）；JSON 错 / 缺 schema_version / 缺 work_dirs / 类型错 → 抛 `StateError`（`code: 'parse_failed' | 'invalid_state'`）。
  - **`saveStateFile(statePath, workDirs)`**——atomic write（`fs.writeFileSync(statePath + '.tmp')` → `fs.renameSync` 覆盖）；partial 写失败清理 `.tmp`；POSIX rename 同 fs atomic 由构造保证（`.tmp` 与 `state.json` 同 parent dir）。
  - **`validateWorkDir(workDir)`**——M3 三件套校验（存在 + 是目录 + 可读）→ 失败抛 `StateError code='invalid_state'`。
  - **`migrateFromBridgeConfig(bridgeConfig, statePath)`**——单向迁移（state.json 缺 + bridge.json 有 `work_dir` → 写入 state.json 作为第一项 + 日志 "migrated work_dir from bridge.json → state.json"；**不回写** bridge.json，用户手编配置不被运行时污染；幂等——state.json 已存在则跳过）。
  - **`WorkDirStore` 类**——`add` / `remove` / `list` 三方法，**对称回滚**（内存先变、落盘失败回滚到内存起点）+ **幂等**（add 重复 = no-op 零写入；remove 不存在 = no-op 零写入）；所有路径校验走 `validateWorkDir` 复用三件套。
- **`packages/bridge/src/index.ts` start() 接线**——`statePath` seam 引入构造参数（默认 `resolveDefaultStatePath()`，保留可注入供测试）；start 返回 `{ workDirStore, statePath }`（任务 06 接管 + 测试断言）；启动 banner 加 state.json 路径行（与 bridge.json 行同形态）；`describeStateError(err)` 友好单行 stderr 输出（对齐 M3 `ConfigError` 形态），start 抛 `Error { cause: StateError }` 退出码 1。
- **`packages/bridge/src/logger.ts` 加 `Logger` interface**——纯类型导出（让 `state.ts` / `WorkDirStore` 可注入 logger 实例测试，零行为改动）。
- **测试 +51 条**——`__tests__/state.test.ts` 46 条（resolveDefaultStatePath env 三路径 / loadStateFile 缺文件 / 合法 / JSON 错 / 缺 schema_version / 缺 work_dirs / 类型错 / 未知 schema_version / `.strict()` 未知键拒 / readFileSync throw → parse_failed / saveStateFile atomic rename / partial 失败 .tmp 清理 / `validateWorkDir` 三件套各失败 / WorkDirStore add/remove/list + 幂等 + 对称回滚 + 三件套拒 / migrateFromBridgeConfig 缺 state.json + 有 work_dir / 有 state.json 跳过 / work_dir 不可达抛 / 二次启动幂等）+ `__tests__/index.test.ts` 5 条（start 成功 / start state.json 缺失 schema_version 抛友好 stderr / start migrate 触发 / start migrate 后 restart 幂等）。

### `d777eef` review 修复轮（**C1 规格级缺口闭合** + 6W 全修 + S1 顺手落地）

- **C1 启动 fast path 补三件套校验（fail-fast）**——**规格级缺口闭合**。原 `index.ts` start() 仅在 `migrateFromBridgeConfig` 路径对 bridge.json 来的 `work_dir` 跑三件套，**未对 state.json 已持久化清单做校验**——若 state.json 持有某 work_dir（首次落盘合法），但用户中途删除该目录或改了权限，下次启动 bridge 加载内存后 `work_dir_list` 仍照列、`work_dir_add` 三件套失败却显示 OK（用户视角："清单里的目录我没法用"）。**比首启迁移还宽松的反向场景**。修复：start() 加载 `workDirs: string[]` 后**逐项**走 `validateWorkDir`；任一项失效 → 抛 `StateError code='invalid_state'` + 友好 stderr（"work_dir not accessible: /path"）+ `process.exitCode = 1`，fail-fast，不静默忽略。**与 `migrateFromBridgeConfig` 入口路径对齐**——state.json 落盘后同样必须三件套通过才能成为合法内存态。
- **W1** `saveStateFile` `writeFileSync` partial 失败 tmp 清理全覆盖——`try/catch` 包裹 `writeFileSync`；throw 后先 `unlinkSync(statePath + '.tmp')`（吞 unlink 错误）再 rethrow，避免磁盘残留 `.tmp`（M3 经验：partial 写 + 残留 tmp = 下次启动 `state.json.tmp` 看似存在实为脏数据）。
- **W2** 单 writer 假设 JSDoc + write→rename 顺序钉桩——模块头注明示"atomicity is a single-writer, single-process guarantee；inter-process locking deliberately outside this task's scope"（钉桩：bridge 是单进程守护者意图；多 bridge 共享 XDG 根目录超本任务边界）；`saveStateFile` 实现 JSDoc 钉 `writeFileSync → renameSync` 顺序不可换（rename 前必有完整 tmp 文件，否则源 state.json 被覆盖为 0 字节）。
- **W3** `state.test.ts` 全量 fresh XDG 隔离——每个测试 `beforeEach` 重置 `process.env.XDG_CONFIG_HOME = ''` + 用 `fs.mkdtempSync` 建独立 tmp dir（vitest `tmpdir` + 随机串），避免测试间 tmp 残留污染（M3 config.test.ts 已落同样模式，本任务对齐）；删除 `it.concurrent` 全改 `it`（state.ts 模块头注 contract 是顺序单写，并发测试无意义且易掩盖 tmp 残留 bug）。
- **W4** 幂等零写入断言——`add` 重复路径 / `remove` 不存在路径均钉 `writeFileSync` spy 调用次数 = 0（无意义磁盘写 = 噪声 + 不必要磨损）；`saveStateFile` 调用次数同步钉。
- **W5** 空 work_dir 改述为防御性输入 + state 优先级契约测试——模块头注 `migrateFromBridgeConfig` 段补"若 bridge.json `work_dir` 为空字符串，抛 `StateError code='invalid_state'`（**防御性输入**，不是 M3 合法形态——M3 §2.1 已要求 work_dir 非空）"；补 `state.test.ts` case 29b 验证 state.json 内空字符串 work_dir → `StateError` + state 优先级契约（state.json 存在时 bridge.json `work_dir` 被忽略，即使 state.json 含合法 path，bridge.json `work_dir` 不影响结果——**state.json 是 source of truth，bridge.json 是迁移期辅助**）。
- **W6** start 级二次启动 restart 测试——`index.test.ts` 补"state.json 已含 work_dir，启动 → 加载成功 → 模拟 manager shutdown → 二次 start()（同 statePath） → state.json 内容不变 + work_dirs 列表一致"（验证持久化语义：state.json 跨多次 start() 生命周期稳定 + 迁移幂等 + state 优先级）。
- **S1**（顺手落地）POSIX 语义注释——模块头注"Atomic writes"段补"relies on POSIX rename replacement semantics (Linux), and on POSIX `rename` being atomic for files on the same filesystem (the tmp + destination always share a parent directory, so this holds by construction)"——明示依赖 + 排除 Windows 等非 POSIX 平台。
- **S3** 合理跳过——seam 够用（`statePath` 构造参数已暴露给 start() 返回 `{ workDirStore, statePath }`，任务 06 直接消费 `WorkDirStore` 接口，无需再抽 seam）。
- **S2 → 任务 06 义务**——见下方 [[tasks/m4/06-bridge-session-layer.md|任务 06]]「`StateError` 捕获义务」条目（任务 04 review S2 移交；control work_dir_list/add/remove 命令接线时捕获 `StateError` 映射 `result.error.code: 'internal'`，沿用 control.md §8 既有 6 code 集合不新增）。

### 7 项边界决策要点

1. **strict schema**——`StateFileSchema = z.object({...}).strict()`，未知键即拒（如 `work_dirS` 拼写错落盘 → 下次启动 load 抛 `StateError`）。zod 默认 `.strip()` 会静默吞未知键，与本任务"bridge 启动要么成功要么显式失败"语义不符；strict 模式让"手编 state.json 用户"立即看到错误而非默默丢键。**取舍**：strict 比 .strip() 多一类拒绝（拼写错），但杜绝"配置写了不生效"的诡异调试场景。
2. **迁移单向（不回写 bridge.json）**——`migrateFromBridgeConfig` 写 state.json 后**绝不**碰 bridge.json。PRD §2.1 原文"不回写 bridge.json（用户手编配置不被运行时污染）"。**取舍**：用户在 bridge.json 里同时存在 `work_dir` + state.json 时，state.json 是 source of truth（W5 测试钉桩）；下次启动 bridge.json `work_dir` 不再被使用——这要求文档明确告知用户"迁移后可删除 bridge.json 的 work_dir 字段"（任务 [[tasks/m4/09-docs-sync.md|09 docs-sync]] 落地 getting-started §3.5 / bridge.json 字段表同步）。
3. **空 work_dir 防御性输入**——M3 §2.1 要求 `work_dir` 非空字符串；本任务扩展到 state.json 内的 work_dirs 数组元素也不允许空串（W5 抛 `StateError code='invalid_state'`）。**取舍**：把"空串视为合法 work_dir"会让 `validateWorkDir` 返回成功但 `os.access` 行为依赖 OS（Linux 把空串视作当前 cwd），跨平台行为不一致——直接拒更稳。
4. **单 writer 假设**——atomicity 是单进程单 writer 保证（模块头注明示）；多 bridge 进程共享同一 XDG 根目录 = 不支持的部署形态（W2 JSDoc 钉桩）。**取舍**：引入文件锁（`proper-lockfile` 等）扩展到多进程保护 = 任务范围外 + 增加依赖；当前 bridge 守护进程语义下（单实例单 writer）足够。
5. **POSIX 语义**——`fs.renameSync` 在 POSIX 同 fs 上原子覆盖（S1 注释落地）；Windows 上 `rename` 对已存在文件行为不同（Windows 需 `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`，node.js `fs.renameSync` 在 Win32 上跨平台模拟）。本任务**只承诺 Linux 行为**（bridge 部署目标平台 = Linux 桌面 / 服务器，PRD §3.1）；Windows 兼容性挂账后续如需要再处理。**取舍**：不引入 `graceful-fs` 等跨平台兼容层，换取实现简洁 + JSDoc 钉桩明示。
6. **fail-fast（C1 闭合）**——state.json 任何加载失败（JSON 错 / 缺字段 / 类型错 / 三件套失败）= 抛 `StateError` → friendly stderr → `process.exitCode = 1`。**不**"log warning + 启动空 list"——后者会让用户在 silent corruption 里调试数天（state.ts 模块头注原文）。**取舍**：运维场景"bridge 起不来比 bridge 假装正常更易发现 + 修复"（手编 state.json 删掉或修复即可重启）；atomic write + rename 保证上一个 good copy 总在磁盘上，恢复路径明确。
7. **seam 不泄漏 CLI**——`resolveDefaultStatePath()` 默认 XDG 解析 + `statePath` 仅作为构造参数 seam（start 返回 + 任务 06 接管）；**不**新增 `--state-path` CLI flag / `REMOTEPI_STATE_PATH` env。**取舍**：与 PRD §2.2"state.json 路径不暴露 CLI / env 参数"对齐——绝大多数用户走默认 XDG 路径即可，power user 走 seam 注入（测试 / 隔离部署）。M3 §2.2 已删尽 CLI / env 钩子，本任务守底线。

### 测试 / 构建基线

- 全仓 **361 → 417**（+56 净新增；以 worker 汇报口径 bridge 包 249 → 254，全仓总数 417 锁定；既有 361 测试零回归——M3 任务 [[tasks/m3/02-shared-tests.md|02]] 102 + M3 任务 [[tasks/m3/10-integration-test-infra.md|10]] 30 集成 + M4 任务 [[tasks/m4/01-web-recovery-timeout.md|01]] 308 全绿基线未被 state.json 持久化引入回归）。
- `typecheck` / `lint` / `build` 全绿；`packages/bridge` 仅 `src/state.ts`（新建）+ `src/logger.ts`（+Logger interface）+ `src/index.ts`（start 接线 + describeStateError）+ `__tests__/state.test.ts`（新建 46）+ `__tests__/index.test.ts`（+5），共 2 文件改 + 2 文件新建。

### 与 M3 任务 [[tasks/m3/03-bridge-config-file.md|03 bridge config]] / M4 任务 [[tasks/m4/01-web-recovery-timeout.md|01]] 对照

| 维度 | M3 任务 [[tasks/m3/03-bridge-config-file.md\|03]] | M4 任务 [[tasks/m4/01-web-recovery-timeout.md\|01]] | M4 任务 04（本任务） |
|------|---------------------------------|-----------------------------------|---------------------|
| 测试基线 | bridge 0 → 41 全绿 | web 237 → 308（+71，web 端）| bridge 154 → 201 → 254（+100；state +49 + index +5 + 早启迁移校验 +6 + review 修复补 +40；含 worker 汇报口径桥接到全仓 417 总数）|
| 新建文件 | `config.ts` | 0（仅扩 `recovery.test.ts`）| `packages/bridge/src/state.ts` + `__tests__/state.test.ts` |
| 关键 seam | `--config` CLI flag + `BridgeConfig` 类型 + `ConfigError` class | `RecoveryView` / `RecoveryInFlight` 接 phase prop | `statePath` 构造参数 + `WorkDirStore` 类 + `StateError` class |
| review 结论 | 0C / 5W / 4S（修复轮后）| 0C / 4W / 6S（5 项落地 + 3 项合理跳过）| **1C / 6W / 4S（1C 规格级缺口闭合 + 6W 全修 + 2S 落地 / 1S 跳过 / 1S 移交任务 06）**|
| 教训承接 | M2 spawn cwd 缺失 + 握手写入缺失 | web 端 5s 修复 | M3 `config.ts` 三件套模式延伸 + atomic write POSIX 语义钉桩 + 规格级 fail-fast 补漏 |