import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Dispatcher } from 'undici';
import type { ProviderCredentialUnsealingKms } from '../../../src/saas/credentials/provider-crypto.js';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PostgresProviderEgressProxyResolver } from '../../../src/saas/gateway/postgres-provider-egress-proxy-resolver.js';
import type { ProviderHttpPinnedConnector } from '../../../src/saas/gateway/provider-http-address.js';
import type { EgressProxyRecord } from '../../../src/saas/supply/egress-proxy-lookup.js';
import { readEgressProxyById, readEgressProxyForAccount } from '../../../src/saas/supply/egress-proxy-lookup.js';
import {
  type EgressProxyProbeFetch,
  EgressProxyProbeWorker,
  PostgresEgressProxyProbeWorkerStore,
  resolveEgressProxyFallbackTarget,
} from '../../../src/saas/supply/egress-proxy-probe-worker.js';

interface CapturedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

class FakeDatabase {
  readonly queries: CapturedQuery[] = [];
  readonly handler: (sql: string, values: readonly unknown[]) => { rows: unknown[]; rowCount: number | null };
  private readonly self: SqlExecutor & {
    transaction: (work: (tx: SqlExecutor) => Promise<unknown>) => Promise<unknown>;
  };

  constructor(
    handler: (sql: string, values: readonly unknown[]) => { rows: unknown[]; rowCount: number | null } = () => ({
      rows: [],
      rowCount: 0,
    }),
  ) {
    this.handler = handler;
    const executor: SqlExecutor = {
      query: async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
        this.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), values: values ?? [] });
        return this.handler(sql, values ?? []) as SqlResult<Row>;
      },
    };
    this.self = {
      ...executor,
      transaction: async (work) => work(executor),
    };
  }

  get executor(): SqlExecutor & { transaction: (work: (tx: SqlExecutor) => Promise<unknown>) => Promise<unknown> } {
    return this.self;
  }
}

const DUMMY_KMS: ProviderCredentialUnsealingKms = {
  decryptDataKey: async () => {
    throw new Error('unexpected unseal in this test');
  },
};

const FAKE_CONNECTION: ProviderHttpPinnedConnector = {
  dispatcher: {} as Dispatcher,
  close: async () => {},
  destroy: async () => {},
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function proxyRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'proxy-1',
    name: 'primary',
    protocol: 'http',
    host: 'proxy.example',
    port: 8080,
    auth_sealed_envelope: null,
    status: 'active',
    expires_at: null,
    fallback_mode: 'none',
    backup_proxy_id: null,
    ...overrides,
  };
}

function makeStore(
  database: FakeDatabase,
  options: {
    fetch?: EgressProxyProbeFetch;
    now?: () => Date;
    probeUrls?: { primary: string; secondary: string };
    degradedLatencyMs?: number;
  } = {},
): PostgresEgressProxyProbeWorkerStore {
  return new PostgresEgressProxyProbeWorkerStore(database.executor as never, DUMMY_KMS, {
    deployment: 'test-deployment',
    environment: 'test-environment',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    createConnection: async () => FAKE_CONNECTION,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.probeUrls === undefined ? {} : { probeUrls: options.probeUrls }),
    ...(options.degradedLatencyMs === undefined ? {} : { degradedLatencyMs: options.degradedLatencyMs }),
  });
}

