import type { ConfigStore } from '../config/store.js';
import type { UpstreamConfig } from '../config/types.js';
import { RuntimeConfigStore } from '../config/v2-runtime.js';
import { joinApiUrl } from '../providers/url.js';
import type { KeyPool } from '../server/keyPool.js';

const HEALTH_CHECK_INTERVAL_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;

interface HealthProbe {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function buildHealthProbe(upstream: UpstreamConfig, model: string): HealthProbe {
  const base = upstream.baseUrl.replace(/\/$/, '');
  const protocol = upstream.protocol || 'anthropic';
  const explicitUrl = upstream.endpoint ? joinApiUrl(upstream.baseUrl, upstream.endpoint).toString() : undefined;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };

  if (protocol === 'anthropic') {
    return {
      url: explicitUrl ?? `${base}/v1/messages`,
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '1' }],
        max_tokens: 5,
      }),
    };
  }

  return {
    url: explicitUrl ?? `${base}/v1/chat/completions`,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '1' }],
      max_tokens: 5,
    }),
  };
}

function authHeader(upstream: UpstreamConfig, key: string): Record<string, string> {
  if (upstream.authMode === 'none' || upstream.authMode === 'pass-through') return {};
  if (upstream.authMode === 'x-api-key') {
    return { 'x-api-key': key };
  }
  return { authorization: `Bearer ${key}` };
}

export class HealthMonitor {
  private store: ConfigStore;
  private keyPool?: KeyPool;
  private failureCounts = new Map<string, number>();
  private observations = new Map<
    string,
    { healthy: boolean; checkedAt: number; consecutiveFailures: number; error?: string }
  >();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(store: ConfigStore, keyPool?: KeyPool) {
    this.store = store;
    this.keyPool = keyPool;
  }

  start(): void {
    if (this.timer) return;
    // Run immediately once, then every minute
    this.runCheck();
    this.timer = setInterval(() => this.runCheck(), HEALTH_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(
    upstreamId: string,
  ): { healthy: boolean; checkedAt: number; consecutiveFailures: number; error?: string } | undefined {
    return this.observations.get(upstreamId);
  }

  private async runCheck(): Promise<void> {
    const upstreams = this.store.listUpstreams();
    await Promise.all(upstreams.map((u) => this.checkUpstream(u)));
  }

  private async checkUpstream(upstream: UpstreamConfig): Promise<void> {
    if (this.store instanceof RuntimeConfigStore && upstream.healthMode !== 'active') return;
    const model = upstream.models[0];
    if (!model) return;

    let entries = this.keyPool?.getAvailableEntries(upstream.name) ?? [];
    if (entries.length === 0) {
      entries = upstream.apiKeys.map((key, index) => ({
        credentialId: upstream.credentialIds?.[index] ?? key,
        key,
      }));
    }
    if (entries.length === 0 && (upstream.authMode === 'none' || upstream.authMode === 'pass-through')) {
      entries = [{ credentialId: '', key: '' }];
    }
    if (entries.length === 0) return;

    const probe = buildHealthProbe(upstream, model);

    let anyOk = false;
    let lastError = '';

    for (const entry of entries) {
      const { key } = entry;
      let ok = false;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
        const headers = { ...probe.headers, ...authHeader(upstream, key) };
        const res = await fetch(probe.url, {
          method: probe.method,
          headers,
          body: probe.body,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        ok = res.status >= 200 && res.status < 300;
        if (!ok) {
          const bodyText = await res.text().catch(() => '');
          lastError = `returned ${res.status}: ${bodyText.slice(0, 200)}`;
        }
      } catch (err: any) {
        ok = false;
        lastError = `error: ${err.message}`;
      }

      if (ok) {
        anyOk = true;
        this.keyPool?.markSuccess(upstream.name, entry);
        break;
      } else {
        console.log(`[health] Upstream "${upstream.name}" key probe failed (${lastError})`);
      }
    }

    const currentCount = this.failureCounts.get(upstream.name) || 0;

    if (anyOk) {
      this.observations.set(upstream.name, { healthy: true, checkedAt: Date.now(), consecutiveFailures: 0 });
      if (!upstream.enabled && !(this.store instanceof RuntimeConfigStore)) {
        this.store.setUpstreamEnabled(upstream.name, true);
        console.log(`[health] Upstream "${upstream.name}" recovered, enabled.`);
      }
      if (currentCount > 0) {
        this.failureCounts.set(upstream.name, 0);
      }
    } else {
      const newCount = currentCount + 1;
      this.failureCounts.set(upstream.name, newCount);
      this.observations.set(upstream.name, {
        healthy: false,
        checkedAt: Date.now(),
        consecutiveFailures: newCount,
        error: lastError,
      });
      console.log(`[health] Upstream "${upstream.name}" all keys failed (${newCount}/${MAX_CONSECUTIVE_FAILURES})`);
      if (newCount >= MAX_CONSECUTIVE_FAILURES && upstream.enabled && !(this.store instanceof RuntimeConfigStore)) {
        this.store.setUpstreamEnabled(upstream.name, false);
        console.log(
          `[health] Upstream "${upstream.name}" disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive all-key failures.`,
        );
      }
    }
  }
}
