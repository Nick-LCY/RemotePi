# Cloudflare provider 5.x 把 worker 路由资源从 `cloudflare_worker_route`
# 重命名为 `cloudflare_workers_route`（复数），字段名也从 `script_name` 改为
# `script`（与 wrangler 的 script name 对齐）。
#
# 顺序约束（重要，详见 PRD §7「资源归属」与 M2 PRD §5「部署顺序」）：
#   route 必须指向一个**已存在**的 worker script（即 wrangler 已把
#   `remotepi-worker` 部署到该 CF 账户）。M1/M2 阶段 worker script 由
#   wrangler 上传，不由 TF 管理，避免双写同一资源。
#   M2 部署顺序（用户本地执行，PRD §用户操作清单）：
#     1) pnpm --filter worker run deploy:cf      # wrangler 上传 remotepi-worker
#     2) terraform apply                          # 创建 / 更新 route 指向已存在的 script
#   注意 M1 → M2 改名的部署顺序细节（PRD §5）：先 deploy 新名 worker，再
#   更新 infra route 的 script 引用并 apply，避免域名空窗。
#
# pattern 用 `remote-pi.sankabox.com/*` 匹配所有该子域的请求，转给
# remotepi-worker（worker/wrangler.toml 的 name 已从 M1 的 `remotepi-hello`
# 改为 `remotepi-worker`，见 M2 task 04）。
resource "cloudflare_workers_route" "remote_pi" {
  zone_id = data.cloudflare_zone.main.id
  pattern = "remote-pi.sankabox.com/*"
  script  = "remotepi-worker"
}
