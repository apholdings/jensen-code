import { createHash } from "node:crypto";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import type { LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { extractText, getDocumentProxy } from "unpdf";
import { type BrowserRenderer, PlaywrightBrowserRenderer } from "./browser.js";
import { type AdministrativeNetworkPolicy, resolveAndValidateWebUrl, type WebDnsResolver } from "./security.js";
import {
	type EvidencePassage,
	type WebEvidenceRecord,
	type WebFetchRequest,
	type WebFetchResponse,
	type WebResearchConfig,
	WebResearchError,
	type WebResearchTelemetry,
} from "./types.js";
import { canonicalizeWebUrl, sanitizeUrlForDiagnostics } from "./url.js";

interface FetcherOptions {
	resolver?: WebDnsResolver;
	administrativeNetworkPolicy?: AdministrativeNetworkPolicy;
	browserRenderer?: BrowserRenderer;
	now?: () => Date;
}

interface RawResponse {
	requestedUrl: string;
	finalUrl: string;
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: Buffer;
	bytesDownloaded: number;
}

interface ExtractedContent {
	content: string;
	title?: string;
	author?: string;
	publishedAt?: string;
	canonicalUrl?: string;
	outboundLinks: string[];
	extractor: WebEvidenceRecord["extractor"];
	pageCount?: number;
}

interface PdfMetadata {
	info?: { Title?: unknown; Author?: unknown; CreationDate?: unknown };
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizeContent(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function headerValue(value: string | string[] | undefined): string {
	return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

function mimeType(headers: RawResponse["headers"]): string {
	return headerValue(headers["content-type"]).split(";", 1)[0].trim().toLowerCase();
}

function decodeText(body: Buffer, contentType: string): string {
	const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(body);
	} catch {
		return new TextDecoder("utf-8").decode(body);
	}
}

function decompressBody(body: Buffer, encoding: string, maximum: number): Buffer {
	const normalized = encoding.trim().toLowerCase();
	try {
		if (!normalized || normalized === "identity") return body;
		if (normalized === "gzip" || normalized === "x-gzip") return gunzipSync(body, { maxOutputLength: maximum });
		if (normalized === "deflate") return inflateSync(body, { maxOutputLength: maximum });
		if (normalized === "br") return brotliDecompressSync(body, { maxOutputLength: maximum });
		throw new WebResearchError("CONTENT_TYPE_UNSUPPORTED", `Unsupported content encoding: ${normalized}`);
	} catch (error) {
		if (error instanceof WebResearchError) throw error;
		throw new WebResearchError(
			"RESPONSE_TOO_LARGE",
			"Compressed response exceeded the decompression limit or was invalid",
			{
				cause: error,
			},
		);
	}
}

function createPinnedLookup(addresses: Array<{ address: string; family: number }>): LookupFunction {
	return (_hostname, options, callback) => {
		if (options.all) {
			callback(null, addresses);
			return;
		}
		const address = addresses[0];
		callback(null, address.address, address.family);
	};
}

async function readHttpResponse(
	url: URL,
	addresses: Array<{ address: string; family: number }>,
	config: WebResearchConfig,
	signal: AbortSignal,
): Promise<{ status: number; headers: RawResponse["headers"]; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const request = (url.protocol === "https:" ? requestHttps : requestHttp)(
			url,
			{
				method: "GET",
				headers: {
					Accept:
						"text/html,text/plain,text/markdown,application/json,application/xml,text/xml,application/pdf;q=0.9,*/*;q=0.1",
					"Accept-Encoding": "gzip, deflate, br",
					"User-Agent": config.userAgent,
				},
				lookup: createPinnedLookup(addresses),
				signal,
			},
			(response) => {
				const status = response.statusCode ?? 0;
				const length = Number(headerValue(response.headers["content-length"]));
				if (Number.isFinite(length) && length > config.maxResponseBytes) {
					response.destroy();
					reject(
						new WebResearchError("RESPONSE_TOO_LARGE", "Response Content-Length exceeds the configured limit"),
					);
					return;
				}
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > config.maxResponseBytes) {
						response.destroy(
							new WebResearchError("RESPONSE_TOO_LARGE", "Response exceeded the configured size limit"),
						);
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }));
				response.on("error", reject);
			},
		);
		request.on("error", reject);
		request.end();
	});
}

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function ensureSupportedMime(type: string, body: Buffer): string {
	if (type === "application/octet-stream" && body.subarray(0, 5).toString("ascii") === "%PDF-")
		return "application/pdf";
	if (!type && /^\s*</.test(body.subarray(0, 512).toString("utf8"))) return "text/html";
	const supported = new Set([
		"text/html",
		"application/xhtml+xml",
		"text/plain",
		"text/markdown",
		"text/x-markdown",
		"application/json",
		"application/xml",
		"text/xml",
		"application/pdf",
	]);
	if (!supported.has(type))
		throw new WebResearchError("CONTENT_TYPE_UNSUPPORTED", `Unsupported response content type: ${type || "missing"}`);
	return type;
}

