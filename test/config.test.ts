import { describe, expect, it } from "vitest";
import { config, loadConfig } from "../src/config";

const SLUG = /^[a-z0-9-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_LIKE = /^(\/|https:\/\/)/;

const DEFAULTS = {
	from: "a@x.com",
	honeypots: ["hp"],
	extraFields: [],
	messageMin: 1,
	messageMax: 10,
	monthlyCap: 5,
	ipDailyCap: 1,
};
const FORM = { site: "s", to: "b@x.com", subject: "S", successUrl: "/ok", errorUrl: "/err" };

function load(form: Record<string, unknown>) {
	const stamp = { minDwellSec: 1, maxDwellSec: 2 };
	return loadConfig({ stamp, defaults: DEFAULTS, sites: ["s"], forms: { f: form as never } });
}

describe("loadConfig", () => {
	it("merges defaults under each form and adds its id", () => {
		const form = load({ ...FORM, monthlyCap: 9 }).forms.f;
		expect(form).toMatchObject({ id: "f", from: "a@x.com", monthlyCap: 9, ipDailyCap: 1 });
	});

	it("rejects misspelled form keys instead of silently using the default", () => {
		expect(() => load({ ...FORM, ipDailycap: 10 })).toThrow('form "f" has unknown keys: ipDailycap');
	});
});

// Guards the real forms.json so a bad edit fails tests instead of production.
describe("forms.json", () => {
	it("has valid stamp windows", () => {
		expect(config.stamp.minDwellSec).toBeGreaterThan(0);
		expect(config.stamp.maxDwellSec).toBeGreaterThan(config.stamp.minDwellSec);
	});

	it("uses slug site ids", () => {
		for (const site of config.sites) expect(site).toMatch(SLUG);
	});

	for (const form of Object.values(config.forms)) {
		describe(form.id, () => {
			it("belongs to a known site and has a slug id", () => {
				expect(form.id).toMatch(SLUG);
				expect(config.sites).toContain(form.site);
			});

			it("has valid addresses and redirects", () => {
				expect(form.to).toMatch(EMAIL);
				expect(form.from).toMatch(EMAIL);
				expect(form.subject.trim()).not.toBe("");
				expect(form.successUrl).toMatch(URL_LIKE);
				expect(form.errorUrl).toMatch(URL_LIKE);
			});

			it("has honeypots that don't collide with real fields", () => {
				expect(form.honeypots.length).toBeGreaterThan(0);
				const real = ["email", "message", ...form.extraFields];
				for (const hp of form.honeypots) expect(real).not.toContain(hp);
			});

			it("has sane limits", () => {
				expect(form.messageMin).toBeGreaterThan(0);
				expect(form.messageMax).toBeGreaterThan(form.messageMin);
				expect(Number.isInteger(form.monthlyCap) && form.monthlyCap > 0).toBe(true);
				expect(Number.isInteger(form.ipDailyCap) && form.ipDailyCap > 0).toBe(true);
			});
		});
	}
});
