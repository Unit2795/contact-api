import type { APIGatewayProxyEventV2 as Event, APIGatewayProxyStructuredResultV2 as Result } from "aws-lambda";
import { config, type FormConfig } from "./config";
import { decodeBody, isHoneypotTripped, MAX_BODY_BYTES, parseFields, validate } from "./contact";
import { failure, plain, type Reason, success, wantsJson } from "./http";
import { consumeFormMonthly, consumeIpDaily } from "./limits";
import { sendMail } from "./mail";
import { resolveSite, SITE_HEADER } from "./site";
import { issueStamp, readCookie, STAMP_COOKIE, stampCookie, verifyStamp } from "./stamp";

const HMAC_SECRET = requireEnv("HMAC_SECRET");
const SITE_KEYS: Record<string, string> = JSON.parse(requireEnv("SITE_KEYS"));

const STAMP_PATH = "/api/stamp.gif";
const CONTACT_PATH = /^\/api\/contact\/([a-z0-9-]+)$/;
const PIXEL = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

export async function handler(event: Event): Promise<Result> {
	const site = resolveSite(event.headers[SITE_HEADER], SITE_KEYS);
	if (!site) return plain(403);

	const { method } = event.requestContext.http;
	if (method === "GET" && event.rawPath === STAMP_PATH) return stamp(site);

	const formId = CONTACT_PATH.exec(event.rawPath)?.[1];
	const form = formId ? config.forms[formId] : undefined;
	if (method === "POST" && form?.site === site) return contact(event, form);

	return plain(404);
}

function stamp(site: string): Result {
	return {
		statusCode: 200,
		headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" },
		cookies: [stampCookie(issueStamp(HMAC_SECRET, site), config.stamp.maxDwellSec)],
		body: PIXEL,
		isBase64Encoded: true,
	};
}

// Checks run cheapest first; nothing touches AWS until the submission is known to be valid.
async function contact(event: Event, form: FormConfig): Promise<Result> {
	const json = wantsJson(event.headers.accept);
	const meta = { ip: viewerIp(event), userAgent: event.headers["user-agent"] ?? "" };
	const reject = (reason: Reason) => {
		log(reason, form, meta.ip);
		return failure(form, json, reason);
	};

	const body = decodeBody(event.body, event.isBase64Encoded);
	if (Buffer.byteLength(body) > MAX_BODY_BYTES) return reject("too_large");

	const fields = parseFields(body, event.headers["content-type"]);
	if (!fields) return reject("bad_request");

	// Pretend success so bots learn nothing.
	if (isHoneypotTripped(fields, form)) {
		log("honeypot", form, meta.ip);
		return success(form, json);
	}

	const stampFailure = verifyStamp(readCookie(event.cookies, STAMP_COOKIE), HMAC_SECRET, form.site, config.stamp);
	if (stampFailure) return reject(stampFailure);

	const result = validate(fields, form);
	if (!result.ok) return reject(result.reason);

	try {
		// Per-IP first, so one abuser exhausts their own budget before the form's monthly cap.
		if (!(await consumeIpDaily(form, meta.ip))) return reject("ip_limit");
		if (!(await consumeFormMonthly(form))) return reject("form_limit");
		await sendMail(form, result.submission, meta);
	} catch (error) {
		console.error(error);
		return reject("server_error");
	}

	log("sent", form, meta.ip);
	return success(form, json);
}

// Behind a proxy, sourceIp is the proxy. Non-CloudFront proxies are set up to overwrite X-Real-IP with the client IP;
// CloudFront strips a viewer-sent X-Real-IP and sends CloudFront-Viewer-Address as `ip:port` instead.
function viewerIp(event: Event): string {
	const realIp = event.headers["x-real-ip"];
	if (realIp) return realIp;
	const viewer = event.headers["cloudfront-viewer-address"];
	return viewer ? viewer.slice(0, viewer.lastIndexOf(":")) : event.requestContext.http.sourceIp;
}

// Fail at cold start rather than, say, signing stamps with an empty secret.
function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing env var ${name}`);
	return value;
}

function log(outcome: string, form: FormConfig, ip: string): void {
	console.log(JSON.stringify({ outcome, form: form.id, site: form.site, ip }));
}
