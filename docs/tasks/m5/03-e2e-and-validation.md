---
prd: prds/m5-uiux.md
status: done
---
# 任务：E2E × 2 + 全量验证 + 文档收尾

## 目标
按 [[prds/m5-uiux.md|M5 PRD 验收标准 + D1-D7]] 收尾验证：

1. **全量验证**（G4 质量门）：
   - `pnpm -r typecheck` 4 包全绿；
   - `pnpm -r lint` 4 包 0 error；
   - `pnpm -r build` 4 包全绿；
   - web 单测全量（≥734 全绿）——含 [[tasks/m5/01-web-markdown-render.md|01]] 新增 assistant-message-body ≥25 条 + web-state-bucket 既有 44 条适配新结构 + [[tasks/m5/02-web-input-textarea.md|02]] 新增 use-auto-resize-textarea ≥5 条 + InputBar keyDown ≥3 条;
   - 集成 32 零回归（bridge wire 层零改动）；
   - e2e 8 spec × 2 连跑全绿（既有 8 spec 零修改通过，**重点回归** 01 spec §6 draft textContent 单调性 / 01 spec Step5 + 02 spec History verification 的 `.message-body` textContent 对账 / 03-08 spec 全跑）；
   - **web build ≤ 350 KB** 记录入 [[current-state.md|current-state]]（D1 预算）。
2. **重点回归**：
   - e2e **01 spec §6** draft `textContent` 单调性（折叠 `<details>` 内文本仍计入 `textContent`，**关键边界**）；
   - e2e **01 spec Step5** + **02 spec History verification** 的 `.message-body` `textContent` 对账（终态 markdown 渲染后 `textContent` 应包含原文本，不丢内容）；
   - e2e **03-08 spec** 全跑（InputBar `.fill('input-field')` textarea 兼容 + 余 6 spec 零变化通过）。
3. **文档收尾**：
   - PRD 修订注记：本任务 done 时如有实施期偏离正文的细节，加修订注记（沿用 M4 PRD 风格）；
   - [[current-state.md|current-state]] M5 状态更新——活跃需求 M5 行收官条 + 测试基线（含 build 体积）+ 最近变更流水；
   - 决策 D1-D7 在 PRD 落档核对（PRD 文末「决策记录」段已列 7 条）；本任务负责核对无遗漏。

