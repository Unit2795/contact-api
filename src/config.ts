import { z } from "zod";
import raw from "../forms.json";

const slug = z.string().regex(/^[a-z0-9-]+$/, "use only a-z, 0-9 and -");
const email = z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address");
const redirect = z.string().regex(/^(\/|https:\/\/)/, "must start with / or https://");
const positiveInt = z.int().positive();

// Fields usually shared through defaults, though any form field can be set there. Those with .default() use that value when neither the form nor defaults sets them.
const inheritable = {
	from: email,
	honeypots: z.array(z.string()).min(1),
	extraFields: z.array(z.string()).default([]),
	messageMin: positiveInt.default(12),
	messageMax: positiveInt.default(2000),
	monthlyCap: positiveInt.default(50),
	ipDailyCap: positiveInt.default(3),
};

// Strict, so a misspelled key fails instead of being ignored in favor of the default.
const Form = z
	.strictObject({
		site: slug,
		to: email,
		subject: z.string().trim().min(1),
		successUrl: redirect,
		errorUrl: redirect,
		...inheritable,
	})
	.refine((form) => form.messageMax > form.messageMin, { message: "must be greater than messageMin", path: ["messageMax"] })
	.refine((form) => !form.honeypots.some((name) => ["email", "message", ...form.extraFields].includes(name)), {
		message: "must not reuse email, message or an extraFields name",
		path: ["honeypots"],
	});

/*
 * defaults has no schema of its own. It is merged under each form before validation, so a bad default is reported on every form that inherits it.
 * The parameter type covers only the two keys read here; the schema below validates the whole result.
 */
function mergeDefaults(input: { defaults?: object; forms?: Record<string, object> }) {
	const { defaults, forms, ...rest } = input;
	const mergedForms = Object.fromEntries(Object.entries(forms ?? {}).map(([id, form]) => [id, { ...defaults, ...form }]));
	return { ...rest, forms: mergedForms };
}

const Config = z.preprocess(
	mergeDefaults,
	z
		.strictObject({
			stamp: z
				.strictObject({ minDwellSec: positiveInt, maxDwellSec: positiveInt })
				.refine((stamp) => stamp.maxDwellSec > stamp.minDwellSec, { message: "maxDwellSec must be greater than minDwellSec" }),
			sites: z.array(slug).min(1),
			forms: z.record(slug, Form).transform((forms) => Object.fromEntries(Object.entries(forms).map(([id, form]) => [id, { ...form, id }]))),
		})
		.superRefine((config, ctx) => {
			for (const [id, form] of Object.entries(config.forms)) {
				if (config.sites.includes(form.site)) continue;
				ctx.addIssue({ code: "custom", message: `"${form.site}" is not in sites`, path: ["forms", id, "site"] });
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
