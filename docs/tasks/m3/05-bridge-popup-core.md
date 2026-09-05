---
prd: prds/m3-single-session.md
status: done
---
# 任务：bridge 弹窗核心（blocked_on 维护 + wire 翻译 + 广播原则）+ bridge 测试扩展（30+ 条）

## 目标
按 [[prds/m3-single-session.md|M3 PRD §2.4 + §6.2]] 落地 bridge 端弹窗转发核心：`Map<requestId, BlockedOnEntry>` 内部状态 / 4 类阻塞弹窗入列 + fire-and-forget 5 类本地消化 / timeout 镜像（与提交竞态原子检查，输家 no-op）/ wire 翻译（web extension_ui_response → pi 原生三态，confirm value:false 路径）/ 多 web 端先答者胜 / 广播原则（写操作触发，get_messages 不触发）。并落地 30+ 条 bridge vitest 用例（含 confirm boolean 双用例 + 自主 kill 三路径 + spawn 触发集 + 翻译一致性）。

关键要点：

- **新增 `packages/bridge/src/extension-ui.ts`**：
  - `class ExtensionUIRouter` 持有 `Map<requestId, BlockedOnEntry>` + `Map<requestId, NodeJS.Timeout>`（timeout 句柄）+ 引用 session 状态机广播函数
  - `handleEventFromPi(rawEvent)`：解析 `event.event === "extension_ui_request"` → 按 method 分流：
    - 4 类（select / confirm / input / editor）→ 入 Map → 广播 session_state（含新 blocked_on）→ 通过 `pi/event` envelope 原样转给 web（含 timeout 字段）
    - 5 类 fire-and-forget（`notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`）→ `logger.info` 消化，不转发，不入 blocked_on
    - entry 含 timeout → 起 `setTimeout(timeout, () => this.timeoutFired(requestId))`（I 决策：镜像契约）
  - `handleWebResponse(envelope)`：zod 校验 web wire 形状（`ExtensionUIResponsePayloadSchema`，含 cancelled / value refine）→ 原子检查 Map：存在 → 翻译为 pi 原生三态 → 写 stdin → 清除 entry → 清除对应 timeout → 广播 session_state（blocked_on 已不含该 id）；不存在 → 回 `command_result{success: false, error: {code: 'request_expired', message: '...'}}`（迟到提交）
  - `timeoutFired(requestId)`：原子检查 Map → 仍在 → 清除 entry → 广播 session_state（blocked_on 已不含该 id）；已被提交清除 → 静默 no-op
  - **wire 翻译**（PRD §1.6 / §2.4）：
    - `cancelled === true` → 写 `{ type: 'extension_ui_response', id, cancelled: true }`
    - `cancelled === false` + method === `confirm` → 写 `{ id, confirmed: value as boolean }`（`value: false` 即 confirm 的"否"）
    - `cancelled === false` + method ∈ `[select, input, editor]` → 写 `{ id, value: value as string }`
    - bridge 写 stdin 失败（子进程死）→ 记 error 日志 + 强制 exited + 广播
  - **广播原则**（PRD §2.4 + §1）：session_state 广播**仅由写操作触发**（prompt / steer / follow_up / abort / extension_ui_response 处理后）+ 状态迁移（相位变化）+ blocked_on 变化；`get_messages` 永不触发广播
- **改 `packages/bridge/src/client.ts`**：bridge 收 web 入站按 envelope.type 分流：
  - `pi/prompt` / `pi/steer` / `pi/follow_up` / `pi/abort` / `pi/get_messages` / `pi/extension_ui_response` → 转发给 pi-process（触发 §2.7 语义）
  - `control/session_state` 不存在该 type（bridge 不收 control/session_state 入站）
  - `control/get_state` → 由内存回答（**不 spawn**）→ 回 `result { ok: true, data: { phase, blocked_on? } }`
