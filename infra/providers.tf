provider "cloudflare" {
  # Credentials are injected via TF_VAR_* env vars (see variables.tf).
  # 5.x provider 块不接受 account_id（已从 4.x 移除，账户由 API token 隐式
  # 解析）。cloudflare_account_id 在 data source 的 filter.account.id 上做
  # 防御性约束被消费（避免同名 zone 跨账户误匹配），见 data.tf。
  api_token = var.cloudflare_api_token
}
