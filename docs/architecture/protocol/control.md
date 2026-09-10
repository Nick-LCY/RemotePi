# control 家族：连接与会话生命周期

> 状态：定稿（2026-09-05），协议版本 v1。字段与语义变更须走 [[architecture/protocol/envelope.md]] 的版本化流程。
>
> **M4 修订注记（2026-09-08）**：control 家族从 9 增至 13 type（新增 `list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`，破锁依据见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]]，沿用 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] 范式）；`session_list.payload` / `session_state.payload` / `session_list` 回执字段同步修订。
>
> **bridge 接收侧 read-idle 判死修订注记（2026-09-10）**：bridge 不再主动发 `control/ping`；原 §2「web / bridge 双方互发」语义修订为「web 侧仍主动 / bridge 侧仅应答」；bridge 改走滑动窗口 read-idle 判死（机制见新增 §9）。wire 协议不变（ping/pong 帧结构、DO 心跳 20s/30s/3 全不变）；DO 对旧版 bridge 仍完全兼容。决策依据见 [[architecture/decisions/0011-bridge-receiver-side-read-idle-deadlock.md|ADR-0011]]。

## 家族定位

`control` 家族承载**连接建立、保活、在位状态与会话管理**，是控制面而非对话面。中间层只深度理解其中 3 个 type——`handshake`（鉴权）、`bridge_status`（自己生成）、`error`（自己生成）——其余一律原样转发。详见 [中间层处理规则](#中间层处理规则)。

共 **13 个 type**：`handshake` / `ping` / `pong` / `bridge_status` / `session_state` / `session_list` / `get_state` / `result` / `error` / **`list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`**（最后 4 个为 M4 新增）。

破锁历史：
- M3：`get_state` 加入（8 → 9，破锁 control 家族 v1 内不再新增 type 的承诺，理由见 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]]）。
- M4：4 个 work-dir 相关 type 加入（9 → 13，沿用 ADR-0006 范式，理由见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]]）。

---

## 1. handshake

连上后的第一帧。

```json
{
  "v": 1,
  "kind": "control",
  "type": "handshake",
  "id": "…",
  "payload": {
    "role": "bridge",
    "token": "x9K…"
  }
}
```

