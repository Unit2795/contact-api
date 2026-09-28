variable "aws_region" {
  description = "Region for the Lambda, table and SES identities."
  type        = string
  default     = "us-east-1"
}

variable "reserved_concurrency" {
  description = "Hard cap on concurrent executions; bounds cost under abuse. The stamp GIF runs on every page view, so keep it above 1."
  type        = number
  default     = 5
}
