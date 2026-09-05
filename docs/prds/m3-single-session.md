# M3 单 session 闭环（pi 子进程 + web 弹窗 + 状态恢复）

> 状态：定稿（2026-09-05）。协议基线：[[architecture/protocol/README.md|隧道协议 v1]]（已定稿）。本 PRD 在 envelope 演进规则 (a) 范围内为 `session_state` payload 新增可选字段 `blocked_on`，并按"协议修订小节"将 control type 由 8 增至 9（破锁修订，理由：v1 无第三方消费者 + 三端锁步部署）。

## 背景

M2 已完成 web ↔ worker ↔ bridge 三端通路（2026-09-05 线上验收通过），control 5 type 落地，shared 中 pi 家族仍为占位。M2 终点：浏览器只见 StatusBar / PingTester / BroadcastLog 三个验证组件，看不到 pi 进程任何业务状态。

M3 目标 = 单 session 闭环。三件核心事：

1. **bridge 端管起 pi 子进程**。目前 `packages/bridge` 仅做 WSS 客户端，`packages/bridge/package.json` 仍带 `@earendil-works/pi-coding-agent` 的可选 peer，但代码里没 spawn 也没 parse 任何 pi 输出。M3 要把 pi 接上：固定工作目录（`work_dir` 配置）→ 自动恢复 / 新建最新 session → 5 分钟 idle 计时 kill → 崩溃重启 → 弹窗转发。
2. **pi 家族 9 type 全链路落地**。`shared` 当前的 `PiBranch = z.never()` 占位要换成真 discriminatedUnion；bridge 要消费 6 命令、生成 3 回应/事件类型；web 端实现聊天界面（流式渲染、队列、abort）+ 4 类阻塞弹窗。
3. **协议从"握手 / 心跳"扩到"业务对业务"**。需补充 control `get_state`（web 端握手后状态查询）、session_state 的 `blocked_on` 字段（弹窗未决队列）；其余沿用 envelope 演进规则 (a) 新增可选字段。

