/**
 * F4 Gemini subscription catalog identity (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b). Single source of
 * truth for the Gemini CLI (Cloud Code Assist) subscription provider identity
 * shared by the credential sink (platform/gemini-oauth/supply-sink.ts), the
 * R4 refresh worker binding, the catalog registration
 * (catalog/gemini-registration.ts) and the gateway dispatch split. Mirrors the
 * claude package's catalog-identity contract.
 */

export const GEMINI_PROVIDER_ID = 'google-gemini';
export const GEMINI_PRODUCT_ID = 'gemini-subscription';
export const GEMINI_CREDENTIAL_TYPE = 'oauth';
export const GEMINI_SUPPLY_MODE = 'platform' as const;
export const GEMINI_REGION = 'global';
export const GEMINI_PURPOSE = 'inference';
export const GEMINI_PROTOCOL = 'gemini' as const;
/** Catalog endpoint scope; also the gateway dispatch split key for gemini traffic. */
export const GEMINI_ENDPOINT = 'gemini-generate-content';
export const GEMINI_DISPLAY_NAME = 'Google Gemini (Gemini CLI subscription)';

/**
 * Pinned upstream targets (sub2api backend/internal/pkg/geminicli/constants.go):
 * the Code Assist OAuth path dials cloudcode-pa.googleapis.com, the AI Studio
 * key path dials generativelanguage.googleapis.com. These are the only bases
 * the gemini transport ever dials in production.
 */
export const GEMINI_CLI_BASE_URL = 'https://cloudcode-pa.googleapis.com';
export const GEMINI_AI_STUDIO_BASE_URL = 'https://generativelanguage.googleapis.com';
export const GEMINI_CLI_HOST = 'cloudcode-pa.googleapis.com';

/**
 * Placeholder model set for the MVP catalog: the core text models the sub2api
 * Gemini platform serves (its antigravity/claude_types.go model table);
 * transform.ts normalizes client aliases onto these.
 */
export const GEMINI_PLACEHOLDER_MODELS: readonly string[] = Object.freeze([
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-3-pro-preview',
  'gemini-3-flash',
]);
