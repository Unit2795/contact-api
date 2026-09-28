import { z } from "zod";
import raw from "../forms.json";

const slug = z.string().regex(/^[a-z0-9-]+$/, "use only a-z, 0-9 and -");
const email = z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address");
const redirect = z.string().regex(/^(\/|https:\/\/)/, "must start with / or https://");
const count = z.int().positive();

// Fields a form can set itself or inherit from `defaults`. The optional ones fall back to these code defaults.
const inheritable = {
	from: email,
	honeypots: z.array(z.string()).min(1),
	extraFields: z.array(z.string()).default([]),
	messageMin: count.default(12),
	messageMax: count.default(2000),
	monthlyCap: count.default(50),
	ipDailyCap: count.default(3),
};

// Strict, so a misspelled key fails instead of being ignored in favor of the default.
const Form = z
	.strictObject({ site: slug, to: email, subject: z.string().trim().min(1), successUrl: redirect, errorUrl: redirect, ...inheritable })
	.refine((form) => form.messageMax > form.messageMin, { message: "must be greater than messageMin", path: ["messageMax"] })
	.refine((form) => !form.honeypots.some((name) => ["email", "message", ...form.extraFields].includes(name)), {
		message: "must not reuse email, message or an extraFields name",
		path: ["honeypots"],
	});

// Each form is validated with `defaults` merged underneath it, so `defaults` is checked through the forms.
function mergeDefaults(input: any) {
	const { defaults, forms, ...rest } = input;
	return { ...rest, forms: Object.fromEntries(Object.entries(forms ?? {}).map(([id, form]) => [id, { ...defaults, ...(form as object) }])) };
}

const Config = z.preprocess(
	mergeDefaults,
	z
		.strictObject({
			stamp: z
				.strictObject({ minDwellSec: count, maxDwellSec: count })
				.refine((stamp) => stamp.maxDwellSec > stamp.minDwellSec, { message: "maxDwellSec must be greater than minDwellSec" }),
			sites: z.array(slug).min(1),
			forms: z.record(slug, Form).transform((forms) => Object.fromEntries(Object.entries(forms).map(([id, form]) => [id, { ...form, id }]))),
		})
		.superRefine((config, ctx) => {
			for (const [id, form] of Object.entries(config.forms)) {
				if (!config.sites.includes(form.site)) ctx.addIssue({ code: "custom", message: `"${form.site}" is not in sites`, path: ["forms", id, "site"] });
			}
		}),
);

export type Config = z.infer<typeof Config>;
export type FormConfig = Config["forms"][string];
export type StampConfig = Config["stamp"];

export function loadConfig(input: unknown): Config {
	const result = Config.safeParse(input);
	if (!result.success) throw new Error(`forms.json is invalid:\n${z.prettifyError(result.error)}`);
	return result.data;
}

export const config = loadConfig(raw);
