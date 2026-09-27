import { describe, expect, it } from "vitest";
import { decodeBody, isHoneypotTripped, parseFields, validate } from "../src/contact";
import { form } from "./fixtures";

const VALID = { email: "someone@example.com", message: "Hello, this is a real message." };

describe("decodeBody / parseFields", () => {
	it("parses urlencoded bodies, plain or base64", () => {
		const body = "email=a%40b.co&message=hi+there";
		const b64 = Buffer.from(body).toString("base64");
		const expected = { email: "a@b.co", message: "hi there" };
		expect(parseFields(decodeBody(body, false), "application/x-www-form-urlencoded")).toEqual(expected);
		expect(parseFields(decodeBody(b64, true), undefined)).toEqual(expected);
	});

	it("parses flat JSON and drops non-string values", () => {
		expect(parseFields(JSON.stringify({ email: "a@b.co", n: 1, o: {} }), "application/json")).toEqual({
			email: "a@b.co",
		});
	});

	it("returns null for malformed or non-object JSON", () => {
		expect(parseFields("{nope", "application/json")).toBeNull();
		expect(parseFields("[1]", "application/json")).toBeNull();
		expect(parseFields("null", "application/json")).toBeNull();
	});

	it("treats a missing body as empty", () => {
		expect(decodeBody(undefined, false)).toBe("");
	});
});

describe("isHoneypotTripped", () => {
	it("trips only on non-blank honeypot values", () => {
		expect(isHoneypotTripped({ ...VALID }, form)).toBe(false);
		expect(isHoneypotTripped({ ...VALID, website: "  " }, form)).toBe(false);
		expect(isHoneypotTripped({ ...VALID, website: "http://spam" }, form)).toBe(true);
	});
});

describe("validate", () => {
	it("accepts a valid submission, trimming and keeping configured extras only", () => {
		const result = validate({ ...VALID, email: " someone@example.com ", name: " Ann ", junk: "x" }, form);
		expect(result).toEqual({ ok: true, submission: { ...VALID, extra: { name: "Ann" } } });
	});

	it.each([
		["missing", undefined],
		["no domain dot", "a@b"],
		["whitespace", "a b@c.com"],
		["header injection", "a@b.com\r\nBcc: x@y.com"],
		["too long", `${"a".repeat(250)}@b.com`],
	])("rejects email: %s", (_, email) => {
		expect(validate({ ...VALID, email: email as string }, form)).toEqual({ ok: false, reason: "invalid_email" });
	});

	it("rejects messages outside the length bounds", () => {
		expect(validate({ ...VALID, message: "short" }, form)).toEqual({ ok: false, reason: "invalid_message" });
		expect(validate({ ...VALID, message: "x".repeat(101) }, form)).toEqual({ ok: false, reason: "invalid_message" });
	});

	it("rejects oversized extra fields", () => {
		expect(validate({ ...VALID, name: "x".repeat(201) }, form)).toEqual({ ok: false, reason: "invalid_field" });
	});
});
