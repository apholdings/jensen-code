# Subagent extension example

This example delegates isolated tasks through the `subagent` tool. Production agent identity and policy are defined by the canonical registry in `src/core/subagent-registry.ts`; the `agents/` Markdown files are example role prompts and must not broaden those policies.

Built-in roles:

- `scout`: fast read-only orientation
- `cavecrew-investigator`: deep read-only flow investigation
- `planner`: bounded plan creation
- `cavecrew-builder`: one- or two-file transactional implementation using the worker model
- `worker`: broader authorized implementation
- `cavecrew-reviewer`: compact read-only diff review
- `reviewer`: broad read-only review
- `librarian`, `security`, and `pentester`: specialized read-only research/review

Unknown names fail with a typed lookup error. There is no fuzzy matching or silent substitution. Project-local definitions are visible in diagnostics and cannot override the canonical policy boundary.
