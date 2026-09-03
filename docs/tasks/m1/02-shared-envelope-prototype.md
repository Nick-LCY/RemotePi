---
prd: prds/m1-infrastructure.md
status: done
---
# 任务：shared 隧道信封雏形

## 目标
按 PRD §2 在 `packages/shared` 实现 envelope 的 Zod schema + 类型，落地 hello/ping/echo 三种最小消息；写 `envelope.test.ts` 三个用例（合法解析、版本不匹配拒绝、未知 kind 拒绝）。

## 完成标准
- [ ] `packages/shared/src/index.ts` 重导出 `./protocol/*`
- [ ] `packages/shared/src/protocol/envelope.ts` 定义：`PROTOCOL_VERSION = 1 as const` 与 `ProtocolVersion` 类型；`Envelope = z.discriminatedUnion('kind', [Hello, Ping, Echo])`；顶层字段 `v` / `kind` / `id` / `payload`
- [ ] `packages/shared/src/protocol/messages.ts` 定义 `Hello`、`Ping`、`Echo` 三种 payload 的 Zod schema
- [ ] `Hello` payload 含 `{ role: 'web' | 'bridge', token?: string }`（token 可选，M2 必填）
- [ ] `Ping` payload 为空对象或 `{ nonce?: string }`；`Echo` payload `{ nonce: string }`
- [ ] 三个消费方（bridge / web / worker）能 `import { Envelope, PROTOCOL_VERSION, Hello, Ping, Echo } from '@remotepi/shared'`
- [ ] `packages/shared/src/protocol/__tests__/envelope.test.ts` 三个用例全绿：合法 hello 解析成功；`v: 2` 抛 ZodError；`kind: 'unknown'` 抛 ZodError
- [ ] `pnpm --filter @remotepi/shared test` 全绿；`pnpm -r build` 全绿（shared 自身只 typecheck）

## 依赖
- 依赖 `01-monorepo-scaffold`（需要 workspace 配置与 tsconfig base）
