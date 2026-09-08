# 0008. 假 LLM server + 隔离 pi 集成测试（bridge wire 层回归套件）

- 日期：2026-09-08
- 状态：已接受
- 背景：
  M3 联调（commit 收口于 2026-09-07）共暴露 **12 个**问题，其中 **8 个**直接根因是"bridge 单测层与 pi 实物行为不一致"——bridge 的 `FakeChild` 单测（193 条）只验证 bridge 自己的解析 / 翻译 / 状态机逻辑，**永不验证真实 pi 是否真的接受这些帧**；凡未实测的 wire / 落盘细节均不可信（cwd 编码 / bridge→pi 翻译层 / error 归一 / 握手写入 / spawn cwd / child error / pi 裸事件对象分发 / web 提取器位置键 8 笔均落在这条铁律之下，详见 [[current-state.md#最近变更]] 2026-09-07 端到端修复轮收口条目）。

  同时存在三类测试基建盲区：
  1. **真 pi 集成 = 0（非回归资产）**——真实 `pi --mode rpc` 仅在用户手测 + 一次性 `/tmp` 探针时被驱动；每次升级 pi（roadmap §6 待决"pi 版本锁定策略"）都得手工走一遍 M3 验收 14 条清单，无任何回归套件可依赖。
  2. **4 类阻塞弹窗无脚本化触发手段**——bridge 单测 FakeChild 模拟不出"pi 内部扩展真的发 `extension_ui_request`"，用户手测又依赖手头有触发插件（如 vimmode setStatus 噪音）；这是任务 08 三端联调手测中"4 类弹窗"长期挂账的根因。
  3. **CI 无 pi 二进制**——GitHub Actions runner 上没装 pi、无法 `pi auth`，跑真链路测试只会假绿；需要让 CI 完全跳过本套件、仅本机可跑。

  本 ADR 是 M3 集成测试基建落地的设计决策——承接用户 2026-09-07 裁定（暂不实施、先落文档；假 server 走 Anthropic Messages API 而非 OpenAI 格式），固化 2026-09-08 实际实施的两笔 commit（`3c6656d` 主体 + `bb6293b` review 修复）背后的设计要点，让"假 LLM + 真 pi + 隔离 agent-dir"成为可重复、可断言、可升级的回归资产。

  浏览器层 E2E（Playwright 驱动 wrangler dev + bridge + 真 pi + 假 LLM fixture，验证 ChatView 渲染 / F5 仪式 / 双 tab 先答者胜）超出本 ADR 范围，已另立 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] 承载；本套件仅覆盖 bridge wire 层。

- 决策：

  ### 1. 集成测试 = 真 `pi --mode rpc` 子进程 + 假 LLM server + 隔离 agent-dir fixture

  - **真 `pi --mode rpc` 子进程**——不做进程内 mock、不做桩；用 bridge 同一套 `PiProcessManager` seam 驱动真 pi 子进程，断言基于真 `stdout` JSONL 流；这是把"bridge→pi wire 真形"从"用户手测发现"挪进 CI 可跑回归套件的核心。
  - **进程内假 LLM server**——Node `http.createServer` 绑 `port: 0` 拿随机端口，回填进 fixture `models.json` 的 `baseUrl`；pi 启动后所有 LLM 请求都打到这个进程内 server，**零外网**。响应格式按 **Anthropic Messages API** 规范（用户裁定 2026-09-07，替代 scout 报告中的 OpenAI 格式）：
    - `POST /v1/messages` + 请求头 `content-type: application/json` / `x-api-key: <auth.json 的 key>` / `anthropic-version: 2023-06-01`；
    - SSE 事件序列**铁律**：`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`（顺序不可换、缺一不可，由 pi-ai SDK `anthropic-messages` contract 强校验）；
    - 错误响应（非流式 JSON）：`{type: "error", error: {type, message}}` 标准 Anthropic error 形状。
  - **隔离 agent-dir fixture 四件套**：
    - `models.json` —— 自定义 provider `fake-anthropic`，`api: 'anthropic-messages'` + `baseUrl: http://127.0.0.1:<randomPort>` + `apiKey: fake-anthropic-test-key` + 1 个 fake model（id `fake-claude-haiku-4-5`）。
    - `settings.json` —— `defaultProvider` + `defaultModel` 两字段，bridge fixture 不需发 `set_model`。
    - `auth.json` —— `{ type: 'api_key', key: 'fake-anthropic-test-key' }`，让 pi 启动握手不报"未配置 provider"；假 server 通过对账 `x-api-key` 头来拒绝非 fake key 请求。
    - `extensions/test-ext.ts` —— 脚本化触发 4 类弹窗的 fixture 扩展（详见决策 4）。
  - **环境变量三件套**：bridge spawn pi 子进程时由 fixtures 子进程入口脚本层注入（非 bridge 行为变更）：
    - `PI_CODING_AGENT_DIR=<fixture>/agent-dir` —— 完全封装 pi 整套目录，**不污染**用户宿主 `~/.pi/agent`；
    - `PI_OFFLINE=1` —— 关版本检查 / telemetry / 模型目录刷新（scout 在 pi 源码层实证：这三面被关但不影响 `baseUrl` 转发；即假 server 仍能接收全部 `POST /v1/messages` 请求）；
    - 三个 env 与 ADR-0007 §决策 3 的"`PI_CODING_AGENT_DIR` 高级覆盖"语义一致——本套件用 env 强制指向 fixture，宿主共享 agent 目录不参与。

  ### 2. in-process 驱动 bridge `PiProcessManager`；否决"真 bridge 进程 + 假 WSS worker" harness

  - **采用** in-process 驱动：测试 case 直接 `new PiProcessManager({ ... })` → 调 `start()` / `handleEnvelope()` / `cleanup()`，断言基于 manager 暴露的 outbox / phase / blocked_on 等回调。
  - 既有 `PiProcessManager` seam（`baseEnv` / `idleTimeoutMs` / `sigkillDelayMs` / `onOutboundEnvelope` 5 个回调）已包含测试需要的所有扩展点（任务 04 / 05 review 时即考虑过测试场景），**`packages/*` 零改动**即印证"seam 已就绪"的设计有效。
  - **否决**"真 bridge 进程 + 假 WSS worker" harness：成本高（要起 bridge CLI 子进程 + 假 worker WSS 帧层 + 端口编排）、收益低（WSS 层已有 client 单测覆盖），且本套件目标是 bridge→pi 翻译层回归而非 WSS 端到端。
  - **浏览器层 E2E 已另立 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]]**——本 ADR 仅覆盖 bridge wire 层；Playwright 驱动 wrangler dev + bridge + 真 pi + 假 LLM fixture 验证 ChatView 渲染 / F5 仪式 / 双 tab 先答者胜属浏览器 UI 层断言，超出本套件范围。

  ### 3. 位置 `tests/integration/` 顶层 + 独立 `vitest.integration.config.js` + 根脚本 `pnpm test:integration` / `typecheck:integration`

  - 位置选 `tests/integration/` 顶层而非 `packages/bridge/test/integration/`，原因：避免 vitest 默认 workspace（`vitest.workspace.ts` 的 `packages/*` 模式）误拾取；本套件 CI 跳过、若并入默认集合会造成"测试套件膨胀但实际不跑"的语义混淆。
  - **vitest config 用 `.js`**——ESLint `projectService.allowDefaultProject` 只认 `*.js` / `mjs` / `cjs`，`.ts` 会撞 ESLint project 解析。这是工程上唯一坑点，已在 commit `3c6656d` 头部注释钉死。
  - **vitest `resolve.alias` + tsconfig `paths` 双通道**映射 `@remotepi/{shared,bridge}` → `packages/*/src` 源码（`tests/integration/node_modules` 无 workspace symlink，必须 alias + paths 并用）。
  - **根 `package.json` 加两脚本**：`"test:integration": "vitest run --config tests/integration/vitest.integration.config.js"` + `"typecheck:integration": "tsc -p tests/integration/tsconfig.json"`。
  - **CI 四步有意跳过本套件**（GitHub Actions 无 pi 二进制，防假绿）：`.github/workflows/` 零改动。
  - 既有 281 条单测（`pnpm -r test` 跑）不变；本套件不并入 `pnpm test`，仅 `pnpm test:integration` 显式触发。

  ### 4. 4 类阻塞弹窗脚本化触发：fixture 扩展 `trigger_dialog` 工具

  这是任务 08 长期挂账"4 类弹窗脚本化触发基建"的解决方案——bridge 单测 FakeChild 模拟不出"pi 内部扩展真的发 `extension_ui_request`"，用户手测又依赖手头有触发插件。

  - **fixture 扩展** `extensions/test-ext.ts`：`pi.registerTool` 一个 `trigger_dialog` 工具，参数纯 JSON-Schema 对象（`{kind: 'select'|'confirm'|'input'|'editor', options?, message?, prefilled?}`，无 typebox 依赖——pi-ai 只读 `parameters` 的 `properties+required`，纯 JSON-Schema 即可 round-trip；typebox 是 pi 的 virtualModule，host filesystem 无需 `node_modules/typebox`）。
  - **执行链**：测试在 prompt 里说"调用 `trigger_dialog`（kind=select, options=A|B）" → pi 真调用工具 → 扩展 `execute(args, ctx)` → 调 `ctx.ui.select/confirm/input/editor` → bridge 端 `ExtensionUIRouter` 入列 → 测试回写 `extension_ui_response`。
  - **覆盖 5 类 `ctx.ui.*`**：select / confirm（true + false 两路） / input / editor / cancelled——共 6 个 it case（`04-extension-dialogs` 6 条）。
  - 端到端跑通即"4 类阻塞弹窗 wire 真形"有了回归资产；用户手测时只需 1 次冒烟（vimmode setStatus 噪音）即可确认 UI 渲染，其余断言全部由测试覆盖。

  ### 5. 密闭性三层防线（防误连真 LLM 服务商）

  - **第一层：baseEnv 剥离宿主 provider key**——bridge 既有 `baseEnv` seam 已包含 11 个 provider key 剥离（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `AZURE_OPENAI_API_KEY` / `GROQ_API_KEY` / `MISTRAL_API_KEY` / `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` / `XAI_API_KEY` / `AWS_*` / `VERTEX_*` 等），从源头上避免 pi 用宿主凭据去敲真服务商。
  - **第二层：假 server 拒非 `fake-claude-*` model**——任何 `POST /v1/messages` 请求的 `model` 字段必须以 `fake-claude-` 开头，否则立即返 400；这是 fail-fast 防御，若 fixture 漏配或 bridge 误用真 model，假 server 立刻报错而不静默。
  - **第三层：loopback 来源校验**——假 server 拒绝任何非 `127.0.0.1` 来源请求（防被宿主网络栈误转发到外网）。
  - **PI_OFFLINE=1** 进一步关版本检查 / telemetry / 模型目录刷新（不关 baseUrl 转发）。
  - 三层合起来 = 测试期间零外网、零凭据泄漏、零误连；本机无网也能跑（前提：pi 二进制已装）。

