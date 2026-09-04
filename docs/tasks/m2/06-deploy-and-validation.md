---
prd: prds/m2-tunnel.md
status: todo
---
# 任务：Terraform Pages 资源 + 三端联调手测验收 + getting-started 更新

## 目标
按 [[prds/m2-tunnel.md|M2 PRD §5 infra]] 新增 Terraform 资源（Pages 项目 + web 子域 CNAME），按 [[prds/m2-tunnel.md|PRD 验收清单]] 全项手测三端（bridge + worker + web）的真实环境闭环，更新 [[getting-started.md]]。这是 M2 的最后一个任务，把 03 / 04 / 05 的代码产物通过部署与手测拉通，并交付用户操作清单。

关键要点：

- `infra/pages.tf`：新增 `cloudflare_pages_project.remotepi_web`（production_branch=main；部署由 `wrangler pages deploy` 执行，不入 TF——TF 只声明项目元数据）
- `infra/dns_web.tf`：新增 `web` CNAME → `remotepi-web.pages.dev`（proxied）；与 M1 的 `dns.tf` 风格一致
- `infra/worker_route.tf`：将 `script` 从 `remotepi-hello` 改为 `remotepi-worker`（用户操作清单的"更新 infra route script 引用后再 apply"对应此处；改与 apply 留到用户本地，本任务仅提交代码）
- 实现时核实（按 PRD 风险段）：
  - `cloudflare_pages_project` 5.x 必填字段（`name` / `production_branch` / `account_id` 等）
  - Pages 自定义域绑定走 TF 资源（`cloudflare_pages_domain`）还是 Dashboard 操作——若必须 Dashboard，README / 当前状态留 TODO
- 部署顺序（用户本地手动执行，PRD 用户操作清单复述）：
  1. CF API Token 补 Pages:Edit 权限
  2. `cd infra && terraform apply`（Pages 项目 + web CNAME）
  3. `pnpm --filter worker run deploy:cf`（`remotepi-worker` 上线，新 worker 先到位）
  4. 更新 `infra/worker_route.tf` 的 `script` 引用 → `terraform apply`（避免域名空窗）
  5. web：`pnpm --filter @remotepi/web build` → `wrangler pages deploy dist --project-name=remotepi-web`
  6. 浏览器验证 `https://web.remote-pi.sankabox.com/#<token>`
- `docs/getting-started.md` 更新：
  - 新增"## 10. M2 三端联调（task 06）"段：本地 wrangler dev + 浏览器 + wscat 的手测脚本（粘 token → StatusBar 在线、PingTester 发 ping、双 tab 同 token 广播、`kill -STOP`/`CONT` bridge 验证 stale/恢复、`wscat` 发畸形帧触发 invalid_envelope / v=2 触发 unsupported_version / 第二 bridge 触发 duplicate_bridge）
  - §3 包 dev 段：补充 bridge 启动 token/URL stdout 输出、web `VITE_WSS_URL` 配置、worker `wrangler dev --port 8787` 默认端口与 `/web` `/bridge` 路径
  - §6 Terraform 段：补充 `pages.tf` / `dns_web.tf` 落地、CF Token 需补 Pages:Edit 权限、Pages 自定义域绑定方式（若需 Dashboard 操作）
- 不自动部署（CI 仍只 fmt/validate；apply 与 wrangler deploy 全部用户本地）

## 完成标准
- [ ] `infra/pages.tf`：`cloudflare_pages_project.remotepi_web`（production_branch=main），参数化一致（API token / account id 走 variable）
- [ ] `infra/dns_web.tf`：`web` CNAME → `remotepi-web.pages.dev`，proxied=true，zone_id 走 `data.cloudflare_zone.main.id`
- [ ] `infra/worker_route.tf`：`script` 字段从 `remotepi-hello` 改为 `remotepi-worker`，与 `worker/wrangler.toml` 对齐
- [ ] 实现时核实产物：在 `docs/current-state.md` 的 TODO 或最近变更中显式记录（a）CF Token Pages:Edit 是否补齐（c）Pages 自定义域绑定走 TF 资源 vs Dashboard
- [ ] `cd infra && terraform fmt -check -recursive` 通过；`terraform init -backend=false && terraform validate` 通过（CI terraform workflow 仍绿）
- [ ] `docs/getting-started.md` 新增 M2 三端联调手测脚本（roadmap 四条 + 心跳判死 + 错误码路径），覆盖 PRD §验收清单全部项目
- [ ] 用户本地 apply + 三端手测通过（roadmap 四条：粘 token → online、PingTester → pong 耗时、双 tab 同收广播、杀 bridge → 5 秒内 offline/reason=closed）；心跳判死 `kill -STOP` → 90s 内 stale；`kill -CONT` → 自动重连 connected；错误码路径 7 项 wscat 验证全通；M1 hello/echo 无残留（grep 验证）
- [ ] `pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` / `pnpm run test` 全绿；`@cloudflare/workers-types` ^5 无 peer 警告
- [ ] 完成后用户本地 commit → 用户手动 push → CI 双绿（terraform + ci workflow）

## 依赖
- 依赖 [[tasks/m2/03-bridge-client.md|03-bridge-client]]（bridge 代码产物）
- 依赖 [[tasks/m2/04-worker-do-room.md|04-worker-do-room]]（worker + DO 代码产物）
- 依赖 [[tasks/m2/05-web-components.md|05-web-components]]（web 代码产物）
- 不依赖 02（shared 测试是 01 / 02 自己的验收；06 仅做三端联调手测）