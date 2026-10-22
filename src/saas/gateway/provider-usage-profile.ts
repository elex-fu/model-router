/** Server-owned facts projected from verified evidence and the validated dispatch target. */
export interface ProviderUsageProfileEvidence {
  readonly providerId?: string;
  readonly productId?: string;
  readonly endpoint?: string;
  readonly providerProtocol?: string;
  readonly providerOperation?: string;
  readonly providerTargetUrl?: string;
}

export type ProviderUsageProfile = 'kimi-coding-messages/v1' | null;

const KIMI_METADATA_KEYS = Object.freeze(['service_tier', 'inference_geo']);

/**
 * This compatibility contract belongs to the Coding product, not every server
 * that implements Anthropic Messages. Neither model names nor response fields
 * can select it. The CN endpoint has live evidence; global uses the documented
 * sibling endpoint and the same explicit, fail-closed value contract.
 */
export function providerUsageProfile(evidence: ProviderUsageProfileEvidence): ProviderUsageProfile {
  if (
    evidence.providerId !== 'kimi' ||
    evidence.endpoint !== 'messages' ||
    evidence.providerProtocol !== 'anthropic' ||
    evidence.providerOperation !== 'messages'
  )
    return null;
  const hostname =
    evidence.productId === 'kimi-code'
      ? 'api.kimi.com'
      : evidence.productId === 'kimi-code-global'
        ? 'api.kimi.ai'
        : null;
  if (hostname === null || evidence.providerTargetUrl === undefined) return null;
  try {
    const target = new URL(evidence.providerTargetUrl);
    return target.protocol === 'https:' &&
      target.hostname === hostname &&
      (target.port === '' || target.port === '443') &&
      target.pathname === '/coding/v1/messages' &&
      target.username === '' &&
      target.password === '' &&
      target.search === '' &&
      target.hash === ''
      ? 'kimi-coding-messages/v1'
      : null;
  } catch {
    return null;
  }
}

export function anthropicUsageMetadataKeys(profile: ProviderUsageProfile): readonly string[] {
  return profile === null ? [] : KIMI_METADATA_KEYS;
}

/** Preserve the exact compatibility contract in the existing observation provenance. */
export function providerUsageObserverVersion(version: string, profile: ProviderUsageProfile): string {
  return profile === null ? version : `${version}+${profile}`;
}

/**
 * The actual Coding response declares these two baseline values. A premium
 * tier or geographic pricing dimension needs a priced contract before it can
 * become a trusted report. Do not infer missing counters or ignore new fields.
 *
 * Anthropic's official Usage schema documents service_tier and inference_geo;
 * Coding's observed baseline is narrower than that upstream schema:
 * https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts
 * https://platform.claude.com/docs/en/api/service-tiers
 * https://platform.claude.com/docs/en/manage-claude/data-residency
 */
export function validAnthropicUsageMetadata(
  profile: ProviderUsageProfile,
  usage: Record<string, unknown>,
  envelope?: Record<string, unknown>,
): boolean {
  if (profile === null) return true;
  for (const value of [usage, envelope]) {
    if (value === undefined) continue;
    if (Object.hasOwn(value, 'service_tier') && value.service_tier !== 'standard') return false;
    if (Object.hasOwn(value, 'inference_geo') && value.inference_geo !== 'not_available') return false;
  }
  // A baseline service_tier must not conceal a separate fast-mode declaration.
  return !Object.hasOwn(usage, 'speed') || usage.speed === 'standard';
}