- **bridge 测试扩展 30+ 条**（PRD §6.2 完整清单；既有 8 条 + 新增 ≥ 22 条）：
  - **配置加载**（任务 03 转测）：合法 / 缺 worker_url 拒 / 缺 work_dir 拒 / 缺 web_base_url 拒 / work_dir 不存在拒 / 不是目录拒 / 不可读拒（mock fs）/ token 字段可缺省
  - **CLI 移除回归**：原 `--worker-url` / `REMOTEPI_WORKER_URL` 都不再生效（start() 完全忽略）；未知 flag 静默忽略
  - **session 扫描**：mock 文件系统，多文件按时间戳取最新（ISO 字典序 = 时间序）；同时间戳 mtime 最新；空目录 → 新建；最新文件不可读 → 报错
  - **pi 子进程状态机**：spawning → ready → running → idle → exited 迁移序列；agent_settled 启动 5min 计时（mock 时间）；超时 kill（SIGTERM→1s→SIGKILL 序列）；**自主 kill 不触发重启**（mock exit code=143 / 137 均走不重启）；**意外 exit≠0（标记不在）触发重启**，spawn 计数 +1；**exit=0（标记不在）走 exited 不重启**
  - **blocked_on 维护**：4 类入列 / 5 fire-and-forget 不入列；timeout 镜像触发 / 与提交竞态（输家走 no-op）
  - **bridge 重启**：目录扫描找最新（无云端依赖）
  - **wire 翻译**：web extension_ui_response 各 cancelled 组合 → pi 原生三态一一对应——`cancelled:true`（不附 value）/ confirm value:true → `confirmed: true` / **confirm value:false → `confirmed: false`**（独立两条用例）/ select/input/editor value:string → `value: <string>`
  - **广播原则**：get_messages 不触发 session_state 广播；prompt / steer / follow_up / abort / extension_ui_response 处理后各触发一次
  - **exited 语义**：exited 时 get_messages 触发带 `--session` 的 spawn（spawn 计数 +1）；get_state 由内存作答不 spawn；abort no-op（回 `command_result{success: true}`）

