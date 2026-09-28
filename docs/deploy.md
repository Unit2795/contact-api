# Deploy

## Links

[Return to README](../README.md) | [Connect a site](connect.md) | [Config reference](config.md)

## Overview

This guide deploys your own instance of the API. Once it is running, [connect a site](connect.md).

You don't fork this repo. You create a small **private** config repo that holds your `forms.json` and `state.config` and runs this repo's GitHub Action ([`action.yml`](../action.yml)) at a pinned release tag. Your sites, addresses and deploy logs stay private, and a new version only reaches your deployment when you bump the tag.

> 💡 Note: You can run one deployment per AWS account. Resource names are fixed, the IAM role names `contact-api` and `contact-api-deploy` are account-wide, and the smoke test reads SSM parameters under `/contact-api/`.

## What gets created

| Resource | Name | Notes |
| --- | --- | --- |
| Lambda function | `contact-api` | Node.js 24, arm64, 256 MB, 10 s timeout. Reserves 5 concurrent executions, which caps cost under abuse, when the account's concurrency quota allows it. |
| Lambda Function URL | | Public (auth `NONE`). Requests without a valid site key get `403`. |
| IAM role | `contact-api` | Lets the function write its logs, update the limits table and send from the sender domains. |
| DynamoDB table | `contact-api-limits` | On-demand billing. Rate-limit counters, removed by TTL on `expiresAt`. |
| CloudWatch log group | `/aws/lambda/contact-api` | 14-day retention. |
| SSM parameter (String) | `/contact-api/origin-domain` | The Function URL host. |
| SSM parameter (SecureString) | `/contact-api/sites/<site>/origin-key` | One per site in `forms.json`. |
| Generated secrets | | An HMAC secret that signs stamp cookies, and one site key per site. They are stored in Terraform state and the Lambda environment; site keys are also stored in SSM. |

