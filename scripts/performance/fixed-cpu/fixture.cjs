'use strict';
// Disposable, offline, fake-money fixture only. Never accepts an external endpoint.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID, generateKeyPairSync, createHash } = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const directory = '/fixture'; // Container mount, NOT a host-specific path.
const root = path.resolve(__dirname, '../../..');
const production = name => require(path.join(root, 'dist', name));
const save = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

function validateInput(input) {
  assert.ok(['single', 'bounded'].includes(input.arm));
  assert.ok([64, 256].includes(input.httpInFlight));
  assert.equal(input.creditCap, String(2 * 524480 * input.httpInFlight));
  for (const key of ['pgPort', 'redisPort', 'mockPort', 'appPort'])
    assert.ok(Number.isInteger(input[key]) && input[key] > 1024 && input[key] < 65536);
  assert.equal(new Set(['pgPort', 'redisPort', 'mockPort', 'appPort'].map(key => input[key])).size, 4);
}
function databaseUrl(input, role) {
  return `postgresql://${role}@127.0.0.1:${input.pgPort}/model_router_quota`;
}
async function seed(input) {
  const { createSaasDatabase } = production('saas/db/index.js');
  const database = createSaasDatabase({ connectionString: databaseUrl(input, 'model_router_saas_migrator'), max: 2 });
  const kms = { MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY: randomBytes(32).toString('hex'), MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID: 'r9-local-test' };
  try {
    assert.equal((await database.query('SELECT count(*)::text AS count FROM saas_api_keys')).rows[0].count, '0');
    const seeded = await require('./seed.cjs').seedNativeFastHttpInventory(database, kms, input.httpInFlight);
    const keys = generateKeyPairSync('ed25519');
    await fs.writeFile(`${directory}/signing-private.pem`, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await fs.writeFile(`${directory}/signing-public.pem`, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const namespace = `quota-${randomUUID()}`;
    const deploymentId = 'r9-current-test'; // Matches the original native fixture's sealed credentials.
    if (input.arm === 'single') {
      const { registerBoundedDeployment, ensureBoundedCreditBudget } = production('saas/gateway/fast/bounded-deployment-budget.js');
      const { saasAdvisoryKey, WALLET_FENCE_SQL } = production('saas/db/advisory-lock-keys.js');
      const spec = { deploymentId, policyDigest: digest({ contract: 'fixed-cpu-single-control/v1', http: input.httpInFlight, cap: input.creditCap }), creditCapMinorUnits: input.creditCap };
      await registerBoundedDeployment(database, spec);
      await database.transaction(async tx => {
        await tx.query(WALLET_FENCE_SQL, [saasAdvisoryKey.walletFence(seeded.tenantId, 'USD')]);
        assert.equal(await ensureBoundedCreditBudget(tx, spec, seeded.tenantId, 'USD'), BigInt(input.creditCap));
      });
    }
    await save('runtime.json', { estimator: 'builtin', maxConcurrency: input.httpInFlight, privateKeyFile: `${directory}/signing-private.pem`, publicKeyFile: `${directory}/signing-public.pem`, mockPort: input.mockPort, routes: seeded.inventory, affinityKey: randomBytes(32).toString('base64'), idempotencyKey: randomBytes(32).toString('base64') });
    await fs.writeFile(`${directory}/api-key`, seeded.key, { mode: 0o600 });
    await save('identity.json', { tenantId: seeded.tenantId, projectId: seeded.projectId, keyId: seeded.keyId, namespace });
    const env = {
      ...kms, NODE_ENV: 'production', MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT: 'true',
      MODEL_ROUTER_DEPLOYMENT_MODE: 'managed-saas', MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway', MODEL_ROUTER_SAAS_DEPLOYMENT_ID: deploymentId,
      MODEL_ROUTER_SAAS_ENVIRONMENT_ID: 'test', MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: databaseUrl(input, 'model_router_saas_gateway'),
      MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL: `redis://127.0.0.1:${input.redisPort}`,
      MODEL_ROUTER_SAAS_DB_POOL_MAX: '16', MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT: String(input.httpInFlight),
      MODEL_ROUTER_FAST_GATEWAY: 'reserved-max', MODEL_ROUTER_FAST_NAMESPACE: namespace, MODEL_ROUTER_FAST_OWNER: namespace,
      MODEL_ROUTER_FAST_CREDIT_STRIPES: '8', MODEL_ROUTER_FAST_RECEIPT_MODE: 'memory-queue',
      MODEL_ROUTER_FAST_RECEIPT_MAX_ENTRIES: '256', MODEL_ROUTER_FAST_RECEIPT_MAX_BYTES: '2097152',
      MODEL_ROUTER_FAST_RECEIPT_MAX_PER_TENANT: '64', MODEL_ROUTER_FAST_RECEIPT_WORKERS: '8',
      MODEL_ROUTER_FAST_RECEIPT_MAX_AGE_MS: '5000', MODEL_ROUTER_FAST_RECEIPT_DRAIN_TIMEOUT_MS: '10000',
      MODEL_ROUTER_FAST_CONNECTION_REUSE: '1',
      MODEL_ROUTER_SAAS_GATEWAY_BIND_ADDRESS: '127.0.0.1', MODEL_ROUTER_SAAS_GATEWAY_PORT: String(input.appPort),
      MODEL_ROUTER_SAAS_GATEWAY_ORIGIN: `http://127.0.0.1:${input.appPort}`,
      MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE: path.join(__dirname, 'runtime-observed.cjs'),
      SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: path.join(root, 'dist/saas/runtime/software-provider-credential-kms.js'),
      MODEL_ROUTER_SAAS_PROVIDER_EGRESS_ALLOWLIST: '127.0.0.1/32', NODE_EXTRA_CA_CERTS: `${directory}/certificate.pem`,
      NATIVE_FAST_HTTP_CONFIG: `${directory}/runtime.json`,
    };
    // Deliberately no REDIS_DRAINED bypass, preload, observer or fixed estimator.
    await fs.writeFile(`${directory}/app.env`, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
    await fs.mkdir(`${directory}/state`, { mode: 0o700 });
  } finally { await database.close(); }
}

const FINANCE_SQL = `WITH intents AS (SELECT * FROM saas_fast_gateway_intents WHERE tenant_id=$1),
 receipts AS (SELECT r.* FROM saas_fast_gateway_receipts r JOIN intents i ON i.id=r.intent_id),
 jobs AS (SELECT j.* FROM saas_fast_billing_jobs j JOIN intents i ON i.id=j.intent_id),
 allocations AS (SELECT * FROM saas_fast_credit_allocations WHERE tenant_id=$1),
 releases AS (SELECT l.* FROM saas_fast_receipt_liability_releases l JOIN intents i ON i.id=l.intent_id),
 postings AS (SELECT t.id,t.amount_minor_units,
 COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction='debit'),0) AS debits,
 COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction='credit'),0) AS credits
 FROM saas_ledger_transactions t LEFT JOIN saas_ledger_entries e ON e.transaction_id=t.id
 WHERE t.tenant_id=$1 AND t.idempotency_namespace='fast-journal-v1' GROUP BY t.id,t.amount_minor_units)
 SELECT (SELECT count(*) FROM intents)::text AS intents,
 (SELECT count(*) FROM receipts)::text AS receipts,
 (SELECT count(*) FROM receipts WHERE outcome='succeeded')::text AS succeeded,
 (SELECT COALESCE(sum(charge_minor_units),0) FROM receipts)::text AS charge,
 (SELECT COALESCE(sum((usage->>'inputTotal')::bigint),0) FROM receipts)::text AS input,
 (SELECT COALESCE(sum((usage->>'outputTotal')::bigint),0) FROM receipts)::text AS output,
 (SELECT count(*) FROM jobs WHERE state='completed')::text AS completed,
 (SELECT count(*) FROM intents i LEFT JOIN jobs j ON j.intent_id=i.id WHERE j.state IS DISTINCT FROM 'completed')::text AS unresolved,
 (SELECT COALESCE(sum(backing_minor_units),0) FROM allocations)::text AS backing,
 (SELECT COALESCE(sum(available_minor_units),0) FROM allocations)::text AS available,
 (SELECT count(*) FROM allocations WHERE state<>'retired')::text AS active_allocations,
 (SELECT count(DISTINCT owner) FROM allocations)::text AS business_owners,
 (SELECT posted_balance_minor_units FROM saas_wallets WHERE tenant_id=$1 AND currency='USD')::text AS wallet,
 (SELECT count(*) FROM postings)::text AS postings,
 (SELECT COALESCE(sum(amount_minor_units),0) FROM postings)::text AS posted,
 (SELECT count(*) FROM postings WHERE debits<>credits OR debits<>amount_minor_units)::text AS unbalanced,
 (SELECT count(*) FROM releases)::text AS releases,
 (SELECT COALESCE(sum(released_minor_units),0) FROM releases)::text AS released,
 (SELECT count(*) FROM releases l JOIN intents i ON i.id=l.intent_id JOIN receipts r ON r.intent_id=i.id
 WHERE l.protocol_version<>2 OR l.tenant_id<>i.tenant_id OR l.request_id<>i.request_id OR l.allocation_id<>i.allocation_id
 OR l.allocation_epoch<>i.allocation_epoch OR l.currency<>i.currency OR l.receipt_digest<>r.receipt_digest
 OR l.released_minor_units+l.retained_minor_units<>i.max_cost_minor_units OR l.retained_minor_units<>r.charge_minor_units
 OR r.outcome<>'succeeded' OR r.http_status NOT BETWEEN 200 AND 299)::text AS invalid_releases,
 (SELECT count(*) FROM intents WHERE max_cost_minor_units<>524480 OR price_snapshot->>'maxInputTokens' IS DISTINCT FROM '262144'
 OR price_snapshot->>'maxOutputTokens' IS DISTINCT FROM '64' OR authority_snapshot->>'estimatorVersion' IS DISTINCT FROM 'builtin-local-text-byte-bound/v2')::text AS invalid_bounds,
 (SELECT credit_cap_minor_units::text FROM saas_fast_gateway_credit_budgets WHERE tenant_id=$1 AND currency='USD') AS cap,
 (SELECT allocated_minor_units::text FROM saas_fast_gateway_credit_budgets WHERE tenant_id=$1 AND currency='USD') AS allocated,
 (SELECT count(*) FROM saas_fast_gateway_owner_slots WHERE active)::text AS active_slots,
 (SELECT count(*) FROM saas_requests WHERE tenant_id=$1)::text AS legacy_requests,
 (SELECT count(*) FROM saas_attempts WHERE tenant_id=$1)::text AS legacy_attempts,
 (SELECT count(*) FROM saas_prepared_request_evidence WHERE tenant_id=$1)::text AS legacy_evidence,
 (SELECT count(*) FROM saas_billing_reservations WHERE tenant_id=$1)::text AS legacy_reservations,
 (SELECT count(*) FROM saas_usage_events WHERE tenant_id=$1)::text AS legacy_usage,
 (SELECT count(*) FROM pg_stat_activity WHERE usename='model_router_saas_gateway' AND datname=current_database())::text AS gateway_sessions,
 (SELECT rolconnlimit::text FROM pg_roles WHERE rolname='model_router_saas_gateway') AS gateway_role_limit`;

function validateFinance(facts, count, input, stopped) {
  assert.ok(Number.isSafeInteger(count) && count > 0);
  for (const key of ['intents', 'receipts', 'succeeded', 'completed', 'postings', 'releases']) assert.equal(facts[key], String(count), key);
  for (const key of ['unresolved', 'unbalanced', 'invalid_releases', 'invalid_bounds', 'legacy_requests', 'legacy_attempts', 'legacy_evidence', 'legacy_reservations', 'legacy_usage']) assert.equal(facts[key], '0', key);
  for (const [key, multiplier] of [['charge', 35], ['posted', 35], ['input', 10], ['output', 5], ['released', 524480 - 35]]) assert.equal(facts[key], String(count * multiplier), key);
  assert.equal(facts.wallet, String(100000000000n - BigInt(count) * 35n));
  assert.equal(facts.cap, input.creditCap);
  assert.equal(facts.allocated, facts.backing);
  assert.equal(facts.available, facts.backing);
  assert.ok(BigInt(facts.backing) <= BigInt(facts.cap));
  assert.ok(Number(facts.gateway_sessions) <= 16);
  assert.equal(facts.gateway_role_limit, '16');
  assert.equal(facts.business_owners, input.arm === 'single' ? '1' : '2');
  if (stopped) for (const key of ['backing', 'available', 'allocated', 'active_allocations', 'active_slots', 'gateway_sessions']) assert.equal(facts[key], '0', key);
}
async function redisFacts(input, identity, expected) {
  const redis = require('@redis/client').createClient({ url: `redis://127.0.0.1:${input.redisPort}`, socket: { reconnectStrategy: false } });
  redis.on('error', () => {});
  await redis.connect();
  try {
    const prefix = `mr:fast:{${digest([identity.namespace])}}`;
    const leases = await redis.keys(`${prefix}:lease:*`);
    const values = leases.length ? await redis.mGet(leases) : [];
    const buckets = {};
    let invalid = 0;
    for (const value of values) {
      const lease = value && JSON.parse(value);
      if (!lease || lease.state !== 'released' || lease.usageState !== 'settled' || lease.actualTokenUnits !== 15 || lease.tokenUnits !== 262208 || !/^\d+$/.test(lease.bucket)) invalid++;
      if (lease) buckets[lease.bucket] = (buckets[lease.bucket] ?? 0) + 1;
    }
    const slots = await redis.keys(`${prefix}:slots:*`);
    const liveSlots = (await Promise.all(slots.map(key => redis.zCard(key)))).reduce((a, b) => a + b, 0);
    const scopes = [['tenant', identity.tenantId], ['project', identity.tenantId, identity.projectId], ['key', identity.tenantId, identity.projectId, identity.keyId]];
    const clock = await redis.sendCommand(['TIME']);
    const now = Number(clock[0]) * 1000 + Math.floor(Number(clock[1]) / 1000);
    const counters = [];
    for (const scope of scopes) {
      const raw = await redis.get(`${prefix}:rate:${digest(scope)}`);
      const counter = raw ? JSON.parse(raw) : { buckets: {} };
      const current = Object.entries(counter.buckets).filter(([bucket]) => Number(bucket) * 1000 + 1000 > now - 60000);
      const expectedBuckets = Object.entries(buckets).filter(([bucket]) => Number(bucket) * 1000 + 1000 > now - 60000);
      let exact = JSON.stringify(current.map(([key]) => key).sort()) === JSON.stringify(expectedBuckets.map(([key]) => key).sort());
      for (const [bucket, [requests, tokens]] of current) exact &&= requests === buckets[bucket] && tokens === requests * 15;
      counters.push({ scope: scope[0], buckets: counter.buckets, exactCurrentWindow: exact });
    }
    return { leaseCount: leases.length, expected, invalidLeases: invalid, liveSlots, leaseBuckets: buckets, nowMs: now, counters,
      exact: leases.length === expected && invalid === 0 && liveSlots === 0 && counters.every(c => c.exactCurrentWindow) };
  } finally { redis.destroy(); }
}
async function audit(input, stopped, warmOnly = false) {
  const identity = JSON.parse(await fs.readFile(`${directory}/identity.json`, 'utf8'));
  const warm = JSON.parse(await fs.readFile(`${directory}/warm.json`, 'utf8'));
  const measured = warmOnly ? { success: 0, requests: 0 } : JSON.parse(await fs.readFile(`${directory}/measured.json`, 'utf8'));
  const count = warm.success + measured.success;
  const { createSaasDatabase } = production('saas/db/index.js');
  const database = createSaasDatabase({ connectionString: databaseUrl(input, 'model_router_saas_migrator'), max: 1 });
  let facts, usage;
  try {
    const deadline = Date.now() + 45000;
    do {
      facts = (await database.query(FINANCE_SQL, [identity.tenantId])).rows[0];
      usage = await redisFacts(input, identity, count);
      if (facts.completed === facts.intents && facts.unresolved === '0' && usage.exact) break;
      await delay(100);
    } while (Date.now() < deadline);
    const rateLimits = (await database.query(`
      SELECT 'tenant' AS scope,requests_per_minute::text AS rpm,tokens_per_minute::text AS tpm,max_concurrent_requests::text AS concurrency FROM saas_tenants WHERE id=$1
      UNION ALL SELECT 'project',v.requests_per_minute::text,v.tokens_per_minute::text,v.max_concurrent_requests::text
        FROM saas_projects p JOIN saas_project_inference_policy_versions v ON v.tenant_id=p.tenant_id AND v.project_id=p.id AND v.version=p.inference_policy_version WHERE p.tenant_id=$1 AND p.id=$2
      UNION ALL SELECT 'key',requests_per_minute::text,tokens_per_minute::text,max_concurrent_requests::text FROM saas_api_keys WHERE tenant_id=$1 AND project_id=$2 AND id=$3 ORDER BY scope`,
      [identity.tenantId, identity.projectId, identity.keyId])).rows;
    // Save evidence BEFORE assertions; a rejection/failure is never silently excluded.
    await save(warmOnly ? 'warm-audit.json' : stopped ? 'stopped-audit.json' : 'drain-audit.json', { finance: facts, usage, rateLimits, allAttemptCount: warm.requests + measured.requests, successCount: count, stopped });
    validateFinance(facts, count, input, stopped);
    assert.deepEqual(rateLimits, ['key', 'project', 'tenant'].map(scope => ({ scope, rpm: '600000', tpm: '600000000', concurrency: String(input.httpInFlight) })), 'all declared authority rate/concurrency limits remain unchanged');
    assert.equal(usage.exact, true, 'actual TPM acknowledgement and slot drain');
  } finally { await database.close(); }
}
async function main() {
  const input = JSON.parse(await fs.readFile(`${directory}/input.json`, 'utf8'));
  validateInput(input);
  if (process.argv[2] === 'seed') return seed(input);
  if (process.argv[2] === 'state-closed') return require('./process-proof.cjs').closed(input);
  assert.ok(['warm', 'drain', 'stopped'].includes(process.argv[2]));
  return audit(input, process.argv[2] === 'stopped', process.argv[2] === 'warm');
}
module.exports = { validateInput, validateFinance, FINANCE_SQL };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
