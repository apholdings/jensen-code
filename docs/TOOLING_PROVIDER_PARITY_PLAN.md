# Tooling & Provider Parity Plan

## 1. Scope

Audit and design doc for four cross-cutting parity areas: Bash execution parity, osgrep expand view, QueryEngine tool-call batching, and AI provider dependency freshness. No product-code changes in this slice.

---

## 2. Exact Repos Checked

- **jensen-code**: `packages/coding-agent/src/core/tools/bash.ts`, `packages/coding-agent/src/core/bash-executor.ts`, `packages/coding-agent/src/utils/shell.ts`, `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/src/modes/rpc/rpc-mode.ts`, `packages/coding-agent/src/modes/interactive/components/bash-execution.ts`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `packages/coding-agent/examples/extensions/osgrep.ts`, `packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/docs/extensions.md`, `packages/ai/package.json`, `packages/ai/src/types.ts`, `packages/ai/src/env-api-keys.ts`, `packages/ai/src/stream.ts`, `packages/ai/src/providers/register-builtins.ts`, `packages/ai/scripts/generate-models.ts`, `packages/ai/src/providers/openai-completions.ts`, `packages/ai/src/providers/openai-responses.ts`, `packages/ai/src/providers/anthropic.ts`, `packages/ai/src/providers/amazon-bedrock.ts`, `packages/ai/src/providers/google.ts`, `packages/ai/src/providers/google-vertex.ts`, `packages/ai/src/providers/google-gemini-cli.ts`, `packages/ai/src/providers/mistral.ts`, `packages/ai/src/providers/azure-openai-responses.ts`, `packages/ai/src/providers/openai-codex-responses.ts`, `packages/ai/test/openrouter-provider.test.ts`
- **agent_harness_pro**: `tools/BashTool/BashTool.tsx`, `tools/BashTool/bashPermissions.ts`, `tools/BashTool/BashToolResultMessage.tsx`, `tools/BashTool/UI.tsx`, `utils/Shell.ts`, `utils/ShellCommand.ts`, `tasks/LocalShellTask/LocalShellTask.tsx`, `tasks/LocalShellTask/killShellTasks.ts`, `utils/toolSearch.ts`, `utils/transcriptSearch.ts`, `utils/ripgrep.ts`, `QueryEngine.ts`, `query.ts`, `utils/processUserInput/processUserInput.ts`, `utils/queryContext.ts`, `utils/queryHelpers.ts`, `services/tools/toolOrchestration.ts`

---

## 3. Provider Matrix

Grouped by risk class.

### Group A — Direct SDK Refresh (low risk, type surfaces verified)

| Provider | Current | Latest | Symbols used | Status |
|---|---|---|---|---|
| OpenAI | 6.26.0 | 6.33.0 | `OpenAI`, chat completions, responses streaming types | Latest type surface still contains the symbols currently used |
| Anthropic | ^0.73.0 | 0.82.0 | `Anthropic`, `MessageCreateParamsStreaming`, messages stream types | Latest type surface still contains the symbols currently used |
| Google GenAI | ^1.40.0 | 1.48.0 | `GoogleGenAI`, `GenerateContentParameters`, `ThinkingConfig`, Vertex options | Latest type surface still contains the symbols currently used |
| AWS Bedrock | ^3.983.0 | 3.1023.0 | `BedrockRuntimeClient`, `ConverseStreamCommand`, cache/thinking enums | Latest type surface still contains the symbols currently used |

**Disposition**: Safe refresh candidates, but still run `npm run check` after the batch. No direct symbol breakage was found in the currently used surfaces.

### Group B — Catalog Drift (medium risk, stale metadata)

| Provider | Issue |
|---|---|
| OpenRouter | `generate-models.ts` has hardcoded manual overrides for `moonshotai/kimi-k2.5` and `z-ai/glm-5` that now diverge from current official pricing/max token data. Official API still returns `supported_parameters`, `architecture.modality`, `pricing`, `context_length`, `top_provider.max_completion_tokens`. Catalog is stale. |
| models.dev | Several manual fallback additions in `generate-models.ts` look potentially obsolete. Current official catalog contains `claude-opus-4-6`, `claude-sonnet-4-6`, `gemini-3.1-flash-lite-preview`, `gpt-5.4`, `gpt-5.3-codex-spark`, `github-copilot gpt-5.3-codex`. These may cover what manual overrides currently handle. |

**Disposition**: Audit and remove stale overrides after verifying official catalog now covers them. Do not just delete — compare output first.

### Group C — Breaking Risk / Defer

| Provider | Current | Latest | Risk |
|---|---|---|---|
| Mistral | 1.14.1 | 2.1.2 | Major-version jump. Latest still contains `chat.stream`, `ChatCompletionStreamRequest`, `toolChoice`, `promptMode`, `serverURL`, but surface may have changed. Higher migration risk. |

**Disposition**: Defer SDK refresh. Audit Mistral symbol surface in isolation before bumping.

---

## 4. Bash Findings

### Reference behavior (agent_harness_pro)

- `LocalShellTask.tsx` manages the shell lifecycle.
- `BashToolResultMessage.tsx` / `UI.tsx` render results.
- Cancellation/kill is represented structurally in the result payload (`interrupted: true` in the shell result path), rather than being surfaced only as a thrown tool error.
- `killShellTasks.ts` handles teardown.

