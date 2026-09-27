# contact-api

Centralized contact-form API: one Lambda (Function URL) + DynamoDB rate limits + SES, reached through each site's
CloudFront. README.md covers the design, the `forms.json` schema, reason codes and how a site is connected.

## Commands

- `pnpm test` / `pnpm typecheck` / `pnpm build`
- `pnpm e2e`: safe checks against the **deployed** API. It sends no email and uses no quota. It needs `.env` (see
  `.env.example`); if `.env` is missing, ask the user to create it. Never print or log `CONTACT_SITE_KEY`.
- `pnpm e2e --send`: also does one real submission. That emails the form's recipient and uses 1 of the per-IP daily
  quota (default 3). Only run it when the user asks, or to verify a change to sending, limits or the stamp.

## Deploy

Only GitHub Actions deploys, on push to `main`: Terraform apply, then `pnpm e2e` as a smoke test. Never run
`terraform apply` locally.

## AWS (read-only)

Prefer the `aws-mcp` server's `run_script` tool. It runs as the read-only IAM user `ai-readonly`. The fallback is
the CLI with that user's profile, e.g. `aws --profile readonly --region us-east-1 ...`. Everything is in us-east-1.

| What | Where |
|---|---|
| Lambda | `contact-api` |
| Logs | `/aws/lambda/contact-api`. Each request logs JSON `{outcome, form, site, ip}`. Try `aws logs tail /aws/lambda/contact-api --since 1h --profile readonly --region us-east-1` |
| Rate-limit counters | DynamoDB `contact-api-limits`. Keys are `d#<form>#<ip>#<day>` and `m#<form>#<month>` |
| Config | SSM `/contact-api/*`. Site keys are SecureStrings; don't decrypt them |
| Terraform state | `s3://tf-state-djoz-portfolio/contact-api/terraform.tfstate`. It contains secrets; don't read it |
