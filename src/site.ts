import { timingSafeEqual } from "node:crypto";

/*
 * Each site's proxy sets this header to its site key, overwriting any viewer-sent value.
 * The key identifies the site; requests without a valid key, such as ones sent straight to the Function URL, are rejected.
 */
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
