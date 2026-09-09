# pi 家族：对话内容

> 状态：定稿（2026-09-05），协议版本 v1。字段与语义变更须走 [[architecture/protocol/envelope.md]] 的版本化流程。
>
> **M4 修订注记（2026-09-08）**：envelope (a) 为 `prompt.payload` 增可选 `work_dir` 字段（仅 `session:'new'` 携带，裁定 A 方案 A），零新增 type；多会话扩展节从「预留」升级为「正式落地」。详见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]]。

## 定位

`pi` 家族承载**对话内容**，网页与 bridge 是唯一的两端；`kind=pi` 的消息中间层一律**原样转发**，中间层不解析、不重组。

`type` 命名镜像 pi 的命令名（v0.84.4），payload 字段尽量对齐 pi 原生形态——**实现时以 `rpc-types.d.ts` 为准核实字段名与形状**；本文档先记字段语义，不写死原生细节（凡标注「实现时核实」处须落地前与包内类型核对）。

共 9 个 type：命令 6 个（prompt / steer / follow_up / abort / get_messages / extension_ui_response）+ 回执 / 事件 3 个（command_result / snapshot / event），详见下文。**M4 零新增 type**（每会话独立进程推论，详见 [多会话扩展正式落地](#多会话扩展正式落地)）。

---

## bridge→pi 翻译层（实现注记）

> 本节是「bridge 把本协议命令帧翻译成 pi 原生 stdin 帧」的实现层注记。**web wire 形状不变**（协议文档里看到的就是网页发的形状），bridge 在写 stdin 时按本节规则翻译——`DeferredCommand` 持有 web wire，写出时单点翻译（`translateToPiWire`）。该层是 [[roadmap.md#4-pi-rpc-协议要点|roadmap §4]] 与本协议的衔接点。

以下四条规则均经 pi 0.85.1 实证（依据：`rpc-types.d.ts` 命令 schema + `rpc-mode.js` 工厂 + 实际回执），由 commit `837d1de` / `44960b9` 落地：

1. **字段名翻译：`content` → `message`**。web wire 的 `prompt` / `steer` / `follow_up` payload 用 `content`（本协议 §命令的命名），pi 原生 RPC schema 要求 `message`。bridge 误发 `content` → pi 读到 `undefined` → 调用 `.startsWith(...)` 抛 `TypeError`（用户手测时在 prompt 命令观察到的现象）。**翻译位置**：`translateToPiWire` 单点处理——web wire 与 DeferredCommand 不感知此差异，未来若 pi 再次重命名字段只需改一处。

2. **`get_messages.since` 在翻译边界丢弃**。web wire 保留 `since`（协议 §`get_messages` payload 字段）以备 M+ 切换到 `get_entries` 时复用；pi 的 `get_messages` 不接受 `since`（该字段属 `get_entries`），`translateToPiWire` 在写 stdin 时直接丢弃，stderr 不告警（语义上属"web wire 字段在 bridge→pi 单向不可用"，与 §字段名翻译 同样属翻译边界处置）。

3. **失败响应 `error` 形状归一化**。pi 原生 RPC 失败响应（带 `success: false` 或缺失）的 `error` 恒为 **string**（`rpc-mode.js` 工厂实证）；worker 的 `command_result.error` schema 要求 `{code, message}` 对象，原样透传会被 zod 拒。bridge 在转发前走 `normalizePiError` 统一归一为 `{code: 'pi_error', message}`（六分支覆盖 `string` / `Error` / `{code,message}` / `{message}` / `null` / 缺省）。**翻译位置**：bridge 收 pi 响应 → `normalizePiError` → `command_result` envelope → worker schema 校验通过 → 转发 web。

4. **`extension_ui_response` 翻译注记见下文 §命令对应小节**——web wire 的 `cancelled` / `value` 三态翻译为 pi 原生 `cancelled` / `value` / 弃 value，是翻译层规则的同类特例，沿用 `translateToPiWire` 单点；本节不复述。

> **测试覆盖**：§命令 wire 保真（10 条 `toEqual` 正向 + `not.toHaveProperty` 反向）+ 整帧 `safeParse` 回归（10 条）+ `normalizePiError` 六分支单测；bridge 测试 247 → 269。**历史教训**：旧测试 §1.3 长期断言错误 wire 形状（`content`），与 pi 真 schema 错位却仍绿，使字段名 bug 存活至今——本次修复同步将断言改为正向 `message` + 反向 `not.toHaveProperty('content')`。

---

## 命令（网页 → bridge）

### prompt

正常发言。

```json
{ "v": 1, "kind": "pi", "type": "prompt", "id": "c1", "payload": { "content": "…" } }
```

```json
// M4：session 为 'new' 的 prompt 可额外携带 work_dir，触发新会话创建。
{ "v": 1, "kind": "pi", "type": "prompt", "id": "c1", "session": "new", "payload": { "content": "…", "work_dir": "/abs/path" } }
```

- **payload**：
  - `content`：string，用户输入文本。
  - `work_dir`（M4 新增，可选）：string，绝对路径。**仅 `session:'new'` 的 prompt 携带**（裁定 A 方案 A：新会话的第一条消息是唯一入口）；其他 session 状态下的 prompt 不带、bridge 忽略；schema 仅标注 optional（不强制与 `session` 关联），web 端发命令时遵守。详见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]] §决策.2 与 envelope.md [演进规则 (a)](#演进规则v1-存续期内允许)。

### steer

干活中途插话。

```json
{ "v": 1, "kind": "pi", "type": "steer", "id": "c2", "payload": { "content": "…" } }
```

- **payload**：`content`：string，插入到当前轮次的引导文本。

### follow_up

排队追加。

```json
{ "v": 1, "kind": "pi", "type": "follow_up", "id": "c3", "payload": { "content": "…" } }
```

- **payload**：`content`：string，等当前轮结束后再投入。

### abort

停止。

```json
{ "v": 1, "kind": "pi", "type": "abort", "id": "c4", "payload": {} }
```

- **payload**：空对象。

### get_messages

拉取历史。

```json
{ "v": 1, "kind": "pi", "type": "get_messages", "id": "c5", "payload": { "since": "…" } }
```

- **payload**：`since`：可选，按消息时间戳或序号过滤；**缺省全量**。

### extension_ui_response

回应阻塞弹窗（web wire 形状）。

```json
{
  "v": 1,
  "kind": "pi",
  "type": "extension_ui_response",
  "id": "c6",
  "payload": { "request_id": "…", "cancelled": false, "value": "…" }
}
```

- **payload**（web wire 形状）：
  - `request_id`：弹窗请求事件中的 pi 原生 `id`，**原样带回**（pi v0.85.1 已实证所有 9 类 `extension_ui_request` 方法均携带稳定 UUID `id`，无须兜底关联）。
  - `cancelled`：boolean。`true` 表示用户取消（不附 `value`）；`false` 表示用户提交（`value` 必填）。
  - `value`：可选；类型为 `string | boolean`。`cancelled: true` 时不出现；`cancelled: false` 时必须出现：
    - `confirm` 走 `boolean`——`true` 确认、`false` 拒绝（这是 confirm 表达"否"的唯一通道，详见 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]]）；
    - `select` / `input` / `editor` 走 `string`。
