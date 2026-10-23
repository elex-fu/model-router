import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Headers as UndiciHeaders, fetch as undiciFetch } from 'undici';
import type {
  ManagedSaasGatewayProductionOptions,
  ManagedSaasProviderPreparationRouteResolver,
  ManagedSaasProviderTargetRouteResolver,
} from '../../server/managed-saas-gateway.js';
import { S3ObjectClient } from '../../storage/s3-object-client.js';
import type { SaasDatabase } from '../db/types.js';
import { CLAUDE_CLI_BASELINE_VERSION } from '../gateway/claude/constants.js';
import { applyClaudeOAuthTransform } from '../gateway/claude/transform.js';
import { CN_PROVIDER_TARGET_BINDINGS } from '../gateway/cn-providers/constants.js';
import { applyCodexCompilation } from '../gateway/codex/payload.js';
import type { GatewayProtocol } from '../gateway/contracts.js';
import { normalizeGeminiToolsForAiStudio } from '../gateway/gemini/transform.js';
import type { ProviderHttpFetch } from '../gateway/provider-http-transport.js';
import {
  allowRequestPreparation,
  blockRequestPreparation,
  type RequestPreparationEntitlementPort,
  rejectRequestPreparation,
} from '../gateway/request-preparation-service.js';
import type { TenantContext } from '../identity/types.js';
import { PostgresSupplyProfileResolver } from '../keys/resolver.js';
import { ByokServicePlanService } from '../plans/service.js';
import { createBuiltinProviderEvidenceTransportFactory } from './builtin-provider-transports.js';
import { createBuiltinUsageUpperBoundEstimator } from './builtin-usage-bounds.js';
import type { GatewayCapabilityReadiness, GatewayCapabilityVerificationLevel } from './gateway-capability-readiness.js';
import { assertGatewayCapabilityAssembly, projectGatewayCapabilityReadiness } from './gateway-capability-readiness.js';
import type {
  GatewayProviderAccountAffinityKeyring,
  GatewayRuntimeModuleExtensionsV2,
  ManagedSaasGatewayRuntimeDependencies,
  ManagedSaasGatewayRuntimeModuleOptions,
  ProviderBundleConfiguration,
} from './gateway-runtime-module.js';
import { parseGatewayRuntimeExtensions } from './gateway-runtime-module.js';
import {
  type TrustedPreparedRequestVerifierKeyDefinition,
  TrustedPreparedRequestVerifierKeyRegistry,
} from './prepared-evidence-verifier-keys.js';
import { PreparedRequestEvidenceSigner } from './prepared-request-evidence-signer.js';
import type { GatewayCapabilityDeploymentFacts } from './provider-bundle-readiness-facts.js';
import { collectGatewayCapabilityFacts } from './provider-bundle-readiness-facts.js';
import { providerBundleManifest } from './provider-bundles.js';
import {
  type ProviderTargetBinding,
  type ProviderTargetResolveInput,
  ProviderTargetResolver,
} from './provider-target-resolver.js';

export const BUILTIN_GATEWAY_RUNTIME_MODULE = 'builtin' as const;
export const MODEL_ROUTER_SAAS_GATEWAY_BUILTIN_CONFIG = 'MODEL_ROUTER_SAAS_GATEWAY_BUILTIN_CONFIG' as const;

export class BuiltinGatewayRuntimeConfigurationError extends Error {
  readonly code = 'BUILTIN_GATEWAY_CONFIGURATION_INVALID';
  constructor() {
    super('Managed SaaS built-in gateway configuration is invalid');
    this.name = 'BuiltinGatewayRuntimeConfigurationError';
  }
}

