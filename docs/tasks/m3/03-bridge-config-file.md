---
prd: prds/m3-single-session.md
status: todo
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
- [ ] `packages/bridge/src/config.ts` 新建：`BridgeConfig` interface / `loadBridgeConfig(path)` / `resolveDefaultConfigPath()` / `readTokenOrGenerate(config)` / `ConfigError` 类落地
- [ ] `packages/bridge/src/index.ts`：`DEFAULT_WORKER_URL` / `parseWorkerUrlFlag` / `readEnvWorkerUrl` 全部删除（grep 零结果）；`StartOptions.workerUrl` 删除；`configPath` 字段新增；CLI 仅识别 `--config`，未知 flag 静默忽略
- [ ] `packages/bridge/src/token.ts`：`DEFAULT_WEB_BASE` 删除；`shareUrl(token, base)` 的 `base` 必填
- [ ] `packages/bridge/package.json`：`peerDependencies` + `peerDependenciesMeta` 整段删除；`grep "pi-coding-agent" packages/bridge/package.json` 零结果；`grep -R "pi-coding-agent" packages/bridge/` 零结果
- [ ] 启动行为：`bridge`（无参）→ 读 `~/.config/remotepi/bridge.json`；`bridge --config /path/to.json` → 读指定路径；JSON 解析失败 / 缺 `worker_url` / 缺 `web_base_url` / 缺 `work_dir` → stderr 友好错误 + exit 1；work_dir 不存在 / 不是目录 / 不可读 → exit 1（**不 mkdir**）；token 缺省 → 自动生成不回写
- [ ] 未知 CLI flag（如 `--foo` / `--systemd-foo`）静默忽略（不退出，编排裁定）
- [ ] `pnpm --filter @remotepi/bridge test` 全绿（既有 8 条 + 本任务新增 7+ 条配置测试；具体清单见任务 05 验收清单）
- [ ] `pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿
- [ ] TODO 占位：M3 整体收尾时落到 [[current-state.md|current-state TODO]]——"（暂缓，用户裁定 2026-09-05）bridge 配置迁移后将来重新加回 CLI 参数与环境变量支持（M3 仅保留 --config）"（任务 08 统一写，本任务不重复）

## 依赖
- 依赖 [[tasks/m3/01-shared-protocol-v2.md|01-shared-protocol-v2]]（config 不直接消费 v2 schema，但同线 commit 利于 review 完整性）
