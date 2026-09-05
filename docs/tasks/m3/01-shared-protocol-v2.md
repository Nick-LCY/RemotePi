---
prd: prds/m3-single-session.md
status: done
---
# 任务：shared 协议 v2（pi 家族 9 schema + control get_state + session_state blocked_on + extension_ui_response web wire）+ 文档同步 + ADR-0006 补全

## 目标
按 [[prds/m3-single-session.md|M3 PRD §1 / §5]] 落地协议 v2 扩展：`PiBranch = z.never()` 占位替换为真 discriminatedUnion（9 个 pi type）；control `get_state` 破锁（8 → 9 type，回执走 `result`）；`session_state.payload.blocked_on` 升级为可选数组；`extension_ui_response` web wire 形状定稿（`value: string | boolean`，confirm 走 boolean 表达"否"）。同步 envelope.md / control.md / pi.md 锁版承诺与字段表，补全 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] 双向引用段。

关键要点：

- **拆分 `envelope.ts` → `envelope.ts` + `control.ts`**：现有 5 个 control payload schema + 对应 envelope 从 `envelope.ts` 迁至新建 `packages/shared/src/protocol/control.ts`；`envelope.ts` 仅保留顶层结构（`PROTOCOL_VERSION` / `KINDS` / `CONTROL_TYPES`（9 项追加 `get_state`）/ `ROLES` / `BRIDGE_STATUS_REASONS` / `ERROR_CODES` / 新增 `SESSION_PHASES` 字面量 / `EnvelopeBase` / `ControlBranch` 引用 / `PiBranch` 真化 / `Envelope` 顶层 `z.union`）
- **`control.ts` 新建**：迁入 `HandshakePayloadSchema` / `PingPayloadSchema` / `PongPayloadSchema` / `BridgeStatusPayloadSchema` / `ErrorPayloadSchema`；新增 `GetStatePayloadSchema = z.object({})` / `SessionStatePayloadSchema = z.object({ phase: z.enum(SESSION_PHASES), blocked_on: z.array(BlockedOnEntryPayloadSchema).optional() })`（`blocked_on` 元素从 `block-on.ts` 复用）/ `ResultPayloadSchema = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }).optional() })`（`code` 复用 `ERROR_CODES`，失败时 `ok: false` + `error` 必填）；7 个 envelope schema 同名导出
- **`pi.ts` 新建**：9 个 pi envelope + payload schema：
  - 命令 6：`Prompt` / `Steer` / `FollowUp`（payload `{ content: z.string() }`）/ `Abort`（payload `{}`）/ `GetMessages`（payload `{ since?: z.string() }`）/ `ExtensionUIResponse`（从 block-on.ts 复用）
  - 回执 / 事件 3：`CommandResult`（`{ command, success, data?, error?: { code, message } }`）/ `Snapshot`（`{ messages: z.array(z.unknown()) }`，不锁元素 shape）/ `Event`（`{ event: z.string(), data: z.unknown() }`，`data` 开放集合）
  - 命名契约沿用 M1（envelope 同名 / payload schema 带 `Schema` 后缀）
- **`block-on.ts` 新建**：
  - `BLOCK_ON_METHODS = ['select', 'confirm', 'input', 'editor'] as const`（fire-and-forget 5 类不入列）
  - `BlockedOnEntryPayloadSchema = z.discriminatedUnion('method', [...])`：select `{ method, id, title, options: z.array(z.string()), timeout? }` / confirm `{ method, id, title, message, timeout? }` / input `{ method, id, title, placeholder?, timeout? }` / editor `{ method, id, title, prefill? }`（无 timeout）
  - `ExtensionUIResponsePayloadSchema = z.object({ request_id: z.string().min(1), cancelled: z.boolean(), value: z.union([z.string(), z.boolean()]).optional() }).refine(v => v.cancelled === true || v.value !== undefined, { message: 'value is required when cancelled=false (string 或 boolean)', path: ['value'] })`
- **`PiBranch` 真化**：`z.discriminatedUnion('type', [9 个 pi envelope])`；顶层 `Envelope = z.union([ControlBranch, PiBranch])` 沿用 M2 形态
- **`index.ts` barrel**：`export * from './protocol/envelope.js'; export * from './protocol/control.js'; export * from './protocol/pi.js'; export * from './protocol/block-on.js';`（沿用 M1 barrel 风格）
- **文档同步**：
  - `docs/architecture/protocol/envelope.md`：锁版承诺"control 8 个 type" → "control 9 个 type（含本破锁新增的 `get_state`）"；演进规则 (a) 注释追加 `session_state.payload.blocked_on`（数组，可选）+ `result.data.phase` / `result.data.blocked_on`（get_state 回执）均为新增可选字段；演进规则 (b) "control 家族 v1 内不再新增 type" → "除 `get_state` 外不再新增"；末尾追加指向 ADR-0006 的双向引用句
  - `docs/architecture/protocol/control.md`：§5 session_state payload 增 `blocked_on` 字段说明（数组 / 元素为 4 类 extension_ui_request）；新增 `§6.5 get_state` 小节（payload `{}` + 回执走 result + `data = { phase, blocked_on? }`）；type 列表 8 → 9；"中间层处理规则"末加一句"get_state 原样转发"
  - `docs/architecture/protocol/pi.md`：9 type 列表按 §1.5 落地；删除 `extension_ui_request` "实现时核实是否带稳定 id" 注记；`extension_ui_response` payload 改 web wire 形状描述 + bridge 翻译注释（value: string | boolean，confirm 走 boolean）；常见事件名表加 `agent_settled` / `message_update` / `queue_update` / `ui_prompt_start` / `ui_prompt_end`
