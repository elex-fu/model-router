/**
 * R5 Claude subscription catalog identity (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5). Single source of
 * truth for the Claude Code subscription provider identity shared by the
 * credential sink (platform/claude-oauth/supply-sink.ts), the R4 refresh
 * worker binding and the gateway dispatch split. Mirrors the codex package's
 * catalog-identity contract.
 */

export const CLAUDE_PROVIDER_ID = 'anthropic-claude';
export const CLAUDE_PRODUCT_ID = 'claude-subscription';
export const CLAUDE_CREDENTIAL_TYPE = 'oauth';
export const CLAUDE_SUPPLY_MODE = 'platform' as const;
export const CLAUDE_REGION = 'global';
export const CLAUDE_PURPOSE = 'inference';
export const CLAUDE_PROTOCOL = 'anthropic' as const;
/** Catalog endpoint scope; also the gateway dispatch split key for claude traffic. */
export const CLAUDE_ENDPOINT = 'claude-messages';
export const CLAUDE_DISPLAY_NAME = 'Anthropic Claude (Claude Code subscription)';

/** Pinned upstream target; the only base the claude transport ever dials in production. */
export const CLAUDE_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const CLAUDE_MESSAGES_HOST = 'api.anthropic.com';

/**
 * Placeholder model set for the MVP catalog: the dated Anthropic model ids the
 * OAuth path accepts (transform.ts maps the short aliases onto these).
 */
export const CLAUDE_PLACEHOLDER_MODELS: readonly string[] = Object.freeze([
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5-20251001',
]);
