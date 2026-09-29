export interface ProxyKey {
  /** Stable V2 identity; legacy configurations may omit it. */
  id?: string;
  name: string;
  key: string;
  keyHash?: string;
  keyPrefix?: string;
  enabled: boolean;
  createdAt: string;
  description?: string;
  expiresAt?: string;
  allowedUpstreams?: string[];
  allowedUpstreamIds?: string[];
  allowedModels?: string[];
  rpm?: number;
  dailyTokens?: number;
  maxConcurrentRequests?: number;
}

export interface OAuthConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** 'client_credentials' | 'device_code'. Default 'client_credentials'. */
  grantType?: 'client_credentials' | 'device_code';
  /** Device flow verification URL override. */
  deviceAuthUrl?: string;
}

export type Protocol = 'anthropic' | 'openai' | 'gemini' | 'responses';

export interface UpstreamConfig {
  id?: string;
  name: string;
  provider: string;
  presetId?: string;
  protocol: Protocol;
  baseUrl: string;
  /** Explicit relative path; bypasses provider preset path inference. */
  endpoint?: string;
  compactEndpoint?: string;
  apiKeys: string[];
  credentialIds?: string[];
  accountGroupId?: string;
  modelCapabilities?: Record<string, import('./v2-schema.js').ModelCapabilities>;
  healthMode?: 'passive' | 'active' | 'off';
  models: string[];
  enabled: boolean;
  modelMap?: Record<string, string>;
  /** Auth mode for upstream requests. Default is 'bearer'. */
  authMode?: 'bearer' | 'x-api-key' | 'custom-header' | 'google' | 'none' | 'pass-through' | 'oauth';
  /** Validated upstream auth header name when authMode is custom-header. */
  authHeaderName?: string;
  /** Enable Copilot-specific optimizations (thinking strip, tool merge, warmup downgrade). */
  copilotOptimized?: boolean;
  /** Anthropic-compatible input_tokens already includes cache tokens. */
  inputIncludesCache?: boolean;
  /** V2 request preparation policy; omitted fields preserve legacy behavior. */
  thinkingPolicy?: 'preserve' | 'strip' | 'force';
  requestStreamUsage?: boolean;
  autoCacheControl?: boolean;
  anthropicBetas?: string[];
  anthropicVersion?: string;
  /** Pass the client's Authorization header through to the upstream instead of using configured apiKeys. */
  passThroughAuth?: boolean;
  /** OAuth client-credentials config for dynamic upstream token resolution. */
  oauth?: OAuthConfig;
  /** Routing priority: lower value = tried first. Default 0. */
  priority?: number;
  /** Stable sort index within same priority. */
  sortIndex?: number;
}

export interface ServerConfig {
  port: number;
  bindAddress: string;
  logFlushIntervalMs: number;
  logBatchSize: number;
  logRetentionDays?: number;
  maxRetries?: number;
  requestTimeoutMs?: number;
  /** Ordered list of upstream names for strict failover. Overrides priority when set. */
  failoverQueue?: string[];
}

export interface Config {
  server: ServerConfig;
  proxyKeys: ProxyKey[];
  upstreams: UpstreamConfig[];
  /** V2 route contract used by the runtime; absent for legacy configurations. */
  routes?: import('./v2-schema.js').RouteDefinition[];
  revision?: number;
}

export const DEFAULT_CONFIG: Config = {
  server: {
    port: 15005,
    bindAddress: '127.0.0.1',
    logFlushIntervalMs: 5000,
    logBatchSize: 100,
    logRetentionDays: 30,
    maxRetries: 3,
    requestTimeoutMs: 120_000,
  },
  proxyKeys: [],
  upstreams: [],
};
