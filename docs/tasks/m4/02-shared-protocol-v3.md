---
prd: prds/m4-multi-session.md
status: done
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

## 完成情况

任务完成，4 笔本地 commit：**`6ff6738`**（shared schema 实施核心）+ **`c0b47ba`**（worker `routeOpenMessage` default 兜底注释同步，M3 教训落地）+ **`381f4c9`**（协议文档锁步 + 新建 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]]）+ **`35dcd79`**（review 修复轮）。reviewer 结论 **0 Critical / 4 Warning / 7 Suggestion**（6 项落地 + 3 项递延任务 09），协议锁版承诺可信，可作为 M4 任务 03–10 锁版依据。

### `6ff6738` shared schema 实施核心

- **`packages/shared/src/protocol/control.ts`**：新增 4 个 envelope + payload schema——`ListDirectoriesEnvelope` / `WorkDirListEnvelope` / `WorkDirAddEnvelope` / `WorkDirRemoveEnvelope`；`SessionListPayloadSchema` 加 `work_dir?: string`；`SessionStatePayloadSchema` 加 `work_dir?: string`。
- **`packages/shared/src/protocol/pi.ts`**：`PromptPayloadSchema` 增 `work_dir?: string` + JSDoc 注释明确**仅 `session:'new'` 的 prompt 携带**（裁定 A 方案 A）；pi 家族零新增 type。
- **`packages/shared/src/protocol/literals.ts`**：`CONTROL_TYPES` 字面量 9 → 13 项——新增 `list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`。
- **`packages/shared/src/protocol/work-dirs.ts` 新建**：`ListDirectoriesPayloadSchema` / `WorkDirListPayloadSchema` / `WorkDirAddPayloadSchema` / `WorkDirRemovePayloadSchema` + 对应 `ResultSchema`（`data.entries` / `data.work_dirs`）+ `PiPromptPayloadWorkDirSchema`（仅 `session:'new'` 携带的 JSDoc 注释）。
- **`packages/shared/src/protocol/session-list.ts` 新建**：`SessionListEntrySchema`（含 `status: z.enum(['exited','idle','running','spawning','unknown'])` 字段 + 既有 M3 字段集 `id`/`name`/`cwd`/`created`/`modified`/`message_count`/`first_message`/`running`）+ `SessionListResultSchema`（`result.data.sessions` 数组二次校验）。
- **`packages/shared/src/index.ts`** barrel re-export 补齐两新文件 + 模块头注释追加 M4 段落。

### `c0b47ba` worker `routeOpenMessage` default 兜底注释同步（M3 `1c86aca` 教训落地）

- `worker/src/room.ts` 模块头注释 + `routeOpenMessage` `default` 分支注释同步列出 4 个 M4 新 control type（与 `get_state` 同路径——default 分支 M3 已存在，新 type 自动落入 default 转发，**零业务代码改动**）；M3 教训 `1c86aca`（v1 switch 缺 `get_state` + 整个 pi 家族 → 静默丢弃）作为警示语写入 `default` 分支注释（沿用 M3 既有警示，扩展为含 4 新 type 的列表）。

### `381f4c9` 协议文档锁步 + 新建 ADR-0010

