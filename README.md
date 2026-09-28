# contact-api

A self-hosted contact-form backend on AWS, for sites hosted anywhere. Every form posts to the site's own domain, where a reverse proxy (CloudFront, nginx, Caddy, Traefik or similar) forwards it to one Lambda function. Each form emails a single recipient through Amazon SES. Forms work as plain HTML with no JavaScript, and can be enhanced with JS.

You don't fork this repo. It holds only code. Each deployment is a small **private config repo** that holds your `forms.json` and `state.config` and runs this repo's GitHub Action at a pinned release tag, so your sites, addresses and deploy logs stay private.

## Is it for you?

| ✅ It fits if | ❌ It doesn't do |
| --- | --- |
| Your sites are served over HTTPS through CloudFront (in any AWS account) or any reverse proxy that can set request headers | Hosts that can't proxy requests on the site's own domain with custom headers, such as GitHub Pages |
| Each form sends to one recipient | Several recipients per form |
| A plain-text email with `Reply-To` set to the sender is enough | HTML email, file attachments, or storing submissions (messages are only emailed) |
| Honeypot fields, a cookie that rejects too-fast submissions and rate limits are enough spam defense | CAPTCHA |

- **AWS:** you need an account with a verified SES domain for the sender address, and SES production access (out of the sandbox). Deploys run from GitHub Actions, and a one-time CloudFormation bootstrap creates the state bucket and deploy role. One deployment per AWS account.
- **Cost:** every resource it creates is billed by use, with no fixed monthly fee, so a low-traffic site costs very little. The Lambda also serves the stamp GIF, so each view of a page with a form is one invocation.

## How it works

```
Browser ──> site's reverse proxy ──(adds x-contact-site-key and the client IP)──> Lambda Function URL ──> DynamoDB (limits) + SES
```

Each site's reverse proxy forwards two paths on the site's own domain to this API, so the stamp cookie stays first-party:

| Route | Purpose |
| --- | --- |
| `GET /api/stamp.gif` | 1x1 GIF that sets the signed `stamp` cookie (HttpOnly, SameSite=Strict) |
| `POST /api/contact/{formId}` | Form submission |

A submission passes these checks, cheapest first. Nothing touches AWS until the submission is valid:

1. **Site key:** a header set by the site's proxy. Missing or wrong → `403`, so requests straight to the Function URL without a key are rejected.
2. **Form ownership:** the form must belong to that site, else `404`.
3. **Size / parse:** body ≤ 32 KB, urlencoded or flat JSON.
4. **Honeypot:** any honeypot field that isn't blank → fake success, no email.
5. **Stamp:** the cookie is signed per site. It must be at least `minDwellSec` old and at most `maxDwellSec`.
6. **Validation:** email, message length, extra fields.
7. **Rate limits:** per form and client IP per day first, then per form per month. The proxy passes the client IP in `X-Real-IP`, or CloudFront in `CloudFront-Viewer-Address`. The counters are atomic DynamoDB writes that expire automatically. See [Rate limits](docs/config.md#rate-limits).
8. **Send:** plain-text email with `Reply-To` set to the submitter.

## Get started

1. [Deploy](docs/deploy.md): create a private config repo from [contact-api-template](https://github.com/Unit2795/contact-api-template), run the one-time AWS bootstrap, and deploy.
2. [Connect a site](docs/connect.md): add the proxy routes (CloudFront, nginx, Caddy or Traefik) and the HTML form.
3. [Configure forms](docs/config.md): `forms.json` fields, validation rules and rate limits.

## Development

Requires Node.js 24 or newer and pnpm; `package.json` pins the pnpm version. `forms.json` is gitignored here. Copy `forms.example.json` to it, or copy in a real config to test against.

```sh
cp forms.example.json forms.json
pnpm install
pnpm test        # unit + handler tests (AWS mocked), and forms.json checks
pnpm typecheck
pnpm build       # dist/index.cjs; Terraform zips it
```

## Testing a deployed API

`pnpm e2e` calls the Function URL directly, bypassing the site's proxy. It reads `CONTACT_URL` and `CONTACT_SITE_KEY`, plus an optional `CONTACT_FORM`, from the environment or from a gitignored `.env`. Copy `.env.example`, which says where to find each value in SSM. The local `forms.json` must match the deployment being tested, since the script reads form settings from it.

| Command | Checks | Side effects |
| --- | --- | --- |
| `pnpm e2e` | 403 without a key; stamp cookie; `too_soon`; honeypot gives a fake success redirect | None |
| `pnpm e2e --send` | The above, then waits out `minDwellSec` and does a real submission | One email; uses 1 of the form's daily per-client quota and 1 of its monthly quota |

These checks can't cover the site's proxy: the real client IP, and the proxy overwriting the site key header. Verify those through a connected site; see [Verify through the site](docs/connect.md#verify-through-the-site).

## Releasing (maintainer)

1. Merge to `main` with CI green. Dependabot opens one weekly PR for the GitHub Actions and one for the npm packages; merge them when CI passes, then release a patch version. Any config format change must update `forms.example.json` in the same PR; CI validates it.
2. Set `version` in `package.json` to the new version, then tag `vX.Y.Z` on that commit and publish a GitHub release. Bump the major version when an existing config would stop validating, and put the migration steps in the release notes. If the release needs new deploy permissions, say to run the bootstrap again.
3. Bump the `Unit2795/contact-api@vX.Y.Z` pin in [contact-api-template](https://github.com/Unit2795/contact-api-template)'s `deploy.yml`, so new config repos start on the new version. Its Dependabot would otherwise take up to a week. Copy any config format change into its `forms.json`.

## License

MIT. See [LICENSE](LICENSE).
