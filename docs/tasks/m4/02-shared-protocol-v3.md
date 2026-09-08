---
prd: prds/m4-multi-session.md
status: todo
---
# 任务：shared 协议 v3（control 4 新 type + envelope (a) 增字段 + pi/prompt.payload.work_dir 仅 session:'new' 携带 + session_list.status）+ worker default 兜底 + ADR-0010

## 目标
按 [[prds/m4-multi-session.md|PRD §1 / §5 / §7 / §8 表 ADR-0010 行]] 落地协议 v3 扩展：control 家族新增 4 个 type（共 9 → 13，破锁沿用 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] 范式——`list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`）；envelope 演进规则 (a) 为 `session_list.payload.work_dir?` / `session_state.payload.work_dir?` / `pi/prompt.payload.work_dir?`（**仅 `session:'new'` 携带**——裁定 A 方案 A）/ `result.data.work_dirs[]` / `result.data.entries[]` 增可选字段；`session_list` 回执 `data.sessions[]` 新增 `status` 字段（5 枚举 `exited` / `idle` / `running` / `spawning` / `unknown`）；`CONTROL_TYPES` 字面量同步追加（13 项）；envelope `session` 字段在多会话下操作惯例必填（schema 仍 optional 不破锁）。同步落 envelope.md / control.md / pi.md 锁版承诺与字段表；worker DO 路由 `routeOpenMessage` 补 4 个新 control type 的 default 转发分支（M3 教训 `1c86aca` 同类——实施期严格走 default 兜底）；新建 ADR-0010 记录破锁决策源头。

关键要点：

- **`packages/shared/src/protocol/control.ts`**：新增 4 个 envelope + payload schema：
  - `ListDirectoriesPayloadSchema = z.object({ path: z.string().optional() })`（可选，缺省列 `$HOME`）
  - `WorkDirListPayloadSchema = z.object({})`
  - `WorkDirAddPayloadSchema = z.object({ path: z.string() })`
  - `WorkDirRemovePayloadSchema = z.object({ path: z.string() })`
- `session_list.payload` 加 `work_dir?: z.string()` 可选字段（M4 操作惯例必带，schema optional 兼容 M3）
- `session_state.payload` 加 `work_dir?: z.string()` 可选字段（每条广播携带对应 work_dir）
- **`packages/shared/src/protocol/pi.ts`**：`PromptPayloadSchema`（及 `SteerPayloadSchema` / `FollowUpPayloadSchema` 沿用）增 `work_dir?: z.string()` 可选字段——注释明确**仅 `session:'new'` 的 prompt 携带**（裁定 A 方案 A），其他命令不带、bridge 忽略；pi 家族**零新增 type**（每会话独立进程推论，见 PRD §1.4）
- **`packages/shared/src/protocol/literals.ts`**：`CONTROL_TYPES` 字面量同步追加 4 个 literal（共 13 项：`['handshake', 'ping', 'pong', 'bridge_status', 'session_state', 'session_list', 'get_state', 'result', 'error', 'list_directories', 'work_dir_list', 'work_dir_add', 'work_dir_remove']`）
- **`packages/shared/src/protocol/work-dirs.ts` 新建**（独立 schema 模块）：`ListDirectoriesPayloadSchema` / `WorkDirListPayloadSchema` / `WorkDirAddPayloadSchema` / `WorkDirRemovePayloadSchema` + 对应 `ResultSchema`（`data.entries` / `data.work_dirs`）+ `PiPromptPayloadWorkDirSchema`（可选字段 + 仅 session:'new' 携带的注释；不强制 session 关联以保留 schema 简洁）
- **`packages/shared/src/protocol/session-list.ts` 新建**：`SessionListEntrySchema`（含 `status: z.enum(['exited','idle','running','spawning','unknown'])` 字段 + 既有 M3 字段集 `id`/`name`/`cwd`/`created`/`modified`/`message_count`/`first_message`/`running`）+ `SessionListResultSchema`（`result.data.sessions` 数组二次校验）
- **envelope.md / control.md / pi.md 同步**：envelope.md 锁版承诺 control 9 → 13 type（破锁依据指向 ADR-0010 双向引用）+ 演进规则 (a) 列出 M4 新增可选字段；control.md §6 session_list payload 加 work_dir 可选（M4 操作惯例必带，schema optional）+ §7 session_list 回执加 `status` 字段 + 新增 §6.5/§6.6/§6.7/§6.8 4 个新 type（每个含 payload + 回执 + 失败码）+ type 列表 13 项；pi.md "多会话扩展（预留）"节正式落地——每会话独立进程 + envelope `session` 字段启用规则 + sessionKey 计算 + pending 键控 + 删除"将向 pi 家族新增 new_session / switch_session / list_directories"占位
- **worker DO `routeOpenMessage`**：补 4 个新 control type（`list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`）的 default 转发分支；M3 任务 01 review 误放行教训（`1c86aca`）——本任务实施时严格走 default 兜底补漏
- **新建 ADR-0010**：见 [[prds/m4-multi-session.md|PRD §8 表 ADR-0010 行]]——记录 control 9 → 13 type 破锁决策（沿用 ADR-0006 范式）+ envelope (a) 字段扩展清单（含 `pi/prompt.payload.work_dir` 裁定 A 方案 A 备注）+ envelope session 字段启用规则 + sessionKey 计算 + 每会话独立进程推论 + pending 键控决策（钉子 2：`new:<work_dir>` 内部键 + map 迁移时序）+ SPAWN_TIMEOUT_MS 决策（钉子 4：60_000 + 复用自主 kill 路径）

