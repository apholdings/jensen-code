/**
 * Deterministic canonical JSON serialization.
 *
 * Produces stable, reproducible JSON output suitable for
 * cryptographic digest computation.
 *
 * Rules:
 *   - Object keys sorted lexicographically by UTF-16 code unit
 *   - Arrays preserved in their semantic order (not sorted)
 *   - No trailing whitespace
 *   - No platform-dependent formatting
 *   - UTF-8 encoding
 */

/**
 * Serialize a value to deterministic canonical JSON.
 */
export function toCanonicalJson(value: unknown): string {
	return serializeValue(value);
}

function serializeValue(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return serializeNumber(value);
	if (typeof value === "string") return serializeString(value);
	if (Array.isArray(value)) return serializeArray(value);
	if (typeof value === "object") return serializeObject(value as Record<string, unknown>);

	throw new Error(`Cannot serialize value of type ${typeof value}`);
}

function serializeNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new Error(`Cannot serialize non-finite number: ${value}`);
	}
	// Use JSON-compatible number serialization
	// This ensures NaN/Infinity are rejected
	return JSON.stringify(value);
}

function serializeString(value: string): string {
	return JSON.stringify(value);
}

function serializeArray(value: unknown[]): string {
	const items = value.map((item) => serializeValue(item)).join(",");
	return `[${items}]`;
}

function serializeObject(value: Record<string, unknown>): string {
	const keys = Object.keys(value).sort();
	const pairs = keys.map((key) => `${serializeString(key)}:${serializeValue(value[key])}`);
	return `{${pairs.join(",")}}`;
}
