import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type AlertMinuteSample,
  ConsoleLogAlertEmailSender,
  deliverAlertWebhook,
  evaluateAlertRule,
  isWindowMetric,
  ObservabilityAlertService,
  parseAlertMetric,
} from '../../../src/saas/observability/alerts.js';

const MINUTE = 60_000;

/** Records queries so rule CRUD can be asserted without a database. */
class FakeExecutor {
  readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  private readonly resultQueue: Array<Record<string, unknown>[]> = [];
  /** Queues the rows returned by the next query call, in order. */
  enqueueNext(rows: Record<string, unknown>[]): void {
    this.resultQueue.push(rows);
  }
  async query<Row>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
    this.queries.push({ sql, values: values ?? [] });
    const rows = (this.resultQueue.shift() ?? []) as Row[];
    return { rows, rowCount: rows.length };
  }
}

function ruleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'b7d1c0de-0000-4000-8000-000000000001',
    name: 'kimi error rate',
    enabled: true,
    metric: 'channel_error_rate:provider=kimi',
    operator: 'gt',
    threshold: 0.1,
    window_minutes: 10,
    sustained_minutes: 3,
    cooldown_minutes: 30,
    notify_email: 'ops@example.com',
    webhook_url: null,
    last_triggered_at: null,
    created_at: new Date('2026-10-15T00:00:00Z'),
    ...overrides,
  };
}

function sample(minuteStartMs: number, value: number): AlertMinuteSample {
  return { minuteStartMs, value };
}

test('parseAlertMetric accepts plain and provider-scoped metrics', () => {
  assert.deepEqual(parseAlertMetric('channel_error_rate'), { name: 'channel_error_rate' });
  assert.deepEqual(parseAlertMetric('channel_error_rate:provider=kimi'), {
    name: 'channel_error_rate',
    provider: 'kimi',
  });
  assert.equal(parseAlertMetric('wallet_active_holds:provider='), null);
  assert.equal(parseAlertMetric('not_a_metric'), null);
  assert.equal(isWindowMetric('channel_error_rate'), true);
  assert.equal(isWindowMetric('wallet_active_holds'), false);
});

test('evaluateAlertRule requires sustained consecutive violations inside the window', () => {
  const now = 10 * MINUTE;
  const rule = {
    operator: 'gt' as const,
    threshold: 0.1,
    sustainedMinutes: 3,
    cooldownMinutes: 10,
    lastTriggeredAtMs: null,
  };
  // Three consecutive violating minutes at the tail → trigger.
  const sustained = evaluateAlertRule({
    rule,
    nowMs: now,
    samples: [sample(6 * MINUTE, 0.2), sample(7 * MINUTE, 0.2), sample(8 * MINUTE, 0.2), sample(9 * MINUTE, 0.2)],
  });
  assert.equal(sustained.violates, true);
  assert.equal(sustained.sustained, true);
  assert.equal(sustained.cooledDown, true);
  assert.equal(sustained.shouldTrigger, true);
  assert.equal(sustained.windowValue, 0.2);

  // A gap in the minute series breaks the consecutive chain.
  const gapped = evaluateAlertRule({
    rule,
    nowMs: now,
    samples: [sample(5 * MINUTE, 0.2), sample(7 * MINUTE, 0.2), sample(8 * MINUTE, 0.2), sample(9 * MINUTE, 0.2)],
  });
  assert.equal(gapped.sustained, false);
  assert.equal(gapped.shouldTrigger, false);

  // Two violating tail minutes are not enough for sustained=3.
  const short = evaluateAlertRule({
    rule,
    nowMs: now,
    samples: [sample(7 * MINUTE, 0.01), sample(8 * MINUTE, 0.2), sample(9 * MINUTE, 0.2)],
  });
  assert.equal(short.sustained, false);

  // A healthy window never triggers.
  const healthy = evaluateAlertRule({
    rule,
    nowMs: now,
    samples: [sample(7 * MINUTE, 0.0), sample(8 * MINUTE, 0.01), sample(9 * MINUTE, 0.02)],
  });
  assert.equal(healthy.violates, false);
  assert.equal(healthy.shouldTrigger, false);
});

