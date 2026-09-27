import type { FormConfig } from "../src/config";

export const form: FormConfig = {
	id: "test-form",
	site: "test-site",
	to: "owner@example.com",
	from: "forms@example.com",
	subject: "Test",
	successUrl: "/thanks",
	errorUrl: "/oops",
	honeypots: ["website"],
	extraFields: ["name"],
	messageMin: 12,
	messageMax: 100,
	monthlyCap: 5,
	ipDailyCap: 2,
};