- **bridge 翻译注记**：bridge 收 web wire 后翻译为 pi 原生三态（web 端统一布尔取消语义，pi 原生 schema 封装在 bridge 内部）：
  - `cancelled: true` → 写 `{ type: 'extension_ui_response', id, cancelled: true }`；
  - `cancelled: false` + 原 method 为 `confirm` → 写 `{ id, confirmed: value as boolean }`；
  - `cancelled: false` + 原 method 为 `select` / `input` / `editor` → 写 `{ id, value: value as string }`。

> `value` 类型放宽为 `string | boolean` 是为 confirm 的"否"提供语义通道（`value: false`）。shared 层不做 `confirm` / 其他方法的 `value` 类型区分——bridge 维护原 method 信息，按对应分支配对即可。

---

## 回应与事件（bridge → 网页）

### command_result

所有命令的通用回执。

```json
{
  "v": 1,
  "kind": "pi",
  "type": "command_result",
  "id": "…",
  "reply_to": "c1",
  "payload": { "command": "prompt", "success": true, "data": …, "error": … }
}
```

- **信封字段**：`reply_to` **必填**，指回命令 `id`。
- **payload**：
  - `command`：被回执的命令 type 名。
  - `success`：boolean。
  - `data`：成功时携带，结构由具体命令决定。
  - `error`：失败时携带 `{ code, message }`。

