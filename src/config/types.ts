export interface ProxyKey {
  name: string;
  key: string;
  enabled: boolean;
  createdAt: string;
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
  logFlushIntervalMs: number;
  logBatchSize: number;
}

export interface Config {
  server: ServerConfig;
  proxyKeys: ProxyKey[];
  upstreams: UpstreamConfig[];
}

export const DEFAULT_CONFIG: Config = {
  server: {
    port: 15005,
    logFlushIntervalMs: 5000,
    logBatchSize: 100,
  },
  proxyKeys: [],
  upstreams: [],
};
