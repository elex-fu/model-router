# Codex instruction assets

This directory holds the outbound `instructions` assets for ChatGPT-backed
Codex traffic (`chatgpt.com/backend-api/codex/responses` requires a non-empty
`instructions` field on every request).

## Sources and versioning strategy

- **Source of truth**: the Codex CLI base prompts published by OpenAI
  (`openai/codex` repository, model-manager instruction sets), which sub2api
  embeds per model family via `go:embed` (`internal/pkg/openai/instructions*.txt`).
- **Versioning**: each asset lands as a new versioned file
  (`codex-<family>-v<N>.txt`). The compiled-in fallback constant in
  `../instructions.ts` is the only runtime input; a new asset version must be
  paired with a constant update in the same change so the two cannot drift.
- **Update workflow (TODO: codex-version-sync service, Phase 1.5)**:
  1. Pull the upstream Codex CLI release notes / model-manager assets.
  2. Add the new family text here as `codex-<family>-v<N>.txt`.
  3. Update the corresponding constant in `../instructions.ts` and the unit
     test snapshot (`tests/saas/gateway/codex/instructions.test.ts`).
  4. Alerting: the version-sync service (not yet implemented) will flag an
     asset older than the tracked CLI version.

## What is embedded

We deliberately do **not** copy OpenAI's full prompt text into this
repository. The runtime fallback below (`fallback.txt`, mirrored by
`CODEX_FALLBACK_INSTRUCTIONS` in `../instructions.ts`) is a minimal generic
instruction that satisfies the endpoint's non-empty constraint without
pretending to reproduce the CLI's exact system prompt. Once the asset update
process above is exercised with verified upstream text, family-specific files
can replace the fallback for production traffic.