### jensen-code comparison

- `bash-executor.ts` returns `cancelled: true` for RPC and interactive modes.
- `tools/bash.ts` (tool-call path) treats abort as a regular error, not as structured cancellation.
- The reference harness uses a different field name (`interrupted`) for this state, so the important parity target is semantic consistency, not field-name imitation.
- Tool-call streaming path lacks `stripAnsi` / `sanitizeBinaryOutput` parity with the interactive/RPC path.

### Parity gaps

| Gap | Severity |
|---|---|
| Cancellation representation: tool-call path rejects abort as error; interactive/RPC returns `cancelled: true` | Medium — user-facing UX inconsistency |
| Output sanitization: interactive/RPC path has `stripAnsi`; tool-call streaming lacks it | Low-medium — visual noise on ANSI output |

### Portable improvement slice

The bounded portable slice is **cancellation representation parity plus output sanitization**, not background-task or sandbox import.

**Recommended disposition**: Fix `tools/bash.ts` to represent abort as cancellation rather than generic failure, and align the tool-call path with `bash-executor.ts` by applying `stripAnsi` plus binary-output sanitization to streamed/final output. Keep background/sandbox as explicitly deferred.

---

## 5. osgrep Findings

### Reference behavior (agent_harness_pro)

- There is **no osgrep integration** in `agent_harness_pro`.
- The only useful comparison points are adjacent search/result-shaping utilities: `utils/toolSearch.ts`, `utils/transcriptSearch.ts`, and `utils/ripgrep.ts`.
- Those files are relevant only as search-UX references, not as a direct parity target.

### jensen-code comparison

- `packages/coding-agent/examples/extensions/osgrep.ts` exists only as an extension example — not shipped as a built-in tool.
- `src/core/extensions/types.ts` and `docs/extensions.md` define the extension surface.
- The current example stores full output in `details.fullOutputPath`, but the expand view still re-renders truncated `result.content`.
- Header line count reports full-output line count even when the visible content is truncated.

### Parity gaps

| Gap | Severity |
|---|---|
| osgrep not shipped as built-in — only exists as example | Low — extension architecture is sound, feature is not missing, just not surfaced |
| Expand view re-renders truncated content instead of streaming from `fullOutputPath` | Low — UX polish once osgrep is built-in |
| Path filter missing | Low — bounded ergonomic improvement |

### Recommended disposition

Do not redesign search architecture. The narrow next slice is to fix the existing extension example so expanded rendering can read from `fullOutputPath` and the header reflects displayed output correctly. A separate decision can later determine whether osgrep should be promoted from example to built-in.

---

## 6. QueryEngine Findings

### Reference behavior (agent_harness_pro)

- `QueryEngine.ts` is a mixed turn-execution runtime.
- It manages session state, context assembly/compaction, tool orchestration, and result normalization.
- `services/tools/toolOrchestration.ts` provides concurrency-safe tool-call batching.

### jensen-code comparison

- jensen-code has no equivalent `QueryEngine`.
- Session state lives in `agent-session.ts` / `session-manager.ts`.
- Context assembly/compaction is handled separately.
- Tool orchestration is in the existing runtime.

### Assessment

**QueryEngine is not a portable search engine.** It is a session-runtime coupling that would not compose cleanly with jensen-code's architecture.

The only portable concept is **concurrency-safe tool-call batching** from `toolOrchestration.ts`.

### Recommended disposition

Reject wholesale QueryEngine import. If tool-call batching is needed, extract and adapt only the batching logic from `services/tools/toolOrchestration.ts` — do not import the mixed turn-execution runtime.

---

## 7. Recommended Implementation Order

1. **Group A provider refresh** — safe batch update for OpenAI, Anthropic, Google GenAI, AWS Bedrock
2. **Bash cancellation parity** — fix `tools/bash.ts` abort representation and add `stripAnsi` to streaming path
3. **osgrep expand-view fix** — make expanded rendering use `fullOutputPath` and correct header counters
4. **OpenRouter catalog audit** — remove stale manual overrides after verifying official catalog coverage
5. **models.dev audit** — verify which manual fallback additions are now covered by the official catalog
6. **Mistral deferred refresh** — audit Mistral 2.x symbol surface in isolation before bumping

---

## 8. Best Next Single Implementation Slice

**Group A provider SDK refresh**

Bounded scope:
- update `openai` from 6.26.0 to 6.33.0
- update `@anthropic-ai/sdk` from ^0.73.0 to 0.82.0
- update `@aws-sdk/client-bedrock-runtime` from ^3.983.0 to 3.1023.0
- update `@google/genai` from ^1.40.0 to 1.48.0
- run `npm run check` to verify types are clean
- no behavior changes

Why this slice first:
- all four are independently verified safe
- type surfaces confirmed unchanged by orchestrator
- unblocks no subsequent work but removes technical debt

---

## 9. Explicit Deferrals

- Mistral SDK refresh (major-version jump; audit required first)
- Bash background-task / sandbox parity
- osgrep `fullOutputPath` streaming optimization
- osgrep path filter
- QueryEngine wholesale import
- OpenRouter catalog refresh (blocked on manual override audit)
- models.dev manual override removal (blocked on catalog comparison)
- Private/non-public provider surfaces such as `google-gemini-cli` / `google-antigravity` model catalogs beyond what can be verified from public official sources
