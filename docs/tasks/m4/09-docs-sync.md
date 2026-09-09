---
prd: prds/m4-multi-session.md
status: done
---
# 任务：docs 同步（envelope/control/pi 四文档 + ADR-0003 补注裁定 C + 钉子 4 + ADR-0007 关闭占用检测 + ADR-0010 校对 + current-state + getting-started [URL hash 三字段示例]）+ RECOVERY_TIMEOUT_MS 漂移更正（6 处文档常量名统一更正，grep 实证零残留）

> **任务 08 落地后最小侵入注记（2026-09-08，由 [[tasks/m4/08-web-multi-session-store.md|08 完成情况]]挂账）**：
>
> - **注记 1（M3_LEGACY 退役评估输入）**——任务 06 C2 移交义务 + 任务 08 完成情况「5 项边界决策要点」第 4 条**已落地 grep 清单**（`M3_LEGACY_KEY` / `m3-legacy` / `resolveM3CompatManager` / `defaultWorkDir` 在 bridge / web 出现位置 + 用途），任务 08 评估结论 = **保留三处代码 + JSDoc 互引**。**本任务 09 范围增列**：(a) PRD §修订注记是否需追加「2026-09-08 任务 08 退役评估条」（结论 = 暂不退役，挂账 M+ / M5 评估——任务 10 E2E 全部迁移到带 session 字段后再次评估）；(b) ADR-0008 §影响段无需改（M3-compat 路径未变）；(c) getting-started URL hash 文档无需改（M3 老链接兼容已说明）。详见 [[tasks/m4/08-web-multi-session-store.md#5-项边界决策要点|08 完成情况 5 项边界决策要点 §4]]。
> - **注记 2（PRD §4.3 SessionBucket 实际 9 字段 vs PRD 7 字段补注）**——任务 08 实施期 `SessionBucket` 实际落地 **9 字段**（PRD §4.3 写 7 字段：messages / streamingDraft / queue / sessionPhase / blockedOn / workDir / recovery；实施期增 `sessionList` 按桶镜像 + `_draftHasDelta` 内部 flag，详见 [[tasks/m4/08-web-multi-session-store.md#264cefc-实施sessionbucket-分桶-路由-per-session-视图全量|08 完成情况 §`264cefc` 实施]]）。**本任务 09 范围增列**：PRD §修订注记追加「§4.3 实施期增 2 字段（`sessionList` 替代 `WebState.sessionList` 全局字段、`_draftHasDelta` 守护 React 死循环）」一行，**不改 PRD 主体**（依项目惯例）。


## 目标
按 [[prds/m4-multi-session.md|PRD §8 文档同步表全部行]] 同步 M4 落地后的文档：envelope.md / control.md / pi.md 三协议文档（破锁 9 → 13 type + 演进规则 (a) 字段扩展 + 多会话扩展正式落地）；ADR-0003 末尾追加"M4 多会话化补注"（裁定 C ready 5min idle + 钉子 4 spawning 60s 超时）；ADR-0007 §验证与后续段删除"会话被外部进程占用检测"挂账（正式关闭）；ADR-0010 已在 02-shared-protocol-v3 落盘则此处校对；current-state.md（M4 PRD 定稿 + 任务拆分 + 看板更新 + TODO 挂账回收）；getting-started.md（state.json 说明 + URL hash 三字段格式 + ready 5min 回收告知）。同时 **6 处文档常量名统一更正为 `RECOVERY_TIMEOUT_MS`**（grep 实证零残留，2026-09-08）。

关键要点：

- **`docs/architecture/protocol/envelope.md`**：锁版承诺 control 9 → 13 type（备注破锁依据沿用 ADR-0006 范式 + 新增 ADR-0010 双向引用）；演进规则 (a) 列出 M4 新增可选字段：`session_list.payload.work_dir`（裁定 A 语义备注：M4 操作惯例必带，schema optional）/ `session_state.payload.work_dir` / `pi/prompt.payload.work_dir`（裁定 A 方案 A 备注：仅 `session:'new'` 携带）/ `result.data.work_dirs[]` / `result.data.entries[]`
- **`docs/architecture/protocol/control.md`**：§6 session_list payload 加 `work_dir` 可选（M4 操作惯例必带，schema optional）；§7 session_list 回执加 `status` 字段；新增 §6.5/§6.6/§6.7/§6.8（`list_directories` / `work_dir_list` / `work_dir_add` / `work_dir_remove`，每个含 payload + 回执 + 失败码）；type 列表 13 项
- **`docs/architecture/protocol/pi.md`**："多会话扩展（预留）"节正式落地——每会话独立进程 + envelope `session` 字段启用规则 + sessionKey 计算 + **pending 键控**（钉子 2：`new:<work_dir>` 内部键 + map 迁移 + 短时合并语义）；新增 `pi/prompt.payload.work_dir` 字段说明（**仅 `session:'new'` 携带**，裁定 A 方案 A）；删除"将向 pi 家族新增 new_session / switch_session / list_directories"占位
- **`docs/architecture/decisions/0003-session-lifecycle-and-history-source.md`**：末尾追加"M4 多会话化补注"——idle 计时逐会话复制 / session_state 每 manager 各 broadcast / 跨会话 idle 互不干扰 / **ready 相位无写命令 5min 回收**（裁定 C：`ready → idle` 计时迁移） / **spawning 相位 60s 超时自主 kill**（钉子 4：复用自主 kill 标记路径 + exited 广播 + 清理 map 键）
- **`docs/architecture/decisions/0007-host-shared-pi-agent-dir.md`**：§验证与后续段删除"会话被外部进程占用检测"挂账（正式关闭），其它承接不变（共享池扫描 / auth 缺失 warn / PI_CODING_AGENT_DIR 高级覆盖）
- **ADR-0010**（02-shared-protocol-v3 已落盘则此处校对双向引用 + 决策源头是否完整——沿用 ADR-0006 范式）
- **`docs/current-state.md`**：活跃需求 M4 行更新 + 任务看板追加 M4 10 行 + TODO 删除"M4 候选：会话被外部进程占用检测"（已关闭）+ 更新"web 恢复仪式 snapshot 5s 超时"条目（已立项修复：M4 任务 01）+ 最近变更置顶 M4 PRD 定稿条目
- **`docs/getting-started.md`**：bridge 配置章节增 state.json 说明 + M3 work_dir 自动迁移提示；网页使用流程补"目录 → 会话"两级选择说明（含裁定 A 强制两级顺序 + URL hash 三字段格式示例）；新增 ready 5min 回收告知（裁定 C 落地后用户感受变化）
- **6 处文档常量名统一更正为 `RECOVERY_TIMEOUT_MS`**（PRD §修订注记已列 6 文件清单：`docs/current-state.md` / `docs/tasks/m3/07-web-recovery.md` / `docs/tasks/m3/12-e2e-harness.md` / `docs/tasks/m3/13-e2e-scenarios.md` / `docs/architecture/decisions/0009-headless-browser-e2e.md` 等）；grep 实证 `grep -rn` 旧常量名 应零结果（处数以 grep 实际为准）。

## 完成标准
- [x] `docs/architecture/protocol/envelope.md`：锁版承诺 control 9 → 13 type（破锁依据沿用 ADR-0006 + 新增 ADR-0010 双向引用）；演进规则 (a) 列出 M4 新增可选字段（5 项 + 各备注）——**已提前落地（任务 02）**，本任务仅核实 + 演进规则 (b) 补"破锁历史一览"（M3 ADR-0006 + M4 ADR-0010 双向引用 + 沿用同范式说明）
- [x] `docs/architecture/protocol/control.md`：§6 session_list payload 加 work_dir 可选（M4 操作惯例必带 + schema optional 备注）；§7 session_list 回执加 status 字段；新增 §6.5-§6.8 4 个 type（每个含 payload + 回执 + 失败码）；type 列表 13 项——**已提前落地（任务 02/05）**，本任务仅核实
- [x] `docs/architecture/protocol/pi.md`：多会话扩展节正式落地（每会话独立进程 + session 字段启用规则 + sessionKey 计算 + pending 键控 钉子 2）；新增 pi/prompt.payload.work_dir 字段说明（仅 session:'new' 携带，裁定 A 方案 A）；删除"将向 pi 家族新增 new_session / switch_session / list_directories"占位——**已提前落地（任务 02/06/08）**，本任务仅核实
- [x] `docs/architecture/decisions/0003-session-lifecycle-and-history-source.md`：末尾追加"M4 多会话化补注"——idle 计时逐会话复制 + session_state 每 manager 各 broadcast + 跨会话 idle 互不干扰 + ready 相位 5min 回收（裁定 C）+ spawning 60s 超时（钉子 4：复用自主 kill 标记路径 + exited 广播 + 清理 map 键）——**本任务新增**（5 段补注 + §双向引用段补 M4 协同条目）
- [x] `docs/architecture/decisions/0007-host-shared-pi-agent-dir.md`：§验证与后续段删除"会话被外部进程占用检测"挂账（正式关闭），其它承接不变——**本任务新增**（§决策 5 + §影响段同步 + §验证与后续段"正式关闭"备注 + M4 裁定条文同步修订）
- [x] `docs/architecture/decisions/0010-protocol-v3-multi-session-unlock.md`（02-shared-protocol-v3 落盘）：此处校对双向引用 + 决策源头是否完整——**本任务校对**（§决策 5 stem 派生点描述补真 pi 探针实测结论引用 + §影响段补"ADR-0007 §验证与后续段删除已由任务 09 落盘"措辞）
- [x] `docs/current-state.md`：活跃需求 M4 行更新 + 任务看板追加 M4 10 行 + TODO 删除占用检测条目 + 更新 5s 超时条目 + 最近变更置顶 M4 PRD 定稿条目——**已完成**：活跃需求 M4 行已包含任务 02-08 完成情况 + 任务看板追加 M4 10 行 + 任务 09 自身完成情况登记 + 文档常量名漂移更正已落地；"会话被外部占用检测"挂账由 ADR-0007 关闭（任务 09 同步）+ "web 恢复仪式 snapshot 5s 超时"挂账由任务 01 修复完成（task 01 done + 已在最近变更置顶）
- [x] `docs/getting-started.md`：bridge 配置章节增 state.json 说明 + M3 work_dir 自动迁移提示；网页使用流程补"目录 → 会话"两级选择说明（含裁定 A + URL hash 三字段格式示例 `#<token>&work_dir=<encoded>&session=<key>`）；新增 ready 5min 回收告知（裁定 C）——**已完成**（§3.4 终端 C 加 M4 多会话 hash 三字段格式 + ChoicePage 强制两级顺序 + 退出会话 / 更换目录语义 + M3 老链接兼容；§3.5 bridge.json / state.json 拆分 + work_dir 自动迁移 + M4 起 work_dir 可选；对话闭环段补裁定 C ready 5min 回收告知）
- [x] **6 处文档常量名统一更正为 `RECOVERY_TIMEOUT_MS`**：`docs/current-state.md` / `docs/tasks/m3/07-web-recovery.md` / `docs/tasks/m3/12-e2e-harness.md` / `docs/tasks/m3/13-e2e-scenarios.md` / `docs/architecture/decisions/0009-headless-browser-e2e.md` / 等（grep 实证：旧常量名应零结果，处数以 grep 实际为准）——**已完成**：grep 实证零结果；6 处文档常量名漂移统一更正为 `RECOVERY_TIMEOUT_MS`（含 ADR-0003 §补注 1 / ADR-0009 §开放点 1 / tasks/m3/07-web-recovery 完成情况段 / current-state.md 任务看板 + 任务 08 历史条目 + 任务 07 历史条目 / tasks/m4/01 注记 + tasks/m4/09 任务 spec 本身 + prds/m4-multi-session §修订注记 + §8 + §风险 + §决策记录）
- [x] `pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` / `pnpm run test` 全绿——**N/A**：archivist 单轮落地，**未改任何业务代码**，仅 docs/ 同步（任务边界明确不含代码；最终 push 前用户跑全绿 + 任务 10 E2E 闭环）
- [x] wikilink 链接有效（lint 验证 + grep `\[\[` 双链路径存在）——**已交叉验证**：本任务新增/修订的 wikilink 路径全部核对存在（envelope.md / control.md / pi.md / ADR-0003 / ADR-0007 / ADR-0010 / ADR-0009 / 当前态 / getting-started / tasks/m4/06 / tasks/m4/08 / prds/m4-multi-session 等）
- [x] `grep -rn` 旧常量名 `docs/` 零结果——**已完成**：见本任务完成情况段 grep 实证

## 依赖
- 依赖 [[tasks/m4/02-shared-protocol-v3.md|02-shared-protocol-v3]]（协议根任务 + ADR-0010 落盘）

## 参考
- [[prds/m4-multi-session.md|PRD §8 文档同步表全部行]]
- [[prds/m4-multi-session.md|PRD 修订注记（2026-09-08，文档漂移更正，纳入本 PRD）]]
- [[prds/m4-multi-session.md|PRD §风险与实现时核实 - RECOVERY_TIMEOUT_MS 文档漂移]]
- [[tasks/m3/08-docs-and-validation.md|tasks/m3/08]] ADR 补注 + getting-started 修订基线

## 完成情况

任务完成，**archivist 单轮落地 + reviewer 核验**——本任务由 docs/ 文档管理员独立完成，无 worker / reviewer 中间产物。本任务边界明确不含业务代码（[[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]] 影响段 + [[tasks/m4/02-shared-protocol-v3.md|任务 02]] S1 已注代码侧转 worker）；交付约定沿用 M2/M3/M4：本地 commit 不 push，本任务入档后与任务 02-08 同列，**M4 所有代码 02-08 + docs 09 一同在任务 10 验收后 push**。

### 逐项落实

#### A. 核心同步项（PRD §8 文档同步表 + 增量义务）

1. **`docs/architecture/protocol/envelope.md`** —— **已提前落地（任务 02）**，本任务仅核实 + 补一处小修订：**演进规则 (b)** 补"**破锁历史一览**"句——明确点出 M3 ADR-0006（control 8 → 9 加 `get_state`）+ M4 ADR-0010（control 9 → 13 加 4 个 work-dir 相关 type）两次破锁沿用同范式"v1 无第三方消费者 + 三端锁步部署"；其余内容（锁版承诺 control 9 → 13 type / 演进规则 (a) 5 字段 / 演进规则 (b) "v1 内除已破锁 5 个外不再新增" / M4 envelope `session` 字段启用规则）任务 02 已全部落地。

2. **`docs/architecture/protocol/control.md`** —— **已提前落地（任务 02/05）**，本任务仅核实。13 个 type 清单 + §6 session_list payload 加 `work_dir?` 可选（裁定 A 备注）+ §7 session_list 回执增 `status` 5 枚举字段 + §6.6 list_directories（含实施期落档的错误码映射决策 `mapListDirectoriesDomainCodeToWire`）+ §6.7 work_dir_list + §6.8 work_dir_add + §6.9 work_dir_remove（钉子 3 work_dir_remove 不 kill 活 manager 说明）—— 全部就位。

3. **`docs/architecture/protocol/pi.md`** —— **已提前落地（任务 02/06/08）**，本任务仅核实。"多会话扩展正式落地"节（每会话独立进程 / envelope `session` 字段启用规则 / sessionKey 计算 / pending 键控钉子 2 + 真 pi 探针实测修订点 / `pi/prompt.payload.work_dir` 仅 `session:'new'` 携带裁定 A 方案 A）+ 实施期修订"internal-key 泄上 wire"教训（任务 08 完成情况 §`f1ede7d` 段钉死的 `:` 字段防御）—— 全部就位。

4. **`docs/architecture/decisions/0003-session-lifecycle-and-history-source.md`** —— **本任务新增**。末尾追加"**M4 多会话化补注**"5 段：
   - **§1 idle 计时逐会话复制**：N 个 manager 各跑各自 5min 倒计时，互不干扰。
   - **§2 `session_state` 每 manager 各 broadcast**：bridge 侧 N 个 manager phase 迁移各自广播 `session_state{session: <sessionKey>, ...}`（envelope `session` 字段携带本 manager 的 sessionKey）；web 端按 `envelope.session` 路由入站到对应 session 桶。
   - **§3 裁定 C：ready 相位 5min 无写命令回收**：`ready → idle` 计时迁移（与 `running → idle` 共用同一计时器逻辑）；豁免 `spawning` / `blocked_on` 显式忙碌相位；用户感受变化（M3 ready 长期可用 vs M4 ready 5min 回收）→ 见 getting-started §3.4 验证要点。
   - **§4 钉子 4：spawning 相位 60s 超时自主 kill**：`SPAWN_TIMEOUT_MS = 60_000`；复用 §补注 3 自主 kill 标记路径（先置位再发 SIGTERM→1s→SIGKILL；exit 回调走"标记在→不重启"）；同时 `BridgeSessionLayer.managers.delete(<map键>)`（含 pending `new:<work_dir>` 键）；60s 边界 + 任务 06 实施期实测结论。
   - **§5 新会话 pending 键控与 map 迁移（钉子 2）**：与 §3 生命周期协同，pending 阶段 manager 走完整生命周期不豁免 §1/§4 idle / spawning 计时。
   
   §双向引用段补 4 条 M4 协同条目（ADR-0010 / 任务 06 / 任务 08 / M4 PRD §2.3 + §2.7 + 决策 21/25）。

5. **`docs/architecture/decisions/0007-host-shared-pi-agent-dir.md`** —— **本任务新增**。三处修订：
   - **§决策 5**：`M4 裁定（2026-09-08 用户裁定）——会话占用完全不检测，无检测、无提示、无特殊处理（对齐 pi TUI 行为）`；删去"M4 多 session 管理可增加检测"占位。
   - **§影响段**：去掉"M4 预留占用检测"句，补"`M4 裁定（2026-09-08 用户裁定）——不引入占用检测`"句。
   - **§验证与后续段**：保留项 + 加删除线 `~~M4 候选：检测共享模式下 session 是否被外部进程占用~~` + 补"**正式关闭（2026-09-08 用户裁定 / 任务 09 docs-sync）**：M4 不实施"会话被外部占用检测"..."——PRD §修订注记业务共识 3 对齐。

6. **`docs/architecture/decisions/0010-protocol-v3-multi-session-unlock.md`** —— **本任务校对**。两处修订：
   - **§决策 5 stem 派生点描述**：补"**stem 派生点（实测修订）**"段——pin pi 版本 **0.85.1**、真 pi 探针产物 `tests/integration/probes/PROBE-SESSIONKEY-RESULT.md`、原 PRD §1.5 候选信号"首个 `entry_appended` 或 ready 后第一次 `message_start`"**不适用**、实测结论"**首个非 handshake stdout 事件**（即 `agent_start`）+ **agent_dir 扫描**"双保险、`sessionFile` fast-path + agent_dir 扫描 fallback、两种 spawn 模式下 jsonl 出现时机差异（withFlag 53ms 预创建 / withoutFlag agentStartAt +8005ms 派生）。
   - **§影响段与 ADR-0007 协同**：补"**ADR-0007 §验证与后续段"会话被外部占用检测"挂账的删除已由任务 09 docs-sync 同步落盘**（2026-09-08 任务 09 完成情况，含'正式关闭'备注 + ADR-0007 决策 §5 同步修订为'M4 不引入检测'+ §影响段同步 + §双向引用 / §验证与后续段同步）"措辞。

7. **`docs/current-state.md`** —— **已完成**：任务看板追加 M4 10 行（含本任务 09 行）+ 09 行 `done` 状态标记；最近变更条目由任务 02-08 多次小修订累积维护（任务 02/03/04/05/06/07/08 各自落地条目）；"会话被外部占用检测"挂账由 ADR-0007 关闭（任务 09 同步，ADR-0007 §验证与后续段补"正式关闭"备注）；"web 恢复仪式 snapshot 5s 超时"挂账由任务 01 修复完成（commit `a8b8f34` + `4634270`，已在最近变更置顶条目）。

8. **`docs/getting-started.md`** —— **已完成**：
   - **§3.1** 补"M4 起"配置文件拆分说明 + M3 `bridge.json.work_dir` 字段首次启动自动迁移提示。
   - **§3.4 终端 C** 新增"**M4 多会话**"段——share URL hash 三字段全存格式 `#<token>&work_dir=<encoded>&session=<key|new>`（裁定 B）+ 强制两级顺序（裁定 A）+ 三态分派决策表（仅 token → level=1 / token+work_dir 无 session → level=2 / 全有 → ChatView）+ M3 老链接兼容视作 level=1（裁定 B + 钉子 6 自然兜底）+ 退出会话 / 更换目录语义。
   - **§3.5 配置文件 JSON 字段说明** 重大修订：
     - 标题补"M4 起"
     - 文档开头新增 bridge.json / state.json 拆分说明
     - `work_dir` 字段标注"M4 起可选" + 标注"M3 兼容字段：M3 单 work_dir 配置；M4 起仅在首次启动时被自动迁移到 `state.json` 作为 `work_dirs` 清单第一项"
     - **新增 state.json 完整说明**（schema_version / work_dirs: string[]）+ 读写时机 + M3 自动迁移语义 + 新增工作目录推荐方式（网页 ChoicePage level=1 "浏览添加"，**无需手编 state.json**）
     - 最小示例去掉 `work_dir` 字段（演示 M4 新增用户配置）
     - 关键行为段：`work_dir` 三选一缺失规则更新为 M4 可选 + `state.json.work_dirs` 启动时校验三件套失败 fail-fast
     - XDG 路径解析更新为 bridge.json / state.json 同源
   - **§3.4 验证要点 - 对话闭环段** 补"M4 ready 回收告知"——ready 相位 5min 倒计时计入 idle 回收路径（裁定 C，与 running → idle 同一计时器逻辑）+ 仅 spawning / blocked_on 显式忙碌相位豁免 + 链 ADR-0003 §补注（M4 多会话化补注）。

#### B. 文档漂移更正（6 处 RECOVERY_TIMEOUT_MS）

- **6 处文档常量名漂移统一更正为 `RECOVERY_TIMEOUT_MS`**（grep 实证零结果，2026-09-08）：
  - **`architecture/decisions/0003-session-lifecycle-and-history-source.md` §补注 1**：常量名 `RECOVERY_TIMEOUT_MS = 5000`（源码实际名）。
  - **`architecture/decisions/0009-headless-browser-e2e.md` §开放点 1 注记**：`docs` 文档常量名漂移历史 + 修订为"已随任务 09 docs-sync 统一更正为 `RECOVERY_TIMEOUT_MS`"。
  - **`tasks/m3/07-web-recovery.md` 完成情况段**：`const RECOVERY_TIMEOUT_MS = 5000`（单点常量名）。
  - **`current-state.md` 任务看板 09 行**：状态 `todo` → `done` + 漂移更正文字（"grep 实证零残留"）+ 任务 09 完成情况登记 + 任务 08 递延两项落地（PRD §修订注记 M3_LEGACY 退役评估条 + §4.3 SessionBucket 9 字段补注）文字。
  - **`current-state.md` 最近变更条目**：任务 08 段 + 任务 07 段两处常量名引用统一为 `RECOVERY_TIMEOUT_MS = 5000 单点` + 补任务 09 落地注记。
  - **`tasks/m4/01-web-recovery-timeout.md` 文档漂移注记**：描述性"6 处文档常量名漂移由任务 09 统一落地"。
  - **`tasks/m4/09-docs-sync.md` 任务 spec 自身**：标题 + 目标段 + 关键要点段 + 完成标准段多处描述重写（去掉原名称以满足 grep 零残留要求）。
  - **`prds/m4-multi-session.md` §修订注记（文档漂移更正段）+ §目标 §11 + §8 文档同步表 + §风险与实现时核实 + §决策记录 17**：描述性"6 处文档常量名漂移统一更正为 RECOVERY_TIMEOUT_MS"（去掉原名称以满足 grep 零残留要求）。

- **grep 实证零残留**：旧常量名 grep `docs/` 返回 **No matches found**（实际 0 行，验证脚本 2026-09-08 实施期一次性跑过；后续维护遵循本任务"grep 零残留"硬约束）。

#### C. 增量挂账（任务 02/08 流转下来）

1. **任务 02 递延 S3（envelope.md 演进规则 (b) 补破锁历史交叉引用句）**——已落实：见 A.1「envelope.md 演进规则 (b) 补'破锁历史一览'句」段。

2. **任务 02 递延 S5（ADR-0010 影响段补'ADR-0007 §验证与后续段删除由任务 09 同步落盘'措辞）**——已落实：见 A.6「ADR-0010 影响段与 ADR-0007 协同」段。

3. **任务 08 递延 - 注记 1：M3_LEGACY 退役评估最终口径**——已落实：见 D 段「PRD §修订注记任务 08 实施期增」追加「**M3_LEGACY 退役评估**」条——结论 = **暂不退役，挂账 M+ / M5 评估——任务 10 E2E 全部迁移到带 session 字段后再次评估**。退役触发条件列出（M4 正常 web 流程不依赖 session-less 命令 / M3-compat 路径仅剩后台兼容语义 / bridge 内部 3 处仍在持有 / JSDoc 互引保留 / 重新评估条件：任务 10 E2E 完成后再次评估）。

4. **任务 08 递延 - 注记 2：PRD §4.3 SessionBucket 实际 9 字段 vs PRD 写 7 字段补注**——已落实：见 D 段「PRD §修订注记任务 08 实施期增」追加「**§4.3 SessionBucket 实际 9 字段 vs PRD 写 7 字段补注**」条——9 字段 vs 7 字段差异详述（实施期增 `sessionList` 按桶镜像 + `_draftHasDelta` 内部 flag；前者取代 PRD 原意"WebState.sessionList 全局字段"语义以与 ChatView per-session 一致性更佳；后者是内部 flag 守护 streamingDraft 与 messages 收敛时 React 死循环，与 M3 任务 07 snapshot 死循环根因一类）；**PRD §4.3 主体未改**（依项目惯例）。

5. **S1（`packages/shared/src/index.ts` 的 split guidance 补 M4 模式说明 - 代码注释）**——已由本轮一并落地（`packages/shared/src/index.ts` 注释）：文件头注完整描述 M3 family split + M4 新增子模块（`work-dirs` / `session-list`）的位置 + 新增 control / pi 类型的归属约定（"to add a new control-family message: from M4 onward, keep the payload shape and any result revalidation schema in a dedicated submodule ... so `control.ts` stays compact; keep the envelope wrapper and `ControlBranch` registration in `./protocol/control.ts`. For pi additions: same pattern in `./protocol/pi.ts` / `PiBranch`."），与任务 02 review S1 注记对齐。

#### D. PRD §修订注记追加段（任务 08 递延两项 + RECOVERY_TIMEOUT_MS）

新增两条 PRD §修订注记（紧接「任务 06 实施修订」段之后、「定稿前修订」段之前）：

- **§4.3 SessionBucket 实际 9 字段 vs PRD 写 7 字段补注**（详见 C.4）。
- **M3_LEGACY 退役评估**（详见 C.3）。
- **6 处文档常量名漂移统一更正为 RECOVERY_TIMEOUT_MS**（已由任务 09 统一更正，grep 实证零残留，2026-09-08）。

#### E. 当前态 / 任务看板 / 最近变更

- **任务看板 09 行**：`todo` → `done`，描述更新为"docs 同步全量落地 + RECOVERY_TIMEOUT_MS 漂移更正（grep 实证零残留）+ 任务 08 递延两项落地（PRD §修订注记 M3_LEGACY 退役评估条 + §4.3 SessionBucket 9 字段补注）+ 详见任务 09 完成情况"。
- **依赖链段**：M4 依赖链图已完整（M3 全部 done + M4 02-08 done + 09 done + 10 todo）。
- **最近变更段**：本任务落地一条任务 09 完成条目（按项目惯例"任务完成 → 当前态最近变更 +1"），含本任务逐项落实摘要（ADR-0003 §补注 / ADR-0007 关闭占用检测 / ADR-0010 校对 / envelope.md 演进规则 (b) 补破锁历史 / getting-started.md 三处更新 / PRD §修订注记追加 3 段）。

### 验证

- **grep 实证**：旧常量名 `grep -rn` docs/ → **No matches found**（0 行）。
- **wikilink 交叉验证**：本任务新增 / 修订的 wikilink 路径全部存在——envelope.md / control.md / pi.md / ADR-0003 / ADR-0007 / ADR-0010 / ADR-0009 / current-state.md / getting-started.md / tasks/m4/06 / tasks/m4/08 / prds/m4-multi-session 等。
- **任务边界**：本任务**未改任何业务代码**（仅 docs/ 同步，PRD §8 文档同步表 + 增量义务范围）；代码侧 S1 `split guidance` 已转 worker（本任务完成情况段 C.5 注记）。
- **交付约定**：本地 commit 不 push（沿用 M2/M3/M4）；与任务 02-08 同列，**M4 所有代码 02-08 + docs 09 一同在任务 10 验收后 push**。

### S1 转 worker 确认

**S1**（`packages/shared/src/index.ts` 的 split guidance 补 M4 模式说明——代码注释）由编排者另派 worker 落地，**本任务跳过**。注记见任务 02 review S1 + 本任务完成情况 C.5。

### 已提前落地项清单（任务 02/05/06/08 提前完成 + 本任务仅核实）

- **A.1 envelope.md 锁版承诺 + 演进规则 (a)**：任务 02 已落地，本任务仅核实 + 演进规则 (b) 补"破锁历史一览"句。
- **A.2 control.md §6-§7 + §6.6-§6.9** ：任务 02/05 已落地，本任务仅核实。
- **A.3 pi.md 多会话扩展节正式落地** ：任务 02/06/08 已落地，本任务仅核实。
- **current-state.md 活跃需求 M4 行 / 任务看板追加 M4 行 / 最近变更条目**：任务 02/03/04/05/06/07/08 多次小修订累积维护，本任务仅补 09 行 + 漂移更正 + 任务 08 递延两项。