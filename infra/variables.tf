variable "cloudflare_api_token" {
  description = "Cloudflare API token used by Terraform to manage DNS records and worker routes for sankabox.com. Inject via the TF_VAR_cloudflare_api_token environment variable. Minimum scopes: Zone DNS Edit + Account Workers Routes Edit + Account Workers Scripts: Read (creating zones routes 会通过 API 校验 script 是否存在, 因此需要 Read 权限读取 worker 列表). 不要给 Account-level: Workers Scripts: Edit — M1 阶段 worker script 由 wrangler 上传, 不由 TF 管理. NEVER check this value into git."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the zone 'sankabox.com'. Inject via TF_VAR_cloudflare_account_id. Stored alongside token in variables for future use (e.g. account-scoped resources); M1 的 DNS / route 资源仅依赖 zone data source."
  type        = string
}
