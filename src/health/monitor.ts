import type { ConfigStore } from '../config/store.js';
import type { UpstreamConfig } from '../config/types.js';

const HEALTH_CHECK_INTERVAL_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export class HealthMonitor {
  private store: ConfigStore;
  private failureCounts = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(store: ConfigStore) {
    this.store = store;
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

  private async runCheck(): Promise<void> {
    const upstreams = this.store.listUpstreams();
    await Promise.all(upstreams.map((u) => this.checkUpstream(u)));
  }

  private async checkUpstream(upstream: UpstreamConfig): Promise<void> {
    const model = upstream.models[0];
    if (!model) return;

    const url = `${upstream.baseUrl.replace(/\/$/, '')}/v1/messages`;
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: '1' }],
      max_tokens: 5,
    });

    let ok = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${upstream.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      ok = res.status >= 200 && res.status < 300;
      if (!ok) {
        const bodyText = await res.text().catch(() => '');
        console.log(`[health] Upstream "${upstream.name}" check returned ${res.status}: ${bodyText.slice(0, 200)}`);
      }
    } catch (err: any) {
      ok = false;
      console.log(`[health] Upstream "${upstream.name}" check error: ${err.message}`);
    }

    const currentCount = this.failureCounts.get(upstream.name) || 0;

    if (ok) {
      if (!upstream.enabled) {
        this.store.setUpstreamEnabled(upstream.name, true);
        console.log(`[health] Upstream "${upstream.name}" recovered, enabled.`);
      }
      if (currentCount > 0) {
        this.failureCounts.set(upstream.name, 0);
      }
    } else {
      const newCount = currentCount + 1;
      this.failureCounts.set(upstream.name, newCount);
      console.log(`[health] Upstream "${upstream.name}" failed check (${newCount}/${MAX_CONSECUTIVE_FAILURES})`);
      if (newCount >= MAX_CONSECUTIVE_FAILURES && upstream.enabled) {
        this.store.setUpstreamEnabled(upstream.name, false);
        console.log(`[health] Upstream "${upstream.name}" disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`);
      }
    }
  }
}
