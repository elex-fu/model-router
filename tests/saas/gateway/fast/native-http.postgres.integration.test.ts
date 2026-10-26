import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@redis/client';
import { createSaasDatabase } from '../../../../src/saas/db/index.js';
import { anyRoleConfigured, roleUrls } from '../../metering/normal-success-postgres-fixture.js';
import type { NativeFastHttpConfig } from './native-http-runtime-fixture.js';
import { seedNativeFastHttpInventory } from './native-http-seed-fixture.js';

const REQUIRED_FLAG = 'MODEL_ROUTER_NATIVE_FAST_HTTP_REQUIRED';
const redisUrl = process.env.MODEL_ROUTER_NATIVE_FAST_HTTP_REDIS_URL;
const offline = process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured && !redisUrl;
const scenario = process.env.MODEL_ROUTER_NATIVE_FAST_HTTP_SCENARIO ?? 'builtin-default';
assert.ok(
  ['builtin-default', 'fixed4096-control', 'builtin-explicit1m-pressure'].includes(scenario),
  'known required native scenario',
);
const pressure = scenario === 'builtin-explicit1m-pressure';
const fixedControl = scenario === 'fixed4096-control';
const expected = pressure
  ? { count: '2', charge: '70', input: '20', output: '10', wallet: '99999999930' }
  : { count: '4', charge: '140', input: '40', output: '20', wallet: '99999999860' };
const maximum = fixedControl ? '20480' : '524480';
const trustedConcurrency = 64n;
const automaticTarget = 2n * 524480n * trustedConcurrency;

