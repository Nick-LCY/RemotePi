---
prd: prds/m3-single-session.md
status: done
---
# 任务：Bridge 复用宿主机 pi agent 目录（去隔离改造）

## 目标
按 2026-09-05 用户裁定，把 M3 原设计中“bridge 托管 pi 使用隔离目录并复制 auth.json”的方案改为：bridge 完整复用宿主机 pi 环境，web 端接管 `work_dir` 最近的会话（含终端里聊的）。代码在 commit `1985fbd` 落地，本任务由编排者事后补录文档。

## 完成标准
- [x] spawn 去注入 `PI_CODING_AGENT_DIR`：子进程继承宿主环境，仍允许用户自设覆盖
- [x] `resolvePiAgentDir()` 语义与 pi `getAgentDir()` 对齐（env 优先 + tilde 展开 + 默认 `~/.pi/agent`）
- [x] session 扫描基准切换到宿主机共享 agent 目录；扫描语义作用于共享池
- [x] auth.json 复制流程废除：缺失时仅 stderr warn，提示 TUI `/login` 或 `*_API_KEY` 环境变量
- [x] 文档：[[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] 落盘；[[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] 双向引用 + 补注；[[prds/m3-single-session.md|M3 PRD]] 修订注记；[[getting-started.md|getting-started §3.5]] 大幅简化
- [x] 测试：双环境密封（共享宿主布局 + 自定义 `PI_CODING_AGENT_DIR`）243 条全绿
- [x] grep 清理：bridge / docs 内 `auth.json` 复制、`PI_CODING_AGENT_DIR=<configDir>/pi-agent` 等历史表述不再出现于用户面向文档

## 完成情况

- **代码变更**：spawn 不再注入 env；`pi-cwd-encoder.ts` / `pi-process.ts` / `index.ts` 接入 `resolvePiAgentDir()`；auth 缺失降级为 stderr warn。两环境密封测试共 243 条全绿。
- **文档变更**：
  - 新建 [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]]：背景 / 决策 / 影响 / 双向引用 / 验证与后续；记录共享池语义、同会话双写、布局局限三项已接受后果；与 [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] / [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] / [[prds/m3-single-session.md|M3 PRD]] 双向引用。
  - [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] 末尾追加“去隔离改造”补注段，并在双向引用节列出 ADR-0007；同时在“相关条目”加入 ADR-0007。
  - [[prds/m3-single-session.md|M3 PRD]] 顶部「修订注记」区追加 2026-09-05 一条：§2.3 / §2.5 / 用户操作清单中关于隔离目录与 auth.json 复制的表述已被 ADR-0007 取代，正文不改。
  - [[getting-started.md|getting-started §3.5]] 大幅简化：`pi` 凭据与 auth.json 段落重写为“无额外配置 + 缺失时 stderr 提示”叙事；保留 `pi auth check` 验证手段与 `PI_CODING_AGENT_DIR` 高级覆盖说明（bridge 透传并对齐扫描）；其余各处残留的隔离目录 / `pi-agent` 字样一并清理。
  - [[current-state.md|current-state]] 任务看板追加本任务行（done，备注一句话）；最近变更置顶新增条目。
- **评审结论**：通过；3 条 Warning 均已修复——(1) §10.3a 测试用 XDG 隔离避免污染宿主 `~/.config/remotepi`；(2) `resolvePiAgentDir` docstring 写明已知局限（仅支持官方默认布局，包级改 `configDir` 名 / fork 改 env 名需用户自设 `PI_CODING_AGENT_DIR` 对齐）；(3) auth 缺失提示加 `*_API_KEY` 环境变量兜底指引。
- **文件清单**：[[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] / [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] 补注 / [[prds/m3-single-session.md|M3 PRD]] 修订注记 / [[getting-started.md|getting-started]] §3.5 与各处清场 / [[current-state.md|current-state]] 看板与最近变更；代码侧 `packages/bridge/src/pi-cwd-encoder.ts` / `packages/bridge/src/pi-process.ts` / `packages/bridge/src/index.ts` 及两份测试文件。

## 依赖

- 依赖 [[tasks/m3/03-bridge-config-file.md|03-bridge-config-file]]（配置全量迁移为去隔离扫清路径）
- 依赖 [[tasks/m3/04-bridge-pi-process.md|04-bridge-pi-process]]（spawn / 扫描 / 状态机为去隔离改造的实施面）