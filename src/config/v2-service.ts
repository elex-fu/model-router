import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { joinApiUrl } from '../providers/url.js';
import { DEFAULT_CONFIG, type Config as LegacyConfig } from './types.js';
import { type ConfigV2, configV2Schema, defaultConfigV2, type SecretSource } from './v2-schema.js';

export interface ConfigIssue {
  path: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
  config?: ConfigV2;
}

export class ConfigConflictError extends Error {
  constructor(
    readonly actualRevision: number,
    readonly expectedRevision: number,
  ) {
    super(`Configuration revision is ${actualRevision}; expected ${expectedRevision}`);
    this.name = 'ConfigConflictError';
  }
}

export class ConfigValidationError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(`Invalid configuration: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'ConfigValidationError';
  }
}

export interface ConfigServiceOptions {
  /** Encrypts a legacy plaintext upstream credential and returns a stable secret ID. */
  storeSecret?: (plaintext: string, label: string) => Promise<string>;
  /** Called for encrypted secret references during validation. */
  hasSecret?: (id: string) => boolean | Promise<boolean>;
  /** Securely archives the original V1 document before replacement. */
  backupLegacy?: (raw: string, label: string) => Promise<void>;
  beforeConfigWrite?: (input: {
    current: ConfigV2;
    candidate: ConfigV2;
    currentChecksum: string;
    candidateChecksum: string;
  }) => void;
  afterConfigRename?: () => void;
  beforeRename?: () => void;
  beforeLegacyMigrationWrite?: (input: { baseChecksum: string; candidate: ConfigV2; candidateChecksum: string }) => void;
  afterLegacyMigrationRename?: (input: { candidate: ConfigV2; candidateChecksum: string }) => void;
}

const ENV_REF = /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}$/;

function unique<T>(items: T[], key: (item: T) => string, listPath: string, errors: ConfigIssue[]): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const value = key(item);
    if (seen.has(value))
      errors.push({ path: `${listPath}[${index}]`, code: 'duplicate', message: `Duplicate ${value}` });
    seen.add(value);
  }
}

function safeId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]+/g, '-')
      .replace(/^-+|-+$/g, '') || randomUUID()
  );
}

function inspectUrl(value: string, field: string, errors: ConfigIssue[]): void {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) is supported');
    if (parsed.username || parsed.password || parsed.hash) throw new Error('Userinfo and fragments are not allowed');
  } catch (error) {
    errors.push({ path: field, code: 'url', message: error instanceof Error ? error.message : 'Invalid URL' });
  }
}

function isPrivateHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === 'localhost.') return true;
  if (host === '[::1]') return true;
  if (/^\[(?:fc|fd)[0-9a-f]{2}:/.test(host)) return true;
  if (isIP(host) !== 4) return false;
  const octets = host.split('.').map(Number);
  return (
    octets[0] === 127 ||
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function inspectUpstreamUrl(
  value: string,
  field: string,
  allowInsecureHttp: boolean | undefined,
  errors: ConfigIssue[],
): void {
  const initialErrors = errors.length;
  inspectUrl(value, field, errors);
  if (errors.length !== initialErrors) return;
  const url = new URL(value);
  if (url.protocol !== 'http:') return;
  if (!allowInsecureHttp) {
    errors.push({
      path: field,
      code: 'insecure_http_requires_opt_in',
      message: 'HTTP upstream URLs require policy.allowInsecureHttp: true',
    });
  } else if (!isPrivateHttpHost(url.hostname)) {
    errors.push({
      path: field,
      code: 'insecure_http_public_host',
      message: 'HTTP is allowed only for localhost or literal loopback/private IP addresses',
    });
  }
}

function inspectEndpoint(value: string, field: string, errors: ConfigIssue[]): void {
  try {
    // Use the same parser as outbound requests. Endpoint validity does not
    // depend on the chosen prefix, which is validated separately.
    joinApiUrl('https://endpoint-validation.invalid/', value);
  } catch {
    errors.push({ path: field, code: 'endpoint', message: 'Invalid relative upstream endpoint' });
  }
}

/** Preserve the URL produced by V1's literal baseUrl + rewritten /v1/... path. */
function migratedLegacyUrl(baseUrl: string, protocol: string): { baseUrl: string; endpoint: string } {
  const suffix =
    protocol === 'anthropic' ? '/v1/messages' : protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions';
  const oldTarget = new URL(`${baseUrl.replace(/\/+$/, '')}${suffix}`);
  let nextBase = baseUrl.replace(/\/+$/, '');
  let endpoint = suffix.slice(1);
  // In V1, a fixed query was followed by the rewritten path literally. Move
  // that resulting query onto a prefix whose relative endpoint recreates the path.
  if (baseUrl.includes('?')) {
    const pathname = oldTarget.pathname;
    const trailingSlashes = pathname.match(/\/+$/)?.[0] ?? '';
    const pathWithoutTrailingSlashes = pathname.slice(0, pathname.length - trailingSlashes.length);
    const lastSlash = pathWithoutTrailingSlashes.lastIndexOf('/');
    endpoint = pathWithoutTrailingSlashes.slice(lastSlash + 1) + trailingSlashes;
    if (!endpoint) throw new Error('V1 URL has no path segment available for a V2 endpoint');
    const prefix = new URL(oldTarget);
    prefix.pathname = pathWithoutTrailingSlashes.slice(0, lastSlash) || '/';
    nextBase = prefix.toString();
  }
  if (joinApiUrl(nextBase, endpoint).toString() !== oldTarget.toString())
    throw new Error('V1 URL cannot be represented exactly by a V2 prefix and relative endpoint');
  return { baseUrl: nextBase, endpoint };
}

/** Safe display form for migration summaries: never expose URL userinfo or query values. */
export function safeMigrationUrl(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...new Set(url.searchParams.keys())]) url.searchParams.set(key, '[redacted]');
    return url.toString();
  } catch {
    return '[invalid URL omitted]';
  }
}

export class ConfigServiceV2 {
  private pending: Promise<unknown> = Promise.resolve();
  private beforeConfigWrite?: ConfigServiceOptions['beforeConfigWrite'];
  private afterConfigRename?: ConfigServiceOptions['afterConfigRename'];
  private beforeRename?: () => void;
  private beforeLegacyMigrationWrite?: ConfigServiceOptions['beforeLegacyMigrationWrite'];
  private afterLegacyMigrationRename?: ConfigServiceOptions['afterLegacyMigrationRename'];

  constructor(
    readonly configPath: string,
    private readonly options: ConfigServiceOptions = {},
  ) {
    this.beforeConfigWrite = options.beforeConfigWrite;
    this.afterConfigRename = options.afterConfigRename;
    this.beforeLegacyMigrationWrite = options.beforeLegacyMigrationWrite;
    this.afterLegacyMigrationRename = options.afterLegacyMigrationRename;
  }

  setCommitHooks(hooks: Pick<ConfigServiceOptions, 'beforeConfigWrite' | 'afterConfigRename' | 'beforeRename'>): void {
    this.beforeConfigWrite = hooks.beforeConfigWrite;
    this.afterConfigRename = hooks.afterConfigRename;
    this.beforeRename = hooks.beforeRename;
  }

  setLegacyMigrationHooks(hooks: Pick<ConfigServiceOptions, 'beforeLegacyMigrationWrite' | 'afterLegacyMigrationRename'>): void {
    this.beforeLegacyMigrationWrite = hooks.beforeLegacyMigrationWrite;
    this.afterLegacyMigrationRename = hooks.afterLegacyMigrationRename;
  }

  async loadRaw(): Promise<ConfigV2> {
    if (!fs.existsSync(this.configPath)) {
      const initial = defaultConfigV2(this.configPath, `router-${randomUUID()}`);
      this.atomicWrite(initial);
      return structuredClone(initial);
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'schemaVersion' in parsed && parsed.schemaVersion === 2) {
      const result = await this.validate(parsed);
      if (!result.valid || !result.config) throw new ConfigValidationError(result.errors);
      return structuredClone(result.config);
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'schemaVersion' in parsed &&
      typeof parsed.schemaVersion === 'number' &&
      parsed.schemaVersion > 2
    ) {
      throw new ConfigValidationError([
        {
          path: 'schemaVersion',
          code: 'unsupported_version',
          message: `Configuration version ${parsed.schemaVersion} is newer than this binary supports`,
        },
      ]);
    }
    return this.migrateLegacy(parsed);
  }

  async validate(next: unknown): Promise<ValidationResult> {
    const parsed = configV2Schema.safeParse(next);
    const errors: ConfigIssue[] = parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || '$',
          code: issue.code,
          message: issue.message,
        }));
    const warnings: ConfigIssue[] = [];
    if (!parsed.success) return { valid: false, errors, warnings };
    const config = parsed.data;

    if (
      config.server.port === config.admin.port &&
      config.admin.enabled &&
      config.server.bindAddress === config.admin.bindAddress
    ) {
      errors.push({
        path: 'admin.port',
        code: 'port_conflict',
        message: 'Proxy and admin listeners cannot share the same address and port',
      });
    }
    inspectUrl(config.server.publicProxyBaseUrl, 'server.publicProxyBaseUrl', errors);
    inspectUrl(config.admin.publicAdminBaseUrl, 'admin.publicAdminBaseUrl', errors);
    unique(config.upstreams, (upstream) => upstream.id, 'upstreams', errors);
    unique(config.upstreams, (upstream) => upstream.name.toLowerCase(), 'upstreams', errors);
    unique(config.routes, (route) => route.id, 'routes', errors);
    unique(config.routes, (route) => route.name.toLowerCase(), 'routes', errors);
    unique(config.proxyKeys, (key) => key.id, 'proxyKeys', errors);
    unique(config.proxyKeys, (key) => key.name.toLowerCase(), 'proxyKeys', errors);
    unique(config.proxyKeys, (key) => key.keyHash, 'proxyKeys', errors);
    const upstreams = new Map(config.upstreams.map((upstream) => [upstream.id, upstream]));
    for (const [index, upstream] of config.upstreams.entries()) {
      inspectUpstreamUrl(upstream.baseUrl, `upstreams[${index}].baseUrl`, upstream.policy.allowInsecureHttp, errors);
      if (upstream.auth.mode === 'oauth' && upstream.auth.tokenUrl)
        inspectUpstreamUrl(
          upstream.auth.tokenUrl,
          `upstreams[${index}].auth.tokenUrl`,
          upstream.policy.allowInsecureHttp,
          errors,
        );
      for (const [name, endpoint] of Object.entries(upstream.endpoints)) {
        if (endpoint !== undefined) inspectEndpoint(endpoint, `upstreams[${index}].endpoints.${name}`, errors);
      }
      unique(upstream.credentials, (credential) => credential.id, `upstreams[${index}].credentials`, errors);
      unique(upstream.models, (model) => model.id, `upstreams[${index}].models`, errors);
      if (
        upstream.enabled &&
        upstream.auth.mode !== 'none' &&
        upstream.auth.mode !== 'pass-through' &&
        upstream.auth.mode !== 'oauth' &&
        !upstream.credentials.some((credential) => credential.enabled)
      ) {
        errors.push({
          path: `upstreams[${index}].credentials`,
          code: 'missing_credential',
          message: 'Enabled upstream requires an enabled credential',
        });
      }
      if (upstream.protocol === 'anthropic' && upstream.endpoints.generate !== 'messages') {
        warnings.push({
          path: `upstreams[${index}].endpoints.generate`,
          code: 'nonstandard_endpoint',
          message: 'Anthropic Messages endpoint is usually messages',
        });
      }
      for (const [credentialIndex, credential] of upstream.credentials.entries()) {
        await this.inspectSecret(
          credential.secret,
          upstream.enabled && credential.enabled,
          `upstreams[${index}].credentials[${credentialIndex}].secret`,
          errors,
          warnings,
        );
      }
      if (upstream.auth.clientSecret)
        await this.inspectSecret(
          upstream.auth.clientSecret,
          upstream.enabled,
          `upstreams[${index}].auth.clientSecret`,
          errors,
          warnings,
        );
    }
    for (const [index, route] of config.routes.entries()) {
      for (const [targetIndex, target] of route.targets.entries()) {
        const upstream = upstreams.get(target.upstreamId);
        const field = `routes[${index}].targets[${targetIndex}]`;
        if (!upstream)
          errors.push({ path: field, code: 'unknown_upstream', message: `Unknown upstream ${target.upstreamId}` });
        else {
          if (!upstream.models.some((model) => model.id === target.model))
            errors.push({ path: field, code: 'unknown_model', message: `Unknown upstream model ${target.model}` });
          if (route.enabled && !upstream.enabled)
            warnings.push({ path: field, code: 'disabled_target', message: 'Target upstream is disabled' });
          if (upstream.protocol === 'responses' && route.clientProtocols.some((client) => client !== 'responses')) {
            errors.push({
              path: field,
              code: 'unsupported_conversion',
              message: 'Responses upstream only accepts Responses clients',
            });
          }
          if (upstream.protocol !== 'responses' && route.clientProtocols.includes('responses')) {
            errors.push({
              path: field,
              code: 'unsupported_conversion',
              message: 'Native Responses route requires a Responses upstream',
            });
          }
        }
      }
    }
    for (const [index, key] of config.proxyKeys.entries()) {
      for (const upstreamId of key.allowedUpstreamIds ?? []) {
        if (!upstreams.has(upstreamId))
          errors.push({
            path: `proxyKeys[${index}].allowedUpstreamIds`,
            code: 'unknown_upstream',
            message: `Unknown upstream ${upstreamId}`,
          });
      }
    }
    return { valid: errors.length === 0, errors, warnings, config };
  }

  async commit(next: unknown, expectedRevision: number): Promise<ConfigV2> {
    const operation = this.pending.then(() => this.withFileLock(() => this.commitUnlocked(next, expectedRevision)));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.configPath}.lock`;
    let descriptor: number | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const opened = fs.openSync(lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(opened, String(process.pid));
          fs.fsyncSync(opened);
        } catch (writeError) {
          fs.closeSync(opened);
          fs.unlinkSync(lockPath);
          throw writeError;
        }
        descriptor = opened;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A crashed process may leave a lock file. Never steal one held by a live PID.
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 30_000) {
            const pid = Number(fs.readFileSync(lockPath, 'utf8'));
            let alive = Number.isInteger(pid) && pid > 0;
            if (alive) {
              try {
                process.kill(pid, 0);
              } catch (probe) {
                alive = (probe as NodeJS.ErrnoException).code !== 'ESRCH';
              }
            }
            if (!alive && fs.existsSync(lockPath) && fs.statSync(lockPath).ino === stat.ino) fs.unlinkSync(lockPath);
          }
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (descriptor === undefined) throw new Error('Configuration file is locked by another process');
    try {
      return await operation();
    } finally {
      fs.closeSync(descriptor);
      fs.unlinkSync(lockPath);
    }
  }

  private async commitUnlocked(next: unknown, expectedRevision: number): Promise<ConfigV2> {
    const current = await this.loadRaw();
    if (current.revision !== expectedRevision) throw new ConfigConflictError(current.revision, expectedRevision);
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new ConfigValidationError([{ path: '$', code: 'type', message: 'Expected config object' }]);
    }
    const candidate = { ...next, schemaVersion: 2, revision: current.revision + 1 };
    const validation = await this.validate(candidate);
    if (!validation.valid || !validation.config) throw new ConfigValidationError(validation.errors);
    if (validation.config.instanceId !== current.instanceId) {
      throw new ConfigValidationError([
        { path: 'instanceId', code: 'immutable', message: 'instanceId cannot be changed' },
      ]);
    }
    const checksum = (value: ConfigV2) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    this.beforeConfigWrite?.({
      current,
      candidate: validation.config,
      currentChecksum: checksum(current),
      candidateChecksum: checksum(validation.config),
    });
    this.atomicWrite(validation.config, this.beforeRename);
    this.afterConfigRename?.();
    return structuredClone(validation.config);
  }

  private async inspectSecret(
    secret: SecretSource,
    required: boolean,
    field: string,
    errors: ConfigIssue[],
    warnings: ConfigIssue[],
  ): Promise<void> {
    let available: boolean | undefined;
    if (secret.type === 'inline') available = secret.value.length > 0;
    else if (secret.type === 'env') available = Boolean(process.env[secret.name]);
    else if (this.options.hasSecret) available = await this.options.hasSecret(secret.id);
    if (available === false) {
      (required ? errors : warnings).push({
        path: field,
        code: 'secret_unavailable',
        message: 'Credential reference cannot be resolved',
      });
    } else if (available === undefined) {
      warnings.push({
        path: field,
        code: 'secret_unverified',
        message: 'Secret reference could not be checked by this service',
      });
    }
  }

  /** Build and validate the V2 candidate without invoking secret or backup persistence. */
  async previewLegacy(parsed: unknown): Promise<ValidationResult> {
    const preview = new ConfigServiceV2(this.configPath, {
      storeSecret: async (_value, label) => `preview_${safeId(label)}`,
      hasSecret: () => true,
    });
    try {
      const candidate = await preview.convertLegacy(parsed);
      return await preview.validate(candidate);
    } catch (error) {
      if (error instanceof ConfigValidationError) return { valid: false, errors: error.issues, warnings: [] };
      if (error instanceof Error && error.message.startsWith('Cannot migrate proxy key '))
        return { valid: false, errors: [{ path: 'proxyKeys', code: 'proxy_key_environment_unset', message: 'Proxy key requires an environment variable that is not set' }], warnings: [] };
      throw error;
    }
  }

  private async migrateLegacy(parsed: unknown): Promise<ConfigV2> {
    // Check the migration precondition before conversion can persist any secrets.
    if (!this.options.backupLegacy) {
      throw new Error('V1 migration requires a secure versioned legacy backup sink');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigValidationError([
        { path: '$', code: 'legacy_format', message: 'Expected a legacy config object' },
      ]);
    }
    const initial = await this.convertLegacy(parsed);
    const result = await this.validate(initial);
    if (!result.valid || !result.config) throw new ConfigValidationError(result.errors);
    const backupLabel = `config-v1-${Date.now()}`;
    // V1 may contain plaintext secrets. Require the secure, versioned backup
    // sink to finish before replacing it with V2; never create a plaintext .bak.
    const raw = fs.readFileSync(this.configPath, 'utf8');
    await this.options.backupLegacy(raw, backupLabel);
    const candidateChecksum = createHash('sha256').update(JSON.stringify(initial)).digest('hex');
    this.beforeLegacyMigrationWrite?.({
      baseChecksum: createHash('sha256').update(raw).digest('hex'),
      candidate: initial,
      candidateChecksum,
    });
    this.atomicWrite(initial, this.beforeRename);
    this.afterLegacyMigrationRename?.({ candidate: initial, candidateChecksum });
    return structuredClone(initial);
  }

  private async convertLegacy(parsed: unknown): Promise<ConfigV2> {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigValidationError([
        { path: '$', code: 'legacy_format', message: 'Expected a legacy config object' },
      ]);
    }
    const legacy = parsed as Partial<LegacyConfig>;
    const initial = defaultConfigV2(this.configPath, `router-${randomUUID()}`);
    const server = { ...DEFAULT_CONFIG.server, ...legacy.server };
    initial.server.port = server.port;
    initial.server.bindAddress = server.bindAddress;
    initial.server.publicProxyBaseUrl = `http://${server.bindAddress}:${server.port}`;
    initial.server.maxAttempts = server.maxRetries ?? 3;
    initial.server.totalRequestTimeoutMs = server.requestTimeoutMs ?? 120_000;
    initial.storage.flushIntervalMs = server.logFlushIntervalMs;
    initial.storage.batchSize = server.logBatchSize;
    initial.storage.requestRetentionDays = server.logRetentionDays ?? 30;
    initial.quota.semanticsVersion = 'legacy_v1';

    // Resolve URL compatibility before storing any plaintext credential.
    const legacyUrls = new Map<number, { baseUrl: string; endpoint: string }>();
    for (const [index, upstream] of (legacy.upstreams ?? []).entries()) {
      if (!upstream?.name) continue;
      try {
        legacyUrls.set(index, migratedLegacyUrl(upstream.baseUrl, upstream.protocol ?? 'openai'));
      } catch {
        throw new ConfigValidationError([
          {
            path: `upstreams[${index}].baseUrl`,
            code: 'legacy_url_unrepresentable',
            message: 'V1 target URL cannot be represented exactly in V2; review this upstream before migration',
          },
        ]);
      }
      const policy = (upstream as typeof upstream & { policy?: { allowInsecureHttp?: boolean } }).policy;
      const urlErrors: ConfigIssue[] = [];
      inspectUpstreamUrl(
        legacyUrls.get(index)!.baseUrl,
        `upstreams[${index}].baseUrl`,
        policy?.allowInsecureHttp,
        urlErrors,
      );
      if (upstream.oauth?.tokenUrl)
        inspectUpstreamUrl(
          upstream.oauth.tokenUrl,
          `upstreams[${index}].auth.tokenUrl`,
          policy?.allowInsecureHttp,
          urlErrors,
        );
      if (urlErrors.length) throw new ConfigValidationError(urlErrors);
    }

    const usedUpstreamIds = new Set<string>();
    const legacyIdByIndex = new Map<number, string>();
    for (const [index, upstream] of (legacy.upstreams ?? []).entries()) {
      if (!upstream || !upstream.name) continue;
      let upstreamId = `up_${safeId(upstream.name)}`;
      while (usedUpstreamIds.has(upstreamId)) upstreamId = `${upstreamId}_${index}`;
      usedUpstreamIds.add(upstreamId);
      legacyIdByIndex.set(index, upstreamId);
      const oldSingleKey = (upstream as typeof upstream & { apiKey?: string }).apiKey;
      const apiKeys = Array.isArray(upstream.apiKeys)
        ? upstream.apiKeys
        : typeof oldSingleKey === 'string'
          ? [oldSingleKey]
          : [];
      const credentials = [];
      for (const [keyIndex, key] of apiKeys.entries()) {
        credentials.push({
          id: `${upstreamId}_cred_${keyIndex + 1}`,
          label: `Migrated credential ${keyIndex + 1}`,
          enabled: true,
          secret: await this.legacySecret(key, `${upstream.name} credential ${keyIndex + 1}`),
        });
      }
      const mappedModels = Object.values(upstream.modelMap ?? {});
      const modelNames = [...new Set([...(upstream.models ?? []), ...mappedModels])];
      initial.upstreams.push({
        id: upstreamId,
        name: upstream.name,
        provider: upstream.provider === 'kimi' || upstream.provider === 'deepseek' ? upstream.provider : 'custom',
        presetId:
          upstream.provider && !['kimi', 'deepseek', 'custom'].includes(upstream.provider)
            ? `legacy-${upstream.provider}`
            : undefined,
        protocol: upstream.protocol ?? 'openai',
        enabled: upstream.enabled ?? true,
        baseUrl: legacyUrls.get(index)!.baseUrl,
        endpoints: { generate: legacyUrls.get(index)!.endpoint },
        auth: {
          mode: upstream.passThroughAuth ? 'pass-through' : upstream.oauth ? 'oauth' : (upstream.authMode ?? 'bearer'),
          ...(upstream.authMode === 'custom-header' && upstream.authHeaderName
            ? { headerName: upstream.authHeaderName }
            : {}),
          ...(upstream.oauth
            ? {
                tokenUrl: upstream.oauth.tokenUrl,
                clientId: upstream.oauth.clientId,
                clientSecret: await this.legacySecret(upstream.oauth.clientSecret, `${upstream.name} OAuth secret`),
                scope: upstream.oauth.scope,
              }
            : {}),
        },
        credentials,
        models: modelNames.map((model) => ({
          id: model,
          enabled: true,
          capabilities: {},
          capabilitiesSource: 'manual' as const,
        })),
        priority: server.failoverQueue
          ? server.failoverQueue.includes(upstream.name)
            ? server.failoverQueue.indexOf(upstream.name)
            : server.failoverQueue.length + (upstream.priority ?? 0)
          : (upstream.priority ?? 0),
        sortIndex: upstream.sortIndex ?? index,
        policy: {
          thinking: upstream.copilotOptimized ? 'strip' : 'preserve',
          healthMode: 'passive',
          ...((upstream as typeof upstream & { policy?: { allowInsecureHttp?: boolean } }).policy?.allowInsecureHttp ===
          true
            ? { allowInsecureHttp: true }
            : {}),
        },
      });
    }
    const routes = new Map<string, ConfigV2['routes'][number]>();
    for (const [index, upstream] of (legacy.upstreams ?? []).entries()) {
      const upstreamId = legacyIdByIndex.get(index);
      if (!upstreamId || !upstream) continue;
      const entries = Object.entries(upstream.modelMap ?? {});
      const mappings = entries.length > 0 ? entries : (upstream.models ?? []).map((model) => [model, model] as const);
      for (const [pattern, targetModel] of mappings) {
        const routeKey = `${pattern}|${upstream.protocol === 'responses' ? 'responses' : 'chat'}`;
        let route = routes.get(routeKey);
        if (!route) {
          route = {
            id: `route_${safeId(pattern)}_${routes.size + 1}`,
            name: `${pattern} (${upstream.protocol === 'responses' ? 'Responses' : 'Chat'})`,
            enabled: true,
            clientProtocols: upstream.protocol === 'responses' ? ['responses'] : ['openai', 'anthropic'],
            match: { kind: pattern.includes('*') ? 'glob' : 'exact', value: pattern },
            order: routes.size,
            publishedModels: pattern.includes('*') ? [] : [pattern],
            targets: [],
          };
          routes.set(routeKey, route);
        }
        route.targets.push({ upstreamId, model: targetModel });
      }
    }
    const upstreamOrder = new Map(
      initial.upstreams.map((upstream) => [upstream.id, [upstream.priority, upstream.sortIndex]]),
    );
    initial.routes = [...routes.values()].map((route) => ({
      ...route,
      targets: route.targets.sort((a, b) => {
        const aOrder = upstreamOrder.get(a.upstreamId) ?? [0, 0];
        const bOrder = upstreamOrder.get(b.upstreamId) ?? [0, 0];
        return aOrder[0]! - bOrder[0]! || aOrder[1]! - bOrder[1]!;
      }),
    }));
    for (const [index, key] of (legacy.proxyKeys ?? []).entries()) {
      const rawKey = key.key.replace(/\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name: string) => {
        const value = process.env[name];
        if (!value) throw new Error(`Cannot migrate proxy key ${key.name}: ${name} is not set`);
        return value;
      });
      initial.proxyKeys.push({
        id: `key_${safeId(key.name)}_${index + 1}`,
        name: key.name,
        description: key.description,
        enabled: key.enabled,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt,
        keyHash: createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.slice(0, 8),
        allowedUpstreamIds: key.allowedUpstreams
          ?.map((name) => initial.upstreams.find((upstream) => upstream.name === name)?.id)
          .filter((value): value is string => Boolean(value)),
        allowedModels: key.allowedModels,
        rpm: key.rpm,
        dailyTokens: key.dailyTokens,
      });
    }
    return initial;
  }

  private async legacySecret(value: string, label: string): Promise<SecretSource> {
    const env = ENV_REF.exec(value);
    if (env) return { type: 'env', name: env[1]! };
    if (!this.options.storeSecret) throw new Error(`Migration requires an encrypted secret store for ${label}`);
    return { type: 'secret', id: await this.options.storeSecret(value, label) };
  }

  private atomicWrite(config: ConfigV2, beforeRename?: () => void): void {
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `.${path.basename(this.configPath)}.${process.pid}.${randomUUID()}.tmp`);
    let created = false;
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      created = true;
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      beforeRename?.();
      fs.renameSync(temporary, this.configPath);
      fs.chmodSync(this.configPath, 0o600);
      const directory = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
