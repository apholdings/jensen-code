---
"@apholdings/jensen-ai": patch
"@apholdings/jensen-agent-core": patch
"@apholdings/jensen-code": patch
"@apholdings/jensen-mom": patch
"@apholdings/jensen-pods": patch
"@apholdings/jensen-tui": patch
"@apholdings/jensen-web-ui": patch
---

Refresh the OpenRouter model catalog from the live OpenRouter Models API.

Regenerates `models.generated.ts` against `https://openrouter.ai/api/v1/models`
so every currently tool-capable OpenRouter model resolves through Jensen's
existing OpenAI-compatible OpenRouter provider.

Highlights from the refresh:

- Added support for newly available OpenRouter models such as
  `x-ai/grok-4.6`, `qwen/qwen3.8-max`, `thinkingmachines/inkling-small`,
  `sakana/sakana-namazu`, `upstage/solar-pro4`, and
  `~deepseek/deepseek-v4-flash-latest`.
- Removed OpenRouter entries that the live API no longer returns
  (`openai/gpt-5.1-chat`, `openai/gpt-5.3-chat`, `inclusionai/ling-3.0-flash:free`).
- Dropped stale manual pricing overrides for `moonshotai/kimi-k2.5` and
  `z-ai/glm-5`; their metadata now comes straight from the live API.

The OpenRouter provider architecture is unchanged: `openrouter` models
continue to route through the existing `openai-completions` provider with the
same reasoning-effort, provider-routing, and API-key handling as before.