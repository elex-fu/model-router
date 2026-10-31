# Codex instruction assets

This directory holds the outbound `instructions` assets for ChatGPT-backed
Codex traffic (`chatgpt.com/backend-api/codex/responses` requires a non-empty
`instructions` field on every request).

## Sources and versioning strategy

- **Source of truth**: the Codex CLI base prompts published by OpenAI in the
  `openai/codex` repository (Apache-2.0) — `codex-rs/core/gpt_5_codex_prompt.md`
  for the GPT-5-Codex family and the per-slug `base_instructions` from
  `codex-rs/models-manager/models.json` for the numbered gpt-5.x families.
  This mirrors what sub2api embeds per model family via `go:embed`
  (`internal/pkg/openai/instructions*.txt`).
- **Current source ref**: `rust-v0.146.0` (recorded in
  `CODEX_INSTRUCTIONS_SOURCE_REF` in `../instructions-families.generated.ts`).
- **Versioning**: each asset lands as a versioned file
  (`codex-<family>-v<N>.txt`). One release = one version number: when a sync
  changes any family's text, every changed family is written as
  `codex-<family>-v<N>.txt` with N = highest N staged across ALL families + 1
  (families advance in lockstep because they come from one release); unchanged
  families keep their existing file, so reruns are idempotent. `fallback.txt`
  is never regenerated from upstream — it stays as the last-resort non-empty
  guarantee.
- **Atomic pairing**: the runtime constants in
  `../instructions-families.generated.ts` are GENERATED from these asset files
  in the same sync run, so the assets and the compiled-in prompt texts cannot
  drift apart. The unit test
  `tests/saas/gateway/codex/instructions-families.test.ts` additionally fails
  on any drift between the generated module and the newest staged asset files.

## Update workflow (mechanical, one command)

```bash
node --import tsx scripts/saas/codex-sync-instructions.ts rust-v0.146.0
```

The script:

1. Fetches the core prompt and `models.json` from
   `https://api.github.com/repos/openai/codex/contents/<path>?ref=<ref>`
   (contents API, 5 attempts with exponential backoff — raw.githubusercontent
   is flaky from this network).
2. Writes changed families as the next lockstep version
   `codex-<family>-v<N>.txt` (fetched text is normalized to a trailing `\n`).
3. Regenerates `../instructions-families.generated.ts` — including the
   `CODEX_INSTRUCTIONS_SOURCE_REF` (the ref) and the Apache-2.0 attribution
   header — from the post-write asset state.

Review the diff (new `.txt` assets + the generated module) and commit it as
one change. Offline recovery mode, for when the assets are already staged but
the generated module is missing or stale:

```bash
node --import tsx scripts/saas/codex-sync-instructions.ts --from-staged
```

Runtime resolution (`codexInstructionsForModel` in `../instructions.ts`) maps
the outbound model to a family — `codex` substring → the GPT-5-Codex prompt;
`gpt-5.6`/`gpt-5.5`/`gpt-5.4`/`gpt-5.2` prefixes → their family prompts;
anything else (gpt-6*, 5.3-era, unknown models) → the latest-known family
(`gpt-5.5`), mirroring sub2api's `CodexBaseInstructionsForModel`.

## What is embedded

We do **not** hand-edit prompt text. The family assets are verbatim copies of
the openai/codex release artifacts fetched by the sync script (source ref and
Apache-2.0 attribution recorded in the generated module); they can only be
replaced by rerunning the script against a new ref. The minimal generic
fallback below (`fallback.txt`, mirrored by `CODEX_INSTRUCTIONS_FALLBACK`) is
the final non-empty guarantee and never pretends to reproduce the CLI's system
prompt.
