# Chunking (1.7.0)

Deterministic, content-addressed chunking for the workspace index.

## Hierarchy

Chunking prefers the most meaningful boundaries available:

1. **Symbol boundaries** — LSP document symbols when a language server is
   present; otherwise a deterministic heuristic line-based parser for TS/JS,
   Python, C#, Java, Go, Rust (functions, classes, interfaces, enums, modules).
2. **Markdown / documentation sections** — `#`/`##` headings; each section becomes
   a chunk.
3. **Configuration sections** — top-level keys for YAML/TOML/properties; small JSON
   is one chunk.
4. **Bounded line windows** — fallback for unknown languages.

## Properties

- **Stable identity**: chunk id is content-addressed (`sha256(fileId:start:end:text)`),
  so unchanged chunks keep stable ids and unchanged files keep stable chunk ids
  across builds.
- **Never crosses unrelated symbols by default.**
- **Long symbols are split deterministically** at a character bound without
  changing the file.
- **Positions preserved**: start/end line and byte offsets are recorded.
- **CRLF/LF and BOM handled**; unsupported encodings surface as errors.
- **Chunking never modifies the file.**
- Import/header prologues may be captured as a `section` chunk before the first
  symbol.

## Chunk kinds

`symbol`, `section`, `paragraph`, `configuration`, `fallback_window`.

## Bounds

- `MAX_CHUNK_LINES = 160`, `MAX_CHUNK_CHARS = 6000`.
- Overlapping chunks bounded; duplicate suppression at retrieval.