function checkedRedisUrl(): string {
  assert.ok(redisUrl, 'MODEL_ROUTER_NATIVE_FAST_HTTP_REDIS_URL is required');
  const url = new URL(redisUrl);
  assert.equal(url.protocol, 'redis:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.ok(url.pathname === '' || url.pathname === '/');
  const ci = url.hostname === 'redis' && url.port === '6379';
  const local = ['127.0.0.1', '[::1]'].includes(url.hostname) && Number(url.port) > 0 && url.port !== '6379';
  assert.ok(ci || local, 'only a fresh CI Redis service or owned nondefault loopback Redis is allowed');
  return url.toString();
}
async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

// No mocked admission, snapshot, journal, transport, terminal, or settlement ports.
// The actual source CLI builds all native fast components from opt-in env settings.
test(`required native fast HTTP ${scenario}: first funded send and exact durable financial drain`, {
  skip: offline ? 'set MODEL_ROUTER_NATIVE_FAST_HTTP_REQUIRED=1 and disposable PostgreSQL/Redis URLs' : false,
  timeout: 120_000,
}, async (t) => {
  const urls = roleUrls();
  const redis = createClient({ url: checkedRedisUrl(), socket: { reconnectStrategy: false } });
  redis.on('error', () => {});
  await redis.connect();
  t.after(() => {
    if (redis.isOpen) redis.destroy();
  });
  const namespace = `native-http-${randomUUID()}`;
  const prefix = `mr:fast:{${createHash('sha256')
    .update(JSON.stringify([namespace]))
    .digest('hex')}}`;
  assert.deepEqual(await redis.keys(`${prefix}:*`), [], 'drained is legal only for this new isolated namespace');

  const migrator = createSaasDatabase({ connectionString: urls[0], max: 2 });
  const inspector = createSaasDatabase({ connectionString: urls[2], max: 2 });
  t.after(async () => {
    await inspector.close();
    await migrator.close();
  });
  await inspector.verifySchema();
  assert.equal(
    (await migrator.query<{ count: string }>('SELECT count(*)::text AS count FROM saas_api_keys')).rows[0]?.count,
    '0',
    'native HTTP gate requires a fresh database, never a consumed historical HTTP fixture',
  );

  const directory = await mkdtemp(join(tmpdir(), 'model-router-native-fast-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certificateFile = join(directory, 'certificate.pem');
  const tlsKeyFile = join(directory, 'tls-key.pem');
  const tls = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      tlsKeyFile,
      '-out',
      certificateFile,
      '-days',
      '1',
      '-subj',
      '/CN=native-fast-local-test',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore', timeout: 15_000 },
  );
  assert.equal(tls.status, 0, 'generate disposable local TLS certificate');
  const kmsEnv = {
    MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY: randomBytes(32).toString('hex'),
    MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID: 'r9-local-test',
  };
  const seeded = await seedNativeFastHttpInventory(migrator, kmsEnv);
  const route = seeded.inventory[0];
  assert.ok(route);
  assert.equal(
    (
      await migrator.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM saas_provider_account_runtime_health WHERE account_id=ANY($1::text[])',
        [route.accountIds],
      )
    ).rows[0]?.count,
    '0',
    'verified cold accounts must work without fabricated healthy rows',
  );

  const upstream = { json: 0, sse: 0, invalid: 0 };
  let tlsConnections = 0;
  let nextBarrier: { entered(): void; released: Promise<void> } | undefined;
  const mock = createHttpsServer(
    { cert: await readFile(certificateFile), key: await readFile(tlsKeyFile) },
    async (req, res) => {
      try {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/v1/chat/completions');
        assert.ok(route.accountIds.some((id) => req.headers.authorization === `Bearer ${id}`));
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string; stream?: boolean };
        assert.equal(body.model, route.providerModel);
        const barrier = nextBarrier;
        nextBarrier = undefined;
        if (barrier) {
          barrier.entered();
          await barrier.released;
        }
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        const common = { id: `chatcmpl-${randomUUID()}`, created: 1_700_000_000, model: body.model };
        if (!body.stream) {
          upstream.json++;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ...common,
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }],
              usage,
            }),
          );
        } else {
          upstream.sse++;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const part of [
            { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello.' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            { choices: [], usage },
          ])
            res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', ...part })}\n\n`);
          res.end('data: [DONE]\n\n');
        }
      } catch {
        upstream.invalid++;
        res.writeHead(500);
        res.end('local fixture rejected request');
      }
    },
  );
  mock.on('secureConnection', () => {
    tlsConnections++;
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(async () => {
    mock.closeAllConnections();
    await new Promise<void>((done) => mock.close(() => done()));
  });
  const mockPort = (mock.address() as { port: number }).port;
  const signing = generateKeyPairSync('ed25519');
  const privateKeyFile = join(directory, 'signing.pem');
  const publicKeyFile = join(directory, 'public.pem');
  await writeFile(privateKeyFile, signing.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(publicKeyFile, signing.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 });
  const configFile = join(directory, 'config.json');
  const config: NativeFastHttpConfig = {
    estimator: fixedControl ? 'fixed-4096' : 'builtin',
    privateKeyFile,
    publicKeyFile,
    mockPort,
    routes: seeded.inventory,
    affinityKey: randomBytes(32).toString('base64'),
    idempotencyKey: randomBytes(32).toString('base64'),
  };
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const gatewayPort = await freePort();
  const origin = `http://127.0.0.1:${gatewayPort}`;
  const childEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    TZ: 'UTC',
    ...kmsEnv,
    MODEL_ROUTER_DEPLOYMENT_MODE: 'managed-saas',
    MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway',
    MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: urls[2],
    ...(fixedControl ? { MODEL_ROUTER_SAAS_DB_POOL_MAX: '8' } : {}),
    MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL: checkedRedisUrl(),
    MODEL_ROUTER_FAST_GATEWAY: 'reserved-max',
    MODEL_ROUTER_FAST_NAMESPACE: namespace,
    MODEL_ROUTER_FAST_OWNER: namespace,
    ...(fixedControl || pressure ? { MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS: '1000000' } : {}),
    MODEL_ROUTER_FAST_REDIS_DRAINED: '1',
    MODEL_ROUTER_SAAS_DEPLOYMENT_ID: 'r9-current-test',
    MODEL_ROUTER_SAAS_ENVIRONMENT_ID: 'test',
    MODEL_ROUTER_SAAS_GATEWAY_BIND_ADDRESS: '127.0.0.1',
    MODEL_ROUTER_SAAS_GATEWAY_PORT: String(gatewayPort),
    MODEL_ROUTER_SAAS_GATEWAY_ORIGIN: origin,
    MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE: resolve('tests/saas/gateway/fast/native-http-runtime-fixture.ts'),
    SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: resolve(
      'src/saas/runtime/software-provider-credential-kms.ts',
    ),
    MODEL_ROUTER_SAAS_PROVIDER_EGRESS_ALLOWLIST: '127.0.0.1/32',
    NODE_EXTRA_CA_CERTS: certificateFile,
    NATIVE_FAST_HTTP_CONFIG: configFile,
  };
  if (scenario === 'builtin-default') {
    for (const name of [
      'MODEL_ROUTER_SAAS_DB_POOL_MAX',
      'MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS',
      'MODEL_ROUTER_FAST_CREDIT_STRIPES',
      'MODEL_ROUTER_FAST_CONNECTION_REUSE',
    ]) {
      assert.equal(Object.hasOwn(childEnvironment, name), false, `${name} must be omitted, not set to a tuned value`);
    }
  }
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'start', '--role', 'gateway'], {
    cwd: process.cwd(),
    env: childEnvironment,
    // Never publish gateway logs, config, private keys, or environment as CI artifacts.
    stdio: 'ignore',
  });
  t.after(() => stop(child));
  let childError = false;
  child.once('error', () => {
    childError = true;
  });
  let ready = false;
  const readinessDeadline = Date.now() + 60_000;
  while (Date.now() < readinessDeadline) {
    assert.equal(childError, false, 'gateway launch failed');
    assert.equal(child.exitCode, null, 'gateway exited before readiness');
    try {
      const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, 'actual native gateway must become ready');

  const request = (stream: boolean) =>
    fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${seeded.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: route.publicModel,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 64,
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  const assertSuccess = async (response: Response, stream: boolean) => {
    const body = await response.text();
    assert.equal(response.status, 200, 'FIRST funded attempt and every serial request must succeed; no cold 429 retry');
    assert.equal(response.headers.get('x-model-router-execution-mode'), 'fast-reserved-max');
    assert.equal(response.headers.get('x-model-router-fast-fallback'), null);
    if (stream) {
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      const events = body
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6));
      assert.equal(events.at(-1), '[DONE]');
      assert.equal(events.filter((event) => event === '[DONE]').length, 1);
      const payloads = events.slice(0, -1).map((event) => JSON.parse(event));
      assert.equal(payloads.length, 3);
      assert.equal(payloads[0]?.choices[0]?.delta.content, 'Hello.');
      assert.deepEqual(payloads[2]?.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    } else {
      const payload = JSON.parse(body);
      assert.equal(payload.choices[0]?.message.content, 'Hello.');
      assert.deepEqual(payload.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    }
  };
  if (pressure) {
    for (const stream of [false, true]) {
      let release = () => {};
      let entered = () => {};
      const reachedUpstream = new Promise<void>((resolve) => {
        entered = resolve;
      });
      nextBarrier = {
        entered,
        released: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      const pending = request(stream);
      void pending.catch(() => {}); // The awaited response below still fails; teardown cannot leak a rejection.
      try {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            reachedUpstream,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('first funded request did not reach actual upstream')), 5_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        const before = (
          await migrator.query<{ backing: string; available: string; intents: string }>(
            `SELECT COALESCE(sum(backing_minor_units),0)::text AS backing,
            COALESCE(sum(available_minor_units),0)::text AS available,
            (SELECT count(*)::text FROM saas_fast_gateway_intents WHERE tenant_id=$1) AS intents
           FROM saas_fast_credit_allocations WHERE tenant_id=$1`,
            [seeded.tenantId],
          )
        ).rows[0];
        assert.ok(before);
        assert.ok(BigInt(before.backing) <= 1_000_000n, 'explicit cap is never auto-raised');
        assert.equal(
          BigInt(before.backing) - BigInt(before.available),
          524480n,
          'one real M remains held during upstream execution',
        );
        const denied = await request(stream);
        assert.equal(denied.status, 429, 'second M cannot fit inside explicit 1m while first is unsettled');
        assert.match(await denied.text(), /FAST_CREDIT_NOT_READY/);
        assert.equal(denied.headers.get('x-model-router-fast-fallback'), null);
        const after = (
          await migrator.query<{ backing: string; intents: string }>(
            `SELECT COALESCE(sum(backing_minor_units),0)::text AS backing,
            (SELECT count(*)::text FROM saas_fast_gateway_intents WHERE tenant_id=$1) AS intents
           FROM saas_fast_credit_allocations WHERE tenant_id=$1`,
            [seeded.tenantId],
          )
        ).rows[0];
        assert.ok(after);
        assert.equal(after.intents, before.intents, 'pressure rejection creates no intent or upstream send');
        assert.ok(BigInt(after.backing) <= 1_000_000n, 'retry pressure does not enlarge the explicit cap');
      } finally {
        release();
      }
      await assertSuccess(await pending, stream);
      // Wait for this legitimate charge to finish before the next independent pressure round.
      const wanted = stream ? '2' : '1';
      const deadline = Date.now() + 15_000;
      let completed = '0';
      while (Date.now() < deadline) {
        completed =
          (
            await migrator.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM saas_fast_billing_jobs j JOIN saas_fast_gateway_intents i ON i.id=j.intent_id
           WHERE i.tenant_id=$1 AND j.state='completed'`,
              [seeded.tenantId],
            )
          ).rows[0]?.count ?? '0';
        if (completed === wanted) break;
        await delay(50);
      }
      assert.equal(completed, wanted);
    }
  } else {
    for (const stream of [false, true, false, true]) await assertSuccess(await request(stream), stream);
  }
  const bounds = (
    await migrator.query<{ maximum: string; input_bound: string; output_bound: string; estimator: string }>(
      `SELECT DISTINCT max_cost_minor_units::text AS maximum, price_snapshot->>'maxInputTokens' AS input_bound,
      price_snapshot->>'maxOutputTokens' AS output_bound, authority_snapshot->>'estimatorVersion' AS estimator
     FROM saas_fast_gateway_intents WHERE tenant_id=$1`,
      [seeded.tenantId],
    )
  ).rows;
  assert.deepEqual(bounds, [
    {
      maximum,
      input_bound: fixedControl ? '4096' : '262144',
      output_bound: fixedControl ? '4096' : '64',
      estimator: fixedControl ? 'r9-local-mock-upper-bound/v1' : 'builtin-local-text-byte-bound/v2',
    },
  ]);

  const financeSql = `WITH intents AS (SELECT * FROM saas_fast_gateway_intents WHERE tenant_id=$1),
    receipts AS (SELECT r.* FROM saas_fast_gateway_receipts r JOIN intents i ON i.id=r.intent_id),
    jobs AS (SELECT j.* FROM saas_fast_billing_jobs j JOIN intents i ON i.id=j.intent_id),
    allocations AS (SELECT * FROM saas_fast_credit_allocations WHERE tenant_id=$1),
    postings AS (SELECT t.id,t.amount_minor_units,
      COALESCE(SUM(e.amount_minor_units) FILTER (WHERE e.direction='debit'),0) AS debits,
      COALESCE(SUM(e.amount_minor_units) FILTER (WHERE e.direction='credit'),0) AS credits
      FROM saas_ledger_transactions t LEFT JOIN saas_ledger_entries e ON e.transaction_id=t.id
      WHERE t.tenant_id=$1 AND t.idempotency_namespace='fast-journal-v1' GROUP BY t.id,t.amount_minor_units)
    SELECT (SELECT count(*) FROM intents)::text AS intents, (SELECT count(*) FROM receipts)::text AS receipts,
      (SELECT count(*) FROM receipts WHERE outcome='succeeded')::text AS succeeded,
      (SELECT COALESCE(sum(charge_minor_units),0) FROM receipts)::text AS charge,
      (SELECT COALESCE(sum((usage->>'inputTotal')::bigint),0) FROM receipts)::text AS input,
      (SELECT COALESCE(sum((usage->>'outputTotal')::bigint),0) FROM receipts)::text AS output,
      (SELECT count(*) FROM jobs WHERE state='completed')::text AS completed,
      (SELECT count(*) FROM intents i LEFT JOIN jobs j ON j.intent_id=i.id WHERE j.state IS DISTINCT FROM 'completed')::text AS unresolved,
      (SELECT COALESCE(sum(backing_minor_units),0) FROM allocations)::text AS backing,
      (SELECT COALESCE(sum(available_minor_units),0) FROM allocations)::text AS available,
      (SELECT posted_balance_minor_units FROM saas_wallets WHERE tenant_id=$1 AND currency='USD')::text AS wallet,
      (SELECT count(*) FROM postings)::text AS postings, (SELECT COALESCE(sum(amount_minor_units),0) FROM postings)::text AS posted,
      (SELECT count(*) FROM postings WHERE debits<>credits OR debits<>amount_minor_units)::text AS unbalanced,
      (SELECT count(*) FROM saas_requests WHERE tenant_id=$1)::text AS legacy_requests,
      (SELECT count(*) FROM saas_attempts WHERE tenant_id=$1)::text AS legacy_attempts,
      (SELECT count(*) FROM saas_prepared_request_evidence WHERE tenant_id=$1)::text AS legacy_evidence,
      (SELECT count(*) FROM saas_billing_reservations WHERE tenant_id=$1)::text AS legacy_reservations,
      (SELECT count(*) FROM saas_usage_events WHERE tenant_id=$1)::text AS legacy_usage`;
  let facts: Record<string, string> | undefined;
  const drainDeadline = Date.now() + 15_000;
  while (Date.now() < drainDeadline) {
    // Test-only migrator observes double-entry rows; gateway retains its restricted grants.
    facts = (await migrator.query<Record<string, string>>(financeSql, [seeded.tenantId])).rows[0];
    if (facts?.completed === expected.count && facts.unresolved === '0') break;
    await delay(50);
  }
  assert.ok(facts);
  assert.deepEqual(facts, {
    intents: expected.count,
    receipts: expected.count,
    succeeded: expected.count,
    charge: expected.charge,
    input: expected.input,
    output: expected.output,
    completed: expected.count,
    unresolved: '0',
    backing: facts.backing,
    available: facts.backing,
    wallet: expected.wallet,
    postings: expected.count,
    posted: expected.charge,
    unbalanced: '0',
    legacy_requests: '0',
    legacy_attempts: '0',
    legacy_evidence: '0',
    legacy_reservations: '0',
    legacy_usage: '0',
  });
  assert.ok(BigInt(facts.backing) > 0n, 'unused escrow remains durable backing, not a refund or overdraft');
  assert.deepEqual(upstream, { json: pressure ? 1 : 2, sse: pressure ? 1 : 2, invalid: 0 });
  if (pressure)
    assert.ok(BigInt(facts.backing) <= 1_000_000n, 'completed pressure rounds retain the explicit hard cap');
  if (scenario === 'builtin-default') {
    assert.equal(automaticTarget, 67133440n, 'trusted C64 sets exact 2*M*C target');
    assert.equal(
      BigInt(facts.backing) + BigInt(facts.charge),
      automaticTarget,
      'default credit is exact wallet-backed auto capacity, not a fixture cap',
    );
    assert.equal(
      (
        await migrator.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM saas_fast_credit_allocations WHERE tenant_id=$1 AND state='active'",
          [seeded.tenantId],
        )
      ).rows[0]?.count,
      '8',
      'the default stripe count is exercised without an override',
    );
    assert.equal(tlsConnections, 1, 'default pooled transport reuses one real TLS connection for serial JSON/SSE');
  }
  t.diagnostic(
    `${scenario}: first-funded=200 M=${maximum} completed=${expected.count} charge=${expected.charge} unresolved=0 TLS-connections=${tlsConnections}`,
  );
});