## 完成标准
- [ ] `packages/shared/src/protocol/control.ts`：4 个新 envelope（`ListDirectoriesEnvelope` / `WorkDirListEnvelope` / `WorkDirAddEnvelope` / `WorkDirRemoveEnvelope`）+ 对应 payload schema；`session_list.payload` 加 `work_dir?` 可选字段；`session_state.payload` 加 `work_dir?` 可选字段
- [ ] `packages/shared/src/protocol/pi.ts`：`PromptPayloadSchema`（及沿用字段）增 `work_dir?` 可选字段 + JSDoc 注释明确**仅 `session:'new'` 的 prompt 携带**；pi 家族零新增 type
- [ ] `packages/shared/src/protocol/literals.ts`：`CONTROL_TYPES` 字面量长度 13 + 新 type 名称对齐
- [ ] `packages/shared/src/protocol/work-dirs.ts` 新建：4 个新 payload schema + 2 个 result schema + `PiPromptPayloadWorkDirSchema`（注释 + 仅 session:'new' 携带）
- [ ] `packages/shared/src/protocol/session-list.ts` 新建：`SessionListEntrySchema`（含 5 枚举 status 字段）+ `SessionListResultSchema`
- [ ] `packages/shared/src/index.ts` barrel re-export 上列所有新文件；公共 API 完整覆盖
- [ ] envelope.md 锁版承诺 control 9 → 13 type + 演进规则 (a) 列出 M4 新增可选字段 + 与 ADR-0010 双向引用；control.md §6 session_list payload 加 work_dir 可选（M4 操作惯例必带备注）+ §7 session_list 回执加 status 字段 + 新增 §6.5-§6.8 4 个 type + type 列表 13；pi.md 多会话扩展节正式落地（每会话独立进程 + session 字段启用规则 + sessionKey 计算 + pending 键控 + 删除占位）
- [ ] worker DO `routeOpenMessage` switch 含全部 13 control type + 全部 9 pi type 的 default 转发分支（M3 `1c86aca` 教训落地）；worker 单测覆盖 4 个新 control type default 转发路径
- [ ] **新建 `docs/architecture/decisions/0010-protocol-v3-multi-session-unlock.md`**（ADR-0010）：日期 2026-09-08 / 状态 已接受 / 背景（control 9 → 13 type 破锁依据 + envelope (a) 字段扩展清单 + envelope session 字段启用规则）/ 决策（破锁 + 4 新 type + envelope 字段扩展 + pi 家族零新增 + worker default 兜底）/ 影响（与 ADR-0003 / ADR-0006 协同 + 双向引用段补全）
- [ ] `pnpm --filter @remotepi/shared build` / `pnpm --filter @remotepi/shared typecheck` / `pnpm --filter @remotepi/worker build` / `pnpm run lint` / `pnpm run typecheck` 全绿
- [ ] `grep -R "CONTROL_TYPES" packages/shared/src/protocol/literals.ts` 命中 13 项列表；`grep "HelloEnvelope\|EchoEnvelope" packages/shared/src` 零结果（占位/M1 雏形已清理）

## 依赖
- 无（协议根任务）

## 参考
- [[prds/m4-multi-session.md|PRD §1 协议演进清单]]
- [[prds/m4-multi-session.md|PRD §5 shared schema 扩展]]
- [[prds/m4-multi-session.md|PRD §7 worker default 分支补漏]]
- [[prds/m4-multi-session.md|PRD §8 文档同步表 ADR-0010 行]]
- [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] 破锁先例范式
- [[tasks/m3/01-shared-protocol-v2.md|tasks/m3/01]] 协议 v2 拆分结构（literals.ts / envelope-base.ts / control.ts / pi.ts）