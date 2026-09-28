# Deploy

## Links

[Return to README](../README.md) | [Connect a site](connect.md) | [Config reference](config.md)

## Overview

This guide deploys your own instance of the API. Once it is running, [connect a site](connect.md).

You don't fork this repo. You create a small **private** config repo that holds your `forms.json` and `state.config` and runs this repo's GitHub Action ([`action.yml`](../action.yml)) at a pinned release tag. Your sites, addresses and deploy logs stay private, and a new version only reaches your deployment when you bump the tag.

> 💡 Note: You can run one deployment per AWS account. Resource names are fixed, the IAM role name `contact-api` is account-wide, and the smoke test reads SSM parameters under `/contact-api/`.

## What gets created

| Resource | Name | Notes |
| --- | --- | --- |
| Lambda function | `contact-api` | Node.js 24, arm64, 256 MB, 10 s timeout. Reserves 5 concurrent executions, which caps cost under abuse. |
| Lambda Function URL | | Public (auth `NONE`). Requests without a valid site key get `403`. |
| IAM role | `contact-api` | Lets the function write its logs, update the limits table and send from the sender domains. |
| DynamoDB table | `contact-api-limits` | On-demand billing. Rate-limit counters, removed by TTL on `expiresAt`. |
| CloudWatch log group | `/aws/lambda/contact-api` | 14-day retention. |
| SSM parameter (String) | `/contact-api/origin-domain` | The Function URL host. |
| SSM parameter (SecureString) | `/contact-api/sites/<site>/origin-key` | One per site in `forms.json`. |
| Generated secrets | | An HMAC secret that signs stamp cookies, and one site key per site. They are stored in Terraform state and the Lambda environment; site keys are also stored in SSM. |

Every resource is tagged `Project = contact-api`. The stack does **not** create the SES identity, the state bucket, the GitHub OIDC provider or the deploy role; you set those up below.

## Prerequisites

- **AWS account.** Everything goes in `us-east-1` unless you set the action's `aws-region` input.
- **SES:** a verified **domain** identity for your sender address, in the deploy region, ideally with DKIM enabled. See [Creating a domain identity](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html).
  - New accounts start in the SES sandbox. [Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) before the first send. In the sandbox, SES also checks the function's permission on each recipient's identity, which this stack doesn't grant, so every send fails with `server_error`.
