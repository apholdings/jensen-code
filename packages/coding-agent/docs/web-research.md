# Web Research Engine

Jensen's web research engine is free by default and has four read-only tools:

- `web_search` discovers URLs through a typed provider registry.
- `web_fetch` retrieves and extracts one URL as untrusted evidence.
- `deep_research` performs a bounded multi-query evidence workflow.
- `web_research_status` reports configuration, health, capabilities, budgets, and counters without prompt contents or secrets.

Search and fetch are intentionally separate. Search results contain concise titles, URLs, snippets, provider/engine metadata, and stable ranks. Pages are fetched only when requested or selected by bounded research.

## Free local search

SearXNG is the default target at `http://127.0.0.1:18888`; DuckDuckGo Lite is the automatic operational fallback. Zero SearXNG results are a successful empty response and do not trigger fallback. Explicit `provider: "searxng"` or `provider: "duckduckgo-lite"` selection never silently switches providers.

On Bucephalus:

```bash
cd /home/magnus/software/jensen-code
./deploy/searxng/install.sh
export JENSEN_SEARXNG_URL=http://127.0.0.1:18888
```

The deployment binds to loopback, uses no host network or privileged capabilities, and is independent of Squid and DIPP. See [`deploy/searxng/README.md`](../../../deploy/searxng/README.md) for start, stop, health, and rollback commands. SearXNG is not intended for public exposure. Its upstream engines can rate-limit independently.

## Tools

Enable the tools explicitly:

```bash
jensen --tools web_search,web_fetch,deep_research,web_research_status
```

`web_search` accepts query, limit, freshness, language, region, category, safe-search, and provider fields. Unsupported provider capabilities are not invented.

`web_fetch` accepts one URL, extraction mode, returned-character limit, passage query, and rendering policy. It returns requested/final/canonical URL, title/author/date when actually extractable, retrieval time, MIME type, extractor, SHA-256, byte counts, truncation, links, evidence ID, and line/page passage coordinates. Publication dates and authors remain absent when unknown.

`deep_research` accepts objective, freshness, query/source bounds, preferred/excluded domains, language, and depth. It deterministically plans distinct queries; searches concurrently; canonicalizes and deduplicates URLs; scores primary, authoritative, current, and diverse sources; fetches with bounded concurrency; retains partial results; detects potential textual contradictions; and produces a durable evidence bundle with claim citations. The synthesis distinguishes direct support, Jensen inference, and unresolved conflicts. It is host-bounded, not one opaque model prompt.

## Configuration

All values are validated at engine construction. Invalid numeric or enum values fail clearly.

| Variable | Default | Purpose |
|---|---:|---|
| `JENSEN_SEARXNG_URL` | `http://127.0.0.1:18888` | SearXNG base URL |
| `JENSEN_WEB_SEARCH_PROVIDER` | `auto` | `auto`, `searxng`, or `duckduckgo-lite` |
| `JENSEN_WEB_SEARCH_TIMEOUT_MS` | `10000` | Search timeout |
| `JENSEN_WEB_SEARCH_MAX_RESULTS` | `10` | Search result ceiling |
| `JENSEN_WEB_SAFE_SEARCH` | `true` | Default safe-search request |
| `JENSEN_WEB_FETCH_TIMEOUT_MS` | `20000` | Total fetch timeout |
| `JENSEN_WEB_FETCH_MAX_BYTES` | `5242880` | Compressed/network response ceiling |
| `JENSEN_WEB_FETCH_MAX_DECOMPRESSED_BYTES` | `10485760` | Decompressed response ceiling |
| `JENSEN_WEB_FETCH_MAX_REDIRECTS` | `5` | Redirect ceiling |
| `JENSEN_WEB_USER_AGENT` | Jensen identifying UA | Outbound user agent |
| `JENSEN_PLAYWRIGHT_EXECUTABLE_PATH` | unset | Optional Chromium path |
| `JENSEN_RESEARCH_MAX_QUERIES` | `4` | Research query ceiling |
| `JENSEN_RESEARCH_MAX_SOURCES` | `6` | Selected-source ceiling |
| `JENSEN_RESEARCH_MAX_BYTES` | `20971520` | Aggregate research download ceiling |
| `JENSEN_RESEARCH_MAX_BROWSER_RENDERS` | `1` | Render budget metadata |
| `JENSEN_RESEARCH_MAX_ELAPSED_MS` | `120000` | Research deadline |
| `JENSEN_RESEARCH_MAX_PARALLEL_FETCHES` | `3` | Fetch concurrency |

