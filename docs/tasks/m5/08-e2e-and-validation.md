---
prd: prds/m5-uiux.md
status: done
---
# 任务：e2e 改写（localStorage seeding）+ 移动端新 spec + 全量验证 + 文档收尾

## 目标
按 [[prds/m5-uiux.md|M5 PRD §第二块 G9 + D13]] 收尾验证 + 文档收尾：

1. **e2e helpers 新增 `seedToken(page, token)`**——`tests/e2e/helpers/` 工具函数：
   - `page.goto(origin)` 建立 origin（localStorage 需同源）；
   - `page.evaluate((token) => localStorage.setItem('remotepi.token', token), token)` 写入；
   - 再 `page.goto(targetUrl)` 触发 App 读 localStorage（05 任务 TokenModal required 分支消失 → App 走 hash 决策表）。
2. **8 个既有 spec token 来源改造**——M3 / M4 e2e specs 当前通过 URL hash 注入 token（`#<token>` 形态）——05 任务后该形态已无意义（hash 不再含 token）；改造为 `seedToken(page, token)` + 后续走 hash 注入 `work_dir` / `session`；**主断言不变**（既有用例的预期流不变，只是 token 来源换路）。
3. **新建 `tests/e2e/specs/09-mobile-drawer.spec.ts`**：
   - viewport **375×667**（iPhone SE 尺寸）；
   - ≥5 断言：
     - 无 token → TokenModal 不可关（Esc 键 / 遮罩点击均无效，断言 token-modal 仍在 DOM）；
     - seedToken + 提交连接 → App 走 level1 / level2 流程；
     - 汉堡按钮可见（`sidebar-toggle` 不 hidden）；
     - 抽屉展开 → sidebar-backdrop 可见 + body 滚动锁（`document.body.style.overflow === 'hidden'`）；
     - 抽屉关闭 → 焦点归还到汉堡按钮（`document.activeElement === sidebar-toggle`）。
4. **全量验证（G9 质量门）**：
   - 单测全量 **≥815 预期**（基线 790 + 任务 04–07 新增 ≥25 不回归）；
   - 集成 32 零回归；
   - e2e **9 spec × 2 连跑全绿**（8 既有 + 1 新增 mobile）；
   - typecheck 4 包绿；
   - lint 4 包 0 error；
   - `pnpm -r build` 4 包绿；
   - **build 体积落档**：首屏 entry 增量 ≤ **+30 KB**（基线 253.44 KB → ≤ 283.44 KB raw）+ **Tailwind utilities CSS 增量 ≤ **+30 KB**（基线 16.33 KB → ≤ 46.33 KB）。
5. **雷区零 diff 再核**——grep `useRecoveryGateMap|handleRefill|gateMapRef|RecoveryView` 仅存在 App.tsx；WsClient 流式管线 / stem-refilled watcher / connect 语义 / 五字段判据零字节改动（与第一块收官 + 验收期 gap 修复后的状态完全一致）。
6. **协议 / worker / bridge / shared 零改动再核**——`packages/shared` / `packages/bridge` / `packages/worker` git diff 实证空（沿用第一块交付约定）。
7. **文档收尾**：
   - [[prds/m5-uiux.md|M5 PRD]] §第二块 §修订注记——实施结果 + build 体积 + preflight 视觉差异清单终版；
   - [[tasks/m5/README.md|tasks/m5/README]] 04-08 全部 done；
   - [[tasks/README.md|tasks/README]] M5 节第二块 5 任务 done；
   - [[prds/README.md|prds/README]] M5 条目更新（第二块已实施完成，待手测验收）；
   - [[current-state.md|current-state]] 活跃需求 M5 行收官（第一块 ✅ + 第二块 ✅）+ 测试基线更新（含 build 体积）+ TODO / 阻塞节追加 push 触发手测验收条目 + 最近变更流水 2026-09-12 M5 第二块收官一段式摘要。

## 完成标准
- [x] `tests/e2e/helpers/` 新增 `seedToken(page, token)` 函数（导出 + JSDoc）
- [x] 8 个既有 spec token 来源改造（git diff 显示 hash 形态消失 / localStorage 形态出现）
- [x] `tests/e2e/specs/09-mobile-drawer.spec.ts` 新建且 ≥5 断言（**实测 12 test**）
- [x] 单测 **≥815 全绿**（基线 790 + 新增 ≥25；**实测 web 977**，全仓 1502）
- [x] 集成 32 零回归
- [x] e2e **9 spec × 2 连跑全绿**（两轮各稳定时长 19.2s/19.1s，无 flaky 无重跑）
- [x] typecheck 4 包绿 / lint 0 error / `pnpm -r build` 4 包绿
- [x] **build 体积落档**：首屏 entry 增量 ≤ +30 KB + utilities CSS 增量 ≤ +30 KB（双预算独立测量；**实测 entry 266.98 KB raw / 77.87 KB gzip（+13.54 KB，达标）+ CSS 32.67 KB / 6.92 gzip（+16.34 KB，达标）**）
- [x] 雷区代码零 diff（grep 实证）
- [x] 协议 / worker / bridge / shared 零改动（git diff 实证）
- [x] **文档收尾部分由 archivist 执行**——worker 只负责验证数字部分（单测 / 集成 / e2e / typecheck / lint / build / 体积 + 雷区零 diff 实证），并在任务文件完成情况中标注「文档收尾已交 archivist」。
- [x] commit 不 push（沿用 M2 / M3 / M4 交付约定）

