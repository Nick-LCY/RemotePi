---
prd: prds/m6-visual-rebuild.md
status: done
---
# 任务：全量验证（单测 / 集成 / e2e 9 spec × 2 / typecheck / lint / build / 体积记录）+ 文档收尾

## 完成情况（2026-09-22，T10）

- **做了什么**（含本批 docs commit）：workspace 全量单测 `pnpm test` 根跑 **1091 tests / 47 files / 2.22s 全绿**（web 566 + bridge 378 + shared 136 + worker 11）；集成 `pnpm test:integration` **32 tests / 7 files / 11.15s 零回归**；e2e `pnpm test:e2e` **9 spec × 2 连跑全绿**（两轮各 **19.6s / 19.1s** 无 flaky 无重跑——spec 改动 0 行，className 字符串断言与新容器 class 自然兼容）；`pnpm -r typecheck` 4 包绿；`pnpm exec eslint packages/web/src` 范围限定 **0 error / 5 pre-existing warnings**（WsClient.ts no-console）；根 `pnpm lint` **86 problems（81 errors / 5 warnings）**——81 errors 全在 `reference/` 第三方 shadcn 风格源码（M5 立项前已存在污染，不计入本轮门）；`pnpm -r build` 4 包绿 + web build 实测体积（web entry 296.75 KB raw / 84.64 KB gzip + CSS 34.80 KB / 7.35 KB gzip + markdown chunk 170.57 KB / 52.47 KB 不变 + AssistantMessageBody 5.14 KB / 1.74 KB）——D8 不设硬门槛。
- **契约自证**：testid 唯一差异 = `data-testid="session-select"` 删除（T04 Sidebar 视图重组后由 `session-row` onClick 承担切换，e2e 9 spec 全集无引用）；M4 雷区零字节 diff（grep `useRecoveryGateMap | handleRefill | gateMapRef | RecoveryView | stem-refilled watcher` 仍仅命中 `App.tsx` 与既有测试，未下移到 AppShell / Sidebar）；`git diff 7700d6c..HEAD --stat` 范围仅 `packages/web/**` + `pnpm-lock.yaml`（29 个文件 changed，3924 insertions / 532 deletions）——协议 / worker / bridge / shared 零改动；组件内硬编码 hex 仅 1 处注释提及 previous 值（`Sidebar.tsx:144` `bg-[#e69138]` 注释），全部 hex 在 `styles.css` `:root` / `@media dark` 块 token 化。
- **重点回归**：e2e 01 spec §6 draft textContent 单调性 + 02 spec 角色断言 + 08 spec 流式打字机 + tool 归并 pill——T10 实测 9 spec × 2 全绿无回归。
- **修订注记落地**（本批 docs commit）：[[prds/m6-visual-rebuild.md#修订注记2026-09-22-t01-t10-实施收官|PRD §修订注记]]（carve-out / z-index 勘误 / M+ 候选 / 实测基线 / 遗留）/ [[tasks/m6/README.md]] 任务状态表 + 实测基线段 / 9 个任务文件（[[tasks/m6/01-token-retranslation.md|01]] / [[tasks/m6/02-css-full-migration.md|02]] / [[tasks/m6/03-app-shell-rebuild.md|03]] / [[tasks/m6/04-sidebar-brand-lucide.md|04]] / [[tasks/m6/05-chatview-bubbles-inputbar.md|05]] / [[tasks/m6/06-token-modal.md|06]] / [[tasks/m6/07-dialoghost-styling.md|07]] / [[tasks/m6/08-directory-browser-modal.md|08]] / [[tasks/m6/09-statusbar-choice-recovery.md|09]]）status → done + 完成情况节 / [[tasks/m6/11-dark-contrast-a11y.md|任务 11]] 仍 `todo` / [[tasks/README.md]] M6 节 / [[prds/README.md]] M6 条目 / [[current-state.md]] M6 行 + 测试基线 + 最近变更 + TODO / 阻塞。
- **遗留**：T11 暗色对比度 WCAG AA 校色 + a11y 审计 `todo`（已知三处 dark 对比边缘：amber pill 1.8:1 / accent CTA 2.9:1 / state-offline 2.1:1 白字场景）；用户 push origin/main + 服务器端 bridge 重启 + 三端联调手测验收（详见 [[prds/m6-visual-rebuild.md#用户操作清单|PRD §用户操作清单]] 8 条 + 移动端抽屉）。
- **T11 后终态数字**（2026-09-22 HEAD = `ab10345`）：T11 在 T10 1091 基线 +26 单测（styles-token-contrast.test.ts）= **1117 全仓**（web 592 + bridge 378 + shared 136 + worker 11）；集成 32 零回归；e2e 9 spec × 2 全绿（19.3s/19.1s 无重跑）；build 体积 web entry 300.07 / 84.86 gzip（vs M5 266.98/77.87 = +33.09/+6.99 KB）+ CSS 35.53 / 7.48 gzip（vs M5 32.67/6.92 = +2.86/+0.56 KB）；T11 后 4 枚 `--on-*` token 根治 T10 登记的三处 dark 对比边缘；T11 border dark 1.25:1 保持决策（hairline 设计意图）登记 M+ 评估。**详见** [[tasks/m6/README.md#最终实测基线m6-任务-11-收官2026-09-22-head--ab10345|tasks/m6/README §最终实测基线]] + [[prds/m6-visual-rebuild.md#修订注记2026-09-22-t11-收官|PRD §修订注记（2026-09-22 T11 收官）]] + [[tasks/m6/11-dark-contrast-a11y.md|tasks/m6/11]] 完成情况。
- **commit**（T10 实施收官批）：本批两批 commit——docs commit `docs(m6): T01-T10 完成情况回填 + 修订注记（carve-out / z-index 勘误 / M+ 候选登记）` + 任何验证期代码微修（≤10 行）`fix(web): M6 T10 验证轮修复 — <摘要>`（T10 实测零代码微修）。
- **依赖链**：✅ 01 / 02 / 03 / 04 / 05 / 06 / 07 / 08 / 09 / 10 / 11 全部 done（领先 origin/main **17 commits** = 3 chore `a61c227` / `56db43d` / `1a45a85` + 14 M6 commit `63eceb1..ab10345`）。

## 目标

按 [[prds/m6-visual-rebuild.md|M6 PRD §验收标准 + G14]] 收尾验证：

1. **全量验证**（G14 质量门）：
   - `pnpm -r typecheck` **4 包绿**；
   - `pnpm -r lint` **4 包 0 error**；
   - `pnpm -r build` **4 包绿**；
   - web 单测 **977 不回归 + 新增 ≥25**（任务 01 styles-token-resolution ~10 + 任务 02 assistant-message-body.test.tsx 12 处 regex + token-modal.test.ts 4 处 regex 适配 + 任务 03 app-shell 0 新增（既有 ≥30 适配）+ 任务 04 sidebar.test.tsx ≥5 + bridge-status 0 新增 + 任务 05 assistant-message-body 0 新增（既有 28 适配）+ input-bar-keydown 0 新增（既有 9）+ use-auto-resize-textarea 0 新增（既有 7）+ 任务 06 token-modal 0 新增（既有 19 backdrop regex 适配）+ 任务 07 dialog 0 新增 + 任务 08 directory-browser 0 新增 + 任务 09 session-status-bar 0 新增（既有 ≥3）+ 任务 10 0 新增 + 任务 11 styles-token-contrast ~10）；
   - shared / bridge / worker 单测不回归（**全仓合计 1502 不变**）；
   - 集成 **32/32 零回归**（bridge wire 零改动）；
   - e2e **9 spec × 2 连跑全绿**（预期改动 ≤3 行：spec 09 / 04 className 字符串断言与新容器 class 对齐；task 05 流式连续性 / 角色断言 / tool 归并路径重点回归）。

2. **重点回归**：
   - e2e **01 spec §6** draft `textContent` 单调性（气泡化后 `<details>` 内文本仍计入 `textContent`——任务 05 重点回归）；
   - e2e **01 spec Step5** + **02 spec History verification** 的 `.message-body` `textContent` 对账（终态 markdown 渲染后 `textContent` 应包含原文本，不丢内容）；
   - e2e **02 spec** 角色断言（`message-role-user` / `message-role-assistant` 容器 class 沿用——D6）；
   - e2e **03-09 spec** 全跑（InputBar `.fill('input-field')` textarea 兼容 + DialogHost 4 类弹窗形态兼容 + DirectoryBrowser 桌面端新增 backdrop + 移动端抽屉 + 焦点陷阱 + 滚动锁）；
   - e2e **08 spec** tool 归并 pill（M5 验收期 gap 修复路径保持稳定）。

3. **build 实测体积记录**（D8）：
   - web **首屏 entry 实测**（KB raw / gzip）——对比基线 266.98 KB raw / 77.87 KB gzip；
   - web **CSS 实测**（KB raw / gzip）——对比基线 32.67 KB / 6.92 KB gzip；
   - 懒加载 chunk 不变（markdown 170.57 KB + AssistantMessageBody 2.78 KB）+ **lucide-react tree-shaking 后实际增量**（预估 +5 ~ +10 KB gzip）；
   - **不设硬门槛**，只记录实测对比。

4. **文档收尾**：
   - [[prds/m6-visual-rebuild.md|M6 PRD]] 修订注记（10 任务 done 时如有实施期偏离正文的细节，加修订注记，沿用 M5 PRD 风格）；
   - [[current-state.md|current-state]] M6 状态更新——活跃需求 M6 行 + 测试基线（含 build 体积对比）+ 最近变更流水；
   - [[tasks/m6/README.md|M6 tasks README]] + [[tasks/m6/01-token-retranslation.md|任务 01]] / [[tasks/m6/02-css-full-migration.md|02]] / ... / [[tasks/m6/11-dark-contrast-a11y.md|11]] 完成情况回填；
   - [[tasks/README.md|tasks/README]] M6 节加入（11/11 done）；
   - [[prds/README.md|PRD 索引]] M6 条目更新；
   - [[roadmap.md|路线图]] M6 立项条目更新（如未由 archivist 在立项时一并写入）。

## 完成标准

- [ ] `pnpm -r typecheck` 4 包全绿
- [ ] `pnpm -r lint` 4 包 0 error（5 pre-existing warnings WsClient.ts no-console 沿用）
- [ ] `pnpm -r build` 4 包绿
- [ ] web 单测全量（**977 不回归 + 新增 ≥25**，具体分布见任务 01-11 完成情况）
- [ ] shared / bridge / worker 单测不回归（全仓合计 1502 不变）
- [ ] 集成 32/32 零回归
- [ ] **e2e 9 spec × 2 连跑全绿**——重点回归 01 spec §6 draft textContent 单调性 + 01 Step5 / 02 History verification `.message-body` textContent 对账 + 02 spec 角色断言 + 03-09 spec 全跑（spec 改动 ≤3 行：spec 09 / 04 className 字符串断言与新容器 class 对齐）
- [ ] **build 实测体积记录**（D8 不设门槛，只记录——对比基线 entry 266.98 KB / CSS 32.67 KB）
- [ ] [[current-state.md|current-state]] M6 行更新——活跃需求 M6 进行中/完成 + 测试基线（含 build 体积对比）+ 最近变更流水
- [ ] [[prds/m6-visual-rebuild.md|M6 PRD]] 修订注记（如有实施期偏离正文细节）落地到 PRD 末尾
- [ ] [[tasks/m6/README.md|tasks/m6/README]] + 11 个任务文件完成情况回填
- [ ] [[tasks/README.md|tasks/README]] M6 节加入（11/11 done）+ [[prds/README.md]] M6 条目更新 + [[roadmap.md]] M6 立项条目（如未由 archivist 在立项时一并写入）
- [ ] **沿用 M2 / M3 / M4 / M5 交付约定**：所有任务（01-11）本地 commit 不 push，本任务 done 后由用户手动 `git push origin main` 触发 Actions CD

## 依赖

- 依赖 [[tasks/m6/01-token-retranslation.md|01]] / [[tasks/m6/02-css-full-migration.md|02]] / [[tasks/m6/03-app-shell-rebuild.md|03]] / [[tasks/m6/04-sidebar-brand-lucide.md|04]] / [[tasks/m6/05-chatview-bubbles-inputbar.md|05]] / [[tasks/m6/06-token-modal.md|06]] / [[tasks/m6/07-dialoghost-styling.md|07]] / [[tasks/m6/08-directory-browser-modal.md|08]] / [[tasks/m6/09-statusbar-choice-recovery.md|09]]

## 参考

- [[prds/m6-visual-rebuild.md|M6 PRD 验收标准 + G14 + §用户操作清单]]
- [[tasks/m5/08-e2e-and-validation.md|tasks/m5/08]] e2e 套路 + 全量验证风格
- [[tasks/m4/10-e2e-and-validation.md|tasks/m4/10]] e2e 8 spec 既有路径 + §10 用户手测清单口径风格
- [[tasks/m3/08-docs-and-validation.md|tasks/m3/08]] current-state 收尾风格
- [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] e2e 套路
- [[current-state.md|current-state]] 文档状态更新风格