type ParsedDocument = ReturnType<typeof parseHTML>["document"];

function canonicalLink(document: ParsedDocument, baseUrl: string): string | undefined {
	const href = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
	if (!href) return undefined;
	try {
		return canonicalizeWebUrl(new URL(href, baseUrl).toString());
	} catch {
		return undefined;
	}
}

function outboundLinks(document: ParsedDocument, baseUrl: string): string[] {
	const links = new Set<string>();
	for (const element of document.querySelectorAll("a[href]")) {
		const href = element.getAttribute("href");
		if (!href) continue;
		try {
			const url = new URL(href, baseUrl);
			if (url.protocol === "http:" || url.protocol === "https:") links.add(canonicalizeWebUrl(url.toString()));
		} catch {
			// Ignore malformed outbound links from untrusted pages.
		}
	}
	return [...links].sort();
}

function extractHtml(
	html: string,
	baseUrl: string,
	extractor: "readability" | "playwright" = "readability",
): ExtractedContent {
	const parseable = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><body>${html}</body></html>`;
	const { document } = parseHTML(parseable);
	for (const selector of ["script", "style", "noscript", "template", "nav", "aside", "form", "dialog"]) {
		for (const element of document.querySelectorAll(selector)) element.remove();
	}
	const canonicalUrl = canonicalLink(document, baseUrl);
	const links = outboundLinks(document, baseUrl);
	const readabilityDocument = document.cloneNode(true) as unknown as ConstructorParameters<typeof Readability>[0];
	const readable = new Readability(readabilityDocument, {
		charThreshold: 120,
		maxElemsToParse: 50_000,
	}).parse();
	const selectedHtml = readable?.content || document.body?.innerHTML || "";
	const turndown = new TurndownService({ bulletListMarker: "-", codeBlockStyle: "fenced", emDelimiter: "_" });
	turndown.remove(["script", "style", "noscript", "template", "iframe"]);
	const content = normalizeContent(turndown.turndown(selectedHtml));
	return {
		content,
		title: readable?.title?.trim() || document.title?.trim() || undefined,
		author: readable?.byline?.trim() || undefined,
		publishedAt: readable?.publishedTime?.trim() || undefined,
		canonicalUrl,
		outboundLinks: links,
		extractor,
	};
}

function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (value !== null && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) output[key] = canonicalJson((value as Record<string, unknown>)[key]);
		return output;
	}
	return value;
}

async function extractPdf(body: Buffer): Promise<ExtractedContent> {
	if (body.subarray(0, 5).toString("ascii") !== "%PDF-") {
		throw new WebResearchError("CONTENT_INVALID", "Response declared PDF content but lacks a PDF signature");
	}
	try {
		const document = await getDocumentProxy(new Uint8Array(body));
		const [textResult, metadata] = await Promise.all([
			extractText(document, { mergePages: false }),
			document.getMetadata().catch(() => undefined) as Promise<PdfMetadata | undefined>,
		]);
		const pages = textResult.text.map((page, index) => `<!-- page:${index + 1} -->\n${normalizeContent(page)}`);
		const content = normalizeContent(pages.join("\n\n"));
		if (!content)
			throw new WebResearchError("PDF_IMAGE_ONLY", "PDF contains no extractable text; OCR is not enabled");
		return {
			content,
			title: typeof metadata?.info?.Title === "string" ? metadata.info.Title : undefined,
			author: typeof metadata?.info?.Author === "string" ? metadata.info.Author : undefined,
			publishedAt: typeof metadata?.info?.CreationDate === "string" ? metadata.info.CreationDate : undefined,
			outboundLinks: [],
			extractor: "pdf",
			pageCount: textResult.totalPages,
		};
	} catch (error) {
		if (error instanceof WebResearchError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		if (/password|encrypted/i.test(message))
			throw new WebResearchError("PDF_ENCRYPTED", "Encrypted PDF cannot be extracted", { cause: error });
		throw new WebResearchError("CONTENT_INVALID", "PDF is malformed or unsupported", { cause: error });
	}
}

function buildPassages(content: string, query: string | undefined, isPdf: boolean): EvidencePassage[] {
	const lines = content.split("\n");
	const terms = (query?.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
		(term, index, values) => values.indexOf(term) === index,
	);
	const candidates: Array<{ passage: EvidencePassage; score: number }> = [];
	for (let start = 0; start < lines.length; start += 8) {
		const end = Math.min(lines.length, start + 12);
		const text = lines.slice(start, end).join("\n").trim();
		if (!text) continue;
		const lower = text.toLowerCase();
		const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
		const pageMatch = isPdf ? /<!-- page:(\d+) -->/.exec(text) : undefined;
		candidates.push({
			passage: {
				id: `passage-${start + 1}-${end}`,
				text: text.slice(0, 3000),
				startLine: start + 1,
				endLine: end,
				page: pageMatch ? Number(pageMatch[1]) : undefined,
			},
			score,
		});
	}
	return candidates
		.sort((left, right) => right.score - left.score || (left.passage.startLine ?? 0) - (right.passage.startLine ?? 0))
		.slice(0, 4)
		.map(({ passage }) => passage);
}

function shouldRender(extracted: ExtractedContent): boolean {
	return extracted.content.replace(/[#*_`>\-\s]/g, "").length < 240;
}

