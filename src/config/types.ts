export interface ProxyKey {
  name: string;
  key: string;
  enabled: boolean;
  createdAt: string;
  description?: string;
  expiresAt?: string;
  allowedUpstreams?: string[];
  allowedModels?: string[];
  rpm?: number;
  dailyTokens?: number;
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
  name: string;
  provider: string;
  protocol: Protocol;
  baseUrl: string;
  apiKeys: string[];
  models: string[];
  enabled: boolean;
  modelMap?: Record<string, string>;
  /** Auth mode for upstream requests. Default is 'bearer'. */
  authMode?: 'bearer' | 'x-api-key' | 'google';
  /** Enable Copilot-specific optimizations (thinking strip, tool merge, warmup downgrade). */
  copilotOptimized?: boolean;
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
