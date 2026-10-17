/**
 * Batch-3 AWS Bedrock catalog identity (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Bedrock 行; port of
 * sub2api's backend/internal/service/bedrock_request.go /
 * bedrock_signer.go / bedrock_stream.go onto this repo's provider-package
 * contract). Single source of truth for the Bedrock (Claude on InvokeModel)
 * provider identity shared by the credential sink (platform/
 * bedrock-keys/supply-sink.ts), the catalog registration
 * (catalog/bedrock-registration.ts), the account probe (supply/
 * account-probe-service.ts buildBedrockProbe) and the gateway dispatch
 * split. Mirrors the gemini package's catalog-identity contract.
 *
 * The client protocol is Anthropic Messages: clients send /v1/messages
 * bodies and the bedrock transform (gateway/bedrock/transform.ts) rewrites
 * them onto the Bedrock InvokeModel shape, so the catalog protocol is
 * `anthropic` and the dispatch route keys on the signed endpoint scope
 * `bedrock-invoke` plus the signed provider protocol `anthropic`.
 */

export const BEDROCK_PROVIDER_ID = 'aws-bedrock';
export const BEDROCK_PRODUCT_ID = 'bedrock-claude';
/** Free-text credential type: SigV4 AWS keys in a sealed envelope. */
export const BEDROCK_CREDENTIAL_TYPE = 'aws-sigv4';
/**
 * The alternate credential type the sealed envelope also accepts (Bedrock
 * API-key / Bearer mode). Registered in the transport's credential parser;
 * catalog rights registration for it is a follow-up (operators must first
 * own the bearer endpoint decision — see the transport comment).
 */
export const BEDROCK_API_KEY_CREDENTIAL_TYPE = 'api-key';
export const BEDROCK_SUPPLY_MODE = 'platform' as const;
/** Region is per-account (the envelope's aws_region); the catalog region is the neutral global bucket. */
export const BEDROCK_REGION = 'global';
export const BEDROCK_PURPOSE = 'inference';
export const BEDROCK_PROTOCOL = 'anthropic' as const;
/** Catalog endpoint scope; also the gateway dispatch split key for bedrock traffic. */
export const BEDROCK_ENDPOINT = 'bedrock-invoke';
export const BEDROCK_DISPLAY_NAME = 'AWS Bedrock (Claude)';

/**
 * Pinned upstream host template (sub2api BuildBedrockURL): every Bedrock
 * dial is `https://bedrock-runtime.<region>.amazonaws.com`. The transport
 * accepts an injectable base URL only for local test upstreams.
 */
export const BEDROCK_INVOKE_HOST_TEMPLATE = 'https://bedrock-runtime.{region}.amazonaws.com';

/**
 * Placeholder model set for the MVP catalog: the cross-region inference
 * profile ids (the `us.`/`eu.`/... prefixed family transform.ts adjusts to
 * the account region) plus the foundational Sonnet model. transform.ts
 * normalizes client aliases onto these.
 */
export const BEDROCK_PLACEHOLDER_MODELS: readonly string[] = Object.freeze([
  'us.anthropic.claude-sonnet-4-5-v1:0',
  'us.anthropic.claude-opus-4-6-v1:0',
  'us.anthropic.claude-haiku-4-5-v1:0',
  'anthropic.claude-sonnet-4-5-v1:0',
]);