- 影响：

  ### 正面

  - **真 pi 从"用户手测 + 一次性 /tmp 探针"升级为回归资产**——bridge→pi wire 真形（cwd 编码 / 翻译层字段名 / error 形状 / 握手写入 / spawn cwd / child error / pi 裸事件对象分发 / web 提取器位置键 8 笔）有了 CI 可跑的回归套件；未来再踩"bridge 假设 vs pi 实物"型 bug 时，**首先应该扩展本套件**而不是再写新单测。
  - **4 类阻塞弹窗脚本化解锁**——任务 08 三端联调 14 条手测清单中"4 类弹窗可交互"从无限挂账变为可自动断言；web UI 层验收仍需用户手测，但 wire 层无须手动。
  - **wire 假设显式化**——bridge 的所有 pi 假设（启动握手响应形状、event 名清单、落盘编码、extension_ui_request 方法清单、错误形状、idle-kill 行为）都在 fixture + 测试断言中显式表达，新增 pi 行为假设时必须先扩测试。
  - **升级体检仪式自动化兜底**（详见"升级体检仪式"小节）——六项清单偏差由 `pnpm test:integration` 任一 it 红直接捕获；任务 08 §4 升级体检仪式的"体检不通过"路径升级为"修集成测试 case 而不是再写新单测"。

  ### 代价

  - **本机依赖 pi 0.85.1**——测试前置 `make-manager` 预检 `pi` 二进制在 PATH（`spawnSync 'pi --version'`），缺 pi 时 throw 带清晰指引（指本 ADR §3）；CI 无 pi 故 CI 跳过。
  - **pi 升级或需维护假 server SSE 兼容**——pi 升级到新主版本（0.86+ / 1.x）后，pi-ai SDK 对 `anthropic-messages` contract 的实现可能微调（SSE 事件顺序 / `delta.type` 取值 / 错误形状），假 server 需同步调整；但本套件本身就是升级体检的工具——任一 it 红即捕获，比"用户手测发现 14 个问题"成本低得多。
  - **runtime ~11s**（30 条测试 / 6 文件）——vs 单测的 281 条 ~3s，多 8s；本机专用，CI 不跑；可接受。
  - **`.tmp` 运行时目录依赖清理纪律**——`tests/integration/.tmp/<run-tag>/` 是 fixture 隔离目录，`.gitignore` 已加 2 行（`tests/integration/.tmp/` + `tests/integration/**/sessions/`），但本机多轮运行后可能堆积；测试 case 自身负责 `afterEach` cleanup（`make-fixture` helper 内的临时副本与 fixture agent-dir 在 case 结束 `rm -rf`）。