function invalid(): never {
  throw new BuiltinGatewayRuntimeConfigurationError();
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const result = object(value);
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Reflect.ownKeys(result).some((key) => typeof key !== 'string' || ![...required, ...optional].includes(key))
  )
    return invalid();
  return result;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) return invalid();
  return value;
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || hasControlCharacters(value))
    return invalid();
  return value;
}
async function boundedFile(file: unknown, maxBytes: number, privateFile = false): Promise<Buffer> {
  const filePath = path(file);
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0 || info.size > maxBytes || (privateFile && (info.mode & 0o077) !== 0))
    return invalid();
  const bytes = await readFile(filePath);
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    bytes.fill(0);
    return invalid();
  }
  return bytes;
}
function positive(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) return invalid();
  return value;
}
function protocol(value: unknown): GatewayProtocol {
  if (value !== 'anthropic' && value !== 'openai' && value !== 'gemini' && value !== 'responses') return invalid();
  return value;
}
function operation(value: GatewayProtocol): string {
  return { anthropic: 'messages', openai: 'chat.completions', gemini: 'generateContent', responses: 'responses' }[
    value
  ];
}
function printable(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || hasControlCharacters(value))
    return invalid();
  return value;
}
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}
async function checkSidecar(socketPath: string): Promise<void> {
  const info = await stat(socketPath);
  if (!info.isSocket()) return invalid();
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', () => {
      socket.destroy();
      reject(new BuiltinGatewayRuntimeConfigurationError());
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new BuiltinGatewayRuntimeConfigurationError());
    });
  });
}

/** Database authority is re-read for each request; caller scopes never create entitlement rights. */
export function createBuiltinGatewayEntitlementResolver(database: SaasDatabase): RequestPreparationEntitlementPort {
  const profiles = new PostgresSupplyProfileResolver(database);
  const plans = new ByokServicePlanService(database);
  return {
    async resolve({ caller, publicModel }) {
      try {
        const resolved = await profiles.resolve(
          { tenantId: caller.tenantId, projectId: caller.projectId } as TenantContext,
          caller.supplyMode,
          { entitlementId: caller.entitlementId },
        );
        const projects = await database.query<{
          inference_policy_status: string;
          inference_policy_version: string | number;
        }>(
          'SELECT inference_policy_status, inference_policy_version FROM saas_projects WHERE tenant_id = $1 AND id = $2 LIMIT 2',
          [caller.tenantId, caller.projectId],
        );
        const project = projects.rows[0];
        if (
          !resolved ||
          resolved.modelScopeVersion === undefined ||
          projects.rows.length !== 1 ||
          project?.inference_policy_status !== 'active' ||
          resolved.profileId !== caller.supplyProfileId ||
          String(resolved.entitlementAuthzVersion) !== String(caller.entitlementVersion) ||
          String(resolved.supplyProfileAuthzVersion) !== String(caller.supplyProfileVersion) ||
          String(resolved.modelScopeVersion) !== String(caller.modelScopeVersion) ||
          !resolved.allowedModels.includes(publicModel)
        ) {
          return rejectRequestPreparation(
            'entitlement_denied',
            'The project entitlement does not authorize this request.',
          );
        }
        let allowedProviderIds: readonly string[] = [];
        if (caller.supplyMode === 'byok') {
          const bound = await plans.resolveBoundForRequest(
            { tenantId: caller.tenantId, projectId: caller.projectId },
            caller.entitlementId,
          );
          if (
            !bound?.modelScopes.includes(publicModel) ||
            String(bound.entitlementAuthzVersion) !== String(caller.entitlementVersion)
          )
            return rejectRequestPreparation('entitlement_denied', 'The service plan does not authorize this request.');
          allowedProviderIds = bound.allowedProviderIds;
        }
        return allowRequestPreparation({
          tenantId: caller.tenantId,
          projectId: caller.projectId,
          proxyKeyId: caller.proxyKeyId,
          entitlementId: resolved.entitlementId,
          entitlementVersion: resolved.entitlementAuthzVersion,
          supplyProfileId: resolved.profileId,
          supplyProfileVersion: resolved.supplyProfileAuthzVersion,
          supplyMode: resolved.mode,
          modelScopeVersion: resolved.modelScopeVersion,
          allowedModels: resolved.allowedModels,
          allowedProviderIds,
          projectPolicyVersion: String(project.inference_policy_version),
        });
      } catch {
        return blockRequestPreparation('storage_failure', 'The project entitlement authority is unavailable.');
      }
    },
  };
}