- **方向**：web / bridge → 中间层
- **payload**：
  - `role`：`"web" | "bridge"`，必填。
  - `token`：string，必填，与连接升级时 WebSocket subprotocol 第 2 元素一致（见 [[architecture/protocol/envelope.md#锁版承诺v1-存续期内不可变]]）。
- **规则**：
  - 服务端在 101 升级响应中必须回显 Sec-WebSocket-Protocol: remotepi.v1（RFC 6455：客户端带 subprotocol 而服务端不回显/回显多项，浏览器会判握手失败——已实测 workerd 默认不回显，需显式设置；2026-09-05 M2 联调确认）。
  - 连接建立后 **5 秒内** 必须收到 handshake，超时则回 `error(auth_failed)` 并断开（见 [配套常量](#配套常量)）。
  - `role` 与连接入口路径（`/web` / `/bridge`）不符 → `error(auth_failed)`。
  - 同一 token 已有 bridge 在线，第二个 bridge → `error(duplicate_bridge)`。
- **备注**：token 颁发方式（bridge 启动时动态生成、网页经 URL 携带、吊销流程等）属**产品流程**，由后续 PRD 定义；本文档只约束 wire 行为。

---

## 2. ping

```json
{ "v": 1, "kind": "control", "type": "ping", "id": "…", "payload": { "nonce": "a1b2" } }
```

- **方向**：**web 侧主动发**；bridge 侧不再主动发 `ping`，仅对收到的 `ping` 回 `pong`（见 §3 + §9）；中间层原样转发到对端。
- **payload**：`nonce`：string，可选但建议携带，用于配对 pong。
- **规则**：web 端每 **20 秒** 发一次（见 [配套常量](#配套常量)）；DO 每 **20 秒** 对各连接直发自己的 `ping`（与 web 互发的 ping 共用同一帧结构，但 nonce 由 DO 独立生成——见 [[architecture/decisions/0011-bridge-receiver-side-read-idle-deadlock.md|ADR-0011]] §双向引用 / worker `heartbeat.ts`）。

> 备注：中间层亦可主动向连接发送 ping 用于自身判死（如 bridge 心跳超时判定 stale）；这不改变 ping/pong 的转发语义，也不新增 wire 字段。（v1 兼容补充，2026-09-05）
>
> **2026-09-10 修订（ADR-0011）**：原「web / bridge 双方互发」语义修订为「web 侧主动 + bridge 侧仅应答」——bridge 已不再以 20s 节奏主动发 `control/ping` 给 DO；bridge 改走 §9 接收侧 read-idle 滑动窗口判死。wire 协议（payload 形状 / nonce 配对 / 中间层转发）零变化；DO 20s 心跳直发行为不变；DO 对旧版 bridge（仍主动发 ping）完全兼容——握手成功后旧 bridge 仍按 20s 节奏发 ping，DO 正常转发，web 端正常应答，业务零影响。

---

## 3. pong

```json
{ "v": 1, "kind": "control", "type": "pong", "id": "…", "payload": { "nonce": "a1b2" } }
```

- **方向**：web / bridge 收到 ping 后回发；中间层原样转发到对端。
- **payload**：`nonce`：原样带回对端 ping 的 `nonce`（nonce 即配对凭据，**不用** `reply_to`）。
- **规则**：**web 端**仍按 30 秒未收到 pong 记一次超时 / 连续 3 次认定对端已死的旧规则（见 [配套常量](#配套常量)）——web 侧互喊 30s×3 规则不变。**bridge 端不再以 30s×3 规则执行**（bridge 已不再主动发 ping，无所谓对端是否回 pong）；bridge 改走 §9 接收侧 read-idle 滑动窗口判死。
- **bridge 收 pong 静默丢弃**：bridge 收到 `control/pong` 不消费（无 pending nonce 配对，无应用状态迁移）——直接走 envelope 解析成功路径，作为「收到任意 inbound envelope」刷新 §9 IDLE_TIMEOUT_MS 滑动窗口计时器，不向 pi / 日志 / 业务侧派发任何事件。
- **设计理由**：长连接可能被中间网络设备静默掐断且本端无感知，应用层互喊是唯一可靠的存在性探测。

---

## 4. bridge_status

bridge 在不在线（由中间层生成）。

```json
{
  "v": 1,
  "kind": "control",
  "type": "bridge_status",
  "id": "…",
  "payload": {
    "online": false,
    "changed_at": "2026-09-05T10:00:00Z",
    "reason": "stale"
  }
}
```

- **方向**：中间层 → 所有网页（广播）。
- **payload**：
  - `online`：boolean。
  - `changed_at`：ISO8601 时间戳。
  - `reason`：`"connected"`（连上）/ `"closed"`（连接断开）/ `"stale"`（心跳判死）。
- **触发时机**：bridge 完成 handshake / bridge 连接断开 / 心跳判死；新网页完成 handshake 后**立刻补发一条当前状态**。
- **设计理由**：由中间层发是因为 bridge 无法播报自己的死讯——崩溃、断网时它什么都发不出来。离线显示不区分正常停止与崩溃（用户不关心，故不设 bye 消息）。

---

## 5. session_state

某个会话的 pi 进程在哪个生命周期阶段（由 bridge 发）。

```json
{
  "v": 1,
  "kind": "control",
  "type": "session_state",
  "id": "…",
  "session": "…",
  "payload": {
    "phase": "idle",
    "blocked_on": [
      { "method": "confirm", "id": "…", "title": "…", "message": "…", "timeout": 30000 }
    ],
    "work_dir": "/abs/path/cwd"
  }
}
```

- **方向**：bridge → 所有网页（广播）。
- **会话字段**：一条消息对应一个 pi 进程；envelope `session` 字段区分；单进程阶段可省略。M4 多会话下**必填**（操作惯例，schema 仍 optional 不破锁），详见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]] §决策.3。
- **payload**：
  - `phase`：`"spawning"`（启动中）/ `"ready"`（可用）/ `"running"`（干活中）/ `"idle"`（空闲）/ `"exited"`（已退出）。
  - `blocked_on`（M3 新增，可选）：未决阻塞弹窗数组；缺省视为空数组。每项是 [[architecture/protocol/pi.md#extension_ui_request|4 类 `extension_ui_request` 阻塞方法]]之一（`select` / `confirm` / `input` / `editor`），形状与 pi 原生 `extension_ui_request` 对应阻塞方法同形（`method` / `id` / `title` / 方法专属字段 / 可选 `timeout`，editor 无 `timeout`）；fire-and-forget 5 类（`notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`）不入此数组，详见 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]]。
  - `work_dir`（M4 新增，可选）：该 pi 进程的工作目录；每条广播携带对应 work_dir，便于 web 在 `ChoicePage` 列表直接渲染（不查 `session_list`）。缺省视为"未知 work_dir"（M3 单会话阶段不回填）。schema 锁版不变，仅新增可选字段。`ChoicePage` 为任务 07 落地（详见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]] §决策.2 / §决策.3）。
- **规则**：一轮对话结束（pi 报 `agent_settled`）→ `idle`；空闲满 5 分钟 bridge 杀掉 pi 进程 → `exited`。`blocked_on` 在弹窗出现 / 提交 / 超时时同步增删。
- **设计理由**：状态属于 pi 进程而不属于 bridge（一个 bridge 可能同时管理多个 pi 进程），故按会话一条。`blocked_on` 与 session_state 同帧广播是为了让 web 端弹窗组件仅由状态帧驱动渲染（无乐观 UI），详见 ADR-0004。`work_dir` 与 session_state 同帧广播是为了让 web 端 `ChoicePage` 列表行直接显示 work_dir 而无需额外查 `session_list`。

---

## 6. session_list

拉取对话列表。

```json
{ "v": 1, "kind": "control", "type": "session_list", "id": "r1", "payload": { "work_dir": "/abs/path/cwd" } }
```

- **方向**：web → bridge（中间层转发）。
- **payload**：`work_dir?: string`（M4 新增，可选）——按 work_dir 过滤会话清单（裁定 A：M4 操作惯例必带，schema 仍 optional 不破锁；缺省全量扫描仅作 M3 兼容语义保留，M4 web UI 不走此路径）。envelope `session` 字段在多会话下**必填**（操作惯例），M4 ChoicePage level=2 入口走 `session: <work_dir>` + `payload.work_dir: <work_dir>` 双携带模式。
- **回执**：走 `result`（见 [§7](#7-result)）；M4 回执 `data.sessions[]` 新增 `status` 字段（5 枚举 + `unknown`）。

---

## 6.5 get_state

拉取当前会话的 pi 进程状态 + 未决阻塞弹窗（由 bridge 发，回执走 `result`）。

```jsonc
// web → bridge
{ "v": 1, "kind": "control", "type": "get_state", "id": "g1", "payload": {} }

// bridge → web（result 回执）
{
  "v": 1,
  "kind": "control",
  "type": "result",
  "id": "g2",
  "reply_to": "g1",
  "payload": {
    "ok": true,
    "data": {
      "phase": "ready",
      "blocked_on": [
        // 可选；与 session_state.payload.blocked_on 同形状
        { "method": "input", "id": "…", "title": "…", "placeholder": "…" }
      ]
    }
  }
}
```

- **方向**：web → bridge（中间层转发到 bridge），bridge → web 走 `result`（与 `session_list` 同形态）。
- **payload**：当前为空对象 `{}`；将来加过滤字段时按 [[architecture/protocol/envelope.md#演进规则v1-存续期内允许|envelope 演进规则 (a)]] 新增可选字段。
- **回执**：`result.data = { phase: SessionPhase, blocked_on?: BlockedOnEntry[] }`；`phase` 取值沿用 [§5](#5-session_state) 已锁版的 5 相位枚举（不破锁）；`blocked_on` 与 `session_state.payload.blocked_on` 同形状（可选数组，元素为 4 类 `extension_ui_request` 阻塞方法之一），缺省视为空数组。
- **回执失败**：`result.ok = false` 时 `error.code` 复用 [§8](#8-error) 已锁版的 6 个 code 集合（不允许新增）。
- **exited 语义**：bridge 永远由内存作答（phase / blocked_on 的当前值），**永不 spawn**——即使当前 phase 为 `exited`，也即时回执不触发重启；详见 ADR-0003 末尾 "exited 状态 spawn 触发集"。
- **破锁依据**：M3 新增，破锁 control 家族 v1 内不再新增 type 的承诺，理由见 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]]。

---

## 6.6 list_directories

按路径列出子目录（仅目录、不含文件；M4 `ChoicePage` "浏览添加"对话框使用）。

```jsonc
// web → bridge
{ "v": 1, "kind": "control", "type": "list_directories", "id": "d1", "payload": { "path": "/home/sankabox" } }
// path 可省略 —— 缺省列 $HOME

// bridge → web（result 回执）
{
  "v": 1,
  "kind": "control",
  "type": "result",
  "id": "d2",
  "reply_to": "d1",
  "payload": {
    "ok": true,
    "data": {
      "entries": [
        { "name": "code", "path": "/home/sankabox/code" },
        { "name": "Documents", "path": "/home/sankabox/Documents" }
      ]
    }
  }
}
```

- **方向**：web → bridge（中间层转发），bridge → web 走 `result`（与 `session_list` / `get_state` 同形态）。
- **payload**：`path?: string`——可选；缺省 = `$HOME`（`os.homedir()`）；提供时由 bridge 走 `path.resolve(path)` 规范化。
- **回执**：`result.data = { entries: { name: string, path: string }[] }`——**只列子目录**（`dirent.isDirectory()` 过滤），不含文件。
- **回执失败**：`result.ok = false` + `error.code` 复用 [§8](#8-error) 已锁版的 6 个 code 集合（**不新增**——ADR-0010 §决策.8）。落地映射（任务 05 实施期定稿）：
  - ENOENT / EACCES / EPERM / ENOTDIR → `result.ok = false` + `error.code = 'invalid_envelope'`，`error.message` 携带 domain 级区分（`path_not_found` / `path_not_readable` / `path_not_directory`）便于运维定位。**语义注记**：此处 `invalid_envelope` 在 list_directories 上下文中扩展为"envelope payload 指向不可用的 fs 实体（路径不存在 / 不可读 / 不是目录）"——并非 envelope 结构本身错误（结构错误仍走 M3 §8 原义）；domain code 落在 message 字段，wire code 统一收敛。
  - EIO / ELOOP / 其他非预期 fs 错误（stat / accessSync / readdir 三处任一抛出未分类 errno）→ `error.code = 'internal'`。
  - 映射表是单点真理：`mapListDirectoriesDomainCodeToWire` 在 `list-directories.ts` 落地，dispatcher 只调用该函数。
- **dotfile 行为**：列出所有子目录（含 dotfile 前缀目录，如 `.config` / `.cache`），UI 层可选择性过滤——属产品 UI 关注点，非 wire 契约。
- **范围限制**：业务共识 2 "起点 home，不设范围限制"——任何合法路径都可列；单用户自用，无 traversal 安全顾虑。
- **破锁依据**：M4 新增（9 → 13），沿用 ADR-0006 范式，理由见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]] §决策.1。

---

## 6.7 work_dir_list

拉取用户保存的工作目录清单。

```jsonc
// web → bridge
{ "v": 1, "kind": "control", "type": "work_dir_list", "id": "w1", "payload": {} }

// bridge → web（result 回执）
{
  "v": 1,
  "kind": "control",
  "type": "result",
  "id": "w2",
  "reply_to": "w1",
  "payload": {
    "ok": true,
    "data": { "work_dirs": ["/home/sankabox/code", "/home/sankabox/Documents"] }
  }
}
```

- **方向**：web → bridge（中间层转发），bridge → web 走 `result`。
- **payload**：当前为空对象 `{}`；将来加过滤字段时按 envelope 演进规则 (a) 新增可选字段。
- **回执**：`result.data = { work_dirs: string[] }`——bridge 内存中保存的工作目录清单（与 bridge `state.json` 同步）。
- **回执失败**：`result.ok = false` + `error.code` 复用 §8 已锁版的 6 个 code 集合（不新增）。
- **破锁依据**：M4 新增（9 → 13），理由见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]]。

---

## 6.8 work_dir_add

向用户保存的工作目录清单添加一项。

```jsonc
// web → bridge
{ "v": 1, "kind": "control", "type": "work_dir_add", "id": "w3", "payload": { "path": "/home/sankabox/code" } }

// bridge → web（result 回执）
{
  "v": 1, "kind": "control", "type": "result", "id": "w4", "reply_to": "w3",
  "payload": { "ok": true }
}
```

- **方向**：web → bridge（中间层转发），bridge → web 走 `result`。
- **payload**：`path: string`——必填，绝对路径。
- **回执**：成功回 `result.ok = true`（`data` 可省略；web 端通过再发 `work_dir_list` 刷新）。重复添加 = 幂等（已存在则 no-op，回 `ok: true`）。
- **回执失败**：`result.ok = false` + `error.code` 复用 §8 已锁版的 6 个 code 集合（不新增）——非法路径 / 不是目录 / 不可读 三件套校验失败时回 `internal` 或 `invalid_envelope`（实施期选最贴切的 code）；state.json 写失败回滚内存后回 `internal`。
- **bridge 行为**：参数校验（存在 + 是目录 + 可读，与 M3 §2.1 同三件套）→ 内存 push → 同步写 state.json（atomic rename）→ 回执。
- **破锁依据**：M4 新增（9 → 13），理由见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]]。

---

## 6.9 work_dir_remove

从用户保存的工作目录清单移除一项。

```jsonc
// web → bridge
{ "v": 1, "kind": "control", "type": "work_dir_remove", "id": "w5", "payload": { "path": "/home/sankabox/code" } }

// bridge → web（result 回执）
{
  "v": 1, "kind": "control", "type": "result", "id": "w6", "reply_to": "w5",
  "payload": { "ok": true }
}
```

- **方向**：web → bridge（中间层转发），bridge → web 走 `result`。
- **payload**：`path: string`——必填，绝对路径。
- **回执**：成功回 `result.ok = true`（`data` 可省略）。
- **回执失败**：`result.ok = false` + `error.code` 复用 §8 已锁版的 6 个 code 集合（不新增）。
- **bridge 行为**：内存 filter → 同步写 state.json → 回执。**钉子 3**（PRD）：**不**清理 agent dir 的会话文件；**不** kill 不打断活 manager（cwd = 该 work_dir），跑完 idle 自然回收（裁定 C 下 ready 5min 也计入）；目录从清单移除后 web `ChoicePage level=2` 不再列该 work_dir 下的会话（即 level2 不可达），但已在 ChatView 看的会话不受影响。
- **破锁依据**：M4 新增（9 → 13），理由见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]]。

