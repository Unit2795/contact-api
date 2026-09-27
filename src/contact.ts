import type { FormConfig } from "./config";

// Generous: a max-length non-ASCII message urlencodes to several times its character count.
export const MAX_BODY_BYTES = 32768;
const EXTRA_FIELD_MAX = 200;
const EMAIL_MAX = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Fields = Record<string, string>;

export type ValidationFailure = "invalid_email" | "invalid_message" | "invalid_field";

export interface Submission {
	email: string;
	message: string;
	extra: Fields;
}

export function decodeBody(body: string | undefined, isBase64Encoded: boolean): string {
	if (!body) return "";
	return isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
}

// Accepts urlencoded (no-JS form posts, and the recommended JS client) or a flat JSON object.
export function parseFields(body: string, contentType: string | undefined): Fields | null {
	if (!contentType?.includes("application/json")) {
		return Object.fromEntries(new URLSearchParams(body));
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

	const fields: Fields = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "string") fields[key] = value;
	}
	return fields;
}

export function isHoneypotTripped(fields: Fields, form: FormConfig): boolean {
	return form.honeypots.some((name) => fields[name]?.trim());
}

export function validate(
	fields: Fields,
	form: FormConfig,
): { ok: true; submission: Submission } | { ok: false; reason: ValidationFailure } {
	const email = fields.email?.trim() ?? "";
	if (email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email)) return { ok: false, reason: "invalid_email" };

	const message = fields.message?.trim() ?? "";
	if (message.length < form.messageMin || message.length > form.messageMax) {
		return { ok: false, reason: "invalid_message" };
	}

	const extra: Fields = {};
	for (const name of form.extraFields) {
		const value = fields[name]?.trim() ?? "";
		if (value.length > EXTRA_FIELD_MAX) return { ok: false, reason: "invalid_field" };
		if (value) extra[name] = value;
	}

	return { ok: true, submission: { email, message, extra } };
}
