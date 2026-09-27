import { describe, expect, it } from "vitest";
import { failure, plain, success, wantsJson } from "../src/http";
import { form } from "./fixtures";

describe("http", () => {
	it("detects JSON clients by Accept", () => {
		expect(wantsJson("application/json")).toBe(true);
		expect(wantsJson("text/html,application/xhtml+xml")).toBe(false);
		expect(wantsJson(undefined)).toBe(false);
	});

	it("redirects no-JS posts with 303", () => {
		expect(success(form, false)).toMatchObject({ statusCode: 303, headers: { Location: "/thanks" } });
		expect(failure(form, false, "too_soon")).toMatchObject({
			statusCode: 303,
			headers: { Location: "/oops?reason=too_soon" },
		});
		expect(failure({ ...form, errorUrl: "/oops?lang=en" }, false, "ip_limit").headers?.Location).toBe(
			"/oops?lang=en&reason=ip_limit",
		);
	});

	it("returns JSON with a status per reason", () => {
		expect(success(form, true)).toMatchObject({ statusCode: 200, body: JSON.stringify({ ok: true }) });
		expect(failure(form, true, "ip_limit")).toMatchObject({
			statusCode: 429,
			body: JSON.stringify({ ok: false, reason: "ip_limit" }),
		});
		expect(failure(form, true, "too_large").statusCode).toBe(413);
		expect(failure(form, true, "server_error").statusCode).toBe(500);
	});

	it("returns bodiless plain responses", () => {
		expect(plain(403)).toEqual({ statusCode: 403, headers: { "Cache-Control": "no-store" } });
	});
});