---

## 7. result

control 请求的通用回执。

```json
{
  "v": 1,
  "kind": "control",
  "type": "result",
  "id": "…",
  "reply_to": "r1",
  "payload": { "ok": true, "data": { "sessions": […] } }
}
```

- **方向**：bridge → web。
- **信封字段**：`reply_to` **必填**，指向请求的 `id`。
- **payload**：
  - `ok`：boolean。
  - `data`：成功时携带（结构随请求 type 而变）。
  - `error`：失败时携带 `{ code, message }`。
- **`session_list` 回执**（M3 + M4）：`data.sessions` 为数组，每项字段：

  | 字段 | 类型 | 说明 |
  |------|------|------|
  | `id` | string | 会话标识 |
  | `name` | string \| null | 会话名，可空 |
  | `cwd` | string | 工作目录 |
  | `created` | ISO8601 | 创建时间 |
  | `modified` | ISO8601 | 最后活跃时间 |
  | `message_count` | number | 消息数 |
  | `first_message` | string \| null | 首条消息摘要，可空 |
  | `running` | boolean | M3 已定义——该会话的 pi 进程是否存活（含空闲）；保留语义。正在干活与否看 `session_state` |
  | `status` | `"exited"` \| `"idle"` \| `"running"` \| `"spawning"` \| `"unknown"` | **M4 新增**——当前 `PiProcessManager.phase` 简化映射；`unknown` = 未在 bridge 内存中（无活跃 manager，可能从未被该 bridge 看过）；会话被外部 pi 占用时也返回 `unknown`（**不做检测**，对齐业务共识 3 / 正式关闭 [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] §验证与后续段挂账）。详见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]] §决策.2 |
