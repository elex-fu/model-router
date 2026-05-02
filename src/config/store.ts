import fs from 'node:fs';
import path from 'node:path';
import { type Config, type ProxyKey, type UpstreamConfig, DEFAULT_CONFIG } from './types.js';

export class ConfigStore {
  private configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  load(): Config {
    if (!fs.existsSync(this.configPath)) {
      this.save(DEFAULT_CONFIG);
      return structuredClone(DEFAULT_CONFIG);
    }
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    return this.mergeDefaults(parsed);
  }

  save(config: Config): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  private mergeDefaults(partial: Partial<Config>): Config {
    return {
      server: {
        port: partial.server?.port ?? DEFAULT_CONFIG.server.port,
        logFlushIntervalMs: partial.server?.logFlushIntervalMs ?? DEFAULT_CONFIG.server.logFlushIntervalMs,
        logBatchSize: partial.server?.logBatchSize ?? DEFAULT_CONFIG.server.logBatchSize,
      },
      proxyKeys: Array.isArray(partial.proxyKeys) ? partial.proxyKeys : [],
      upstreams: Array.isArray(partial.upstreams) ? partial.upstreams : [],
    };
  }

  getProxyKeyByKey(key: string): ProxyKey | undefined {
    const config = this.load();
    return config.proxyKeys.find((k) => k.key === key && k.enabled);
  }

  addProxyKey(key: ProxyKey): void {
    const config = this.load();
    if (config.proxyKeys.some((k) => k.name === key.name)) {
      throw new Error(`Proxy key with name "${key.name}" already exists.`);
    }
    config.proxyKeys.push(key);
    this.save(config);
  }

  deleteProxyKey(name: string): void {
    const config = this.load();
    config.proxyKeys = config.proxyKeys.filter((k) => k.name !== name);
    this.save(config);
  }

  listProxyKeys(): ProxyKey[] {
    return this.load().proxyKeys;
  }

  addUpstream(upstream: UpstreamConfig): void {
    const config = this.load();
    if (config.upstreams.some((u) => u.name === upstream.name)) {
      throw new Error(`Upstream with name "${upstream.name}" already exists.`);
    }
    config.upstreams.push(upstream);
    this.save(config);
  }

  deleteUpstream(name: string): void {
    const config = this.load();
    config.upstreams = config.upstreams.filter((u) => u.name !== name);
    this.save(config);
  }

  listUpstreams(): UpstreamConfig[] {
    return this.load().upstreams;
  }

  setUpstreamEnabled(name: string, enabled: boolean): boolean {
    const config = this.load();
    const upstream = config.upstreams.find((u) => u.name === name);
    if (!upstream) return false;
    if (upstream.enabled === enabled) return true;
    upstream.enabled = enabled;
    this.save(config);
    return true;
  }

  getUpstream(name: string): UpstreamConfig | undefined {
    const config = this.load();
    return config.upstreams.find((u) => u.name === name);
  }

  updateUpstream(name: string, patch: Partial<UpstreamConfig>): void {
    const config = this.load();
    const idx = config.upstreams.findIndex((u) => u.name === name);
    if (idx === -1) {
      throw new Error(`Upstream "${name}" does not exist.`);
    }
    const current = config.upstreams[idx]!;
    config.upstreams[idx] = { ...current, ...patch, name: current.name };
    this.save(config);
  }

  setModelMapEntry(upstreamName: string, pattern: string, target: string): void {
    const config = this.load();
    const upstream = config.upstreams.find((u) => u.name === upstreamName);
    if (!upstream) {
      throw new Error(`Upstream "${upstreamName}" does not exist.`);
    }
    if (!upstream.modelMap) {
      upstream.modelMap = {};
    }
    upstream.modelMap[pattern] = target;
    this.save(config);
  }

  deleteModelMapEntry(upstreamName: string, pattern: string): void {
    const config = this.load();
    const upstream = config.upstreams.find((u) => u.name === upstreamName);
    if (!upstream) {
      throw new Error(`Upstream "${upstreamName}" does not exist.`);
    }
    if (upstream.modelMap && pattern in upstream.modelMap) {
      delete upstream.modelMap[pattern];
      this.save(config);
    }
  }
}
