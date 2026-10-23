/**
 * Gateway capability readiness projection (core-plan §6.3; G-C1 §8.2,
 * docs/gap-remediation-technical-plan-2026-10-18.md).
 *
 * One pure, deterministic projection over the v2 runtime module extensions:
 *
 * - `enabled`      the configuration explicitly selects the capability;
 * - `assembled`    the core dispatch face (and, for media/TLS, the storage or
 *                  sidecar profile) is actually mounted;
 * - `verified`     a live verification record exists (mock/standard-assembly
 *                  records stay visible but never make a capability sellable);
 * - `operational`  catalog registration, supplier prices and credentials are
 *                  present, so the capability can serve right now.
 *
 * Configuration errors (an unknown bundle, an enabled bundle without its
 * dedicated dispatch face, a configured media storage or TLS profile the
 * deployment cannot serve) make `configurationValid` false and are fatal at
 * startup via `assertGatewayCapabilityAssembly`. Readiness gaps are reported
 * as sanitized reason codes instead: the capability returns 503 rather than
 * taking the whole gateway down (§6.3).
 *
 * The projection never echoes extension parameters or secret references. The
 * only identifiers it carries are bundle ids, endpoint scopes, media storage
 * ids and TLS profile ids — all bounded extension ids validated by the loader.
 */

import { codexTrustedBoundReadiness } from './codex-trusted-bound-profiles.js';
import type { GatewayRuntimeModuleExtensionsV2, ProviderBundleConfiguration } from './gateway-runtime-module.js';
import { type ProviderBundleManifest, providerBundleManifest } from './provider-bundles.js';

export type GatewayCapabilityKind = 'provider-bundle' | 'media' | 'tls-fingerprint';

/** Live records are the only level that makes a capability customer-sellable. */
export type GatewayCapabilityVerificationLevel = 'unverified' | 'mock' | 'live';

/**
 * `FATAL` codes invalidate the configuration at startup. The remaining codes
 * describe runtime readiness and are surfaced through doctor/admin views.
 */
export const GATEWAY_CAPABILITY_FATAL_REASON_CODES = Object.freeze([
  'PROVIDER_BUNDLE_UNKNOWN',
  'PROVIDER_BUNDLE_DISPATCH_UNAVAILABLE',
  'MEDIA_STORAGE_UNAVAILABLE',
  'TLS_PROFILE_UNAVAILABLE',
] as const);

export const GATEWAY_CAPABILITY_READINESS_REASON_CODES = Object.freeze([
  'CATALOG_PROVIDER_MISSING',
  'CATALOG_ENDPOINT_MISSING',
  'SUPPLIER_PRICE_MISSING',
  'CREDENTIALS_NOT_PROVISIONED',
  'VERIFICATION_NOT_RECORDED',
  'USAGE_BOUNDS_UNAVAILABLE',
] as const);

export type GatewayCapabilityFatalReasonCode = (typeof GATEWAY_CAPABILITY_FATAL_REASON_CODES)[number];
export type GatewayCapabilityReadinessReasonCode = (typeof GATEWAY_CAPABILITY_READINESS_REASON_CODES)[number];
export type GatewayCapabilityReasonCode = GatewayCapabilityFatalReasonCode | GatewayCapabilityReadinessReasonCode;

const FATAL_REASON_CODES: ReadonlySet<GatewayCapabilityReasonCode> = new Set(GATEWAY_CAPABILITY_FATAL_REASON_CODES);

export interface GatewayCapabilityDispatchFacts {
  /** True when the shared provider HTTP transport is mounted. */
  readonly generic: boolean;
  /** Endpoint scopes routed by a dedicated prepared-evidence transport. */
  readonly routedEndpointScopes: readonly string[];
}

export interface ProviderBundleReadinessFacts {
  /** Providers whose catalog registration rows exist. */
  readonly catalogProviderIds: readonly string[];
  /**
   * Endpoint scopes whose latest catalog capability row is supported and
   * verified, keyed by provider. Per-provider scoping is deliberate: a scope
   * registered or priced for one provider must never make another provider's
   * bundle look ready.
   */
  readonly catalogEndpointScopesByProvider: ReadonlyMap<string, readonly string[]>;
  /** Endpoint scopes with a current supplier price, keyed by provider. */
  readonly pricedEndpointScopesByProvider: ReadonlyMap<string, readonly string[]>;
  /** Providers with at least one provisioned, verified platform credential. */
  readonly credentialProviderIds: readonly string[];
}

