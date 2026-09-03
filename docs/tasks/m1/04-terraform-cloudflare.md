---
prd: prds/m1-infrastructure.md
status: done
---
# 任务：Terraform 管理 CF（DNS + worker 路由）

## 目标
按 PRD §7 在 `infra/` 落 Terraform：`data "cloudflare_zone"` 按 name 查 `sankabox.com`、`cloudflare_record` 创建 `remote-pi.sankabox.com` 的 proxied A 占位记录（指向 `192.0.2.1`）、`cloudflare_worker_route` 创建 `remote-pi.sankabox.com/*` 路由指向 `remotepi-hello`。Backend 用 S3 + `use_lockfile = true`（参数化），provider cloudflare `~> 5.0`，required_version `~> 1.15`。本地 `fmt -check` / `init -backend=false` / `validate` / `plan` / `apply` 全跑通。

## 完成标准
- [ ] `infra/versions.tf`：`required_version = "~> 1.15"`
- [ ] `infra/providers.tf`：`cloudflare ~> 5.0`，API token / account id 走 `variable`
- [ ] `infra/variables.tf`：声明 `cloudflare_api_token`（`sensitive = true`）、`cloudflare_account_id`
- [ ] `infra/backend.tf`：`backend "s3" {}` 空块（无明文 bucket/region/key）
- [ ] `infra/data.tf`：`data "cloudflare_zone" "main" { filter = { name = "sankabox.com", account = { id = var.cloudflare_account_id }, match = "all" } }`（5.x 必须用 `filter` 块；顶层 `name =` 已在 4.x 弃用；`filter.account.id` 是嵌套结构而非 `account_id`）
- [ ] `infra/dns.tf`：`cloudflare_dns_record`（5.x 复数化，4.x 是 `cloudflare_record`），name=`remote-pi`，zone_id 用 `data.cloudflare_zone.main.id`，type=`A`，content=`192.0.2.1`，proxied=true，ttl=1（auto）
- [ ] `infra/worker_route.tf`：`cloudflare_workers_route`（5.x 复数化，4.x 是 `cloudflare_worker_route`），pattern=`remote-pi.sankabox.com/*`，`script`=`remotepi-hello`（5.x 字段从 4.x 的 `script_name` 改为 `script`，与 `worker/wrangler.toml` 的 `name` 对齐）
- [ ] `infra/outputs.tf`：输出 `zone_id` 与 `worker_route_id`
- [ ] 提供 `infra/backend.hcl.example`（bucket/region/key/use_lockfile 占位），真实 `backend.hcl` 进 `.gitignore`
- [ ] `docs/getting-started.md` 加 "Terraform 本地起步" 段：复制 `infra/backend.hcl.example` → `infra/backend.hcl` → 填 bucket/region → `terraform init` → `terraform plan`
- [ ] 本地（真实凭据）`terraform fmt -check`、`terraform init`、`terraform validate`、`terraform plan`、`terraform apply` 全跑通；plan 输出含 DNS 记录与 worker route 的创建计划（apply 由用户执行）
- [ ] `terraform fmt -check -recursive` 与 `terraform init -backend=false && terraform validate` 在无凭据环境可执行（CI 集成在 05 任务）

## 依赖
- 依赖 `01-monorepo-scaffold`（需要仓库根 `.gitignore` 与目录结构）
- 依赖 `03-hello-worker`（需要 `remotepi-hello` 这个 wrangler name 已经确定并被部署，否则 route 引用空脚本）