M3 把 [[roadmap.md#5-里程碑|roadmap §5 M3 行]]、[[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]]（session 生命周期 + 5min idle + 历史来源）与 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]]（弹窗转发）的具体 wire 行为一次性钉死，避免 M4 拆 session 选择 UI 时再回头改协议。

> **修订注记（2026-09-05）**：原 control 锁版承诺"v1 存续期内 control 家族不再新增 type"破锁为 9 个 type（新增 `get_state`）；理由（已与用户锁定）：
> 1. v1 无第三方消费者（仅三端锁步部署）；
> 2. `get_state` 是 web 端握手后必需的"会话态查询"，与 `session_list` 同形态（web → bridge，回执走 `result`），不引入新的转发/语义负担；
> 3. 不破锁则 web 端只能用 `get_messages` 间接探测状态，浪费带宽 + 引入冗余字段；
> 4. envelope 演进规则 (b) 中"control 家族 v1 内不再新增 type"同步改为"除已破锁的 `get_state` 外不再新增"。
> 同步在 envelope.md 锁版承诺清单与 ADR-0003 末尾标注此破锁。

## 目标

1. **配置全量迁移**：bridge CLI 仅保留 `--config <path>` 一个 flag，配置 JSON 文件（默认 `~/.config/remotepi/bridge.json`），含 `worker_url` / `web_base_url` / `work_dir` / 可选 `token`。
2. **pi 子进程状态机**：spawning → ready → running → idle → exited 五相位按协议播报；`get_state` 响应 = 就绪信号；`agent_settled` → 启动 5 分钟 idle 计时（roadmap §4.3 + ADR-0003）；idle 超时 SIGTERM→1s→SIGKILL 走"自主 kill 标记"路径 → exited（不重启）；标记不在 + exit≠0 → 崩溃重启（spawning）；标记不在 + exit=0 → exited 不重启（stdin EOF 等合法关闭路径）。
3. **session 自动恢复 / 新建**：bridge 不 import pi 包，会话发现走目录扫描（PI_CODING_AGENT_DIR 隔离目录下扫固定 work_dir 对应子目录，文件名时间戳取最新，无则新建）。
4. **pi 家族 9 type 全链路**：command 6（prompt / steer / follow_up / abort / get_messages / extension_ui_response）+ 回执/事件 3（command_result / snapshot / event）；bridge 与 web 各自按 wire 形态落地。
5. **4 类阻塞弹窗转发**：select / confirm / input / editor 经 pi → bridge → worker → web 弹窗 → 回执；并发多弹窗按 id 独立处理；web 端显示倒计时（timeout 字段）。
6. **fire-and-forget 5 类本地消化**：notify / setStatus / setWidget / setTitle / set_editor_text 在 bridge 端记日志消化，不转发 web（理由：TUI 概念无远程等价物；事件保留在 stdout 流，将来 M+ 恢复零协议成本）。
7. **blocked_on 状态帧驱动弹窗**：session_state payload 新增可选 `blocked_on` 数组；bridge 维护未决队列；web 端弹窗仅由事件 / 状态帧驱动渲染，无乐观 UI；并发多弹窗按 id 独立应答。
8. **timeout 镜像契约**：bridge 转发阻塞请求时起本地 `setTimeout`（请求 `timeout` 毫秒值）；触发 → 移出 blocked_on → 广播；与提交竞态时原子检查，输家走对方路径。editor 无 timeout 接受为已知行为（roadmap §4.5 + ADR-0004：阻塞期间不发 agent_settled，idle 计时不误触发）。
9. **恢复仪式 + 协议修订**：web 每次连接 / 重连并行发 `pi/get_messages`（拉历史）与 `control/get_state`（拉会话态 + blocked_on），两条都到才渲染视图；F5 刷新走同一仪式；envelope / control / pi / ADR-0003 / ADR-0004 同步修订。
10. **广播原则**：session_state 广播**仅由写操作触发**（prompt / steer / follow_up / abort / extension_ui_response 处理后）+ 状态迁移（相位变化、blocked_on 变化）；get_messages 是读，永不触发广播。
11. **exited 语义**：spawn 触发集 = prompt / steer / follow_up / get_messages（前三种为写，get_messages 走 pi RPC 需活进程）；control `get_state` 永远由 bridge 内存作答、永不 spawn；abort 在 exited 为 no-op。

## 非目标

- session / 目录选择 UI；`new_session` / `switch_session` / `list_directories`（M4 范围）
- 环形缓冲补发、断线增量流恢复（roadmap §6 待决问题；M3 最小方案 = 重连后 `get_messages` 拉全量快照，进行中 delta 丢失可接受）
- worker 缓存、worker 端 pi 状态镜像
- fire-and-forget 5 类（notify / setStatus / setWidget / setTitle / set_editor_text）的 web 转发
- 模型切换（`set_model` / `cycle_model`）、bash 命令（`bash` / `abort_bash`）、`compact` / `set_auto_compaction` 等 M4+ 命令
- bridge CLI 参数（`--worker-url`）与环境变量（`REMOTEPI_WORKER_URL`）的恢复（仅 TODO）
- 多 pi 子进程并发（M3 单 session；多 session 在 M4）
- 鉴权 token 持久化、吊销流程（沿用 M2 启动随机生成 + URL fragment）
- web 端 localStorage / cookie 存 token（沿用 M2：仅内存 + URL hash）
- 离线 bridge 状态广播（M2 已覆盖，本里程碑不重复）

## 方案

### §1 协议修订（v1 内破锁 + envelope 演进规则 (a)）

#### §1.1 新增 control `get_state`（破锁 8 → 9）

参考 control.md §6 session_list 模式（web → bridge，payload 空对象，回执走 `result`）：

```jsonc
// web → bridge
{ "v": 1, "kind": "control", "type": "get_state", "id": "g1", "payload": {} }
// bridge → web（result 回执）
{
  "v": 1, "kind": "control", "type": "result", "id": "g2",
  "reply_to": "g1",
  "payload": {
    "ok": true,
    "data": { "phase": "ready", "blocked_on": [ /* 可选，详见 §1.3 */ ] }
  }
}
```

result 失败时 `error.code` 复用 control.md §8 已锁版的 6 个 code 集合（不允许新增）。

#### §1.2 session_state payload 扩展（envelope 演进规则 (a)）

原 schema：
```ts
{ phase: "spawning" | "ready" | "running" | "idle" | "exited" }
```
升级后：
```ts
{
  phase: "spawning" | "ready" | "running" | "idle" | "exited",
  blocked_on?: BlockedOnEntry[]   // 新增可选；缺省视为空数组
}
```

枚举值沿用 control.md §5 已锁版的 5 相位（不破锁）。

#### §1.3 blocked_on 元素（数组项）形状

直接复用 pi v0.85.1 原生 `extension_ui_request` 4 类阻塞方法的负载（已 0.85.1 实证携带稳定 UUID `id` 字段）。Fire-and-forget 5 类**不**进 blocked_on（§6 裁定）：

```ts
type BlockedOnEntry =
  | { method: "select";  id: string; title: string; options: string[]; timeout?: number }
  | { method: "confirm"; id: string; title: string; message: string;    timeout?: number }
  | { method: "input";   id: string; title: string; placeholder?: string; timeout?: number }
  | { method: "editor";  id: string; title: string; prefill?: string };
```

**envelope 内嵌 pi 内容本体的代价**：worker 端原样转发（不解析 blocked_on 内容）；bridge 端构造 / 消费此字段；web 端直接渲染。这意味着 RemotePi 协议实际承担了 pi `extension_ui_request` 的 schema。已与用户锁定接受该代价——避免了另起一种 envelope type（如 `pi/ui_request`）的双层映射。

#### §1.4 envelope 演进规则 (a) 同步

envelope.md 锁版承诺清单同步：
- "control 8 个 type" → "control 9 个 type（含本破锁新增的 `get_state`）"；
- 演进规则 (a) 注释追加：M3 起 `session_state.payload.blocked_on`（数组，可选）、`result.data.phase` / `result.data.blocked_on`（get_state 回执）均为新增可选字段；
- 演进规则 (b) "control 家族 v1 内不再新增 type" → "除 `get_state` 外不再新增"。

#### §1.5 pi 家族 9 type 落地

`packages/shared/src/protocol/envelope.ts` 的 `PiBranch = z.never()` 占位替换为真 discriminatedUnion（替换前 M2 联调已用 `z.union([ControlBranch, PiBranch])` 锁住 kind 顶层，PiBranch 真化后两层 discriminatedUnion 自动兼容，无需调整顶层结构）：

| type | 方向 | payload |
|------|------|---------|
| `prompt` | web → bridge | `{ content: string }` |
| `steer` | web → bridge | `{ content: string }` |
| `follow_up` | web → bridge | `{ content: string }` |
| `abort` | web → bridge | `{}` |
| `get_messages` | web → bridge | `{ since?: string }`（缺省全量） |
| `extension_ui_response` | web → bridge | web wire 形状，见 §1.6 |
| `command_result` | bridge → web | `{ command, success, data?, error?: { code, message } }` |
| `snapshot` | bridge → web | `{ messages: AgentMessage[] }` |
| `event` | bridge → web | `{ event: string, data: any }`（data 字段开放集合，envelope.md §1.5 不锁） |

`event.data` 不在 zod 层面做 shape 校验——web 端按 `event` 名分支判断（参考 pi.md 渲染规则：text_delta 打字机暂显 + message_end 权威覆盖）。

#### §1.6 extension_ui_response web wire 形状（已敲定）

**web 端统一用 `{ request_id, cancelled: boolean, value?: string | boolean }`**——`value` 类型放宽为 `string | boolean`：confirm 传 boolean（→ pi 原生 `confirmed`），select / input / editor 传 string（→ pi 原生 `value`）。这是 confirm 表达"否"的唯一通道（`value: false`）。

zod schema：
```ts
export const ExtensionUIResponsePayloadSchema = z
  .object({
    request_id: z.string().min(1),
    cancelled: z.boolean(),
    value: z.union([z.string(), z.boolean()]).optional(),
  })
  .refine(
    (v) => v.cancelled === true || v.value !== undefined,
    { message: 'value is required when cancelled=false (string 或 boolean)', path: ['value'] },
  );
export type ExtensionUIResponsePayload = z.infer<typeof ExtensionUIResponsePayloadSchema>;
```

bridge 端翻译为 pi 原生三态（参考 §2.4）：
- `cancelled === true` → 写 `{ type: 'extension_ui_response', id, cancelled: true }`；
- `cancelled === false`，原 method 为 `confirm` → 写 `{ id, confirmed: value as boolean }`（value 为 boolean，true/false 对应确认/拒绝——`value: false` 即 confirm 的"否"）；
- `cancelled === false`，原 method 为 select / input / editor → 写 `{ id, value: value as string }`（value 为 string）。

**理由**：web 端组件统一布尔取消语义；bridge 翻译简单且本地化；pi 原生三态封装在 bridge 内部，shared 不向 web 暴露 pi 原生 schema。

### §2 bridge：配置 + pi 子进程 + 弹窗转发

#### §2.1 配置文件

```
~/.config/remotepi/bridge.json
{
  "worker_url": "wss://remote-pi.sankabox.com/bridge",
  "web_base_url": "https://remote-pi.sankabox.com",
  "work_dir": "/home/user/projects/foo",
  "token": "<optional: 有则用，无则每次启动随机生成，不回写>"
}
```

加载规则：
- 路径解析：`--config <path>` → 默认 `~/.config/remotepi/bridge.json`。可解析 XDG：env `XDG_CONFIG_HOME` / `HOME`（实现时简化版优先支持默认路径，XDG 加 bonus）。
- JSON 解析失败 / 缺 `worker_url` / `web_base_url` / `work_dir` 三个必填 → 退出码 1 + stderr 友好错误（不静默）。
- `work_dir` 启动时严格校验：存在 + 是目录 + 当前用户可读，否则退出码 1；**不**自动 mkdir（已敲定决策 4）。
- `token` 字段：存在且非空 → 用；否则 `crypto.randomBytes(24).toString('base64url')` 生成（沿用 `packages/bridge/src/token.ts:generateToken`），**不**回写到配置文件。
- 心跳 / 重连时序常量维持代码常量（`packages/bridge/src/client.ts` 现有的 `PING_INTERVAL_MS` / `PONG_TIMEOUT_MS` 等），**不**进配置。
- 未知 CLI flag 静默忽略（不破坏 systemd wrapper 传参），不做严格报错（编排裁定，2026-09-05）。

#### §2.2 CLI / env 移除清单

- 删除 `packages/bridge/src/index.ts`：`parseWorkerUrlFlag` / `readEnvWorkerUrl` / `DEFAULT_WORKER_URL` 常量、`StartOptions.workerUrl` 字段（保留 test seam 的 `argv` 注入）、`DEFAULT_WORKER_URL` 检测 hint 日志。
- 删除 `packages/bridge/src/token.ts`：`DEFAULT_WEB_BASE` 常量；`shareUrl` 改为接 `base: string` 必填入参（由配置传入，不再有默认值）。
- `packages/bridge/package.json`：`peerDependencies."@earendil-works/pi-coding-agent"` 与 `peerDependenciesMeta` 整段删除。
- `packages/bridge/src/index.ts` CLI 解析：仅识别 `--config <path>`（支持 `--config=<path>` 等价形式）；未知 flag 静默忽略。
- TODO 落到 `docs/current-state.md`：将来重新加回 CLI 参数与环境变量。

#### §2.3 pi 子进程状态机

启动命令：
```
PI_CODING_AGENT_DIR=<bridge专属隔离目录> pi --mode rpc
```
- 隔离目录路径建议 `<config-dir>/pi-agent/`（与配置同根，便于清退）；该目录**必须**含 `auth.json`（roadmap §4.8 优先级 auth.json > env > --api-key）；
- bridge 启动时若 `auth.json` 缺失 → 提示用户配 `pi login`（不在 M3 范围自动登录，留 stderr 提示即可）。

启动握手（roadmap §4.1 ⚠）：
1. spawn → stdout 第一组扩展 `setStatus` 事件流过（**忽略**）；
2. bridge 写入 `get_state` 命令（带 `id`），等响应；
3. 响应 `{ type: "response", command: "get_state", success: true, data: RpcSessionState }` → 标记 ready，广播 `session_state{phase: "ready"}`。

stdin / stdout（roadmap §4.2 ⚠）：
- 用 `StringDecoder('utf8')` + `indexOf('\n')` 自管缓冲，**不**用 `readline`（U+2028 / U+2029 拆行破坏 JSON 解析）。

五相位迁移（R1 修正后的精确表述，idle kill 走"自主 kill 标记"路径；exited 重启触发集按 §2.7 精确化）：
```
spawning ──(get_state 响应)──► ready ──(收到首个 prompt/steer/follow_up)──► running
                                                                              │
ready ──(收到 prompt, 但未走 spawning)─────────────────────────────────────────┘
running ──(agent_settled 事件)──► idle ──(5min 超时,SIGTERM→1s→SIGKILL,自主 kill)──► exited（不重启）
exited  ──(spawn 触发集: prompt/steer/follow_up/get_messages)──► spawning（详见 §2.7）
spawning / running ──(exit ≠ 0,自主 kill 标记不在)──► spawning（崩溃重启）
spawning / running ──(exit === 0,自主 kill 标记不在)──► exited（stdin EOF 等正常关闭路径,不重启）
```

- 收到首个任务（prompt / steer / follow_up）触发 spawn（延迟到首任务触发，不预热）；
- `running` 状态期间收到新 prompt → 仍属 running（不迁移）；steer / follow_up 按 pi 语义处理（roadmap §4.2）；
- `idle` 计时由 bridge 本地维护（5 min 经验值，代码常量，可调）；
- **自主 kill 标记（R1）**：bridge 发起 kill（idle 超时）前设置内部标记（**先置位再发信号**，避免 exit 回调与信号之间的竞态）；exit 回调先查标记——标记在 → 清除 → exited 不重启；标记不在且 exit≠0 → 崩溃重启（走 §2.6 spawning）；标记不在且 exit=0 → exited 不重启（stdin EOF 等合法关闭路径）；
- `running` 期间若收到扩展 UI 阻塞请求 → 不迁移相位，blocked_on 入列（仍在 running）。

#### §2.4 弹窗转发数据流

bridge 维护内部状态：`Map<requestId, BlockedOnEntry>`（与 session_state.blocked_on 同形状，作为内部真相源）。

**入站（bridge 收 pi stdout）**：
1. 解析 `event.data.event === "extension_ui_request"`；
2. 按 method 分流：
   - `select` / `confirm` / `input` / `editor` → 写入 `Map` → 广播 `session_state`（含 `blocked_on`）→ 转发该 `extension_ui_request` 事件给 web（通过 `pi/event` envelope 原样转）；
   - `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text` → 本地 `logger.info` 消化，不转发，不入 blocked_on。
3. 若 entry 带 `timeout` → 起本地 `setTimeout(timeout, ...)`（I 决策）。

**入站（bridge 收 web `extension_ui_response`）**：
1. zod 校验 web wire 形状（§1.6，value 类型为 `string | boolean`，confirm 允许 boolean）；
2. 原子检查 `Map`：存在 → 翻译为 pi 原生三态（§1.6）→ 写 stdin → 清除 entry → 清除对应 timeout 句柄 → 广播 `session_state`；
3. 不存在 → 回 `command_result{success: false, error: {code: "request_expired", message: "..."}}`（迟到提交场景）。

**timeout 镜像触发**：
1. setTimeout 触发 → 原子检查 `Map`（与提交竞态点）；
2. 仍在 → 清除 entry → 广播 `session_state`（blocked_on 已不含该 id）；
3. 已被提交清除 → 静默 no-op（pi 侧迟到回应本就被静默丢弃）。

**多 web 端先答者胜**：
- 每个 web 端收 `session_state` 广播都更新本地 blocked_on；
- 弹窗组件按 id 独立显示与应答；
- 先答者的 extension_ui_response 经 bridge 处理后触发新一轮 session_state 广播，其他 web 端的最新帧不含该 id → 自然收起；
- 后续答者收到 `command_result{success: false, error: {code: "request_expired"}}` → 弹窗组件显示错误提示并关闭。

#### §2.5 session 目录扫描

启动时 + session exited 后下次启动时执行：

1. 路径模板：`<PI_CODING_AGENT_DIR>/sessions/--<cwd 编码>--/<时间戳>_<uuid>.jsonl`（roadmap §4.6）；
2. cwd 编码规则：实现时**严格对齐** pi 官方编码；推荐先实现 `encodeURIComponent(cwd).replace(/%/g, '')`，再用真实 pi 启动一次 + 落盘路径回归比对，不通过则不收尾；
3. 扫描该子目录下的 `*.jsonl` 文件；
4. 取最新：按文件名 `<时间戳>` 部分字典序（时间戳是 ISO 形式，字典序 = 时间序）；同时间戳多文件取 mtime 最新（已敲定决策 5）；
5. 候选 → spawn 时加 `--session <path>`；
6. 无候选 → spawn 不带 `--session`（pi 自动新建）。

恢复语义：spawn 后仍走 §2.3 启动握手（`get_state` 验证可恢复）；状态正常 → `ready` + web 端走恢复仪式（§4.4）拉到完整历史。

#### §2.6 exit 处理与崩溃恢复

pi 子进程 `exit` 事件的完整处理规则（与 §2.3 状态机的 exit 转移一一对应）：

- **自主 kill 标记在**（idle 超时 kill）→ 清除标记 → exited（广播）→ **不重启**；
- **标记不在 + `code !== 0`** → 崩溃：广播 exited → 立即 spawn 新子进程（走 §2.3 spawning）；
- **标记不在 + `code === 0`** → exited（广播）→ **不**自动重启；下次 spawn 触发集命令（§2.7：prompt / steer / follow_up / get_messages）到达时按 §2.3 触发 spawn。

bridge 自身崩溃 → bridge 重启后目录扫描恢复 + web 端恢复仪式拉历史（无云端依赖，ADR-0003 设计成立）。

#### §2.7 exited 状态下的命令语义

- **spawn 触发集 = prompt / steer / follow_up / get_messages**：前三种是写操作；`get_messages` 走 pi RPC 必须有活进程——恢复仪式在 idle kill 后拉历史必然触发带 `--session` 恢复的 spawn，spawn 后照常 spawning → ready 播报，随后 5min idle kill 兜底（资源浪费在 M3 单用户场景可接受）。
- control `get_state` 永远由 bridge 内存作答（phase / blocked_on 的当前值），**永不 spawn**。
- abort 在 exited 时为 no-op，回 `command_result{success: true}`。

### §3 worker：协议搬运工（零业务改动）

worker 维持 M2 行为，本里程碑**零代码改动**：

- handshake 鉴权 + bridge_status 补发 + error 生成（control.md §4 / §8）；
- 转发 web 入站到 bridge（get_messages / get_state / pi 家族 6 命令 / session_list）；
- 转发 bridge 广播到所有 web（session_state / result / pi/event / snapshot / command_result / bridge_status）；
- 不解析 blocked_on、不解析 pi 家族内容、不维护会话态；
- 中间层处理规则（control.md 末节）一字不动。

### §4 web：聊天 + 弹窗 + 恢复仪式

#### §4.1 状态模型

web 端维护（ws 单件持有的状态 store，框架形态随 M2 既有结构）：

```ts
interface WebState {
  // 业务
  messages: AgentMessage[];           // 由 snapshot / message_end 收敛
  streamingDraft: AgentMessage | null; // 由 message_update.text_delta 暂显
  queue: { steering: string[]; followUp: string[] }; // 由 queue_update 更新
  // 会话
  sessionPhase: 'spawning' | 'ready' | 'running' | 'idle' | 'exited';
  blockedOn: BlockedOnEntry[];        // 由 session_state.blocked_on 覆盖
  bridgeOnline: boolean;               // 由 bridge_status 控制（沿用 M2）
}
```

所有状态均**只由事件 / 状态帧驱动**（H 决策）。本地任何操作（提交弹窗、发 prompt）→ 立刻显示"已提交待确认"暂态 → 等下一个事件 / 状态帧确认 → 才视为生效。

#### §4.2 弹窗组件（4 类）

| method | 组件 | 渲染字段 | 提交形状 |
|--------|------|----------|----------|
| `select` | SelectDialog | title, options[] | `{ request_id, cancelled: false, value: <option string> }` |
| `confirm` | ConfirmDialog | title, message | `{ request_id, cancelled: false, value: true \| false }`（"否" = `value: false`，R2 修正；confirm 的 value 始终为 boolean） |
| `input` | InputDialog | title, placeholder? | `{ request_id, cancelled: false, value: <text> }` |
| `editor` | EditorDialog | title, prefill? | `{ request_id, cancelled: false, value: <text> }` |

每组件：
- 倒计时显示：`timeout` 存在 → 头部显示 `剩余 Ns` + 进度条；不存在（仅 editor）→ 不显示倒计时（接受为已知行为）；
- 取消按钮：所有 4 类组件都有"取消"按钮 → 发 `{ request_id, cancelled: true }`（不附 value）；
- 关闭规则：session_state 帧 `blocked_on` 不含该 id → 自动收起（即使本地"已提交待确认"）；
- 提交失败（`command_result{success: false, error.code === 'request_expired'}`） → 显示错误 toast + 自动收起。

并发多弹窗：按 id 独立显示在主界面之上的层叠容器（罕见；协议不假设至多一个）。

#### §4.3 chat 界面

- 输入框：发 prompt；abort 按钮（活态于 phase === "running"）；
- 流式渲染：`event.event === "message_update"` → `assistantMessageEvent.text_delta` 累加到 streamingDraft 显示（打字机）；
- 权威覆盖：`event.event === "message_end"` → 用 `message_end.message` 全量覆盖 / 追加到 `messages`；清空 streamingDraft；
- queue_update：显示队列条数（`steering.length` + `followUp.length`）；
- session_state 相位指示：顶部 StatusBar（沿用 M2）下方加一行小字显示 phase（spawning / ready / running / idle / exited）+ 当前 work_dir；
- agent_settled 处理：`event.event === "agent_settled"` → 输入框可用 + UI 显示"agent 已就绪（5 分钟后自动休眠）"提示；
- exited 状态：发 prompt / steer / follow_up 或由恢复仪式发 `get_messages` 都会触发 spawn，UI 显示 `exited → spawning` 过渡态；abort 在 exited 为 no-op（按钮可点但回 `command_result{success: true}` 不改变状态）。

#### §4.4 恢复仪式（双查询）

ws `onopen` → handshake 发出后即可**并行**发双查询（handshake 是 web→worker 单向，**无 ack 机制**，合法性由连接存活保证；bridge 在线与否以 `bridge_status` 补发为准）：

```
pi/get_messages     { id: m1 }       （拉历史，无 since 全量）
control/get_state   { id: g1 }       （拉会话态）
```

等两条都到：
- `snapshot { reply_to: m1, payload.messages }` → 渲染 `messages`；
- `result { reply_to: g1, ok: true, data: { phase, blocked_on? } }` → 渲染 `sessionPhase` + `blockedOn`；
- 然后渲染整个聊天界面（输入框可用与否按 phase 决定）。

若两条中任意一条失败（超时 / `ok: false`） → 显示"恢复失败，请重试"按钮（点击重发双查询）；不静默丢。

F5 刷新走完全相同路径（web 端无 localStorage，刷新 = 重新走 WSS + 仪式）。

注：`get_messages` 走 pi RPC 需活进程——若当前 phase === `exited`，bridge 会先按 §2.7 触发带 `--session` 恢复的 spawn，再正常回 `snapshot`。

#### §4.5 提交失败处理

`command_result{success: false, error.code === 'request_expired'}`（H 决策 + §2.4 翻译）：
- 弹窗组件：显示"已过期"toast + 自动收起；
- 普通命令（prompt / steer / follow_up）：输入框临时显示错误提示（"pi 已不再处理该请求，可能是 idle 超时 kill"），不重发。

### §5 shared：schema 扩展（按 §1 落到代码）

新增文件 / 改动清单（与 envelope.md 锁版承诺同步校对）：

```
packages/shared/src/protocol/
  envelope.ts            # PiBranch 占位 → 真 discriminatedUnion；SessionStatePayload 加 blocked_on
  control.ts             # 新文件（沿用 envelope.ts 风格）：HandshakePayloadSchema / PingPayloadSchema / ...
                         # + GetStatePayloadSchema（{}）+ SessionStatePayloadSchema（升级）+ ResultPayloadSchema
                         # + BridgeStatusPayloadSchema / ErrorPayloadSchema
  pi.ts                  # 新文件：9 个 pi envelope + payload schema（按 §1.5 / §1.6）
  block-on.ts            # 新文件：BlockedOnEntry schema（§1.3）+ ExtensionUIResponsePayload schema（§1.6，value: string | boolean）
  index.ts               # barrel：re-export 上列 + CONTROL_TYPES 列表追加 'get_state'
```

CONTROL_TYPES 字面量同步：`['handshake', 'ping', 'pong', 'bridge_status', 'session_state', 'session_list', 'get_state', 'result', 'error']`（9 项）。

shared 测试追加：
- pi 家族合法解析 / 必填字段缺一拒 / 非法 method 拒；
- session_state 加 blocked_on 缺省解析 / 含 4 类 blocked_on 元素合法 / 含 fire-and-forget method 拒；
- extension_ui_response web wire shape refine 规则（cancelled=false 必填 value，且 value 接受 string 或 boolean——confirm value 必为 boolean）；
- get_state 回执 result.data 形状合法 / 非法 phase 拒；
- 命令载荷缺必填字段拒。

### §6 测试

#### §6.1 shared（vitest）

预计新增 25+ 条（按 §5 末节清单）：
- pi 家族 6 命令 + 3 回执/事件：合法解析、缺字段拒、非法 enum 拒；
- session_state：5 phase 合法 + blocked_on 缺省 + 4 类 blocked_on 元素合法 + fire-and-forget method 拒；
- extension_ui_response：cancelled=true 合法（不附 value）/ cancelled=false 缺 value 拒 / cancelled=false 带 string value 合法（select / input / editor）/ cancelled=false 带 boolean value 合法（confirm，true 与 false 两个用例）/ 缺 request_id 拒 / 非 string 非 boolean 的 value 拒；
- get_state payload 解析 / result 回执解析（含 data.blocked_on 缺省 / 含数组）；
- 命令 6 类缺必填字段拒。

#### §6.2 bridge（vitest）

- 配置加载：合法 / 缺 worker_url 拒 / 缺 work_dir 拒 / 缺 web_base_url 拒 / work_dir 不存在拒 / work_dir 不是目录拒 / work_dir 不可读拒（mock fs）/ token 字段可缺省；
- CLI 移除回归：原 `--worker-url` / `REMOTEPI_WORKER_URL` 都不再生效（start() 完全忽略）；未知 flag 静默忽略（编排裁定，2026-09-05）；
- session 扫描：mock 文件系统，多文件按时间戳取最新（ISO 字典序 = 时间序）；同时间戳多文件取 mtime 最新；空目录 → 新建；最新文件不可读 → 报错；
- pi 子进程状态机：spawning → ready → running → idle → exited 迁移序列；agent_settled 启动 5min 计时（mock 时间）；超时 kill（SIGTERM→1s→SIGKILL 序列）；**自主 kill 不触发重启**（mock exit code=143 / 137 均走不重启路径）；**意外 exit≠0（标记不在）触发重启**，spawn 计数 +1；**exit=0（标记不在）走 exited 不重启**（stdin EOF 合法关闭路径）；
- blocked_on 维护：4 类入列 / 5 fire-and-forget 不入列；timeout 镜像触发 / 与提交竞态（输家走 no-op）；
- bridge 重启 → 目录扫描找最新（无云端依赖）；
- wire 翻译：web extension_ui_response 各 cancelled 组合 → pi 原生三态一一对应，覆盖 confirm value:true → `confirmed: true`、confirm value:false → `confirmed: false`、select / input / editor value:string → `value: <string>`、cancelled:true → `{ id, cancelled: true }`（不附 value）；
- 广播原则：get_messages 不触发 session_state 广播；prompt / steer / follow_up / abort / extension_ui_response 处理后各触发一次；
- exited 语义：exited 时 get_messages 触发带 `--session` 的 spawn（spawn 计数 +1）；get_state 由内存作答不 spawn；abort no-op（回 `command_result{success: true}`）。

#### §6.3 worker / DO

- 无新增（M2 已有测试覆盖转发；本里程碑无业务代码）。

#### §6.4 web

- 双查询恢复仪式：两条都到才渲染 / 任意一条失败显示"重试" / 重发双查询；
- 弹窗组件：4 类渲染 + 倒计时 / 取消 / 提交（含 confirm value:false → 发 `{cancelled:false, value:false}`）/ 关闭规则（mock session_state.blocked_on 不含该 id 触发收起）；
- 流式：text_delta 暂显 + message_end 覆盖；
- 迟到提交：mock command_result{success:false, error.code:'request_expired'} → 显示错误 + 收起；
- exited 状态：发 prompt / steer / follow_up 触发 `exited → spawning` UI 过渡；发 get_messages 同样触发；abort 不改变状态；
- F5 刷新：端到端 smoke（走 vite preview + 真实 WSS，本地手测；不写自动化 E2E）。

### §7 文档同步（文档交付物）

| 文件 | 改动 |
|------|------|
| `docs/architecture/protocol/envelope.md` | 锁版承诺 control 8 → 9 type（备注破锁）；演进规则 (a) 列出 `session_state.payload.blocked_on` 新增；演进规则 (b) "v1 内不再新增 type" → "除 `get_state` 外" |
| `docs/architecture/protocol/control.md` | §6 get_state 新增（payload `{}` + 回执走 result）；§5 session_state payload 增 `blocked_on` 字段说明（数组 / 元素为 4 类 extension_ui_request）；type 列表 8 → 9 |
| `docs/architecture/protocol/pi.md` | 9 个 type 列表按 §1.5 落地；extension_ui_request 9 方法全部带稳定 UUID id（删除"实现时核实是否带稳定 id"注记）；extension_ui_response payload 改 web wire 形状描述 + bridge 翻译注释（value: string \| boolean，confirm 走 boolean）；常见事件名表加 `agent_settled` / `message_update` / `queue_update` / `ui_prompt_start` / `ui_prompt_end`（已 0.85.1 实证存在，但 pi.md 现表未列） |
| `docs/architecture/decisions/0003-session-lifecycle-and-history-source.md` | 末尾注记：恢复措辞与"双查询恢复仪式"对齐；明确 idle 计时不会被阻塞弹窗误触发（与 ADR-0004 协同）；自主 kill 标记规则注记；exited 状态 spawn 触发集（prompt / steer / follow_up / get_messages；get_state 永由内存作答）注记 |
| `docs/architecture/decisions/0004-extension-ui-dialog-forwarding.md` | 补注：弹窗模型升级为状态帧驱动（session_state.blocked_on）；无乐观 UI 规则；并发多端"先答者胜"语义落地；extension_ui_response web wire 形状（value: string \| boolean，confirm 走 boolean）注记 |
| `docs/current-state.md` | 活跃需求追加 M3 PRD 链接；TODO 增"将来恢复 CLI/env 参数"条目 |
| `docs/architecture/decisions/0006-protocol-v1-get-state-unlock.md`（**新增 ADR**） | 记录 control 8 → 9 type 破锁决策 |
| `getting-started.md` | bridge 启动命令改为 `bridge --config <path>`；新增"配置 JSON 字段说明"小节；删除 `--worker-url` / `REMOTEPI_WORKER_URL` 段落 |

## 验收清单

### wire / 协议

- [ ] shared 测试全绿（§6.1 估算 25+ 条）
- [ ] bridge 测试全绿（§6.2 估算 30+ 条）
- [ ] worker / web 既有测试仍全绿（M2 22 + bridge 32 一字不动）
- [ ] lint / typecheck / build 全绿
- [ ] pi 包不再出现在 `packages/bridge/package.json`（peerDependencies 删尽，`grep pi-coding-agent packages/bridge/` 零结果）
- [ ] `packages/bridge/src/index.ts` 不再有 `DEFAULT_WORKER_URL` / `parseWorkerUrlFlag` / `readEnvWorkerUrl`
- [ ] `packages/bridge/src/token.ts` 不再有 `DEFAULT_WEB_BASE` 常量
- [ ] 配置文件加载：合法 / 缺必填 / work_dir 不存在或不可读 / 缺 token → 各分支行为符合 §2.1
- [ ] 未知 CLI flag 静默忽略（编排裁定，不报错）

### 浏览器闭环（本地 + 线上）

- [ ] **发消息→流式→完成**：web 端发 prompt，message_update 打字机暂显 + message_end 收敛；agent_settled 后 phase 转 idle + 输入框可用 + 提示"5 分钟自动休眠"
- [ ] **F5 刷新恢复**：刷新后聊天记录 / phase / blocked_on 全部恢复（web 端无 localStorage）
- [ ] **abort 生效**：phase=running 时点 abort → pi 终止 + phase 转 idle；phase=exited 时点 abort → 无状态变化 + 回 `command_result{success:true}`
- [ ] **空闲 5 分钟 kill**：agent_settled 后超时 kill（SIGTERM→1s→SIGKILL）→ phase 转 exited，且**不触发崩溃重启**（自主 kill 标记路径）
- [ ] **意外崩溃重启**：标记不在 + 子进程 exit≠0 → spawn 计数 +1（验证崩溃重启语义）
- [ ] **exited 后拉历史**：idle kill 后 F5 → get_messages 触发带 --session 的 spawn → 历史完整恢复
- [ ] **exited 后写操作唤醒**：exited 时发 prompt / steer / follow_up → 触发 spawn → 走 spawning → ready → running
- [ ] **exited 时 get_state 零成本**：exited 时 web 调 `control/get_state` → 内存即时回执，**不**触发 spawn
- [ ] **4 类弹窗可交互且 agent 行为正确**：select 选项返回字符串 / confirm 确认（`value:true`）与拒绝（`value:false`）都正确改 pi 分支 / input / editor；超时倒计时显示；提交后弹窗收起；agent 收到回应后行为符合扩展语义
- [ ] **timeout 自答 + 迟到回应**：弹窗 timeout 触发 → bridge 镜像触发 → session_state.blocked_on 移除该 id → 弹窗自动收起（pi 侧 stdout 零输出）；迟到提交收到 `command_result{success:false, error.code:'request_expired'}`
- [ ] **fire-and-forget 5 类本地消化**：bridge 日志含该事件，web 端零弹窗 / 零事件
- [ ] **多 web 端**：两个标签同 token；弹窗在两端都弹出；先答者提交后两端同步收起；后续答者收到 request_expired
- [ ] **bridge 重启 / 崩溃自愈**：bridge 进程 kill → 两 web 端 5 秒内 bridge_status offline → 重启 bridge → web 端重连 + 恢复仪式拉回 history；bridge 启动后不发命令时 pi 子进程不 spawn（延迟到首任务触发）
- [ ] **双查询恢复仪式**：mock 两条都到 / 任意一条超时失败（前端显示重试按钮）；handshake 后无 ack 即并行发双查询

### 协议修订

- [ ] envelope.md 锁版清单与演进规则 (a)/(b) 同步
- [ ] control.md get_state 增补；§5 session_state payload blocked_on 增补；type 列表 9
- [ ] pi.md 9 type + extension_ui_request 9 方法带稳定 id 注记删除 + extension_ui_response web wire 形状（value: string \| boolean）修订
- [ ] ADR-0006（破锁 ADR）新建
- [ ] ADR-0003 / ADR-0004 补注（自主 kill 标记 / exited 触发集 / wire value 类型）
- [ ] current-state.md TODO 增"恢复 CLI/env"

### 真实环境

- [ ] `https://remote-pi.sankabox.com/#<token>` 打开 → 聊天界面
- [ ] 浏览器完成"发消息 → 流式 → 完成"线上闭环
- [ ] F5 刷新线上恢复

## 任务拆分

| # | 标题 | 依赖 |
|---|------|------|
| 01 | shared 协议扩展（pi 家族 9 schema + control get_state + session_state blocked_on + blocked_on 元素 schema + extension_ui_response web wire，value: string \| boolean） + envelope/control/pi 文档同步 + ADR-0006 | — |
| 02 | shared 测试扩展（25+ 条新增，含 confirm boolean 双用例） | 01 |
| 03 | bridge 配置加载（JSON 解析 + 校验 + XDG 可选 + work_dir 严格校验）+ CLI/env 移除清单 + 未知 flag 静默忽略 + 文档 | 01 |
| 04 | bridge pi 子进程状态机（spawn / 握手 / 5 相位 / 自主 kill 标记 / 5min idle kill / 崩溃重启 / exit=0 不重启）+ session 目录扫描（含 cwd 编码对齐 + 同名 mtime 兜底）+ §2.7 exited 语义（spawn 触发集 + get_state 不 spawn + abort no-op） | 01/03 |
| 05 | bridge 弹窗核心（blocked_on 维护 + 4 类入列 + fire-and-forget 5 类消化 + timeout 镜像 + 多 web 端先答者胜 + wire 翻译含 confirm value:false）+ bridge 测试扩展（30+ 条） | 01/03/04 |
| 06 | web 聊天界面（消息流 + 队列 + abort + 4 类弹窗组件含 confirm value:false + 倒计时 + 关闭规则 + 提交失败处理） | 01 |
| 07 | web 双查询恢复仪式 + F5 恢复 + phase / blocked_on / queue_update UI 接线（handshake 后无 ack 即并行发双查询） | 01/06 |
| 08 | ADR-0003 / ADR-0004 补注 + current-state.md TODO + getting-started.md 修订 + 三端联调手测验收 | 03/04/05/06/07 |

03/04/05 链式依赖 01；06/07 链式依赖 01，06/07 与 03/04/05 可并行；08 收尾。

## 交付约定

沿用 [[prds/m2-tunnel.md#交付约定|M2 交付约定]]：所有任务（01–07）只在本地 commit，不 push。08（文档收尾 + getting-started + 三端联调手测验收）落地后，用户本地验证（lint / typecheck / test / build 全绿 + 三端手测通过）→ 用户手动 `git push origin main` → Actions 首跑 CD（沿用 M2 deploy.yml）。

## 用户操作清单

- **配置 bridge**：在 `~/.config/remotepi/bridge.json` 写入 worker_url / web_base_url / work_dir；token 可选（不写则启动随机生成）。
- **认证**：在 `<config-dir>/pi-agent/`（bridge 启动时打印路径）下跑 `pi login` 生成 `auth.json`（roadmap §4.8）。
- **启动 bridge**：`bridge`（默认配置路径）或 `bridge --config <path>`。
- **首次访问**：浏览器开 `https://remote-pi.sankabox.com/#<bridge 启动时打印的 token>`，完成"粘 token → 聊天界面"过渡。
- **联调手测**：按 §验收清单"浏览器闭环"逐条验过。
- **可选 dev 切换**：本地 wrangler dev 时，配置 `worker_url: "ws://localhost:8787/bridge"`、`web_base_url: "http://localhost:5173"`。

## 风险与实现时核实

- **cwd 编码一致性**：bridge 目录扫描的 cwd 编码规则必须与 pi 完全一致，否则 session 文件定位失败 → 用真实 pi 启动一次 + 落盘路径比对回归；不通过则不收尾。
- **timeout 单位**：0.85.1 rpc-mode.js 用 `setTimeout(ms)` 直传，确认无单位换算。
- **kill 标记竞态**：自主 kill 标记必须在发信号前置位（set → kill signal → exit 回调），exit 回调先读标记后清标记；测试覆盖"标记在 → 不重启 / 标记不在 + exit≠0 → 重启 / 标记不在 + exit=0 → 不重启"三条路径。
- **extension_ui_response 翻译一致性**：bridge → pi stdin 时机：blocked_on 弹出后立即写；bridge 写 stdin 失败（子进程死）→ 记 error 日志 + 强制 exited + 广播。confirm 翻译时 value 必须 cast 为 boolean（zod refine 已约束），select/input/editor 翻译时 value 必须 cast 为 string。
- **pi 升级 schema 漂移**：pi 升级可能改 extension_ui_request 4 类负载字段 → 文档同步 + 单测覆盖；blocked_on 元素 zod schema 强校验漂移时桥接层显式拒绝并报告。
- **多 web 端弹窗 UX**：并发多弹窗按 id 独立 → web 组件按 id 维护 Map（罕见但协议不假设至一）。
- **session.jsonl 完整性**：bridge 重启时 pi 未在写 → 安全；bridge 崩溃时 pi 已落盘 → 目录扫描恢复；无云端依赖（ADR-0003 成立）。
- **exited 后 get_messages 必触发 spawn**：恢复仪式在 idle kill 后必触发带 `--session` 的 spawn（spawn 后正常走 spawning→ready，5min idle kill 兜底）；M3 单用户场景下资源浪费可接受。
- **无乐观 UI 的体验折损**：本地操作"提交"后只显示"待确认"暂态 → 用户感知略慢；用户接受该折损换取并发一致性。
- **F5 刷新需重输 token**：web 端不持久化 token（沿用 M2）→ 刷新后 URL hash 仍带 token 故实际不需要重输（仅在 hash 被手动清掉时需重输）。
- **bridge 本地联调僵尸**：沿用 M2 current-state.md TODO（tsx watch 对脚本崩溃不重启）→ M3 仍受影响；M3 不解决此历史问题。
- **未知 CLI flag 静默忽略**：编排裁定，systemd wrapper 可能传额外 flag，bridge 必须静默吃掉而不能因未知 flag 退出 1（与 §2.1 一致）。
- **ADR-0006 与 envelope.md 锁版承诺描述同步**：破锁修订需在 envelope.md 与 ADR 双向引用，确保后续维护者找到决策源头。

## 相关

[[architecture/protocol/README.md|协议 v1]] / [[architecture/protocol/envelope.md]] / [[architecture/protocol/control.md]] / [[architecture/protocol/pi.md]] / [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] / [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] / [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006（待建）]] / [[roadmap.md#5-里程碑|M3 行]] / [[prds/m2-tunnel.md|M2 PRD]] / [[current-state.md]] / [[getting-started.md]]

---

## 已敲定决策记录（2026-09-05 用户确认）

1. **extension_ui_response web wire 形状**：统一 `{request_id, cancelled: boolean, value?: string | boolean}`，bridge 翻译 pi 原生三态；confirm 靠 `value: boolean` 表达"否"（`value: false`），select / input / editor 传 string。
2. **配置字段命名**：`worker_url` / `web_base_url` / `work_dir` / `token`。
3. **work_dir 校验**：启动时严格校验（存在 + 是目录 + 当前用户可读），否则退出码 1；不自动 mkdir。
4. **"最新 session"判定**：文件名时间戳字典序（ISO = 时间序）+ 同时间戳多文件取 mtime 最新。
5. **阻塞请求 wire 路径**：经 `pi/event` 原样转（`payload.event === "extension_ui_request"`），不新增 envelope type。
6. **多 web 端弹窗**：广播、先答者胜，迟到者收 `request_expired`。
7. **idle kill 后**：exited 不自动重启，spawn 触发集命令（prompt / steer / follow_up / get_messages）再唤醒；`get_state` 永远由 bridge 内存作答、永不 spawn；abort 在 exited 为 no-op。
8. **editor 无 timeout**：无限阻塞落档为已知行为（ADR-0004 不自动失败）。
9. **未知 CLI flag**：静默忽略（systemd wrapper 友好），编排裁定，不做严格报错。
10. **协议破锁**：control 由 8 个 type 增至 9 个 type（新增 `get_state`），envelope.md 演进规则 (b) 同步修订；ADR-0006 记录决策源头。
11. **kill 标记机制**：bridge 主动 kill（idle 超时 SIGTERM→1s→SIGKILL）走"自主 kill 标记"路径，exit 回调识别标记后走 exited 不重启；非自主 kill + exit≠0 走崩溃重启；非自主 kill + exit=0 走 exited 不重启。
