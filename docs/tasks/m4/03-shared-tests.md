---
prd: prds/m4-multi-session.md
status: todo
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