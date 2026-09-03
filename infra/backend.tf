# Terraform backend 配置：
# - backend 块留空（bucket / region / key / use_lockfile 等参数不在源码里）
# - 真实参数通过 `terraform init -backend-config=backend.hcl` 注入
# - backend.hcl 已被 .gitignore 排除（避免 state bucket 信息泄露）
# - use_lockfile = true 启用 S3 原生 state 锁（Terraform ≥ 1.10），无需 DynamoDB
#
# 示例文件：infra/backend.hcl.example（已提交进 git，供本地首次复制）
# 用户侧命令：cp infra/backend.hcl.example infra/backend.hcl && terraform init -backend-config=backend.hcl
terraform {
  backend "s3" {}
}
