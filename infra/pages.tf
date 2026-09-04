# Cloudflare Pages 项目 — remotepi-web（M2 task 06, PRD §5 infra）
#
# 资源说明：
# - name = "remotepi-web" → CF Pages 分配的副域名 = remotepi-web.pages.dev
#   （项目创建后自动签发；dns_web.tf 的 CNAME 指向这个默认域）
# - production_branch = "main" → 与 worker（仓库同 main 分支）一致；
#   Git 直连模式（Pages → GitHub → 自动部署）下 main 推送触发 production
#   部署；本项目不走 Git 集成（见下），production_branch 仅作元数据保留
# - account_id 引用 var.cloudflare_account_id，与 data.tf 里
#   `filter.account.id = var.cloudflare_account_id` 的归属关系保持一致
#   （Pages 项目与 zone sankabox.com 在同一 CF 账户下）
#
# 5.x provider 必填字段（已通过 `terraform providers schema -json` 核对，
# provider 5.24.0）：account_id / name / production_branch。其余字段均为
# optional + computed，API 会用服务端默认值补全：
#   - build_config：可选；CF 默认 { build_command = "", destination_dir = "" }
#     本项目部署不接 Pages CI（直接 wrangler pages deploy dist），所以
#     build_command 留空 → wrangler 把 dist/ 原样上传，不会触发 Pages
#     端 npm install / build
#   - deployment_configs.{preview, production}：可选；CF 默认 preview /
#     production 两个 environment，无需占位
#   - source：可选；本项目不接 Git 集成（直传 wrangler），留空
# 因此本资源只声明项目元数据（name / production_branch / account_id），
# 实际部署动作（`wrangler pages deploy dist --project-name=remotepi-web`）
# 由部署流水线负责，避免 TF / wrangler 双写同一资源（与 worker 路由的
# "TF 仅指向 script、脚本本体走 wrangler" 模式保持一致）。
#
# 实现时核实（PRD 风险段 / "实现时核实"清单）：
#   - 5.x 必填字段仅 name / production_branch / account_id → 本资源最小集
#     即可，**不需要** placeholder build_config / deployment_configs 块
#   - Pages 自定义域绑定走 TF 资源 `cloudflare_pages_domain` 还是
#     Dashboard 操作？apply 完成后视情况二选一（建议先 TF 跑一遍探
#     schema）；详见 dns_web.tf 注释
#   - CF API Token 需补 Pages:Edit 权限（变量描述已在 variables.tf 更新
#     或在本文件追加说明？本次不动 variables.tf，落地时在 getting-started
#     §6 / §10 写明）
#
# 顺序约束（部署顺序与 M1 阶段 `worker_route.tf` 同构）：
#   1) terraform apply → 创建 Pages 项目元数据
#   2) wrangler pages deploy dist --project-name=remotepi-web → 真实上传
#   3) Pages 项目侧绑定自定义域 web.remote-pi.sankabox.com
#      （走 TF `cloudflare_pages_domain` 还是 Dashboard → 实现时核实）
resource "cloudflare_pages_project" "remotepi_web" {
  account_id        = var.cloudflare_account_id
  name              = "remotepi-web"
  production_branch = "main"
}