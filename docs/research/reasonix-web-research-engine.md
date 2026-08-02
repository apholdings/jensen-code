# Reasonix Web Research Engine Study

## Source identity

- Repository: `https://github.com/esengine/DeepSeek-Reasonix`
- Primary stable release: `v1.19.2`
- Stable commit: `c46e3af1c2732fe2b3dedb0bd47eb39a629357d2`
- Default branch inspected separately: `main-v2` at `93b47a036a1809993caf9766f9a5e8997841d6a7`
- License: MIT

The newer default-branch changes after `v1.19.2` were release workflow and website changes; no newer web-fetch or autoresearch mechanism affected this design.

## Source paths inspected

- `internal/tool/builtin/webfetch.go`
- `internal/tool/builtin/webfetch_ssrf_test.go`
- `internal/tool/builtin/web_fetch_proxy_test.go`
- `internal/netclient/netclient.go`
- `internal/installsource/ssrf.go`
- `internal/autoresearch/schema.go`
- `internal/autoresearch/store.go`
- `internal/autoresearch/readiness.go`
- `internal/autoresearch/summary.go`
- `internal/autoresearch/task.go`
- `internal/evidence/evidence.go`
- `internal/evidence/meta.go`
- `internal/telemetry/sink.go`
- `internal/agent/evidence_flow_test.go`
- `docs/superpowers/specs/2026-06-29-autoresearch-runtime-design.md`
- `docs/superpowers/audits/2026-06-30-autoresearch-runtime-verification.md`

Reasonix does not ship a general search-provider registry or SearXNG adapter at this release. The relevant production implementation is its `web_fetch` tool and host-managed AutoResearch/evidence state.

## Observed mechanisms

Reasonix separates a read-only fetch tool from model reasoning, applies a response cap and timeout, strips executable HTML, keeps links, checks resolved addresses at dial time, rechecks redirect connections, and supports configured HTTP/SOCKS proxy paths. Its AutoResearch runtime stores task specifications, progress, findings, directions, iterations, and heartbeats under a host-owned directory. Atomic state writes, structured findings, readiness gates, stale-direction detection, summaries, and resume validation keep the host rather than model prose authoritative.

The evidence flow uses accepted finding identifiers and readiness checks. UI/API surfaces load compact status eagerly and findings on demand. Telemetry and tests cover recovery, bounds, persistence, proxy behavior, SSRF ranges, lifecycle events, and completion gates.

## Ideas applied to Jensen

- Keep search/fetch tools read-only and make host structures authoritative.
- Revalidate destinations at connection and redirect boundaries.
- Cap time and bytes before extraction.
- Preserve complete evidence outside normal model-visible context.
- Use structured evidence IDs, hashes, passages, and readiness/citation metadata.
- Keep bounded research lifecycle events and partial failure recovery deterministic.
- Expose compact status and load detailed evidence only when required.

## Ideas rejected or changed

- Reasonix deliberately allows loopback because its agent can already use shell. Jensen blocks loopback and all private ranges because untrusted web content must not gain network authority from unrelated shell capability.
- Reasonix trusts remote proxy DNS for hostnames. Jensen's secure fetcher ignores ambient proxies because it cannot validate remote DNS answers or guarantee rebinding protection. SearXNG is contacted only by its separate configured provider adapter.
- Reasonix's HTML reducer is intentionally lossy. Jensen uses Readability plus deterministic Markdown to preserve article structure, code, tables, links, and citation coordinates.
- Reasonix's normal fetch path does not provide PDF extraction, isolated rendering, provider-independent search, or cited synthesis. Jensen adds these as bounded independent layers.
- Free-form model summaries are not evidence authority. Jensen keeps full tool details in the existing durable session tree and relies on the 1.1.12 deterministic compaction checkpoint.

## Jensen-native decisions

Jensen implements a typed provider registry with local SearXNG as the default target and the existing DuckDuckGo Lite parser refactored as fallback. Search never fetches pages. The secure fetcher validates URL syntax, every DNS answer, pinned socket resolution, and each redirect; applies compressed/decompressed limits; and dispatches by validated MIME.

Evidence uses Jensen's existing persisted tool-result `details`, session JSONL, and deterministic checkpoint rather than a competing store. Model-visible tool content includes only metadata, bounded extraction, evidence IDs, hashes, and passages in explicit untrusted delimiters. The stable system/tool prefix remains deterministic; results and retrieval timestamps remain dynamic.

Deep research uses deterministic host planning/ranking and bounded parallel operations. It records lifecycle events, retains partial results, flags potential contradictions, builds an addressable bundle, and emits claim-to-passage citations. Caches are observational only.

## Provenance

Reasonix is MIT-licensed research input. Jensen's implementation was written independently against Jensen types, runtime, session persistence, provider abstraction, and security requirements. No non-trivial Reasonix code or source fragment was copied, so no derived-code notice is required. SearXNG remains an external AGPL service and is not embedded or redistributed in Jensen npm packages.
