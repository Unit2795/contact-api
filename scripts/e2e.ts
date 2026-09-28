// End-to-end checks against the deployed Function URL (bypasses the site's proxy).
// Safe by default: sends no email and uses no rate-limit quota.
// `--send` adds one real submission: emails the form's recipient and uses 1 of the form's daily per-client quota and 1 of its monthly quota.
// Config comes from .env (see .env.example) or the environment.
import { readFileSync } from "node:fs";

const url = process.env.CONTACT_URL?.replace(/\/$/, "");
const key = process.env.CONTACT_SITE_KEY;
if (!url || !key) {
	console.error("Set CONTACT_URL and CONTACT_SITE_KEY in .env (see .env.example).");
	process.exit(1);
}

const config = JSON.parse(readFileSync(new URL("../forms.json", import.meta.url), "utf8"));
const formId: string = process.env.CONTACT_FORM ?? Object.keys(config.forms)[0];
const form = { ...config.defaults, ...config.forms[formId] };
const send = process.argv.includes("--send");

let failures = 0;
function check(name: string, pass: boolean, detail: string): void {
	console.log(`${pass ? "✅" : "❌"} ${name} (${detail})`);
	if (!pass) failures++;
}

const siteHeaders = { "x-contact-site-key": key };

const noKey = await fetch(`${url}/api/stamp.gif`);
check("No site key -> 403", noKey.status === 403, `got ${noKey.status}`);

const stamp = await fetch(`${url}/api/stamp.gif`, { headers: siteHeaders });
const cookie = stamp.headers.getSetCookie().find((c) => c.startsWith("stamp="))?.split(";")[0];
check(
	"Stamp -> 200 + cookie",
	stamp.status === 200 && !!cookie,
	`got ${stamp.status}, cookie ${cookie ? "set" : "missing"}`,
);

function submit(fields: Record<string, string>, json: boolean): Promise<Response> {
	return fetch(`${url}/api/contact/${formId}`, {
		method: "POST",
		redirect: "manual",
		headers: { ...siteHeaders, cookie: cookie ?? "", ...(json ? { accept: "application/json" } : {}) },
		body: new URLSearchParams({
			email: "e2e-test@example.com",
			message: "End-to-end test from scripts/e2e.ts",
			...fields,
		}),
	});
}

// An empty email can never be sent, so this stays safe even if the dwell time has somehow passed.
// The stamp is checked before the email, so the expected result is still too_soon.
const early = await submit({ email: "" }, true);
const earlyBody = await early.text();
check(
	"Instant submit -> too_soon",
	early.status === 400 && earlyBody.includes("too_soon"),
	`got ${early.status} ${earlyBody}`,
);

const honeypot = await submit({ [form.honeypots[0]]: "spam" }, false);
const location = honeypot.headers.get("location");
check(
	"Honeypot, no-JS -> fake success redirect",
	honeypot.status === 303 && location === form.successUrl,
	`got ${honeypot.status} -> ${location}`,
);

if (send) {
	const waitSec = config.stamp.minDwellSec + 1;
	console.log(`… waiting ${waitSec}s for the dwell window`);
	await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
	const real = await submit({}, true);
	const realBody = await real.text();
	check(
		`Real submit -> sent to ${form.to}`,
		real.status === 200 && realBody === '{"ok":true}',
		`got ${real.status} ${realBody}`,
	);
} else {
	console.log("ℹ️  Skipped real send (add --send; emails the recipient, uses daily and monthly quota)");
}

process.exitCode = failures ? 1 : 0;
