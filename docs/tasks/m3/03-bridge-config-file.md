---
prd: prds/m3-single-session.md
status: done
---
# 任务：bridge 配置加载（JSON 文件 + 校验）+ CLI/env 移除 + 未知 flag 静默忽略

## 目标
按 [[prds/m3-single-session.md|M3 PRD §2.1 / §2.2]] 落地 `packages/bridge` 配置文件全量迁移：删除 `--worker-url` CLI flag / `REMOTEPI_WORKER_URL` env / `DEFAULT_WORKER_URL` / `parseWorkerUrlFlag` / `readEnvWorkerUrl` / `DEFAULT_WEB_BASE` / `shareUrl` 默认 base / `peerDependencies["@earendil-works/pi-coding-agent"]`；新增 `--config <path>` 单 flag + JSON 配置加载（XDG 可选 + work_dir 严格校验 + 未知 flag 静默忽略）。默认路径 `~/.config/remotepi/bridge.json`；字段 `worker_url` / `web_base_url` / `work_dir` / 可选 `token`。

关键要点：

- **新建 `packages/bridge/src/config.ts`**：
  - `interface BridgeConfig { worker_url: string; web_base_url: string; work_dir: string; token?: string }`
  - `function loadBridgeConfig(path: string): BridgeConfig`：读文件 → JSON.parse → zod 校验（3 必填 + token 选填）→ work_dir 严格校验（`fs.statSync` 存在 + `isDirectory()` + `accessSync(work_dir, R_OK)` 任一失败 throw `ConfigError`）→ 返回 config
  - `function resolveDefaultConfigPath()`：`process.env.XDG_CONFIG_HOME` 优先 → fallback `path.join(os.homedir(), '.config', 'remotepi', 'bridge.json')`
  - `function readTokenOrGenerate(config)`：`config.token` 非空 → 用 + `shareUrl(token, config.web_base_url)`；否则 `generateToken()`（**不**回写到文件）
  - `class ConfigError extends Error` 含 `code: 'parse_failed' | 'missing_field' | 'work_dir_invalid'`
- **改 `packages/bridge/src/index.ts`**：
  - 删除 `DEFAULT_WORKER_URL` 常量 / `parseWorkerUrlFlag` / `readEnvWorkerUrl` / `StartOptions.workerUrl` 字段（保留 `argv` test seam）
  - `StartOptions` 改为 `{ configPath?: string; logger?, createSocket?, argv?: string[], token?: string }`
  - `start(options)`：`configPath = options.configPath ?? resolveDefaultConfigPath()` → `loadBridgeConfig(configPath)` → catch → `logger.error(...)` + `process.exitCode = 1`（友好 stderr，不堆栈）→ 成功 `workerUrl = config.worker_url` → `readTokenOrGenerate(config)` → 打 token + shareUrl + worker URL → `new BridgeClient(workerUrl, token, ...)`
  - CLI 解析：仅识别 `--config <path>` / `--config=<path>`；**未知 flag 静默忽略**（不退出；编排裁定；systemd wrapper 友好）
- **改 `packages/bridge/src/token.ts`**：删除 `DEFAULT_WEB_BASE`；`shareUrl(token, base: string)` 的 `base` 改必填入参（无默认）
- **改 `packages/bridge/package.json`**：删除 `peerDependencies["@earendil-works/pi-coding-agent"]` + `peerDependenciesMeta` 整段；bridge 不再声明 pi 依赖（M3 task 04 仍用外部 `pi` 二进制但不引入包 import）
- **不动**：`client.ts`（WSS / handshake / 心跳 / 重连不变）；`logger.ts`

