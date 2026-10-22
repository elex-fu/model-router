import {
  GATEWAY_CAPABILITY_FATAL_REASON_CODES,
  GATEWAY_CAPABILITY_READINESS_REASON_CODES,
  type GatewayCapabilityProjection,
  isGatewayCapabilitySellable,
} from './gateway-capability-readiness.js';

export interface GatewayCapabilityAdvertisementTarget {
  readonly providerId: string;
  readonly productId: string;
  readonly endpoint: string;
}

export type GatewayCapabilityAdvertisementPolicy = (target: GatewayCapabilityAdvertisementTarget) => boolean;

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const identifiers = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 128 && value.every(identifier) && new Set(value).size === value.length;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const reasons = new Set<string>([
  ...GATEWAY_CAPABILITY_FATAL_REASON_CODES,
  ...GATEWAY_CAPABILITY_READINESS_REASON_CODES,
]);

function unavailable(): never {
  throw new Error('Gateway capability advertisement facts are unavailable');
}

function projection(value: unknown): GatewayCapabilityProjection {
  if (
    !object(value) ||
    !identifier(value.capability) ||
    !['provider-bundle', 'media', 'tls-fingerprint'].includes(String(value.kind)) ||
    typeof value.label !== 'string' ||
    value.label.length > 256 ||
    !['enabled', 'assembled', 'verified', 'operational'].every((key) => typeof value[key] === 'boolean') ||
    !['unverified', 'mock', 'live'].includes(String(value.verificationLevel)) ||
    value.verified !== (value.verificationLevel === 'live') ||
    !identifiers(value.productIds) ||
    !identifiers(value.endpointScopes) ||
    !identifiers(value.unavailableEndpointScopes) ||
    !identifiers(value.reasonCodes) ||
    !value.reasonCodes.every((code) => reasons.has(code)) ||
    value.reasonCodes.some((code) => (GATEWAY_CAPABILITY_FATAL_REASON_CODES as readonly string[]).includes(code)) ||
    (value.providerId !== undefined && !identifier(value.providerId)) ||
    (value.kind === 'provider-bundle' &&
      (!identifier(value.providerId) || value.capability !== `provider-bundle:${value.providerId}`)) ||
    (value.operational && (!value.enabled || !value.assembled))
  )
    return unavailable();
  const result = value as unknown as GatewayCapabilityProjection;
  if (
    result.unavailableEndpointScopes.some((scope) => !result.endpointScopes.includes(scope)) ||
    (isGatewayCapabilitySellable(result) &&
      (result.reasonCodes.length !== 0 || result.unavailableEndpointScopes.length !== 0))
  )
    return unavailable();
  return result;
}

const key = (target: GatewayCapabilityAdvertisementTarget): string =>
  `${target.providerId}\u0000${target.productId}\u0000${target.endpoint}`;

/**
 * Build one immutable advertisement decision from one freshly collected report.
 * Missing or invalid facts throw so HTTP consumers return their existing 503;
 * a valid report with no matching sellable bundle simply advertises no models.
 * Catalog rights and caller authorization remain separate intersections.
 */
export function createGatewayCapabilityAdvertisementPolicy(report: unknown): GatewayCapabilityAdvertisementPolicy {
  if (
    !object(report) ||
    report.configurationValid !== true ||
    !Array.isArray(report.fatalReasonCodes) ||
    report.fatalReasonCodes.length !== 0 ||
    !Array.isArray(report.capabilities) ||
    report.capabilities.length > 128
  )
    return unavailable();

  const capabilities = new Set<string>();
  const sellable = new Set<string>();
  for (const value of report.capabilities) {
    const capability = projection(value);
    if (capabilities.has(capability.capability)) return unavailable();
    capabilities.add(capability.capability);
    if (capability.kind !== 'provider-bundle' || !isGatewayCapabilitySellable(capability)) continue;
    for (const productId of capability.productIds) {
      for (const endpoint of capability.endpointScopes) {
        sellable.add(key({ providerId: capability.providerId as string, productId, endpoint }));
      }
    }
  }
  return (target) =>
    identifier(target.providerId) &&
    identifier(target.productId) &&
    identifier(target.endpoint) &&
    sellable.has(key(target));
}
