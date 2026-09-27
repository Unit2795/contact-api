# contact-api

One centralized, hardened contact-form backend for all my sites. Every form posts to the same Lambda; each form
emails a single recipient via SES. Works with plain HTML forms (no JS), and optionally enhanced with JS.

It is built for personal use and costs pennies a month. This repo holds only the code. Each deployment lives in its
own private config repo, which runs this repo's GitHub Action at a pinned release; see
[Deploy your own](#deploy-your-own).

## How it works

```
Browser ──> site's CloudFront ──(adds x-contact-site-key)──> Lambda Function URL ──> DynamoDB (limits) + SES
```

Each site proxies two paths to this API through its own CDN, so the stamp cookie stays first-party:

| Route | Purpose |
|---|---|
| `GET /api/stamp.gif` | 1x1 GIF that sets the signed `stamp` cookie (HttpOnly, SameSite=Strict) |
| `POST /api/contact/{formId}` | Form submission |

A submission passes these checks, cheapest first. Nothing touches AWS until the submission is valid:

1. **Site key**: header injected by the site's CDN. Missing or wrong → `403`. Blocks direct hits on the Function URL.
2. **Form ownership**: the form must belong to that site, else `404`.
3. **Size / parse**: body ≤ 32 KB, urlencoded or flat JSON.
4. **Honeypot**: any non-empty honeypot field → fake success, no email.
5. **Stamp**: cookie signed per site. Must be at least `minDwellSec` old and at most `maxDwellSec`.
6. **Validation**: email, message length, extra fields.
7. **Rate limits**: per-IP per day first, then per-form per month. Atomic DynamoDB counters that expire automatically.
8. **Send**: plain text email with `Reply-To` set to the submitter.

Responses depend on the client:
- **No-JS posts** get a `303` to `successUrl`, or to `errorUrl?reason=<code>`.
- **Requests with `Accept: application/json`** get `{ ok: true }` or `{ ok: false, reason }` with a matching status.

| Reason | Status | Meaning |
|---|---|---|
| `stamp_missing` / `stamp_invalid` | 400 | No valid stamp cookie (page didn't load the GIF, or tampering) |
| `too_soon` | 400 | Submitted faster than `minDwellSec` after page load |
| `stamp_expired` | 400 | Page open longer than `maxDwellSec`; reload |
| `invalid_email` / `invalid_message` / `invalid_field` | 400 | Validation failed |
| `bad_request` / `too_large` | 400 / 413 | Unparseable or oversized body |
| `ip_limit` / `form_limit` | 429 | Daily per-IP or monthly per-form cap reached |
| `server_error` | 500 | AWS failure (see CloudWatch logs) |

## Adding a form

Forms live in `forms.json` in your config repo; start from [`forms.example.json`](forms.example.json). The file is
bundled into the Lambda and read by Terraform, and the deploy action validates it before touching AWS.

- **`stamp`**: global dwell window in seconds. One stamp cookie covers every form on a site.
- **`sites`**: site ids. Each gets its own generated origin key.
- **`defaults`**: applied to every form unless the form overrides them.
- **`forms`**: keyed by form id, which appears in the URL.

| Form field | Required | Notes |
|---|---|---|
| `site` | ✅ | Must be listed in `sites` |
| `to` | ✅ | Single recipient address |
| `subject` | ✅ | Email subject |
| `successUrl` / `errorUrl` | ✅ | Relative paths resolve on the site's own domain |
| `honeypots` | ✅ | Hidden field names that must stay empty; at least one |
| `from` | | Sender; its domain must be a verified SES identity |
| `extraFields` | | Optional extra fields to include in the email, max 200 chars each |
| `messageMin` / `messageMax` | | Message length bounds |
| `monthlyCap` / `ipDailyCap` | | Rate limits |

`email` and `message` are always the field names for the submitter's address and message.

A new **site** also needs a deploy, which creates its key, then the CDN wiring below. A new **sender domain** must
already be verified in SES.

## Connecting a site

### 1. CDN (CloudFront, in the site's Terraform)

The site needs two values from this API's deployment:

| Value | Where to find it |
|---|---|
| Origin domain | Terraform output `origin_domain`, or SSM `/contact-api/origin-domain` |
| Site key (secret) | SSM SecureString `/contact-api/sites/<site>/origin-key` |

Pass them into the site's Terraform as variables. The site can then live in any AWS account; for example, store the
key as a CI secret exposed as `TF_VAR_contact_api_site_key`. If the site is in the same account, it can read them
with `aws_ssm_parameter` data sources instead.

Use exactly these two path patterns rather than `api/*`, so other `/api` routes on the site are unaffected.

```hcl
variable "contact_api_origin_domain" { type = string }
variable "contact_api_site_key" {
  type      = string
  sensitive = true
}

data "aws_cloudfront_cache_policy" "disabled" { name = "Managed-CachingDisabled" }
data "aws_cloudfront_origin_request_policy" "all_viewer" { name = "Managed-AllViewerExceptHostHeader" }

# Inside the aws_cloudfront_distribution:
origin {
  origin_id   = "contact-api"
  domain_name = var.contact_api_origin_domain
  custom_origin_config {
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "https-only"
    origin_ssl_protocols   = ["TLSv1.2"]
  }
  custom_header {
    name  = "x-contact-site-key"
    value = var.contact_api_site_key
  }
}

ordered_cache_behavior {
  path_pattern             = "/api/contact/*"
  target_origin_id         = "contact-api"
  viewer_protocol_policy   = "https-only"
  allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
  cached_methods           = ["GET", "HEAD"]
  cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
  origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
}

ordered_cache_behavior {
  path_pattern             = "/api/stamp.gif"
  target_origin_id         = "contact-api"
  viewer_protocol_policy   = "https-only"
  allowed_methods          = ["GET", "HEAD"]
  cached_methods           = ["GET", "HEAD"]
  cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
  origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
}
```

- `Managed-AllViewerExceptHostHeader` forwards cookies and `CloudFront-Viewer-Address`, which carries the real client
  IP for rate limiting. It also drops `Host`, which Function URLs require.
- CloudFront overwrites any viewer-sent `x-contact-site-key`, so the key can't be spoofed.

### 2. HTML (works without JS)

```html
<!-- Sets the stamp cookie. Include it on the page that has the form. -->
<img src="/api/stamp.gif" alt="" width="1" height="1" style="position:absolute">

<form method="post" action="/api/contact/portfolio-contact">
  <input type="email" name="email" required maxlength="254">
  <textarea name="message" required minlength="12" maxlength="2000"></textarea>

  <!-- Honeypots: names must match the form's "honeypots"; hidden from people and assistive tech -->
  <div inert aria-hidden="true" style="position:absolute;left:-9999px">
    <input name="phone" tabindex="-1" autocomplete="off">
  </div>

  <button type="submit">Send</button>
</form>
```

The error page can read `?reason=` to explain what happened, e.g. `too_soon` → "Please wait a few seconds and retry".

### 3. Optional JS enhancement

Post the same fields urlencoded and ask for JSON. The server runs every check the same way, honeypots included:

```js
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const res = await fetch(form.action, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams(new FormData(form)),
  });
  const { ok, reason } = await res.json().catch(() => ({ ok: false, reason: "server_error" }));
  // ok → show thanks; otherwise map `reason` to a message
});
```

## Deploying

This repo never deploys itself. Its CI runs the deploy action against the example config, in validate-only mode.

Deployments run from a private config repo, through the composite action in [`action.yml`](action.yml):

| `apply` | What runs | AWS access |
|---|---|---|
| `false` (PRs) | Copies in the config, typecheck, tests including `forms.json` checks, build, `terraform validate` | None |
| `true` (`main`) | The same checks, then `terraform apply`, then `pnpm e2e` as a smoke test (no email) | OIDC role |

Terraform state lives wherever the config repo's `state.config` says. It holds the generated secrets, so keep the
bucket private. The deploy role needs:

| Service | Access |
|---|---|
| S3 | The state bucket: list, plus get/put/delete on the state key's prefix (includes the `.tflock` lockfile) |
| Lambda | Manage function `contact-api`, its URL, concurrency and permissions |
| IAM | Manage role `contact-api` and its inline policy; `iam:PassRole` on it |
| DynamoDB | Manage table `contact-api-limits`, including TTL and tags |
| SSM | Manage parameters under `/contact-api/*` |
| CloudWatch Logs | Manage log group `/aws/lambda/contact-api` |
| SES | `ses:GetEmailIdentity` on the sender domains |
| STS | `sts:GetCallerIdentity` |

## Deploy your own

You don't fork this repo. You create a small **private** config repo that runs this repo's action, so your sites,
addresses and deploy logs stay private.

### Prerequisites

Everything is in `us-east-1` unless you pass the action's `aws-region` input.

- **SES:** a verified **domain** identity for your sender address, in the same region.
  - New accounts start in the SES sandbox, where every recipient must also be verified. Either verify each form's
    `to` address, or request production access.
- **State bucket:** a private S3 bucket for Terraform state. Enabling versioning is recommended.
- **Deploy role:** a GitHub OIDC role with the permissions in the table above. Scope its trust policy to your
  **config repo's** `main` branch, e.g. `token.actions.githubusercontent.com:sub` =
  `repo:<you>/<config-repo>:ref:refs/heads/main`.

### Config repo

```
forms.json                    # from forms.example.json
state.config                  # from terraform/state.config.example
.github/workflows/deploy.yml
.github/dependabot.yml
```

`.github/workflows/deploy.yml`:

```yaml
name: Deploy
concurrency: { group: deploy, cancel-in-progress: false }
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
      - uses: Unit2795/contact-api@v1.0.0 # pin a release tag
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

Then add the `AWS_ROLE_ARN` secret and push to `main`. Finally, wire each site's CDN as described in
[Connecting a site](#connecting-a-site).

### Staying in sync

- **Pinned tag:** new versions never reach your deployment until you bump the tag.
- **Dependabot PRs:** Dependabot opens a PR for each new release. PRs run in validate-only mode, so they show
  whether your config still fits the new version, without touching AWS.
- **Versioning:** releases follow semver. New config options get defaults, so minor releases never break existing
  configs. A major release may need config changes, and its release notes say what they are.

## Releasing (maintainer)

1. Merge to `main` with CI green. Any config format change must update `forms.example.json` in the same PR; CI
   validates it.
2. Tag `vX.Y.Z` and publish a GitHub release. Bump the major version when an existing config would stop validating,
   and put the migration steps in the release notes.

## Local development

`forms.json` is gitignored here. Copy `forms.example.json` to it, or copy in a real config to test against.

```sh
cp forms.example.json forms.json
pnpm install
pnpm test        # unit + handler tests (AWS mocked), and forms.json checks
pnpm typecheck
pnpm build       # dist/index.cjs; Terraform zips it
```

## Testing the deployed API

`pnpm e2e` calls the Function URL directly, bypassing CloudFront. It reads `CONTACT_URL` and `CONTACT_SITE_KEY` from
a gitignored `.env`; copy `.env.example`, which says where to find each value in SSM. The local `forms.json` must
match the deployment being tested, since the script reads form settings from it.

| Command | Checks | Side effects |
|---|---|---|
| `pnpm e2e` | 403 without a key; stamp cookie; `too_soon`; honeypot gives a fake success redirect | None |
| `pnpm e2e --send` | The above, then waits out the dwell time and does a real submit | One email; uses 1 of today's per-IP quota |

These checks can't cover the CloudFront path: real viewer IP, and the site key being overwritten. Verify those
through a connected site.
