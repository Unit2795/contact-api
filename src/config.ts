import raw from "../forms.json";

export interface StampConfig {
	minDwellSec: number;
	maxDwellSec: number;
}

export interface FormConfig {
	id: string;
	site: string;
	to: string;
	from: string;
	subject: string;
	successUrl: string;
	errorUrl: string;
	honeypots: string[];
	extraFields: string[];
	messageMin: number;
	messageMax: number;
	monthlyCap: number;
	ipDailyCap: number;
}

type FormDefaults = Omit<FormConfig, "id" | "site" | "to" | "subject" | "successUrl" | "errorUrl">;
type FormEntry = Partial<FormDefaults> & Pick<FormConfig, "site" | "to" | "subject" | "successUrl" | "errorUrl">;

export interface RawConfig {
	stamp: StampConfig;
	defaults: FormDefaults;
	sites: string[];
	forms: Record<string, FormEntry>;
}

export interface Config {
	stamp: StampConfig;
	sites: string[];
	forms: Record<string, FormConfig>;
}

const REQUIRED_FORM_KEYS = ["site", "to", "subject", "successUrl", "errorUrl"];

export function loadConfig(input: RawConfig): Config {
	// A misspelled key would otherwise be ignored and the default used, so reject anything unrecognized.
	const allowedKeys = new Set([...REQUIRED_FORM_KEYS, ...Object.keys(input.defaults)]);
	const forms: Record<string, FormConfig> = {};
	for (const [id, entry] of Object.entries(input.forms)) {
		const unknown = Object.keys(entry).filter((key) => !allowedKeys.has(key));
		if (unknown.length) throw new Error(`forms.json: form "${id}" has unknown keys: ${unknown.join(", ")}`);
		forms[id] = { ...input.defaults, ...entry, id };
	}
	return { stamp: input.stamp, sites: input.sites, forms };
}

export const config = loadConfig(raw);
