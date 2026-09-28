# Sender domain identities must already be verified in SES; this stack only references them.
# In the SES sandbox, SES also checks the send permission on each recipient's identity. The send policy in lambda.tf covers only the sender domains, so sandbox sends reach only addresses at those domains.
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