test('evaluateAlertRule enforces cooldown after a trigger', () => {
  const now = 10 * MINUTE;
  const rule = {
    operator: 'gt' as const,
    threshold: 10,
    sustainedMinutes: 1,
    cooldownMinutes: 10,
    lastTriggeredAtMs: now - 5 * MINUTE,
  };
  const silenced = evaluateAlertRule({
    rule,
    nowMs: now,
    samples: [sample(9 * MINUTE, 50)],
  });
  assert.equal(silenced.violates, true);
  assert.equal(silenced.cooledDown, false);
  assert.equal(silenced.shouldTrigger, false);

  const recovered = evaluateAlertRule({
    rule: { ...rule, lastTriggeredAtMs: now - 11 * MINUTE },
    nowMs: now,
    samples: [sample(9 * MINUTE, 50)],
  });
  assert.equal(recovered.cooledDown, true);
  assert.equal(recovered.shouldTrigger, true);
});

test('evaluateAlertRule supports the lt operator and point-in-time metrics', () => {
  const now = 10 * MINUTE;
  const lowTraffic = evaluateAlertRule({
    rule: {
      operator: 'lt' as const,
      threshold: 5,
      sustainedMinutes: 2,
      cooldownMinutes: 1,
      lastTriggeredAtMs: null,
    },
    nowMs: now,
    samples: [sample(8 * MINUTE, 1), sample(9 * MINUTE, 2)],
  });
  assert.equal(lowTraffic.shouldTrigger, true);

  const holds = evaluateAlertRule({
    rule: {
      operator: 'gt' as const,
      threshold: 100,
      sustainedMinutes: 5,
      cooldownMinutes: 1,
      lastTriggeredAtMs: null,
    },
    nowMs: now,
    samples: [sample(now, 150)],
    pointInTime: true,
  });
  assert.equal(holds.violates, true);
  assert.equal(holds.sustained, true);
  assert.equal(holds.shouldTrigger, true);
  assert.equal(holds.windowValue, 150);
});

test('alert rule validation rejects malformed rules before any SQL runs', async () => {
  const executor = new FakeExecutor();
  const service = new ObservabilityAlertService(executor);
  const base = {
    name: 'kimi error rate',
    metric: 'channel_error_rate',
    operator: 'gt' as const,
    threshold: 0.1,
    windowMinutes: 10,
    sustainedMinutes: 3,
    cooldownMinutes: 30,
  };
  const invalidCases: Array<[Partial<typeof base>, string]> = [
    [{ name: '   ' }, 'ALERT_INVALID_NAME'],
    [{ metric: 'bogus' }, 'ALERT_INVALID_METRIC'],
    [{ operator: 'eq' as unknown as 'gt' }, 'ALERT_INVALID_OPERATOR'],
    [{ threshold: Number.NaN }, 'ALERT_INVALID_THRESHOLD'],
    [{ windowMinutes: 0 }, 'ALERT_INVALID_WINDOW'],
    [{ sustainedMinutes: 0 }, 'ALERT_INVALID_SUSTAINED'],
    [{ sustainedMinutes: 20 }, 'ALERT_INVALID_SUSTAINED'],
    [{ cooldownMinutes: 0 }, 'ALERT_INVALID_COOLDOWN'],
    [{ notifyEmail: 'not-an-email' }, 'ALERT_INVALID_NOTIFY_EMAIL'],
    [{ webhookUrl: 'http://insecure.example' }, 'ALERT_INVALID_WEBHOOK_URL'],
  ];
  for (const [patch, code] of invalidCases) {
    await assert.rejects(service.createRule({ ...base, ...patch }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, code);
      return true;
    });
  }
  assert.equal(executor.queries.length, 0, 'validation failures must never reach SQL');
});

