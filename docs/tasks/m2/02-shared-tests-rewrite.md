---
prd: prds/m2-tunnel.md
status: done
---
# 任务：shared 测试重写（17 条）

## 目标
按 [[prds/m2-tunnel.md|M2 PRD §6 shared 17 条]] 重写 `packages/shared/src/protocol/__tests__/envelope.test.ts`，覆盖 v1 信封与 5 个 payload schema 的合法/非法路径。删除 M1 的 3 条 hello/echo 测试（任务 02 净增 14 条 + 旧 3 条 → 17 条）。可与 [[tasks/m2/01-shared-envelope-v1.md|任务 01]] 同一提交落地。

关键要点：

- 用 vitest；断言用 `safeParse(...).success === true/false` 或 `.parse(...) throws ZodError`，统一断言风格
- 17 条用例清单（与 PRD §6 完全一致，下文为复述）：
  1. handshake 合法 envelope 解析成功且类型窄化为 `HandshakeEnvelope`
  2. handshake payload 缺 `role` → 拒
  3. handshake payload `role` 非 'web'|'bridge' → 拒
  4. handshake payload 缺 `token` → 拒
  5. ping payload 含 `nonce` → 通过；缺 `nonce`（optional）→ 通过
  6. pong payload 缺 `nonce`（必填）→ 拒
  7. bridge_status 三 reason（'connected'|'closed'|'stale'）合法解析
  8. bridge_status `reason` 非法值（如 'foo'）→ 拒
  9. error 六个 6 个 code（auth_failed/duplicate_bridge/invalid_envelope/unsupported_version/unsupported_type/internal）合法解析
  10. error payload 缺 `terminal`（optional）→ 通过；`terminal: true` / `false` 均解析
  11. envelope `v: 2` → 拒（unsupported_version 触发场景）
  12. envelope `kind: 'control'` 下未知 `type` → 拒
  13. envelope `kind: 'pi'` 当前任何 `type` → 拒（pi 分支 z.never() 占位语义验证）
  14. envelope `kind` 非 'control'|'pi' → 拒
  15. envelope 缺 `id`（min1）→ 拒
  16. envelope 缺 `session`（optional）→ 合法解析
  17. envelope 缺 `reply_to`（optional）→ 合法解析
- M1 `envelope.test.ts` 中 hello/echo 相关 3 条用例（合法 hello 解析、`v: 2` 拒、未知 kind 拒）需重写为 v1 语义（第 11 / 14 条）；M1 的 5 条测试中的另外 2 条（未知 role、缺 id）合并入第 3 / 15 条——总条数从 M1 的 5 条调整为 17 条
- 用例编排顺序与 PRD §6 一致（便于 review 对照）；非法用例的 `expect(...).toThrow(ZodError)` 或 `expect(success).toBe(false)` 风格自定，保持一致即可

## 完成标准
- [ ] `packages/shared/src/protocol/__tests__/envelope.test.ts` 落地 17 条用例（与上方清单逐条对应，编号 1–17）
- [ ] M1 hello / echo 测试用例全部删除；`packages/shared/src/protocol/__tests__/` 目录不再含 hello/echo 字符串（grep 验证）
- [ ] 17 条用例全部 `pnpm --filter @remotepi/shared test` 通过
- [ ] `pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿；测试文件无类型错误
- [ ] 测试文件顶部注释说明 17 条用例与 PRD §6 的对应关系，便于 review

## 依赖
- 依赖 [[tasks/m2/01-shared-envelope-v1.md|01-shared-envelope-v1]]（需要 v1 envelope + 5 payload schema 才能写断言）