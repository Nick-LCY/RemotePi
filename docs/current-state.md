# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 活跃需求
- [[roadmap.md]] — 路线图 M1–M4 已定稿（**2026-09-04 用户定稿**：基建 → 通路 → 单 session 闭环 → 多 session 管理）。下一步按里程碑逐个出 [[prds/README.md|PRD]]。
- [[prds/m1-infrastructure.md|M1 PRD]] 已定稿（基础设施基座，2026-09-04 落盘）；任务已拆至 [[tasks/m1/01-monorepo-scaffold.md|tasks/m1/01]] ~ [[tasks/m1/05-github-actions-ci.md|05]]，详见下方任务看板与 [[tasks/README.md|任务索引]]。
- [[architecture/protocol/README.md|architecture/protocol/]] —— RemotePi 隧道协议（envelope / 握手 / token 配对 / 业务消息 / 错误码 / 版本化）的唯一真相源（骨架已立；envelope / 握手 / 版本化小节留待对应里程碑 PRD 填充，M1 阶段保持占位）。

## 任务看板
| Task | 状态 | 备注 |
|------|------|------|
| [[tasks/m1/01-monorepo-scaffold.md\|01 脚手架]] | todo | 仓库根 package.json + 4 包占位 + 顶层脚本 + .vscode 调试四件套 |
| [[tasks/m1/02-shared-envelope-prototype.md\|02 信封雏形]] | todo | Zod envelope + 三个测试用例（依赖 01）|
| [[tasks/m1/03-hello-worker.md\|03 hello worker]] | todo | wrangler dev 起服务，演示性 import shared（依赖 01→02）|
| [[tasks/m1/04-terraform-cloudflare.md\|04 Terraform CF]] | todo | zone/dns/route + S3 backend（依赖 01；与 03 平行——route 引用 worker 名）|
| [[tasks/m1/05-github-actions-ci.md\|05 CI 骨架]] | todo | ci.yml + terraform.yml，无 secret（依赖 01；与 04 平行——workflow 需要 infra/ 存在）|

依赖链：01 必须先做；02 依赖 01；03 依赖 01+02；04 依赖 01+03；05 依赖 01+04。

## TODO / 阻塞
- [ ] 领取 [[tasks/m1/01-monorepo-scaffold.md|tasks/m1/01]] 开始执行；按依赖链 01→02→03→04→05 推进。

## 最近变更
- 2026-09-04（追加 .vscode 调试四件套） — 用户补充需求：M1 范围内追加本地调试/调试任务配置。新增 [[prds/m1-infrastructure.md#11-本地调试与一键启动vscode|PRD §11 本地调试与一键启动（.vscode）]]（含 `tasks.json` 四任务 / `launch.json` 三配置 / `settings.json` / `extensions.json` 完整定义），目录树补 `.vscode/` 条目，§10 用户清单前插第 0 条（可选 VS Code 一键启动），验收标准新增「### 本地调试（.vscode）」一组；同步收紧 [[tasks/m1/01-monorepo-scaffold.md|任务 01]] 完成标准（worker dev:inspector + .vscode 四件套全部用 `${workspaceFolder}`）。
- 2026-09-04（PRD 落盘 + 任务拆分） — [[prds/m1-infrastructure.md|M1 PRD]] 定稿（基础设施基座）；按 PRD 拆 5 个任务 [[tasks/m1/01-monorepo-scaffold.md|01]] / [[tasks/m1/02-shared-envelope-prototype.md|02]] / [[tasks/m1/03-hello-worker.md|03]] / [[tasks/m1/04-terraform-cloudflare.md|04]] / [[tasks/m1/05-github-actions-ci.md|05]]（全 todo），依赖链 01→02→03→04→05。版本锚定按本地实测修正：`pnpm@9.15.0`→`pnpm@10.32.1`、engines `pnpm >=9 <10`→`>=10 <11`、`pnpm/action-setup` `version: 9`→`10`；Terraform `~> 1.10`→`~> 1.15`、`terraform_version: 1.10.x`→`1.15.x`（PRD §7/§8/§9、根 package.json、CI workflows、4/5 任务清单一致）。`docs/architecture/protocol/README.md` 按 PRD 验收要求保持占位不动。
- 2026-09-04（定稿） — 用户定稿路线图：从早先 M0–M5 六段草案改为 **M1–M4 四步走**（基建 → 通路 → 单 session 闭环 → 多 session 管理）；同步更新 [[roadmap.md]] §5 里程碑表与 §6 待决问题（加归属列）；新建 [[architecture/protocol/README.md|architecture/protocol/]] 作为 RemotePi 隧道协议（envelope / 握手 / token 配对 / 业务消息 / 错误码 / 版本化）的唯一真相源；[[architecture/README.md]] / [[architecture/overview.md]] / [[README.md]] 地图补 protocol 入口；扩展 UI 对话框桥接并入 M3。
- 2026-09-04 — 修正 [[roadmap.md]] / [[architecture/overview.md]] 三处事实性错误：§4.2 线路协议改用物理方向（stdin / stdout）表述并校正事件名与 `extension_ui_request` 方法清单；§4.6 SessionManager 包名更正为 `@earendil-works/pi-coding-agent` 并补 `SessionInfo[]` 字段；§2 拓扑图重画为 web—CF—bridge 三段式（bridge 本地 spawn pi 子进程）。
- 2026-09-03 — 初始化文档：新增 [[roadmap.md]]（路线图 + 架构总览 + pi RPC 协议要点 + M0–M5 里程碑 + 待决问题）；新增 [[architecture/decisions/0001-three-component-topology-with-cf-do.md\|ADR-0001]] ~ [[architecture/decisions/0004-extension-ui-dialog-forwarding.md\|ADR-0004]]（关键设计决策）；[[architecture/overview.md]] 替换占位内容为真实系统总览；[[glossary.md]] 补核心术语；[[README.md]] 地图加上路线图入口。