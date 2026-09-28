# Connect a site

## Links

[Return to README](../README.md) | [Deploy](deploy.md) | [Config reference](config.md)

## Overview

This guide connects a site to a deployed API: a reverse proxy on the site's own domain, the HTML form and an optional JS enhancement. The proxy can be the site's CloudFront distribution, or nginx, Caddy or Traefik on any host, such as a plain Linux server or Docker outside AWS. Deploy first; see [Deploy](deploy.md). The site and its forms must already be in `forms.json`; see [Adding a site, form or sender domain](config.md#adding-a-site-form-or-sender-domain).

## How the site connects

The browser only talks to the site's own domain, and the site's reverse proxy forwards two paths to the API's Function URL. Keeping these requests on the site's domain makes the stamp cookie first-party, and no CORS setup is needed. Every proxy must:

1. **Forward two paths, unchanged:** `GET /api/stamp.gif` and `POST /api/contact/*`. Use exactly these rather than `/api/*`, so other `/api` routes on the site are unaffected. Don't strip or add a path prefix; the API matches the full path.
2. **Use the Function URL's host:** connect over HTTPS, and send the origin domain as both the `Host` header and the TLS server name (SNI). Sending the site's host instead can stop the Function URL from working.
3. **Set the site key:** overwrite `x-contact-site-key` with the site's key. Without a valid key, the API returns a bare `403`.
4. **Set the visitor IP:** overwrite `X-Real-IP` with the visitor's IP. Rate limits count per visitor IP. If the proxy sends nothing, every visitor counts as the proxy's address; if it passes on a visitor-sent value, anyone can pick their own IP and skip the daily cap.

CloudFront meets rule 4 its own way: it removes a visitor-sent `X-Real-IP` and puts the visitor IP in `CloudFront-Viewer-Address`, which the API reads when `X-Real-IP` is absent.

> ⚠️ Warning: The site must use HTTPS. The stamp cookie is `Secure`, so browsers don't keep it on plain HTTP, and every submission fails with `stamp_missing`.

## Values to fetch

The site's proxy needs two values from the API's deployment:

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

### Option C: site outside AWS

Copy both values once with the AWS CLI, using credentials that can read the parameters:

```sh
aws ssm get-parameter --name /contact-api/origin-domain --query Parameter.Value --output text --region <region>
aws ssm get-parameter --name /contact-api/sites/<site>/origin-key --with-decryption --query Parameter.Value --output text --region <region>
```

Store the key on the server as an environment variable or secret, such as `CONTACT_SITE_KEY`, and keep it out of any repo. The examples below read it from `CONTACT_SITE_KEY` where the proxy supports environment variables.

> ⚠️ Warning: After a [site key rotation](deploy.md#rotating-secrets), copy the new key to the server and restart the proxy. In Docker, recreate the container so it gets the new environment. Until then, the site's forms get a bare `403`.

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

## nginx

Add this to the site's `server` block, which must already serve HTTPS. The two `set` lines hold the origin domain and the site key; `contact-api.conf` holds the settings both locations share.

```nginx
resolver 1.1.1.1 valid=300s;               # in Docker: 127.0.0.11
set $contact_api https://<origin_domain>;  # no path part, so the request path passes unchanged
set $contact_site_key "<site key>";

location = /api/stamp.gif { proxy_pass $contact_api; include contact-api.conf; }
location ^~ /api/contact/  { proxy_pass $contact_api; include contact-api.conf; }
```

`contact-api.conf`, in nginx's config directory (such as `/etc/nginx/`):

```nginx
proxy_http_version 1.1;
proxy_ssl_server_name on;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header x-contact-site-key $contact_site_key;
```

- **Host and SNI:** nginx sends the origin domain as `Host` by default. `proxy_ssl_server_name on` also sends it as the TLS server name; nginx leaves that off by default.
- **Inherited headers:** a `proxy_set_header` in a location drops every `proxy_set_header` from the `server` or `http` block, including a `Host $host` line. That keeps the site's host away from the Function URL, so don't add a `Host` line here.
- **DNS:** `proxy_pass` uses a variable so nginx looks up the Function URL's address again while running (every 300 seconds here), not only at startup. That needs the `resolver` line, because nginx doesn't read `/etc/resolv.conf`.
- **Other locations:** `=` and `^~` locations win over regex locations, so a static-file rule such as `location ~* \.gif$` can't take `/api/stamp.gif`.
- **HTTP version:** `proxy_http_version 1.1` is the default only from nginx 1.29.7; older versions default to HTTP/1.0.

In Docker, with the official `nginx` image:

- Use `resolver 127.0.0.11`, Docker's built-in DNS. It is available on Compose networks and other user-defined networks, not on the default `bridge` network.
- To read the key from an environment variable, save the site config as `/etc/nginx/templates/default.conf.template` and write `set $contact_site_key "${CONTACT_SITE_KEY}";`. At startup the image fills in `${CONTACT_SITE_KEY}` from the container's environment and writes the result to `/etc/nginx/conf.d/default.conf`. Only defined environment variables are replaced, so nginx variables such as `$remote_addr` are left alone.
- Mount `contact-api.conf` at `/etc/nginx/contact-api.conf`, not in `conf.d/`. nginx loads every `conf.d/*.conf` file at the `http` level.

## Caddy

Add the `(contact_api)` snippet at the top of the Caddyfile and the two `handle` blocks to the site's block. Caddy serves the site over HTTPS automatically.

```caddy
(contact_api) {
	reverse_proxy https://<origin_domain> {
		header_up Host {upstream_hostport} # automatic from Caddy 2.11; needed before that
		header_up X-Real-IP {client_ip}
		header_up x-contact-site-key {env.CONTACT_SITE_KEY}
	}
}

example.com {
	handle /api/stamp.gif {
		import contact_api
	}
	handle /api/contact/* {
		import contact_api
	}

	# the site's existing directives
}
```

- **Path:** `handle` and `reverse_proxy` pass the path unchanged. Don't use `handle_path`, which strips the matched prefix.
- **Visitor IP:** `{client_ip}` is the connecting address, unless `trusted_proxies` is set; see [Behind another CDN](#behind-another-cdn). Caddy doesn't touch `X-Real-IP` by itself, so the `header_up` line is what overwrites a visitor-sent value.
- **Order:** `handle` runs before the site's other `reverse_proxy` and `file_server` directives, and a longer path wins over a shorter one such as `handle /api/*`, so these two paths reach the API. A site-wide `rewrite` or `try_files`, such as a single-page-app fallback, still runs first and would rewrite them; move it into a `handle { ... }` block for the rest of the site.
- **Docker:** with the official `caddy` image, set `CONTACT_SITE_KEY` in the container's environment. Caddy looks up the Function URL's address when it opens a connection, so no DNS setting is needed.

## Traefik

For Traefik v3. The route goes in a dynamic config file loaded by the file provider, because only those files can read the key from an environment variable. Add the file provider to the static config, next to the site's existing providers:

```yaml
providers:
  docker: {}                     # the site's existing provider, if any
  file:
    directory: /etc/traefik/dynamic
```

`/etc/traefik/dynamic/contact-api.yml`:

```yaml
http:
  routers:
    contact-api:
      rule: "Host(`example.com`) && (Path(`/api/stamp.gif`) || PathPrefix(`/api/contact/`))"
      priority: 1000             # above the site's own router
      entryPoints: [websecure]   # the site's HTTPS entry point
      service: contact-api
      middlewares: [contact-api-key]
      tls: {}                    # match the site's router, such as its certResolver
  middlewares:
    contact-api-key:
      headers:
        customRequestHeaders:
          x-contact-site-key: '{{ env "CONTACT_SITE_KEY" }}'
  services:
    contact-api:
      loadBalancer:
        passHostHeader: false
        servers:
          - url: "https://<origin_domain>"   # no path part
```

- **Host and SNI:** `passHostHeader: false` sends the host from the server `url` in place of the site's host. Traefik also uses that host as the TLS server name, so no `serversTransport` is needed.
- **Visitor IP:** no setting is needed. Traefik deletes an incoming `X-Real-IP` from any peer not listed in the entry point's `forwardedHeaders.trustedIPs`, then sets it to the connecting address.
- **Site key:** `customRequestHeaders` overwrites a visitor-sent header of the same name. If `CONTACT_SITE_KEY` is empty, Traefik drops the header and the API returns `403`.
- **Priority:** Traefik uses the matching router with the highest `priority`, which by default is the length of its rule. The explicit value keeps this router ahead of the site's.
- **Docker:** set `CONTACT_SITE_KEY` in the Traefik container's environment, not the site's, and mount the `dynamic` directory into the Traefik container. Keep the key out of Docker labels.

## Behind another CDN

If another CDN such as Cloudflare sits in front of the server, the proxy's connecting address is the CDN, so `X-Real-IP` would hold the CDN's address and visitors would share daily caps. Make the proxy trust the CDN's published IP ranges and read the visitor IP from the CDN's header, `CF-Connecting-IP` for Cloudflare:

- **nginx:** in the `server` block, one `set_real_ip_from <range>;` line per CDN range, plus `real_ip_header CF-Connecting-IP;`. `$remote_addr` then holds the visitor IP.
- **Caddy** (2.7 or newer): in the global options, as below. `{client_ip}` then holds the visitor IP.

  ```caddy
  {
  	servers {
  		trusted_proxies static <CDN ranges>
  		client_ip_headers CF-Connecting-IP
  	}
  }
  ```

- **Traefik:** `forwardedHeaders.trustedIPs` isn't enough. Traefik still sets `X-Real-IP` to the CDN's address, and it can't copy `CF-Connecting-IP` into `X-Real-IP` without a plugin. Use nginx or Caddy for this setup.

## HTML form

This works without JavaScript. The form posts to the site's own host, which the site's proxy forwards to the API, so no CORS setup is needed.

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

`pnpm e2e` calls the Function URL directly, so it can't check the site's proxy. Check it on the live site:

1. Open the page with the form. In the browser's dev tools, `/api/stamp.gif` should return `200` and set the `stamp` cookie.
2. Reload the page and submit the form within `minDwellSec`. You should get `too_soon`: the error page with `reason=too_soon`, or that reason in the JSON response if you use the JS enhancement.
3. Wait at least `minDwellSec`, then submit a real message. The email should arrive with `Reply-To` set to the address you entered.
4. Check the `IP:` line in the footer of the email. It should be your own public address, not the address of the proxy, the server or a CDN. That confirms the proxy passes on the visitor IP.

Each real submission uses 1 of the form's daily per-client quota and 1 of its monthly quota.

Optionally, check that a visitor can't choose their own IP. This sends no email and uses no quota. Post a tripped honeypot through the site with a fake `X-Real-IP`; `phone` stands for one of the form's `honeypots`:

```sh
curl -s https://<site domain>/api/contact/<form id> -H 'Accept: application/json' -H 'X-Real-IP: 192.0.2.55' --data 'phone=x'
aws logs tail /aws/lambda/contact-api --since 10m --region <region>
```

The response is `{"ok":true}`, and the log shows a line like `{"outcome":"honeypot","form":"<form id>","site":"<site>","ip":"..."}`. Its `ip` should be your own address. If it is `192.0.2.55`, the proxy passes on a visitor-sent `X-Real-IP`; see rule 4 in [How the site connects](#how-the-site-connects).