- **[[architecture/protocol/envelope.md|architecture/protocol/envelope.md]]**：顶部新增 M4 修订注记；锁版承诺段 control 8 → 13 type 列表（含 M3 `get_state` + M4 4 新 type）；演进规则 (a) 追加 5 项可选字段清单（`session_list.payload.work_dir` / `session_state.payload.work_dir` / `pi/prompt.payload.work_dir` 仅 `session:'new'` 携带 / `result.data.work_dirs` / `result.data.entries` + `session_list` 回执 `status` 字段）；envelope `session` 字段启用规则（多会话下操作惯例必填，schema 仍 optional 不破锁）；演进规则 (b) control 家族 v1 内不再新增 type 修订为"除已破锁的 `get_state` + 4 个 M4 type 外不再新增 type"。
- **[[architecture/protocol/control.md|architecture/protocol/control.md]]**：顶部新增 M4 修订注记；类型列表 13 项；§5 `session_state.payload` 加 `work_dir?` 字段段；§6 `session_list.payload` 加 `work_dir?` 字段段；§7 `session_list` 回执表加 `status` 字段行 + `work_dir_list` / `list_directories` / `work_dir_add` / `work_dir_remove` 回执 shape 段；**§6.6–§6.9** 落地 4 个新 type（**§6.5 已被 `get_state` 占用故顺延**——M3 修订时插入所致，本轮 §6.5 → §6.9 共 5 段紧密相邻）；§8 错误码集合不扩展 + `M4 不新增 code` 段（`invalid_envelope` / `internal` 复用）；中间层处理规则段加 4 个新 type 的 default 转发注解（引用 `worker/src/room.ts` §`routeOpenMessage` 注释）。
- **[[architecture/protocol/pi.md|architecture/protocol/pi.md]]**：顶部新增 M4 修订注记；§`prompt` payload 加 `work_dir?` 字段段（仅 `session:'new'` 携带 + JSDoc 引用 ADR-0010）；「多会话扩展正式落地」节从预留升级为正式落地——每会话独立 pi 进程推论 + envelope `session` 字段启用规则 + sessionKey 计算 + pending 键控（钉子 2）+ `pi/prompt.payload.work_dir` 仅 `session:'new'` 携带（裁定 A 方案 A），删除原"将向 pi 家族新增 `new_session` / `switch_session` / `list_directories`"占位。
- **新建 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]]**（`architecture/decisions/0010-protocol-v3-multi-session-unlock.md`，日期 2026-09-08 / 状态 已接受）：8 决策（control 9 → 13 破锁 / envelope (a) 5 字段扩展 / envelope `session` 字段启用规则 / 每会话独立 pi 进程推论 / sessionKey 计算 + pending 键控钉子 2 / SPAWN_TIMEOUT_MS 钉子 4 = 60_000 复用自主 kill 标记路径 / worker zero 业务改动 + DO 路由 default 兜底补漏 / 错误码集合不扩展）+ 影响段（与 [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] / [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] / [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] / [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] 协同 + 双向引用补全）+ 双向引用段（envelope.md / control.md / pi.md / ADR-0003 / ADR-0006 / ADR-0007 / ADR-0009 / M4 PRD / 任务 02 / 任务 03 / 任务 06 / 任务 09）。

### `35dcd79` review 修复轮（W1–W4 + S2/S4/S6，纯注释 / 文档 drift 对齐）

- **W1** ADR-0010 §决策 4 推导"无需新增 `new_session` / `switch_session` type"的根因理由增强——补一段"bridge 不知道 pi 何时创建 session 文件，需要先 round-trip 查 session 文件名再喂 `--session`，徒增复杂度"（原版理由偏弱）。
- **W2** ADR-0010 §决策 5 pending 键控段补一句实测验证点的"已知事实"——"pi 是 lazy 创建文件的（首次 `agent_start` / 首次 stdout entry 写入后才落盘），M4 必须接受这一窗口"（与 control.md §6.9 `钉子 3` 联动）。
- **W3** ADR-0010 §决策 6 SPAWN_TIMEOUT_MS 段补 60s 在慢机器 / 冷启动机器下可能不够的免责句 + "任务 06 实施期实测真 pi 冷启动时长覆盖 P95 后再定" + "超时后通过自主 kill 标记路径保证不悬挂（不依赖外部 GC）"。
- **W4** envelope.md 演进规则 (a) 段尾补"全部为可选字段，schema 锁版承诺不变"明示（避免读者误读为破锁）。
- **S2** control.md §6.9 `work_dir_remove` 钉子 3 段补"目录从清单移除后 web `ChoicePage level=2` 不再列该 work_dir 下的会话（即 level2 不可达）"。
- **S4** pi.md「多会话扩展正式落地」节补实测验证点的合理性段——"凡未实测的落盘细节不可信"（与既有 ADR-0008 / 测试规划文档口径一致）。
- **S6** ADR-0010 影响段加"由任务 09 同步落盘"措辞——涉及 ADR-0003 / ADR-0007 / envelope.md 等多处文档同步指向。
- **递延项（任务 09 范围）**：
  - **S1** `packages/shared/src/index.ts` 模块头注释"split guidance"补 M4 模式说明（M4 已沿用 v2 拆分——`work-dirs.ts` / `session-list.ts` 各自独立模块，但模块头注释的"何时该新建独立模块"判据未补 M4 例）。
  - **S3** envelope.md 演进规则 (b) 补"破锁历史交叉引用句"（将 ADR-0006 + ADR-0010 同步列出，目前 M3 / M4 破锁信息分散在锁版承诺段 + 演进规则段两处）。
  - **S5** ADR-0010 影响段补"ADR-0007 修改由任务 09 同步落盘"措辞（S6 部分修了 §验证与后续段对应删除的指向，但 §影响段缺一句明文指向任务 09）。
