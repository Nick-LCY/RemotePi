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
- [ ] `packages/bridge/src/extension-ui.ts` 落地：`ExtensionUIRouter` 类 / 4 类入列 + 5 fire-and-forget 消化 / timeout 镜像 + 竞态原子检查 / wire 翻译三态（含 confirm value:false）/ 多 web 端先答者胜（广播驱动 + 后续答者收 `request_expired`）
- [ ] `packages/bridge/src/client.ts` 入站分流：pi 家族 6 命令转发 + control get_state 内存回答 + abort no-op（exited 时回 `command_result{success:true}`）
- [ ] `packages/bridge/src/__tests__/` 新增 / 拆分：`config.test.ts` / `pi-process.test.ts` / `extension-ui.test.ts` 覆盖 PRD §6.2 全部清单；总用例数 ≥ 30 条（既有 8 + 新增 ≥ 22）
- [ ] confirm value:false → `confirmed: false` 单测独立覆盖（R2 修正点）
- [ ] 自主 kill 三路径单测覆盖（标记在→不重启 / 标记不在+exit≠0→重启 / 标记不在+exit=0→不重启）
- [ ] wire 翻译一致性 6 种组合全覆盖（`cancelled:true`；confirm value:true/false；select/input/editor value:string）
- [ ] 广播原则单测：get_messages 不触发；prompt/steer/follow_up/abort/extension_ui_response 各触发一次
- [ ] §2.7 exited 语义单测：exited 时 get_messages 触发带 `--session` 的 spawn；get_state 不 spawn；abort no-op
- [ ] `pnpm --filter @remotepi/bridge test` 全绿（既有 8 + 新增 ≥ 22 = ≥ 30）；`pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿
- [ ] `grep -c "it(" packages/bridge/src/__tests__/*.test.ts` ≥ 30

## 依赖
- 依赖 [[tasks/m3/01-shared-protocol-v2.md|01-shared-protocol-v2]]（需要 BlockedOnEntry / ExtensionUIResponsePayload schema）
- 依赖 [[tasks/m3/03-bridge-config-file.md|03-bridge-config-file]]（config 加载是 pi 启动前置）
- 依赖 [[tasks/m3/04-bridge-pi-process.md|04-bridge-pi-process]]（ExtensionUIRouter 依赖 pi 子进程 stdin/stdout）
