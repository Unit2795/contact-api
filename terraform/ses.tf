# Sender domain identities must already be verified in SES; this stack only references them. The account must be out
# of the SES sandbox: there, SES also checks permission on each recipient's identity, which this policy doesn't grant.
data "aws_sesv2_email_identity" "sender" {
  for_each       = local.sender_domains
  email_identity = each.key
}

locals {
  # A domain's default configuration set must also be allowed for ses:SendEmail.
  ses_send_resources = concat(
    [for identity in data.aws_sesv2_email_identity.sender : identity.arn],
    [
      for identity in data.aws_sesv2_email_identity.sender :
      "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:configuration-set/${identity.configuration_set_name}"
      if try(identity.configuration_set_name, "") != ""
    ],
  )
}
