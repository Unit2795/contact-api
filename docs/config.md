# Config reference

## Links

[Return to README](../README.md) | [Deploy](deploy.md) | [Connect a site](connect.md)

## Overview

`forms.json` defines your sites and forms. It is stored in your config repo; start from [`forms.example.json`](../forms.example.json). It is bundled into the Lambda and read by Terraform, and the deploy action validates it before touching AWS. To connect a site and its HTML form, see [Connect a site](connect.md).

## Structure

| Key | Contents |
| --- | --- |
| `stamp` | How long after the stamp cookie is set a submission is accepted, in seconds: from `minDwellSec` to `maxDwellSec`. It applies to every form. One stamp cookie covers every form on a site, and the cookie expires after `maxDwellSec`. |
| `defaults` | Optional. Values applied to every form unless the form sets its own. |
| `sites` | Site ids. Each site gets its own generated key. |
| `forms` | Keyed by form id, which appears in the URL: `/api/contact/<form id>`. |

## Fields

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `site` | Yes | | Must be listed in `sites` |
| `to` | Yes | | Single recipient address |
| `subject` | Yes | | Email subject |
| `successUrl` / `errorUrl` | Yes | | A root-relative path like `/thanks`, which resolves on the site's own domain, or a full `https://` URL |
| `from` | Yes | | Sender; its domain must be a verified SES identity |
| `honeypots` | Yes | | Hidden field names that must stay empty. At least one. A form's list replaces the default list |
| `extraFields` | No | `[]` | Extra fields to include in the email, max 200 characters each |
| `messageMin` / `messageMax` | No | `12` / `2000` | Message length bounds, in characters, after trimming whitespace |
| `monthlyCap` / `ipDailyCap` | No | `50` / `3` | Rate limits; see [Rate limits](#rate-limits) |

Any field can be set on each form or once in `defaults`. A value on the form wins over `defaults`, which wins over the code default.

`email` and `message` are always the field names for the submitter's address and message. The email address can be at most 254 characters.

## Validation rules

The config is checked as it loads: in the deploy action's `pnpm test` step, before anything touches AWS, and again when the Lambda starts.

- Unknown keys fail, so a misspelled key like `ipDailycap` isn't silently ignored in favor of the default. This applies at the top level, in `stamp` and in forms. Keys in `defaults` are checked as part of each form.
- `minDwellSec` and `maxDwellSec` are whole numbers greater than 0, and `maxDwellSec` is greater than `minDwellSec`.
- Site and form ids use only lowercase letters, digits and hyphens (`a-z0-9-`). `sites` has at least one id, and each form's `site` is listed in it.
- `to` and `from` look like email addresses. `subject` is not blank.
- `successUrl` and `errorUrl` start with `/` or `https://`.
- Honeypot names don't reuse `email`, `message` or one of the form's `extraFields`.
- `messageMin`, `messageMax`, `monthlyCap` and `ipDailyCap` are whole numbers greater than 0, and `messageMax` is greater than `messageMin`.

A failure lists every problem, each with its location:

```
forms.json is invalid:
✖ Unrecognized key: "ipDailycap"
  → at forms["blog-contact"]
✖ "shop" is not in sites
  → at forms["portfolio-contact"].site
```

## Adding a site, form or sender domain

- **Form:** add it under `forms`, open a PR in the config repo, and merge it to deploy. A form on an existing site needs no proxy change; the site's HTML just posts to the new form id.
- **Site:** add its id to `sites` and add its forms, then deploy. The deploy creates the site's key. Then [connect the site](connect.md). Renaming a site id removes the old key and creates a new one.
- **Sender domain:** verify the domain in SES, in the deploy region, before you use it in `from`. Terraform looks up every sender domain, and the deploy fails if one isn't an SES identity.

## Rate limits

Two counters are checked, in this order, after every other check has passed:

| Counter | Limit | Counted per |
| --- | --- | --- |
| Daily | `ipDailyCap` | Form, client and UTC day |
| Monthly | `monthlyCap` | Form and UTC calendar month, across all clients |

- **Client:** the IPv4 address. IPv6 addresses are grouped by their /64 prefix, because one device often controls a whole /64. IPv4-mapped IPv6 addresses written like `::ffff:192.0.2.1` count as the IPv4 address.
- **Client IP source:** the `X-Real-IP` header, which the site's proxy sets. Without it, the `CloudFront-Viewer-Address` header, which CloudFront adds. Without either, the address that called the Function URL. See [How the site connects](connect.md#how-the-site-connects).
- **No refunds:** a counter is used before the email is sent, and is not given back if sending fails. A submission rejected by the monthly cap has already used 1 of the daily count.
- **What counts:** only submissions that pass every other check. Honeypot hits and submissions rejected before the rate limits don't use quota.
- **Resets:** counter keys include the UTC day or month, so a new day or month starts from 0. DynamoDB TTL removes old counters later.
