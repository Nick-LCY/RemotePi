---
prd: prds/m3-single-session.md
status: done
---
# 任务：假 LLM server + 隔离 pi 集成测试基建

## 目标
把 [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]] §1-§5 已挂账的"假 LLM server + 隔离 pi"集成测试方案从可研落成可本地跑的回归套件——真实 `pi --mode rpc` 子进程 + 进程内假 Anthropic Messages API server + 隔离 fixture agent-dir（`models.json` / `settings.json` / `auth.json` + 测试插件四件套 + `PI_CODING_AGENT_DIR` + `PI_OFFLINE=1`）+ vitest 独立 workspace（CI 跳过、本机 `pnpm test:integration`）。本套件不接 LLM 真实服务商、不污染宿主 `~/.pi/agent`、不对 `packages/*` / `worker/` / `.github/` / 根 `tsconfig` 做任何改动——直接消费既有 `PiProcessManager` seam。代码在 commit `3c6656d`（主体）+ `bb6293b`（review 修复）落地，本任务由编排者事后补录文档。

## 完成标准
- [x] 顶层 `tests/integration/` 新建（独立 vitest workspace + tsconfig，独立 `http.createServer` 假 server，五 helper + 一 fixture 扩展 + 六测试文件）
- [x] fixture `agent-dir` 四件套（`models.json` / `settings.json` / `auth.json` + `extensions/test-ext.ts`）就绪；fixture 通过 `PI_CODING_AGENT_DIR=<fixture>` + `PI_OFFLINE=1` 注入 pi 子进程，宿主零污染
- [x] 假 server 协议规格按 [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md#决策|ADR-0008 §1 Anthropic Messages API 决策]] 落地：`POST /v1/messages` + SSE 事件序列铁律（`message_start` → `content_block_start` → `content_block_delta(text_delta)` → `content_block_stop` → `message_delta` → `message_stop`），`x-api-key` + `anthropic-version` 头对账 `auth.json`；其他 Anthropic 端点 404 占位
- [x] vitest config 用 `.js`（ESLint `projectService.allowDefaultProject` 只认 `*.js`/`mjs`/`cjs`）+ `resolve.alias` + `tsconfig.paths` 双通道把 `@remotepi/{shared,bridge}` 映射到 `packages/*/src` 源码（`tests/integration/node_modules` 无 workspace symlink 也能解析）
- [x] 根 `package.json` 加 `test:integration` / `typecheck:integration` 两脚本；`.gitignore` 加 `tests/integration/.tmp/` + `tests/integration/**/sessions/`
- [x] `pnpm test:integration` 30 条全绿（≈11s）；基线 281 单测不变；4 包 typecheck + `typecheck:integration` + lint + build 全绿
- [x] CI 四步 workflow 不变、有意跳过本套件（GitHub Actions 无 `pi` 二进制）；与 [[architecture/decisions/0002-monorepo-and-tech-stack.md|ADR-0002]] 测试基建原则一致
- [x] 覆盖 §2.6 表五个测试面 + 两项新发现（LLM 失败路径 + steer/follow_up 翻译层钉桩），共六测试文件
- [x] review 通过：零 Critical；6 Warning 全修；2 Suggestion 合理跳过（详见下方"评审纪要"）

## 完成情况

- **代码变更**（commit `3c6656d`）：
  - `tests/integration/vitest.integration.config.js` —— 独立 workspace（`include: ['tests/integration/**/*.test.ts']`，不并入 `vitest.workspace.ts` 默认集合），`resolve.alias` 把 `@remotepi/{shared,bridge}` 指向 `packages/*/src`；文件名 `.js` 因 ESLint `projectService.allowDefaultProject` 只认 js 扩展。
  - `tests/integration/tsconfig.json` —— 独立 typecheck 入口，`baseUrl` + `paths` 同 alias 双通道；显式排除 `fixtures/agent-dir/extensions/**`（pi 扩展由 jiti 在 pi 进程内加载，不入 monorepo typecheck）。
  - `tests/integration/fixtures/agent-dir/` —— `models.json`（`api: 'anthropic-messages'` + `baseUrl` 占位 + `apiKey: fake-anthropic-test-key` + 1 个 fake model）+ `settings.json`（`defaultProvider` + `defaultModel`）+ `auth.json`（api_key 形状）+ `extensions/test-ext.ts`（`pi.registerTool` 一个 `trigger_dialog` 工具，5 类 `ctx.ui.*` 全触发）。
  - `tests/integration/helpers/` —— `fake-llm-server.ts`（进程内 `http.createServer` 绑 port 0，按 script 回放 SSE 事件流 + 录制所有 request body）+ `make-fixture.ts`（建 `tests/integration/.tmp/<run-tag>/agent-dir/` 隔离目录 + 工作目录的临时副本）+ `make-manager.ts`（预检 `pi` 二进制在 PATH，启动 `PiProcessManager`，封装 bridge `start()` / `handleEnvelope()` / `cleanup()`）+ `wait-for.ts`（poll 异步条件通用工具）+ `assertions.ts`（envelope / phase / blocked_on 共享断言）。
  - `tests/integration/*.test.ts` —— 6 文件 30 条 it：`00-smoke`（1）/ `01-happy-path`（6：握手 + 流式 + idle kill + 重启 + 状态机迁移）/ `02-session-persistence`（4：jsonl 落盘 + get_messages 跨重启拉回 + spawnCount→1）/ `03-error-normalization`（3：假 server 返 400 → bridge 归一化为 `command_result{success:false}` + `errorMessage` 落线）/ `04-extension-dialogs`（6：select / confirm(true|false) / input / editor / cancel 5 类）+ `06-multi-turn`（10：sequential / steer mid-run 端到端 / follow_up 队列）。
  - 根 `package.json` 加 `"test:integration": "vitest run --config tests/integration/vitest.integration.config.js"` + `"typecheck:integration": "tsc -p tests/integration/tsconfig.json"`。
  - `.gitignore` 加 `tests/integration/.tmp/` + `tests/integration/**/sessions/`。
  - **零改动**：`packages/*` / `worker/` / `.github/` / 根 `tsconfig` / `eslint.config.*` —— `PiProcessManager` 既有 seam 直接消费，印证"seam 已就绪"的设计。
- **评审结论**：review 通过；**6 Warning 全修** + **2 Suggestion 合理跳过**：
  - **6 Warning 全修**（关键排序）：
    1. **W5（最关键）steer 用例补端到端断言**——除 `command_result` 成功外，假 server 第二轮脚本因 steer 内容进入对话才触发 + `fakeServer.requests` 落线断言（"steer 文本出现在 post-steer LLM 请求体里"），真正钉死 bridge→pi→LLM 全链路携带 steer 文本——**防 commit `44960b9` 同类翻译层回归**。
    2. W1 fake server 录制请求体可观测（暴露 `requests: RecordedRequest[]` 给测试用）。
    3. W2 `make-manager` 预检 `pi` 二进制（PATH 上找不到 → 立即 fail with 指引到 §2.7）。
    4. W3 idle kill 用例减小 `idleTimeoutMs` 加速（避免 5min 默认时间）。
    5. W4 fixture `auth.json` 必须存在才开测（避免 401 混淆主测试）。
    6. W6 fixture work_dir 用临时副本（避免污染仓库本身）。
  - **2 Suggestion 合理跳过**：(S5) `.gitignore` 冗余行（`tests/integration/.tmp/` 已覆盖 `tests/integration/.tmp/**/*.jsonl` 等所有子树）——按"宁多勿漏"原则保留显式 mention；(S7) `cleanup` SIGKILL 兜底——bridge `stop()` 已内建 `SIGTERM → 1s → SIGKILL`，重复套娃无收益。
- **文件清单**：commit `3c6656d`（主体）+ `bb6293b`（review 修复）；`tests/integration/`（21 文件：6 测试 + 5 helper + 1 fixture 扩展 + 4 fixture agent-dir 文件 + 2 配置 + .gitignore 加 2 行）+ 根 `package.json`（加 2 脚本）。文档侧：原 `testing` 规划文档顶部状态行 + §2 状态行 + §2.4.3 补注 + §2.5 三核实点标记实证 + §2.6 覆盖行 + §2.7 CI 门控改完成时态（2026-09-08 拆解：原 `testing` 文档删除、§2 + §4 + 实施期 review/关键 wire 发现承接至 [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]]，§3 无头浏览器 E2E 挂账于 current-state TODO）；`docs/current-state.md` 任务看板加本任务行 + TODO 撤挂账 + 最近变更加 2026-09-08 摘要 + 依赖链补 m3/10 + 2026-09-08 同日补一条 "原 `testing` 规划 → ADR-0008" 拆解注记。

