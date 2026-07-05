# Caveman Output Compression

Caveman is a session-scoped output compression feature that reduces assistant prose verbosity at runtime.

- It does **not** modify session history or persistent state.
- Fresh sessions always start with Caveman **off**.

## Overview

Caveman shapes the assistant’s *runtime* prose contract by injecting native Caveman guidelines into the session system prompt.

### Slash commands

| Command | Description |
| --- | --- |
| `/caveman` | Enable **Full** Caveman contract (default) |
| `/caveman lite` | Enable **Lite** Caveman contract |
| `/caveman full` | Enable **Full** Caveman contract |
| `/caveman ultra` | Enable **Ultra** Caveman contract |
| `/caveman off` | Disable Caveman and restore normal assistant prose |
| `/caveman status` | Show current Caveman level |

## Natural Language Controls (SILENT)

Natural-language activation phrases update Caveman state **silently**: they do **not** inject any “activation” announcement into the model’s prose.

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

- `caveman off` disables compression.
- When Caveman is off, all Caveman guidelines are cleared from the system prompt (so the model returns to the normal prose contract).
- Fresh sessions always reset to Caveman **off**:
  - new sessions ("/new")
  - switching sessions
  - forking sessions

## Compression levels

### Lite (recommended)

Lite is recommended for most use cases since it preserves professional, complete sentences while removing filler words and hedging language.

Lite contract (what the model should do):
- Use professional complete sentences that remove filler words, hedging language, and unnecessary elaboration.
- Present each step clearly and concisely while maintaining natural prose flow.

### Full

Full contract (what the model should do):
- Use tighter phrasing.
- Prefer fragments only where meaning remains unambiguous.
- Eliminate redundant words and softening phrases.

### Ultra

Ultra contract (what the model should do):
- Use only simple, non-risky answers with minimal prose.
- **Mandatory fallback to clear, complete prose** for warnings, destructive actions/confirmations, ambiguity, ordered or multi-step procedures, or repeated questions.

## Safety exclusions (never compressed)

Regardless of Caveman level, the following surfaces are excluded by native safety protections (from `CAVEMAN_SAFETY_PROTECTIONS`):

- Tool calls, tool arguments, tool results, and command output
- JSON, YAML, XML, frontmatter, schemas, or any machine-parsed envelopes
- details.results and all result fields used for parent validation
- Task, planner, slice, handoff, run, and verification state
- Code, file paths, URLs, commit hashes, CLI commands, and exact error messages
- Security confirmations, destructive action confirmations, and ordered procedures
- Delegated evidence from reviewer, security, pentester, and librarian agents

### Prompt invariance

These global native rules cannot be weakened by project-local configuration or skills.

## Session scope & inspection

Caveman state is **runtime-only** and is not persisted in session history. Use `/caveman status` to inspect which level is active for the current session.

---

Based on the Caveman output compression concept (MIT License).
Upstream: https://github.com/JuliusBrussee/caveman
