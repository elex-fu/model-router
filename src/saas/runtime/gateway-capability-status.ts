import { MODEL_ROUTER_SAAS_GATEWAY_ORIGIN } from '../deployment.js';
import {
  GATEWAY_CAPABILITY_FATAL_REASON_CODES,
  GATEWAY_CAPABILITY_READINESS_REASON_CODES,
  type GatewayCapabilityReadiness,
} from './gateway-capability-readiness.js';

export type GatewayCapabilityStatus =
  | { readonly state: 'available'; readonly observedAt: string; readonly readiness: GatewayCapabilityReadiness }
  | { readonly state: 'not-configured' | 'unavailable' };

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 128 && value.every(identifier);
const reasonCodes = new Set<string>([
  ...GATEWAY_CAPABILITY_FATAL_REASON_CODES,
  ...GATEWAY_CAPABILITY_READINESS_REASON_CODES,
]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Accept only the secret-free projection contract, never arbitrary probe fields. */
function parseProjection(value: unknown): GatewayCapabilityReadiness | undefined {
  if (
    !object(value) ||
    typeof value.configurationValid !== 'boolean' ||
    !ids(value.fatalReasonCodes) ||
    !value.fatalReasonCodes.every((code) =>
      (GATEWAY_CAPABILITY_FATAL_REASON_CODES as readonly string[]).includes(code),
    ) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 128
  )
    return;
  const capabilities: GatewayCapabilityReadiness['capabilities'][number][] = [];
  for (const entry of value.capabilities) {
    if (
      !object(entry) ||
      !identifier(entry.capability) ||
      !['provider-bundle', 'media', 'tls-fingerprint'].includes(String(entry.kind)) ||
      typeof entry.label !== 'string' ||
      entry.label.length > 256 ||
      [...entry.label].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      !['enabled', 'assembled', 'verified', 'operational'].every((key) => typeof entry[key] === 'boolean') ||
      !['unverified', 'mock', 'live'].includes(String(entry.verificationLevel)) ||
      !ids(entry.reasonCodes) ||
      !entry.reasonCodes.every((code) => reasonCodes.has(code)) ||
      !ids(entry.productIds) ||
      !ids(entry.endpointScopes) ||
      !ids(entry.unavailableEndpointScopes) ||
      (entry.providerId !== undefined && !identifier(entry.providerId))
    )
      return;
    capabilities.push({
      capability: entry.capability,
      kind: entry.kind as 'provider-bundle' | 'media' | 'tls-fingerprint',
      label: entry.label,
      enabled: entry.enabled as boolean,
      assembled: entry.assembled as boolean,
      verified: entry.verified as boolean,
      operational: entry.operational as boolean,
      verificationLevel: entry.verificationLevel as 'unverified' | 'mock' | 'live',
      reasonCodes: entry.reasonCodes as GatewayCapabilityReadiness['capabilities'][number]['reasonCodes'],
      productIds: [...entry.productIds],
      endpointScopes: [...entry.endpointScopes],
      unavailableEndpointScopes: [...entry.unavailableEndpointScopes],
      ...(entry.providerId === undefined ? {} : { providerId: entry.providerId as string }),
    });
  }
  return {
    configurationValid: value.configurationValid,
    fatalReasonCodes: value.fatalReasonCodes as GatewayCapabilityReadiness['fatalReasonCodes'],
    capabilities,
  };
}

/** Read the running gateway's assembled facts; loading a config cannot prove assembly. */
export async function readGatewayCapabilityStatus(
  environment: Readonly<Record<string, string | undefined>>,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<GatewayCapabilityStatus> {
  const origin = environment[MODEL_ROUTER_SAAS_GATEWAY_ORIGIN];
  if (!origin) return { state: 'not-configured' };
  try {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '') ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      return { state: 'unavailable' };
    url.pathname = '/readyz';
    const response = await fetcher(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.body) return { state: 'unavailable' };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 128 * 1024) {
          await reader.cancel();
          return { state: 'unavailable' };
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(body)) return { state: 'unavailable' };
    const readiness = parseProjection(body.providerCapabilities);
    return readiness
      ? { state: 'available', observedAt: new Date().toISOString(), readiness }
      : { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
}