export class SecureWebFetcher {
	private readonly browser: BrowserRenderer;
	private readonly now: () => Date;

	constructor(
		private readonly config: WebResearchConfig,
		private readonly telemetry: WebResearchTelemetry,
		private readonly options: FetcherOptions = {},
	) {
		this.browser =
			options.browserRenderer ?? new PlaywrightBrowserRenderer(config.browserExecutablePath, config.fetchTimeoutMs);
		this.now = options.now ?? (() => new Date());
	}

	get browserAvailable(): boolean {
		return this.browser.available;
	}

	private async rawFetch(requestedUrl: string, signal: AbortSignal): Promise<RawResponse> {
		let current = requestedUrl;
		for (let redirect = 0; redirect <= this.config.maxRedirects; redirect++) {
			let resolved: Awaited<ReturnType<typeof resolveAndValidateWebUrl>>;
			try {
				resolved = await resolveAndValidateWebUrl(current, {
					resolver: this.options.resolver,
					administrativeNetworkPolicy: this.options.administrativeNetworkPolicy,
					signal,
				});
			} catch (error) {
				if (error instanceof WebResearchError && (error.code === "DNS_BLOCKED" || error.code === "URL_BLOCKED"))
					this.telemetry.ssrfBlocks++;
				throw error;
			}
			const response = await readHttpResponse(resolved.url, resolved.addresses, this.config, signal);
			if (isRedirect(response.status)) {
				const location = headerValue(response.headers.location);
				if (!location) throw new WebResearchError("CONTENT_INVALID", "Redirect response is missing Location");
				if (redirect === this.config.maxRedirects)
					throw new WebResearchError("REDIRECT_LIMIT", "Maximum redirect count exceeded");
				current = new URL(location, resolved.url).toString();
				continue;
			}
			if (response.status < 200 || response.status >= 300) {
				throw new WebResearchError("PROVIDER_UNAVAILABLE", `Web fetch failed with HTTP ${response.status}`, {
					sanitizedUrl: sanitizeUrlForDiagnostics(current),
				});
			}
			const decompressed = decompressBody(
				response.body,
				headerValue(response.headers["content-encoding"]),
				this.config.maxDecompressedBytes,
			);
			if (decompressed.length > this.config.maxDecompressedBytes) {
				throw new WebResearchError(
					"RESPONSE_TOO_LARGE",
					"Decompressed response exceeded the configured size limit",
				);
			}
			return {
				requestedUrl,
				finalUrl: resolved.url.toString(),
				status: response.status,
				headers: response.headers,
				body: decompressed,
				bytesDownloaded: response.body.length,
			};
		}
		throw new WebResearchError("REDIRECT_LIMIT", "Maximum redirect count exceeded");
	}

