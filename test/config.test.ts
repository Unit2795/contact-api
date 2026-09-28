import { describe, expect, it } from "vitest";
import { config, loadConfig } from "../src/config";

const FORM = { site: "s", to: "b@x.com", subject: "S", successUrl: "/ok", errorUrl: "/err", honeypots: ["hp"] };

function load(form: Record<string, unknown>) {
	return loadConfig({ stamp: { minDwellSec: 1, maxDwellSec: 2 }, defaults: { from: "a@x.com" }, sites: ["s"], forms: { f: form } });
}

describe("loadConfig", () => {
	it("merges defaults under each form, fills code defaults and adds its id", () => {
		const form = load({ ...FORM, monthlyCap: 9 }).forms.f;
		expect(form).toMatchObject({ id: "f", from: "a@x.com", monthlyCap: 9, ipDailyCap: 3, extraFields: [] });
	});

	it("rejects misspelled keys instead of silently using the default", () => {
		expect(() => load({ ...FORM, ipDailycap: 10 })).toThrow('Unrecognized key: "ipDailycap"');
	});

	it("names the form and field of an invalid value", () => {
		expect(() => load({ ...FORM, to: "nope" })).toThrow(/must be an email address\s+→ at forms\.f\.to/);
	});

	it("rejects a form whose site isn't listed", () => {
		expect(() => load({ ...FORM, site: "other" })).toThrow('"other" is not in sites');
	});

	it("rejects honeypots that reuse a real field", () => {
		expect(() => load({ ...FORM, honeypots: ["email"] })).toThrow("must not reuse email");
	});
});

// Guards the real forms.json so a bad edit fails tests instead of production.
it("loads the real forms.json", () => {
	expect(Object.keys(config.forms).length).toBeGreaterThan(0);
});
