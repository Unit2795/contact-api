# Rate-limit counters. Keys embed the UTC day/month; TTL on expiresAt cleans up old counters.
resource "aws_dynamodb_table" "limits" {
  name         = "${var.name}-limits"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}
