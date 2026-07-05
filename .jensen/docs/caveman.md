# Caveman Output Compression

Caveman is a session-scoped output compression feature that reduces assistant prose verbosity at runtime.

- It does **not** modify session history or persistent state.
- Fresh sessions always start with Caveman **off**.

---

## Commands (6 forms)

Use `/caveman` to control the session runtime contract:

- `/caveman` — Enable **Full** contract (default)
- `/caveman lite` — Enable **Lite** contract
- `/caveman full` — Enable **Full** contract
- `/caveman ultra` — Enable **Ultra** contract
- `/caveman off` — Disable Caveman and restore normal assistant prose
- `/caveman status` — Show current Caveman level

## Natural language controls (SILENT)

Natural-language activation/deactivation phrases update Caveman state **silently** (no activation announcements are injected into model prose).

### Activation phrases (set level to **full**)

- "caveman mode"
- "talk like caveman"
- "be brief"
- "less tokens"
- "me caveman"
- "caveman style"
- "make it briefer"
- "shorter please"

### Deactivation phrases (set level to **off**)

- "normal mode"
- "stop caveman"

## Disable behavior

`caveman off` disables compression and clears all Caveman guidelines from the system prompt. Fresh sessions (new, switch, fork) always reset to **off**.

## Compression levels

### Lite (recommended)

Recommended for most use cases: professional complete sentences with filler/hedging removed.

### Full

Tighter phrasing, using fragments only when meaning is unambiguous.

### Ultra

Simple, non-risky answers with minimal prose, with mandatory fallback to clear, complete prose for warnings, destructive actions/confirmations, ambiguity, ordered or multi-step procedures, or repeated questions.

## Safety exclusions (never compressed) + invariance

Native safety protections exclude the following surfaces at all levels (from `CAVEMAN_SAFETY_PROTECTIONS`):

- Tool calls, tool arguments, tool results, and command output
- JSON, YAML, XML, frontmatter, schemas, or any machine-parsed envelopes
- details.results and all result fields used for parent validation
- Task, planner, slice, handoff, run, and verification state
- Code, file paths, URLs, commit hashes, CLI commands, and exact error messages
- Security confirmations, destructive action confirmations, and ordered procedures
- Delegated evidence from reviewer, security, pentester, and librarian agents

These global native rules cannot be weakened by project-local configuration or skills.

## Session scope & inspection

Caveman is runtime-only (not persisted). Use `/caveman status` to inspect the active level for the current session.

---

Based on the Caveman output compression concept (MIT License).
Upstream: https://github.com/JuliusBrussee/caveman