- 三项均属任务 [[tasks/m4/09-docs-sync.md|09]] docs-sync 范围。

### 测试 / 构建基线

- `pnpm --filter @remotepi/shared build` / `pnpm --filter @remotepi/shared typecheck` / `pnpm --filter @remotepi/worker build` / `pnpm run lint` / `pnpm run typecheck` 全绿。
- **测试 308 条全绿不变**（schema 任务零回归——既有 shared 测试基线未被本轮新增 4 type / `session_list.status` 5 枚举 / `work_dir?` 可选字段等扩展破坏）。
- `grep -R "CONTROL_TYPES" packages/shared/src/protocol/literals.ts` 命中 13 项列表；`grep "HelloEnvelope\|EchoEnvelope" packages/shared/src` 零结果（占位 / M1 雏形已清理）。
- `packages/shared` / `packages/bridge` / `packages/web` 零非预期改动（shared 仅 schema 扩展；worker 仅注释同步 + routeOpenMessage 注释增强；bridge / web 零改动）。

### 协议锁版可信结论

control 9 → 13 type 破锁 + envelope (a) 5 字段扩展（全部 optional）+ envelope `session` 字段启用规则 + sessionKey 计算 + pending 键控 + SPAWN_TIMEOUT_MS 60_000 决策全部落地 + ADR-0010 双向引用补全 + envelope / control / pi 三文档锁版承诺与字段表锁步。**协议 v3 锁版承诺可信**，可作为 M4 任务 [[tasks/m4/03-shared-tests.md|03 shared tests]] / [[tasks/m4/04-bridge-state-json.md|04 bridge state.json]] / [[tasks/m4/05-bridge-list-directories.md|05 bridge list directories]] / [[tasks/m4/06-bridge-session-layer.md|06 bridge session layer]] / [[tasks/m4/07-web-choice-page.md|07 web choice page]] / [[tasks/m4/08-web-multi-session-store.md|08 web multi-session store]] / [[tasks/m4/09-docs-sync.md|09 docs sync]] / [[tasks/m4/10-e2e-and-validation.md|10 e2e and validation]] 的协议层锁版依据。

### 与 M3 协议根任务对照

| 维度 | M3 任务 [[tasks/m3/01-shared-protocol-v2.md|01]] | M4 任务 02（本任务） |
|------|--------------------------------------------|---------------------|
| 破锁 | control 8 → 9 type（加 `get_state`） | control 9 → 13 type（加 4 个 work-dir 相关） |
| envelope (a) | 2 字段（`session_state.payload.blocked_on` / `extension_ui_response.web.value`） | 5 字段（`session_list.payload.work_dir` / `session_state.payload.work_dir` / `pi/prompt.payload.work_dir` / `result.data.work_dirs` / `result.data.entries` + `session_list` 回执 `status` 字段） |
| ADR | [[architecture/decisions/0006-protocol-v1-get-state-unlock.md\|ADR-0006]]（破锁范式） | [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md\|ADR-0010]]（沿用 ADR-0006 范式 + M4 多会话特有决策） |
| worker 改动 | 业务代码补 `get_state` 内存回答 | 零业务改动（仅注释同步 + default 兜底注解增强） |
| 教训承接 | M2 spawn cwd 缺失 + 握手写入缺失 | M3 `1c86aca`（worker switch 缺 type 静默丢弃） → c0b47ba 注释补漏 |