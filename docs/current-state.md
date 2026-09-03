# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 活跃需求
- [[roadmap.md]] — 路线图 M1–M4 已定稿（**2026-09-04 用户定稿**：基建 → 通路 → 单 session 闭环 → 多 session 管理）。下一步按里程碑逐个出 [[prds/README.md|PRD]]。
- [[prds/m1-infrastructure.md|M1 PRD]] 已定稿（基础设施基座，2026-09-04 落盘）；任务已拆至 [[tasks/m1/01-monorepo-scaffold.md|tasks/m1/01]] ~ [[tasks/m1/05-github-actions-ci.md|05]]，详见下方任务看板与 [[tasks/README.md|任务索引]]。
- [[architecture/protocol/README.md|architecture/protocol/]] —— RemotePi 隧道协议（envelope / 握手 / token 配对 / 业务消息 / 错误码 / 版本化）的唯一真相源（骨架已立；envelope / 握手 / 版本化小节留待对应里程碑 PRD 填充，M1 阶段保持占位）。

## 任务看板
| Task | 状态 | 备注 |
|------|------|------|
| [[tasks/m1/01-monorepo-scaffold.md\|01 脚手架]] | done | 脚手架+四包空壳+.vscode 四件套；review 通过（修复 prettierignore/shared 双脚本/launch.json 字段/wrangler→4.128+compat 2025-09-01 等 7 项）|
| [[tasks/m1/02-shared-envelope-prototype.md\|02 信封雏形]] | done | Zod envelope + 5 用例全绿；review 通过，修复冗余再导出并裁定命名契约 |
| [[tasks/m1/03-hello-worker.md\|03 hello worker]] | done | 返回文案对齐 + wrangler dev curl 实测 + getting-started/README 落地 |
| [[tasks/m1/04-terraform-cloudflare.md\|04 Terraform CF]] | done | 代码交付 + 无凭据验证（fmt/init -backend=false/validate）全绿；5.x 资源名适配 + 防御性 account filter；apply 待用户凭据（见 getting-started §6） |
| [[tasks/m1/05-github-actions-ci.md\|05 CI 骨架]] | todo | ci.yml + terraform.yml，无 secret（依赖 01；与 04 平行——workflow 需要 infra/ 存在）|

依赖链：01 必须先做；02 依赖 01；03 依赖 01+02；04 依赖 01+03；05 依赖 01+04。

## TODO / 阻塞
- [ ] 用户：凭据就绪后本地执行 `terraform init -backend-config=backend.hcl && plan && apply`（见 [[getting-started.md|getting-started §6]]；apply 前先 `wrangler deploy`，详见 [[getting-started.md|getting-started §5]]）。apply 通过后领取 [[tasks/m1/05-github-actions-ci.md|tasks/m1/05]]（依赖 04 + 01，闭环 CI 骨架）。

