---
prd: prds/m4-multi-session.md
status: todo
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
- [ ] `tests/e2e/04-directory-browser.spec.ts`（场景 d）：从 TokenPrompt → ChoicePage level=1 → "浏览添加" → DirectoryBrowser 选 home 下的子目录 → work_dirs 列表新增 → ChoicePage level=2 列该 work_dir 会话
- [ ] `tests/e2e/05-multi-tab-isolated.spec.ts`（场景 e）：双 context 同 token + A 端看 session X + B 端看 session Y + A 发 prompt → B 端 ChatView 不显示该消息
- [ ] `tests/e2e/06-cross-session-dialog.spec.ts`（场景 f）：A 端看 session X、B 端看 session Y + X 触发 select 弹窗 → A 端显示 / B 端后台 dialog 暂存 + 切 B 到 X 后 dialog 恢复 + 倒计时
- [ ] `tests/e2e/07-work-dir-remove-live.spec.ts`（场景 g）：活 manager 在 work_dir 下 spawn + work_dir_remove → 该 manager 仍在 ChatView 可用 + 自然 exited 后 manager 清理
- [ ] `tests/e2e/08-pending-key.spec.ts`（场景 h）：双 context 同一 work_dir 短时多次点"新建会话" → 同一目录仅一个 pending manager + stem 派生后两个 context 都看到新会话入列表
- [ ] 既有场景 (a)(b) retry 容错断言简化（task 12/13 既有代码去除 retry helper 依赖，改为纯等 ChatView；[[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §开放点 1 长期路径落实）
- [ ] 场景 (c) 沿用 M3 task 13 既有断言（双端收起主断言 + `request_expired` observation annotation）
- [ ] 5 条新场景 + 既有 3 条场景（已简化） 全绿，本机专用 `pnpm test:e2e` / CI 跳过
- [ ] **§10 用户手测清单**（12 条）落地到任务文件末尾表格，**不勾选**——验收由用户执行（沿用 [[tasks/m3/08-docs-and-validation.md|tasks/m3/08]] 用户手测交接风格）
- [ ] 既有 e2e 装配（wrangler dev + bridge 子进程 + 真 pi + 假 LLM 进程）零变化（沿用 [[tasks/m3/12-e2e-harness.md|tasks/m3/12]] 既有 helper）

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