# Cloudflare provider 5.x 把 DNS 记录资源从 `cloudflare_record` 重命名为
# `cloudflare_dns_record`（同时 4.x 的 `value` 字段在 5.x 改为 `content`）。
# 这里沿用 5.x 的真实资源名 `cloudflare_dns_record`。
#
# 资源说明：
# - name = "remote-pi" + zone = sankabox.com → FQDN = remote-pi.sankabox.com
# - type = "A", content = "192.0.2.1"（RFC 5737 TEST-NET-1 文档保留地址，作占位；
#   worker route pattern=* 接管后该 content 不会被边缘真实查询，保留 RFC 5737 占位
#   （192.0.2.1）作为 proxy bypass 兜底时的安全值）
# - proxied = true → 走 CF 边缘代理（橙云）
# - ttl = 1 → provider 视为 automatic
resource "cloudflare_dns_record" "remote_pi" {
  zone_id = data.cloudflare_zone.main.id
  name    = "remote-pi"
  type    = "A"
  content = "192.0.2.1"
  proxied = true
  ttl     = 1
}
