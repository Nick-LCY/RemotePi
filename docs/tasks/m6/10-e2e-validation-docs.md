---
prd: prds/m6-visual-rebuild.md
status: todo
---
# 任务：全量验证（单测 / 集成 / e2e 9 spec × 2 / typecheck / lint / build / 体积记录）+ 文档收尾

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
