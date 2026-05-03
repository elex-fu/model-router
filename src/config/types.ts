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

export interface UpstreamConfig {
  name: string;
  provider: string;
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  apiKey: string;
  models: string[];
  enabled: boolean;
  modelMap?: Record<string, string>;
}

export interface ServerConfig {
  port: number;
  bindAddress: string;
  logFlushIntervalMs: number;
  logBatchSize: number;
  logRetentionDays?: number;
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
  },
  proxyKeys: [],
  upstreams: [],
};
