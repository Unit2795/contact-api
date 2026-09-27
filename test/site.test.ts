import { describe, expect, it } from "vitest";
import { resolveSite } from "../src/site";

const KEYS = { alpha: "key-alpha", beta: "key-beta" };

describe("resolveSite", () => {
	it("maps a known key to its site", () => {
		expect(resolveSite("key-beta", KEYS)).toBe("beta");
	});

	it("rejects missing, unknown and prefix keys", () => {
		expect(resolveSite(undefined, KEYS)).toBeNull();
		expect(resolveSite("", KEYS)).toBeNull();
		expect(resolveSite("key-gamma", KEYS)).toBeNull();
		expect(resolveSite("key-alph", KEYS)).toBeNull();
	});
});