- **`get_state` 回执**（M3 新增）：`data = { phase, blocked_on? }`；`phase` 取值见 [§5](#5-session_state) 5 相位枚举；`blocked_on` 与 `session_state.payload.blocked_on` 同形状（可选数组，元素为 4 类 `extension_ui_request` 阻塞方法之一）。
- **`work_dir_list` 回执**（M4 新增）：`data = { work_dirs: string[] }`——bridge 内存中保存的工作目录清单（与 bridge `state.json` 同步）。
- **`list_directories` 回执**（M4 新增）：`data = { entries: { name: string, path: string }[] }`——指定路径下的子目录列表（不含文件；起点 home，不设范围限制）。
- **`work_dir_add` / `work_dir_remove` 回执**（M4 新增）：成功回 `result.ok = true`（`data` 可省略；web 端通过再发 `work_dir_list` 刷新）；失败回 `result.ok = false` + `error.code`（复用 [§8](#8-error) 已锁版的 6 个 code 集合，不新增）。

---

## 8. error

出错定向发回肇事方（由中间层生成）。

```json
{
  "v": 1,
  "kind": "control",
  "type": "error",
  "id": "…",
  "payload": { "code": "duplicate_bridge", "message": "…", "terminal": true }
}
```

- **方向**：中间层 → 肇事连接，**不广播**。
- **payload**：
  - `code`：见下表，**全集只增不改、不复用**。
  - `message`：人类可读描述。
  - `terminal`：boolean。`true` 表示发完即断开 WebSocket（关闭码统一 `1008`，见 [配套常量](#配套常量)）；`false` 表示发完继续。
- **错误码全集**：

  | code | 触发条件 | terminal |
  |------|----------|----------|
  | `auth_failed` | token 不符 / handshake 超时 / role 与入口不符 | true |
  | `duplicate_bridge` | 同 token 已有 bridge 在线 | true |
  | `invalid_envelope` | 消息结构解析失败 / `session:'new'` 缺 `payload.work_dir`（M4 钉子 2 边界） | false |
  | `unsupported_version` | `v` 不是 `1` | true |
  | `unsupported_type` | type 不识别且无法转发处理时 | false |
  | `internal` | 中间层内部异常 / bridge state.json 写失败回滚 / `list_directories` 路径校验失败 等 | false |

> M4 不新增 code（[[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]] §决策.8）：4 个新 type 失败时复用 `invalid_envelope` / `internal`（按实施期最贴切选）；新 type 已被 `CONTROL_TYPES` 字面量覆盖、worker `routeOpenMessage` 的 `default` 分支自动转发，不会触发 `unsupported_type`——该 code 仅面向真正未知的 type。

---

## 配套常量

| 常量 | 数值 | 出处 | 作用域 |
|------|------|------|--------|
| handshake 等待窗口 | 5 秒 | §1 | DO 侧（worker `heartbeat.ts` `HANDSHAKE_TIMEOUT_MS`） |
| ping 间隔 | 20 秒 | §2 | web 端 + DO 主动发 ping（worker `heartbeat.ts` `PING_INTERVAL_MS`）；**bridge 端不再发 ping** |
| pong 超时 | 30 秒 | §3 | web 端 + DO 收 pong 超时（worker `heartbeat.ts` `PONG_TIMEOUT_MS`）；**bridge 端不再走此规则** |
| 判死次数（连续 pong 超时） | 3 次 | §3 | web 端 + DO；**bridge 端不再走此规则** |
| fatal 关闭码（WebSocket） | `1008` | §8 / [[architecture/protocol/envelope.md#锁版承诺v1-存续期内不可变]] | DO 协议 fatal 关闭（1008 仍保留） |
| 空闲杀进程倒计时 | 5 分钟 | §5 | `PiProcessManager` `IDLE_TIMEOUT_MS`（**与 §9 bridge client 的 90s 是两个不同的常量**，不要 grep 同名混淆——前者是进程级 idle 杀 pi，后者是 WSS 接收侧 read-idle 判死） |
| **bridge 接收侧 read-idle 阈值**（**新增 2026-09-10**） | **90_000 ms（≈ DO 20s 心跳 ×3 + 余量）** | **§9** | **bridge client 侧 `IDLE_TIMEOUT_MS`**（**`packages/bridge/src/client.ts`，read-idle 滑动窗口；与上面 5min `PiProcessManager.IDLE_TIMEOUT_MS` 同名但用途不同——前者判死 WSS 连接，后者判死 pi 子进程；详见 §9 与 ADR-0011 §决策）** |

> 数值为初始经验值，实现时可调，调整属 [[conventions/README.md|实现约定]] 范畴。
>
> **同名 `IDLE_TIMEOUT_MS` 辨析**（2026-09-10 落地注记，reviewer 指出 docs grep 会撞名）：文档库当前存在两处 `IDLE_TIMEOUT_MS`——(a) `PiProcessManager` 5 分钟空闲杀 pi 进程常量（[[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] §3，作用域 = 每个 pi 子进程 manager，逐会话复制）；(b) `BridgeClient` 90 秒接收侧 read-idle 判死常量（本节 §9 新增，[[architecture/decisions/0011-bridge-receiver-side-read-idle-deadlock.md|ADR-0011]] §决策，作用域 = bridge WSS 连接本身）。**两者层级不同**：(a) 在 bridge 进程内管理子进程；(b) 在 bridge 进程内管理 WSS 长连接。实现时各自模块内常量化（如 `packages/bridge/src/pi-process.ts` 与 `packages/bridge/src/client.ts` 分别导出），不共享。本节配套常量表的「作用域」列即用于避免混淆。

## 9. bridge 接收侧 read-idle 判死（**新增 2026-09-10**）

> **本节为新增节**，承载 bridge 端「不主动发 ping / 滑动窗口 read-idle 判死」机制的契约层定义。代码层落地于 `packages/bridge/src/client.ts` 的 `IDLE_TIMEOUT_MS = 90_000`（与 §5 / §配套常量 同名 `IDLE_TIMEOUT_MS` 辨析已注明）；决策依据见 [[architecture/decisions/0011-bridge-receiver-side-read-idle-deadlock.md|ADR-0011]]。

### 9.1 应用模型

bridge 是**常驻后台工人**（长连 worker DO，多 session 多 pi 子进程由它监管）；web 是**随上随下的遥控器**（用户开浏览器就连，关浏览器就走）。bridge 不应把 web 的死活当作自己的健康信号——web 离线与 bridge 存活是正交事件。

### 9.2 机制（四条）

1. **bridge 不再主动发 `control/ping`**——§2 原「web / bridge 双方互发」语义修订为「web 侧主动 + bridge 侧仅应答」；bridge 收到 `ping` 仍按 §3 回 `pong`，但不再以 20s 节奏主动 outbound `ping`。`pongTimeoutMs` 选项改名 `idleTimeoutMs`，`pingIntervalMs` / `pongTimeoutsBeforeDead` 选项删除（见 [[architecture/decisions/0011-bridge-receiver-side-read-idle-deadlock.md|ADR-0011]] §决策）。
2. **DO 心跳直发 bridge，不经 web**——worker `heartbeat.ts` 每 20s 对各连接直发自己的 `control/ping`（nonce 由 DO 独立生成），bridge 收到后回 `pong`（无 pending nonce 配对，仅作 inbound 帧计入 §9.2.3 滑动窗口）。web 侧互喊与 DO 主动 ping 走同一帧结构，但 bridge 不区分两路 ping 的 nonce 来源——bridge 不需要区分，详见 §3 「bridge 收 pong 静默丢弃」。
3. **滑动窗口 read-idle 判死**——bridge 在每收到**任何解析成功的 inbound envelope** 时刷新 `IDLE_TIMEOUT_MS = 90_000`（≈ DO 20s 心跳 ×3 + 余量）计时器。覆盖范围包括但不限于：`control/ping`（DO 直发或 web 转发）/ `control/pong` / `control/handshake` / `control/bridge_status` / `control/result` / `control/error` / `control/session_state` / `control/session_list` / `control/get_state` 回执 / 全部 pi 家族 envelope。**故意排除**：解析失败的入站帧（不刷新窗口）——「服务器狂发坏帧本身即病态信号」，继续刷新会让真正死掉的连接借坏帧延命，是有意选择（reviewer S5 注记，详见 ADR-0011 §决策.3）。
4. **超时 → close(1000, 'idle timeout') → handleClose 退避重连**——`IDLE_TIMEOUT_MS` 计时器触发：bridge 打 `warn "no inbound frame for 90000ms, closing"` → `ws.close(1000, 'idle timeout')` → 现有 `handleClose` 路径生效（close code 1000 走正常重连路径；1008 仍保留协议 fatal 关闭，语义不变）。指数退避沿用既有 `BACKOFF_BASE_MS = 1_000` / `BACKOFF_CAP_MS = 30_000` / ±20% jitter。

### 9.3 wire 不变

- `control/ping` / `control/pong` 帧结构零变化（nonce 可选 / 必填规则不变）。
- DO 心跳 20s / pong 超时 30s / 判死 3 次 全部不变（worker `heartbeat.ts` 零改动）。
- 中间层（原样转发）零改动——bridge 不再主动 outbound ping 后，中间层不再收到 bridge→DO 的 ping 帧，但中间层 `routeOpenMessage` 的 default 分支对剩余所有控制类帧的转发语义不变。
- §2 「中间层亦可主动向连接发送 ping 用于自身判死」备注仍成立——中间层（DO）仍按 20s 节奏直发 ping 给 bridge，与本节机制协同而非冲突。

### 9.4 web 端不变

- web 端 WsClient 仍按 20s 主动发 `control/ping` / 30s×3 无 pong 判死的旧规则——本节机制仅替代 bridge 端旧行为，web 侧互喊不变。
- web 端对老版本 bridge（仍主动发 ping）完全兼容——web 不关心 bridge 是否主动 ping，只关心 ping/pong 帧是否正常流动。

### 9.5 向后兼容

- **DO 对旧版 bridge 完全兼容**——旧 bridge 仍按 20s 节奏发 `control/ping`，DO 照常转发并按 30s×3 规则对待；DO 零改动。
- **新 bridge 对老版本 web 完全兼容**——web 主动 ping 仍能被新 bridge 收到并回 pong（bridge 对 ping 应答路径未变）；web 不感知 bridge 是否主动 ping。
- **bridge 切换无需 worker 配合部署**——纯客户端行为变更 + 文档注记；worker / DO / web 三端无需同步切换。
- **用户行动**：本地跑旧版 bridge 的实例需要择机重启才生效（重启时加载新版 `packages/bridge`，行为自动切到 §9.2 接收侧 read-idle）；旧版 bridge 在 5min 内连续触发旧 30s×3 判死 → 无限退避重连循环的缺陷（详见 ADR-0011 §背景）随重启一并消失。

## 中间层处理规则

中间层只深度处理以下 3 件事：

1. **handshake** —— 完成鉴权（token / role / 超时窗口 / duplicate 检测）。
2. **bridge_status** —— 自己生成，触发条件见 §4。
3. **error** —— 自己生成，触发条件见 §8。

其余消息一律原样转发：`ping` / `pong` / `session_list` / `get_state` / `result` / `session_state` / **`list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`（M4 新增）** 以及整个 [[architecture/protocol/pi.md|pi 家族]]。

其中 `get_state` 由 web 发到 bridge，bridge 用本地内存作答（phase / blocked_on 的当前值），中间层不参与；`result` 是其回执。M4 的 `list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove` 同形态——web 发到 bridge，bridge 处理后回 `result`，中间层不参与处理内容；worker DO `routeOpenMessage` 的 `default` 兜底分支自动转发（与 `get_state` 同路径，零业务代码改动；M3 教训 `1c86aca` 同类补漏落地，详见 worker/src/room.ts §`routeOpenMessage` 注释）。

**2026-09-10 修订注记**：bridge 不再主动 outbound `control/ping`，故中间层不再收到 bridge→DO 的 ping 帧；DO 仍直发自己的 ping 给 bridge（worker `heartbeat.ts`），bridge 回 pong 仍按转发规则原样处理。本节规则不变——ping/pong 仍是中间层原样转发的 9 类 frame 之一。