import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ConfigV2, ProxyKeyDefinition, RouteDefinition, UpstreamDefinition } from '../config/v2-schema.js';
import { ControlService } from '../control/service.js';
import { ControlStore } from '../control/store.js';
import { PROVIDER_PROFILES, providerProfile } from '../providers/profiles.js';
import { joinApiUrl } from '../providers/url.js';
import { DEFAULT_CONFIG_PATH } from '../utils/paths.js';
import { applyUpdateOptions, type KeyCliOptions, parseCreateOptions } from './key-options.js';

type Options = KeyCliOptions & {
  config?: string;
  showSecrets?: boolean;
  map?: string;
  model?: string;
  authMode?: string;
  allowInsecureHttp?: boolean;
};
type Action =
  | 'key:create'
  | 'key:update'
  | 'key:rotate'
  | 'key:enable'
  | 'key:disable'
  | 'key:list'
  | 'key:delete'
  | 'upstream:add'
  | 'upstream:list'
  | 'upstream:delete'
  | 'upstream:map:set'
  | 'upstream:map:list'
  | 'upstream:map:delete'
  | 'test';
const actor = 'cli';
const readOnly = new Set<Action>(['key:list', 'upstream:list', 'upstream:map:list', 'test']);

async function serverIsRunning(config: ConfigV2): Promise<boolean> {
  const host = (address: string) => (address === '0.0.0.0' || address === '::' ? '127.0.0.1' : address);
  const endpoints = [
    `http://${host(config.server.bindAddress)}:${config.server.port}/healthz`,
    ...(config.admin.enabled
      ? [`http://${host(config.admin.bindAddress)}:${config.admin.port}/admin/api/v1/bootstrap`]
      : []),
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(400) });
      if (response.ok) return true;
    } catch {
      /* listener absent */
    }
  }
  return false;
}