## 完成标准
- [x] `packages/bridge/src/extension-ui.ts` 落地（独立 `ExtensionUIRouter` 类）：`pending: Map<id, BlockedOnEntryPayload>` + `timeouts: Map<id, Timeout>` / 4 类（select/confirm/input/editor）入列 + 5 fire-and-forget（notify/setStatus/setWidget/setTitle/set_editor_text）`logger.info` 消化 / `handleBlockingRequest` 含 timeout 镜像 `setTimeout(timeout, () => timeoutFired(id))` + 竞态原子检查（`pending.get` + `pending.delete` 配对 + `timeouts.delete` 同步）/ wire 翻译三态（cancelled:true / confirm `value:boolean → confirmed` / select/input/editor `value:string → value`）/ 多 web 端先答者胜（广播驱动 + 后续答者收 `request_expired`）/ `clearAll` 防 ghost dialog（child exit / `stop()` 路径清空 pending + timeouts + 单次终态广播）/ S1 duplicate id 告警 / S2 `translateToPiNative` 返回 `null` 时 emit `invalid_response` 回执不静默吞
- [x] `packages/bridge/src/client.ts` 入站分流：pi 家族 6 命令（prompt/steer/follow_up/abort/get_messages/extension_ui_response）转发给 pi-process + control `get_state` 内存回答（**不 spawn**，回 `result{ok:true,data:{phase,blocked_on?}}`）+ abort 在 exited 时回 `command_result{success:true}` 不 spawn
- [x] `packages/bridge/src/pi-process.ts` 接入 `ExtensionUIRouter`（任务 04 桩替换为真构造）：`buildExtensionUIRouter(options)` 用 5 个回调（`broadcastSessionState` / `emitEventEnvelope` / `emitCommandResult` / `writeToPi` / `forceExited`）+ `setTimeout/clearTimeout` 注入（任务 04 桩接缝落地）；广播原则落地——`broadcastSessionState` 读 `router.getBlockedOn()` 组装 `session_state.payload.blocked_on`（空数组省略字段），仅由写操作 / 相位迁移 / blocked_on 变化触发（`get_messages` 永不走 `handleWriteToPi` → 永不发 broadcast）；`writeExtensionUIResponseToPi` 同步返回 boolean 失败 → `forceExitedForExtensionUIFailure(reason)` 强制 exited + 广播
- [x] 新增 `packages/bridge/src/__tests__/extension-ui.test.ts`：9 段（§1 4 类入列 + 5 fire-and-forget + 未知方法 + 非法 data / §2 timeout 镜像 + 5 处竞态原子检查 / §3 wire 翻译 8 组合含 confirm value:false 独立 / §4 多 web 先答者胜 + request_expired / §5 广播原则 / §6 stdin 写失败 / §7 clearAll / §8 envelope schema round-trip / §9 BlockedOnEntryPayload 全 method round-trip）；既有 `pi-process.test.ts` 增 §11 broadcast 原则（`11.7` extension_ui_response 触发广播 / `11.8` fire-and-forget 不触发）+ §12 exited 语义端到端（spawn 计数 +1 / get_state 内存 / abort no-op）
- [x] confirm value:false → `confirmed: false` 单测独立覆盖（test 3.3，R2 修正点）
- [x] 自主 kill 三路径单测覆盖（任务 04 已落：pi-process.test.ts 2.1/2.2/2.3，标记在→不重启 / 标记不在+code≠0→重启 / 标记不在+code=0→不重启）
- [x] wire 翻译一致性 8 种组合全覆盖（`cancelled:true` 不附 value / `cancelled:true` 附 value 仍忽略 value / confirm value:true / **confirm value:false** / select/input/editor value:string 各一条 + 完整流程 3.7）
- [x] 广播原则单测：get_messages 不触发（§11.1 + §11.8）/ prompt/steer/follow_up 各触发一次（§11.2-11.4）/ abort 不触发（§11.5 exited + §11.6 running）/ **extension_ui_response 触发一次**（§11.7 端到端断言：广播 payload 含已清空的 blocked_on）
- [x] §2.7 exited 语义单测：exited 时 get_messages 触发带 `--session` 的 spawn（§12.1 spawn 计数 +1）；get_state 内存不 spawn（§12.2）；abort no-op 回 `command_result{success:true}` 不 spawn（§12.3）
- [x] `pnpm --filter @remotepi/bridge test` 全绿（bridge **106 → 154 条**，新增 47 条）；`pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿；工作区全量 **237 条**测试全绿
- [x] `grep -c "it(" packages/bridge/src/__tests__/*.test.ts` ≥ 30（实际 154）

## 依赖
- 依赖 [[tasks/m3/01-shared-protocol-v2.md|01-shared-protocol-v2]]（需要 BlockedOnEntry / ExtensionUIResponsePayload schema）
- 依赖 [[tasks/m3/03-bridge-config-file.md|03-bridge-config-file]]（config 加载是 pi 启动前置）
- 依赖 [[tasks/m3/04-bridge-pi-process.md|04-bridge-pi-process]]（ExtensionUIRouter 依赖 pi 子进程 stdin/stdout）

## 完成情况

任务完成，commit `a466188`。bridge 弹窗核心全量落地：`extension-ui.ts` 新建（独立 `ExtensionUIRouter` 类，持有 `pending: Map<id, BlockedOnEntryPayload>` + `timeouts: Map<id, Timeout>`，通过 5 个回调钩到 manager）+ `pi-process.ts` 接入（任务 04 的 `extensionUIRouter` 桩替换为真构造 `buildExtensionUIRouter(options)`，广播原则落地——`broadcastSessionState` 读 `router.getBlockedOn()` 组装 `session_state.payload.blocked_on`、仅由写操作 / 相位迁移 / blocked_on 变化触发）+ `client.ts` 6 命令转发 + control get_state 内存作答。reviewer 通过，**零 Critical 零 Warning**；**5 项低成本 Suggestion 全修**（详见下）。bridge 测试 **106 → 154 条**（新增 47 条），工作区全量 **237 条**全绿。

### 5 项 Suggestion 落地

- **S1 duplicate id 告警**：`handleBlockingRequest` 入口 `pending.has(id)` → `logger.warn` 替换前条目（`extension_ui_request duplicate id=... — replacing prior pending entry (pi upgrade or upstream bug?)`），与未知 method 的 warn 形态对齐，便于 pi 升级后操作员从日志发现 id 碰撞。
- **S2 翻译 null 分支补 `invalid_response` 回执**：`translateToPiNative(payload, method)` 返回 `null`（理论上 schema refine 已拒 `cancelled:false` 无 value，但作为防御性兜底）时不再只 log + clear + broadcast（web 端 dialog 会"消失且无反馈"），改为额外 emit `command_result{success:false, error:{code:"invalid_response",...}}`（`reply_to = env.id`，与 `request_expired` 同样回 web envelope id），让 web 走 §4.5 提交失败 UX。
- **S3 §11 fake timers**：`pi-process.test.ts` §11 广播原则测试改用 `vi.useFakeTimers()` 推进 idle/timeout 计时，避免真实 `setTimeout` 干扰；§12 exited 语义测试保持同步 fake timers（`vi.advanceTimersByTime`）。
- **S4 §11.7 stdin 端到端断言**：test `11.7 extension_ui_response handling triggers a session_state broadcast` 升级为完整端到端——mock `child.stdin.write` 验证写出的字节流 = `{type:'extension_ui_response', id, confirmed: true}`、断言 broadcast payload 含已清空的 `blocked_on`（不是仅断言"broadcast 被调用一次"），pin 整条 wire 形态。
- **S5 `writeToPi` 同步契约 JSDoc**：`ExtensionUIOptions.writeToPi` JSDoc 明确"**keep this synchronous** — 底层 stream `.write()` 在 OS pipe buffer 内本就同步；boolean 返回值是『内核是否接受字节』的诚实信号"，避免后续 reviewer / 协作者误改成异步 (`Promise<boolean>`) 引发 race（timeout 与 commit 的竞态原子检查依赖该回调同步返回 boolean）。

### §6.2 清单覆盖说明

PRD §6.2 bridge 验收清单共 9 大类，分摊在任务 03 / 04 / 05：

| §6.2 大类 | 覆盖任务 | 说明 |
|-----------|---------|------|
| 配置加载（合法 / 缺 worker_url / 缺 work_dir / 缺 web_base_url / work_dir 三连校验 / token 缺省） | [[tasks/m3/03-bridge-config-file.md\|03]] | `config.test.ts` 17 条全清单 |
| CLI 移除回归（`--worker-url` / `REMOTEPI_WORKER_URL` 不再生效 / 未知 flag 静默） | [[tasks/m3/03-bridge-config-file.md\|03]] | `index.test.ts` 13 条（含 systemd `-D` / `--` 终止符等边界） |
| session 扫描（多文件按时间戳 / 同时间戳 mtime / 空目录 / 不可读） | [[tasks/m3/03-bridge-config-file.md\|03]] + [[tasks/m3/04-bridge-pi-process.md\|04]] | `pi-cwd-encoder.test.ts` 19 条（含 S7 garbage filename） |
| pi 子进程状态机（5 相位迁移 / 5min idle kill / 自主 kill 三路径 / 崩溃重启 / stdin EOF） | [[tasks/m3/04-bridge-pi-process.md\|04]] | `pi-process.test.ts` §1-§4（35 条）+ §10.3/10.4 |
| blocked_on 维护（4 类入列 / 5 fire-and-forget / timeout 镜像 / 提交竞态） | **05** | `extension-ui.test.ts` §1-§2（12 条） |
| bridge 重启 → 目录扫描找最新 | [[tasks/m3/04-bridge-pi-process.md\|04]] | `pi-process.test.ts` §7（2 条） |
| wire 翻译（cancelled / confirm value:true/false / select/input/editor value:string） | **05** | `extension-ui.test.ts` §3（9 条含 S2 invalid_response 兜底） |
| 广播原则（get_messages 不触发 / prompt/steer/follow_up/abort/extension_ui_response 各触发一次） | **05**（含 [[tasks/m3/04-bridge-pi-process.md\|04]] §11.1 部分铺垫） | `extension-ui.test.ts` §5（4 条 router 单元）+ `pi-process.test.ts` §11（8 条端到端） |
| exited 语义（get_messages spawn +1 / get_state 内存 / abort no-op） | [[tasks/m3/04-bridge-pi-process.md\|04]] + **05** | `pi-process.test.ts` §5（4 条 manager）+ §12（3 条端到端） |

05 新增 47 条集中在 **blocked_on 维护（§1-§2 = 12）** + **wire 翻译（§3 = 9）** + **多 web 先答者胜（§4 = 4）** + **广播原则（§5 + §11 = 12）** + **stdin 写失败 + clearAll + envelope round-trip（§6-§9 = 10）** 五大块，覆盖 §6.2 后半部（弹窗 wire 翻译 + 广播 + 多端并发 + 端到端 envelope 校验）。

### ExtensionUIRouter 独立类的结构裁定

任务 04 的桩 `extensionUIRouter!: ExtensionUIRouter`（未实例化，留 TODO）拆分为 `extension-ui.ts` 独立模块 + `ExtensionUIRouter` 类，**理由**：

1. **职责分离** — manager（`PiProcessManager`）只管相位状态机（spawn / kill / 启动握手 / exited 语义），router 只管 `pending` Map 维护 + timeout 镜像 + wire 翻译。manager 不直接接触 `BlockedOnEntryPayload` 内部结构，需要时只调 `router.getBlockedOn()` 读快照；router 不直接接触 `phase` / `child` / `idleTimer` 任何 manager 字段，需要副作用时通过 5 个回调（`broadcastSessionState` / `emitEventEnvelope` / `emitCommandResult` / `writeToPi` / `forceExited`）回写。两条边界互不泄漏内部状态。
2. **可独立单元测试** — `extension-ui.test.ts` 用 `makeRouter()` 工厂注入 5 个 mock 回调（vitest `vi.fn()`），不构造 `PiProcessManager`、不 mock `child_process.spawn`、不 fake `setTimeout`（除 §2.3/2.4 竞态测试），就能覆盖 4 类入列 / wire 翻译 / 多端并发 / 广播原则 / clearAll 全部核心路径。`pi-process.test.ts` §11/§12 端到端测试再补 manager + router 接线的集成验证——两层各管各的失败用例。
3. **便于 future 替换** — 若 M4 多 session 落地，router 可按 session key 分桶（`Map<sessionId, ExtensionUIRouter>`），manager 保持单例；或 router 可独立演进 wire 翻译规则而不动 manager。
4. **同步契约钉子** — `writeToPi` 同步返回 `boolean` 是与 `timeoutFired` 竞态原子检查的关键（同步 boolean 才能保证"write 与 clear"在同一 tick 决策）；JSDoc（S5）已钉死，未来重构者改异步会立刻被 §11.7 端到端测试捕获（mock 写 bytes + 断言广播时序）。

### 未在本任务收尾的项

- **`blocked_on` 字段缺省行为偏差**（已在 [[tasks/m3/02-shared-tests.md|tasks/02 完成情况]] 挂账 W-2）——任务 06 web 端消费 `session_state.payload.blocked_on` 时需注意：`EditorBlockedOnEntry` schema 无 `.strict()`，zod 默认剥离未知键；当前实现未发现 wire breaking 场景（编辑器场景不携带 timeout），留给未来 envelope 演进规则 (d) 配套修订时一并收紧。
- **bridge 端口反向链入 web 端**——web 端 4 类弹窗组件（ConfirmDialog value:false 提交）+ 倒计时 + 关闭规则 + 提交失败 UX 留给 [[tasks/m3/06-web-chat.md|tasks/06]] 落地。