### snapshot

`get_messages` 的回执——完整消息数组，网页用它**收敛整个对话视图**。

```json
{
  "v": 1,
  "kind": "pi",
  "type": "snapshot",
  "id": "…",
  "reply_to": "c5",
  "payload": { "messages": [ … ] }
}
```

- **信封字段**：`reply_to` **必填**。
- **payload**：`messages`：消息数组，每项结构与 pi 原生消息一致。

### event

pi 事件原样装填。

```json
{
  "v": 1,
  "kind": "pi",
  "type": "event",
  "id": "…",
  "payload": { "event": "message_update", "data": { … } }
}
```

- **payload**：
  - `event`：事件名，**集合开放**——pi 升级新增事件无须改本协议，未识别事件网页端忽略。
  - `data`：事件负载，结构随事件名变化。

常见事件名（与 pi v0.85.1 对齐，已实证存在）：

| 事件 | 含义 |
|------|------|
| `agent_start` / `agent_end` / `agent_settled` | agent 进程粒度的起止与一轮对话结束（agent_settled 触发 bridge 启动 5min idle 计时，详见 ADR-0003） |
| `turn_start` / `turn_end` | 一轮 turn 的起止 |
| `message_start` / `message_update` / `message_end` | 一条消息的起 / 流式增量（text_delta 等，仅用于打字机暂显）/ 终（权威覆盖） |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | 一次工具调用的起 / 流式增量 / 终 |
| `queue_update` | steering + follow_up 队列变化（web 端据比显示队列条数） |
| `entry_appended` | 日志条目追加 |
| `extension_ui_request` | 阻塞式弹窗请求（要求网页响应；所有 9 类方法携带稳定 UUID `id` 字段） |
| `ui_prompt_start` / `ui_prompt_end` | 一次阻塞交互的起 / 终（与 `extension_ui_request` 互补；用于 UI 帧状态补全） |

> 上述集合**不封闭**：pi 升级新增事件无须改协议，未识别事件网页忽略。

---

## 关联规则