- 备选否决：
  - **真 LLM 服务商（Anthropic / OpenAI）**——成本（按 token 计费）、不确定性（每次响应可能不同 → 断言难写）、密钥管理（测试需真 API key 进 CI secrets），三方均否决。
  - **OpenAI Completions 格式**——scout 报告最初建议 OpenAI，但用户 2026-09-07 裁定改 Anthropic（pi 0.85.1 默认走 anthropic-messages contract，与 pi 自身使用的 provider 一致；改 OpenAI 等于在 pi 和 LLM 之间插入翻译层，多一层不一致源）。
  - **无测试基建维持手测**——M3 联调 12 问题中 8 笔源于"bridge 假设 vs pi 实物"，已经证伪"手测能兜住所有问题"的假设。
  - **真 bridge 进程 + 假 WSS worker harness**——成本高（CLI 子进程 + WSS 帧编排 + 端口编排）、收益低（WSS 层已有 client 单测覆盖），否决。

- 实施纪要：
  - **commit `3c6656d`（主体）** + **`bb6293b`（review 修复）**。
  - **30 条测试 / 6 文件**：6 测试文件 30 条全绿 ≈11s —— `00-smoke` 1 + `01-happy-path` 6 + `02-session-persistence` 4 + `03-error-normalization` 3 + `04-extension-dialogs` 6 + `06-multi-turn` 10。
  - **5 helper**：`fake-llm-server`（进程内 `http.createServer` 绑 port 0，按 script 回放 SSE 事件流 + 录制所有 request body `fakeServer.requests: RecordedRequest[]`）+ `make-fixture`（建 `tests/integration/.tmp/<run-tag>/agent-dir/` 隔离目录 + 工作目录的临时副本）+ `make-manager`（预检 `pi` 二进制在 PATH，启动 `PiProcessManager`）+ `wait-for`（poll 异步条件通用工具）+ `assertions`（envelope / phase / blocked_on 共享断言）。
  - **1 fixture 扩展** `extensions/test-ext.ts`（`pi.registerTool` 一个 `trigger_dialog` 工具覆盖 5 类 `ctx.ui.*`）。
  - **fixture agent-dir 四件套**（`models.json` + `settings.json` + `auth.json` + `extensions/test-ext.ts`）。
  - **覆盖面**（5 行 §2.6 + 2 新增）：
    - handshake + 流式 / idle kill 唤醒链 / session 落盘 / `--session` 恢复 / LLM 错误路径 / 4 类弹窗×6 / 多轮 + steer + follow_up。
  - **验收命令面全绿**：基线 281 单测不变 + 4 包 typecheck + `typecheck:integration` + lint + build。
  - **零改动面**：`packages/*` / `worker/` / `.github/` / 根 `tsconfig` / `eslint.config.*` —— `PiProcessManager` seam 直接消费。

