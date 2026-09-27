import { createHmac, timingSafeEqual } from "node:crypto";
import type { StampConfig } from "./config";

// Dwell-time stamp: `<issuedAtMs>.<hmac(site.issuedAtMs)>`, set as a first-party cookie by a 1x1 GIF.
// Binding the site into the signature stops a stamp from one site being replayed on another.

export const STAMP_COOKIE = "stamp";

export type StampFailure = "stamp_missing" | "stamp_invalid" | "too_soon" | "stamp_expired";

function sign(secret: string, site: string, issuedAt: string): string {
	return createHmac("sha256", secret).update(`${site}.${issuedAt}`).digest("base64url");
}

export function issueStamp(secret: string, site: string, now = Date.now()): string {
	const issuedAt = String(now);
	return `${issuedAt}.${sign(secret, site, issuedAt)}`;
}

export function stampCookie(value: string, maxAgeSec: number): string {
	return `${STAMP_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

export function readCookie(cookies: string[] | undefined, name: string): string | undefined {
	const prefix = `${name}=`;
	return cookies?.find((c) => c.startsWith(prefix))?.slice(prefix.length);
}

export function verifyStamp(
	value: string | undefined,
	secret: string,
	site: string,
	{ minDwellSec, maxDwellSec }: StampConfig,
	now = Date.now(),
): StampFailure | null {
	if (!value) return "stamp_missing";

	const [issuedAt, signature] = value.split(".");
	if (!issuedAt || !signature || !/^\d+$/.test(issuedAt)) return "stamp_invalid";

	const expected = Buffer.from(sign(secret, site, issuedAt));
	const actual = Buffer.from(signature);
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return "stamp_invalid";

	const ageSec = (now - Number(issuedAt)) / 1000;
	if (ageSec < minDwellSec) return "too_soon";
	if (ageSec > maxDwellSec) return "stamp_expired";

	return null;
}