| 关联场景 | 用什么字段 | 说明 |
|----------|-----------|------|
| control 请求 ↔ 回执 | envelope `reply_to` | 见 [[architecture/protocol/control.md#7-result]] |
| pi 命令 ↔ `command_result` | envelope `reply_to` | 见上文 |
| `get_messages` ↔ `snapshot` | envelope `reply_to` | 见上文 |
| pi 内部：流式增量 ↔ 所属消息 | payload `data.messageId`（pi 原生） | message_update / tool_execution_update 携带 |
| 弹窗请求 ↔ 回应 | payload `request_id` | extension_ui_request ↔ extension_ui_response |
| ping ↔ pong | payload `nonce` | **不用** `reply_to` |

> 信封级 `reply_to` 只用于 `command_result` 与 `snapshot`——自家协议只关联自家事务；pi 内部的关联用 pi 原生 id 放 payload。

## 渲染规则（网页实现必须遵守）

- **`message_update` 携带的增量**（如 `text_delta` 等）**只用于打字机式暂显**——它是不完整快照。
- **`message_end` 里的完整消息是权威内容**，可随时覆盖重画，丢弃之前的 `message_update` 暂显态。
- **`agent_settled` 表示一轮结束**，网页须：恢复输入框可用、开始空闲计时（bridge 会在空闲 5 分钟后回收 pi 进程，经 [[architecture/protocol/control.md#5-session_state|session_state]] 播报）。

## 多会话扩展正式落地

> M4 起多会话不再「预留」——以下决策落地：本节明确每会话独立 pi 进程、envelope `session` 字段启用规则、sessionKey 计算、pending 键控（钉子 2）、`pi/prompt.payload.work_dir` 仅 `session:'new'` 携带（裁定 A 方案 A）。详见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]] §决策.2–5。

### 每会话独立 pi 进程

M3 的 `PiProcessManager` 5 相位状态机逐会话实例化（每 manager 独立 idle 计时 + 崩溃隔离）。推论：

- **新会话** = bridge spawn 新 manager（不带 `--session`，让 pi 自己开新 jsonl 文件），触发点是 web 在 `ChoicePage` 点"新建会话" → web 发 `pi/prompt`（`session: 'new'` + `payload.work_dir`）→ bridge 收到后按 pending 键控（见下）路由；首次 prompt 写入触发 spawn，spawning → ready 后 bridge 在下一个 `session_state` 广播里携带 session 字段（实际 stem，如 `2026-09-08T10-30-00_a3f9b2c1-4d5e-...` 的 stem）。
- **切会话** = web 改 URL hash，bridge 不感知；web 后续命令携带新 `session` 字段，bridge 路由到对应 manager。
- 这两条语义都被 web URL hash + bridge router 完整表达，**无需**在 pi RPC 协议里新增 `new_session` / `switch_session` / `list_directories` type——新增会让协议多两个 bridge → pi 的翻译命令（bridge 不知道 pi 何时创建 session 文件，需要先 round-trip 查 session 文件名再喂 `--session`，徒增复杂度），故**不引入**。`pi` 家族 M4 零新增 type（沿 envelope 演进规则 (b) "可向 pi 家族新增 type" 的逆向：M4 不需要新增）。

### envelope `session` 字段启用规则（多会话下操作惯例必填，schema 仍 optional 不破锁）

schema 维持 envelope.md 锁版承诺（`session` 字段 optional）。多会话下的操作惯例（违反时不强制 wire 错，仅靠实施期对端协商补全）：

- **web → bridge**：所有 pi 家族命令 + `control/get_state` / `control/session_list` 必须带 `session` 字段（缺省视为"作用于 bridge 默认 session"——M3 兼容路径，但 M4 ChoicePage 强制带）。
- **bridge → web**：所有 `session_state` / `command_result` / `snapshot` / `event` 必须带 `session` 字段（M3 兼容路径下可省略，但 M4 推荐始终带，便于 web 按 session 过滤）。
- **session_state 列表广播**：bridge 在每个 manager 的 phase 迁移时各广播一次（各自带 session 字段），web 收 N 个 session_state 各 update 自己的桶。

### sessionKey 计算规则

`sessionKey` = pi session 文件名 stem（如 `2026-09-08T10-30-00_a3f9b2c1-4d5e-...`）。

- 复用 M3 `encodeCwdForPi(cwd)` + `sessionSubdir(agentDir, cwd)` + `findLatestSession(subdir)`（详见 `packages/bridge/src/pi-cwd-encoder.ts`）。
- 已知会话：web 命令带 `session: <stem>` → bridge 在 map 里查找 → 命中复用，未命中则按 session 路径 spawn 新 manager（cwd = 该 session 所属 work_dir，`--session` = 该 stem 的 jsonl 路径）。

### pending 键控（钉子 2）

bridge 收到 `session:'new'` + `payload.work_dir`：

- **pending 键**：map 内部键 `'new:' + work_dir`；先查 `managers.has('new:' + work_dir)` —— 命中则复用 pending manager（短时多次 new 请求合并为同一个）；未命中则 spawn 新 manager（cwd = work_dir，**不带** `--session`，让 pi 自己开新 jsonl 文件）。
- **map 键迁移**：manager 启动后，spawning 相位启动 SPAWN_TIMEOUT_MS 兜底；收到首个 `entry_appended` 或 ready 后第一次 `message_start` → 从 stdout / `--session-dir` 派生 stem → bridge 自行将 map 键迁移到真实 stem（`managers.delete('new:' + work_dir); managers.set(stem, manager)`） → 广播 `session_state{session: <stem>}`（web 收到后回填 hash `&session=<stem>`）。
- **边界**：`session:'new'` 但 payload 缺 `work_dir` → 拒，回 `result.ok = false` + `error.code: 'invalid_envelope'`（M4 操作惯例下必带，缺省视为协议错）。

> **实测验证点（PRD 落盘前必做）**：(a) bridge 是否能在 pi 完成首次 jsonl 写入前读出文件名？答：不能——pi 是 lazy 创建文件的（首次 `agent_start` / 首次 stdout entry 写入后才落盘）。M4 必须接受这一窗口——spawning → ready 期间 web 命令的 `session: 'new'` 占位（map 内 pending 键 `'new:' + work_dir`），bridge 在收到首个 `entry_appended` 事件时（或 ready 后第一次 `message_start`）从 stdout / `--session-dir` 派生 stem 并广播 `session_state{session: <stem>}`。**凡未实测的落盘细节不可信**——任务 06 实施期跑真 pi 探针（沿用 tasks/m3/10 假 LLM 套件）确认事件时序与 stem 派生点。
>
> **2026-09-08 任务 06 实施修订**（探针实测 pi 0.85.1，PRD 修订注记有完整说明，详见 `tests/integration/probes/PROBE-SESSIONKEY-RESULT.md`）：**pi 0.85.1 无 `entry_appended` 事件**——探针 script 中 `firstEntryAppended` 字段始终为 `null`（pi 走裸 `message_update` / `message_end` 流而非 entry 序列化）。**实际派生点改写为「首个非 handshake stdout 事件 + agent_dir 扫描」**——实测为 `agent_start` 事件触发的同帧/微秒内 pi 创建 `<agentDir>/sessions/--<encodedWorkDir>--/<timestamp>_<uuid>.jsonl`；bridge 实现采用「`agent_start` 事件触发 + agent_dir 扫描」双保险策略。`sessionFile` 字段在 `agent_start` 帧内携带（绝对路径）——可作为 fast-path 直接消费；当前 bridge 实现走 agent_dir 扫描 fallback（更通用，应对未来 pi 版本不再携带该字段），`sessionFile` 字段留作 M+ 优化候选。PRD §1.5 候选信号「首个 `entry_appended` 或 ready 后第一次 `message_start`」**不适用**——实施期实测已替换。
>
> **2026-09-08 任务 08 实施事实（pending 键控边界 — 内部键泄上 wire）**：bridge `BridgeSessionLayer` 在 pending 阶段 map 内部键为 `'new:' + work_dir`（任务 06 §钉子 2 设计），但**实施期**其 `session_state` 广播带 `session: <内部键>`（`new:<work_dir>` 形态）——该内部键是 bridge 内部状态机的实现细节，**不应**作为 wire 上的 `session` 字段语义。**web 端防御**（任务 08 完成情况 e2e 根因修复段）：① watcher 跳 pending-key 形态（正则 `^new:.+` 不触发 hash 回填）；② `WsClient` 收到 `session_state` 入站时检测 `session` 字段是否含 `:` → 折叠回 `'new'` 桶；③ `migratePendingBucket('new' → <stem>)` 仅在 `<stem>` 不含 `:` 时执行。**教训一句**：内部 map 键 / 内部状态机字段是 bridge 内部实现细节，序列化到 wire 时应**统一**映射到协议层定义的 session 形态（`'new'` 关键字 + 真实 stem），不得让内部键字面量泄出。任务 09 docs-sync 范围建议在 envelope.md `session` 字段说明段补一句「`session` 字段值不应含 `:`（除 `'m3-legacy'` 内部兼容外）」防类似偏差。详见 [[tasks/m4/08-web-multi-session-store.md#f1ede7d-e2e-根因修复-4-笔根因-4-笔防御修复|08 完成情况 §`f1ede7d` e2e 根因修复]] + [[prds/m4-multi-session.md|PRD §修订注记（任务 08 实施期增 2 字段——待任务 09 落档）]]。

### `pi/prompt.payload.work_dir` 仅 `session:'new'` 携带

裁定 A 方案 A：新会话的第一条消息是唯一入口。web 在 `ChoicePage` level=2 点"新建会话" → 写 hash `&session=new` → 进 ChatView → 首次 prompt 携带 `session: 'new'` + `payload.work_dir` → bridge 按 pending 键控（见上）路由。其他 session 状态下的 prompt 命令**不带** `payload.work_dir`，bridge 忽略（schema 仍允许携带，但实施期 web 端不发送；bridge 端不做强制校验，避免 wire 误杀）。

> **反向**：M3 单 session 阶段 `session: <stem>` 的 prompt 不携带 `work_dir`（无需——bridge 已知 session 所属 work_dir）；新增 `work_dir` 字段对 M3 wire 无影响（schema optional，缺省 = M3 行为）。