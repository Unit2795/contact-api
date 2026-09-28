# Contact API AI Guide

Centralized contact-form API: one Lambda (Function URL) + DynamoDB rate limits + SES, reached through each site's CloudFront. Docs:

- `README.md`: what it is, the design and request checks, development, e2e testing and releasing.
- `docs/deploy.md`: the config-repo deployment model, prerequisites, action inputs, secret rotation, removal and troubleshooting.
- `docs/connect.md`: CloudFront wiring, the HTML form, the JS enhancement and reason codes.
- `docs/config.md`: the `forms.json` fields, validation rules and rate-limit behavior.

This repo is public and holds code only. Deployments run from private config repos that pin a release tag of the composite action in `action.yml`. Never commit real config, secrets, Function URLs or `.env`. `forms.json` and `terraform/state.config` are gitignored local copies; the committed templates are `forms.example.json` and `terraform/state.config.example`.

A config repo may sit in a sibling directory; you can recognize it by a deploy workflow that uses `Unit2795/contact-api@vX.Y.Z`. If one exists, read its AGENTS.md for deployment details: live config, AWS access and e2e setup.

## Commands

- `pnpm test` / `pnpm typecheck` / `pnpm build`. These need a local `forms.json`; copy `forms.example.json` if it's missing.
- `pnpm e2e`: safe checks against a **deployed** API. It sends no email and uses no quota. It needs `CONTACT_URL` and `CONTACT_SITE_KEY`, from `.env` (see `.env.example`) or from plain environment variables, and a local `forms.json` matching that deployment; if any is missing, ask the user. Never print or log `CONTACT_SITE_KEY`.
- `pnpm e2e --send`: also does one real submission. That emails the form's recipient and uses 1 of the form's daily per-client quota (`ipDailyCap`, 3 by default) and 1 of its `monthlyCap`. Only run it when the user asks, or to verify a change to sending, limits or the stamp.

## Changes

- A config format change must update `forms.example.json` in the same change. CI validates the action against it.
- New config options get a code default in the schema in `src/config.ts`, so existing configs keep working. Anything that would make an existing config invalid is a breaking change: it needs a major version bump and migration notes.
- Renaming or restructuring a Terraform resource is a breaking change unless a `moved` block keeps the old address. Without one, Terraform destroys and recreates it. For `random_password.site_key`, that gives every site a new key and breaks its CDN until the site redeploys.
- Never deploy from here, and never run `terraform apply` locally. The rotation and removal steps in `docs/deploy.md` are for the maintainer to run.
