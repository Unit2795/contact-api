import type { APIGatewayProxyStructuredResultV2 as Result } from "aws-lambda";
import type { FormConfig } from "./config";
import type { ValidationFailure } from "./contact";
import type { StampFailure } from "./stamp";

export type Reason =
	| "too_large"
	| "bad_request"
	| StampFailure
	| ValidationFailure
	| "ip_limit"
	| "form_limit"
	| "server_error";

const STATUS: Record<Reason, number> = {
	too_large: 413,
	bad_request: 400,
	stamp_missing: 400,
	stamp_invalid: 400,
	too_soon: 400,
	stamp_expired: 400,
	invalid_email: 400,
	invalid_message: 400,
	invalid_field: 400,
	ip_limit: 429,
	form_limit: 429,
	server_error: 500,
};

const NO_STORE = { "Cache-Control": "no-store" };

// JS clients opt into JSON with `Accept: application/json`; everything else is a plain form post.
export function wantsJson(accept: string | undefined): boolean {
	return !!accept?.includes("application/json");
}

export function success(form: FormConfig, json: boolean): Result {
	if (json) return jsonResult(200, { ok: true });
	return redirect(form.successUrl);
}

export function failure(form: FormConfig, json: boolean, reason: Reason): Result {
	if (json) return jsonResult(STATUS[reason], { ok: false, reason });
	const separator = form.errorUrl.includes("?") ? "&" : "?";
	return redirect(`${form.errorUrl}${separator}reason=${reason}`);
}

// For requests that never resolved to a form (bad site key, unknown form): no redirect target exists.
export function plain(statusCode: number): Result {
	return { statusCode, headers: NO_STORE };
}

function jsonResult(statusCode: number, body: object): Result {
	return { statusCode, headers: { ...NO_STORE, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function redirect(location: string): Result {
	return { statusCode: 303, headers: { ...NO_STORE, Location: location } };
}