	async fetch(request: WebFetchRequest): Promise<WebFetchResponse> {
		const started = performance.now();
		this.telemetry.fetches++;
		const timeout = AbortSignal.timeout(this.config.fetchTimeoutMs);
		const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
		try {
			const raw = await this.rawFetch(request.url, signal);
			const type = ensureSupportedMime(mimeType(raw.headers), raw.body);
			const contentType = headerValue(raw.headers["content-type"]);
			let extracted: ExtractedContent;
			let sourceHtml: string | undefined;
			if (request.mode === "pdf" || type === "application/pdf") {
				extracted = await extractPdf(raw.body);
			} else if (request.mode === "json" || type === "application/json") {
				const parsed = JSON.parse(decodeText(raw.body, contentType)) as unknown;
				extracted = {
					content: JSON.stringify(canonicalJson(parsed), null, 2),
					outboundLinks: [],
					extractor: "json",
				};
			} else if (request.mode === "xml" || type === "application/xml" || type === "text/xml") {
				extracted = {
					content: normalizeContent(decodeText(raw.body, contentType)),
					outboundLinks: [],
					extractor: "xml",
				};
			} else if (request.mode === "text" || type === "text/plain" || type.includes("markdown")) {
				extracted = {
					content: normalizeContent(decodeText(raw.body, contentType)),
					outboundLinks: [],
					extractor: "text",
				};
			} else {
				sourceHtml = decodeText(raw.body, contentType);
				extracted = extractHtml(sourceHtml, raw.finalUrl);
			}
			let rendered = false;
			if (
				sourceHtml !== undefined &&
				(request.render === "always" || (request.render !== "never" && shouldRender(extracted)))
			) {
				const renderedHtml = await this.browser.renderHtml(sourceHtml, signal);
				extracted = extractHtml(renderedHtml, raw.finalUrl, "playwright");
				rendered = true;
				this.telemetry.renderFallbacks++;
			}
			if (!extracted.content)
				throw new WebResearchError("CONTENT_INVALID", "Fetched content contained no extractable text");
			const completeContent = normalizeContent(extracted.content);
			const hash = sha256(completeContent);
			const canonicalUrl = extracted.canonicalUrl ?? canonicalizeWebUrl(raw.finalUrl);
			const evidenceId = `web-${sha256(`${canonicalUrl}\n${hash}`).slice(0, 20)}`;
			const maxCharacters = Math.max(500, Math.min(request.maxCharacters ?? 12_000, 50_000));
			const truncated = completeContent.length > maxCharacters;
			const content = completeContent.slice(0, maxCharacters);
			const relevantPassages = buildPassages(completeContent, request.passageQuery, extracted.extractor === "pdf");
			const evidence: WebEvidenceRecord = {
				evidenceId,
				sourceType: "web",
				requestedUrl: canonicalizeWebUrl(raw.requestedUrl),
				finalUrl: canonicalizeWebUrl(raw.finalUrl),
				canonicalUrl,
				title: extracted.title,
				author: extracted.author,
				retrievedAt: this.now().toISOString(),
				publishedAt: extracted.publishedAt,
				contentType: type,
				extractor: extracted.extractor,
				contentSha256: hash,
				completeContentLocation: `session:tool-result:${evidenceId}`,
				completeContent,
				relevantPassages,
				outboundLinks: extracted.outboundLinks,
				bytesDownloaded: raw.bytesDownloaded,
				bytesExtracted: Buffer.byteLength(completeContent),
				truncated,
				pageCount: extracted.pageCount,
				untrusted: true,
			};
			this.telemetry.bytesDownloaded += evidence.bytesDownloaded;
			this.telemetry.bytesExtracted += evidence.bytesExtracted;
			this.telemetry.evidenceRecords++;
			return { evidence, content, rendered, durationMs: Math.round(performance.now() - started) };
		} catch (error) {
			this.telemetry.fetchFailures++;
			if (request.signal?.aborted) throw new WebResearchError("ABORTED", "Web fetch was aborted", { cause: error });
			if (timeout.aborted) {
				this.telemetry.timeouts++;
				throw new WebResearchError("TIMEOUT", "Web fetch timed out", { cause: error });
			}
			throw error;
		}
	}
}