## 依赖
- 依赖 [[tasks/m5/04-tailwind-v4-intro.md|04-tailwind-v4-intro]]
- 依赖 [[tasks/m5/05-token-storage.md|05-token-storage]]
- 依赖 [[tasks/m5/06-app-shell-sidebar.md|06-app-shell-sidebar]]
- 依赖 [[tasks/m5/07-mobile-drawer.md|07-mobile-drawer]]

## 参考
- [[prds/m5-uiux.md|M5 PRD §第二块 G9 / D13 / 验收标准 / 方案 §1-§4]]
- [[tasks/m5/03-e2e-and-validation.md|03-e2e-and-validation]] 验证套路 + 文档收尾风格 + §10 用户手测清单口径
- [[tasks/m5/01-web-markdown-render.md#验收期-gap-注记-2026-09-11-toolresult-归并修复|01 验收期 gap 注记]]（toolResult 归并模式参考）
- [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] e2e 套路 + viewport helper
- [[tasks/m4/10-e2e-and-validation.md|tasks/m4/10]] §10 用户手测清单口径风格（第二块 §10 沿用）

## 完成情况（2026-09-12）

任务完成，2 笔代码 commit 在本任务验收后由用户 push（沿用 M2 / M3 / M4 交付约定）。**本任务含 e2e 改写 + 全量验证 + 移动端新 spec；文档收尾已交 archivist**。

### Commit 链

- `be2d894` feat(web): M5 任务08 —— 移动端 e2e spec 09 + 焦点陷阱互斥 + 全量验证
- `d290be6` chore(web): M5 任务08 polish —— spec 09 断言强化 + 测试计数对账 + 注释校准

### Review 轮次与裁决

本任务 1 轮 review + polish 收尾：

- **Round1**：1W（重复 Escape 监听删除，已落）+ 2S（spec 09 断言强化 / 全量 e2e 跑 2 轮），全部落地。
- **Polish `d290be6`**：spec 09 断言强化（加固 mobile-drawer 边界）+ **测试计数对账**（`967→978` 笔误修正：实际 `963→978(+15)`，两错对消终值正确——详见 [[#测试数字笔误说明|测试数字笔误说明]]）+ 注释校准。

### 关键数字（终验 2026-09-12，d290be6 后）

#### 单测（演进链）

| 节点 | 单测 web | 节点事件 |
|------|----------|---------|
| M4 收官基线 | 236 | M4 10/10 done |
| M5 第一块收官 | 271 | +35 markdown + textarea |
| M5 第一块 gap 修复 | 271 | toolResult 归并（实测 web 不变 271，bridge 372 → 372） |
| 任务 06 后 | 888 | AppShell + Sidebar 等 +98 |
| 任务 07 后 | 963 | useIsMobile / useFocusTrap 等 +75 |
| 任务 08 后 | 978 | spec 09 + 焦点陷阱互斥 +15 |
| 任务 08 polish 后 | **977** | 删 1 条同义反复测试 -1 |

**终值 web 977**（42 文件全绿）。

#### 全仓口径（d290be6 终版）

- **web 单测**：**977**（42 文件全绿）
- **bridge 单测**：**378**（含用户 ADR-0013 +6：5g/5h/5i/5j/5k/5l）
- **shared 单测**：**136**
- **worker 单测**：**11**
- **全仓合计**：**1502**

#### 集成 / e2e / 类型检查 / lint

- **集成**：32/32 零回归
- **e2e**：**9 spec × 2 连跑全绿**（19.2s / 19.1s，含新 09-mobile-drawer 12 test，无 flaky 无重跑）
- **typecheck**：4 包绿
- **lint**：0 error / 5 pre-existing warnings（WsClient.ts no-console）

#### Build 双预算（独立测量）

- **web 首屏 entry**：**266.98 KB raw / 77.87 KB gzip**（vs M4 基线 253.44 → **+13.54 KB**，预算 ≤+30 KB **达标**）
- **web CSS**：**32.67 KB / 6.92 gzip**（vs M4 基线 16.33 → **+16.34 KB**，预算 ≤+30 KB **达标**）
- **markdown 懒 chunk**：**170.57 KB**（不变，沿用 M5 第一块）
- **AssistantMessageBody 懒 chunk**：**2.78 KB**

### 测试数字笔误说明

`be2d894` commit message 写「`967→978(+11)`」是**笔误**——实际 `963→978(+15)`（任务 07 后 963 → 任务 08 后 978 = +15）。两个错（967 起算 -4 + 11 增量 = 967；正确 963 起算 + 15 增量 = 978）对消后**终值正确**。polish `d290be6` 落地时**最终测试基线 978**（后又删 1 条同义反复 → **977**）；终值无差异，仅中间过程笔误。

### 实施要点

#### e2e helpers / spec 改写

- **`seedToken(page, token)` helper**——`page.goto(origin)` 建立 origin → `page.evaluate` 写入 localStorage → `page.goto(targetUrl)` 触发 App 读 localStorage（05 任务编排者提前落地；本任务统一收尾）。
- **8 个既有 spec token 来源改造**——`#<token>` 形态消失 / localStorage seeding 形态出现；主断言不变（流程不变，只是 token 来源换路）。

#### spec 09 新建（移动端）

`tests/e2e/specs/09-mobile-drawer.spec.ts`：

- viewport **375×667**（iPhone SE 尺寸）；
- **12 test**（远超 ≥5 要求）：
  1. required modal 不可关（Esc 键 / 遮罩点击均无效，断言 token-modal 仍在 DOM）；
  2. seedToken + 提交连接 → App 走 level1 / level2 流程；
  3. 汉堡按钮可见（`sidebar-toggle` 不 hidden）；
  4. 抽屉展开 → sidebar-backdrop 可见 + body 滚动锁（`document.body.style.overflow === 'hidden'`）；
  5. 抽屉关闭 → 焦点归还到汉堡按钮（`document.activeElement === sidebar-toggle`）；
  6. Tab 逃逸防护（focus trap）；
  7. inert 机制（收起态 aside inert=true）；
  8. 焦点归还语义；
  9. 全流程（汉堡 → 抽屉 → token modal → 提交 → level1/level2）；
  10. sheet 形态（mobile 全屏）；
  11. 桌面零回归（≥768px 抽屉不展开，汉堡 hidden）；
  12. closable Esc 闭环（TokenModal closable 模式 Esc 关闭）。

#### W1 / W2 遗留落地

- **W1（焦点陷阱互斥）**——开 modal 强制收抽屉（**inert 机制**：收起态 `<aside inert>` + effect 前移 `useFocusTrap`——实施期真踩并修复 inert 顺序 bug）；同时 `useFocusTrap` 在多 trap 容器并存时只有最后启用的生效，关闭后焦点正确归还到开启 trap 时的元素。
- **W2（重复 Escape 监听删除）**——TokenModal closable 模式 + DirectoryBrowser 共用一份 Escape 监听 seamb（07 任务实施期误双注册），本任务删除重复监听 + 钉桩。

### 雷区零 diff 实证

- `grep useRecoveryGateMap|handleRefill|gateMapRef|RecoveryView packages/web/src/` 仍仅命中 App.tsx；
- WsClient 流式管线 / stem-refilled watcher / connect 语义 / 五字段判据 零字节改动；
- `packages/shared` / `packages/bridge` / `packages/worker` git diff 实证空；
- wire 协议零改动（v3 锁版承诺守住）。

### 交付约定

- **本地 commit 不 push**（沿用 M2 / M3 / M4）：本任务 2 笔代码 commit（`be2d894` + `d290be6`）+ 任务 04-07 共 7 笔代码 commit + 任务 05 reviewer 提前落地的 `seedToken` helper（合并计入任务 05 范畴），由用户手动 `git push origin main` 触发 Actions CD。
- **M5 第二块收官标记**：本任务 done → M5 第二块全部 5 个任务 done，**M5 第二块 ✅ 实施收官（2026-09-12）**——待用户 push + 线上手测验收（新形态全量手测：侧边栏双 tab / token 设置弹窗 / 手机抽屉 / 移动全流程）。

### 文档收尾（已交 archivist）

- [[prds/m5-uiux.md|M5 PRD]] §修订注记（2026-09-12 第二块收官）落地——本任务 archivist 收尾执行；
- [[tasks/m5/README.md|tasks/m5/README]] 04-08 全部 done——本任务 archivist 收尾执行；
- [[tasks/README.md|tasks/README]] M5 节第二块 5 任务 done——本任务 archivist 收尾执行；
- [[prds/README.md|prds/README]] M5 条目更新——本任务 archivist 收尾执行；
- [[current-state.md|current-state]] 活跃需求 M5 行收官（第一块 ✅ + 第二块 ✅）+ 测试基线更新（含 build 体积）+ TODO / 阻塞节追加 push 触发手测验收条目 + 最近变更流水 2026-09-12 M5 第二块收官一段式摘要——本任务 archivist 收尾执行。
