---
prd: prds/m4-multi-session.md
status: todo
---
# 任务：docs 同步（envelope/control/pi 四文档 + ADR-0003 补注裁定 C + 钉子 4 + ADR-0007 关闭占用检测 + ADR-0010 校对 + current-state + getting-started [URL hash 三字段示例]）+ REPLY_TIMEOUT_MS 6 处漂移更正（grep 验证零残留）

> **任务 08 落地后最小侵入注记（2026-09-08，由 [[tasks/m4/08-web-multi-session-store.md|08 完成情况]]挂账）**：
>
> - **注记 1（M3_LEGACY 退役评估输入）**——任务 06 C2 移交义务 + 任务 08 完成情况「5 项边界决策要点」第 4 条**已落地 grep 清单**（`M3_LEGACY_KEY` / `m3-legacy` / `resolveM3CompatManager` / `defaultWorkDir` 在 bridge / web 出现位置 + 用途），任务 08 评估结论 = **保留三处代码 + JSDoc 互引**。**本任务 09 范围增列**：(a) PRD §修订注记是否需追加「2026-09-08 任务 08 退役评估条」（结论 = 暂不退役，挂账 M+ / M5 评估——任务 10 E2E 全部迁移到带 session 字段后再次评估）；(b) ADR-0008 §影响段无需改（M3-compat 路径未变）；(c) getting-started URL hash 文档无需改（M3 老链接兼容已说明）。详见 [[tasks/m4/08-web-multi-session-store.md#5-项边界决策要点|08 完成情况 5 项边界决策要点 §4]]。
> - **注记 2（PRD §4.3 SessionBucket 实际 9 字段 vs PRD 7 字段补注）**——任务 08 实施期 `SessionBucket` 实际落地 **9 字段**（PRD §4.3 写 7 字段：messages / streamingDraft / queue / sessionPhase / blockedOn / workDir / recovery；实施期增 `sessionList` 按桶镜像 + `_draftHasDelta` 内部 flag，详见 [[tasks/m4/08-web-multi-session-store.md#264cefc-实施sessionbucket-分桶-路由-per-session-视图全量|08 完成情况 §`264cefc` 实施]]）。**本任务 09 范围增列**：PRD §修订注记追加「§4.3 实施期增 2 字段（`sessionList` 替代 `WebState.sessionList` 全局字段、`_draftHasDelta` 守护 React 死循环）」一行，**不改 PRD 主体**（依项目惯例）。


## 目标
按 [[prds/m4-multi-session.md|PRD §8 文档同步表全部行]] 同步 M4 落地后的文档：envelope.md / control.md / pi.md 三协议文档（破锁 9 → 13 type + 演进规则 (a) 字段扩展 + 多会话扩展正式落地）；ADR-0003 末尾追加"M4 多会话化补注"（裁定 C ready 5min idle + 钉子 4 spawning 60s 超时）；ADR-0007 §验证与后续段删除"会话被外部进程占用检测"挂账（正式关闭）；ADR-0010 已在 02-shared-protocol-v3 落盘则此处校对；current-state.md（M4 PRD 定稿 + 任务拆分 + 看板更新 + TODO 挂账回收）；getting-started.md（state.json 说明 + URL hash 三字段格式 + ready 5min 回收告知）。同时 **`REPLY_TIMEOUT_MS` → `RECOVERY_TIMEOUT_MS` 共 6 处统一更正**（grep 实证零结果）。

关键要点：

- **`docs/architecture/protocol/envelope.md`**：锁版承诺 control 9 → 13 type（备注破锁依据沿用 ADR-0006 范式 + 新增 ADR-0010 双向引用）；演进规则 (a) 列出 M4 新增可选字段：`session_list.payload.work_dir`（裁定 A 语义备注：M4 操作惯例必带，schema optional）/ `session_state.payload.work_dir` / `pi/prompt.payload.work_dir`（裁定 A 方案 A 备注：仅 `session:'new'` 携带）/ `result.data.work_dirs[]` / `result.data.entries[]`
- **`docs/architecture/protocol/control.md`**：§6 session_list payload 加 `work_dir` 可选（M4 操作惯例必带，schema optional）；§7 session_list 回执加 `status` 字段；新增 §6.5/§6.6/§6.7/§6.8（`list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`，每个含 payload + 回执 + 失败码）；type 列表 13 项
- **`docs/architecture/protocol/pi.md`**："多会话扩展（预留）"节正式落地——每会话独立进程 + envelope `session` 字段启用规则 + sessionKey 计算 + **pending 键控**（钉子 2：`new:<work_dir>` 内部键 + map 迁移 + 短时合并语义）；新增 `pi/prompt.payload.work_dir` 字段说明（**仅 `session:'new'` 携带**，裁定 A 方案 A）；删除"将向 pi 家族新增 new_session / switch_session / list_directories"占位
- **`docs/architecture/decisions/0003-session-lifecycle-and-history-source.md`**：末尾追加"M4 多会话化补注"——idle 计时逐会话复制 / session_state 每 manager 各 broadcast / 跨会话 idle 互不干扰 / **ready 相位无写命令 5min 回收**（裁定 C：`ready → idle` 计时迁移） / **spawning 相位 60s 超时自主 kill**（钉子 4：复用自主 kill 标记路径 + exited 广播 + 清理 map 键）
- **`docs/architecture/decisions/0007-host-shared-pi-agent-dir.md`**：§验证与后续段删除"会话被外部进程占用检测"挂账（正式关闭），其它承接不变（共享池扫描 / auth 缺失 warn / PI_CODING_AGENT_DIR 高级覆盖）
- **ADR-0010**（02-shared-protocol-v3 已落盘则此处校对双向引用 + 决策源头是否完整——沿用 ADR-0006 范式）
- **`docs/current-state.md`**：活跃需求 M4 行更新 + 任务看板追加 M4 10 行 + TODO 删除"M4 候选：会话被外部进程占用检测"（已关闭）+ 更新"web 恢复仪式 snapshot 5s 超时"条目（已立项修复：M4 任务 01）+ 最近变更置顶 M4 PRD 定稿条目
- **`docs/getting-started.md`**：bridge 配置章节增 state.json 说明 + M3 work_dir 自动迁移提示；网页使用流程补"目录 → 会话"两级选择说明（含裁定 A 强制两级顺序 + URL hash 三字段格式示例）；新增 ready 5min 回收告知（裁定 C 落地后用户感受变化）
- **`REPLY_TIMEOUT_MS` → `RECOVERY_TIMEOUT_MS` 共 6 处统一更正**（PRD §修订注记已列 6 文件清单：`docs/current-state.md` / `docs/tasks/m3/07-web-recovery.md` / `docs/tasks/m3/12-e2e-harness.md` / `docs/tasks/m3/13-e2e-scenarios.md` / `docs/architecture/decisions/0009-headless-browser-e2e.md` 等）；grep 实证 `grep -rn REPLY_TIMEOUT_MS docs/` 应零结果（处数以 grep 实际为准）

## 完成标准
- [ ] `docs/architecture/protocol/envelope.md`：锁版承诺 control 9 → 13 type（破锁依据沿用 ADR-0006 + 新增 ADR-0010 双向引用）；演进规则 (a) 列出 M4 新增可选字段（5 项 + 各备注）
- [ ] `docs/architecture/protocol/control.md`：§6 session_list payload 加 work_dir 可选（M4 操作惯例必带 + schema optional 备注）；§7 session_list 回执加 status 字段；新增 §6.5-§6.8 4 个 type（每个含 payload + 回执 + 失败码）；type 列表 13 项
- [ ] `docs/architecture/protocol/pi.md`：多会话扩展节正式落地（每会话独立进程 + session 字段启用规则 + sessionKey 计算 + pending 键控 钉子 2）；新增 pi/prompt.payload.work_dir 字段说明（仅 session:'new' 携带，裁定 A 方案 A）；删除"将向 pi 家族新增 new_session / switch_session / list_directories"占位
- [ ] `docs/architecture/decisions/0003-session-lifecycle-and-history-source.md`：末尾追加"M4 多会话化补注"——idle 计时逐会话复制 + session_state 每 manager 各 broadcast + 跨会话 idle 互不干扰 + ready 相位 5min 回收（裁定 C）+ spawning 60s 超时（钉子 4：复用自主 kill 标记路径 + exited 广播 + 清理 map 键）
- [ ] `docs/architecture/decisions/0007-host-shared-pi-agent-dir.md`：§验证与后续段删除"会话被外部进程占用检测"挂账（正式关闭），其它承接不变
- [ ] `docs/architecture/decisions/0010-protocol-v3-multi-session-unlock.md`（02-shared-protocol-v3 落盘）：此处校对双向引用 + 决策源头是否完整
- [ ] `docs/current-state.md`：活跃需求 M4 行更新 + 任务看板追加 M4 10 行 + TODO 删除占用检测条目 + 更新 5s 超时条目 + 最近变更置顶 M4 PRD 定稿条目
- [ ] `docs/getting-started.md`：bridge 配置章节增 state.json 说明 + M3 work_dir 自动迁移提示；网页使用流程补"目录 → 会话"两级选择说明（含裁定 A + URL hash 三字段格式示例 `#<token>&work_dir=<encoded>&session=<key>`）；新增 ready 5min 回收告知（裁定 C）
- [ ] **`REPLY_TIMEOUT_MS` → `RECOVERY_TIMEOUT_MS` 共 6 处统一更正**：`docs/current-state.md` / `docs/tasks/m3/07-web-recovery.md` / `docs/tasks/m3/12-e2e-harness.md` / `docs/tasks/m3/13-e2e-scenarios.md` / `docs/architecture/decisions/0009-headless-browser-e2e.md` / 等（grep 实证：`grep -rn REPLY_TIMEOUT_MS docs/` 应零结果，处数以 grep 实际为准）
- [ ] `pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` / `pnpm run test` 全绿
- [ ] wikilink 链接有效（lint 验证 + grep `\[\[` 双链路径存在）
- [ ] `grep -rn REPLY_TIMEOUT_MS docs/` 零结果

## 依赖
- 依赖 [[tasks/m4/02-shared-protocol-v3.md|02-shared-protocol-v3]]（协议根任务 + ADR-0010 落盘）

## 参考
- [[prds/m4-multi-session.md|PRD §8 文档同步表全部行]]
- [[prds/m4-multi-session.md|PRD 修订注记（2026-09-08，文档漂移更正，纳入本 PRD）]]
- [[prds/m4-multi-session.md|PRD §风险与实现时核实 - REPLY_TIMEOUT_MS 文档漂移]]
- [[tasks/m3/08-docs-and-validation.md|tasks/m3/08]] ADR 补注 + getting-started 修订基线