## 最近变更
- 2026-09-04（task 03/04 完成 + review 通过） — [[tasks/m1/03-hello-worker.md|03]] / [[tasks/m1/04-terraform-cloudflare.md|04]] 完成并 review 通过：
  - **03 hello worker**：`worker/src/index.ts` 返回文案与 [[getting-started.md|getting-started §3.3]] 描述对齐（`hello from remotepi worker v1`，`PROTOCOL_VERSION=1` 来自 `@remotepi/shared`）；`wrangler dev` 本地起 `http://localhost:8787/`、curl 实测响应一致；`wrangler deploy --dry-run --outdir=dist` 产出 `dist/` 无错；`compatibility_date="2025-09-01"`、`name="remotepi-hello"` 与 [[prds/m1-infrastructure.md#7-terraform-细节|PRD §7]] route 引用对齐。
  - **04 Terraform CF**：`infra/` 全套到位（`versions.tf` / `providers.tf` / `backend.tf` / `variables.tf` / `data.tf` / `dns.tf` / `worker_route.tf` / `outputs.tf` / `backend.hcl.example`）；`terraform fmt -check` / `init -backend=false` / `validate` 三步无凭据全绿；`plan` / `apply` 待用户本地凭据执行（步骤见 [[getting-started.md|getting-started §6]]）。
  - **provider 5.x 适配要点**（同步落 [[prds/m1-infrastructure.md#7-terraform-细节|PRD §7]] 新增行 + [[tasks/m1/04-terraform-cloudflare.md|tasks/04]] 完成标准）：
    - DNS 资源 `cloudflare_record` → `cloudflare_dns_record`（复数化）
    - worker route 资源 `cloudflare_worker_route` → `cloudflare_workers_route`（复数化），字段 `script_name` → `script`
    - `cloudflare_zone` data source 顶层 `name =` 废弃，必须用 `filter = { name = ..., account = { id = ... }, match = ... }` 块结构（`filter.account.id` 嵌套而非 `account_id`）
    - provider 块不再接受 `account_id`（4.x 已删），账户由 API token 隐式解析；防御性 account 约束下放到 `data.cloudflare_zone.main.filter.account.id`（避免同名 zone 跨账户误匹配）
  - **文档落地**：新建 [[getting-started.md]]（本地起步 9 节——前置依赖 / clone / 各包 dev / VS Code 一键启动 / wrangler deploy / Terraform 起步 / 自验 / FAQ / 下一步）+ 仓库根 `README.md` 同步补"起步"段与仓库结构（指向 `getting-started.md` / `roadmap.md` / `current-state.md`）。两个文件覆盖了 PRD §10 验收与 03 / 04 任务的对外输出。
  - **待人项**：apply 需用户凭据（CF token + AWS S3 凭据），见上方 TODO；apply 完成后 [[tasks/m1/05-github-actions-ci.md|tasks/05]] 解锁。
- 2026-09-04（task 02 完成 + review 通过） — [[tasks/m1/02-shared-envelope-prototype.md|02]] 完成并 review 通过：Zod envelope discriminated union（`HelloEnvelope` / `PingEnvelope` / `EchoEnvelope` + `HelloPayload` / `PingPayload` / `EchoPayload`，payload schema 带 `Schema` 后缀位于 `messages.ts`），5 用例（合法 hello 解析 / `v: 2` 拒绝 / 未知 kind 拒绝 / 未知 role 拒绝 / 缺 `id` 拒绝）全绿。review 修复：(a) 移除 `envelope.ts` 对 payload 类型的冗余再导出，统一通过 barrel `export * from './protocol/messages.js'` 暴露，避免两套入口；(b) 命名契约正式裁定——envelope schema+type 同名（`XxxEnvelope`），payload schema 带 `Schema` 后缀（`XxxPayloadSchema`）、类型不带后缀（`XxxPayload`），M2 扩展 kind 沿用（已落 [[prds/m1-infrastructure.md#2-共享包与协议雏形|PRD §2]]）。**顺带修复**：`vitest.workspace.ts` 的 workspace 入口由相对 glob 改为绝对路径（`${repoRoot}packages/*`、`${repoRoot}worker`）——相对 glob 在 `pnpm --filter <pkg> test` 时按调用方 CWD 解析，包目录内运行 vitest 会找不到兄弟包；用 `import.meta.url` 锁住 repoRoot 后从根或包内调用都能解析正确。
- 2026-09-04（task 01 完成 + review） — [[tasks/m1/01-monorepo-scaffold.md|01]] 完成并 review 通过：脚手架（根 package.json / pnpm-workspace / tsconfig.base / eslint flat / prettier / .nvmrc / .gitignore）+ 四包空壳（shared / bridge / web / worker）+ .vscode 调试四件套（launch.json 三配置 / tasks.json 四后台任务 / settings.json / extensions.json）全部落地；review 修复 7 项（prettierignore / shared 双脚本 / launch.json 字段 / wrangler→4.128+compat 2025-09-01 等）。技术备注：(a) `.prettierignore` 保留 `docs/` 与 `pnpm-lock.yaml` / `pnpm-workspace.yaml` 排除——prettier 3.x 默认格式化 md/yaml，全量格式化 docs 待后续单独做后再放开排除；(b) wrangler 升 4.128 后对 `@cloudflare/workers-types` 有 unmet peer 警告（peer `^5`、现装 v4），当前 dry-run / typecheck 全绿，留待 M2 引入真实 worker 逻辑时再对齐版本。
- 2026-09-04（追加 .vscode 调试四件套） — 用户补充需求：M1 范围内追加本地调试/调试任务配置。新增 [[prds/m1-infrastructure.md#11-本地调试与一键启动vscode|PRD §11 本地调试与一键启动（.vscode）]]（含 `tasks.json` 四任务 / `launch.json` 三配置 / `settings.json` / `extensions.json` 完整定义），目录树补 `.vscode/` 条目，§10 用户清单前插第 0 条（可选 VS Code 一键启动），验收标准新增「### 本地调试（.vscode）」一组；同步收紧 [[tasks/m1/01-monorepo-scaffold.md|任务 01]] 完成标准（worker dev:inspector + .vscode 四件套全部用 `${workspaceFolder}`）。
- 2026-09-04（PRD 落盘 + 任务拆分） — [[prds/m1-infrastructure.md|M1 PRD]] 定稿（基础设施基座）；按 PRD 拆 5 个任务 [[tasks/m1/01-monorepo-scaffold.md|01]] / [[tasks/m1/02-shared-envelope-prototype.md|02]] / [[tasks/m1/03-hello-worker.md|03]] / [[tasks/m1/04-terraform-cloudflare.md|04]] / [[tasks/m1/05-github-actions-ci.md|05]]（全 todo），依赖链 01→02→03→04→05。版本锚定按本地实测修正：`pnpm@9.15.0`→`pnpm@10.32.1`、engines `pnpm >=9 <10`→`>=10 <11`、`pnpm/action-setup` `version: 9`→`10`；Terraform `~> 1.10`→`~> 1.15`、`terraform_version: 1.10.x`→`1.15.x`（PRD §7/§8/§9、根 package.json、CI workflows、4/5 任务清单一致）。`docs/architecture/protocol/README.md` 按 PRD 验收要求保持占位不动。
- 2026-09-04（定稿） — 用户定稿路线图：从早先 M0–M5 六段草案改为 **M1–M4 四步走**（基建 → 通路 → 单 session 闭环 → 多 session 管理）；同步更新 [[roadmap.md]] §5 里程碑表与 §6 待决问题（加归属列）；新建 [[architecture/protocol/README.md|architecture/protocol/]] 作为 RemotePi 隧道协议（envelope / 握手 / token 配对 / 业务消息 / 错误码 / 版本化）的唯一真相源；[[architecture/README.md]] / [[architecture/overview.md]] / [[README.md]] 地图补 protocol 入口；扩展 UI 对话框桥接并入 M3。
- 2026-09-04 — 修正 [[roadmap.md]] / [[architecture/overview.md]] 三处事实性错误：§4.2 线路协议改用物理方向（stdin / stdout）表述并校正事件名与 `extension_ui_request` 方法清单；§4.6 SessionManager 包名更正为 `@earendil-works/pi-coding-agent` 并补 `SessionInfo[]` 字段；§2 拓扑图重画为 web—CF—bridge 三段式（bridge 本地 spawn pi 子进程）。
- 2026-09-03 — 初始化文档：新增 [[roadmap.md]]（路线图 + 架构总览 + pi RPC 协议要点 + M0–M5 里程碑 + 待决问题）；新增 [[architecture/decisions/0001-three-component-topology-with-cf-do.md\|ADR-0001]] ~ [[architecture/decisions/0004-extension-ui-dialog-forwarding.md\|ADR-0004]]（关键设计决策）；[[architecture/overview.md]] 替换占位内容为真实系统总览；[[glossary.md]] 补核心术语；[[README.md]] 地图加上路线图入口。