output "origin_domain" {
  description = "Function URL host that each site's reverse proxy forwards to."
  value       = local.origin_domain
}

output "site_key_parameters" {
  description = "SSM SecureString parameter holding each site's origin key."
  value       = { for site, param in aws_ssm_parameter.site_key : site => param.name }
}