- **ADR-0006 完整化**：`docs/architecture/decisions/0006-protocol-v1-get-state-unlock.md` 现有 背景/决策/影响 三段已铺——核对无误后删除末尾"本文件由 M3 PRD 落盘时同步创建（占位）"提示行；补"双向引用"句（指向 envelope.md 锁版承诺清单 + ADR-0003 / ADR-0004 末尾）

## 完成标准
- [x] `packages/shared/src/protocol/envelope.ts`：顶层 `Envelope = z.union([ControlBranch, PiBranch])`；`ControlBranch` 从 control.ts 引用；`PiBranch = z.discriminatedUnion('type', [...9 pi envelopes])`；`CONTROL_TYPES` 9 项（含 `get_state`）；`SESSION_PHASES` 字面量导出
- [x] `packages/shared/src/protocol/control.ts` 新建：5 迁入 + `GetStatePayloadSchema`（`{}`）+ `SessionStatePayloadSchema`（含 `blocked_on?`）+ `ResultPayloadSchema`（`{ ok, data?, error? }`）；7 envelope 同名
- [x] `packages/shared/src/protocol/pi.ts` 新建：9 pi envelope + payload schema 完整覆盖
- [x] `packages/shared/src/protocol/block-on.ts` 新建：`BLOCK_ON_METHODS` + `BlockedOnEntryPayloadSchema`（4 类，editor 无 timeout）+ `ExtensionUIResponsePayloadSchema`（含 cancelled/value refine）
- [x] `packages/shared/src/index.ts` barrel re-export 上列四文件；`@remotepi/shared` 公共 API 含 `Envelope` / `CONTROL_TYPES` / `SESSION_PHASES` / `BlockedOnEntryPayloadSchema` / `ExtensionUIResponsePayloadSchema` / `PromptEnvelope` 等
- [x] 命名契约：grep `packages/shared/src/protocol/` 验证 envelope 同名（`HandshakeEnvelope` / `PromptEnvelope` ...）+ payload schema 带 `Schema` 后缀 + payload 类型不带后缀
- [x] 文档：envelope.md 锁版 control 8 → 9 type / 演进规则 (b) 修订 / 与 ADR-0006 双向引用；control.md §5 blocked_on 增补 + 新增 §6.5 get_state + type 列表 9 + 中间层加 get_state 转发；pi.md 9 type + extension_ui_request id 稳定注记删除 + extension_ui_response web wire 形状 + 5 个常见事件名
- [x] ADR-0006 末尾追加双向引用段（指向 envelope.md 锁版承诺清单 + ADR-0003 / ADR-0004 末尾），删除占位提示行
- [x] `pnpm --filter @remotepi/shared build` / `pnpm --filter @remotepi/shared typecheck` 全绿；`pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿
- [x] `grep -R "PiBranch = z.never()" packages/shared/src` 零结果（占位已替换）；`grep -R "HelloEnvelope\|EchoEnvelope" packages/shared/src` 零结果；`grep "get_state" packages/shared/src/protocol/envelope.ts` 命中 `CONTROL_TYPES`（`CONTROL_TYPES` 实际在 `literals.ts`，由 `envelope.ts` 模块头注释指向并 re-export，语义等同 CONTROL_TYPES 定义）+ `GetStatePayloadSchema` 定义

## 依赖
- 无（M3 根任务）

## 完成情况

**完成一句话**：协议 v2 落地（pi 家族 9 schema 真化 + control `get_state` 8→9 type 破锁 + `session_state.payload.blocked_on` + `extension_ui_response` web wire refine） + envelope/control/pi/ADR-0006 四文档同步 + 公共 API 完整导出。**关键偏差**：(1) 实际拆分出 `literals.ts`（`PROTOCOL_VERSION` / `KINDS` / `CONTROL_TYPES` / `ROLES` / `BRIDGE_STATUS_REASONS` / `ERROR_CODES` / `SESSION_PHASES` 字面量 + 对应 type 推导） + `envelope-base.ts`（`VersionLiteral` / `EnvelopeBaseControl` / `EnvelopeBasePi`）两文件，原因是 M3 拆分后 `envelope.ts ↔ control.ts` / `envelope.ts ↔ pi.ts` 形成循环导入，叶子模块抽取以打破循环；(2) `packages/shared/package.json` 补 `typecheck` 脚本（与 `build` 等价的 `tsc --noEmit`，便于 CI 按用途分阶段验证）。**Commit**：`6568b4b`。**Review 结论**：无 Critical；1 项 JSDoc Warning 已修。
