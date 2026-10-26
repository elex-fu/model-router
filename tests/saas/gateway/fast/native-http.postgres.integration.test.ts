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
test('required native fast HTTP: cold paid JSON and SSE reach exact durable financial drain', {
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
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'start', '--role', 'gateway'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'test',
      TZ: 'UTC',
      ...kmsEnv,
      MODEL_ROUTER_DEPLOYMENT_MODE: 'managed-saas',
      MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway',
      MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: urls[2],
      MODEL_ROUTER_SAAS_DB_POOL_MAX: '8',
      MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL: checkedRedisUrl(),
      MODEL_ROUTER_FAST_GATEWAY: 'reserved-max',
      MODEL_ROUTER_FAST_NAMESPACE: namespace,
      MODEL_ROUTER_FAST_OWNER: namespace,
      MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS: '1000000',
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
    },
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

  let coldCreditDenials = 0;
  for (const stream of [false, true, false, true]) {
    let succeeded = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const response = await fetch(`${origin}/v1/chat/completions`, {
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
      const body = await response.text();
      if (response.status === 429 && body.includes('FAST_CREDIT_UNAVAILABLE')) {
        coldCreditDenials++;
        await delay(50);
        continue;
      }
      assert.equal(response.status, 200, 'native request must succeed; no non-credit error retry is allowed');
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
      succeeded = true;
      break;
    }
    assert.ok(succeeded, 'cold credit must become available without falling back to strict mode');
  }

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
    if (facts?.completed === '4' && facts.unresolved === '0') break;
    await delay(50);
  }
  assert.ok(facts);
  assert.deepEqual(facts, {
    intents: '4',
    receipts: '4',
    succeeded: '4',
    charge: '140',
    input: '40',
    output: '20',
    completed: '4',
    unresolved: '0',
    backing: facts.backing,
    available: facts.backing,
    wallet: '99999999860',
    postings: '4',
    posted: '140',
    unbalanced: '0',
    legacy_requests: '0',
    legacy_attempts: '0',
    legacy_evidence: '0',
    legacy_reservations: '0',
    legacy_usage: '0',
  });
  assert.ok(BigInt(facts.backing) > 0n, 'unused escrow remains durable backing, not a refund or overdraft');
  assert.deepEqual(upstream, { json: 2, sse: 2, invalid: 0 });
  t.diagnostic(`native paid JSON=2 SSE=2 completed=4 charge=140 unresolved=0 cold-credit-denials=${coldCreditDenials}`);
});
