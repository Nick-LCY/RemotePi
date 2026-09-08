---
prd: prds/m4-multi-session.md
status: done
---
# 任务：shared 测试扩展（4 新 payload schema + envelope (a) 增字段 + session_list.status + CONTROL_TYPES 13 项 + pi/prompt.work_dir 携带语义）

## 目标
按 [[prds/m4-multi-session.md|PRD §5 末节测试清单 + §9.1（30+ 条）]] 扩展 shared 测试覆盖协议 v3 新增 schema：4 个新 payload schema 合法 / 缺字段拒 / 非法类型拒；`session_list` / `session_state` 的 `work_dir` 可选字段双向（缺省 / 提供）；**`pi/prompt.work_dir` 可选字段合法 / 缺字段 / 提供**（注释说明仅 `session:'new'` 携带，schema 不强制）；`session_list.result.data.sessions[]` 形状（含 5 枚举 status 合法 + 非法 status 拒）；`work_dir_list.result.data.work_dirs[]` 形状；`list_directories.result.data.entries[]` 形状；`CONTROL_TYPES` 字面量长度 13 + 新 type 名称对齐；envelope `session` 字段仍 optional（验证未误改 lock-version）。

关键要点：

- **新增 schema 测试**：
  - `ListDirectoriesPayloadSchema` 合法（带 path / 缺省 path）/ 缺字段拒 / 非法类型拒
  - `WorkDirListPayloadSchema` 合法 / 非法字段拒
  - `WorkDirAddPayloadSchema` 合法 / 缺 path 拒
  - `WorkDirRemovePayloadSchema` 合法 / 缺 path 拒
  - `ListDirectoriesResultSchema` 合法（entries 数组）/ 缺 entries 拒
  - `WorkDirListResultSchema` 合法（work_dirs 数组）/ 缺 work_dirs 拒
  - `PiPromptPayloadWorkDirSchema` 合法（带 work_dir / 缺省）/ 非法类型拒（注释说明 schema 不强制 session 关联）
- **`session_list` payload `work_dir?`**：合法双向（缺省 / 提供）/ 类型错拒
- **`session_state` payload `work_dir?`**：合法双向 / 类型错拒
- **`pi/prompt.payload.work_dir?`**：合法双向 / 注释测试覆盖（注释说明仅 `session:'new'` 携带，schema 不强制）
- **`session_list.result.data.sessions[]`** 形状：含 status 字段（5 枚举合法：`exited` / `idle` / `running` / `spawning` / `unknown`）+ 非法 status 拒 + 既有 M3 字段集（`id` / `name` / `cwd` / `created` / `modified` / `message_count` / `first_message` / `running`）完整覆盖
- **`work_dir_list.result.data.work_dirs`** 形状
- **`list_directories.result.data.entries`** 形状（含 `name` / `path` 字段）
- **`CONTROL_TYPES` 字面量**：长度 13 验证 + 4 新 type 名称对齐（`list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`）
- **envelope `session` 字段**：仍 optional（验证未误改 lock-version；多会话下操作惯例必填是语义层，schema 锁版承诺 wire 兼容）
- **回归**：M3 既有 102 条测试零变化（不得破锁 envelope / control 9 type / pi 9 type）

## 完成标准
- [ ] `packages/shared/src/protocol/work-dirs.test.ts` 新建：覆盖 4 新 payload schema + 2 新 result schema + `PiPromptPayloadWorkDirSchema` 合法 / 缺字段拒 / 非法类型拒（≥ 10 条）
- [ ] `packages/shared/src/protocol/control.test.ts`（或扩 `control-extension.test.ts` 新建）：`session_list.payload.work_dir?` 合法双向 + `session_state.payload.work_dir?` 合法双向 + `session_list.result.data.sessions[]` 形状含 5 枚举 status（≥ 8 条）
- [ ] `packages/shared/src/protocol/pi.test.ts`：`pi/prompt.payload.work_dir?` 合法双向 + 注释覆盖（≥ 3 条）
- [ ] `packages/shared/src/protocol/literals.test.ts`：`CONTROL_TYPES` 长度 13 + 4 新 type 名称对齐（≥ 3 条）
- [ ] `packages/shared/src/protocol/envelope.test.ts`：envelope `session` 字段仍 optional 验证（lock-version 未误改，≥ 2 条）
- [ ] **总计新增 ≥ 30 条**（PRD §9.1 下限），全部覆盖 PRD §5 末节测试清单 + §9.1 各项
- [ ] 既有 102 条 M3 测试零回归（破锁不得影响）
- [ ] `pnpm --filter @remotepi/shared test` 全绿
- [ ] `pnpm run lint` / `pnpm run typecheck` 全绿

