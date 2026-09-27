# contact-api

Centralized contact-form API: one Lambda (Function URL) + DynamoDB rate limits + SES, reached through each site's
CloudFront. README.md covers the design, the `forms.json` schema, reason codes, how a site is connected, and the
config-repo deployment model.

This repo is public and holds code only. Deployments run from private config repos that pin a release tag of the
composite action in `action.yml`. Never commit real config, secrets, Function URLs or `.env`. `forms.json` and
`terraform/state.config` are gitignored local copies; the committed templates are `forms.example.json` and
`terraform/state.config.example`.

If a sibling config repo exists (the maintainer's is `../djoz-contact-api`), read its AGENTS.md for
deployment-specific details: live config, AWS access and e2e setup.

## Commands

- `pnpm test` / `pnpm typecheck` / `pnpm build`. These need a local `forms.json`; copy `forms.example.json` if it's
  missing.
- `pnpm e2e`: safe checks against a **deployed** API. It sends no email and uses no quota. It needs `.env` (see
  `.env.example`) and a local `forms.json` matching that deployment; if either is missing, ask the user. Never print
  or log `CONTACT_SITE_KEY`.
- `pnpm e2e --send`: also does one real submission. That emails the form's recipient and uses 1 of the per-IP daily
  quota (default 3). Only run it when the user asks, or to verify a change to sending, limits or the stamp.

## Changes

- A config format change must update `forms.example.json` in the same change. CI validates the action against it.
- New config options get defaults, so existing configs keep working. Anything that would make an existing config
  invalid is a breaking change: it needs a major version bump and migration notes.
- Never deploy from here, and never run `terraform apply` locally.
