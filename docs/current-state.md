# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。
>
> 历史变更流水见 [[archive/recent-changes-2026-09.md|归档：2026-09-08 及更早最近变更]]。

## 活跃需求
- [[roadmap.md|路线图]] — M1–M4 已定稿（2026-09-04 用户定稿）。下一步 **M5+** 待立项（roadmap §6 待决问题回收）。
- **M1 ✅ 完成**（2026-09-05）— 5/5 任务 done：脚手架 + shared 协议雏形 + hello worker + Terraform CF + CI 骨架；CI/CD 双绿 + 真实环境闭环 `curl remote-pi.sankabox.com/` 返回 hello。详见 [[prds/m1-infrastructure.md|M1 PRD]] + [[tasks/m1/01-monorepo-scaffold.md|tasks/m1/01-05]]。
- **M2 ✅ 完成**（2026-09-05 线上验收）— 6/6 任务 done：协议 v1 + shared tests + bridge client + worker+DO + web 组件 + deploy+validation；主域 `remote-pi.sankabox.com` 上线 + Actions CD 跑通 + 用户手测验收通过。详见 [[prds/m2-tunnel.md|M2 PRD]] + [[tasks/m2/01-shared-envelope-v1.md|tasks/m2/01-06]]。
- **M3 ✅ 完成**（2026-09-08）— 13/13 任务 done：单 session 闭环（bridge 接 pi 子进程 + web 聊天 + 4 类阻塞弹窗 + 状态恢复 + 集成测试基建）；用户裁定 2026-09-08 关单任务 08（4 类弹窗 wire 层由 [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]] 自动化覆盖 + web UI 手测项随裁定一并关闭）。详见 [[prds/m3-single-session.md|M3 PRD]] + [[tasks/m3/01-shared-protocol-v2.md|tasks/m3/01-13]] + 任务 08 关单注记 [[tasks/m3/08-docs-and-validation.md#关单注记2026-09-08|相关段落]]。
- **M4 ✅ 完成**（2026-09-08，10/10 任务 done；验收期 4 gap 修复链归档 2026-09-09；§10 手测验收收单 2026-09-10 用户裁定）— 并行多 session + 目录浏览 + 入口选择页 + 恢复仪式 5s 修复 + URL hash 三字段全集 + SessionBucket 按 session 分桶 + 跨会话 blocked_on 隔离 + 8 场景 e2e 全闭环。**§10 手测验收已收单（2026-09-10 用户裁定）**——验收期手测实测暴露的 4 个 gap（1st session_list 字段占位 / 2nd firstMessage 字节窗口 / 3rd sessionJsonlPath 丢字段 / 4th 流式打字机丢失）已全部修复闭环；12 条清单未逐条勾选，保持事实原貌；#6 文案位置微调候选保留在 TODO（清单见 [[prds/m4-multi-session.md#§10-用户手测清单口径|M4 PRD §10]]）。详见 [[prds/m4-multi-session.md|M4 PRD]] + [[tasks/m4/01-web-recovery-timeout.md|tasks/m4/01-10]]。
- [[architecture/protocol/README.md|architecture/protocol/]] —— RemotePi 隧道协议唯一真相源；**v3 锁版**（2026-09-08）：control 13 type / envelope (a) 5 字段 / session 字段启用规则 / pending 键控 / SPAWN_TIMEOUT_MS 60s。破锁依据见 [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010]] + [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]]。

## 任务看板
任务明细见 [[tasks/README.md|任务索引]]。汇总（34/34 done）：

| 里程碑 | 任务 | 主题 | 状态 |
|--------|------|------|------|
| **M1** | [[tasks/m1/01-monorepo-scaffold.md\|01-05]] | 脚手架 / shared 协议雏形 / hello worker / Terraform CF / CI 骨架 | done（5/5） |
| **M2** | [[tasks/m2/01-shared-envelope-v1.md\|01-06]] | 协议 v1 + shared tests + bridge + worker+DO + web 组件 + deploy+validation | done（6/6） |
| **M3** | [[tasks/m3/01-shared-protocol-v2.md\|01-13]] | 协议 v2 + shared tests + bridge config/pi/popup + web chat/recovery/docs+validation + 去隔离改造 + 集成基建 + testid + e2e harness + e2e scenarios | done（13/13） |
| **M4** | [[tasks/m4/01-web-recovery-timeout.md\|01-10]] | 5s 修复 + 协议 v3 + shared tests + state.json + list_directories + session-layer + ChoicePage + SessionBucket 分桶 + docs-sync + e2e+validation | done（10/10） |