## 依赖
- 依赖 [[tasks/m4/02-shared-protocol-v3.md|02-shared-protocol-v3]]（协议根任务）

## 参考
- [[prds/m4-multi-session.md|PRD §5 shared 测试追加]]
- [[prds/m4-multi-session.md|PRD §9.1 shared 测试 30+ 条]]
- [[tasks/m4/02-shared-protocol-v3.md|02-shared-protocol-v3]] schema 落地
- [[tasks/m3/02-shared-tests.md|tasks/m3/02]] 测试扩展基线（4 文件 61 条 + 102 全绿）

## 完成情况

任务完成，2 笔本地 commit：**`e20f760`**（测试实施 +53 条 308→361 全绿）+ **`95ac98d`**（review 修复轮：W1 envelope.ts 头注虚假 `PiPromptPayloadWorkDirSchema` 引用清理 / W2 测试注释收拢 / S3 strip 契约钉桩 / S5 nullable 契约钉桩；总数不变）。reviewer 结论 **0 Critical / 2 Warning / 5 Suggestion**；**PRD §9.1 9 项清单全部覆盖**——4 新 payload schema / `session_list.payload.work_dir?` 双向 / `session_state.payload.work_dir?` 双向 / `pi/prompt.payload.work_dir?` 携带语义 / `session_list.result.data.sessions[]` 形状（含 5 枚举 status）/ `work_dir_list.result.data.work_dirs` 形状 / `list_directories.result.data.entries[]` 形状 / `CONTROL_TYPES` 13 + 4 新 type 名称对齐 / envelope `session` 仍 optional 锁版守护。

### `e20f760` 实施（+53 条按文件分布）

- **`work-dirs.test.ts` 新建 19 条**——4 新 payload schema 合法 / 缺字段拒 / 非法类型拒（cases 1-11：`list_directories` path 缺省 + 提供 + 非字符串拒 / `work_dir_list` 空对象合法 + 根非对象拒 / `work_dir_add` path 必填 + 非字符串拒 / `work_dir_remove` path 必填 + 非字符串拒）+ 2 新 result schema 合法 / 缺字段拒 / 元素形态拒（cases 12-17：`list_directories` 合法 + 空 entries + 缺 entries 拒 + 元素缺 `name`/`path` 拒 / `work_dir_list` 合法 + 缺 work_dirs 拒）+ `pi/prompt.payload.work_dir` 合法提供 + 非字符串拒（cases 18-19，走 `PromptPayloadSchema` 直接测，schema 不强制 `session:'new'` 关联以保留简洁）。
- **`session-list.test.ts` 新建 17 条**——`SessionListEntrySchema` 5 枚举 status 合法（exited / idle / running / spawning / unknown，"no manager in map" 哨兵）+ 非法 status 拒 + 既有 M3 字段集完整覆盖（cases 1-9，含 `running: false` AND `status: 'exited'` M3 布尔与 M4 枚举共存 + result envelope `data.sessions[]` 二次校验 cases 10-11）+ `SessionListResultSchema` 空 sessions 合法 + 缺 sessions 拒 + 5 枚举 sanity sweep + `session_list.payload.work_dir?` 缺省（M3 兼容）/ 提供（M4 操作惯例必带）/ 非字符串拒（cases A/B/C）。
- **`literals.test.ts` 新建 5 条**——`CONTROL_TYPES` 长度 13（M2 8 + M3 1 + M4 4 演进，case 1）+ M3 9 项基线保留（case 2，additive-only 守护）+ 4 新 M4 type 名称对齐（case 3，list_directories / work_dir_list / work_dir_add / work_dir_remove）+ 无重复（case 4）+ 全非空小写 sanity sweep（snake_case 命名契约）。
- **`envelope.test.ts` +6 条**——M3 `session_list` + M4 `list_directories` envelope `session` optional 锁版守护双向（cases 20-21：M3 兼容缺省 + M4 多会话提供，验证 envelope 演进规则 (b) 未误改 wire 兼容）+ 4 新 control type envelope 全栈 round-trip（cases 22-25：`Envelope.safeParse` 走 `ControlBranch` discriminated union 路径，discriminator + payload shape + id 全保留）。
- **`pi.test.ts` +3 条**——`pi/prompt.payload.work_dir?` 缺省 / 提供双向 + `steer` / `follow_up` payload `work_dir` 静默 strip 对照（cases 20-22；`work_dir` 仅 `prompt` 携带 + `session:'new'` 关联是 schema 行为非缺陷）。
- **`session-state.test.ts` +3 条**——`session_state.payload.work_dir?` 缺省（M3 兼容）/ 提供（M4 多会话模式）/ 非字符串拒（cases 12-14）。

