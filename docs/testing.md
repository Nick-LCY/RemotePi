# 测试规划

> 跨 M3 联调教训沉淀的统一测试基建路线图。**当前状态：仅完成 §1 分层现状梳理 + §2 假 LLM + 隔离 pi 集成测试方案的可研挂账；尚未实施**。本文档由 archivist 在用户裁定（2026-09-07：暂不实施、先落文档 + 假 server 用 Anthropic Messages API 格式）后建立，作为后续基建任务的入口。修改本文需在 [[current-state.md|current-state]] 的最近变更追加修订注记。

## 目录

1. [测试分层现状](#1-测试分层现状)
2. [已挂账方案：假 LLM server + 隔离 pi 集成测试](#2-已挂账方案假-llm-server--隔离-pi-集成测试)
3. [展望：无头浏览器端到端](#3-展望无头浏览器端到端)
4. [升级体检仪式：pi 升级时真实形状比对](#4-升级体检仪式pi-升级时真实形状比对)

---

## 1. 测试分层现状

> 2026-09-07 快照。M3 联调踩坑之后，对"现在到底有什么 / 缺什么"的盘点。

### 1.1 已有测试面

| 包 / 维度 | 测试形态 | 数量（2026-09-07 快照） | 覆盖范围 |
|-----------|---------|-----------------------|---------|
| `packages/shared` | Vitest 单元（zod schema + envelope 解析） | ~83 条 | envelope v2 全 9 个 pi schema + 9 个 control type + blocked_on + extension_ui_response refine |
| `packages/bridge` | Vitest 单元（`FakeChild` mock 子进程） | ~186 条 | 5 相位状态机 / 启动握手 / 5min idle kill / 自主 kill / exit 三路径 / session 扫描 / outstanding 表 / ExtensionUIRouter / wire 翻译三态 / 多 web 先答者胜 / 广播原则 / clearAll / `translateToPiWire` / `normalizePiError` / `encodeCwdForPi` |
| `worker/` | 无 | 0 | DO 房间路由、转发、广播、握手回显 — **零测试基建** |
| `packages/web` | 无（vitest 基建未建） | 0 | ChatView / DialogHost / WsClient / 6 出站方法 / 恢复仪式 / F5 — **零测试基建** |
| 真 pi 集成 | 仅用户手测 + 一次性 `/tmp` 探针 | 0（**非回归资产**） | 用户实测发现 bridge→pi 翻译层字段错位、cwd 编码占位实现错误、spawning 死锁 |

### 1.2 现有覆盖的强项与盲区

**强项**：

- shared 包测试密度高（83 条 / 22 文件），是契约层的核心防线；envelope 解析回归靠它兜底。
- bridge 的 `FakeChild` 单测能跑通完整状态机、wire 翻译、ExtensionUIRouter 全部 4 类入列与 5 类消化，配合 `vi.useFakeTimers()` 钉死 idle kill / extension_ui 超时镜像的时序。

**盲区**：

- bridge 单测只覆盖 **bridge→pi 的送出与解析**，**永远不验证真实 pi 是否真的接受这些帧**——所有"pi 字段名 / RPC schema 形状 / 落盘编码"的真伪都不在测试闭环里。
- worker / web 缺测试基建意味着：DO 路由、握手回显 subprotocol、WSS 多端广播、ChatView 渲染、断线重连恢复仪式 —— 任何回归都靠用户浏览器手测兜底。
- 真实 pi 仅在用户手测时被驱动；**没有回归套件**。每次升级 pi（roadmap §6 待决"pi 版本锁定策略"）都得手工走一遍 14 条 M3 验收清单（见 [[tasks/m3/08-docs-and-validation.md|tasks/08 用户手测交接]]）。

### 1.3 M3 联调教训：6 / 12 问题源于"文档假设 vs pi 实物"偏差

M3 联调共暴露 **12 个**问题（详见 [[current-state.md#最近变更]] 2026-09-07 三条 + 历史变更的 9 条），其中 **6 个**直接根因是"bridge 单测层与 pi 实物不一致"：

1. **cwd 编码占位实现**（commit `cc00a3f`）— `encodeURIComponent(cwd).replace(/%/g,'')` 与 pi `session-manager.js` 的真实算法不一致，扫描落空 → spawn 不带 `--session` → 每次都是新会话。**单测层无法发现**，因为测试只 mock 了 bridge 自己的编码。
2. **bridge→pi 命令帧字段名错位**（commit `837d1de`）— pi 0.85.1 RPC schema 要求 `prompt` 用 `message` 字段，bridge 误发 `content`，pi 读 `undefined` 崩。**单测层无法发现**，因为 FakeChild 不验证 schema 严格匹配。
3. **bridge→pi 失败响应 `error` 形状**（commit `44960b9`）— pi 失败响应 `error` 恒为 `string`，bridge 透传给 worker schema 拒收。**单测层无法发现**，因为 FakeChild 模拟的是 happy path。
4. **spawning 握手写入缺失**（commit `52557fb`）— bridge spawn 后从不写 `get_state`，pi 静默等输入、bridge 等响应死锁。**单测层无法发现**，因为 FakeChild 默认不模拟"等输入就报错"。
5. **spawn cwd 缺失**（commit `52557fb` 同条）— `PiSpawnOptions` 无 `cwd`，pi 跑在 bridge 进程目录，session 落盘目录与扫描目录错位。**单测层无法发现**，因为 FakeChild 不真正 spawn。
6. **child error 裸奔**（commit `52557fb` 同条）— 无 handler 时 `ENOENT` 触发 `uncaughtException` → bridge `exit(1)`。**单测层无法发现**，因为 FakeChild 走的是 happy exit。

> **教训一句**：bridge 的 FakeChild 单测密度虽高，**但它只验证 bridge 自己的逻辑，不验证 pi 的真实行为**——凡未实测的 wire / 落盘细节均不可信（[[current-state.md#最近变更]] 2026-09-07 cwd 修复条尾部）。

---

## 2. 已挂账方案：假 LLM server + 隔离 pi 集成测试

> **状态**：已验证可行（scout 在 pi 0.85.1 源码层面走查四件套配置），**待实施**。**格式裁定**：假 server 走 **Anthropic Messages API**（用户裁定 2026-09-07，替代 scout 报告中的 OpenAI 格式）。

### 2.1 设计动机

把"真实 pi 的行为"从"用户手测"挪进 CI 可跑的回归套件：

- **真实 pi 进程 + 自家假 LLM server**（不是真 LLM 服务商）—— 本地、确定性、零成本、可断言。
- **隔离目录三件套**（models.json / settings.json / auth.json） + `PI_CODING_AGENT_DIR` + `PI_OFFLINE=1` —— 把 pi 完全封装进 fixture 目录，**不污染**用户宿主 `~/.pi/agent`，不连真实 LLM 服务商。
- **脚本化 SSE 响应** —— 测试用例在 js 里声明"这段 prompt 应该走什么流式事件"，无需 LLM 服务商配合。

### 2.2 隔离目录四件套（bridge fixture 形态）

bridge fixture 准备在 `tests/integration/fixtures/agent-dir/` 下，bridge 子进程启动时通过 `PI_CODING_AGENT_DIR=<fixture>` 注入。下文示例以 Anthropic provider 为例：

#### 2.2.1 `models.json` —— 自定义 provider 指向假 server

```json
{
  "providers": {
    "fake-anthropic": {
      "baseUrl": "http://127.0.0.1:<randomPort>",
      "apiKey": "fake-anthropic-test-key",
      "api": "anthropic-messages",
      "models": [
        {
          "id": "fake-claude-haiku-4-5",
          "name": "Fake Claude Haiku 4.5",
          "contextWindow": 200000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

**字段说明**（待实施时按 pi 0.85.1 实际 schema 校准）：

- `providers.<name>.baseUrl` —— 假 server 的入口，测试起进程内 `http.createServer` 绑 port 0 拿到随机端口后回填此处。
- `providers.<name>.api` —— pi-ai SDK 的 contract 名，**anthropic 取值以 docs/models.md 为准**（该文档待建；本 fixture 当前按 `"anthropic-messages"` 占位，实施时需对照 pi-ai 源码实证一次）。
- `providers.<name>.apiKey` —— 假 server 只校验请求头 `x-api-key` 是否为这个值，校验通过即可。
- `providers.<name>.models[].id` —— pi 启动握手后由 `defaultProvider` / `defaultModel` 选中（见 2.2.2）。

#### 2.2.2 `settings.json` —— 注入默认 provider / model

```json
{
  "defaultProvider": "fake-anthropic",
  "defaultModel": "fake-claude-haiku-4-5"
}
```

**作用**：bridge fixture 不需要发 `set_model` 命令，pi 启动后即按这两条选 model；测试 case 想覆盖其他 model 时显式发 `set_model` 覆盖即可。

#### 2.2.3 `auth.json` —— 假 key 满足 schema 校验

```json
{
  "fake-anthropic": {
    "type": "api_key",
    "key": "fake-anthropic-test-key"
  }
}
```

**作用**：让 pi 启动握手时不报"未配置 provider"。**假 server 校验请求头 `x-api-key` 时即与该字段对账**（无须真 OAuth）。

#### 2.2.4 `auth.json` 缺位时的降级（已知事实）

按 [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]]，bridge 启动若 `auth.json` 缺失仅打 stderr warn；fixture 测试要断言"未缺失"，因缺位会让 pi 子进程收到 401。详见 [[getting-started.md#getting-started-§35-配置文件-json-字段说明]] 现有"高级覆盖：`PI_CODING_AGENT_DIR`"段。

### 2.3 环境变量三件套

bridge spawn pi 子进程时注入（fixtures 子进程入口脚本层负责，**不是** bridge 行为变更）：

```
PI_CODING_AGENT_DIR=<fixture>/agent-dir   # 隔离 pi 整套目录
PI_OFFLINE=1                              # 关版本检查 / telemetry / 模型目录刷新
                                         # → 密闭性：不连外网，不打点，不请求 pi 自己的 model 目录
```

**`PI_OFFLINE=1` 的密闭性边界**（scout 在 pi 源码层实证）：

- **关版本检查**：pi 不查 upstream 版本。
- **关 telemetry**：不发遥测事件。
- **关模型目录刷新**：不扫真 provider 的模型目录。
- **不关 baseUrl 转发**：pi 仍按 `models.json` 的 `baseUrl` 发请求到假 server（这正是 fixture 工作的基础）。

### 2.4 假 server 协议规格：Anthropic Messages API

> 假 server 只需实现 `POST /v1/messages` + SSE 事件流；其他 Anthropic 端点（如 `/v1/models`）可返回 404 占位。

#### 2.4.1 请求

| 项 | 要求 |
|----|------|
| 方法 + 路径 | `POST /v1/messages` |
| 请求头 | `content-type: application/json`、`x-api-key: <auth.json 的 key>`、`anthropic-version: 2023-06-01` |
| 请求体（节选） | `{ "model": "fake-claude-haiku-4-5", "max_tokens": 1024, "messages": [{ "role": "user", "content": "..." }] }` |

#### 2.4.2 响应：SSE 事件流

按 Anthropic Messages API 顺序，**逐事件**发出：

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","type":"message","role":"assistant","content":[],"model":"fake-claude-haiku-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}
```

**事件序列铁律**（pi-ai SDK 的 anthropic contract 强校验）：

1. `message_start` —— 必有，且是 SSE 流的第一条。
2. `content_block_start` —— 必有，标记 content block 类型（`text` / `tool_use` / ...）。
3. `content_block_delta` —— 流式增量；**`delta.type` 取值**：
   - `"text_delta"` —— 文本增量（覆盖 §2.4.2 示例）
   - `"input_json_delta"` —— tool_use 部分 JSON
   - `"thinking_delta"` —— 思考增量
4. `content_block_stop` —— 一个 content block 结束的标志。
5. `message_delta` —— 携带 `stop_reason`（`end_turn` / `max_tokens` / `tool_use` / `stop_sequence`）与 `usage.output_tokens`。
6. `message_stop` —— 流结束标志。

#### 2.4.3 错误响应（非流式）

工具调用失败、超长、限流时返回标准 Anthropic error 形状（JSON，非 SSE）：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "messages: max_tokens must be > 0"
  }
}
```

pi-ai 会把它归一化为 pi RPC `error: string`（参见 [[current-state.md#最近变更]] 2026-09-07 bridge→pi 翻译层修复条对 `normalizePiError` 的实证）。

### 2.5 实现时核实点

scout **仅实证了 `openai-completions` contract 的 `baseUrl` 行为**；本 fixture 切到 Anthropic 后，实施时需在 pi 源码或运行时实证以下三点：

1. **pi-ai 的 `anthropic-messages` contract 是否同样尊重 `models.json` 自定义 `baseUrl`** —— 大概率是（同 SDK 一致性），但需跑通一次真链路确认。
2. **`models.json` 的 `api` 字段 anthropic 取值名称** —— 按本文件 §2.2.1 占位为 `"anthropic-messages"`，**实施时对照 docs/models.md（待建）或 pi-ai 源码 `Api` 字面量校准**。
3. **`PI_OFFLINE=1` 是否影响 anthropic-messages 请求路径** —— 当前 scout 实证影响"版本检查 / telemetry / 模型目录刷新"三个面，**不影响请求转发**，但 anthropic SDK 可能有自己的网络初始化（如 token 计数 endpoint）需要额外关掉。

### 2.6 能覆盖的测试面

| 测试面 | 测试断言 | 对应 PRD / ADR |
|-------|---------|---------------|
| 真 pi 流式解析 | `message_update` / `agent_settled` 事件序列与 web 渲染 | [[prds/m3-single-session.md\|M3 PRD §2.4]] |
| Session 落盘 | fixture `agent-dir/sessions/--<cwd>--/<ts>_<uuid>.jsonl` 文件存在 + 内容可被 `get_messages` 拉回 | [[architecture/decisions/0003-session-lifecycle-and-history-source.md\|ADR-0003]] |
| `--session` 恢复 | 重启 pi 子进程后，`get_messages` 能拉到上次消息（证明 `--session <latest>` 走通） | [[architecture/decisions/0003-session-lifecycle-and-history-source.md#补注child-error-事件处理策略2026-09-07\|ADR-0003 补注]] |
| Idle kill 唤醒链 | 5min 后 SIGTERM→1s→SIGKILL、后续命令触发 `exited → spawning` 重启 | [[architecture/decisions/0003-session-lifecycle-and-history-source.md\|ADR-0003 §3]] |
| 脚本化 `extension_ui_request` 4 类弹窗 | 假 server 在 SSE 流中插入 `tool_use` block → pi 内部扩展触发 `select` / `confirm` / `input` / `editor` → bridge ExtensionUIRouter 入列 → web 收 `session_state.blocked_on` | [[architecture/decisions/0004-extension-ui-dialog-forwarding.md\|ADR-0004]] |

> **关键解锁**：脚本化 4 类弹窗这件事**当前没有替代方案**——bridge 单测 FakeChild 模拟不出"pi 内部扩展真的发 `extension_ui_request`"，用户手测又依赖手头有触发插件。假 server + 真 pi 后，可以用 prompt 引导 pi 自己调出插件弹窗（如 vimmode 的 setStatus 噪音就是天然 fixture —— 见 [[current-state.md#最近变更]] 2026-09-07 spawning 修复条"首组 setStatus 帧实为 `extension_ui_request{method:'setStatus'}`"事实修正），测试 case 在 fixture prompt 里写明"请用某插件的 confirm 弹窗"，真 pi 真触发 → bridge ExtensionUIRouter 真处理。

### 2.7 CI 门控

**实施时必须满足**（[[architecture/decisions/0002-monorepo-and-tech-stack.md|ADR-0002]] 测试基建原则）：

- **CI 不跑** —— GitHub Actions 没有 `pi` 二进制、没法 `pi auth`，跑通也只会假绿。**`pnpm test` / `pnpm -r test` 默认排除 `**/integration/**`**。
- **本机专用脚本**：新增 `pnpm test:integration`，根级 `package.json` 加 `"test:integration": "vitest run --config vitest.integration.config.ts"`，独立 vitest workspace 文件，不并入 `vitest.workspace.ts` 的默认集合。
- **前置依赖**：开发者本机已装 pi（roadmap §4.2：`pi --mode rpc` 可启动）+ 临时 fixture `agent-dir` 由测试自己创建 / 清理（`afterEach` 删树）。
- **网络**：fixture 起 `127.0.0.1:<randomPort>` 的进程内 server，**零外网**；假 server 拒绝任何非 `127.0.0.1` 来源请求（防误连）。

### 2.8 Fixture 形态预估

- **位置**：`tests/integration/`（新增顶层目录，不放 bridge 包内，避免单测文件误拾取）。
- **HTTP server**：Node 内置 `http`（无须 express / fastify）；`port: 0` 随机端口；事件流用 `res.write('event: ...\ndata: ...\n\n')` 手拼（Anthropic SSE 格式铁律见 §2.4.2）。
- **脚本化响应**：每个测试 case 写一个 `script: () => AsyncIterable<SseEvent>` 工厂，按 prompt 关键字 / 顺序决定返回哪些事件；约 80-150 行 / case。
- **断言工具**：复用现有 `FakeChild` 的 `stdout` 录制思路，但替换为"真 pi 的 stdout"——把 pi 子进程 stdout 的 JSONL 行实时传给 WsClient 测试 harness，对照 `expected: Envelope[]` 数组 `toEqual`。

---

## 3. 展望：无头浏览器端到端

> **状态：仅作为方向挂账，细节待讨论后补充**。不作为当前任务的实施范围。

**目标**：用 Playwright（或类似无头浏览器基建）驱动 web UI，对本地全栈（wrangler dev + bridge + 真 pi + 假 LLM fixture）跑：

- token 注入 → 恢复仪式 → 流式渲染断言（页面出现 token-by-token 文本）
- F5 → 状态恢复（同 §2.6 的 `--session` 恢复但走 UI 层）
- 多端弹窗（两个浏览器上下文同时挂同一 token，断言先答者胜、迟到者收 request_expired）

**前置依赖**：§2 集成测试基建立稳后才有意义（web UI 层断言依赖 wire 层断言已成立）。

**可能的角色**：web 包建设测试基建的契机（M3 至今 web 包 vitest 基建未建，§1.1 表空行）—— Playwright 测试套件可作为 web 包首个测试基建，与 §2 集成测试在 CI 上同跑同跳（依赖本机装 pi + 假 server，本机专用 `pnpm test:e2e`，CI 跳过）。

---

## 4. 升级体检仪式：pi 升级时真实形状比对

> **状态：流程约定，不是自动化测试**。每次升级 pi 版本（roadmap §6 待决"pi 版本锁定策略"）时由负责升级的开发者手工跑一遍，对照本节清单逐项过；记录在 [[current-state.md]] 最近变更。

### 4.1 为什么必须有这步

本轮 M3 联调 6 个 wire 硬伤（详见 §1.3）**全部**是"bridge 假设 vs pi 实物"偏差。如果不做升级体检仪式，bridge 代码里累积的"pi 行为假设"会越来越多；每次升级都会重新踩坑。

### 4.2 体检清单（每次升级必过）

每次升级 pi 跑以下六步，**任一项偏差** → 暂停升级 → 写 [[current-state.md]] 修订注记 + 走 §2 集成测试基建的扩展（而不是修单测了事）：

1. **握手响应形状比对**：`get_state` 命令响应的所有字段（`sessionInfo` / `model` / `availableModels` 等）逐一与 `packages/shared` 的 pi schema 对账；字段名、类型、可选性一致才放行。
2. **事件名清单比对**：`pi --mode rpc` 实际发出的所有 `type` 字符串（`agent_start` / `message_start` / `tool_execution_start` / `extension_ui_request` 等）逐一与 [[architecture/protocol/pi.md|architecture/protocol/pi.md]] 第 §4.2 / §4.4 / §4.5 节的事件名清单对账；新增 / 删除 / 改名要修订该文档。
3. **落盘编码比对**：session 目录名（`--<cwd 编码>--`，[[current-state.md#最近变更]] 2026-09-07 cwd 修复条实证算法）与 bridge 的 `encodeCwdForPi` 对账；jsonl 单行格式（每个 entry 的字段名 / 类型）逐一抽几条对照。
4. **extension_ui_request 方法清单比对**：实际可能发出的 method（`select` / `confirm` / `input` / `editor` / `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`）对照 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] §2 入列清单；新增 method 要决定 fire-and-forget 还是入列。
5. **失败响应 error 形状比对**：RPC 失败时 `error` 字段的实际类型（[[current-state.md#最近变更]] 2026-09-07 bridge→pi 翻译层修复条实证 pi 0.85.1 恒为 string）对照 `packages/bridge/src/pi-process.ts` 的 `normalizePiError` 六分支；类型签名变化要扩展归一化。
6. **idle / kill 行为比对**：bridge 的 5min idle SIGTERM→1s→SIGKILL 序列仍能让新版本 pi 干净退出（exit code = 0 或预期非零）；崩溃路径行为与 [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] §3 三路径一致。

### 4.3 体检结果落到哪里

- **通过** → [[current-state.md]] 最近变更追加一条"YYYY-MM-DD pi 升级至 X.Y.Z — 体检 6 项通过"。
- **不通过** → 暂停升级，回到 §2 集成测试基建的扩展上：
  - 字段名 / 类型变 → 写集成测试 case 钉死新形状。
  - 旧字段缺失 / 重命名 → 改 `packages/shared` pi schema + 写 ADR 修订注记。
  - 行为语义变（如 idle kill 改了退码） → 改 bridge 处理 + 改对应 ADR。

> **底线**：不允许 bridge 在 pi 升级后"实际行为有变但单测全绿"——§1.3 教训的全部 6 个坑都属于这一类。

---

## 相关

- [[current-state.md]] — 看板 + 最近变更（M3 联调 12 问题原始记录）
- [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] — session 生命周期与 idle kill
- [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] — extension UI 弹窗转发
- [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] — bridge 复用宿主机 agent 目录
- [[architecture/protocol/pi.md]] — pi RPC 协议细节（事件名 / 命令 schema）
- [[prds/m3-single-session.md]] — M3 PRD（§2.4 流式 / §2.5 session / §4.2 弹窗）
- [[roadmap.md]] — §4 pi RPC 协议要点 + §6 待决问题（pi 版本锁定策略）
- [[tasks/m3/08-docs-and-validation.md|tasks/08]] — M3 三端联调 14 条手测清单（§2 集成测试基建的"对照基准"）
- [[getting-started.md|getting-started §3.5]] — `PI_CODING_AGENT_DIR` 高级覆盖 + auth.json 现状
- [[glossary.md]] — `agent_settled` / `extension_ui_request` 等术语
