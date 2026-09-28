import type { APIGatewayProxyEventV2 as Event } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../src/handler";
import { consumeFormMonthly, consumeIpDaily } from "../src/limits";
import { sendMail } from "../src/mail";
import { issueStamp } from "../src/stamp";
import { form } from "./fixtures";

vi.hoisted(() => {
	process.env.HMAC_SECRET = "test-secret";
	process.env.SITE_KEYS = JSON.stringify({ "test-site": "key-a", "other-site": "key-b" });
});

vi.mock("../src/config", async () => {
	const { form } = await import("./fixtures");
	return {
		config: {
			stamp: { minDwellSec: 15, maxDwellSec: 3600 },
			sites: ["test-site", "other-site"],
			forms: { [form.id]: form, "other-form": { ...form, id: "other-form", site: "other-site" } },
		},
	};
});
vi.mock("../src/limits");
vi.mock("../src/mail");

const VALID_BODY = "email=someone%40example.com&message=Hello%2C+this+is+a+real+message.&website=";

function freshStamp(ageMs = 20_000): string {
	return `stamp=${issueStamp("test-secret", "test-site", Date.now() - ageMs)}`;
}

function request({
	method = "POST",
	path = `/api/contact/${form.id}`,
	siteKey = "key-a",
	headers = {},
	cookies = [freshStamp()],
	body = VALID_BODY,
	isBase64Encoded = false,
}: {
	method?: string;
	path?: string;
	siteKey?: string | null;
	headers?: Record<string, string>;
	cookies?: string[];
	body?: string;
	isBase64Encoded?: boolean;
} = {}): Event {
	return {
		rawPath: path,
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"user-agent": "test-agent",
			"cloudfront-viewer-address": "203.0.113.7:51234",
			...(siteKey ? { "x-contact-site-key": siteKey } : {}),
			...headers,
		},
		cookies,
		body,
		isBase64Encoded,
		requestContext: { http: { method, path, sourceIp: "10.0.0.1" } },
	} as unknown as Event;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(consumeIpDaily).mockResolvedValue(true);
	vi.mocked(consumeFormMonthly).mockResolvedValue(true);
	vi.mocked(sendMail).mockResolvedValue();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("site key", () => {
	it("rejects requests without a valid site key", async () => {
		expect((await handler(request({ siteKey: null }))).statusCode).toBe(403);
		expect((await handler(request({ siteKey: "wrong" }))).statusCode).toBe(403);
	});
});

describe("routing", () => {
	it("404s unknown routes, unknown forms, and forms of another site", async () => {
		expect((await handler(request({ path: "/api/nope" }))).statusCode).toBe(404);
		expect((await handler(request({ path: "/api/contact/missing" }))).statusCode).toBe(404);
		expect((await handler(request({ path: "/api/contact/other-form" }))).statusCode).toBe(404);
		expect((await handler(request({ method: "GET" }))).statusCode).toBe(404);
	});
});

describe("GET /api/stamp.gif", () => {
	it("returns a GIF and a site-bound stamp cookie", async () => {
		const res = await handler(request({ method: "GET", path: "/api/stamp.gif" }));
		expect(res).toMatchObject({ statusCode: 200, isBase64Encoded: true, headers: { "Content-Type": "image/gif" } });
		expect(res.cookies?.[0]).toMatch(/^stamp=\d+\.[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600$/);
	});
});

describe("POST /api/contact/:form", () => {
	it("sends and redirects a valid no-JS post", async () => {
		const res = await handler(request());
		expect(res).toMatchObject({ statusCode: 303, headers: { Location: "/thanks" } });
		expect(consumeIpDaily).toHaveBeenCalledWith(form, "203.0.113.7");
		expect(sendMail).toHaveBeenCalledWith(
			form,
			{ email: "someone@example.com", message: "Hello, this is a real message.", extra: {} },
			{ ip: "203.0.113.7", userAgent: "test-agent" },
		);
	});

	it("answers JSON clients with JSON, including base64 bodies", async () => {
		const res = await handler(
			request({
				headers: { accept: "application/json" },
				body: Buffer.from(VALID_BODY).toString("base64"),
				isBase64Encoded: true,
			}),
		);
		expect(res).toMatchObject({ statusCode: 200, body: JSON.stringify({ ok: true }) });
		expect(sendMail).toHaveBeenCalledOnce();
	});

	it("fakes success on a honeypot hit without touching AWS", async () => {
		const res = await handler(request({ body: `${VALID_BODY}http://spam`, cookies: [] }));
		expect(res).toMatchObject({ statusCode: 303, headers: { Location: "/thanks" } });
		expect(consumeIpDaily).not.toHaveBeenCalled();
		expect(sendMail).not.toHaveBeenCalled();
	});

	it.each([
		["stamp_missing", { cookies: [] }],
		["too_soon", { cookies: [freshStamp(5_000)] }],
		["stamp_invalid", { cookies: ["stamp=123.bad"] }],
		["invalid_email", { body: "email=nope&message=Hello%2C+this+is+a+real+message." }],
		["invalid_message", { body: "email=someone%40example.com&message=hi" }],
		["too_large", { body: "x".repeat(40_000) }],
		["bad_request", { headers: { "content-type": "application/json" }, body: "{nope" }],
	])("rejects %s before touching AWS", async (reason, overrides) => {
		const res = await handler(request(overrides));
		expect(res.headers?.Location).toBe(`/oops?reason=${reason}`);
		expect(consumeIpDaily).not.toHaveBeenCalled();
		expect(sendMail).not.toHaveBeenCalled();
	});

	it("stops at the per-IP limit without consuming the form's monthly cap", async () => {
		vi.mocked(consumeIpDaily).mockResolvedValue(false);
		const res = await handler(request({ headers: { accept: "application/json" } }));
		expect(res).toMatchObject({ statusCode: 429, body: JSON.stringify({ ok: false, reason: "ip_limit" }) });
		expect(consumeFormMonthly).not.toHaveBeenCalled();
		expect(sendMail).not.toHaveBeenCalled();
	});

	it("stops at the monthly form limit", async () => {
		vi.mocked(consumeFormMonthly).mockResolvedValue(false);
		const res = await handler(request());
		expect(res.headers?.Location).toBe("/oops?reason=form_limit");
		expect(sendMail).not.toHaveBeenCalled();
	});

	it("reports server_error when SES fails", async () => {
		vi.mocked(sendMail).mockRejectedValue(new Error("SES down"));
		const res = await handler(request());
		expect(res.headers?.Location).toBe("/oops?reason=server_error");
	});

	it("takes the viewer IP from X-Real-IP, then CloudFront, including IPv6, falling back to sourceIp", async () => {
		await handler(request({ headers: { "x-real-ip": "198.51.100.9" } }));
		expect(consumeIpDaily).toHaveBeenLastCalledWith(form, "198.51.100.9");

		await handler(request({ headers: { "cloudfront-viewer-address": "2001:db8::1:443" } }));
		expect(consumeIpDaily).toHaveBeenLastCalledWith(form, "2001:db8::1");

		const noViewer = request();
		delete noViewer.headers["cloudfront-viewer-address"];
		await handler(noViewer);
		expect(consumeIpDaily).toHaveBeenLastCalledWith(form, "10.0.0.1");
	});
});