### `95ac98d` review 修复轮（W1-W2 + S3/S5 落地；3 项合理跳过）

- **W1** `packages/shared/src/protocol/envelope.ts` 头注虚假 `PiPromptPayloadWorkDirSchema` 引用清理——任务 [[tasks/m4/02-shared-protocol-v3.md|02]] 遗留 drift，envelope 头注仍按"独立 schema 模块"路径写，实际实施决定 `work_dir?` 字段直接落 `PromptPayloadSchema`（`pi.ts`）沿用 envelope 演进规则 (a) "field-on-existing-payload"；头注改"The `pi/prompt.payload.work_dir?` field lives directly on `PromptPayloadSchema` in `./pi.ts`"对齐真实代码。**任务 02 遗留 drift 就地清账，不占任务 [[tasks/m4/09-docs-sync.md|09 docs-sync]]**——免得拖成跨任务文档漂移挂账。
- **W2** `work-dirs.test.ts` 测试注释收拢——`## pi/prompt.payload.work_dir test location` 段补"通过 `PromptPayloadSchema` 直接测，与 envelope-level `pi.test.ts` cases 20-22 分工"（消除两文件跨引歧义）。
- **S3** `pi.test.ts` case 22 `steer` / `follow_up` payload `work_dir` strip 行为钉桩——断言 `result.data` 不含 `work_dir` 键（zod 默认剥离未知键，schema 设计行为；与既有 case 16 `pi/abort` "extra payload fields (zod strips unknowns)" 风格一致）。**"steer/follow_up 的 work_dir 被 strip"确认为 schema 设计行为而非缺陷**——协议层裁定 A：`pi/prompt.payload.work_dir` 是新会话唯一入口，`steer` / `follow_up` 不携带（mid-flight 调整无 work_dir 概念）。
- **S5** `work-dirs.test.ts` case 19 + `pi.test.ts` case 21 `pi/prompt.payload.work_dir` nullable 契约钉桩——断言 `work_dir` 接受 `undefined`（缺省）与 `string`（提供）双向 type guard。
- **合理跳过（3 项 Suggestion）**——**S1**（`z.infer` cast alias，类型系统合理逃逸已注释，code review 风格分歧）/ **S2**（`envelope.test.ts` case 16 拆分为"session omitted" + "session provided"两条 it 块，纯粒度风格——当前单 it 多 case 风格与既有 case 5 ping with/without nonce、case 7 bridge_status every legal reason 一致）/ **S4**（test helper 签名宽窄，纯风格）。

### 断言质量与覆盖说明