Every resource is tagged `Project = contact-api`. The state bucket, the GitHub OIDC provider and the deploy role come from a one-time [bootstrap](#2-run-the-bootstrap). The SES identity is yours to set up.

## Prerequisites

- **AWS account.** Everything goes in `us-east-1` unless you set the action's `aws-region` input.
- **SES:** a verified **domain** identity for your sender address, in the deploy region, ideally with DKIM enabled. See [Creating a domain identity](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html).
  - New accounts start in the SES sandbox. [Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) before the first send. In the sandbox, SES also checks the function's permission on each recipient's identity, which this stack doesn't grant, so every send fails with `server_error`.
- **Lambda concurrency (optional):** AWS always keeps 100 concurrent executions unreserved, so reserving 5 needs an account "Concurrent executions" quota of at least 105. New accounts can start lower. Then the deploy skips the reservation with a warning, and the account quota bounds cost instead. To turn the cap on, request a higher quota in Service Quotas; the next deploy reserves 5.
- **Runner:** the action uses `jq` and the AWS CLI. GitHub's `ubuntu-latest` runners have both.
- **Local tools,** only for [rotating secrets](#rotating-secrets) or [removing a deployment](#removing-a-deployment): Node.js 24 or newer, pnpm (`package.json` pins the version) and Terraform 1.10 or newer.

## Deploy steps

#### 1. Create the config repo

On [contact-api-template](https://github.com/Unit2795/contact-api-template), choose **Use this template** and make the new repo **private**. From a terminal: `gh repo create <config-repo> --private --template Unit2795/contact-api-template`.

| File | Purpose |
| --- | --- |
| `forms.json` | Your sites and forms, starting from the example. Edit it before the first deploy; see the [config reference](config.md). |
| `state.config` | Terraform state location. Replace it with the bootstrap's output in the next step. |
| `.github/workflows/deploy.yml` | Runs this repo's action at a pinned release tag. PRs validate; pushes to `main` deploy once the `AWS_ROLE_ARN` secret exists, and only validate before that. |
| `.github/dependabot.yml` | Opens a PR for each new contact-api release. |

The template's README has the same setup as a checklist.

#### 2. Run the bootstrap

[`bootstrap.yml`](../bootstrap.yml) is a CloudFormation template that creates the state bucket, the GitHub OIDC provider and the deploy role. Run it once per AWS account in [AWS CloudShell](https://console.aws.amazon.com/cloudshell/), in your deploy region, as a user that can create IAM roles. Use the same release tag as `deploy.yml`, and your config repo's owner and name with the same capitalization as on GitHub:

```sh
curl -fsSLO https://raw.githubusercontent.com/Unit2795/contact-api/vX.Y.Z/bootstrap.yml
# An account can have only one GitHub OIDC provider, so create it only if it's missing.
oidc=$(aws iam list-open-id-connect-providers --output text | grep -q token.actions.githubusercontent.com && echo false || echo true)
aws cloudformation deploy --stack-name contact-api-bootstrap --template-file bootstrap.yml \
  --capabilities CAPABILITY_NAMED_IAM --parameter-overrides GitHubRepo=<owner>/<config-repo> CreateOidcProvider=$oidc
# RoleArn: add it as the config repo's secret AWS_ROLE_ARN
aws cloudformation describe-stacks --stack-name contact-api-bootstrap --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text
# StateConfig: save it as the config repo's state.config
aws cloudformation describe-stacks --stack-name contact-api-bootstrap --query "Stacks[0].Outputs[?OutputKey=='StateConfig'].OutputValue" --output text
```

| Resource | Name | Notes |
| --- | --- | --- |
| S3 bucket | generated, in `StateConfig` | Terraform state, which holds the generated secrets. Private and versioned. Kept if you delete the stack. |
| IAM OIDC provider | `token.actions.githubusercontent.com` | Only if the account has none. |
| IAM role | `contact-api-deploy` | Trusted only by the config repo's `main` branch, in both of GitHub's `sub` formats. It can manage only the resources in [What gets created](#what-gets-created) and read the state bucket. |

- **Updating:** if a release needs new deploy permissions, its release notes say so. Download that tag's `bootstrap.yml` and run the `aws cloudformation deploy` line again without `--parameter-overrides`, so the stack keeps its first values.
- **Your own role:** to manage IAM another way, copy the trust policy and permissions from `bootstrap.yml`.

#### 3. Add the secret and deploy

Add the `AWS_ROLE_ARN` secret and commit `state.config`, if you haven't yet. Then open a PR with your config, and merge it once it passes.

| Event | `apply` | What runs | AWS access |
| --- | --- | --- | --- |
| Pull request | `false` | Copies in the config, then tests including `forms.json` checks, typecheck, build, `terraform validate` | None |
| Push to `main`, or a manual run, once `AWS_ROLE_ARN` exists | `true` | The same checks up to the build, then `terraform apply`, then `pnpm e2e` as a smoke test (no email, no quota) | OIDC role |

A manual run (`workflow_dispatch`) also deploys, so start it from `main`. The role only trusts `main`.

#### 4. Send a real test message

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
| `origin_domain` | The Function URL host that each site's proxy forwards to. Also in SSM `/contact-api/origin-domain`. |
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

- **Site key:** the old key stops working once the apply finishes. Put the new value from SSM into the site's proxy: for CloudFront, redeploy the site; for a server, update the key in its proxy config or `CONTACT_SITE_KEY` and restart the proxy (in Docker, recreate the container). See [Values to fetch](connect.md#values-to-fetch).
- **HMAC secret:** existing stamp cookies become invalid, so visitors who already have a form open must reload the page before submitting.

## Removing a deployment

> ⚠️ Warning: This deletes the site keys, the rate-limit counters and the function. A later deploy generates new keys, so every site would need its proxy updated again.

1. Remove the two contact API routes from each site's proxy. For CloudFront, remove the `contact-api` origin and its two behaviors, and if the site's Terraform reads the SSM parameters, remove those data sources too, or its next plan fails once the parameters are gone.
2. From a local clone set up as in [Rotating secrets](#rotating-secrets), run:

   ```sh
   pnpm install && pnpm build
   cd terraform
   terraform init -backend-config=state.config
   terraform destroy
   ```

   Add `-var aws_region=<region>` if you deploy outside `us-east-1`. The build is needed because Terraform reads the Lambda bundle even when destroying. Destroy before you delete the SES identity, because Terraform also looks it up.
3. Delete the bootstrap stack with `aws cloudformation delete-stack --stack-name contact-api-bootstrap`. That removes the deploy role, and the OIDC provider if the stack created it, which breaks any other GitHub workflows that use it. The state bucket is kept; empty and delete it once you no longer need the state.
4. Delete the SES identity and the config repo, if nothing else uses them.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The deploy fails to assume the role (`Not authorized to perform sts:AssumeRoleWithWebIdentity`) | The role's `sub` condition doesn't match the token. Check that the bootstrap's `GitHubRepo` matches the config repo's owner and name exactly, including capitalization; after a rename, run the bootstrap's `aws cloudformation deploy` line again with only `--parameter-overrides GitHubRepo=<owner>/<new-name>`, so `CreateOidcProvider` keeps its first value. If the job uses a GitHub environment, `sub` ends in `environment:<name>` instead of the branch, which the role doesn't trust. |
| The bootstrap fails, and running it again says the stack is in `ROLLBACK_COMPLETE` | A failed first create leaves the stack unusable. Check its events in the CloudFormation console for the cause, such as an existing `contact-api-deploy` role or OIDC provider, then run `aws cloudformation delete-stack --stack-name contact-api-bootstrap` and run the bootstrap again. |
| A manual run fails to assume the role, but pushes to `main` work | The run was started from another branch. `sub` then names that branch, and the role only trusts `main`. Start it from `main`. |
| `terraform apply` fails setting reserved concurrency | Less than 105 unreserved concurrency is left. Either the deploy role can't read the quota (add `lambda:GetAccountSettings` so the deploy skips the reservation), or other functions reserve concurrency too. Request a higher "Concurrent executions" quota in Service Quotas to keep the cap. |
| The validate step fails with `forms.json is invalid:` | Each `✖` line names a problem, and the `→ at` line under it says where, such as `forms["blog-contact"].to`. See the [validation rules](config.md#validation-rules). |
| Terraform fails reading an SES email identity | A sender domain isn't an SES identity in the deploy region. Create and verify it first. |
| Submissions return `server_error` | Check the log group `/aws/lambda/contact-api`; the AWS error is logged just before the `server_error` line. It is usually SES. An error saying the function is not authorized to perform `ses:SendEmail` on the recipient's identity means the account is still in the SES sandbox; request production access. |
| Bare `403` with no body | The request reached the API without a valid `x-contact-site-key`. The proxy doesn't set the header (for CloudFront, the origin's custom header is missing or wrong), the key is wrong, or the key was rotated and the site wasn't updated. |
| Bare `404` with no body | The key was accepted, but no form matched. The form isn't in `forms.json`, it belongs to another site, the path is wrong (for example, a CloudFront origin path is set, or the proxy strips `/api`), or the method isn't `POST`. |
| Many unrelated visitors get `ip_limit` | The API isn't receiving the visitor IP, so it counts many visitors as the same address. A server proxy isn't overwriting `X-Real-IP` with the visitor IP, or it sits behind a CDN it doesn't trust (see [Behind another CDN](connect.md#behind-another-cdn)); or the CloudFront origin request policy doesn't forward `CloudFront-Viewer-Address` (see [CloudFront](connect.md#cloudfront)). |
