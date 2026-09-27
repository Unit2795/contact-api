# Sender domain identities are verified and owned elsewhere (djoz.us by the portfolio stack); this stack only
# references them. The account has SES production access, so recipients need no verification.
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
