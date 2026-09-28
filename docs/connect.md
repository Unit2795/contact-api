# Connect a site

## Links

[Return to README](../README.md) | [Deploy](deploy.md) | [Config reference](config.md)

## Overview

This guide connects a site to a deployed API: its CloudFront distribution, the HTML form and an optional JS enhancement. Deploy first; see [Deploy](deploy.md). The site and its forms must already be in `forms.json`; see [Adding a site, form or sender domain](config.md#adding-a-site-form-or-sender-domain).

> 💡 Note: The site must be served through CloudFront. The API reads the real client IP for rate limiting from the `CloudFront-Viewer-Address` header, which CloudFront adds. Behind another CDN or proxy, every visitor would be counted as that proxy's address.

## Values to fetch

The site's CloudFront needs two values from the API's deployment:

| Value | Where to find it |
| --- | --- |
| Origin domain | Terraform output `origin_domain`, or SSM `/contact-api/origin-domain` |
| Site key (secret) | SSM SecureString `/contact-api/sites/<site>/origin-key` (the output `site_key_parameters` lists these names) |

The SSM parameters are in the region the API was deployed to.

### Option A: site in the same account

The site's Terraform can read both values from SSM. Use the data sources' `.value` in place of `var.contact_api_origin_domain` and `var.contact_api_site_key` in the CloudFront example below. If the site's AWS provider uses another region, read them through a provider for the API's region.

```hcl
data "aws_ssm_parameter" "contact_api_origin_domain" { name = "/contact-api/origin-domain" }
data "aws_ssm_parameter" "contact_api_site_key" { name = "/contact-api/sites/<site>/origin-key" }
```

### Option B: site in another account

Pass the values into the site's Terraform as variables. For example, store the key as a CI secret exposed as `TF_VAR_contact_api_site_key`.

```hcl
variable "contact_api_origin_domain" { type = string }
variable "contact_api_site_key" {
  type      = string
  sensitive = true
}
```

## CloudFront

Add one origin and two behaviors to the site's distribution:

- Use exactly these two path patterns rather than `/api/*`, so other `/api` routes on the site are unaffected.
- Place both behaviors **above** any broader behavior such as `/api/*`. CloudFront uses the first behavior, in list order, whose path pattern matches.
- The origin is the bare host from `origin_domain`, with no `https://` and no origin path. An origin path changes the path the API sees, so every request would get `404`.

```hcl
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

- `Managed-AllViewerExceptHostHeader` forwards cookies and `CloudFront-Viewer-Address`, which carries the real client IP. It withholds only the viewer's `Host` header, so CloudFront sends the Function URL's own host, which the Function URL needs. `Managed-AllViewer` forwards the viewer's `Host` and can stop the Function URL from working.
- CloudFront overwrites any viewer-sent `x-contact-site-key` with the configured value, so a visitor can't choose the key through your distribution. Anyone who has a key can still call the Function URL directly, so keep the keys secret.

## HTML form

This works without JavaScript. The form posts to the site's own host, which CloudFront forwards to the API, so no CORS setup is needed.

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

- The last part of `action` is the form id from `forms.json`.
- `minlength` and `maxlength` on the message should match the form's `messageMin` and `messageMax`.
- Add an input for each of the form's `extraFields`, if it has any.
- The error page can read `?reason=` to explain what happened, e.g. `too_soon` → "Please wait a few seconds and retry". See [Responses](#responses).

## JavaScript enhancement

This is optional. Post the same fields urlencoded and ask for JSON. The server runs every check the same way, honeypots included:

```js
const form = document.querySelector('form[action^="/api/contact/"]');

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const res = await fetch(form.action, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams(new FormData(form)),
  });
  // A bare 403 or 404 has no JSON body (see Responses).
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const { ok, reason } = isJson ? await res.json() : { ok: false, reason: `http_${res.status}` };
  // ok → show thanks; otherwise map `reason` to a message
});
```

## Responses

Responses depend on the client:

- **No-JS posts** get a `303` redirect to `successUrl`, or to `errorUrl?reason=<code>`. If `errorUrl` already contains `?`, the reason is appended with `&reason=<code>`.
- **Requests with `Accept: application/json`** get `{ "ok": true }`, or `{ "ok": false, "reason": "<code>" }` with the status below.
- A tripped honeypot gets the normal success response, and no email is sent.

| Reason | Status | Meaning |
| --- | --- | --- |
| `stamp_missing` / `stamp_invalid` | 400 | No valid stamp cookie (page didn't load the GIF, or tampering) |
| `too_soon` | 400 | Submitted faster than `minDwellSec` after page load |
| `stamp_expired` | 400 | Page open longer than `maxDwellSec`; reload |
| `invalid_email` / `invalid_message` / `invalid_field` | 400 | Validation failed |
| `bad_request` / `too_large` | 400 / 413 | Unparseable or oversized body |
| `ip_limit` / `form_limit` | 429 | Daily per-client cap for this form, or monthly per-form cap, reached |
| `server_error` | 500 | AWS failure (see CloudWatch logs) |
| (no body) | 403 | Missing or wrong site key. No redirect, even for no-JS posts |
| (no body) | 404 | Unknown form, a form of another site, or a wrong path or method. No redirect, even for no-JS posts |

For bare `403` and `404` causes, see [Troubleshooting](deploy.md#troubleshooting).

## Verify through the site

`pnpm e2e` calls the Function URL directly, so it can't check the CloudFront path. Check it on the live site:

1. Open the page with the form. In the browser's dev tools, `/api/stamp.gif` should return `200` and set the `stamp` cookie.
2. Reload the page and submit the form within `minDwellSec`. You should get `too_soon`: the error page with `reason=too_soon`, or that reason in the JSON response if you use the JS enhancement.
3. Wait at least `minDwellSec`, then submit a real message. The email should arrive with `Reply-To` set to the address you entered.
4. Check the `IP:` line in the footer of the email. It should be your own address, not a CloudFront address. That confirms `CloudFront-Viewer-Address` is forwarded.

Each real submission uses 1 of the form's daily per-client quota and 1 of its monthly quota.