## 关键发现（实施期沉淀——值得后续任务复用）

1. **LLM 侧失败的真实 wire 形状**（pi 0.85.1 `rpc-mode.js:298-323` 实证）——prompt 的 `command_result` 在 preflight 通过时即**同步**返回 `success:true`（先于 LLM 调用），LLM 侧失败只在事件流体现：`message_end` 事件带 `stopReason:'error'` + `errorMessage`（Anthropic SDK 错误文本）。**修正原 §2.4.3 表述**（2026-09-08 承接至 [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md#关键-wire-发现pi-0851-实证实施期沉淀|ADR-0008 关键 wire 发现 #1]]）：原"pi-ai 会把它归一化为 pi RPC `error: string`"**仅适用于 RPC 层失败**（如非法命令）；LLM 调用失败走的是事件流而非 `command_result` 失败。`03-error-normalization` 用例钉此行为（`command_result.success === true` + 紧跟 `message_end{stopReason:'error'}`）。
2. **steer 端到端钉死**——`06-multi-turn` 6.2 用例：running 中 steer → pi 在 turn 间消化队列重新进 LLM → 假 server 第二轮脚本因 steer 内容进入对话才触发 + `fakeServer.requests` 录制直接断言 bridge→pi→LLM 全链路携带 steer 文本。**专门防 `44960b9` 同类翻译层回归**（commit 描述提到"未来字段再变只需改一处 `translateToPiWire`"，但忘了测试也得变；本用例把"测试也会跟着变"钉死）。
3. **`--session` 恢复语义**——pi 0.85.1 恢复 session 后对 prompt 的处理不确定（可能立即 `agent_settled` 或退出）。**测试钉 bridge 侧契约**（`spawnCount→2`、二次 spawning），完整会话往返语义由 `02.2 get_messages` 路径覆盖。
4. **follow_up 语义**——idle 后发 follow_up 只入队不触发新 turn；running 中入队才会在当前 turn 结束后被消化（pi 0.85.1 `rpc-mode.js` follow_up handler）。`06.3` 用例按此重写。
5. **fixture 扩展免 typebox**——pi-ai 只读 `parameters` 的 `properties+required`，纯 JSON-Schema 对象即可 round-trip；**无需 typebox 依赖、无模块解析问题**（typebox 是 pi 的 virtualModule，host filesystem 无需 `node_modules/typebox`）。`test-ext.ts` 头部 JSDoc 详细记录此约定与未来迁移路径。
6. **工程细节**：(a) `vitest.integration.config.js` 用 `.js` —— ESLint `projectService.allowDefaultProject` 只认 `*.js/mjs/cjs`，`.ts` 会撞 ESLint project 解析；(b) `resolve.alias` + `tsconfig.paths` 双通道把 `@remotepi/{shared,bridge}` 映射到 `packages/*/src` 源码（`tests/integration/node_modules` 无 workspace symlink，必须 alias + paths 并用）。

## 与 ADR-0008 的对应关系（原 §2 拆解承接）

| ADR-0008 子节 | 实施态 |
|-------------|--------|
| §1.1 集成测试 = 真 pi + 假 LLM server + 隔离 agent-dir fixture | ✅ 落地——零外网 + fixture port 0 + 进程内 http server |
| §1.2 in-process 驱动 `PiProcessManager`（否决真 bridge 进程 + 假 WSS worker harness） | ✅ `PiProcessManager` 既有 seam 直接消费；`packages/*` 零改动 |
| §1.3 位置 `tests/integration/` 顶层 + 独立 `vitest.integration.config.js` + 根脚本 | ✅ `.js` 扩展因 ESLint `projectService.allowDefaultProject` + `resolve.alias` + tsconfig `paths` 双通道；CI 四步 workflow 零改动（无 pi 二进制有意跳过） |
| §1.4 4 类阻塞弹窗脚本化触发（fixture 扩展 `trigger_dialog`） | ✅ 1 fixture 扩展 `test-ext.ts`（免 typebox 依赖——pi-ai 只读 `parameters` 的 `properties+required`） |
| §1.5 密闭性三层防线（baseEnv 剥离 + fake-claude-* 校验 + loopback 来源） | ✅ 三层均落地 |
| §关键 wire 发现 | ✅ 4 条均钉死（LLM 失败事件流 / `--session` 恢复契约 / follow_up 时机 / steer 端到端断言） |
| §升级体检仪式 | ✅ 本套件即"体检清单的回归化"——未来 pi 升级时跑 `pnpm test:integration`，**任一 it 红即等价于体检清单 6 项偏差** |

## 依赖

- 依赖 [[tasks/m3/04-bridge-pi-process.md|04-bridge-pi-process]]（`PiProcessManager` seam 验证对象）
- 依赖 [[tasks/m3/05-bridge-popup-core.md|05-bridge-popup-core]]（`ExtensionUIRouter` 4 类入列的端到端验证对象）
- 依赖 [[tasks/m3/09-host-shared-agent-dir.md|09-host-shared-agent-dir]]（共享 agent 目录语义下 fixture 仍可注入 `PI_CODING_AGENT_DIR` 覆盖，与 ADR-0007 §3.5 高级覆盖一致）

## 后续挂账（移交任务 08 + 路线图）

- **无头浏览器 E2E**（原 `testing` §3，2026-09-08 拆解时挂账于 [[current-state.md]] TODO）已立项——见 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]]（已接受·待实施，2026-09-08，与本 ADR 同日成对）。本套件覆盖 bridge wire 层；浏览器 UI 层（ChatView 渲染、F5 仪式、双 tab 先答者胜）实施任务待排期。**任务 08 注记**：脚本化触发基建已就绪（bridge wire 层，由 ADR-0008 §1.4 钉死），web UI 层仍需手测验收直至 ADR-0009 实施完成。
- **pi 升级体检仪式**（原 `testing` §4，2026-09-08 承接至 [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md#升级体检仪式pi-升级时真实形状比对|ADR-0008 §升级体检仪式]]）——本套件即"体检清单的回归化"：未来 pi 升级时跑 `pnpm test:integration`，**任一 it 红即等价于体检清单 6 项偏差**，§升级体检仪式流程落地更彻底。

## follow-up 补记（任务 12 review 期间顺带修复，2026-09-08）

任务 12 review 期间（S8 跟进项）发现 `eslint.config.js` 的 `projectService` ignores 漏配 `tests/integration/.tmp/**`——本任务实施时 fixture 落盘产物（隔离目录 + 假 LLM 录制 + work_dir 副本）落 `tests/integration/.tmp/<run-tag>/`，未加 ignore → ESLint typecheck 试图解析 `jsonl` / `auth.json` 等 fixture 临时文件，触发非项目源码的 false positive 风险。**本任务未及时补配**（commit `3c6656d` + `bb6293b` 均未动 `eslint.config.*`，与 §完成情况「零改动」表述一致——漏配非主动零改动）。

**补配位置**：任务 12 主体 commit `127595c` 在改 `eslint.config.js`（加 `tests/e2e/.tmp/**` / `tests/e2e/playwright-report/**` / `tests/e2e/test-results/**` 3 条 ignore）时**顺带补配**本任务的 `tests/integration/.tmp/**`，共 4 条 ignore 一次性提交。本任务的「零改动」表述需补注：实际为「**本任务自身零改动**；下游任务 12 review 期间发现漏配、顺带补配覆盖」。

**教训一句**：任务 10 review 期间 6W 全修 / 2S 合理跳过的清单里，ESLint `projectService` ignores 未列入排查项——既因本任务实施时 ESLint 还未在 flat config `projectService` 模式下报错（fixture 临时文件由 vitest 进程隔离、不走 `pnpm lint`），也因 review 时未对 fixture 落盘产物路径做覆盖性检查。下次类似任务（`tests/*/` 顶层新建）需把 `eslint.config.*` 改为「`tests/*/.*` 显式 ignore」并入 review 必查项。
