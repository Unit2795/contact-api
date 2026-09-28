import { timingSafeEqual } from "node:crypto";

// Each site's proxy injects its own secret in this header, overwriting any viewer-sent value.
// It identifies the site and rejects anything that didn't come through a configured proxy.
export const SITE_HEADER = "x-contact-site-key";

export function resolveSite(key: string | undefined, siteKeys: Record<string, string>): string | null {
	if (!key) return null;
	const given = Buffer.from(key);
	for (const [site, expected] of Object.entries(siteKeys)) {
		const candidate = Buffer.from(expected);
		if (candidate.length === given.length && timingSafeEqual(candidate, given)) return site;
	}
	return null;
}
