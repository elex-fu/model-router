/**
 * R9 §4 P1: the operator-configurable egress allowlist for the provider HTTP
 * SSRF policy (registration-settings.ts is the config-grammar precedent).
 *
 * A dedicated-gateway deployment may carry container-network providers
 * (Docker 172.x, k8s services, private VPCs) that the default global-only
 * address policy must reject. `MODEL_ROUTER_SAAS_PROVIDER_EGRESS_ALLOWLIST`
 * is the authenticated-operator escape hatch: a comma-separated list of
 * explicit CIDR networks that additionally permit dispatch. Grammar:
 *
 * - unset/empty → empty allowlist → the exact pre-R9 fail-closed posture
 *   (zero behavior change for existing deployments);
 * - every entry must be a canonical (host bits zero), non-/0 IPv4/IPv6 CIDR
 *   network — malformed input throws at config load and startup fails closed;
 * - addresses outside the entries remain denied exactly as before, including
 *   loopback and link-local (no implicit carve-outs — they need their own
 *   explicit entry like any other range).
 *
 * CIDR entries are not secrets; the effective allowlist is safe to log at
 * startup.
 */

import {
  createProviderHttpEgressAllowlist,
  type ProviderHttpEgressAllowlist,
  ProviderHttpEgressAllowlistError,
} from './provider-http-address.js';

export const PROVIDER_EGRESS_ALLOWLIST_ENV_VAR = 'MODEL_ROUTER_SAAS_PROVIDER_EGRESS_ALLOWLIST';

/** Strict parser for the egress-allowlist environment grammar (fail-closed on any malformed value). */
export function parseProviderEgressAllowlistSettings(
  values: Readonly<Record<string, string | undefined>>,
): ProviderHttpEgressAllowlist {
  if (!values || typeof values !== 'object') {
    throw new ProviderHttpEgressAllowlistError('Invalid egress-allowlist settings source');
  }
  const raw = values[PROVIDER_EGRESS_ALLOWLIST_ENV_VAR];
  if (raw === undefined || raw === '') return createProviderHttpEgressAllowlist([]);
  if (typeof raw !== 'string' || raw.includes('\u0000')) {
    throw new ProviderHttpEgressAllowlistError(
      `${PROVIDER_EGRESS_ALLOWLIST_ENV_VAR} must be a comma-separated list of CIDR networks`,
    );
  }
  const entries = raw.split(',').map((part) => part.trim());
  if (entries.some((entry) => entry === '')) {
    throw new ProviderHttpEgressAllowlistError(`${PROVIDER_EGRESS_ALLOWLIST_ENV_VAR} contains an empty CIDR entry`);
  }
  return createProviderHttpEgressAllowlist(entries);
}
