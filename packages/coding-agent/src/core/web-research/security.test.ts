import { describe, expect, it } from "vitest";
import { isBlockedWebAddress, resolveAndValidateWebUrl, validateWebUrlSyntax } from "./security.js";

describe("web fetch SSRF policy", () => {
	it.each([
		"127.0.0.1",
		"0.0.0.0",
		"10.1.2.3",
		"172.16.1.2",
		"192.168.1.2",
		"169.254.169.254",
		"100.100.100.200",
		"224.0.0.1",
		"::1",
		"::",
		"fc00::1",
		"fe80::1",
		"ff02::1",
		"::ffff:127.0.0.1",
		"::ffff:a9fe:a9fe",
	])("blocks non-public address %s", (address) => {
		expect(isBlockedWebAddress(address)).toBe(true);
	});

	it.each([
		"file:///etc/passwd",
		"data:text/plain,hi",
		"ftp://example.com/a",
		"gopher://example.com",
		"http://user:pass@example.com",
	])("blocks forbidden URL %s", (url) => expect(() => validateWebUrlSyntax(url)).toThrow());

	it.each(["http://127.0.0.1", "http://[::1]", "http://0x7f000001", "http://2130706433", "http://0177.0.0.1"])(
		"blocks alternate loopback notation %s after normalization/resolution",
		async (url) => {
			await expect(
				resolveAndValidateWebUrl(url, {
					resolver: async (hostname) => [
						{ address: hostname.replace(/[[\]]/g, ""), family: hostname.includes(":") ? 6 : 4 },
					],
				}),
			).rejects.toMatchObject({ code: "DNS_BLOCKED" });
		},
	);

	it("blocks DNS answers when any address is private", async () => {
		await expect(
			resolveAndValidateWebUrl("https://public.example", {
				resolver: async () => [
					{ address: "93.184.216.34", family: 4 },
					{ address: "10.0.0.2", family: 4 },
				],
			}),
		).rejects.toMatchObject({ code: "DNS_BLOCKED" });
	});

	it("pins and returns only the vetted DNS answer set", async () => {
		const answers = [
			{ address: "93.184.216.34", family: 4 },
			{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
		];
		await expect(resolveAndValidateWebUrl("https://example.com", { resolver: async () => answers })).resolves.toEqual(
			{
				url: new URL("https://example.com"),
				addresses: answers,
			},
		);
	});

	it.each(["http://localhost", "http://service.internal", "http://metadata.google.internal"])(
		"blocks internal hostname %s before DNS",
		(url) => expect(() => validateWebUrlSyntax(url)).toThrow(),
	);
});