test('alert rule CRUD maps rows and writes validated fields', async () => {
  const executor = new FakeExecutor();
  const service = new ObservabilityAlertService(executor);
  executor.enqueueNext([ruleRow()]);
  const rules = await service.listRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.metric, 'channel_error_rate:provider=kimi');
  assert.equal(rules[0]?.notifyEmail, 'ops@example.com');
  assert.equal(rules[0]?.lastTriggeredAt, null);
  assert.equal(rules[0]?.createdAt, '2026-10-15T00:00:00.000Z');

  executor.enqueueNext([ruleRow({ notify_email: null, last_triggered_at: '2026-10-15T01:02:03Z' })]);
  const created = await service.createRule({
    name: 'kimi error rate',
    metric: 'channel_error_rate:provider=kimi',
    operator: 'gt',
    threshold: 0.1,
    windowMinutes: 10,
    sustainedMinutes: 3,
    cooldownMinutes: 30,
    notifyEmail: null,
  });
  assert.equal(created.lastTriggeredAt, '2026-10-15T01:02:03.000Z');
  const insert = executor.queries.at(-1);
  assert.match(insert?.sql ?? '', /INSERT INTO saas_obs_alert_rules/);
  assert.equal(insert?.values[2], true);
  assert.equal(insert?.values[3], 'channel_error_rate:provider=kimi');

  // updateRule merges with the current row and revalidates the merged shape.
  executor.enqueueNext([ruleRow()]);
  await assert.rejects(
    service.updateRule('b7d1c0de-0000-4000-8000-000000000001', { sustainedMinutes: 99 }),
    (error: unknown) => (error as { code?: string }).code === 'ALERT_INVALID_SUSTAINED',
  );
  executor.enqueueNext([ruleRow({ enabled: true })]);
  executor.enqueueNext([ruleRow({ enabled: false })]);
  const updated = await service.updateRule('b7d1c0de-0000-4000-8000-000000000001', { enabled: false });
  assert.equal(updated.enabled, false);
  executor.enqueueNext([]);
  assert.equal(await service.deleteRule('missing'), false);
});

test('the console email sender logs structured notifications', async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    const sender = new ConsoleLogAlertEmailSender();
    await sender.send({ to: 'ops@example.com', subject: 'alert', body: 'body' });
  } finally {
    console.log = originalLog;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /ops@example\.com/);
});

test('deliverAlertWebhook signs with the customer webhook HMAC contract when a key is set', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('ok', { status: 200 });
  }) as typeof globalThis.fetch;
  const payload = {
    type: 'obs.alert.triggered' as const,
    ruleId: 'r1',
    ruleName: 'rule',
    metric: 'channel_error_rate',
    operator: 'gt' as const,
    threshold: 0.1,
    windowMinutes: 5,
    sustainedMinutes: 2,
    value: 0.5,
    triggeredAt: '2026-10-15T00:00:00.000Z',
  };
  const key = new Uint8Array(32).fill(7);
  await deliverAlertWebhook('https://hooks.example/alerts', payload, { fetch: fakeFetch, signingKey: key });
  assert.equal(calls.length, 1);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.match(headers['x-model-router-signature'] ?? '', /^v1=1:[0-9a-f]{64}$/);
  assert.match(headers['x-model-router-event-id'] ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(headers['content-type'], 'application/json');

  // Unsigned when no key is configured.
  calls.length = 0;
  await deliverAlertWebhook('https://hooks.example/alerts', payload, { fetch: fakeFetch });
  const unsignedHeaders = calls[0].init.headers as Record<string, string>;
  assert.equal(unsignedHeaders['x-model-router-signature'], undefined);
});

test('deliverAlertWebhook surfaces non-2xx deliveries as failures', async () => {
  const fakeFetch = (async () => new Response('boom', { status: 500 })) as typeof globalThis.fetch;
  await assert.rejects(
    deliverAlertWebhook(
      'https://hooks.example/alerts',
      {
        type: 'obs.alert.triggered',
        ruleId: 'r1',
        ruleName: 'rule',
        metric: 'wallet_active_holds',
        operator: 'gt',
        threshold: 1,
        windowMinutes: 1,
        sustainedMinutes: 1,
        value: 5,
        triggeredAt: '2026-10-15T00:00:00.000Z',
      },
      { fetch: fakeFetch },
    ),
    /status 500/,
  );
});
