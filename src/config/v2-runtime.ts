import { createHash, timingSafeEqual } from 'node:crypto';
import { ConfigStore } from './store.js';
import type { Config, ProxyKey, UpstreamConfig } from './types.js';
import type { ConfigV2, SecretSource } from './v2-schema.js';

export type SecretResolver = (id: string) => string | undefined | Promise<string | undefined>;

async function resolveSecret(source: SecretSource, resolver?: SecretResolver): Promise<string> {
  const value =
    source.type === 'inline'
      ? source.value
      : source.type === 'env'
        ? process.env[source.name]
        : await resolver?.(source.id);
  if (!value) {
    const reference = source.type === 'inline' ? 'inline' : source.type === 'env' ? source.name : source.id;
    throw new Error(`Credential ${reference} is unavailable`);
  }
  return value;
}

export async function compileRuntimeConfig(raw: ConfigV2, resolver?: SecretResolver): Promise<Config> {
  const routesByUpstream = new Map<string, Record<string, string>>();
  for (const route of raw.routes.filter((item) => item.enabled).sort((a, b) => a.order - b.order)) {
    for (const target of route.targets) {
      const map = routesByUpstream.get(target.upstreamId) ?? {};
      if (!Object.hasOwn(map, route.match.value)) map[route.match.value] = target.model;
      routesByUpstream.set(target.upstreamId, map);
    }
  }

  const upstreams: UpstreamConfig[] = [];
  for (const upstream of raw.upstreams) {
    const credentials = upstream.enabled ? upstream.credentials.filter((item) => item.enabled) : [];
    const apiKeys = await Promise.all(credentials.map((item) => resolveSecret(item.secret, resolver)));
    const oauth =
      upstream.auth.mode === 'oauth' && upstream.auth.tokenUrl && upstream.auth.clientId && upstream.auth.clientSecret
        ? {
            tokenUrl: upstream.auth.tokenUrl,
            clientId: upstream.auth.clientId,
            clientSecret: await resolveSecret(upstream.auth.clientSecret, resolver),
            scope: upstream.auth.scope,
          }
        : undefined;
    upstreams.push({
      id: upstream.id,
      name: upstream.id,
      provider: upstream.provider,
      presetId: upstream.presetId,
      protocol: upstream.protocol,
      baseUrl: upstream.baseUrl,
      endpoint: upstream.endpoints.generate,
      compactEndpoint: upstream.endpoints.compact,
      apiKeys,
      credentialIds: credentials.map((item) => item.id),
      accountGroupId: upstream.accountGroupId,
      models: upstream.models.filter((model) => model.enabled).map((model) => model.id),
      modelCapabilities: Object.fromEntries(upstream.models.map((model) => [model.id, model.capabilities])),
      healthMode: upstream.policy.healthMode ?? 'passive',
      inputIncludesCache: upstream.policy.inputIncludesCache,
      thinkingPolicy: upstream.policy.thinking,
      requestStreamUsage: upstream.policy.requestStreamUsage,
      autoCacheControl: upstream.policy.autoCacheControl,
      anthropicBetas: upstream.policy.anthropicBetas,
      anthropicVersion: upstream.policy.anthropicVersion,
      enabled: upstream.enabled,
      modelMap: routesByUpstream.get(upstream.id) ?? {},
      authMode: upstream.auth.mode,
      authHeaderName: upstream.auth.mode === 'custom-header' ? upstream.auth.headerName : undefined,
      passThroughAuth: upstream.auth.mode === 'pass-through',
      oauth,
      priority: upstream.priority,
      sortIndex: upstream.sortIndex,
    });
  }

  const proxyKeys: ProxyKey[] = raw.proxyKeys.map((key) => ({
    id: key.id,
    name: key.name,
    key: '',
    keyHash: key.keyHash,
    keyPrefix: key.keyPrefix,
    enabled: key.enabled,
    createdAt: key.createdAt,
    description: key.description,
    expiresAt: key.expiresAt,
    allowedUpstreams: key.allowedUpstreamIds,
    allowedUpstreamIds: key.allowedUpstreamIds,
    allowedModels: key.allowedModels,
    rpm: key.rpm,
    dailyTokens: key.dailyTokens,
    maxConcurrentRequests: key.maxConcurrentRequests ?? raw.quota.defaultMaxConcurrentRequests,
  }));

  return {
    revision: raw.revision,
    server: {
      port: raw.server.port,
      bindAddress: raw.server.bindAddress,
      logFlushIntervalMs: raw.storage.flushIntervalMs,
      logBatchSize: raw.storage.batchSize,
      logRetentionDays: raw.storage.requestRetentionDays,
      maxRetries: raw.server.maxAttempts,
      requestTimeoutMs: raw.server.totalRequestTimeoutMs,
      connectTimeoutMs: raw.server.connectTimeoutMs,
      firstByteTimeoutMs: raw.server.firstByteTimeoutMs,
      streamIdleTimeoutMs: raw.server.streamIdleTimeoutMs,
      totalRequestTimeoutMs: raw.server.totalRequestTimeoutMs,
    } as Config['server'] &
      Pick<
        ConfigV2['server'],
        'connectTimeoutMs' | 'firstByteTimeoutMs' | 'streamIdleTimeoutMs' | 'totalRequestTimeoutMs'
      >,
    proxyKeys,
    upstreams,
    routes: structuredClone(raw.routes),
  };
}

/** Adapter for the legacy request handler. Mutations must go through ConfigServiceV2. */
export class RuntimeConfigStore extends ConfigStore {
  private snapshot: Config;

  constructor(configPath: string, snapshot: Config) {
    super(configPath);
    this.snapshot = snapshot;
  }

  override load(): Config {
    return this.snapshot;
  }

  override save(_config: Config): void {
    throw new Error('V2 runtime snapshots are read-only; use ConfigServiceV2.commit');
  }

  override getProxyKeyByKey(key: string): ProxyKey | undefined {
    if (!key) return undefined;
    const digest = createHash('sha256').update(key).digest();
    return this.snapshot.proxyKeys.find((candidate) => {
      if (!candidate.keyHash) return false;
      const expected = Buffer.from(candidate.keyHash, 'hex');
      return expected.length === digest.length && timingSafeEqual(expected, digest);
    });
  }

  replace(snapshot: Config): void {
    this.snapshot = snapshot;
  }
}
