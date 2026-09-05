# Terraform S3 backend 参数
# --------------------------
# 本文件**已入库**——只含非敏感字段（bucket / region / key / use_lockfile /
# encrypt）。AWS 凭据**不**在本文件，走标准环境变量：
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
# 或 ~/.aws/credentials（[default] / 自定义 profile）、或 EC2/ECS task role。
# TF_S3 backend 凭据解析顺序：环境变量 > ~/.aws/credentials > task role。
# 这是把 6 个 GitHub Secrets 收敛到 4 个的关键——CLOUDFLARE_API_TOKEN /
# CLOUDFLARE_ACCOUNT_ID / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
# 全部走 Secrets，bucket / region / key 走 git，TF_STATE_* 不再单独存在。
#
# 配合 deploy.yml 的：
#   terraform init -backend-config=backend.hcl
# 即可连上 S3 backend。开发/调试本地的 init 同样用此文件（凭据走
# `aws login` 或本地环境变量）。
#
# ⚠️ 若本文件的 bucket / region / key 在仓库里需要重定位（迁移、staging
# 分支等），改这里并直接 commit 即可——这些字段本身不敏感，但属于部署拓扑
# 元数据，变更应在 PR 里可被 review。

bucket       = "terraform-654654240294-ap-southeast-1-an"
region       = "ap-southeast-1"
key          = "remote-pi/terraform.tfstate"
use_lockfile = true
encrypt      = true
