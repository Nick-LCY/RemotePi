---
prd: prds/m2-tunnel.md
status: todo
---
# 任务：shared 协议 v1 重写

## 目标
按 [[prds/m2-tunnel.md|M2 PRD §1 shared]] 整文件重写 `packages/shared/src/protocol/envelope.ts`，落地 v1 信封（kind 二分 + control 5 type）。删除 M1 的 hello/echo 雏形与遗留 schema，不留兼容 stub。

关键要点：

- `PROTOCOL_VERSION = 1 as const`；`ProtocolVersion = typeof PROTOCOL_VERSION`
- 顶层 `Envelope = z.discriminatedUnion('kind', [ControlBranch, PiBranch])`
- `ControlBranch = z.discriminatedUnion('type', [HandshakeEnvelope, PingEnvelope, PongEnvelope, BridgeStatusEnvelope, ErrorEnvelope])`
- `PiBranch = z.never()`（占位；Zod 空 discriminatedUnion 会抛错，必须有至少一个分支——M3 替换为真 union 直接 append 9 个 type）
- 信封字段：`v: ProtocolVersion` / `kind: 'control'|'pi'` / `type: string` / `id: z.string().min(1)` / `session: optional` / `reply_to: optional` / `payload`——`session` 与 `reply_to` M2 不填值但 schema 留位（envelope.md 锁版承诺）
- 5 个 payload schema：
  - `HandshakePayloadSchema`：`{ role: z.enum(['web', 'bridge']), token: z.string().min(1) }`
  - `PingPayloadSchema`：`{ nonce: z.string().optional() }`
  - `PongPayloadSchema`：`{ nonce: z.string() }`（必填）
  - `BridgeStatusPayloadSchema`：`{ online: z.boolean(), changed_at: z.string().datetime(), reason: z.enum(['connected', 'closed', 'stale']) }`
  - `ErrorPayloadSchema`：`{ code: z.enum(['auth_failed','duplicate_bridge','invalid_envelope','unsupported_version','unsupported_type','internal']), message: z.string(), terminal: z.boolean().optional() }`
- 命名契约沿用 M1 裁定：envelope schema+type 同名（`HandshakeEnvelope` / `PingEnvelope` / ...）；payload schema 带 `Schema` 后缀（`HandshakePayloadSchema`），推导类型不带后缀（`HandshakePayload`）。envelope 字段 `v` / `kind` / `type` 也以协议字面量暴露供消费者使用
- M1 的 `HelloEnvelope` / `PingEnvelope`（旧版）/ `EchoEnvelope` 与对应 payload schema + 相关导出**彻底删除**，不留兼容 stub；`@remotepi/shared` 的 `index.ts` barrel 与 `messages.ts`（若存在）同步清理
- `packages/shared` 导出格式沿用 M1（`exports: { ".": "./src/index.ts" }`，三个消费方各自编译）
- 枚举字面量集合（kind / type / role / reason / error code）须在 `envelope.ts` 内集中导出（供消费方做 switch 时类型收窄、供测试断言用）

## 完成标准
- [ ] `packages/shared/src/protocol/envelope.ts` 完整覆盖 M2 PRD §1 列出的 5 个 payload schema + 顶层 discriminatedUnion + `z.never()` pi 占位
- [ ] `PROTOCOL_VERSION = 1 as const` 与 `ProtocolVersion` 类型导出；信封 `id` 字段 `z.string().min(1)`；`session` / `reply_to` 字段以 optional 形式存在
- [ ] M1 的 hello / echo 相关 schema（`HelloPayload` / `PingPayload`（旧版）/ `EchoPayload` 等）与导出**彻底删除**——`grep -r "Hello\|Echo" packages/shared/src` 在 envelope schema 命名契约范围内不出现 M1 残留
- [ ] `packages/shared/src/index.ts` barrel 重导出 `./protocol/envelope.js`（不再有 `./protocol/messages`）；bridge / worker / web 三方能 `import { Envelope, PROTOCOL_VERSION, HandshakeEnvelope, HandshakePayloadSchema, ... } from '@remotepi/shared'`
- [ ] 命名契约落地：envelope 同名（`HandshakeEnvelope` ...）、payload schema 带 `Schema` 后缀、payload 类型不带后缀；通过 grep 校验
- [ ] pi 分支用 `z.never()` 占位，vitest 跑通（`EnvelopSchema.safeParse({ kind: 'pi', type: 'x', ... })` 应拒；但 `EnvelopeSchema.safeParse(...)` 顶层合法 control envelope 必须通过）
- [ ] `pnpm --filter @remotepi/shared test` 全绿（包含任务 02 的 17 条）；`pnpm -r build` 全绿；`pnpm run lint` / `pnpm run typecheck` 全绿

## 依赖
- 无（M2 根任务）