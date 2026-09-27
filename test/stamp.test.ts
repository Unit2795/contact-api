import { describe, expect, it } from "vitest";
import { issueStamp, readCookie, stampCookie, verifyStamp } from "../src/stamp";

const SECRET = "test-secret";
const WINDOW = { minDwellSec: 15, maxDwellSec: 3600 };
const T0 = 1_700_000_000_000;
const LATER = T0 + 20_000;

describe("stamp", () => {
	const stamp = issueStamp(SECRET, "site-a", T0);

	it("accepts a stamp inside the dwell window", () => {
		expect(verifyStamp(stamp, SECRET, "site-a", WINDOW, LATER)).toBeNull();
	});

	it("rejects too soon and expired", () => {
		expect(verifyStamp(stamp, SECRET, "site-a", WINDOW, T0 + 14_000)).toBe("too_soon");
		expect(verifyStamp(stamp, SECRET, "site-a", WINDOW, T0 + 3_601_000)).toBe("stamp_expired");
	});

	it("rejects missing, malformed and tampered stamps", () => {
		const [, signature] = stamp.split(".");
		expect(verifyStamp(undefined, SECRET, "site-a", WINDOW, LATER)).toBe("stamp_missing");
		expect(verifyStamp("garbage", SECRET, "site-a", WINDOW, LATER)).toBe("stamp_invalid");
		expect(verifyStamp(`${T0 - 60_000}.${signature}`, SECRET, "site-a", WINDOW, LATER)).toBe("stamp_invalid");
		expect(verifyStamp(`${stamp}x`, SECRET, "site-a", WINDOW, LATER)).toBe("stamp_invalid");
	});

	it("rejects a stamp from another site or secret", () => {
		expect(verifyStamp(stamp, SECRET, "site-b", WINDOW, LATER)).toBe("stamp_invalid");
		expect(verifyStamp(stamp, "other-secret", "site-a", WINDOW, LATER)).toBe("stamp_invalid");
	});

	it("builds a first-party cookie that round-trips", () => {
		const cookie = stampCookie(stamp, 3600);
		expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict; Max-Age=3600");
		expect(readCookie(["other=1", cookie.split(";")[0]], "stamp")).toBe(stamp);
		expect(readCookie(undefined, "stamp")).toBeUndefined();
	});
});
