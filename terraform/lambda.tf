# Run `pnpm build` first; it produces dist/index.cjs.
data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/../dist/index.cjs"
  output_path = "${path.module}/../dist/lambda.zip"
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 14
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "lambda" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }
  statement {
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.limits.arn]
  }
  statement {
    actions   = ["ses:SendEmail"]
    resources = local.ses_send_resources
  }
}

resource "aws_iam_role_policy" "lambda" {
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "aws_lambda_function" "this" {
  function_name    = local.name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = 10

  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = {
      TABLE_NAME  = aws_dynamodb_table.limits.name
      HMAC_SECRET = random_password.hmac_secret.result
      SITE_KEYS   = jsonencode({ for site in local.sites : site => random_password.site_key[site].result })
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

# Public URL; every request must still carry a valid site key injected by a site's proxy.
# With auth NONE the provider adds both required public-invoke permission statements itself.
resource "aws_lambda_function_url" "this" {
  function_name      = aws_lambda_function.this.function_name
  authorization_type = "NONE"
}

locals {
  origin_domain = trimsuffix(trimprefix(aws_lambda_function_url.this.function_url, "https://"), "/")
}