export interface GatewayCapabilityFacts {
  readonly dispatch: GatewayCapabilityDispatchFacts;
  readonly bundles: ProviderBundleReadinessFacts;
  /**
   * Media storage ids the deployment can serve. The media extension is only
   * valid when its `storage` id appears here.
   */
  readonly mediaStorages: readonly string[];
  /** TLS sidecar profile ids the deployment can serve. */
  readonly tlsFingerprintProfiles: readonly string[];
  /**
   * Verification records keyed by capability id
   * (`provider-bundle:<bundle>`, `media:<storage>`,
   * `tls-fingerprint:<profile>`). Missing, malformed or unknown levels are
   * reported as `unverified` (fail closed).
   */
  readonly verification: Readonly<Record<string, GatewayCapabilityVerificationLevel>>;
  /** Provider faces with no proven admission usage bound for this standard runtime. */
  readonly unavailableUsageBoundProviderIds?: readonly string[];
  /** Explicit mounted workflow facts; an HTTP endpoint alone does not prove WS mounting. */
  readonly codexWorkflowTransports?: readonly CodexWorkflowReadiness['workflow'][];
}

export interface GatewayCapabilityProjection {
  /** Stable id: `<kind>:<identity>`. */
  readonly capability: string;
  readonly kind: GatewayCapabilityKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly assembled: boolean;
  readonly verified: boolean;
  readonly operational: boolean;
  readonly verificationLevel: GatewayCapabilityVerificationLevel;
  readonly reasonCodes: readonly GatewayCapabilityReasonCode[];
  /** Present for provider bundles only. */
  readonly providerId?: string;
  readonly productIds: readonly string[];
  readonly endpointScopes: readonly string[];
  /** Declared endpoint scopes whose dedicated transport is not mounted. */
  readonly unavailableEndpointScopes: readonly string[];
}

export interface CodexWorkflowReadiness {
  readonly workflow: 'responses-http-full' | 'responses-ws-full' | 'responses-ws-continuation' | 'responses-compact';
  readonly transportAssembled: boolean;
  readonly credentialVerified: boolean;
  readonly financiallyAdmissible: boolean;
  readonly workflowVerified: boolean;
}
export interface GatewayCapabilityReadiness {
  readonly configurationValid: boolean;
  readonly codexWorkflows?: readonly CodexWorkflowReadiness[];
  /** Fatal reason codes present in this report, deduplicated in canonical order. */
  readonly fatalReasonCodes: readonly GatewayCapabilityFatalReasonCode[];
  readonly capabilities: readonly GatewayCapabilityProjection[];
}

export interface GatewayCapabilityReadinessInput {
  /** Absent for v1 modules; the v1 contract has no extensions. */
  readonly extensions?: GatewayRuntimeModuleExtensionsV2;
  readonly facts: GatewayCapabilityFacts;
}

export interface GatewayCapabilityAssemblyFailure {
  readonly capability: string;
  readonly kind: GatewayCapabilityKind;
  readonly reasonCodes: readonly GatewayCapabilityReasonCode[];
}