interface FixedTarget {
  readonly productId: string;
  readonly protocol: string;
  readonly operation: string;
  readonly baseUrl: string;
  readonly path: string;
}
function targets(bundles: readonly ProviderBundleConfiguration[]): readonly FixedTarget[] {
  const selected = new Set(bundles.filter((bundle) => bundle.enabled).map((bundle) => bundle.bundle));
  const result: FixedTarget[] = [];
  if (selected.has('kimi'))
    result.push({
      productId: 'kimi-code',
      protocol: 'anthropic',
      operation: 'messages',
      baseUrl: 'https://api.kimi.com/coding/v1',
      path: '/messages',
    });
  if (selected.has('openrouter'))
    result.push({
      productId: 'openrouter-api',
      protocol: 'openai',
      operation: 'chat.completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      path: '/chat/completions',
    });
  if (selected.has('opencode-go'))
    for (const [native, op, suffix] of [
      ['openai', 'chat.completions', '/v1/chat/completions'],
      ['anthropic', 'messages', '/v1/messages'],
      ['responses', 'responses', '/v1/responses'],
    ] as const)
      result.push({
        productId: 'opencode-go-zen',
        protocol: native,
        operation: op,
        baseUrl: 'https://opencode.ai/zen/go',
        path: suffix,
      });
  for (const binding of CN_PROVIDER_TARGET_BINDINGS) {
    const manifest = bundles.find(
      (bundle) => bundle.enabled && providerBundleManifest(bundle.bundle)?.productIds.includes(binding.productId ?? ''),
    );
    if (manifest)
      result.push({
        productId: binding.productId ?? '',
        protocol: binding.protocol,
        operation: binding.operation,
        baseUrl: binding.baseUrl,
        path: binding.path,
      });
  }
  return Object.freeze(result);
}

/** Fixed core targets still use the strict production target resolver for each concrete upstream tuple. */
export function createBuiltinProviderTargetResolver(bundles: readonly ProviderBundleConfiguration[]): {
  readonly resolver: Pick<ProviderTargetResolver, 'resolve'>;
  readonly endpointPolicy: { readonly allowedHosts: readonly string[]; readonly allowedPorts: readonly number[] };
} {
  const fixed = targets(bundles);
  const allowedHosts = Object.freeze([...new Set(fixed.map((target) => new URL(target.baseUrl).hostname))].sort());
  // Dedicated-only deployments still need a nonempty generic transport policy.
  const endpointPolicy = Object.freeze({
    allowedHosts: allowedHosts.length ? allowedHosts : Object.freeze(['api.anthropic.com']),
    allowedPorts: Object.freeze([443]),
  });
  return {
    endpointPolicy,
    resolver: {
      resolve(input: ProviderTargetResolveInput) {
        const productId = input.productId ?? input.product;
        const target = fixed.find(
          (entry) =>
            entry.productId === productId && entry.protocol === input.protocol && entry.operation === input.operation,
        );
        if (!target) throw new Error('Built-in provider target is unavailable');
        const binding: ProviderTargetBinding = {
          ...target,
          upstreamId: input.upstreamId,
          allowedHosts: endpointPolicy.allowedHosts,
          allowedPorts: endpointPolicy.allowedPorts,
          method: 'POST',
        };
        return new ProviderTargetResolver({ bindings: [binding] }).resolve(input);
      },
    },
  };
}