- **PRD §9.1 9 项清单逐条对照**：
  1. **4 新 payload schema 合法 / 缺字段拒 / 非法类型拒** → `work-dirs.test.ts` cases 1-11（work-dirs.test.ts 段首注释逐条映射清单编号，便于 review 对照）。
  2. **`session_list.payload.work_dir?` 缺省 / 提供双向** → `session-list.test.ts` cases A / B / C。
  3. **`session_state.payload.work_dir?` 缺省 / 提供双向** → `session-state.test.ts` cases 12 / 13 / 14。
  4. **`pi/prompt.payload.work_dir?` 携带语义**（注释说明仅 `session:'new'` 携带，schema 不强制）→ `work-dirs.test.ts` cases 18-19（payload 级）+ `pi.test.ts` cases 20-22（envelope 级 + steer/follow_up strip 对照）。
  5. **`session_list.result.data.sessions[]` 形状**（含 5 枚举 status 合法 + 非法 status 拒 + 既有 M3 字段集完整）→ `session-list.test.ts` cases 1-11 + sanity sweep。
  6. **`work_dir_list.result.data.work_dirs` 形状** → `work-dirs.test.ts` cases 16-17。
  7. **`list_directories.result.data.entries[]` 形状** → `work-dirs.test.ts` cases 12-15（含 `name` / `path` 元素形态拒）。
  8. **`CONTROL_TYPES` 长度 13 + 4 新 type 名称对齐** → `literals.test.ts` cases 1-4 + sanity sweep。
  9. **envelope `session` 字段仍 optional**（验证未误改 lock-version）→ `envelope.test.ts` cases 20-21（M3 `session_list` + M4 `list_directories` 双向守护）+ cases 22-25（4 新 type envelope round-trip 顺带覆盖）。
- **断言质量良好**——无恒真断言；负向用例真实 reject（zod `success: false` 而非 `toThrow(ZodError)`，与 M2 envelope.test.ts 风格一致；`literals.test.ts` case 4 duplicate 钉桩无 `.toBe(true)` 假阳）；枚举逐值扫描（5 status 枚举 / 13 CONTROL_TYPES / 9 M3 基线 / 4 M4 新增 全 sweep）；无 mock（直接走 `schema.safeParse` / `Envelope.safeParse`，对 zod 边界的真实断言）。

### 测试 / 构建基线

- `pnpm --filter @remotepi/shared test` 全绿；**308 → 361 全绿**（+53，PRD §9.1 下限 30 条超额 23 条；既有 308 测试零回归——M3 任务 [[tasks/m3/02-shared-tests.md|02]] 61 条 + M3 后续累积 + M4 任务 [[tasks/m4/01-web-recovery-timeout.md|01]] 测试基线未被协议 v3 破锁影响）。
- `pnpm run lint` / `pnpm run typecheck` 全绿；`packages/shared` 仅测试文件 + envelope.ts 模块头注清理（`packages/bridge` / `packages/web` / `packages/worker` 零改动）。

### 与 M3 / M4 任务 01 / 02 对照

| 维度 | M3 任务 [[tasks/m3/02-shared-tests.md\|02]] | M4 任务 01 ([[tasks/m4/01-web-recovery-timeout.md\|01]]) | M4 任务 [[tasks/m4/02-shared-protocol-v3.md\|02]] | M4 任务 03（本任务） |
|------|---------------------------------|-----------------------------------|----------------------------------|---------------------|
| 测试基线 | 22 → 102（+80，PRD §6.1 25 条下限超额）| web 237 → 308（+71，web 端） | 308（schema 任务零回归）| 308 → 361（+53，PRD §9.1 30+ 条下限超额 23 条）|
| 新建文件 | 4 文件 61 条 | 0（仅扩 `recovery.test.ts`）| `work-dirs.ts` / `session-list.ts` | 3 文件 41 条 + 3 文件扩 12 条 |
| review 结论 | 0C / 3W / 0S（2 偏差挂账）| 0C / 4W / 6S（5 项修复 + 3 项合理跳过）| 0C / 4W / 7S（6 项落地 + 3 项递延任务 09）| 0C / 2W / 5S（4 项落地 + 3 项合理跳过；W1 顺手清任务 02 遗留 drift）|
| 锁版承诺 | M2 envelope (a) 字段 + M3 envelope (a) 2 字段 | web 端 5s 修复，bridge / worker 零改动 | M4 control 9→13 type + envelope (a) 5 字段 + ADR-0010 | M4 测试补全，锁版承诺可信验证 |