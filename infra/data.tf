# Cloudflare provider 5.x 的 `cloudflare_zone` data source 不再支持顶层
# `name = "..."` 过滤参数（M1 PRD 描述是基于 4.x 写下的）；必须用 `filter` 块。
# 字段语义对齐 5.x 文档：filter.name 按 zone 域名匹配，默认 operator 为 equal。
# match = "all" 要求所有 filter 项同时命中；account.id 防御性约束避免同名 zone
# 跨账户误匹配（API token 跨账户时可能返回多个同名 zone）。
# 注意：filter.account.id 不是 filter.account_id（5.x schema 是嵌套结构）。
data "cloudflare_zone" "main" {
  filter = {
    name = "sankabox.com"
    account = {
      id = var.cloudflare_account_id
    }
    match = "all"
  }
}