export interface BuiltinGatewayRuntimeHandle {
  readonly dependencies: ManagedSaasGatewayRuntimeDependencies;
  readonly extensions: GatewayRuntimeModuleExtensionsV2;
  readonly deploymentFacts: GatewayCapabilityDeploymentFacts;
  getCapabilityReadiness(): Promise<GatewayCapabilityReadiness>;
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

/** Production standard factory: declarative config in, real PostgreSQL/catalog/crypto/transports out. */
export async function createBuiltinManagedSaasGatewayRuntime(
  options: ManagedSaasGatewayRuntimeModuleOptions,
): Promise<BuiltinGatewayRuntimeHandle> {
  const retainedSecrets: Uint8Array[] = [];
  let transportFactory: ReturnType<typeof createBuiltinProviderEvidenceTransportFactory> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    transportFactory?.close();
    for (const secret of retainedSecrets) secret.fill(0);
  };
  options.lifecycle.registerCloseHook(close);
  try {
    const configBytes = await boundedFile(options.env[MODEL_ROUTER_SAAS_GATEWAY_BUILTIN_CONFIG], 128 * 1024);
    const config = exact(
      JSON.parse(configBytes.toString('utf8')),
      ['apiVersion', 'extensions', 'signing', 'affinity', 'idempotencyKeyFile'],
      ['limits', 'verificationRecordsFile'],
    );
    if (config.apiVersion !== 2) return invalid();
    const extensions = parseGatewayRuntimeExtensions(config.extensions);
    for (const bundle of extensions.providerBundles) {
      if (!providerBundleManifest(bundle.bundle) || Object.keys(bundle.secretReferences ?? {}).length) return invalid();
      const parameters = exact(bundle.parameters ?? {}, [], bundle.bundle === 'openai-codex' ? ['nativeCompact'] : []);
      if (parameters.nativeCompact !== undefined && typeof parameters.nativeCompact !== 'boolean') return invalid();
    }
    const nativeCompact = extensions.providerBundles.some(
      (bundle) => bundle.bundle === 'openai-codex' && bundle.enabled && bundle.parameters?.nativeCompact === true,
    );
    let verification: Readonly<Record<string, GatewayCapabilityVerificationLevel>> = Object.freeze({});
    async function refreshVerification() {
      if (config.verificationRecordsFile === undefined) return;
      const bytes = await boundedFile(config.verificationRecordsFile, 128 * 1024);
      const records: unknown = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(records) || records.length > 66) return invalid();
      const observed: Record<string, GatewayCapabilityVerificationLevel> = Object.create(null);
      const configured = new Set([
        ...extensions.providerBundles
          .filter((bundle) => bundle.enabled)
          .map((bundle) => `provider-bundle:${bundle.bundle}`),
        ...(extensions.providerBundles.some((bundle) => bundle.bundle === 'openai-codex' && bundle.enabled) ? ['responses-http-full', 'responses-ws-full', 'responses-ws-continuation', 'responses-compact'].map((workflow) => `codex-workflow:${workflow}`) : []),
        ...(extensions.media ? [`media:${extensions.media.storage}`] : []),
        ...(extensions.tlsFingerprint ? [`tls-fingerprint:${extensions.tlsFingerprint.profile}`] : []),
      ]);
      for (const value of records) {
        const entry = exact(value, ['capability', 'level', 'verifiedAt', 'evidenceFile', 'evidenceSha256']);
        const capability = printable(entry.capability, 256);
        if (
          !configured.has(capability) ||
          Object.hasOwn(observed, capability) ||
          (entry.level !== 'mock' && entry.level !== 'live') ||
          typeof entry.evidenceSha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.test(entry.evidenceSha256)
        )
          return invalid();
        const verifiedAt = Date.parse(printable(entry.verifiedAt, 64));
        if (!Number.isFinite(verifiedAt) || verifiedAt > Date.now() + 60_000) return invalid();
        const evidence = await boundedFile(entry.evidenceFile, 1024 * 1024);
        if (createHash('sha256').update(evidence).digest('hex') !== entry.evidenceSha256) return invalid();
        // An expired observation remains visible as unverified. A config
        // record cannot silently grant perpetual commercial verification.
        observed[capability] = Date.now() - verifiedAt > 30 * 24 * 60 * 60 * 1000 ? 'unverified' : entry.level;
      }
      verification = Object.freeze(observed);
    }
    await refreshVerification();
    async function referencedSecret(reference: unknown, maxBytes = 4096): Promise<string> {
      const ref = printable(reference);
      let bytes: Buffer;
      if (ref.startsWith('file://')) bytes = await boundedFile(fileURLToPath(ref), maxBytes, true);
      else if (ref.startsWith('env://') && /^[A-Z][A-Z0-9_]{0,127}$/.test(ref.slice(6)))
        bytes = Buffer.from(printable(options.env[ref.slice(6)], maxBytes), 'utf8');
      else return invalid();
      retainedSecrets.push(bytes);
      return printable(bytes.toString('utf8'), maxBytes);
    }
    let imageMedia: ManagedSaasGatewayProductionOptions['imageMedia'];
    if (extensions.media) {
      if (extensions.media.storage !== 's3') return invalid();
      const parameters = exact(
        extensions.media.parameters,
        ['endpoint', 'bucket', 'region'],
        ['forcePathStyle', 'publicBaseUrl', 'keyPrefix', 'taskTtlMs', 'executionTimeoutMs'],
      );
      const secrets = exact(extensions.media.secretReferences, ['accessKeyId', 'secretAccessKey']);
      const endpoint = new URL(printable(parameters.endpoint));
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        return invalid();
      if (parameters.forcePathStyle !== undefined && typeof parameters.forcePathStyle !== 'boolean') return invalid();
      const publicBaseUrl = parameters.publicBaseUrl === undefined ? undefined : printable(parameters.publicBaseUrl);
      if (publicBaseUrl !== undefined) {
        const publicUrl = new URL(publicBaseUrl);
        if (
          publicUrl.protocol !== 'https:' ||
          publicUrl.username ||
          publicUrl.password ||
          publicUrl.search ||
          publicUrl.hash
        )
          return invalid();
      }
      const s3 = {
        endpoint: endpoint.toString(),
        bucket: printable(parameters.bucket, 63),
        region: printable(parameters.region, 64),
        accessKeyId: await referencedSecret(secrets.accessKeyId, 128),
        secretAccessKey: await referencedSecret(secrets.secretAccessKey, 256),
        ...(parameters.forcePathStyle === undefined ? {} : { forcePathStyle: parameters.forcePathStyle }),
        ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
      };
      new S3ObjectClient(s3); // Validate with the same client the core mounts.
      imageMedia = {
        s3,
        ...(parameters.keyPrefix === undefined ? {} : { keyPrefix: printable(parameters.keyPrefix, 1024) }),
        taskTtlMs: positive(parameters.taskTtlMs, 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000),
        executionTimeoutMs: positive(parameters.executionTimeoutMs, 30 * 60 * 1000, 24 * 60 * 60 * 1000),
      };
    }
    let tlsFingerprintResolution: ManagedSaasGatewayProductionOptions['tlsFingerprintResolution'];
    let tlsReachable = false;
    if (extensions.tlsFingerprint) {
      const parameters = exact(extensions.tlsFingerprint.parameters, ['sidecarSocketPath']);
      if (Object.keys(extensions.tlsFingerprint.secretReferences ?? {}).length) return invalid();
      const sidecarSocketPath = path(parameters.sidecarSocketPath);
      if (!['default', 'random'].includes(extensions.tlsFingerprint.profile)) {
        const profiles = await options.database.query<{ name: string }>(
          'SELECT name FROM saas_tls_fingerprint_profiles WHERE name=$1 LIMIT 2',
          [extensions.tlsFingerprint.profile],
        );
        if (profiles.rows.length !== 1) return invalid();
      }
      await checkSidecar(sidecarSocketPath);
      tlsReachable = true;
      tlsFingerprintResolution = { enabled: true, sidecarSocketPath };
    }
    const signing = exact(config.signing, ['verifierKeyId', 'privateKeyFile', 'trustedPublicKeys']);
    const verifierKeyId = identifier(signing.verifierKeyId);
    if (
      !Array.isArray(signing.trustedPublicKeys) ||
      signing.trustedPublicKeys.length < 1 ||
      signing.trustedPublicKeys.length > 8
    )
      return invalid();
    const publicKeys: TrustedPreparedRequestVerifierKeyDefinition[] = [];
    for (const value of signing.trustedPublicKeys) {
      const entry = exact(value, ['keyId', 'publicKeyFile', 'status']);
      if (entry.status !== 'active' && entry.status !== 'retired') return invalid();
      const publicKey = createPublicKey(await boundedFile(entry.publicKeyFile, 16 * 1024));
      publicKeys.push({ keyId: identifier(entry.keyId), publicKey, status: entry.status });
    }
    const registry = new TrustedPreparedRequestVerifierKeyRegistry({ keys: publicKeys });
    const privateBytes = await boundedFile(signing.privateKeyFile, 16 * 1024, true);
    let evidenceSigner: PreparedRequestEvidenceSigner;
    try {
      evidenceSigner = new PreparedRequestEvidenceSigner({
        registry,
        verifierKeyId,
        privateKey: createPrivateKey(privateBytes),
      });
    } finally {
      privateBytes.fill(0);
    }
    const affinity = exact(config.affinity, ['activeKeyVersion', 'keys']);
    if (!Array.isArray(affinity.keys) || affinity.keys.length < 1 || affinity.keys.length > 8) return invalid();
    const affinityKeys = [];
    for (const value of affinity.keys) {
      const entry = exact(value, ['version', 'keyFile']);
      const key = await boundedFile(entry.keyFile, 4096, true);
      retainedSecrets.push(key);
      if (key.byteLength < 32) return invalid();
      affinityKeys.push(Object.freeze({ version: identifier(entry.version), key }));
    }
    const affinityKeyring: GatewayProviderAccountAffinityKeyring = Object.freeze({
      activeKeyVersion: identifier(affinity.activeKeyVersion),
      keys: Object.freeze(affinityKeys),
    });
    if (
      !affinityKeys.some((entry) => entry.version === affinityKeyring.activeKeyVersion) ||
      new Set(affinityKeys.map((entry) => entry.version)).size !== affinityKeys.length
    )
      return invalid();
    const idempotencyHmacKey = await boundedFile(config.idempotencyKeyFile, 4096, true);
    retainedSecrets.push(idempotencyHmacKey);
    if (idempotencyHmacKey.byteLength < 32) return invalid();
    const limits =
      config.limits === undefined
        ? {}
        : exact(
            config.limits,
            [],
            ['timeoutMs', 'maxConcurrency', 'leaseTtlMs', 'maxBodyBytes', 'maxInputTokens', 'maxOutputTokens'],
          );
    const timeoutMs = positive(limits.timeoutMs, 300_000, 3_600_000);
    const maxConcurrency = positive(limits.maxConcurrency, 16, 100_000);
    const leaseTtlMs = positive(limits.leaseTtlMs, 600_000, 3_600_000);
    const maxBodyBytes = positive(limits.maxBodyBytes, 16 * 1024 * 1024, 64 * 1024 * 1024);
    const maxInputTokens = positive(limits.maxInputTokens, 262_144, 16_777_216);
    if (maxInputTokens < 8192) return invalid();
    const maxOutputTokens = positive(limits.maxOutputTokens, 131_072, 1_048_576);
    const defaultOutputTokens = Math.min(4096, maxOutputTokens);
    const enabled = extensions.providerBundles
      .filter((bundle) => bundle.enabled)
      .map((bundle) => providerBundleManifest(bundle.bundle));
    const fetch: ProviderHttpFetch = (url, init) => {
      if (closed) throw new Error('Built-in gateway runtime is closed');
      const headers = new UndiciHeaders(init.headers);
      if (new URL(url).hostname === 'api.kimi.com') headers.set('anthropic-version', '2023-06-01');
      return undiciFetch(url, { ...init, headers } as Parameters<
        typeof undiciFetch
      >[1]) as unknown as Promise<Response>;
    };
    transportFactory = createBuiltinProviderEvidenceTransportFactory({
      database: options.database,
      providerBundles: extensions.providerBundles,
      fetch,
      timeoutMs,
    });
    const target = createBuiltinProviderTargetResolver(extensions.providerBundles);
    const compactModels = new Set<string>();
    async function refreshCompactModels() {
      if (!nativeCompact) return;
      const rows = await options.database.query<{ alias: string }>(`SELECT DISTINCT public_model.alias
        FROM saas_public_models public_model JOIN saas_public_model_versions model ON model.public_model_id=public_model.id
        WHERE public_model.status='active' AND model.status='active' AND model.provider_id='openai-codex' AND model.product_id='codex-chatgpt'
          AND model.version=(SELECT max(latest.version) FROM saas_public_model_versions latest WHERE latest.public_model_id=model.public_model_id)`);
      compactModels.clear();
      for (const row of rows.rows)
        if (typeof row.alias === 'string' && row.alias.length > 0) compactModels.add(row.alias);
    }
    await refreshCompactModels();
    const providerPreparationRoute: ManagedSaasProviderPreparationRouteResolver = async ({ authority }) => {
      const manifest = enabled.find(
        (entry) =>
          entry?.providerId === authority.candidate.providerId &&
          entry.productIds.includes(authority.candidate.productId),
      );
      if (!manifest || !authority.modelResolution)
        throw new Error('Built-in provider preparation route is unavailable');
      const clientProtocol = protocol(authority.route.protocol);
      const providerProtocol = protocol(authority.route.providerProtocol ?? authority.candidate.protocol);
      if (!manifest.protocols.includes(providerProtocol)) throw new Error('Built-in provider protocol is unavailable');
      return {
        clientProtocol,
        providerProtocol,
        clientOperation: authority.route.clientOperation ?? operation(clientProtocol),
        providerOperation: authority.route.providerOperation ?? operation(providerProtocol),
        modelResolution: authority.modelResolution,
      };
    };
    const providerTargetRoute: ManagedSaasProviderTargetRouteResolver = async (input) => {
      const manifest = enabled.find((entry) => entry?.endpointScopes.includes(input.endpoint));
      if (!manifest) return null;
      const productId = manifest.productIds.find((product) => product === input.endpoint) ?? manifest.productIds[0];
      return productId
        ? {
            productId,
            providerProtocol: input.providerProtocol ?? input.protocol,
            providerOperation: input.providerOperation ?? operation(protocol(input.providerProtocol ?? input.protocol)),
          }
        : null;
    };
    const dependencies: ManagedSaasGatewayRuntimeDependencies = {
      entitlementResolver: createBuiltinGatewayEntitlementResolver(options.database),
      schedulerAuthorities: { affinityKeyring, leaseConcurrencyLimit: maxConcurrency },
      idempotencyHmacKey,
      providerPreparationRoute,
      providerTargetRoute,
      providerTargetResolver: target.resolver,
      providerEvidenceTransports: transportFactory.factory,
      egressProxyResolution: { enabled: true },
      ...(nativeCompact ? { responsesCompactNativeSupply: (model: string) => compactModels.has(model) } : {}),
      ...(imageMedia ? { imageMedia } : {}),
      ...(tlsFingerprintResolution ? { tlsFingerprintResolution } : {}),
      providerNativeProtocol: (providerId, productId, _model, clientProtocol) => {
        const manifest = enabled.find(
          (entry) => entry?.providerId === providerId && entry.productIds.includes(productId),
        );
        if (!manifest) throw new Error('Built-in provider protocol is unavailable');
        const native = manifest.protocols.length === 1 ? protocol(manifest.protocols[0]) : clientProtocol;
        if (native !== clientProtocol && !(manifest.bundle === 'kimi' && clientProtocol === 'openai'))
          throw new Error('Built-in provider client protocol is unavailable');
        return native;
      },
      providerPayload: {
        estimator: createBuiltinUsageUpperBoundEstimator({ maxInputTokens, maxOutputTokens }),
        modelCompatibility: async (input) => {
          const manifest = enabled.find(
            (entry) => entry?.providerId === input.providerId && entry.productIds.includes(input.productId),
          );
          if (!manifest) return false;
          const rows = await options.database.query<{
            support_level: string;
            validation_state: string;
            protocol: string;
          }>(
            `SELECT support_level, validation_state, protocol FROM saas_provider_capabilities WHERE provider_id=$1 AND product_id=$2 AND model=$3 AND endpoint=ANY($4::text[]) ORDER BY version DESC LIMIT 1`,
            [input.providerId, input.productId, input.providerModel, manifest.endpointScopes],
          );
          const row = rows.rows[0];
          return (
            row?.support_level === 'supported' &&
            row.validation_state === 'verified' &&
            (row.protocol === input.providerProtocol ||
              manifest.dispatch === 'cn-providers' ||
              manifest.dispatch === 'opencode-go')
          );
        },
        providerRequestTransform: (input) => {
          const bounded =
            input.providerProtocol === 'anthropic' && input.body.max_tokens === undefined
              ? { ...input.body, max_tokens: defaultOutputTokens }
              : input.providerProtocol === 'openai' &&
                  input.body.max_tokens === undefined &&
                  input.body.max_completion_tokens === undefined
                ? { ...input.body, max_tokens: defaultOutputTokens }
                : input.providerProtocol === 'responses' && input.body.max_output_tokens === undefined
                  ? { ...input.body, max_output_tokens: defaultOutputTokens }
                  : input.providerProtocol === 'gemini'
                    ? {
                        ...input.body,
                        generationConfig: {
                          ...(input.body.generationConfig &&
                          typeof input.body.generationConfig === 'object' &&
                          !Array.isArray(input.body.generationConfig)
                            ? input.body.generationConfig
                            : {}),
                          maxOutputTokens:
                            (input.body.generationConfig &&
                            typeof input.body.generationConfig === 'object' &&
                            !Array.isArray(input.body.generationConfig)
                              ? (input.body.generationConfig as Record<string, unknown>).maxOutputTokens
                              : undefined) ?? defaultOutputTokens,
                        },
                      }
                    : input.body;
          if (input.providerId === 'openai-codex') return applyCodexCompilation(bounded, { allowNativePreviousResponseId: input.upstreamTransport === 'websocket' && input.continuationMode === 'remote-history' });
          if (input.providerId === 'anthropic-claude')
            return applyClaudeOAuthTransform(bounded, { cliVersion: CLAUDE_CLI_BASELINE_VERSION });
          if (input.providerId === 'google-gemini') return normalizeGeminiToolsForAiStudio(bounded);
          return bounded;
        },
        maxPayloadBytes: maxBodyBytes,
        compilerVersion: 'builtin-gateway-payload/v1',
      },
      evidenceSigner,
      evidenceVerifierKeyId: verifierKeyId,
      trustedVerifierPublicKeys: registry.trustedVerifierPublicKeys,
      idFactory: { requestId: randomUUID, attemptId: randomUUID, evidenceId: randomUUID },
      resolveAuthenticationHeader: async (input) => {
        const rows = await options.database.query<{ provider_id: string; product_id: string; credential_type: string }>(
          `SELECT account.provider_id,account.product_id,account.credential_type FROM saas_platform_provider_credentials credential JOIN saas_platform_provider_accounts account ON account.id=credential.account_id WHERE credential.id=$1 AND account.id=$2 UNION ALL SELECT account.provider_id,account.product_id,account.credential_type FROM saas_tenant_provider_credentials credential JOIN saas_tenant_provider_accounts account ON account.tenant_id=credential.tenant_id AND account.id=credential.account_id WHERE credential.tenant_id=$3 AND credential.id=$1 AND account.id=$2`,
          [input.credentialId, input.accountId, input.tenantId],
        );
        if (rows.rows.length !== 1) throw new Error('Built-in authentication policy is unavailable');
        const row = rows.rows[0];
        if (row?.credential_type !== 'api-key') throw new Error('A dedicated provider transport is required');
        return row.provider_id === 'kimi' ? 'x-api-key' : 'authorization';
      },
      fetch,
      endpointPolicy: target.endpointPolicy,
      timeoutMs,
      maxConcurrency,
      leaseTtlMs,
      maxBodyBytes,
      entryPoint: 'managed-saas:builtin',
    };
    const mountedScopes = Object.freeze(
      enabled.filter((entry) => entry?.dispatch !== 'generic').flatMap((entry) => entry?.endpointScopes ?? []),
    );
    const deploymentFacts: GatewayCapabilityDeploymentFacts = Object.freeze({
      get dispatch() {
        return Object.freeze({
          generic: transportFactory?.assembled === true,
          routedEndpointScopes: transportFactory?.assembled ? mountedScopes : Object.freeze([]),
        });
      },
      get mediaStorages() {
        return Object.freeze(
          transportFactory?.assembled && imageMedia && extensions.media ? [extensions.media.storage] : [],
        );
      },
      get tlsFingerprintProfiles() {
        return Object.freeze(
          transportFactory?.assembled && tlsFingerprintResolution && extensions.tlsFingerprint && tlsReachable
            ? [extensions.tlsFingerprint.profile]
            : [],
        );
      },
      get verification() {
        return verification;
      },
      get codexWorkflowTransports() {
        return Object.freeze(transportFactory?.assembled && enabled.some((entry) => entry?.providerId === 'openai-codex') ? ['responses-http-full' as const, 'responses-ws-full' as const, 'responses-ws-continuation' as const, ...(nativeCompact ? ['responses-compact' as const] : [])] : []);
      },
      unavailableUsageBoundProviderIds: Object.freeze(
        enabled.filter((entry) => entry?.providerId === 'openai-codex').map((entry) => entry?.providerId ?? ''),
      ),
    });
    async function collectCurrentFacts() {
      if (closed) throw new Error('Built-in gateway runtime is closed');
      await refreshCompactModels();
      await refreshVerification();
      if (tlsFingerprintResolution) {
        try {
          await checkSidecar(tlsFingerprintResolution.sidecarSocketPath);
          tlsReachable = true;
        } catch {
          tlsReachable = false;
        }
      }
      return collectGatewayCapabilityFacts(options.database, deploymentFacts);
    }
    return Object.freeze({
      dependencies,
      extensions,
      deploymentFacts,
      async getCapabilityReadiness() {
        return projectGatewayCapabilityReadiness({ extensions, facts: await collectCurrentFacts() });
      },
      async checkReady() {
        if (closed) throw new Error('Built-in gateway runtime is closed');
        await options.database.query('SELECT 1');
        assertGatewayCapabilityAssembly({
          extensions,
          facts: await collectCurrentFacts(),
        });
      },
      close,
    });
  } catch {
    await close();
    return invalid();
  }
}