function cliLock(configPath: string): () => void {
  const lockPath = `${configPath}.cli.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch {
    throw new Error('Another V2 CLI write is in progress; retry after it finishes');
  }
  return () => {
    closeSync(descriptor);
    unlinkSync(lockPath);
  };
}

export function v2Config(options: { config?: string }): ConfigV2 | undefined {
  const file = options.config ?? DEFAULT_CONFIG_PATH;
  if (!existsSync(file)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return raw && typeof raw === 'object' && (raw as { schemaVersion?: unknown }).schemaVersion === 2
    ? (raw as ConfigV2)
    : undefined;
}

const matchName = (name: string, actual: { id: string; name: string }) => actual.id === name || actual.name === name;
const findKey = (config: ConfigV2, name: string) => config.proxyKeys.find((key) => matchName(name, key));
const findUpstream = (config: ConfigV2, name: string) => config.upstreams.find((upstream) => matchName(name, upstream));
const list = (value?: string) =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
const nonnegative = (value: number | undefined, field: string) => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    throw new Error(`V2 requires --${field} to be a nonnegative integer`);
  return value;
};
const idsFor = (config: ConfigV2, names?: string[]) =>
  names?.map((name) => {
    const upstream = findUpstream(config, name);
    if (!upstream) throw new Error(`Upstream "${name}" not found`);
    return upstream.id;
  });

function parseMap(value?: string): Array<[string, string]> {
  return list(value).map((entry) => {
    const separator = entry.indexOf('=');
    const pattern = entry.slice(0, separator).trim();
    const target = entry.slice(separator + 1).trim();
    if (separator < 1 || !target) throw new Error(`Invalid --map entry "${entry}", expected pattern=target`);
    return [pattern, target];
  });
}

function routeFor(config: ConfigV2, upstream: UpstreamDefinition, pattern: string): RouteDefinition {
  const protocols: RouteDefinition['clientProtocols'] =
    upstream.protocol === 'responses' ? ['responses'] : ['openai', 'anthropic'];
  let route = config.routes.find(
    (item) => item.match.value === pattern && item.clientProtocols.join(',') === protocols.join(','),
  );
  if (!route) {
    route = {
      id: `route_${randomUUID()}`,
      name: `${pattern} (${protocols.join(',')})`,
      enabled: true,
      clientProtocols: protocols,
      match: { kind: pattern.includes('*') ? 'glob' : 'exact', value: pattern },
      order: Math.max(-1, ...config.routes.map((item) => item.order)) + 1,
      publishedModels: pattern.includes('*') ? [] : [pattern],
      targets: [],
    };
    config.routes.push(route);
  }
  return route;
}

function setRouteTarget(config: ConfigV2, upstream: UpstreamDefinition, pattern: string, target: string): void {
  if (!upstream.models.some((model) => model.id === target)) {
    upstream.models.push({ id: target, enabled: true, capabilities: {}, capabilitiesSource: 'manual' });
  }
  const route = routeFor(config, upstream, pattern);
  const old = route.targets.find((item) => item.upstreamId === upstream.id);
  if (old) old.model = target;
  else route.targets.push({ upstreamId: upstream.id, model: target });
}

async function execute(control: ControlService, action: Action, args: string[], options: Options): Promise<void> {
  const config = await control.raw();
  const name = args[0] ?? '';
  if (action === 'key:create') {
    const patch = parseCreateOptions(options);
    const result = await control.createKey(
      {
        name,
        description: patch.description,
        expiresAt: patch.expiresAt,
        allowedUpstreamIds: idsFor(config, patch.allowedUpstreams),
        allowedModels: patch.allowedModels,
        rpm: nonnegative(patch.rpm, 'rpm'),
        dailyTokens: nonnegative(patch.dailyTokens, 'daily-tokens'),
      },
      config.revision,
      actor,
    );
    console.log(`Created proxy key: ${name}`);
    console.log(`Key: ${result.secret}`);
    return;
  }
  if (action === 'key:list') {
    if (options.showSecrets) throw new Error('V2 proxy keys cannot be recovered; rotate a key to obtain a new value');
    if (!config.proxyKeys.length) {
      console.log('No proxy keys found.');
      return;
    }
    console.table(
      config.proxyKeys.map((key) => ({
        name: key.name,
        id: key.id,
        key: `${key.keyPrefix}…`,
        enabled: key.enabled,
        expires: key.expiresAt ?? '-',
        upstreams: key.allowedUpstreamIds?.join(',') ?? '*',
        models: key.allowedModels?.join(',') ?? '*',
        rpm: key.rpm ?? '-',
        daily_tokens: key.dailyTokens ?? '-',
      })),
    );
    return;
  }
  if (action.startsWith('key:')) {
    const key = findKey(config, name);
    if (!key) throw new Error(`Proxy key "${name}" not found`);
    if (action === 'key:rotate') {
      const result = await control.rotateKey(key.id, config.revision, actor);
      console.log(`Rotated proxy key: ${key.name}`);
      console.log(`New key: ${result.secret}`);
    } else if (action === 'key:delete') {
      await control.entity('proxyKeys', 'delete', key.id, undefined, config.revision, actor);
      console.log(`Deleted proxy key: ${key.name}`);
    } else if (action === 'key:enable' || action === 'key:disable') {
      const enabled = action === 'key:enable';
      await control.entity('proxyKeys', 'update', key.id, { enabled }, config.revision, actor);
      console.log(`${enabled ? 'Enabled' : 'Disabled'} proxy key: ${key.name}`);
    } else if (action === 'key:update') {
      const existingNames = key.allowedUpstreamIds?.map(
        (id) => config.upstreams.find((item) => item.id === id)?.name ?? id,
      );
      const patch = applyUpdateOptions(options, {
        ...key,
        key: '',
        allowedUpstreams: existingNames,
      } as import('../config/types.js').ProxyKey);
      const update: Partial<ProxyKeyDefinition> = {
        description: patch.description,
        allowedModels: patch.allowedModels,
        allowedUpstreamIds: idsFor(config, patch.allowedUpstreams),
        rpm: nonnegative(patch.rpm, 'rpm'),
        dailyTokens: nonnegative(patch.dailyTokens, 'daily-tokens'),
        expiresAt: patch.expiresAt,
      };
      await control.mutate(config.revision, actor, (next) => {
        const item = next.proxyKeys.find((candidate) => candidate.id === key.id)!;
        for (const [field, value] of Object.entries(update)) {
          if (value !== undefined) (item as unknown as Record<string, unknown>)[field] = value;
          else if (
            (field === 'expiresAt' && options.expires === 'never') ||
            (field === 'allowedUpstreamIds' &&
              (options.upstreams !== undefined || options.removeUpstream !== undefined)) ||
            (field === 'allowedModels' && (options.models !== undefined || options.removeModel !== undefined))
          )
            delete (item as unknown as Record<string, unknown>)[field];
        }
      });
      console.log(`Updated proxy key: ${key.name}`);
    }
    return;
  }
  if (action === 'upstream:add') {
    const [upstreamName, givenProvider, protocol, baseUrl, rawKeys] = args;
    if (!['openai', 'anthropic', 'responses', 'gemini'].includes(protocol))
      throw new Error('Invalid upstream protocol');
    const keys = rawKeys === '-' ? [] : list(rawKeys);
    const profile = providerProfile(givenProvider, protocol as UpstreamDefinition['protocol']);
    if (PROVIDER_PROFILES[givenProvider] && profile.protocol !== protocol)
      throw new Error(`Preset ${givenProvider} requires protocol ${profile.protocol}`);
    const mode = (options.authMode ?? profile.authMode) as UpstreamDefinition['auth']['mode'];
    if (!['bearer', 'x-api-key', 'google', 'none'].includes(mode))
      throw new Error('Use --auth-mode bearer, x-api-key, google, or none');
    if (mode !== 'none' && !keys.length) throw new Error('At least one upstream API key is required');
    if (mode === 'none' && keys.length) throw new Error('Use - for apiKeys with --auth-mode none');
    const provider: UpstreamDefinition['provider'] = givenProvider.startsWith('kimi')
      ? 'kimi'
      : givenProvider.startsWith('deepseek')
        ? 'deepseek'
        : 'custom';
    const id = `up_${randomUUID()}`;
    const secretIds = keys.map(() => `sec_${randomUUID()}`);
    const upstream: UpstreamDefinition = {
      id,
      name: upstreamName,
      provider,
      presetId: givenProvider.includes('-') ? givenProvider : undefined,
      protocol: protocol as UpstreamDefinition['protocol'],
      enabled: true,
      baseUrl,
      endpoints: { generate: profile.endpoint },
      auth: { mode },
      credentials: secretIds.map((secretId, index) => ({
        id: `cred_${randomUUID()}`,
        label: `Key ${index + 1}`,
        enabled: true,
        secret: { type: 'secret', id: secretId },
      })),
      models: list(options.models).map((model) => ({
        id: model,
        enabled: true,
        capabilities: {},
        capabilitiesSource: 'manual',
      })),
      priority: 0,
      sortIndex: config.upstreams.length,
      policy: options.allowInsecureHttp ? { allowInsecureHttp: true } : {},
    };
    const maps = parseMap(options.map);
    try {
      keys.forEach((value, index) => {
        control.store.secrets.put(secretIds[index]!, value);
      });
      await control.mutate(config.revision, actor, (next) => {
        next.upstreams.push(upstream);
        for (const [pattern, target] of maps) setRouteTarget(next, upstream, pattern, target);
      });
    } catch (error) {
      for (const secretId of secretIds) control.store.secrets.delete(secretId);
      throw error;
    }
    console.log(`Created upstream: ${upstreamName}`);
    return;
  }
  if (action === 'upstream:list') {
    if (options.showSecrets) throw new Error('V2 upstream secrets cannot be displayed; replace a credential instead');
    if (!config.upstreams.length) {
      console.log('No upstreams found.');
      return;
    }
    console.table(
      config.upstreams.map((upstream) => ({
        id: upstream.id,
        name: upstream.name,
        provider: upstream.presetId ?? upstream.provider,
        protocol: upstream.protocol,
        baseUrl: upstream.baseUrl,
        keys: `${upstream.credentials.length} stored`,
        models: upstream.models.map((model) => model.id).join(', '),
        routes: config.routes.filter((route) => route.targets.some((target) => target.upstreamId === upstream.id))
          .length,
        enabled: upstream.enabled,
      })),
    );
    return;
  }
  const upstream = findUpstream(config, name);
  if (!upstream) throw new Error(`Upstream "${name}" not found`);
  if (action === 'upstream:delete') {
    await control.entity('upstreams', 'delete', upstream.id, undefined, config.revision, actor);
    console.log(`Deleted upstream: ${upstream.name}`);
  } else if (action === 'upstream:map:list') {
    const entries = config.routes.flatMap((route) =>
      route.targets
        .filter((target) => target.upstreamId === upstream.id)
        .map((target) => ({ pattern: route.match.value, target: target.model, route: route.id })),
    );
    if (!entries.length) console.log(`No modelMap entries for ${upstream.name}.`);
    else console.table(entries);
  } else if (action === 'upstream:map:set') {
    const [pattern, target] = args.slice(1);
    await control.mutate(config.revision, actor, (next) =>
      setRouteTarget(next, findUpstream(next, name)!, pattern, target),
    );
    console.log(`Set ${upstream.name}: ${pattern} → ${target}`);
  } else if (action === 'upstream:map:delete') {
    const pattern = args[1];
    await control.mutate(config.revision, actor, (next) => {
      for (const route of next.routes) {
        if (route.match.value === pattern)
          route.targets = route.targets.filter((target) => target.upstreamId !== upstream.id);
      }
      next.routes = next.routes.filter((route) => route.targets.length > 0);
    });
    console.log(`Deleted ${upstream.name}: ${pattern}`);
  } else if (action === 'test') {
    const model = options.model ?? upstream.models.find((item) => item.enabled)?.id;
    if (!model) throw new Error(`Upstream "${upstream.name}" has no enabled model; pass --model`);
    const endpoint = upstream.endpoints.generate;
    const url = joinApiUrl(upstream.baseUrl, endpoint);
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    const credential = upstream.credentials.find((item) => item.enabled);
    const mode = upstream.auth.mode;
    if (upstream.protocol === 'anthropic')
      headers['anthropic-version'] = upstream.policy.anthropicVersion ?? '2023-06-01';
    if (upstream.protocol === 'gemini') throw new Error('V2 CLI probe does not support Gemini');
    if (mode !== 'none') {
      if (!credential) throw new Error('No enabled upstream credential');
      const secret =
        credential.secret.type === 'inline'
          ? credential.secret.value
          : credential.secret.type === 'env'
            ? process.env[credential.secret.name]
            : control.store.secrets.get(credential.secret.id);
      if (!secret) throw new Error('Upstream credential unavailable');
      if (mode === 'x-api-key') headers['x-api-key'] = secret;
      else if (mode === 'bearer') headers.authorization = `Bearer ${secret}`;
      else if (mode === 'google') headers['x-goog-api-key'] = secret;
      else throw new Error(`CLI probe does not support auth mode ${mode}`);
    }
    const start = Date.now();
    const body =
      upstream.protocol === 'responses'
        ? { model, max_output_tokens: 1, input: 'ping' }
        : { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
    const response = await fetch(url, {
      method: 'POST',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(body),
    });
    console.log(
      `${upstream.name} ${url.origin}${url.pathname} model=${model}: ${response.status} in ${Date.now() - start}ms`,
    );
    if (!response.ok) throw new Error(`Upstream probe failed: HTTP ${response.status}`);
    console.log('OK');
  }
}

/** Returns false for V1. V2 errors set the process exit code without touching V1 state. */
export async function tryV2(action: Action, options: Options, ...args: string[]): Promise<boolean> {
  const raw = v2Config(options);
  if (!raw) return false;
  let release: (() => void) | undefined;
  let store: ControlStore | undefined;
  try {
    if (!readOnly.has(action)) {
      release = cliLock(options.config ?? DEFAULT_CONFIG_PATH);
      if (await serverIsRunning(v2Config(options) ?? raw))
        throw new Error('V2 server is running; use the admin console/API so changes apply immediately');
    }
    const file = resolve(options.config ?? DEFAULT_CONFIG_PATH);
    const latest = v2Config(options) ?? raw;
    store = new ControlStore(resolve(dirname(file), latest.storage.dataDir));
    const control = new ControlService(options.config ?? DEFAULT_CONFIG_PATH, store);
    await execute(control, action, args, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    store?.close();
    release?.();
  }
  return true;
}