- review 纪要：
  - **零 Critical**。
  - **6 Warning 全修**（关键排序）：
    1. **W5（最关键）steer 用例补端到端断言**——除 `command_result` 成功外，假 server 第二轮脚本因 steer 内容进入对话才触发 + `fakeServer.requests` 落线断言（"steer 文本出现在 post-steer LLM 请求体里"），真正钉死 bridge→pi→LLM 全链路携带 steer 文本——**防 commit `44960b9` 同类翻译层回归**。
    2. W1 fake server 录制请求体可观测（暴露 `requests: RecordedRequest[]` 给测试用）。
    3. W2 `make-manager` 预检 `pi` 二进制（PATH 上找不到 → 立即 fail with 指引到本 ADR §3）。
    4. W3 idle kill 用例减小 `idleTimeoutMs` 加速（避免 5min 默认时间）。
    5. W4 fixture `auth.json` 必须存在才开测（避免 401 混淆主测试）。
    6. W6 fixture work_dir 用临时副本（避免污染仓库本身）。
  - **2 Suggestion 合理跳过**：(S5) `.gitignore` 冗余行按"宁多勿漏"保留显式 mention；(S7) `cleanup` SIGKILL 兜底——bridge `stop()` 已内建 `SIGTERM → 1s → SIGKILL`，重复套娃无收益。

