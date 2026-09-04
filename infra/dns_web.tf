# web 子域 CNAME → Pages 默认域（PRD §5 infra，M2 task 06）
# 与 dns.tf 的 remote-pi 占位记录风格保持一致（data source 拿 zone_id，
# proxied=true 走 CF 边缘代理）。
#
# 资源说明：
# - name = "web" + zone = sankabox.com → FQDN = web.sankabox.com
#   （PRD §3 web 子域）
# - type = "CNAME" / content = "remotepi-web.pages.dev"
#   → pages.tf 创建的项目 CF 自动签发的默认域（首次 apply 后即可解析）
# - proxied = true → 走 CF 边缘代理（橙云；让 web 端走 CDN 也方便 Pages
#   自定义域校验——CF Pages Custom domains 校验要求目标 CNAME 已 proxied）
# - ttl = 1 → provider 视为 automatic（5.x 行为与 M1 阶段 dns.tf 一致）
#
# 实现时核实（PRD §5 风险段）：
#   - Pages 自定义域 web.sankabox.com 可能还需在 Pages 项目侧绑定
#     （CF Pages → Custom domains → Add domain → web.sankabox.com）。
#     绑定走 TF 资源 `cloudflare_pages_domain`（5.x 提供）还是 Dashboard
#     操作 — 实现时核实。建议 apply 本资源后立刻尝试 TF `cloudflare_pages_domain`：
#     zone_id = data.cloudflare_zone.main.id, account_id = var.cloudflare_account_id,
#     project_name = cloudflare_pages_project.remotepi_web.name, domain = "web.sankabox.com"。
#     若 TF 资源 5.x schema / API 行为有问题，回退 Dashboard 操作并在
#     getting-started §10 + current-state.md TODO 留痕。
#
# 顺序约束：
#   1) terraform apply（含 pages.tf 创建 Pages 项目）→ pages.dev 域签发
#   2) terraform apply（本 dns_web.tf 创建 CNAME）→ web.sankabox.com 解析
#   3) Pages 项目侧绑定自定义域 web.sankabox.com（见上"实现时核实"）
resource "cloudflare_dns_record" "web" {
  zone_id = data.cloudflare_zone.main.id
  name    = "web"
  type    = "CNAME"
  content = "remotepi-web.pages.dev"
  proxied = true
  ttl     = 1
}