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
  authMode?: 'bearer' | 'x-api-key';
  /** Enable Copilot-specific optimizations (thinking strip, tool merge, warmup downgrade). */
  copilotOptimized?: boolean;
  /** Pass the client's Authorization header through to the upstream instead of using configured apiKeys. */
  passThroughAuth?: boolean;
  /** OAuth client-credentials config for dynamic upstream token resolution. */
  oauth?: OAuthConfig;
}

export interface ServerConfig {
  port: number;
  bindAddress: string;
  logFlushIntervalMs: number;
  logBatchSize: number;
  logRetentionDays?: number;
  maxRetries?: number;
  requestTimeoutMs?: number;
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
