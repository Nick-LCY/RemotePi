# 需求设计（PRD）

每个需求一个文件，放在本目录下，命名 `<feature>.md`。PRD 是任务拆分的输入。

## PRD 格式

```
# <需求名>

## 背景
为什么做这个。

## 目标
- 要达成什么

## 非目标
- 明确不做什么

## 方案
设计思路、关键决策。

## 验收标准
- [ ] ...
```

## 清单
- [[prds/m1-infrastructure.md|M1 基础设施基座]] — 已定稿（2026-09-04），已完成（2026-09-05 CI 双绿 + 真实环境闭环）；任务已拆至 [[tasks/m1/01-monorepo-scaffold.md|tasks/m1/]]（5 个，按依赖链 01→02→03→04→05 推进，全部 done）。
- [[prds/m2-tunnel.md|M2 通路]] — 已定稿（2026-09-05），已完成（2026-09-05 线上验收通过：主域合并 + Worker Static Assets + CD 自动部署）；任务已拆至 [[tasks/m2/01-shared-envelope-v1.md|tasks/m2/]]（6 个，03/04/05 可并行，01/02 同线，全部 done）。
- [[prds/m3-single-session.md|M3 单 session 闭环]] — 已定稿（2026-09-05），已完成（2026-09-08 用户裁定关单任务 08，13 个任务全部 done）；任务已拆至 [[tasks/m3/01-shared-protocol-v2.md|tasks/m3/]]（13 个，01 根任务，03/04/05 与 06/07 两条并行链，08 文档收尾；09 裁定落盘；10 集成测试基建 + ADR-0008；11/12/13 无头浏览器 E2E + ADR-0009）。
- [[prds/m4-multi-session.md|M4 工作目录与多会话管理]] — 已定稿（2026-09-08）；任务已拆至 [[tasks/m4/01-web-recovery-timeout.md|tasks/m4/]]（10 个，01/02/04 可并行起步，详见 PRD §任务拆分）。
- [[prds/m5-uiux.md|M5 UIUX 优化]] — 已定稿（2026-09-11 用户裁定 D1-D13）；**第一块已实施完成（2026-09-11，3/3 任务 done，5 commits 待 push + 验收期 1 gap 修复 → 单测基线 790），待用户线上手测验收**；**第二块已实施收官（2026-09-12，5/5 任务 done，10 个 web commit + 用户并行 ADR-0013 bridge 修复 → 单测基线 977 / 全仓 1502），待用户 push + 新形态全量手测验收**（侧边栏双 tab / token 设置弹窗 / 手机抽屉 / 移动全流程）。任务已拆至 [[tasks/m5/01-web-markdown-render.md|tasks/m5/]]（8 个：第一块 01 渲染层+分段存储 → 02 textarea（与 01 并行拆分但串行执行）→ 03 验证收尾，均 done；第二块 04 Tailwind v4 → 05 token localStorage → 06 AppShell+Sidebar → 07 移动端抽屉 → 08 e2e+验证+文档收尾，**均 done**）。
- [[prds/m6-visual-rebuild.md|M6 Web UI 全量视觉重做（reference 蓝本）]] — 已定稿（2026-09-22 用户裁定 D1-D12 全部就位）；**2026-09-22 实施收官 11/11 done**（T01-T11 全量验证轮全绿 / 14 个 M6 commit + 3 个 M5 后注释清理 chore = **17 commits** 领先 origin/main 未 push；待用户 push + 端到端验收），任务拆至 [[tasks/m6/01-token-retranslation.md|tasks/m6/]]（01 token 翻译 → 02 CSS 全量迁 → 03 / 04 AppShell + Sidebar + lucide → 05 / 06 / 07 MessageList + TokenModal + DialogHost → 08 / 09 DirectoryBrowser + StatusBar + ChoicePanels + RecoveryView → 10 全量验证 + 文档收尾 → 11 暗色对比度 WCAG AA 校色 + a11y）。**前置 M5 第一块 + 第二块均 2026-09-22 用户口头确认全部完成**（单测基线 977 / 全仓 1502 / 集成 32 / e2e 9 spec × 2）；本轮 **packages/web + docs 增量 / 协议 / worker / bridge / shared 零改动 / testid 锚点零增零删**（唯一差异 = `session-select` 删除，T04 Sidebar 视图重组后由 `session-row` onClick 承担切换，e2e 9 spec 全集无引用）；**build 体积不设硬门槛**（D8 只记录实测值，不设预算；T11 终态对比：web entry 300.07 / 84.86 gzip vs M5 266.98 / 77.87 = **+33.09 / +6.99 KB**，CSS 35.53 / 7.48 vs M5 32.67 / 6.92 = **+2.86 / +0.56 KB**，落在预估 +5~+10 KB 区间内）；兑现 M5 M+ 挂账 (a) Tailwind scanner 22 条精简 / (b) DirectoryBrowser 桌面端 backdrop / (d) HamburgerIcon 双处重复 / (g) 存量 ~1280 行 CSS 全量迁 Tailwind（M6 任务 02 / 04 兑现 (d) + (g)，任务 08 兑现 (b)，任务 02 顺手兑现 (a)）。修订注记（实施期偏差 / z-index 勘误 / M+ 候选 / 遗留）详见 [[prds/m6-visual-rebuild.md#修订注记2026-09-22-t01-t10-实施收官|PRD §修订注记（2026-09-22 T01-T10 实施收官）]] + [[prds/m6-visual-rebuild.md#修订注记2026-09-22-t11-收官|§修订注记（2026-09-22 T11 收官）]]。
