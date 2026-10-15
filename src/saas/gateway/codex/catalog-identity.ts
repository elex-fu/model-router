/**
 * P1c Codex catalog identity constants (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.1). Single source of
 * truth for the `openai-codex` provider identity shared by the catalog
 * registration (saas/catalog/codex-registration.ts), the credential sink
 * (platform/codex-oauth/supply-sink.ts) and the gateway dispatch split.
 */

export const CODEX_PROVIDER_ID = 'openai-codex';
export const CODEX_PRODUCT_ID = 'codex-chatgpt';
export const CODEX_CREDENTIAL_TYPE = 'oauth';
export const CODEX_SUPPLY_MODE = 'platform' as const;
export const CODEX_REGION = 'global';
export const CODEX_PURPOSE = 'inference';
export const CODEX_PROTOCOL = 'responses';
/** Catalog endpoint scope; also the gateway dispatch split key for codex traffic. */
export const CODEX_ENDPOINT = 'codex-responses';
export const CODEX_DISPLAY_NAME = 'OpenAI Codex (ChatGPT subscription)';

/**
 * Placeholder model set for the MVP catalog. Model ids follow the codex
 * normalization table in transform.ts; the `/v1/models` live manifest
 * (Phase 1.5) will supersede this list.
 */
export const CODEX_PLACEHOLDER_MODELS: readonly string[] = Object.freeze(['gpt-5.3-codex', 'gpt-5.3-codex-mini']);
