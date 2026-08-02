import type { LookupAddress } from "node:dns";
import { lookup as defaultLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { WebResearchError } from "./types.js";
import { sanitizeUrlForDiagnostics } from "./url.js";

export type WebDnsResolver = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;

export interface AdministrativeNetworkPolicy {
	/** Host-owned test/administration policy. This value is never accepted from a model tool call. */
	allowPrivateNetwork: true;
	/** Explicit host allowlist; broad private-network access is never inferred. */
	allowedHosts: readonly string[];
}

const INTERNAL_HOST_SUFFIXES = [".internal", ".local", ".localhost", ".home", ".lan"];

function parseIpv4(address: string): number[] | undefined {
	const parts = address.split(".");
	if (parts.length !== 4) return undefined;
	const bytes = parts.map(Number);
	return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : undefined;
}

function mappedIpv4(address: string): string | undefined {
	const normalized = address.toLowerCase();
	if (!normalized.startsWith("::ffff:")) return undefined;
	const suffix = normalized.slice(7);
	if (suffix.includes(".")) return suffix;
	const groups = suffix.split(":");
	if (groups.length !== 2) return undefined;
	const high = Number.parseInt(groups[0], 16);
	const low = Number.parseInt(groups[1], 16);
	if (!Number.isFinite(high) || !Number.isFinite(low)) return undefined;
	return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isBlockedWebAddress(address: string): boolean {
	const mapped = mappedIpv4(address);
	if (mapped) return isBlockedWebAddress(mapped);
	const family = isIP(address);
	if (family === 4) {
		const bytes = parseIpv4(address);
		if (!bytes) return true;
		const [a, b] = bytes;
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 0) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224
		);
	}
	if (family === 6) {
		const value = address.toLowerCase().split("%")[0];
		return (
			value === "::" ||
			value === "::1" ||
			value.startsWith("fc") ||
			value.startsWith("fd") ||
			/^fe[89ab]/.test(value) ||
			value.startsWith("ff")
		);
	}
	return true;
}

export function validateWebUrlSyntax(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new WebResearchError("URL_BLOCKED", "URL must be an absolute HTTP(S) address", {
			cause: error,
			sanitizedUrl: sanitizeUrlForDiagnostics(value),
		});
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new WebResearchError("URL_BLOCKED", `URL scheme ${url.protocol || "(missing)"} is not allowed`, {
			sanitizedUrl: sanitizeUrlForDiagnostics(value),
		});
	}
	if (url.username || url.password) {
		throw new WebResearchError("URL_BLOCKED", "URLs containing credentials are not allowed", {
			sanitizedUrl: sanitizeUrlForDiagnostics(value),
		});
	}
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (
		hostname === "localhost" ||
		hostname === "metadata" ||
		hostname === "metadata.google.internal" ||
		INTERNAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
	) {
		throw new WebResearchError("URL_BLOCKED", "Internal hostnames are not allowed", {
			sanitizedUrl: sanitizeUrlForDiagnostics(value),
		});
	}
	return url;
}

export async function resolveAndValidateWebUrl(
	value: string,
	options: {
		resolver?: WebDnsResolver;
		administrativeNetworkPolicy?: AdministrativeNetworkPolicy;
		signal?: AbortSignal;
	} = {},
): Promise<{ url: URL; addresses: LookupAddress[] }> {
	const url = validateWebUrlSyntax(value);
	const resolver: WebDnsResolver =
		options.resolver ?? ((hostname, lookupOptions) => defaultLookup(hostname, lookupOptions));
	if (options.signal?.aborted) throw new WebResearchError("ABORTED", "URL resolution was aborted");
	let addresses: LookupAddress[];
	try {
		addresses = await resolver(url.hostname, { all: true, verbatim: true });
	} catch (error) {
		throw new WebResearchError("PROVIDER_UNAVAILABLE", "URL hostname could not be resolved", {
			cause: error,
			sanitizedUrl: sanitizeUrlForDiagnostics(value),
		});
	}
	if (addresses.length === 0) {
		throw new WebResearchError("PROVIDER_UNAVAILABLE", "URL hostname resolved to no addresses", {
			sanitizedUrl: sanitizeUrlForDiagnostics(value),
		});
	}
	const administrativelyAllowed =
		options.administrativeNetworkPolicy?.allowPrivateNetwork === true &&
		options.administrativeNetworkPolicy.allowedHosts.includes(url.hostname.toLowerCase());
	if (!administrativelyAllowed) {
		const blocked = addresses.find((entry) => isBlockedWebAddress(entry.address));
		if (blocked) {
			throw new WebResearchError("DNS_BLOCKED", "URL resolves to a non-public network address", {
				sanitizedUrl: sanitizeUrlForDiagnostics(value),
			});
		}
	}
	return { url, addresses };
}
