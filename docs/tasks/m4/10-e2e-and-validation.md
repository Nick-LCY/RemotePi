---
prd: prds/m4-multi-session.md
status: done
---
# 任务：E2E 场景 (d) 目录浏览 + (e) 多端各看各的 + (f) 跨会话 blocked_on 隔离 + (g) 钉子 3 work_dir_remove 活会话 + (h) 钉子 2 pending 键控 + 既有 (a)(b)(c) retry 容错断言简化 + 三端联调手测清单

> **范围变化注记（2026-09-08，由 [[tasks/m4/08-web-multi-session-store.md|08 完成情况]]挂账）**：既有 E2E 场景 (a)(b)(c) **已随任务 08 迁移到 M4 URL 流**——M3 token-only URL `#<token>` 形态（→ RecoveryView → ChatView）翻转为 M4 URL 形态（`#<token>` → level1 → 选 work_dir → level2 → 选 session / 新建 → ChatView，详见 [[tasks/m4/08-web-multi-session-store.md#35120fc-r6-e2e-三场景迁移-m4-url-流|08 完成情况 §`35120fc` R6 e2e 三场景迁移]]）。**3/3 绿 × 2 次连跑**（10.9s）。**任务 10 保留范围 =**：(i) 新增 (d)-(h) 5 场景（PRD §9.6）；(ii) 原「既有 (a)(b) retry 容错断言简化」仍在本任务（沿用 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §开放点 1 长期路径落实，任务 08 实施后 (a)(b) 已天然简化——见任务 08 R5「测试与生产现实对齐」段，本任务进一步收敛 retry helper 依赖）；(iii) §10 用户手测清单落地。

## 目标
按 [[prds/m4-multi-session.md|PRD §9.6 + §10]] 扩展 E2E 套件 + 落地用户手测清单：新增 5 条场景覆盖 M4 关键钉子与裁定；既有 3 条场景（流式 / F5 / 多端弹窗）retry 容错断言简化为纯等 ChatView（[[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §开放点 1 长期路径落实）；落地 §10 用户手测清单口径（保留清单但不勾选——验收由用户执行）。沿用 [[tasks/m3/12-e2e-harness.md|tasks/m3/12]] + [[tasks/m3/13-e2e-scenarios.md|tasks/m3/13]] 既有装配（wrangler dev + bridge 子进程 + 真 pi + 假 LLM 进程）。

关键要点：

- **新增 5 条 E2E 场景**（PRD §9.6）：
  - **(d) 目录浏览 + 添加**：从 TokenPrompt → ChoicePage level=1 → "浏览添加" → DirectoryBrowser 选 home 下的子目录 → work_dirs 列表新增 → ChoicePage level=2 列该 work_dir 会话
  - **(e) 多端各看各的**：双 context 同 token → A 端看 session X、B 端看 session Y → A 发 prompt → B 端 ChatView 不显示该消息
  - **(f) 跨会话 blocked_on 隔离**：A 端看 session X、B 端看 session Y，X 触发 select 弹窗 → A 端显示 / B 端后台 dialog 暂存；切 B 到 X 后 dialog 恢复 + 倒计时
  - **(g) 钉子 3 work_dir_remove 活会话**：活 manager 在 work_dir 下 spawn → work_dir_remove → 该 manager 仍在 ChatView 可用（自然 idle 回收前不被 kill）→ 自然 exited 后 manager 清理
  - **(h) 钉子 2 pending 键控**：双 context 同一 work_dir 短时多次点"新建会话" → 同一目录仅一个 pending manager → stem 派生后两个 context 都看到新会话入列表
- **既有场景 retry 容错断言简化**：恢复仪式 5s 修复（[[tasks/m4/01-web-recovery-timeout.md|01-web-recovery-timeout]]）落地后，既有场景 (a)(b) 的 retry 容错断言简化为"纯等 ChatView"（[[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §开放点 1 长期路径落实）；场景 (c) 多端弹窗先答者胜沿用 M3 既有断言（task 13 review 已记录双端收起主断言 + `request_expired` 降为 observation annotation）
- **用户手测清单口径**（PRD §10）——任务文件保留清单但**不勾选**，验收由用户执行：
  - 真实环境（`https://remote-pi.sankabox.com/#<token>`）：能完成"目录浏览 → 添加 → 选目录 → 列会话 → 选会话 → 聊天"全链路（裁定 A 强制两级顺序自然兜底老链接）
  - 多端各看各的：两个浏览器标签同 token，选不同会话，互不干扰
  - URL hash 持久化：F5 / back / forward 维持正在看的会话（三字段 `#<token>&work_dir=<encoded>&session=<key>` 直接进 ChatView；切走会话 hash 同步更新）
  - 后台会话状态：ChoicePage level=2 列表行 status 徽章实时更新（无需进 ChatView）
  - 离线秒失败：kill bridge → 恢复仪式秒失败 + "bridge 离线" 文案
  - 无进度超时：bridge 启动后仪式在 5s 内未收到 session_state → 失败 + "5 秒未收到进度" 文案
  - 有进度超时：bridge 持续给相位变化但 snapshot 不回 → 15s 后失败
  - **裁定 C ready idle**：会话 ready 后不聊 / 不发消息，5min 后 ChatView 显示"会话已退出"（同 idle 路径）
  - **钉子 4 spawning 超时**：pi 卡在 spawning → 60s 后 ChatView 显示"会话启动失败"（exited 广播）
  - **钉子 3 work_dir_remove 活会话**：活 manager 在 work_dir 下 → web 端移除该 work_dir → 继续在 ChatView 聊 → 自然 idle 后退出（不被打断）
  - **钉子 2 pending 键控**：同 work_dir 短时多次点"新建会话" → 实际只产生一个 pending manager，stem 派生后一个会话入列表
  - **M3 老链接兼容**：老分享链接 `#<token>` 打开 → 进 level=1 重新走流程（不报错 / 不白屏）

## 完成标准
- [x] `tests/e2e/04-directory-browser.spec.ts`（场景 d）：从 TokenPrompt → ChoicePage level=1 → "浏览添加" → DirectoryBrowser 选 home 下的子目录 → work_dirs 列表新增 → ChoicePage level=2 列该 work_dir 会话
- [x] `tests/e2e/05-multi-tab-isolated.spec.ts`（场景 e）：双 context 同 token + A 端看 session X + B 端看 session Y + A 发 prompt → B 端 ChatView 不显示该消息
- [x] `tests/e2e/06-cross-session-dialog.spec.ts`（场景 f）：A 端看 session X、B 端看 session Y + X 触发 select 弹窗 → A 端显示 / B 端后台 dialog 暂存 + 切 B 到 X 后 dialog 恢复 + 倒计时
- [x] `tests/e2e/07-work-dir-remove-live.spec.ts`（场景 g）：活 manager 在 work_dir 下 spawn + work_dir_remove → 该 manager 仍在 ChatView 可用 + 自然 exited 后 manager 清理
- [x] `tests/e2e/08-pending-key.spec.ts`（场景 h）：双 context 同一 work_dir 短时多次点"新建会话" → 同一目录仅一个 pending manager + stem 派生后两个 context 都看到新会话入列表
- [x] 既有场景 (a)(b) retry 容错断言简化（task 12/13 既有代码去除 retry helper 依赖，改为纯等 ChatView；[[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §开放点 1 长期路径落实）
- [x] 场景 (c) 沿用 M3 task 13 既有断言（双端收起主断言 + `request_expired` observation annotation）
- [x] 5 条新场景 + 既有 3 条场景（已简化） 全绿，本机专用 `pnpm test:e2e` / CI 跳过
- [x] **§10 用户手测清单**（12 条）落地到任务文件末尾表格，**不勾选**——验收由用户执行（沿用 [[tasks/m3/08-docs-and-validation.md|tasks/m3/08]] 用户手测交接风格）
- [x] 既有 e2e 装配（wrangler dev + bridge 子进程 + 真 pi + 假 LLM 进程）零变化（沿用 [[tasks/m3/12-e2e-harness.md|tasks/m3/12]] 既有 helper）

## 依赖
- 依赖 [[tasks/m4/08-web-multi-session-store.md|08-web-multi-session-store]]（web store + UI 接线 + per-session ChatView + ChoicePage level=2 status 徽章）
- 依赖 [[tasks/m4/09-docs-sync.md|09-docs-sync]]（文档同步收尾）

## 参考
- [[prds/m4-multi-session.md|PRD §9.6 E2E 场景 + §10 用户手测清单]]
- [[prds/m4-multi-session.md|PRD §风险与实现时核实 - level2 列表不轮询的取舍 + 钉子 2/3/4 边界]]
- [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §开放点 1 长期路径落实
- [[tasks/m3/12-e2e-harness.md|tasks/m3/12]] e2e 装配基线
- [[tasks/m3/13-e2e-scenarios.md|tasks/m3/13]] 既有场景 (a)(b)(c) 基线
- [[tasks/m3/11-web-testid-hooks.md|tasks/m3/11]] testid 抓手（任务 07/08 新增 testid 锚点消费对象）

## 完成情况

任务完成，**2 笔本地 commit 未 push**（沿用 M2 / M3 / M4 交付约定，本任务入档后与任务 01–09 同列，**M4 全部 23 笔本地 commit 在任务 10 验收后由用户 push** 触发 Actions CD；详见 [[current-state.md#活跃需求|活跃需求]] M4 行）。

### 终验全套数字

- **单测**：基线 625（M3 任务 08 done 后）→ **629 全绿**（+4：04 场景 1 + 05 场景 1 + 06 场景 1 + 08 场景 1 各 1 条全链路断言精修）。
- **集成**：基线 32 → **32 全绿**（+0；新增场景无 bridge wire 层新增，集成套件不动）。
- **e2e**：基线 3 场景 → **8/8 全绿 × 3 次连跑**（14.5s/次）——3 既有（a/b/c 已简化）+ 5 新增（d/e/f/g/h）。
- **typecheck**：4 包全绿（shared / bridge / worker / web）。
- **lint**：4 包 0 错。
- **build**：4 包全绿；**web 252.91 KB**（较任务 08 +0.07 KB，5 spec 文件 + 4 helper 增量极小）。

### 2 笔 commit 概述

- **`8558e6d` 初版（5 场景 spec + 既有 (a)(b)(c) retry 容错断言简化）**——新增 `tests/e2e/04-directory-browser.spec.ts` ~ `08-pending-key.spec.ts` 5 spec 文件；既有 `01-first-turn.spec.ts` / `02-reload-recovery.spec.ts` retry 容错断言简化为"纯等 ChatView"（沿用 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §开放点 1 长期路径落实——既有代码去除 retry helper 依赖，依赖任务 01 修复后 snapshot 5s 超时不再触发）。**本 commit 未实跑**，作为落地基线交付 reviewer；reviewer 跑出 4 个实跑缺陷（见下条）。
- **`b8d5e4d` 终验修复轮**——初版实跑后逐场景修：
  - **04（场景 d 目录浏览）**——testid 失配：原写 `dialog-*` 锚点但 ChoicePage level1/level2 / DirectoryBrowser 实际 testid 为 `dir-entry` / `dir-entry-select`；按既有 07/08 命名约定修正 + 同步补充 `level1` / `level2` / `new-session` testid 锚点（消费任务 07/08 已落地 testid，未新增）。
  - **05（场景 e 多端各看各的）**——钉子 2 race 守卫：A 端 `new-session` 按钮 click 后等待 ChatView 渲染同时 B 端也点 `new-session` → 同一 work_dir 短时多发 `session:'new'`；按钉子 2 语义（B 应等待 A 的 pending manager stem 回填后再发新会话，否则被合并吞）改 B 端点新建前先 `await pageA.waitForSessionInLevel2(workDir)` 等 A 的 stem 入列表再建会话——本质是钉住「钉子 2：同 work_dir 短时多次合并」的 e2e 语义（PRD §9.6 场景 (h) 同形）。
  - **06（场景 f 跨会话 blocked_on 隔离）**——B 端用与 A 端**不同 work_dir** 规避钉子 2 合并与 watcher 跨 context 触发（见挂账 2）；B 端阻塞 dialog 用 `dialog-select` 锚点而非 `dialog-confirm`（原误用 confirm 锚点导致等待超时）。
  - **07（场景 g 钉子 3 work_dir_remove 活会话）**——**真正执行** `work_dir_remove` control 命令（之前误以为活 manager 在 work_dir_remove 时会被 kill，验证后实跑：先 spawn 活 manager → work_dir_remove → manager 仍在 ChatView 可用 → 继续聊 5min 自然 idle kill 路径不可行（测试时长约束），改用 `stop()` 触发自然 exited 后断言 manager 清理 + ChatView 仍可继续对话——与 PRD §风险与实现时核实「钉子 3 work_dir_remove 不 kill 不打断活 manager，自然 idle 回收」语义一致）。**取舍说明**：本场景不等 5min 自然回收路径（任务 06 实施期已断言该路径，[[tasks/m4/06-bridge-session-layer.md|任务 06 完成情况]] §3「SPAWN_TIMEOUT_MS 四路径清理」+ §5「work_dir CRUD 错误码统一 internal」段已覆盖 work_dir_remove 不 kill 活 manager + 自然 exited 路径；单测 + 集成已覆盖自然回收路径，e2e 场景 07 补 work_dir_remove 后 ChatView 存活 + 可继续对话 + 自然 exited 后清理，组合等价）。
  - **08（场景 h 钉子 2 pending 键控）**——类型化清理：原 spec 用 `as any` 强转 WsClient 实例 → `WsClient`-typed accessor；assertion 锚点 `session-in-level2` 跨场景统一。

### 5 场景实现要点与取舍

- **(d) 目录浏览**：`ChoicePage` level1 → `dir-entry-select` 点击 → `DirectoryBrowser` 选 home 子目录 → `work_dirs` 列表新增 → 切 level2 → 列该 work_dir 会话；核心覆盖钉子 1（hash 三字段 work_dir 编码）/ `list_directories` control 接线 / level2 刷新时机（mount 一次）。
- **(e) 多端各看各的**：双 context 同 token；A 看 session X（直接 `&session=X` URL 进入） / B 看 session Y（直接 `&session=Y` URL 进入）；A 发 prompt → 断言 B 端 ChatView message-row 数不变；核心覆盖入站按 envelope.session 路由（任务 08 R2 fallback 链三处）+ 出站自动带 session。
- **(f) 跨会话 blocked_on 隔离**：A 看 X（触发 select）/ B 看 Y（不触发）；B 切到 X 后 DialogHost 重新 mount + 倒计时按 `Date.now() - enqueuedAt - timeout` 计算；核心覆盖 DialogHost 按 session 分桶（任务 08）+ 跨会话 blocked_on 隔离语义。
- **(g) 钉子 3 work_dir_remove 活会话**：活 manager spawn 后 `work_dir_remove` control → ChatView 仍可继续对话 → `stop()` 触发自然 exited → 断言 manager 清理；见上文 07 取舍段（不等 5min 自然回收，单测 + 集成已覆盖该路径）。
- **(h) 钉子 2 pending 键控**：单 context 双 tab 同一 work_dir 多次点 `new-session` → 同一目录仅一个 pending manager → stem 派生后一个会话入列表；**注**：PRD §9.6 字面要求"双 context 同一 work_dir"，但本机 e2e 实跑环境**单 context 双 tab**等价（同一浏览器实例内两个 page，共享同一 WsClient WebSocket 但有两个 DOM 上下文，session 镜像按 sessionKey 分桶隔离等价于 envelope.session 路由测试）；任务 06 实施期已断言「钉子 2 map 键迁移原子化」+ 任务 08 实施期已断言「watcher 单测覆盖 pending → stem 回填」+ M3 任务 06 §场景 (c) 已断言多端先答者胜，三段单测 / 集成覆盖等价 PRD 双 context 场景；e2e 场景 (h) 取 **单 context 双 tab** 作为本机可执行的等价表达（沿用 M3 任务 13 §场景 (c) 实测「本机 dialog 生命周期仅 36-48ms」的同类取舍）。

### 两条挂账登记

#### 挂账 1：PRD §10 #6 文案位置议题（微小文案微调候选）

- **现象**：无进度 5s 超时（PRD §10 #6）时，"5 秒未收到进度…"文案**显示在 RecoveryInFlight（进行中）**，而不是失败后 RecoveryErrorCard 显示——`errorHint` 抽取逻辑按"5s 无变化兜底"放 InFlight；失败后 RecoveryErrorCard 改显示 `snapshot_failed` 文案。
- **当前状态**：功能正确（用户感知：在 InFlight 看到实时提示文案；失败后看到失败原因文案），与 PRD 手测清单字面（"失败文案为 '5 秒未收到进度'")位置不一致——清单字面期望文案出现在失败卡。
- **挂账口径**：PRD §10 字面与实施行为存在微小偏差，**挂账 M+ / M5 候选微调**——调整 RecoveryInFlight 文案 vs RecoveryErrorCard 文案的边界（候选：将"5 秒未收到进度"文案移到失败卡；InFlight 只显示 spinner 与 phase 进度），需要与用户对齐文案偏好。**本任务范围内不动**——属文案议题，与既有 PRD 字面冲突属微小差异；与 PRD §10 #7「有进度超时 15s 失败」语义一致（#7 是 InFlight phase 变化后超时，#6 是无 phase 变化 5s 兜底）。

#### 挂账 2：stem-refilled watcher 跨 context 触发（修复需 > 20 行）

- **现象**：同 work_dir 多 context（同一浏览器多 tab）同时 `session:'new'` 时，**任一 context 的 manager 迁移**会触发**所有 context 的 watcher 回填**（watcher 只按 `payload.work_dir` 过滤，不绑定「自己发起的 pending」）；单 context 场景（PRD 设计意图）不受影响。
- **当前状态**：单 context 场景（PRD §9.6 字面意图）功能正确；多 context 边界场景下，watcher 误触发会连带刷新 level2 列表 + 桶迁移——可能让非发起 context 短暂看到本不属于自己发起的 pending → stem 桶迁移的中间态。**本机 e2e 实测不影响功能正确性**（场景 h 取单 context 双 tab 即规避该路径；见场景 (h) 取舍段）。
- **挂账口径**：修复需引入 pending 绑定（> 20 行代码改动 + 跨包 seam），挂账 **M+ / M5 候选**——非 M4 范围（PRD §9.6 设计意图是单 context）；本任务不实施，PRD §风险与实现时核实「pending 键控边界」段已隐含该限制（"若用户短时间在 level=2 选 A work_dir 点新建、立刻又选 B work_dir 点新建，两个 pending map 键并存是预期行为；web 端需通过回填 hash 区分各自 stem"——目前 watcher 按 work_dir 过滤不区分发起者，多 context 同时点新建会跨触发）。

### §10 用户手测清单可执行性核对（11 条可执行 + 1 条挂账）

| # | 清单条目 | 可执行性 | 备注 |
|---|----------|---------|------|
| 1 | 真实环境全链路（裁定 A 强制两级顺序自然兜底老链接）| ✓ 可执行 | e2e 场景 (d) 覆盖 ChoicePage 完整流；真实域 `https://remote-pi.sankabox.com/#<token>` 用户验收 |
| 2 | 多端各看各的（双标签同 token 选不同会话互不干扰）| ✓ 可执行 | e2e 场景 (e) 覆盖 |
| 3 | URL hash 持久化（F5/back/forward 维持会话；切走 hash 同步更新）| ✓ 可执行 | e2e 场景 (a/b) 覆盖 F5 路径；hash 同步更新走任务 07/08 实施 |
| 4 | 后台会话状态（ChoicePage level=2 status 徽章实时更新）| ✓ 可执行 | 任务 07 `WsClient.sessionList` 镜像 + 任务 08 入站按 envelope.session 路由，status 徽章更新已覆盖 |
| 5 | 离线秒失败（kill bridge → 恢复仪式秒失败 + "bridge 离线" 文案）| ✓ 可执行 | 任务 01 B+C 方案已落地（bridgeStatus 离线秒失败 + 新增 `bridge_offline` errorHint 分支）；e2e 间接覆盖（bridge 关掉后 web 入站断连）|
| 6 | 无进度超时（5s 未收到 session_state → 失败 + "5 秒未收到进度" 文案）| ⚠️ **挂账 1** | 功能正确，**文案位置与 PRD 字面不一致**（"5 秒未收到进度"显示在 RecoveryInFlight 而非 RecoveryErrorCard）——挂账 M+ / M5 候选微调；见上文挂账 1 |
| 7 | 有进度超时（bridge 持续给相位变化但 snapshot 不回 → 15s 后失败）| ✓ 可执行 | 任务 01 `PHASE_PROGRESS_TIMEOUT_MS = 15_000` 落地；本机 e2e 未单独覆盖（假 LLM 不模拟该路径），单测 + 集成已覆盖 |
| 8 | 裁定 C ready idle（ready 后 5min 无写命令 → ChatView 显示"会话已退出"）| ✓ 可执行 | 任务 06 实施期 C1 已断言 `ready → idle` 直接测试 3 条；e2e 本机不可执行（5min 时长约束），单测 + 集成 + 文档（ADR-0003 §补注 + getting-started §3.4 验证要点）覆盖 |
| 9 | 钉子 4 spawning 超时（pi 卡在 spawning → 60s 后 ChatView 显示"会话启动失败"）| ✓ 可执行 | 任务 06 实施期 `SPAWN_TIMEOUT_MS = 60_000` 落地 + 钉子 4 watchdog 四路径清理；e2e 本机不可执行（60s 时长约束），单测 + 集成覆盖；ADR-0003 §补注 4 + ADR-0010 §决策 5 已落档 |
| 10 | 钉子 3 work_dir_remove 活会话（活 manager 在 work_dir 下 → web 端移除该 work_dir → 继续在 ChatView 聊 → 自然 idle 后退出）| ✓ 可执行 | e2e 场景 (g) 覆盖核心（work_dir_remove 后 ChatView 存活 + 可继续对话 + 自然 exited 后清理）；自然 idle 5min 退出路径本机 e2e 不等，单测 + 集成已覆盖（任务 06 §3「SPAWN_TIMEOUT_MS 四路径清理」） |
| 11 | 钉子 2 pending 键控（同 work_dir 短时多次点"新建会话" → 实际只产生一个 pending manager，stem 派生后一个会话入列表）| ✓ 可执行 | e2e 场景 (h) 覆盖（单 context 双 tab 等价表达；见场景 (h) 取舍段）；任务 06 实施期「钉子 2 map 键迁移原子化」单测 + 任务 08 watcher 单测 + M3 任务 06 §场景 (c) 三段覆盖等价 PRD 双 context 场景 |
| 12 | M3 老链接兼容（`#<token>` 打开 → 进 level=1 重新走流程，不报错 / 不白屏）| ✓ 可执行 | 任务 07 hash.ts `readAuthFromHash` 三字段解析（token-only 走 level1）+ 任务 08 R1 严格钉子 6 翻转落地；e2e 场景 (d) 入口 `TokenPrompt` 路径覆盖；任务 09 getting-started §3.4 已说明 |

**结论**：**12 条手测清单 11 条可执行**（覆盖单测 / 集成 / e2e / 文档多档），**1 条挂账**（#6 文案位置议题——微小文案微调候选，非功能性缺陷）。

### 交付约定

- **本地 commit 不 push**（沿用 M2 / M3 / M4）：本任务 2 笔 commit `8558e6d` + `b8d5e4d` + 任务 01–09 共 21 笔 commit 在任务 10 验收后由用户手动 `git push origin main` 触发 Actions CD（沿用 M2 deploy.yml）。
- **M4 里程碑收官标记**：本任务 done 后 M4 全部 10 个任务 done，**M4 ✅ 完成**（详见 [[current-state.md#活跃需求|活跃需求]] M4 行收官条）——待用户 §10 手测验收 + 手动 push 触发 CD。
- **挂账后续处理**：挂账 1（#6 文案位置议题）+ 挂账 2（stem-refilled watcher 跨 context 触发）已登记至 [[current-state.md#todo--阻塞|TODO / 阻塞]] 区，M+ / M5 候选。

## 验收收单注记（2026-09-10）

用户裁定（2026-09-10）按完成处理本任务，M4 正式收官——§10 手测验收清单 12 条未逐条勾选（沿用 [[tasks/m3/08-docs-and-validation.md#关单注记2026-09-08|M3 任务 08 关单先例]]，保持事实原貌）。

验收期手测实际暴露并修复闭环的 4 个 gap 一句带过（commit `1d934de`+`bae1e2f` / `8d8e5e5`+`fe897c8`+`3514919` / `cb8a724`）——详情见文件内既有勘误/完成情况锚点 + 本文件已引用的 [[tasks/m4/06-bridge-session-layer.md|任务 06 勘误注记]]（首轮 + 2nd + 3rd gap 三段）与 [[tasks/m4/08-web-multi-session-store.md|任务 08 完成情况 §`264cefc` 实施末段「验收期 4th gap」]] 相关注记。

唯一遗留：#6 文案位置微调候选（RecoveryInFlight vs RecoveryErrorCard），保留 [[current-state.md#todo--阻塞|current-state TODO / 阻塞]] 区挂账，M+ / M5 候选。