---
prd: prds/m2-tunnel.md
status: done
---
# 任务：CD（GitHub Actions）+ Worker Static Assets SPA + /healthz + 三端联调手测验收 + getting-started 更新

> **修订（2026-09-05，用户改定部署形态）**：网页合并进主域 `remote-pi.sankabox.com`（Worker Static Assets 托管 SPA），不再独立 `web.` 子域 + Cloudflare Pages 托管。原计划的 `infra/pages.tf` / `infra/dns_web.tf` 已删除（**未 apply，零迁移**）；新增 `.github/workflows/deploy.yml`（CD）+ `worker/wrangler.toml` 的 `[assets]` 配置 + `GET /` 改返 SPA fallback、`/healthz` 走 worker（run_worker_first）。bridge 分享 URL 从 `https://web.remote-pi.sankabox.com/#<token>` 改为 `https://remote-pi.sankabox.com/#<token>`。详细修订注记见 [[prds/m2-tunnel.md#方案|M2 PRD §方案]]；该部署决策沉淀为 [[architecture/decisions/0005-unified-domain-with-worker-static-assets-and-actions-cd.md\|ADR-0005]]。

## 目标
按 [[prds/m2-tunnel.md|M2 PRD §方案]] 落地修订后的部署形态：Worker Static Assets 托管 SPA（合并进主域）+ GitHub Actions 自动部署（CD），按 [[prds/m2-tunnel.md|PRD 验收清单]] 全项手测三端（bridge + worker + web）的真实环境闭环，更新 [[getting-started.md]]。这是 M2 的最后一个任务，把 03 / 04 / 05 的代码产物通过 CD 与手测拉通，并交付用户 Secrets 配置清单。

关键要点：

- **删除**（原计划，作废）：`infra/pages.tf`、`infra/dns_web.tf`——Pages 项目 + `web.` 子域 CNAME 方案作废（TF 文件已删，未曾 apply，零迁移）
- **新增 `.github/workflows/deploy.yml`**：push main 触发，自动 build web → wrangler deploy（Worker + SPA 静态资源）→ terraform apply（route 切换 / 基础设施）；首次顺序：worker 先于 route 切换，编码进 deploy.yml；所需 Secrets 由用户在仓库配置
- **新增 `worker/wrangler.toml` `[assets]` 配置**：Static Assets 指向 `packages/web/dist`；`not_found_handling = "single-page-application"` 实现 SPA fallback；`run_worker_first = ["/web", "/bridge", "/healthz"]` 强制这三条路径先进 Worker 代码（ws upgrade / healthz 探活），其余路径走 asset worker
- **`infra/worker_route.tf`**：将 `script` 从 `remotepi-hello` 改为 `remotepi-worker`（与 `worker/wrangler.toml` 的 `name` 对齐）
- **`worker/src/index.ts`**：`GET /` 改返 web SPA（assets SPA fallback）；`/healthz` 返回 `ok`（ops 探活挪到这里）；`/web` `/bridge` `run_worker_first` 走 worker 路由
- 部署形态：
  - **首选 CD**：`git push origin main` → Actions 自动跑（用户需先配 Secrets，详见完成标准与 [[getting-started.md#10-m2-部署到-cloudflare|getting-started §10]]）
  - **备选本地手动**：`pnpm --filter worker run deploy:cf`（会先 build web）→ `cd infra && terraform apply`
- `docs/getting-started.md` §10「M2 部署到 Cloudflare」整节改写：Secrets 清单 / CD 流程 / 本地手动备选 / 验证清单（`/healthz` 探活 + 网页首页 + bridge 直连生产）；§3.4 share URL 改为 `https://remote-pi.sankabox.com/#<token>`；全文清理 `web.remote-pi.sankabox.com` 与 `wrangler pages deploy` 表述
- bridge shareUrl 默认 base：代码层同步改 `https://remote-pi.sankabox.com`（覆盖 [[tasks/m2/03-bridge-client.md|tasks/03]] 原 `web.remote-pi.sankabox.com` 默认值）

## 完成标准
- [ ] `infra/pages.tf` / `infra/dns_web.tf` 已删除（与代码同步；TF 文件 zero 状态）
- [ ] `.github/workflows/deploy.yml` 落地：push main → checkout + setup-node（22.23.1）/ pnpm（自动读根 `packageManager`）/ cache → `pnpm install --frozen-lockfile` → `pnpm -r build` → `pnpm --filter worker run deploy:cf` → `cd infra && terraform init -backend-config=backend.hcl && terraform apply -auto-approve`；顺序：worker deploy 先于 terraform apply（route 切换后置），避免空窗；使用 GitHub Secrets：`CLOUDFLARE_API_TOKEN` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
- [ ] `worker/wrangler.toml`：name=`remotepi-worker`、新增 `[assets]` 表（`directory = "../packages/web/dist"`、`not_found_handling = "single-page-application"`、`run_worker_first = ["/web", "/bridge", "/healthz"]`）；**不设 `assets.binding`** —— array 形式的 `run_worker_first` 已足以路由三条路径，asset worker 自动处理 SPA fallback，无需 Worker 主动调 `env.ASSETS.fetch()`
- [ ] `worker/src/index.ts`：`GET /` 让位 web SPA（assets fallback）；`/healthz` 返 `ok`；`/web` `/bridge` 升级 → token 鉴权 → DO stub（沿用 [[tasks/m2/04-worker-do-room.md|tasks/04]] 逻辑）
- [ ] `infra/worker_route.tf`：`script` 字段从 `remotepi-hello` 改为 `remotepi-worker`，与 `worker/wrangler.toml` 对齐；apply 后 route 切到新 worker
- [ ] `packages/bridge/src/token.ts` 的 `shareUrl()` 默认 base 从 `https://web.remote-pi.sankabox.com` 改为 `https://remote-pi.sankabox.com`；对应单测断言同步（`shareUrl('abc') === 'https://remote-pi.sankabox.com/#abc'`）
- [ ] `cd infra && terraform fmt -check -recursive` 通过；`terraform init -backend=false && terraform validate` 通过（CI terraform workflow 仍绿；validate 覆盖删除后的资源集）
- [ ] `docs/getting-started.md` §10「M2 部署到 Cloudflare」整节按新形态重写：Secrets 清单（CF token 需 Workers Scripts:Edit + DNS Edit；AWS 凭据供 TF S3 backend）+ CD 流程（`git push` 触发）+ 本地手动备选 + 验证清单（`/healthz` 探活 + 网页首页）+ 旧 `remotepi-hello` 清理备注保留；§3.4 share URL 示例改为 `https://remote-pi.sankabox.com/#<token>`；全文清理 `web.remote-pi.sankabox.com` / `wrangler pages deploy` 表述
- [ ] Actions 首跑需用户配置 Secrets 后才可触发；本任务提交后 `cd infra && terraform apply` 首次把 route 从 `remotepi-hello` 切到 `remotepi-worker`（顺序已编码进 deploy.yml）；完成上述后用户本地 commit → 用户手动 push → Actions 自动跑首轮 CD
- [ ] `pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` / `pnpm run test` 全绿；`@cloudflare/workers-types` ^5 无 peer 警告；`wrangler deploy --dry-run --outdir=dist` 无错
- [ ] 用户本地三端手测通过（roadmap 四条：粘 token → online、PingTester → pong 耗时、双 tab 同收广播、杀 bridge → 5 秒内 offline/reason=closed）；心跳判死 `kill -STOP` → 90s 内 stale；`kill -CONT` → 自动重连 connected；错误码路径 7 项 wscat 验证全通；`curl https://remote-pi.sankabox.com/healthz` 返 `ok`；`https://remote-pi.sankabox.com/` 打开 web SPA；M1 hello/echo 无残留（grep 验证）

## 依赖
- 依赖 [[tasks/m2/03-bridge-client.md|03-bridge-client]]（bridge 代码产物；shareUrl 默认 base 同步改）
- 依赖 [[tasks/m2/04-worker-do-room.md|04-worker-do-room]]（worker + DO 代码产物；`GET /` 与 `/healthz` 行为需在此基础上调整）
- 依赖 [[tasks/m2/05-web-components.md|05-web-components]]（web 代码产物；build 产物由 Worker Static Assets 托管，不再走 Pages）
- 不依赖 02（shared 测试是 01 / 02 自己的验收；06 仅做 CD + 三端联调手测）