- **State bucket:** a private S3 bucket for Terraform state. The state holds the generated secrets. Enabling versioning is recommended.
- **GitHub OIDC provider:** the account needs the `token.actions.githubusercontent.com` identity provider, with audience `sts.amazonaws.com`. See [Configuring OpenID Connect in AWS](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services).
- **Deploy role:** an IAM role trusted only by your config repo's `main` branch. See [Deploy role](#deploy-role).
- **Lambda concurrency:** AWS always keeps 100 concurrent executions unreserved, so reserving 5 needs an account "Concurrent executions" quota of at least 105. New accounts can start with a lower quota, which AWS raises over time. If the first deploy fails with an error about unreserved concurrency, request a higher quota in Service Quotas.
- **Runner:** the action uses `jq` and the AWS CLI. GitHub's `ubuntu-latest` runners have both.
- **Local tools,** only for [rotating secrets](#rotating-secrets) or [removing a deployment](#removing-a-deployment): Node.js 24 or newer, pnpm (`package.json` pins the version) and Terraform 1.10 or newer.

### Deploy role

Trust the GitHub OIDC provider, and set the `token.actions.githubusercontent.com:sub` condition to your config repo's `main` branch. GitHub uses two formats:

- `repo:<owner>@<owner-id>/<config-repo>@<repo-id>:ref:refs/heads/main` for repositories created after 15 July 2026, and for older ones that were renamed, transferred or opted in since. Get the two ids with `gh api repos/<owner>/<config-repo> --jq '.owner.id, .id'`.
- `repo:<owner>/<config-repo>:ref:refs/heads/main` for other older repositories.

If the role can't be assumed, try the other format. See GitHub's [OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).

The role needs these permissions:

| Service | Access |
| --- | --- |
| S3 | The state bucket: list, plus get/put/delete on the state key's prefix (includes the `.tflock` lockfile) |
| Lambda | Manage function `contact-api`, its URL, concurrency and permissions |
| IAM | Manage role `contact-api` and its inline policy; `iam:PassRole` on it |
| DynamoDB | Manage table `contact-api-limits`, including TTL and tags |
| SSM | Manage parameters under `/contact-api/*` |
| CloudWatch Logs | Manage log group `/aws/lambda/contact-api` |
| SES | `ses:GetEmailIdentity` on the sender domains |
| STS | `sts:GetCallerIdentity` |

## Deploy steps

#### 1. Create the config repo

Create a **private** GitHub repo with these files:

```
forms.json                    # from forms.example.json
state.config                  # from terraform/state.config.example
.github/workflows/deploy.yml
.github/dependabot.yml
```

- `forms.json`: start from [`forms.example.json`](../forms.example.json). The fields and rules are in the [config reference](config.md).
- `state.config`: start from [`terraform/state.config.example`](../terraform/state.config.example). Set your state bucket, the state key, and the bucket's region.

`.github/workflows/deploy.yml`:

```yaml
name: Deploy
# PR checks get their own group; a queued PR run would otherwise cancel a queued deploy.
concurrency:
  group: ${{ github.event_name == 'pull_request' && format('validate-{0}', github.ref) || 'deploy' }}
  cancel-in-progress: false
on:
  push: { branches: ["main"] }
  pull_request:
  workflow_dispatch:
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: Unit2795/contact-api@vX.Y.Z # the latest release tag
        with:
          apply: ${{ github.event_name != 'pull_request' }}
          aws-role-arn: ${{ secrets.AWS_ROLE_ARN }}
```

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

#### 2. Add the secret and deploy

Add the deploy role's ARN as the repository secret `AWS_ROLE_ARN`. Then open a PR with your config, and merge it once it passes.

| Event | `apply` | What runs | AWS access |
| --- | --- | --- | --- |
| Pull request | `false` | Copies in the config, then tests including `forms.json` checks, typecheck, build, `terraform validate` | None |
| Push to `main`, or a manual run | `true` | The same checks up to the build, then `terraform apply`, then `pnpm e2e` as a smoke test (no email, no quota) | OIDC role |

A manual run (`workflow_dispatch`) also deploys, so start it from `main`. The role only trusts `main`.

#### 3. Send a real test message

> ⚠️ Warning: A green deploy doesn't prove email works. The smoke test never sends. SES problems, such as an account still in the sandbox, only show up as `server_error` on the first real submission.

After the first deploy, send one real message and check it arrives:

- through a connected site: see [Verify through the site](connect.md#verify-through-the-site), or
- with `pnpm e2e --send` from a local clone of this repo: see [Testing a deployed API](../README.md#testing-a-deployed-api).

## Action inputs

| Input | Default | Description |
| --- | --- | --- |
| `config-dir` | `.` | Directory in the caller's workspace holding `forms.json` and `state.config` |
| `apply` | `false` | `true`: validate, then deploy and smoke test. `false`: validate only; no AWS access needed (use for PRs) |
| `aws-role-arn` | | OIDC role to assume. Required when `apply` is `true` |
| `aws-region` | `us-east-1` | Region for the Lambda, table, SSM parameters and SES identities. The state bucket's region is set separately in `state.config` |

- The workflow must check out the config repo before the action runs, and grant `id-token: write` when `apply` is `true`.
- Only the `apply: false` path runs `terraform validate`. The `apply: true` path goes straight to `terraform apply`.
- The smoke test uses the first form in `forms.json`, and that form's site key from SSM.

## Outputs

Terraform prints these at the end of the apply step in the deploy log:

| Output | Value |
| --- | --- |
| `origin_domain` | The Function URL host, for each site's CloudFront origin. Also in SSM `/contact-api/origin-domain`. |
| `site_key_parameters` | A map from each site id to the SSM SecureString parameter that holds its key. |

## Staying in sync

- **Pinned tag:** new versions never reach your deployment until you bump the tag.
- **Dependabot PRs:** Dependabot opens a PR for each new release. PRs run in validate-only mode, so they show whether your config still fits the new version, without touching AWS.
- **Versioning:** releases follow semver. New config options get defaults, so minor releases never break existing configs. A major release may need config changes, and its release notes say what they are.

## Rotating secrets

Terraform generates every secret, so rotating one means asking Terraform to replace it. Run this from a local clone of this repo, checked out at the tag your config repo pins, so the apply doesn't also change the deployed code. Copy in your `forms.json`, copy your `state.config` to `terraform/`, and use AWS credentials that can deploy:

```sh
pnpm install && pnpm build
cd terraform
terraform init -backend-config=state.config
terraform apply -replace='random_password.site_key["<site>"]'   # or random_password.hmac_secret
```

If you deploy outside `us-east-1`, add `-var aws_region=<region>` to the apply.

- **Site key:** the old key stops working once the apply finishes. Update the site's CloudFront with the new value from SSM, then redeploy the site.
- **HMAC secret:** existing stamp cookies become invalid, so visitors who already have a form open must reload the page before submitting.

## Removing a deployment

> ⚠️ Warning: This deletes the site keys, the rate-limit counters and the function. A later deploy generates new keys, so every site would need its CloudFront updated again.

1. Remove the `contact-api` origin and its two behaviors from each site's CloudFront. If a site's Terraform reads the SSM parameters, remove those data sources too, or its next plan fails once the parameters are gone.
2. From a local clone set up as in [Rotating secrets](#rotating-secrets), run:

   ```sh
   pnpm install && pnpm build
   cd terraform
   terraform init -backend-config=state.config
   terraform destroy
   ```

   Add `-var aws_region=<region>` if you deploy outside `us-east-1`. The build is needed because Terraform reads the Lambda bundle even when destroying. Destroy before you delete the SES identity, because Terraform also looks it up.
3. Delete what the stack doesn't manage, if nothing else uses it: the SES identity, the state bucket, the deploy role, the GitHub OIDC provider and the config repo.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The deploy fails to assume the role (`Not authorized to perform sts:AssumeRoleWithWebIdentity`) | The role's `sub` condition doesn't match the token. Try the other `sub` format in [Deploy role](#deploy-role), and check the owner, repo name and branch. If the job uses a GitHub environment, `sub` ends in `environment:<name>` instead of the branch. |
| A manual run fails to assume the role, but pushes to `main` work | The run was started from another branch. `sub` then names that branch, and the role only trusts `main`. Start it from `main`. |
| `terraform apply` fails setting reserved concurrency | The account's concurrency quota is below 105. Request a higher "Concurrent executions" quota in Service Quotas. |
| The validate step fails with `forms.json is invalid:` | Each `✖` line names a problem, and the `→ at` line under it says where, such as `forms["blog-contact"].to`. See the [validation rules](config.md#validation-rules). |
| Terraform fails reading an SES email identity | A sender domain isn't an SES identity in the deploy region. Create and verify it first. |
| Submissions return `server_error` | Check the log group `/aws/lambda/contact-api`; the AWS error is logged just before the `server_error` line. It is usually SES. An error saying the function is not authorized to perform `ses:SendEmail` on the recipient's identity means the account is still in the SES sandbox; request production access. |
| Bare `403` with no body | The request reached the API without a valid `x-contact-site-key`. The origin's custom header is missing or wrong, or the key was rotated and the site wasn't updated. |
| Bare `404` with no body | The key was accepted, but no form matched. The form isn't in `forms.json`, it belongs to another site, the path is wrong (for example, an origin path is set), or the method isn't `POST`. |
| Many unrelated visitors get `ip_limit` | The API isn't receiving `CloudFront-Viewer-Address`, so it counts every visitor as the address that called it. Traffic is going through a proxy other than CloudFront, or the CloudFront origin request policy doesn't forward that header. See [CloudFront](connect.md#cloudfront). |
