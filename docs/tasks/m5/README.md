# M5 — UIUX 优化轮（任务索引）

> 详见 [[prds/m5-uiux.md|M5 PRD]]。本目录 3 个任务**第一块全部 done**（2026-09-11 实施收官，待用户 push + 线上手测验收）；第二块（侧边栏 + 手机适配）待另立批次（roadmap §6 待决问题回收）。

## 任务列表

- [[tasks/m5/01-web-markdown-render.md|01 — web 渲染层结构化 + markdown 渲染 + thinking/tool 可折叠（含流式分段存储）]] ✅ done（2026-09-11，commits `926ae9c` + `1d08230` + `b1041e8`；**验收期 gap 修复 +2 commit `1fa3b82` + `d9c4409`**——toolResult 归并进 toolCall pill（isError 样式 + orphan 折叠），详见任务 01 [[tasks/m5/01-web-markdown-render.md#验收期-gap-注记-2026-09-11-toolresult-归并修复|§验收期 gap 注记]]）
- [[tasks/m5/02-web-input-textarea.md|02 — InputBar textarea 升级（换行 + 自动增高 + IME 守卫）]] ✅ done（2026-09-11，commits `f28295f` + `0594767`）
- [[tasks/m5/03-e2e-and-validation.md|03 — E2E × 2 + 全量验证 + 文档收尾]] ✅ done（2026-09-11，无新 commit，验证 + 文档收尾即本体）

## 依赖链

- **01** 独立（流式分段存储 + 渲染层结构化 + markdown 渲染）；
- **02** 独立（InputBar textarea 升级，与 01 零代码交集）；
- 01 与 02 **相互独立、串行执行**（避免 styles.css 冲突）—— 实施期先 01 后 02 顺序写盘；
- **03 → 01 / 02**（E2E × 2 连跑 + 全量验证 + 文档收尾）。

## 测试基线（2026-09-11 M5 第一块收官后）

- 单测 **765**（shared 136 + bridge 372 + web **246** + worker 11；M5 第一块 +61：assistant-message-body 28 / input-bar-keydown 9 / use-auto-resize-textarea 7 / 既有用例分段结构适配与新增 ~17）；
- 集成 **32**（零回归）；
- e2e **8 spec × 2 连跑全绿**（两轮各 14.5s，无 flaky 无重跑）；
- web build **首屏 entry 250.76 KB raw / 73.37 KB gzip**（较 M4 基线 254.40 KB -3.64 KB；D1 预算 ≤ 350 KB 按首屏口径达标）；懒加载 chunk：markdown **170.57 KB raw / 52.47 KB gzip** + AssistantMessageBody **2.47 KB**——首屏不加载；css **16.33 KB**。