- 关键 wire 发现（pi 0.85.1 实证，实施期沉淀）：
  1. **LLM 侧失败走 `message_end{stopReason:'error'}` 事件流**——prompt 的 `command_result` 在 preflight 通过时即**同步**返回 `success:true`（先于 LLM 调用），属"preflight 通过 ≠ LLM 调用成功"的契约。LLM 侧失败只在事件流体现：`message_end` 事件带 `stopReason:'error'` + `errorMessage`（Anthropic SDK 错误文本）。bridge 端通过 `normalizePiError` 归一化为 `command_result{success:false, error:{code,message}}` 时机**不**是 LLM 失败路径——`03-error-normalization` 用例钉此行为。**修正原表述**："pi-ai 会把它归一化为 pi RPC `error: string`"**仅适用于 RPC 层失败**（如非法命令——prompt 缺字段 / schema 不匹配，pi 0.85.1 `rpc-mode.js:298-323` 实证），与 LLM 调用失败是两条不同路径。
  2. **`--session` 恢复后 pi 对 prompt 的处理不确定**——pi 0.85.1 恢复 session 后对 prompt 的处理不确定（可能立即 `agent_settled` 或退出）。**测试钉 bridge 侧契约**（`spawnCount→2`、二次 spawning），完整会话往返语义由 `02.2 get_messages` 路径覆盖。
  3. **follow_up 需 running 中入队才会被消化**——idle 后发 follow_up 只入队不触发新 turn；running 中入队才会在当前 turn 结束后被消化（pi 0.85.1 `rpc-mode.js` follow_up handler）。`06.3` 用例按此重写。
  4. **steer 端到端断言 = 假 server 第二轮回显 + `requests` 落线双重验证**——`06-multi-turn` 6.2 用例：running 中 steer → pi 在 turn 间消化队列 → 假 server 第二轮脚本因 steer 内容进入对话才触发 + `fakeServer.requests` 录制直接断言 bridge→pi→LLM 全链路携带 steer 文本。**专门防 `44960b9` 同类翻译层回归**（commit 描述提到"未来字段再变只需改一处 `translateToPiWire`"，但忘了测试也得变；本用例把"测试也会跟着变"钉死）。