> **测试基线（2026-09-10 验收期后 A' 修补后）**：单测 **691**（shared 136 + bridge **370** + web 185，worker 无测试；bridge 367 → 370 = A' 修补 +3 条 5b/5c/5d）/ 集成 32 / e2e 8 spec 全绿；web build 254.40 KB；M4 全部 commit `fd3981f` 已 push `origin/main`（验收期 4 gap 修复链 16 笔 commit 全部入库）。A' 修补工作区未提交（与代码改动同 commit，待 docs 与代码一并 commit）。

## TODO / 阻塞
- [ ]（暂缓，用户裁定）可选加固：remotepi-worker 关闭 `workers_dev=false`；清理 `/usr/local/bin/remote-pi-bridge` 旧二进制
- [ ] 修复 `pnpm dev` 启动方式下 bridge 偶发僵尸（tsx watch 对脚本崩溃不重启、栈被吞）；候选：换 `node --watch` / 外层监督重启 / 根因排查顶层异常
- [ ]（暂缓，用户裁定 2026-09-05）bridge 配置迁移后将来重新加回 CLI 参数与环境变量支持（M3 仅保留 `--config`）
- [ ] **可选 e2e 场景挂账（ADR-0009）** — (d) abort / (e) idle kill 与 bridge 重启自愈 / (f) PRD §4.5 命令失败 UX / (g) 4 类弹窗逐一交互；当前 (g) 部分覆盖（confirm + select 已覆盖，input / editor 欠）。**注意**：本条与 M4 任务 [[tasks/m4/10-e2e-and-validation.md|10]] 场景 (d)-(h) **编号撞名但含义不同**（本条指 ADR-0009 §可选场景；M4 任务 10 指 M4 新增 5 场景）。详见 [[architecture/decisions/0009-headless-browser-e2e.md#3-场景范围-mvp-三场景--可选后续|ADR-0009 §3 可选场景]]。
- [ ] **M4 验收期挂账**（2026-09-09，全部 M+ / M5 候选）——
  - (a) #6 文案位置议题（`App.tsx:526` RecoveryInFlight "5 秒未收到进度" 文案 vs PRD §10 字面 "失败文案" 位置边界微调）— 详见 [[tasks/m4/10-e2e-and-validation.md#完成情况|任务 10 完成情况 §挂账 1]]；
  - (b) stem-refilled watcher 跨 context 触发（同 work_dir 多 context 同时 `session:'new'` 时 watcher 无 pending 绑定跨触发；单 context 设计意图不受影响；修复需 > 20 行引入 pending 绑定）— 详见 [[tasks/m4/10-e2e-and-validation.md#完成情况|任务 10 完成情况 §挂账 2]]；
  - (c) e2e harness 每 spec 共享 agent-dir（race 源头）+ `tests/integration/.tmp/` 已积 118 目录 8.4MB / `tests/e2e/.tmp` 412KB；根治 = 每 spec 独立 agent-dir 隔离 + `.tmp` 轮转策略 — 详见 [[tasks/m4/06-bridge-session-layer.md#勘误注记2026-09-09验收期-3rd-gapsessionjsonlpath-丢失--派生绑错-race3-commit-链|任务 06 勘误注记（3rd gap）]] §第 2 层根因 ①；
  - (d) `session_list` 全 work_dir 扫描无缓存（O(file-size) + `SESSION_LIST_TIMEOUT_MS = 5_000` 看门狗保护；常规规模余量充足，**潜在地雷：极端不带 work_dir 路径实测 199 文件 / 939.5MB ≈ 9.4s 同步阻塞**——当前 web 总是带 work_dir 不触发，任何 CLI/第三方不带 work_dir 都会踩；后续按需加载 / mtime-keyed 缓存 / 摘要落盘）— 详见 [[tasks/m4/06-bridge-session-layer.md#勘误注记2026-09-09验收期|任务 06 勘误注记]] §边界决策表；
  - (e) W2 deferred listener 加 session 过滤（防极端并发 pending 误触发，加固级非必修，与 (b) 互为路径）+ **S6 e2e 轮询改 `MutationObserver`（部分解决）**——主断言已用 MutationObserver（`01-first-turn.spec.ts:204` 流式连续性），残留 `spec:248-265` 终态等待仍 `setTimeout` 轮询 — 详见 [[tasks/m4/08-web-multi-session-store.md#264cefc-实施sessionbucket-分桶--路由--per-session-视图全量|任务 08 完成情况 §`264cefc` 实施末段]] W2 + S6。

## 最近变更
> 完整变更流水见 [[archive/recent-changes-2026-09.md|归档：2026-09-08 及更早最近变更]]。本节仅留验收期活动变更（2026-09-10 bridge A' 修补 + 2026-09-09 3rd gap + 4th gap）。

- 2026-09-10（M4 验收期后修补 — 方案 A' 移除 bridge 主动 ping、改接收侧 read-idle 判死，决策依据 [[architecture/decisions/0011-bridge-receiver-side-read-idle-deadlock.md|ADR-0011]]）— **根因一句**：旧实现 bridge 主动发 `control/ping` → DO `forwardToOpposite`（worker `room.ts:472-483`）转发 → 网页离线时纯 no-op 静默丢弃 → bridge 30s×3 判死 → 断开 → 退避重连成功后再次同样链路 → **无限退避重连循环**；违背应用模型（bridge 常驻工人 / web 随上随下遥控器，bridge 不应把 web 死活当自己的健康信号）。**修复**：A' 方案——bridge 不再主动发 ping；改走滑动窗口 read-idle 判死（每收到任何解析成功的 inbound envelope 刷新 `IDLE_TIMEOUT_MS = 90_000` 计时器；超时 → warn + `ws.close(1000, 'idle timeout')` → 现有 `handleClose` 退避重连路径）；`pongTimeoutMs` 选项改名 `idleTimeoutMs`、删 `pingIntervalMs` / `pongTimeoutsBeforeDead`；**wire 协议不变**（ping/pong 帧结构、DO 心跳 20s/30s/3 全不变；worker / web 零改动；DO 对旧版 bridge 完全兼容）。备选 B「DO 对 bridge 的 ping 代答」被否（需破「中间层原样转发」语义走新 ADR 且改动面在 worker）。**数字**：bridge 单测 **688 → 691**（+3：5b/5c/5d）/ 集成 32/32 零回归 / e2e 8/8 零回归 / lint 0 error（5 warnings 为 web WsClient pre-existing）/ typecheck 4/4 / `pnpm -r build` 绿；review **0 Critical / 0 blocking Warning / 5 Suggestions**（含 docs grep `IDLE_TIMEOUT_MS` 同名辨析提醒 + safeParse 后才刷新 idle 的语义注记——「服务器狂发坏帧本身即病态信号」当前实现为有意选择，已由 ADR-0011 §决策.3 + [[architecture/protocol/control.md#配套常量|control.md §配套常量]]同名辨析段同步回应）。**用户行动**：本地跑旧版 bridge 的实例需择机重启（`systemctl restart remotepi-bridge` 或手动重启 bridge 进程）才生效；重启后行为自动切到接收侧 read-idle，旧版 5min 内连续触发旧 30s×3 判死 → 无限退避重连循环的缺陷随重启一并消失。文档同步落地：[[architecture/protocol/control.md|control.md]] §2 / §3 / §配套常量 / 新增 §9 接收侧 read-idle 判死节 + 顶部修订注记；[[prds/m3-single-session.md|M3 PRD §2.1]] line 181 现役常量更新为 `IDLE_TIMEOUT_MS`（PING_INTERVAL_MS 已随 A' 移除；PONG_TIMEOUT_MS 已随 A' 改名为 IDLE_TIMEOUT_MS） + 引用 ADR-0011。详见 ADR-0011。
- 2026-09-09（M4 验收期 4th gap 修复 — "流式打字机丢失"缺陷，commit `cb8a724`）— **根因**：3rd gap 修复 (`3514919` 快照法) 让 `pending → <stem>` 迁移稳定成功后，stem 回填时机前移到 turn 开头，首次暴露 `gateForSession(<stem>)` store miss → 触发恢复仪式 → `ChatView` 卸载 → 流式 delta 无人渲染。**修复四点**：① watcher 增 `onRefill` seam + 'new' 桶 ready gate 移交到 `<stem>`；② `sendSessionList` 推迟到 `agent_settled` 或 3s debounce；③ `useWsState` useCallback memoization 冻结首帧 selector 修复；④ e2e (a) 补流式连续性断言（chat-view 持续可见 + recovery-in-flight 从未出现）。**数字**：单测 674 → **688**（+14）/ 集成 32 零回归 / e2e 8/8 全绿 × 2 / web build 253.62 → **254.40 KB**（+0.78 KB）；review 0C / 4W 加固级（已登记 TODO (e)）/ 6S 不本轮修。**教训**：修 bug 会移动时序 → 时序变化暴露被掩盖的下一个缺口；工程流程层对策（任何"原本未触发"的流程路径一旦首次激活必须强制做完整链路回归）挂账 M+ 候选。详见 [[tasks/m4/08-web-multi-session-store.md#264cefc-实施sessionbucket-分桶--路由--per-session-视图全量|任务 08 完成情况 §`264cefc` 实施末段 "验收期 4th gap（2026-09-09 落档）"]]。
- 2026-09-09（M4 验收期 3rd gap 修复链 — "点任意会话都进最新会话"缺陷，3 commit `8d8e5e5` + `fe897c8` + `3514919`）— **三层根因 + 三层修复链**：(1) `8d8e5e5` 类型层丢字段——`sessionJsonlPath` 三态贯通（`undefined`=M3 取最新 / `null`=全新 / `string`=精确恢复）；(2) `fe897c8` e2e 回归三根因——共享 agent dir 下派生按 mtime 绑错 + watcher 过期 `_currentSessionKey` 双 manager + 派生前 `session_list{session:'new'}` 回执复活空桶；(3) `3514919` 派生过滤改**文件名快照法**（首 spawn 前 `readdir` 快照，派生排除快照内文件——免疫 mtime 粒度 / 时钟源 / 并发活跃会话）+ `migratePendingBucket` 五字段判据（`messages` / `queue` / `streamingDraft` / `sessionPhase` / `blockedOn` 任一非空即不整桶覆盖）+ warn 5s 节流 + 8 条回归钉桩经 `stash` 验证旧实现必红。**数字**：单测 659 → 674（+15）/ 集成 32 零回归 / e2e 8/8 全绿 × 2 / web build 252.91 → 253.62 KB（+0.71 KB）。**`fe897c8` commit message 失实以代码为准**——声称改 result handler 空桶创建，实际代码未改，由 `3514919` 五字段判据重写收口。**教训一句**：类型层缺字段使"丢弃"编译合法 / 测试 seam 不捕获 spawn argv / 修复合入时 e2e 红灯不许以"非回归"定性带过（本轮 `fe897c8` 首版 5/8 红即此因）。详见 [[tasks/m4/06-bridge-session-layer.md#勘误注记2026-09-09验收期-3rd-gapsessionjsonlpath-丢失--派生绑错-race3-commit-链|任务 06 勘误注记（3rd gap）]] + [[tasks/m4/08-web-multi-session-store.md#264cefc-实施sessionbucket-分桶--路由--per-session-视图全量|任务 08 完成情况 §`264cefc` 实施末段 "时序语义固化"]]。

## 依赖链
- M1–M4 全 done（5 + 6 + 13 + 10 = 34 任务全部落地）。
- M4 内部依赖史见 [[prds/m4-multi-session.md|M4 PRD §任务拆分]]；M3 内部依赖史见 [[prds/m3-single-session.md|M3 PRD §任务拆分]]；M2 / M1 同理。
- **下一步 M5+**（roadmap §6 待决问题回收）——M4 任务 2026-09-08 全 done、§10 手测验收 2026-09-10 用户裁定收单，至此正式收官，M5+ 视情况立项。
