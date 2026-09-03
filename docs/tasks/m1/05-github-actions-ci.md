---
prd: prds/m1-infrastructure.md
status: todo
---
# 任务：GitHub Actions CI 骨架

## 目标
按 PRD §8 加两个 workflow：`.github/workflows/ci.yml` 跑 `pnpm install --frozen-lockfile` + lint + typecheck + test + build；`.github/workflows/terraform.yml` 跑 `terraform fmt -check` + `init -backend=false` + `validate`。两者均 PR/push 触发，无 secret。

## 完成标准
- [ ] `.github/workflows/ci.yml`：`on: [push, pull_request]`；`actions/checkout@v4`；`pnpm/action-setup@v4` with `version: 10`；`actions/setup-node@v4` with `node-version-file: .nvmrc` + `cache: pnpm`；步骤 `pnpm install --frozen-lockfile` → `pnpm run lint` → `pnpm run typecheck` → `pnpm run test` → `pnpm run build`；单 job，ubuntu-latest
- [ ] `.github/workflows/terraform.yml`：`on: [push, pull_request]`；`actions/checkout@v4`；`hashicorp/setup-terraform@v3` with `terraform_version: 1.15.x`；`working-directory: infra`；步骤 `terraform fmt -check -recursive` → `terraform init -backend=false` → `terraform validate`；单 job，ubuntu-latest
- [ ] CI 不引用任何 secret（无 `secrets.*`、无 `TF_VAR_*`）
- [ ] 首推 + 自开 PR 触发两条 workflow 全绿
- [ ] 引入故意 lint 错误时 `ci.yml` 失败、引入 `fmt` 错误时 `terraform.yml` 失败（回归验证）

## 依赖
- 依赖 `01-monorepo-scaffold`（需要 pnpm/lint/typecheck/test/build 脚本都在根 `package.json` 配齐）
- 依赖 `04-terraform-cloudflare`（CI 需要 `infra/` 真实存在且 fmt/validate 能跑通）
