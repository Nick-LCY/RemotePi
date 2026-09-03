output "zone_id" {
  description = "Identifier of the Cloudflare zone 'sankabox.com' (resolved via data source; never hard-coded)."
  value       = data.cloudflare_zone.main.id
}

output "worker_route_id" {
  description = "Identifier of the Cloudflare worker route attached to remote-pi.sankabox.com/* → remotepi-hello. Reminder: the underlying worker script is deployed via `wrangler deploy`, not by Terraform."
  value       = cloudflare_workers_route.remote_pi.id
}
