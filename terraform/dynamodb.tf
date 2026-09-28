# Rate-limit counters. Keys include the UTC day or month; TTL on expiresAt deletes old counters.
resource "aws_dynamodb_table" "limits" {
  name         = "${local.name}-limits"
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