export class GatewayCapabilityAssemblyError extends Error {
  constructor(readonly failures: readonly GatewayCapabilityAssemblyFailure[]) {
    // Fixed message: failures carry ids/reason codes only, never parameters
    // or secret references (the projection cannot echo them).
    super('Managed SaaS gateway capability assembly is invalid');
    this.name = 'GatewayCapabilityAssemblyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A capability may appear in customer-facing model/capability lists only
 * when it can serve now and has a live verification record. TLS sidecar
 * profiles are internal and are not listed regardless.
 */
export function isGatewayCapabilitySellable(capability: GatewayCapabilityProjection): boolean {
  return capability.enabled && capability.assembled && capability.verified && capability.operational;
}

function includes(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

function verificationLevel(facts: GatewayCapabilityFacts, capability: string): GatewayCapabilityVerificationLevel {
  if (!Object.hasOwn(facts.verification, capability)) return 'unverified';
  const level = facts.verification[capability];
  return level === 'live' || level === 'mock' ? level : 'unverified';
}

function pushReason(reasons: GatewayCapabilityReasonCode[], code: GatewayCapabilityReasonCode): void {
  if (!reasons.includes(code)) reasons.push(code);
}

function projectBundle(
  config: ProviderBundleConfiguration,
  facts: GatewayCapabilityFacts,
): GatewayCapabilityProjection {
  const capability = `provider-bundle:${config.bundle}`;
  const level = verificationLevel(facts, capability);
  const manifest = providerBundleManifest(config.bundle);

  if (manifest === undefined) {
    return Object.freeze({
      capability,
      kind: 'provider-bundle' as const,
      label: config.bundle,
      enabled: config.enabled,
      assembled: false,
      verified: level === 'live',
      operational: false,
      verificationLevel: level,
      reasonCodes: Object.freeze(['PROVIDER_BUNDLE_UNKNOWN'] as const),
      productIds: Object.freeze([]),
      endpointScopes: Object.freeze([]),
      unavailableEndpointScopes: Object.freeze([]),
    });
  }

  const reasonCodes: GatewayCapabilityReasonCode[] = [];
  let assembled = false;
  let unavailableEndpointScopes: readonly string[] = [];

  if (config.enabled) {
    if (manifest.dispatch === 'generic') {
      assembled = facts.dispatch.generic;
    } else {
      unavailableEndpointScopes = Object.freeze(
        manifest.endpointScopes.filter((scope) => !includes(facts.dispatch.routedEndpointScopes, scope)),
      );
      assembled =
        facts.dispatch.generic &&
        manifest.endpointScopes.every((scope) => includes(facts.dispatch.routedEndpointScopes, scope));
    }
    if (!assembled) pushReason(reasonCodes, 'PROVIDER_BUNDLE_DISPATCH_UNAVAILABLE');
  }

  const catalogProvider = includes(facts.bundles.catalogProviderIds, manifest.providerId);
  if (config.enabled && !catalogProvider) pushReason(reasonCodes, 'CATALOG_PROVIDER_MISSING');
  const catalogScopesForProvider = facts.bundles.catalogEndpointScopesByProvider.get(manifest.providerId) ?? [];
  const catalogScopes =
    config.enabled && manifest.endpointScopes.every((scope) => includes(catalogScopesForProvider, scope));
  if (config.enabled && !catalogScopes) pushReason(reasonCodes, 'CATALOG_ENDPOINT_MISSING');
  const pricedScopesForProvider = facts.bundles.pricedEndpointScopesByProvider.get(manifest.providerId) ?? [];
  const priced = config.enabled && manifest.endpointScopes.every((scope) => includes(pricedScopesForProvider, scope));
  if (config.enabled && !priced) pushReason(reasonCodes, 'SUPPLIER_PRICE_MISSING');
  const credentials = config.enabled && includes(facts.bundles.credentialProviderIds, manifest.providerId);
  if (config.enabled && !credentials) pushReason(reasonCodes, 'CREDENTIALS_NOT_PROVISIONED');
  const usageBoundAvailable = !(facts.unavailableUsageBoundProviderIds ?? []).includes(manifest.providerId);
  if (config.enabled && !usageBoundAvailable) pushReason(reasonCodes, 'USAGE_BOUNDS_UNAVAILABLE');

  const verified = level === 'live';
  if (config.enabled && !verified) pushReason(reasonCodes, 'VERIFICATION_NOT_RECORDED');

  // A disabled bundle is intentionally not assessed: its transport is not
  // expected to be mounted, and it must never be reported as serving.
  const operational =
    config.enabled && assembled && catalogProvider && catalogScopes && priced && credentials && usageBoundAvailable;

  return Object.freeze({
    capability,
    kind: 'provider-bundle' as const,
    label: manifest.displayName,
    enabled: config.enabled,
    assembled,
    verified,
    operational,
    verificationLevel: level,
    reasonCodes: Object.freeze(reasonCodes),
    providerId: manifest.providerId,
    productIds: manifest.productIds,
    endpointScopes: manifest.endpointScopes,
    unavailableEndpointScopes,
  });
}

function projectMedia(
  extensions: GatewayRuntimeModuleExtensionsV2,
  facts: GatewayCapabilityFacts,
): GatewayCapabilityProjection | undefined {
  const media = extensions.media;
  if (media === undefined) return undefined;
  const capability = `media:${media.storage}`;
  const level = verificationLevel(facts, capability);
  const assembled = includes(facts.mediaStorages, media.storage);
  const reasonCodes: GatewayCapabilityReasonCode[] = [];
  if (!assembled) pushReason(reasonCodes, 'MEDIA_STORAGE_UNAVAILABLE');
  const verified = level === 'live';
  if (!verified) pushReason(reasonCodes, 'VERIFICATION_NOT_RECORDED');
  return Object.freeze({
    capability,
    kind: 'media' as const,
    label: 'Media storage',
    enabled: true,
    assembled,
    verified,
    operational: assembled,
    verificationLevel: level,
    reasonCodes: Object.freeze(reasonCodes),
    productIds: Object.freeze([]),
    endpointScopes: Object.freeze([]),
    unavailableEndpointScopes: Object.freeze([]),
  });
}

function projectTlsFingerprint(
  extensions: GatewayRuntimeModuleExtensionsV2,
  facts: GatewayCapabilityFacts,
): GatewayCapabilityProjection | undefined {
  const tls = extensions.tlsFingerprint;
  if (tls === undefined) return undefined;
  const capability = `tls-fingerprint:${tls.profile}`;
  const level = verificationLevel(facts, capability);
  const assembled = includes(facts.tlsFingerprintProfiles, tls.profile);
  const reasonCodes: GatewayCapabilityReasonCode[] = [];
  if (!assembled) pushReason(reasonCodes, 'TLS_PROFILE_UNAVAILABLE');
  const verified = level === 'live';
  if (!verified) pushReason(reasonCodes, 'VERIFICATION_NOT_RECORDED');
  return Object.freeze({
    capability,
    kind: 'tls-fingerprint' as const,
    label: 'TLS fingerprint sidecar',
    enabled: true,
    assembled,
    verified,
    operational: assembled,
    verificationLevel: level,
    reasonCodes: Object.freeze(reasonCodes),
    productIds: Object.freeze([]),
    endpointScopes: Object.freeze([]),
    unavailableEndpointScopes: Object.freeze([]),
  });
}

/**
 * Pure projection: never throws, never performs I/O, and preserves extension
 * order for provider bundles (media and TLS follow, when configured).
 */
export function projectGatewayCapabilityReadiness(input: GatewayCapabilityReadinessInput): GatewayCapabilityReadiness {
  const { extensions, facts } = input;
  const capabilities: GatewayCapabilityProjection[] = [];
  if (extensions !== undefined) {
    for (const config of extensions.providerBundles) capabilities.push(projectBundle(config, facts));
    const media = projectMedia(extensions, facts);
    if (media !== undefined) capabilities.push(media);
    const tls = projectTlsFingerprint(extensions, facts);
    if (tls !== undefined) capabilities.push(tls);
  }

  const fatalReasonCodes: GatewayCapabilityFatalReasonCode[] = [];
  for (const capability of capabilities) {
    for (const code of capability.reasonCodes) {
      if (FATAL_REASON_CODES.has(code) && !fatalReasonCodes.includes(code as GatewayCapabilityFatalReasonCode)) {
        fatalReasonCodes.push(code as GatewayCapabilityFatalReasonCode);
      }
    }
  }

  return Object.freeze({
    configurationValid: fatalReasonCodes.length === 0,
    fatalReasonCodes: Object.freeze(fatalReasonCodes),
    capabilities: Object.freeze(capabilities),
    ...(capabilities.some((capability) => capability.providerId === 'openai-codex') ? {
      codexWorkflows: Object.freeze((['responses-http-full', 'responses-ws-full', 'responses-ws-continuation', 'responses-compact'] as const).map((workflow) => Object.freeze({
        workflow,
        transportAssembled: (facts.codexWorkflowTransports ?? []).includes(workflow) || (workflow === 'responses-http-full' && facts.dispatch.routedEndpointScopes.includes('codex-responses')),
        credentialVerified: facts.bundles.credentialProviderIds.includes('openai-codex'),
        financiallyAdmissible: codexTrustedBoundReadiness().admittedProfileCount > 0 && !(facts.unavailableUsageBoundProviderIds ?? []).includes('openai-codex'),
        workflowVerified: facts.verification[`codex-workflow:${workflow}`] === 'live',
      }))),
    } : {}),
  });
}

/**
 * Startup guard: an explicitly enabled but unassembled capability is a
 * configuration error (§6.3), never a silent runtime downgrade.
 */
export function assertGatewayCapabilityAssembly(input: GatewayCapabilityReadinessInput): GatewayCapabilityReadiness {
  const report = projectGatewayCapabilityReadiness(input);
  if (report.configurationValid) return report;

  const failures = report.capabilities
    .filter((capability) => capability.reasonCodes.some((code) => FATAL_REASON_CODES.has(code)))
    .map((capability) =>
      Object.freeze({
        capability: capability.capability,
        kind: capability.kind,
        reasonCodes: Object.freeze(capability.reasonCodes.filter((code) => FATAL_REASON_CODES.has(code))),
      }),
    );
  throw new GatewayCapabilityAssemblyError(Object.freeze(failures));
}

/** Exported for tests and callers that classify fatal vs readiness codes. */
export function isGatewayCapabilityFatalReasonCode(
  code: GatewayCapabilityReasonCode,
): code is GatewayCapabilityFatalReasonCode {
  return FATAL_REASON_CODES.has(code);
}

export type { ProviderBundleManifest };