There is deliberately no model-visible switch for private-network access, proxy selection, cookies, credentials, or SSRF bypass.

## Fetch security

Before every request and redirect, Jensen rejects non-HTTP schemes, URL credentials, internal hostnames, loopback, unspecified, RFC1918, IPv6 unique-local, link-local, multicast, carrier-grade NAT, benchmark ranges, and IPv4-mapped IPv6 variants. It resolves all DNS answers, rejects the entire answer set if any address is blocked, and pins the vetted address into the socket lookup to prevent DNS rebinding between validation and connection. Redirects repeat the full validation. Alternate integer, hexadecimal, octal, and mapped IP syntax is normalized before policy checks.

`web_fetch` does not honor ambient HTTP proxy variables. This is intentional: a remote-resolving proxy would weaken DNS and redirect guarantees. It never uses Unix sockets, executes downloads, opens attachments, performs OCR, or sends cookies. MIME headers and content signatures, rather than file extensions, choose extractors. Compressed and decompressed byte limits are separate.

An internal host allowlist exists only as a programmatic host-owned administration/test constructor policy. It is absent from tool schemas and environment configuration and cannot be set by a model or page.

## Extraction and rendering

Static HTML uses LinkeDOM, Mozilla Readability, and Turndown. Scripts, styles, templates, navigation, forms, dialogs, and irrelevant chrome are removed; headings, lists, quotations, code, tables, links, and image alt text are retained where available. Normalized Markdown and content hashes are deterministic.

JSON keys are canonicalized without reordering arrays. XML, Markdown, plain text, common raw documentation pages, gzip, deflate, Brotli, and declared charsets are supported. PDFs use unpdf/PDF.js, preserve page markers, expose page coordinates, and report malformed, encrypted, or image-only files without mandatory OCR.

Rendered extraction is optional. Install Chromium without adding it to the npm package:

```bash
cd /home/magnus/software/jensen-code/packages/coding-agent
npx playwright-core install chromium
export JENSEN_PLAYWRIGHT_EXECUTABLE_PATH="$HOME/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell"
```

The exact cache path is Playwright-version/platform dependent. Rendering starts only when explicitly requested or static content is deterministically insufficient. Jensen renders the already-securely-fetched HTML in a fresh context; page networking is blocked, service workers are disabled, downloads are not accepted, dialogs are dismissed, no cookies persist, and browser/context cleanup runs on success and failure. This safely supports inline client rendering but intentionally cannot reconstruct SPAs that require additional network resources.

## Evidence, citations, and context

Every accepted page has an evidence ID, canonical source metadata, content hash, complete content, durable location, relevant passages, and coordinates. Full content is stored in the tool-result `details` already persisted by Jensen's authoritative JSONL session tree. Model-visible content is bounded. Compaction retains deterministic hashes/excerpts and the session pointer; it does not delete the original result. Replay, recovery, goal revisions, transitions, and completion authority remain independent of caches.

Search snippets and pages are delimited as external untrusted data. Tool descriptions and typed records enforce that web content is never a system message, cannot authorize a command, change scope, request secrets, disable SSRF, or override user/system policy. Research tools are read-only. No hidden reasoning or raw private page content is emitted by status diagnostics.

## Telemetry and privacy

The status tool reports provider, counts, deduplication, fallbacks, fetch failures, MIME-independent byte totals, rendering, SSRF blocks, timeouts, and evidence totals. Queries, full pages, cookies, authorization headers, API keys, secret-bearing URL fields, and model hidden reasoning are not logged by default. Diagnostic URLs redact secret-like query parameters.

## Limitations

- Upstream SearXNG engines can rate-limit, change markup, or become temporarily unavailable.
- DuckDuckGo Lite has fewer capability controls than SearXNG.
- Readability is heuristic and can omit unusual layouts.
- Rendered fallback blocks external page network activity by design.
- Image-only PDF files require a separate, explicitly authorized OCR workflow.
- Contradiction detection is conservative textual screening; marked conflicts require source review.

## Dependency and license boundary

Jensen remains MIT. Production dependencies are Mozilla Readability (Apache-2.0, main-content selection), LinkeDOM (ISC, DOM implementation), Turndown (MIT, deterministic Markdown), unpdf (MIT, PDF extraction; pinned to a Node 20-compatible release), and Playwright Core (Apache-2.0, browser control without bundled browser binaries). Chromium binaries retain their upstream licenses and are installed separately. SearXNG remains a separately deployed AGPL-3.0-or-later service; no SearXNG code is embedded in Jensen packages. Reasonix was MIT-licensed research input only, with no source copied.