test('a probe claims one due proxy with SKIP LOCKED and writes the measured quality', async () => {
  const database = new FakeDatabase((sql) => {
    const normalized = sql.replace(/\s+/g, ' ');
    if (normalized.includes('FROM saas_egress_proxies') && normalized.includes('FOR UPDATE SKIP LOCKED')) {
      return { rows: [proxyRow()], rowCount: 1 };
    }
    if (normalized.includes('FROM saas_egress_proxies')) {
      return { rows: [{ id: 'proxy-1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const seen: string[] = [];
  const store = makeStore(database, {
    fetch: async (url) => {
      seen.push(url);
      return jsonResponse({ ip: '203.0.113.9', country: 'AU' });
    },
  });
  const probed = await store.probeNext();
  assert.equal(probed, true);
  // The primary probe answered; the secondary endpoint is never touched.
  assert.deepEqual(seen, ['http://ip-api.com/json/']);
  const write = database.queries.find((query) => query.sql.includes('last_probe_quality'));
  assert.ok(write, 'the probe result write happened');
  assert.equal(write.values[0], 'proxy-1');
  assert.equal(write.values[3], 'ok');
  assert.equal(write.values[2], '203.0.113.9');
});

test('a probe falls back to the secondary endpoint and marks dead on total failure', async () => {
  for (const [fetchImpl, expectedQuality] of [
    [
      async (url: string) =>
        url.includes('ip-api') ? jsonResponse({ fail: 1 }, 500) : jsonResponse({ ip: '198.51.100.7' }),
      'ok',
    ],
    [async () => jsonResponse({ nope: true }, 503), 'dead'],
    [async () => new Response('garbage', { status: 200, headers: { 'content-type': 'application/json' } }), 'dead'],
  ] as const) {
    const database = new FakeDatabase((sql) => {
      const normalized = sql.replace(/\s+/g, ' ');
      if (normalized.includes('FOR UPDATE SKIP LOCKED')) return { rows: [proxyRow()], rowCount: 1 };
      if (normalized.includes('FROM saas_egress_proxies')) return { rows: [{ id: 'proxy-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const store = makeStore(database, { fetch: fetchImpl as EgressProxyProbeFetch });
    assert.equal(await store.probeNext(), true);
    const write = database.queries.find((query) => query.sql.includes('last_probe_quality'));
    assert.ok(write);
    assert.equal(write.values[3], expectedQuality);
    if (expectedQuality === 'dead') {
      assert.equal(write.values[1], null);
      assert.equal(write.values[2], null);
    }
  }
});

test('a probe failure never throws and never leaks the proxy URL into results', async () => {
  const database = new FakeDatabase((sql) => {
    const normalized = sql.replace(/\s+/g, ' ');
    if (normalized.includes('FOR UPDATE SKIP LOCKED')) {
      return { rows: [proxyRow({ auth_sealed_envelope: { nonsense: true } })], rowCount: 1 };
    }
    if (normalized.includes('FROM saas_egress_proxies')) return { rows: [{ id: 'proxy-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const store = makeStore(database, {
    fetch: async () => {
      throw new Error('connector exploded with socks5h://user:secret@proxy.example:1080 in the message');
    },
  });
  assert.equal(await store.probeNext(), true);
  const write = database.queries.find((query) => query.sql.includes('last_probe_quality'));
  assert.ok(write);
  assert.equal(write.values[3], 'dead');
  // The failure detail is discarded — only the bounded quality tuple is written.
  for (const value of write.values) {
    assert.ok(!String(value).includes('proxy.example'));
    assert.ok(!String(value).includes('secret'));
  }
});

test('the expiry sweep migrates accounts per fallback mode and records provenance', async () => {
  const now = new Date('2026-10-16T00:00:00.000Z');
  const expiredIso = '2026-10-15T00:00:00.000Z';
  const rows: Record<string, unknown>[] = [
    proxyRow({ id: 'proxy-none', name: 'none-mode', expires_at: expiredIso, fallback_mode: 'none' }),
    proxyRow({ id: 'proxy-direct', name: 'direct-mode', expires_at: expiredIso, fallback_mode: 'direct' }),
    proxyRow({ id: 'proxy-backup', name: 'backup', expires_at: null }),
    proxyRow({
      id: 'proxy-chain',
      name: 'chain-mode',
      expires_at: expiredIso,
      fallback_mode: 'proxy',
      backup_proxy_id: 'proxy-backup',
    }),
    proxyRow({ id: 'proxy-future', name: 'future', expires_at: '2027-01-01T00:00:00.000Z' }),
    proxyRow({ id: 'proxy-inactive', name: 'inactive', status: 'inactive', expires_at: expiredIso }),
  ];
  const migrated: CapturedQuery[] = [];
  const database = new FakeDatabase((sql, values) => {
    const normalized = sql.replace(/\s+/g, ' ');
    if (
      normalized.startsWith(
        'SELECT id, name, protocol, host, port, auth_sealed_envelope, status, expires_at, fallback_mode, backup_proxy_id FROM saas_egress_proxies',
      )
    ) {
      return { rows, rowCount: rows.length };
    }
    if (normalized.includes('FOR UPDATE SKIP LOCKED')) {
      return { rows: [{ id: values[0] }], rowCount: 1 };
    }
    if (normalized.includes('SET egress_proxy_id = $2')) {
      migrated.push({ sql: normalized, values });
      return { rows: [], rowCount: 3 };
    }
    return { rows: [], rowCount: 0 };
  });
  const store = makeStore(database, { now: () => now });
  const changed = await store.sweepExpiredProxies();
  // direct (3 tenant + 3 platform = 6) + chain (6) = 12 migrated accounts.
  assert.equal(changed, 12);

  const byProxy = new Map(migrated.map((query) => [String(query.values[0]), query]));
  assert.ok(byProxy.has('proxy-direct'));
  assert.ok(byProxy.has('proxy-chain'));
  assert.ok(!byProxy.has('proxy-none'), 'fallback_mode=never touches accounts');
  assert.ok(!byProxy.has('proxy-future'));
  assert.ok(!byProxy.has('proxy-inactive'));
  assert.equal(byProxy.get('proxy-direct')?.values[1], null, 'direct mode unbinds');
  assert.equal(byProxy.get('proxy-chain')?.values[1], 'proxy-backup', 'proxy mode rebinds to the backup');
  for (const query of migrated) {
    assert.match(query.sql, /proxy_fallback_origin_id = \$1/);
    assert.match(query.sql, /WHERE egress_proxy_id = \$1/);
  }
  // Every expired proxy transitions to 'expired'; audits were written.
  const statusWrites = database.queries.filter((query) => query.sql.includes("SET status = 'expired'"));
  assert.equal(statusWrites.length, 3);
  const audits = database.queries.filter((query) => query.sql.includes('INSERT INTO saas_audit_events'));
  assert.equal(audits.length, 3);
  for (const audit of audits) {
    // VALUES ($1 id, $2 action, 'saas_egress_proxies', $3 target, clock, $4 entry point)
    assert.match(String(audit.values[1]), /^saas_egress_proxy\./);
    assert.equal(typeof audit.values[2], 'string');
    assert.equal(audit.values[3], 'egress-proxy-probe-worker');
    assert.ok(audit.sql.includes("'saas_egress_proxies'"));
  }
});

test('fallback chains resolve cycle-safely and stop on unresolved links', () => {
  const now = new Date('2026-10-16T00:00:00.000Z');
  const record = (
    id: string,
    fallbackMode: string,
    backupProxyId: string | null,
    overrides: Partial<EgressProxyRecord> = {},
  ): EgressProxyRecord => ({
    id,
    name: id,
    protocol: 'http',
    host: 'proxy.example',
    port: 8080,
    authSealedEnvelope: null,
    status: 'active',
    expiresAt: null,
    fallbackMode,
    backupProxyId,
    lastProbeAt: null,
    lastProbeLatencyMs: null,
    lastProbeIp: null,
    lastProbeQuality: null,
    ...overrides,
  });
  // none never changes anything.
  assert.deepEqual(resolveEgressProxyFallbackTarget(record('a', 'none', null), new Map(), now), {
    targetProxyId: null,
    change: false,
  });
  // direct unbinds.
  assert.deepEqual(resolveEgressProxyFallbackTarget(record('a', 'direct', null), new Map(), now), {
    targetProxyId: null,
    change: true,
  });
  // A healthy backup is selected.
  const healthy = record('backup', 'none', null);
  assert.deepEqual(
    resolveEgressProxyFallbackTarget(record('a', 'proxy', 'backup'), new Map([['backup', healthy]]), now),
    {
      targetProxyId: 'backup',
      change: true,
    },
  );
  // A cycle of expired intermediates resolves to no-change.
  const cyclic = new Map([
    ['a', record('a', 'proxy', 'b', { expiresAt: '2026-01-01T00:00:00.000Z' })],
    ['b', record('b', 'proxy', 'a', { expiresAt: '2026-01-01T00:00:00.000Z' })],
  ]);
  assert.deepEqual(resolveEgressProxyFallbackTarget(cyclic.get('a') as EgressProxyRecord, cyclic, now), {
    targetProxyId: null,
    change: false,
  });
  // A healthy backup is a valid target even if its own fallback points back
  // (the chain is only walked through expired links).
  const backRef = new Map([
    ['a', record('a', 'proxy', 'b', { expiresAt: '2026-01-01T00:00:00.000Z' })],
    ['b', record('b', 'proxy', 'a')],
  ]);
  assert.deepEqual(resolveEgressProxyFallbackTarget(backRef.get('a') as EgressProxyRecord, backRef, now), {
    targetProxyId: 'b',
    change: true,
  });
  // An expired backup with direct fallback terminates at direct.
  const chain = new Map([
    ['a', record('a', 'proxy', 'dead-backup')],
    ['dead-backup', record('dead-backup', 'direct', null, { expiresAt: '2026-01-01T00:00:00.000Z' })],
  ]);
  assert.deepEqual(resolveEgressProxyFallbackTarget(chain.get('a') as EgressProxyRecord, chain, now), {
    targetProxyId: null,
    change: true,
  });
  // A missing backup link is unresolved.
  assert.deepEqual(resolveEgressProxyFallbackTarget(record('a', 'proxy', 'missing'), new Map(), now), {
    targetProxyId: null,
    change: false,
  });
});

test('the three egress paths resolve the same proxy record for one account', async () => {
  // One shared lookup: the gateway dispatch-profile resolver reads through
  // readEgressProxyForAccount, and so must the refresh worker and the probe
  // worker's account joins — that is the sub2api three-paths-one-egress
  // invariant. This test proves the shared lookup returns the identical
  // record for both scopes of one account id.
  const row = proxyRow({ id: 'proxy-9', protocol: 'socks5', host: 'egress.example', port: 1080 });
  const database = new FakeDatabase((sql) => {
    const normalized = sql.replace(/\s+/g, ' ');
    if (
      normalized.includes('FROM saas_tenant_provider_accounts AS account') ||
      normalized.includes('FROM saas_platform_provider_accounts AS account') ||
      normalized.includes('FROM saas_egress_proxies')
    ) {
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const tenantRecord = await readEgressProxyForAccount(database.executor, {
    ownerKind: 'tenant',
    tenantId: 'tenant-1',
    accountId: 'account-1',
  });
  const platformRecord = await readEgressProxyForAccount(database.executor, {
    ownerKind: 'platform',
    accountId: 'account-1',
  });
  assert.deepEqual(tenantRecord, platformRecord);
  assert.equal(tenantRecord?.id, 'proxy-9');
  // The probe worker's by-id read maps to the same record family.
  const byId = await readEgressProxyById(database.executor, 'proxy-9');
  assert.equal(byId?.host, 'egress.example');
  assert.equal(byId?.protocol, 'socks5');
  // The gateway resolver turns that record into the dispatch URL (socks5
  // upgraded to socks5h, credentials from the sealed envelope).
  const resolver = new PostgresProviderEgressProxyResolver({
    database: database.executor as never,
    kms: DUMMY_KMS,
    credentialContext: { deployment: 'test-deployment', environment: 'test-environment' },
  });
  const descriptor = await resolver.resolveEgressProxy({
    tenantId: 'tenant-1',
    supplyMode: 'byok',
    accountOwnerKind: 'tenant',
    accountId: 'account-1',
  });
  assert.equal(descriptor?.url, 'socks5h://egress.example:1080');
  const legacyOwnerKindDescriptor = await resolver.resolveEgressProxy({
    tenantId: 'tenant-1',
    supplyMode: 'byok',
    accountOwnerKind: undefined,
    accountId: 'account-1',
  });
  assert.equal(legacyOwnerKindDescriptor?.url, 'socks5h://egress.example:1080');

  // A bound proxy that cannot be unsealed fails closed — never a silent
  // direct-egress null.
  const brokenKms: ProviderCredentialUnsealingKms = {
    decryptDataKey: async () => {
      throw new Error('kms down');
    },
  };
  const brokenDatabase = new FakeDatabase(() => ({
    rows: [proxyRow({ auth_sealed_envelope: { algorithm: 'aes-256-gcm' } })],
    rowCount: 1,
  }));
  const brokenResolver = new PostgresProviderEgressProxyResolver({
    database: brokenDatabase.executor as never,
    kms: brokenKms,
    credentialContext: { deployment: 'test-deployment', environment: 'test-environment' },
  });
  await assert.rejects(
    brokenResolver.resolveEgressProxy({
      tenantId: 'tenant-1',
      supplyMode: 'byok',
      accountOwnerKind: 'tenant',
      accountId: 'account-1',
    }),
  );
});

test('all three paths source the account→proxy mapping from the shared lookup module', () => {
  // The refresh worker and the gateway resolver must import the same
  // readEgressProxyForAccount; the probe worker resolves by proxy id through
  // the same module family. Source-level pins keep future refactors honest.
  const refreshWorker = readFileSync('src/saas/supply/oauth-token-refresh-worker.ts', 'utf8');
  assert.ok(
    refreshWorker.includes('readEgressProxyForAccount('),
    'the OAuth refresh worker resolves proxies through the shared lookup',
  );
  assert.ok(
    refreshWorker.includes('egress_proxy_unavailable'),
    'a broken proxy fails the refresh attempt instead of direct-egressing',
  );
  const gatewayResolver = readFileSync('src/saas/gateway/postgres-provider-egress-proxy-resolver.ts', 'utf8');
  assert.ok(
    gatewayResolver.includes('readEgressProxyForAccount('),
    'the gateway dispatch resolver resolves proxies through the shared lookup',
  );
  const scheduler = readFileSync('src/saas/gateway/postgres-provider-account-scheduler.ts', 'utf8');
  assert.ok(
    scheduler.includes('egress_proxy.last_probe_quality'),
    'the scheduler reads the probe quality as a weight signal',
  );
  assert.ok(scheduler.includes('LEFT JOIN saas_egress_proxies'), 'the scheduler joins the proxy table');
});

test('the worker bounds probe rounds and sweeps once per cycle', async () => {
  let probeCalls = 0;
  let sweepCalls = 0;
  const store = makeStore(new FakeDatabase());
  const probeNext = store.probeNext.bind(store);
  store.probeNext = async () => {
    probeCalls += 1;
    return probeCalls <= 25; // more due proxies than the round cap
  };
  const sweep = store.sweepExpiredProxies.bind(store);
  store.sweepExpiredProxies = async () => {
    sweepCalls += 1;
    return 0;
  };
  void probeNext;
  void sweep;
  const worker = new EgressProxyProbeWorker(store, { pollIntervalMs: 1_000 });
  const probed = await worker.runOnce();
  assert.equal(probed, 10, 'the round cap bounds probes per cycle');
  assert.equal(sweepCalls, 1, 'the sweep runs exactly once per cycle');
});