## 完成标准
- [x] `pnpm -r typecheck` 4 包全绿
- [x] `pnpm -r lint` 4 包 0 error
- [x] `pnpm -r build` 4 包全绿
- [x] web 单测全量（≥734 全绿）——新增 ≥33 条（01 ≥25 + 02 ≥8）
- [x] 集成 32 零回归
- [x] **e2e 8 spec × 2 连跑全绿**——重点回归 01 spec §6 draft textContent 单调性 + 01 Step5 / 02 History verification `.message-body` textContent 对账
- [x] **web build ≤ 350 KB** 记录入 [[current-state.md|current-state]] 测试基线行
- [x] [[current-state.md|current-state]] M5 行更新——活跃需求 M5 完成条 + 测试基线（含 build 体积）+ 最近变更流水（沿用 [[tasks/m4/10-e2e-and-validation.md#验收收单注记2026-09-10|tasks/m4/10 验收收单注记]]风格）
- [x] **PRD 修订注记**：实施期如有偏离正文细节，加修订注记（如 WsClient 字段名细节 / hook 文件路径 / sanitize schema 扩展点）；PRD 文末「决策记录 D1-D7」核对无遗漏
- [x] **§10 用户手测清单口径**（沿用 M4 PRD §10 风格）落地到 PRD 末尾表格，**不勾选**——验收由用户执行
- [x] 沿用 M2 / M3 / M4 交付约定：所有任务（01-03）本地 commit 不 push，本任务 done 后由用户手动 `git push origin main` 触发 Actions CD

## 依赖
- 依赖 [[tasks/m5/01-web-markdown-render.md|01-web-markdown-render]]
- 依赖 [[tasks/m5/02-web-input-textarea.md|02-web-input-textarea]]

## 参考
- [[prds/m5-uiux.md|M5 PRD 验收标准 + D1-D7 + §风险与实现时核实]]
- [[tasks/m4/10-e2e-and-validation.md|tasks/m4/10]] e2e 套路 + §10 用户手测清单口径风格
- [[tasks/m3/08-docs-and-validation.md|tasks/m3/08]] current-state 收尾风格
- [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] e2e 套路

## 完成情况（2026-09-11）

任务完成，**5 笔代码 commit 在本任务验收后由用户 push** 触发 Actions CD（沿用 M2 / M3 / M4 交付约定；详见 [[current-state.md#活跃需求|活跃需求]] M5 行）。本任务**无新 commit**——验证数字与文档收尾即本任务本体。

### Commit 链（5 笔代码 commit，全部本地未 push）

- `926ae9c` feat(web): M5 任务01 —— markdown 渲染 + 流式分段存储 + thinking/tool 折叠
- `1d08230` fix(web): 任务01 review 修复 —— tool args 新引用契约 + markdown chunk 真懒加载 + 判空语义对齐
- `b1041e8` test(web): 任务01 验证轮收尾 —— e2e 懒加载竞态等待 + orphan 引用契约钉桩
- `f28295f` feat(web): M5 任务02 —— InputBar textarea 升级（换行 + 自动增高 + IME 守卫）
- `0594767` fix(web): 任务02 review 收尾 —— 测例去重 + Safari 229 防御 + 契约措辞校准

（`84c13b3` 是更早的 docs commit，不在本轮范围。）

### 关键数字（终验，2026-09-11）

- **单测**：基线 **704** → **765**（+61：assistant-message-body 28 / input-bar-keydown 9 / use-auto-resize-textarea 7 / 既有用例分段结构适配与新增 ~17），30 文件全绿。
- **集成**：32/32 零回归（bridge wire 层零改动，PRD §非目标 worker / bridge / shared 零改动承诺兑现）。
- **e2e**：8 spec × 2 连跑全绿（两轮各 14.5s，无 flaky 无重跑）；01 spec §6 流式 `textContent` 单调性 + 02 spec `History verification`（新增 `waitForAssistantBodiesRendered` 等待 markdown chunk 渲染）重点回归通过——详见 [[tasks/m5/01-web-markdown-render.md#设计注记实施期发现--备查|01 设计注记 2]]。
- **typecheck**：4 包绿（shared / bridge / worker / web）。
- **lint**：0 error / 5 pre-existing warnings（WsClient.ts no-console）。
- **build**：4 包绿（worker Total Upload 160.34 KiB；**web 首屏 entry 250.76 KB raw / 73.37 KB gzip**，较 M4 基线 254.40 KB **-3.64 KB**；懒加载 chunk：markdown 170.57 KB raw / 52.47 KB gzip + AssistantMessageBody 2.47 KB；css 16.33 KB——详见 [[prds/m5-uiux.md#修订注记2026-09-11-第一块收官|PRD §修订注记（2026-09-11）]] D1 预算口径解释）。

### 重点回归

- **01 spec §6 draft `textContent` 单调性**——核心边界：折叠 `<details>` 内文本仍计入 `textContent`（`details` 默认折叠仍计入子节点 `textContent`，**不**因 `open` 属性变化而重置）——M3 / M4 已落地的『typing in details』边界由本轮 M5 review Round1 W1 markdown chunk 懒加载引发的 cold 路径 markdown chunk 未就绪暴露——补 `ChatView` mount 预热带（`import('react-markdown')` fire-and-forget）+ 02 spec `waitForAssistantBodiesRendered` 等待 markdown chunk 渲染完成再断言，单测 + e2e 双层钉桩。
- **01 spec Step5 + 02 spec `History verification`** 的 `.message-body` `textContent` 对账——终态 markdown 渲染后 `textContent` 应包含原文本，不丢内容；`AssistantMessageBody` §4.1 string 路径 `<br>` 拼接与 §4.7 空 text 段空容器 + §4.3 null 空容器钉桩确保 textContent 不丢。
- **03-08 spec 全跑**——InputBar `.fill('input-field')` textarea 兼容（Playwright `.fill()` 跨 input/textarea 一致接口）+ 余 5 spec 零变化通过。

### 文档收尾清单

- [x] **PRD 修订注记**（[[prds/m5-uiux.md#修订注记2026-09-11-第一块收官|2026-09-11 第一块收官]]）：实施结果摘要 + D1 预算口径解释（首屏 entry 250.76 KB raw / 73.37 KB gzip 达标 + 懒 chunk 说明）+ 已接受的视觉微移（Send/Abort 单行态下移 2-4px）+ 两条设计注记（streamingDraftIsEmpty 边界 + 单行态 align-items 切换 M+ 候选）。
- [x] **PRD 验收标准第一块部分勾选**（任务文件完成标准含本任务 9 条全部勾；PRD §验收标准第一块 12 条全勾**除**「用户线上手测验收」保持未勾——待用户 push 后手测，详见 [[prds/m5-uiux.md#§10-用户手测清单口径2026-09-11-第一块收官|PRD §10 用户手测清单口径]]）。
- [x] **PRD 文末「决策记录 D1-D7」核对无遗漏**——7 条决策全部落地实施，未遗漏未新增。
- [x] **PRD §10 用户手测清单口径**（沿用 M4 PRD §10 风格，详见 [[prds/m5-uiux.md#§10-用户手测清单口径2026-09-11-第一块收官|PRD §10]]）——表格落地，**不勾选**——验收由用户执行。
- [x] **current-state 更新**（[[current-state.md|详见]]）——活跃需求 M5 第一块 ✅ 实施收官（2026-09-11，3/3 任务 done，5 commits 待 push）+ TODO / 阻塞节追加 push 触发手测验收条目 + 最近变更流水 2026-09-11 M5 第一块一段式摘要 + 测试基线段 704 → 765 + chunk 表（首屏 250.76 + lazy 170.57/2.47 + css 16.33）。
- [x] **prds/README.md M5 条目更新**（第一块已实施完成待手测验收，第二块待另立批次）。
- [x] **tasks/m5/README.md + tasks/README.md M5 行更新**（3/3 done）。

### 交付约定

- **本地 commit 不 push**（沿用 M2 / M3 / M4）：本任务无新 commit；M5 第一块全部 **5 笔代码 commit**（`926ae9c..0594767`，含任务 01 三笔 + 任务 02 两笔）+ 早期 docs commit `84c13b3`（不属本轮）由用户手动 `git push origin main` 触发 Actions CD（沿用 M4 deploy.yml）。
- **M5 第一块收官标记**：本任务 done 后 M5 第一块全部 3 个任务 done，**M5 第一块 ✅ 实施收官（2026-09-11）**——待用户 push + 线上手测验收。第二块（G5 ChoicePage Sidebar + G6 手机响应式）不在本轮范围，另立批次（roadmap §6 待决问题回收）。
