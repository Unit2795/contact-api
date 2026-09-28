# Secrets live only in Terraform state (encrypted S3), the Lambda environment and, for site keys, SSM SecureString
# parameters. Never in git.

resource "random_password" "hmac_secret" {
  length  = 64
  special = false
}

# One key per site. The site's CDN injects it as the x-contact-site-key origin header.
resource "random_password" "site_key" {
  for_each = local.sites
  length   = 48
  special  = false
}

# Published for each consuming site's Terraform to read when configuring its CDN origin.
resource "aws_ssm_parameter" "site_key" {
  for_each = local.sites
  name     = "/${local.name}/sites/${each.key}/origin-key"
  type     = "SecureString"
  value    = random_password.site_key[each.key].result
}

resource "aws_ssm_parameter" "origin_domain" {
  name  = "/${local.name}/origin-domain"
  type  = "String"
  value = local.origin_domain
}