- 升级体检仪式（pi 升级时真实形状比对）：

  每次升级 pi 版本（roadmap §6 待决"pi 版本锁定策略"）时由负责升级的开发者跑 `pnpm test:integration`——**任一 it 红即等价于体检清单 6 项偏差**，§偏差处置流程落地更彻底：

  1. **握手响应形状比对**：`get_state` 命令响应的所有字段（`sessionInfo` / `model` / `availableModels` 等）逐一与 `packages/shared` 的 pi schema 对账；字段名、类型、可选性一致才放行。
  2. **事件名清单比对**：`pi --mode rpc` 实际发出的所有 `type` 字符串（`agent_start` / `message_start` / `tool_execution_start` / `extension_ui_request` 等）逐一与 [[architecture/protocol/pi.md#42-pi-家族事件名清单|architecture/protocol/pi.md §4.2]] 的事件名清单对账；新增 / 删除 / 改名要修订该文档。
  3. **落盘编码比对**：session 目录名（`--<cwd 编码>--`，[[current-state.md#最近变更]] 2026-09-07 cwd 修复条实证算法）与 bridge 的 `encodeCwdForPi` 对账；jsonl 单行格式（每个 entry 的字段名 / 类型）逐一抽几条对照。
  4. **extension_ui_request 方法清单比对**：实际可能发出的 method（`select` / `confirm` / `input` / `editor` / `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`）对照 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] §2 入列清单；新增 method 要决定 fire-and-forget 还是入列。
  5. **失败响应 error 形状比对**：RPC 失败时 `error` 字段的实际类型（[[current-state.md#最近变更]] 2026-09-07 bridge→pi 翻译层修复条实证 pi 0.85.1 恒为 string）对照 `packages/bridge/src/pi-process.ts` 的 `normalizePiError` 六分支；类型签名变化要扩展归一化。
  6. **idle / kill 行为比对**：bridge 的 5min idle SIGTERM→1s→SIGKILL 序列仍能让新版本 pi 干净退出（exit code = 0 或预期非零）；崩溃路径行为与 [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] §3 三路径一致。

  **2026-09-08 起可部分自动化**：`pnpm test:integration` 任一 it 红即拦截六项对应的回归；不再需要手工逐项走对照清单，但仍需"测试已修 + 全绿 + 收口记录到 [[current-state.md]] 最近变更"才视为体检通过。

  **体检结果落到哪里**（流程保留）：
  - **通过** → [[current-state.md]] 最近变更追加一条"YYYY-MM-DD pi 升级至 X.Y.Z — `pnpm test:integration` 全绿 + 体检 6 项通过"。
  - **不通过** → 暂停升级，回到本套件扩展上：
    - 字段名 / 类型变 → 写集成测试 case 钉死新形状。
    - 旧字段缺失 / 重命名 → 改 `packages/shared` pi schema + 写 ADR 修订注记。
    - 行为语义变（如 idle kill 改了退码） → 改 bridge 处理 + 改对应 ADR。

  **底线**：不允许 bridge 在 pi 升级后"实际行为有变但测试全绿"——M3 联调 8 个 wire 硬伤都属于这一类（cwd 编码 / 翻译层字段名 / error 形状 / 握手写入缺失 / spawn cwd 缺失 / child error 裸奔 / pi 裸事件对象分发 / web 提取器位置键）。**2026-09-08 起**套件即升级回归防线，体检清单 6 项偏差全部可由 `pnpm test:integration` 任一 it 红直接捕获——"体检不通过"路径升级为"修集成测试 case 而不是再写新单测"。

- 备选否决：
  - **真 LLM 服务商**（Anthropic / OpenAI）：成本 / 不确定性 / 密钥管理三难，三方均否决。
  - **OpenAI Completions 格式**：用户 2026-09-07 裁定改 Anthropic（pi 0.85.1 默认走 anthropic-messages contract，与 pi 自身使用的 provider 一致；改 OpenAI 等于在 pi 和 LLM 之间插入翻译层）。
  - **无测试基建维持手测**：M3 联调 12 问题中 8 笔源于"bridge 假设 vs pi 实物"已证伪"手测能兜住所有问题"的假设。
  - **真 bridge 进程 + 假 WSS worker harness**：成本高（CLI 子进程 + WSS 帧编排 + 端口编排）、收益低（WSS 层已有 client 单测覆盖），否决。
  - **Playwright 浏览器层 E2E（超出本 ADR 范围）**：已另立 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] 承载——浏览器 UI 层断言（ChatView 渲染 / F5 仪式 / 双 tab 先答者胜）超出本套件范围。

- 参考：
  - 任务 [[tasks/m3/10-integration-test-infra.md|10]] —— 本套件的事后补录任务文件（done）。
  - 任务 [[tasks/m3/08-docs-and-validation.md|08]] —— 三端联调 14 条手测清单（活任务，本套件为其中"4 类弹窗脚本化触发"提供自动化兜底）。
  - commit `3c6656d`（主体）+ `bb6293b`（review 修复）。
  - [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] —— session 生命周期、idle kill、5min 超时；本套件的 5min 测试用更小 `idleTimeoutMs` 加速。
  - [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] —— extension UI 4 类弹窗；本套件的 `04-extension-dialogs` 6 条 it 钉死 4 类入列 + cancel 5 类消化的端到端真形。
  - [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] —— bridge 复用宿主机 pi agent 目录；本套件用 `PI_CODING_AGENT_DIR` env 高级覆盖，宿主共享目录不参与。
  - [[architecture/protocol/pi.md|architecture/protocol/pi.md]] —— pi RPC 协议细节（事件名 / 命令 schema），本套件所有断言以该协议为契约。
  - 原 `testing` 规划文档（2026-09-07 用户裁定建，2026-09-08 拆解：§2 + §4 承接至本 ADR；§3 无头浏览器 E2E 由 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] 承载，已接受、待实施）。