## 完成标准
- [x] `packages/bridge/src/config.ts` 新建：`BridgeConfig` interface / `loadBridgeConfig(path)` / `resolveDefaultConfigPath()` / `readTokenOrGenerate(config)` / `ConfigError` 类落地
- [x] `packages/bridge/src/index.ts`：`DEFAULT_WORKER_URL` / `parseWorkerUrlFlag` / `readEnvWorkerUrl` 全部删除（grep 零结果）；`StartOptions.workerUrl` 删除；`configPath` 字段新增；CLI 仅识别 `--config`，未知 flag 静默忽略
- [x] `packages/bridge/src/token.ts`：`DEFAULT_WEB_BASE` 删除；`shareUrl(token, base)` 的 `base` 必填
- [x] `packages/bridge/package.json`：`peerDependencies` + `peerDependenciesMeta` 整段删除；`grep "pi-coding-agent" packages/bridge/package.json` 零结果；`grep -R "pi-coding-agent" packages/bridge/` 零结果
- [x] 启动行为：`bridge`（无参）→ 读 `~/.config/remotepi/bridge.json`；`bridge --config /path/to.json` → 读指定路径；JSON 解析失败 / 缺 `worker_url` / 缺 `web_base_url` / 缺 `work_dir` → stderr 友好错误 + exit 1；work_dir 不存在 / 不是目录 / 不可读 → exit 1（**不 mkdir**）；token 缺省 → 自动生成不回写
- [x] 未知 CLI flag（如 `--foo` / `--systemd-foo`）静默忽略（不退出，编排裁定）
- [x] `pnpm --filter @remotepi/bridge test` 全绿（既有 19 条基线 → **41 条**，新增 22 条覆盖 config 校验 / XDG 解析 / token 三态 / `--config` 长短形 / 未知 flag 静默 / `--` 终止符 / systemd `-D` 不误吞 / strict schema typo 拒；任务书写的"既有 8"为旧估算，实际基线 19 条）
- [x] `pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿
- [x] TODO 占位：M3 整体收尾时落到 [[current-state.md|current-state TODO]]——"（暂缓，用户裁定 2026-09-05）bridge 配置迁移后将来重新加回 CLI 参数与环境变量支持（M3 仅保留 --config）"（任务 08 统一写，本任务不重复）

## 依赖
- 依赖 [[tasks/m3/01-shared-protocol-v2.md|01-shared-protocol-v2]]（config 不直接消费 v2 schema，但同线 commit 利于 review 完整性）

## 完成情况
任务完成，commit `3fbd93e`。bridge 配置全量迁移落地：`config.ts` 新建（zod strict + work_dir 三连校验不 mkdir + XDG 可选解析 + token 不回写）、`index.ts` 重写为配置驱动、`token.ts` `shareUrl` base 必填、`peerDependencies["@earendil-works/pi-coding-agent"]` 与 `peerDependenciesMeta` 整段删除。reviewer 通过，**无 Critical**；3 项 Warning 全修（options.token 注入时 shareUrl 契约 / `logger.error` 切 stderr / `--config` 遇 `-` 开头 token 不误吞），另补 S1（`--` 终止符停止扫描 `--config` 解析）/ S2（ConfigError 保留 `cause` 以便溯源）/ 补 S3（strict schema camelCase typo 拒测试）。bridge 测试 **41 条全绿**（19 既有 + 22 新增），tsx 实跑冒烟通过。

值得记的补充：

- **bridge 直接依赖 `zod ^3.24.1`**：与 `@remotepi/shared` 同版本；config schema 仅 bridge 消费，未提到 shared（避免在 shared 留 bridge-only 的死代码）。
- **`logger.error` 由 stdout 切 stderr**（M2 行为变更）：M2 时代 `logger.info` / `logger.error` 同走 stdout，运维不便按流分离日志；本任务统一修正，`logger.error` → stderr，`logger.info` 保持 stdout。若有外部脚本按旧行为分流（grep stdout），需相应调整。
- **`--config` 解析加固**（review 暴露的三处边界）：
  - 遇 `-` 开头 token 不吞——systemd 风格 `-D` / `-E` 等短横线参数不会被当成 `--config` 的 path 吃掉（index.test.ts 覆盖）。
  - 遇 `--` 终止符停止扫描——之后所有 argv 一律视为业务参数，不会再被 `--config` 误拾。
  - `--config=<path>` 长形与 `--config <path>` 短形等价。
