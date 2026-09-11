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
- [[prds/m5-uiux.md|M5 UIUX 优化]] — 已定稿（2026-09-11 用户裁定 D1-D7）；**第一块已实施完成（2026-09-11，3/3 任务 done，5 commits 待 push），待用户线上手测验收**；第二块（侧边栏 + 手机适配 G5/G6）待另立批次（roadmap §6 待决问题回收）。任务已拆至 [[tasks/m5/01-web-markdown-render.md|tasks/m5/]]（3 个：01 渲染层+分段存储 → 02 textarea（与 01 并行拆分但串行执行）→ 03 验证收尾；均 done）。
