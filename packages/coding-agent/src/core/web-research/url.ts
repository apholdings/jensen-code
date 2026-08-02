const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);

export function sanitizeUrlForDiagnostics(value: string): string {
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		for (const key of [...url.searchParams.keys()]) {
			if (/token|key|secret|auth|password|signature/i.test(key)) url.searchParams.set(key, "[REDACTED]");
		}
		return url.toString();
	} catch {
		return "[invalid URL]";
	}
}

export function canonicalizeWebUrl(value: string): string {
	const url = new URL(value);
	url.hash = "";
	url.hostname = url.hostname.toLowerCase();
	if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
		url.port = "";
	}
	const entries = [...url.searchParams.entries()]
		.filter(([key]) => !key.toLowerCase().startsWith("utm_") && !TRACKING_PARAMETERS.has(key.toLowerCase()))
		.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
			leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
		);
	url.search = "";
	for (const [key, valuePart] of entries) url.searchParams.append(key, valuePart);
	if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
	return url.toString();
}

export function normalizeDomain(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^www\./, "")
		.replace(/\.$/, "");
}
