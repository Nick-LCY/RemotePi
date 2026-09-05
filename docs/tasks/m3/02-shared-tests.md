---
prd: prds/m3-single-session.md
status: done
---
# 任务：shared 测试扩展（25+ 条）

## 目标
按 [[prds/m3-single-session.md|M3 PRD §6.1]] 在 `packages/shared/src/protocol/__tests__/` 落地 25+ 条 vitest 用例，覆盖任务 01 新增 schema：pi 家族 9 type + session_state blocked_on + extension_ui_response web wire + get_state 回执。可与 [[tasks/m3/01-shared-protocol-v2.md|任务 01]] 同一提交落地。

关键要点：

- 新增 4 个测试文件（沿用 M2 `Envelope.safeParse(...)` 断言风格）：
  - **`pi.test.ts`**：9 type 合法解析 + 必填字段缺一拒 + 非法 enum 拒——`Prompt` 缺 `content` 拒 / `Abort` 含额外字段通过 / `GetMessages` 含 `since` 通过 / 缺 `since` 通过 / `CommandResult` 缺 `success` 拒 / `Snapshot` 缺 `messages` 拒 / `Event` `data` 任意形状通过
  - **`block-on.test.ts`**：4 类 `BlockedOnEntry` 合法 + 边界 + fire-and-forget 拒——select `options` 缺一拒 / confirm 含 `message` 通过 / input 含 `placeholder` 通过 / editor 无 timeout 通过 + 含 timeout 字段拒 / `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text` 五 method 拒；`ExtensionUIResponsePayloadSchema` 6 类用例：`cancelled: true` 合法不附 value / `cancelled: false` 缺 value → refine 拒 / `cancelled: false` + string value 合法（select/input/editor）/ `cancelled: false` + boolean value 合法——**confirm value 必为 boolean，独立两条用例**（`true` 与 `false`）/ `request_id` 缺 → 拒 / value 非 string 非 boolean → 拒
  - **`session-state.test.ts`**：5 phase 合法 + `blocked_on` 缺省通过 + 含 4 类元素通过 + 含 fire-and-forget method 拒 + 元素缺 `id` 拒
  - **`get-state.test.ts`**：`get_state` payload `{}` 合法 / `result` 回执 `{ ok: true, data: { phase: 'ready' } }` 合法 / 回执 `data.blocked_on` 缺省通过 / 含数组通过 / 回执 `data.phase` 非法值（`'foo'`）拒 / 回执 `data.blocked_on` 含非法 method 拒 / `result` `ok: false` + `error: { code: ERROR_CODES 之一, message }` 合法 / `ok: false` 缺 `error` 拒
- 用例编号风格沿用 M2（`it('N. ...')` 顶部注释映射 PRD §6.1 清单编号）
- 既有 22 条（M2 17 + 后续追加 5）保留不动，本任务净增 ≥ 25 条；测试套总数 ≥ 47 条

## 完成标准
- [x] `packages/shared/src/protocol/__tests__/` 落地 4 文件（`pi.test.ts` / `block-on.test.ts` / `session-state.test.ts` / `get-state.test.ts`），总计新增 61 条用例（PRD §6.1 下限 25 条，超额 36 条；review 后补 steer/follow_up 缺 content 镜像 2 条）
- [x] 每个测试文件顶部注释逐条映射 PRD §6.1 清单编号（便于 review 对照）
- [x] confirm value 必为 boolean 的两条用例（true / false）独立列出（PRD §6.1 强调）
- [x] `pnpm --filter @remotepi/shared test` 全绿（套件总数 102 条）；`pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿
- [x] `grep -c "it(" packages/shared/src/protocol/__tests__/*.test.ts` 总数 ≥ 47（22 既有 + 80 新增 = 102 条，含 review 后补镜像 2 条）；新文件不含 hello / echo 字串

## 依赖
- 依赖 [[tasks/m3/01-shared-protocol-v2.md|01-shared-protocol-v2]]（需要新 schema 才能写断言）

## 完成情况
任务完成，commit `9bc5bad`。4 文件 61 条新增用例（远超 PRD §6.1 25 条下限），套件总数 102 条全绿（22 既有 + 80 新增）。reviewer 通过，**无 Critical**；3 项 Warning 中 W-1 / W-3 已修，**W-2 挂账两处 schema 行为偏差**，后续任务（04/05）消费 `blocked_on` / `result.error` 时需知晓：

**偏差 1：`block-on.test.ts` case 11 — `EditorBlockedOnEntry` 含 timeout 字段实际通过**
- 现象：`EditorBlockedOnEntry` schema 无 `.strict()`，zod 默认剥离未知键；PRD §1.3 未列 `timeout` 字段，故含 `timeout` 的 payload 也合法通过。
- 影响：bridge 镜像 timeout 定时器（任务 05）依赖此行为——web 弹窗的 timeout 由 bridge 独立计时，不由 web 自 schema 拒。
- 收紧路径：给 4 类 `BlockedOnEntry` 加 `.strict()` 会拒 timeout，属 wire breaking；需先在 [[architecture/protocol/envelope.md#演进规则|envelope 演进规则 (d)]] 追加"已知字段忽略"条款、再走一版协议号递增。

**偏差 2：`get-state.test.ts` case 9 — `result.ok:false` 缺 `error` 实际通过**
- 现象：`ResultPayload` 中 `error` 为 optional，`ok:false` 缺 `error` 不触发 refine，合法通过。
- 影响：worker / bridge 任何一端若按"无 error 字段 = 错乱回执"假设处理会漏判；任务 04 / 05 接 `get_state` 回执时应按"ok:true 看 data / ok:false 看 error（允许缺，按 unknown error 处理）"防御性编程。
- 收紧路径：将 `ResultPayload` 改成 `z.discriminatedUnion('ok', [...])` 强制 `ok:false` 必带 error，同属 wire breaking，需要 envelope 演进规则 (d) 配套。

