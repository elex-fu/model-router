import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Socket } from 'node:net';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../src/saas/db/index.js';
import type { SaasDatabase } from '../../src/saas/db/types.js';
import { getPaymentControl, ReadonlyPaymentBindingResolver, registerPaymentBindings, setPaymentControl } from '../../src/saas/payments/merchant-binding.js';
import { PaymentFulfillmentService } from '../../src/saas/payments/service.js';
import type { PaymentProviderRefundInput, NormalizedPaymentProviderEvent } from '../../src/saas/payments/types.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls } from '../saas/metering/normal-success-postgres-fixture.js';
import { crashRefundBinding, type CrashRefundInputs } from './helpers/payment-worker-sigkill-child.js';

// Real PG15/18, restricted production CP service and worker, real process signals.
// The loopback PSP is synthetic: this proves no real Alipay merchant contract.
// The caller owns creation/drop of the dedicated disposable database; this
// test closes its pools/children/listener and restores control without deleting
// or rewriting original financial facts.
const CHILD = 'tests/drills/helpers/payment-worker-sigkill-child.ts';
interface Exit { code: number | null; signal: NodeJS.Signals | null }
interface OwnedChild { child: ChildProcess; exit: Promise<Exit>; messages: Array<Record<string, unknown>> }
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(label);
    await new Promise(resolvePoll => setTimeout(resolvePoll, 25));
  }
}
function launch(mode: string, cpUrl: string, inputPath: string): OwnedChild {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, '--child', mode, inputPath], { cwd: resolve(process.cwd()), detached: true, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', MODEL_ROUTER_PAYMENT_CRASH_CP_URL: cpUrl }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr?.resume();
  const messages: Array<Record<string, unknown>> = [];
  child.on('message', message => { if (message && typeof message === 'object') messages.push(message as Record<string, unknown>); });
  const exit = new Promise<Exit>((resolveExit, reject) => { child.once('error', () => reject(new Error('Owned drill child could not start'))); child.once('exit', (code, signal) => resolveExit({ code, signal })); });
  void exit.catch(() => {});
  return { child, exit, messages };
}
function signalOwned(owned: OwnedChild, signal: NodeJS.Signals): void {
  if (owned.child.exitCode !== null || owned.child.signalCode !== null || !owned.child.pid) return;
  try { process.kill(-owned.child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
async function stopOwned(owned: OwnedChild): Promise<void> {
  signalOwned(owned, 'SIGTERM');
  try { await within(owned.exit, 2000, 'Owned child graceful cleanup deadline'); }
  catch { signalOwned(owned, 'SIGKILL'); await within(owned.exit, 5000, 'Owned child forced cleanup deadline'); }
}

async function snapshot(database: SaasDatabase, tenantId: string) {
  const financial = (await database.query<Record<string, string>>(`SELECT
    (SELECT COALESCE(sum(posted_balance_minor_units),0)::text FROM saas_wallets WHERE tenant_id=$1) AS balance,
    (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id=$1 AND source_type='wallet_funding') AS funding,
    (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id=$1 AND source_type='wallet_refund') AS refunds,
    (SELECT count(*)::text FROM saas_refund_wallet_freezes WHERE tenant_id=$1) AS freezes,
    (SELECT COALESCE(sum(amount_minor_units),0)::text FROM saas_refund_wallet_freezes WHERE tenant_id=$1) AS frozen,
    (SELECT count(*)::text FROM saas_billing_reservations WHERE tenant_id=$1) AS holds,
    (SELECT count(*)::text FROM saas_attempts WHERE tenant_id=$1) AS attempts,
    (SELECT count(*)::text FROM (SELECT l.id FROM saas_ledger_transactions l LEFT JOIN saas_ledger_entries e ON e.transaction_id=l.id WHERE l.tenant_id=$1 GROUP BY l.id,l.amount_minor_units HAVING count(e.id)<>2 OR COALESCE(sum(e.amount_minor_units) FILTER(WHERE e.direction='credit'),0)<>l.amount_minor_units OR COALESCE(sum(e.amount_minor_units) FILTER(WHERE e.direction='debit'),0)<>l.amount_minor_units) invalid) AS unbalanced,
    (SELECT COALESCE(sum(CASE WHEN direction='credit' THEN amount_minor_units ELSE -amount_minor_units END),0)::text FROM saas_ledger_entries WHERE tenant_id=$1 AND wallet_id IS NOT NULL) AS ledger_balance`, [tenantId])).rows[0]!;
  const refunds = (await database.query(`SELECT id,binding_id,original_local_order_ref,provider_order_id,merchant_id,amount_minor_units::text,currency,state,provider_attempts,provider_refund_id,wallet_refund_transaction_id,lease_action,lease_token,lease_expires_at FROM saas_refund_orders WHERE tenant_id=$1 ORDER BY id`, [tenantId])).rows;
  const inbox = (await database.query(`SELECT id,binding_id,processing_state,processing_outcome,lease_token,lease_expires_at FROM saas_payment_inbox WHERE tenant_id=$1 ORDER BY id`, [tenantId])).rows;
  return { financial, refunds, inbox };
}

test('P10 PG15/18: submit service SIGKILL after durable PSP acceptance, then refund worker SIGKILL during query recovers original refund once', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured ? `set ${REQUIRED_FLAG}=1 and three isolated disposable PG15/18 role URLs` : false,
  timeout: 180000, concurrency: false,
}, async t => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 4 });
  const cp = createSaasDatabase({ connectionString: urls[1], max: 4 });
  const scratch = mkdtempSync(join(tmpdir(), 'payment-worker-sigkill-'));
  const journal = join(scratch, 'synthetic-psp.jsonl');
  const inputPath = join(scratch, 'inputs.json');
  const children: OwnedChild[] = [];
  const sockets = new Set<Socket>();
  let restoreControl: (() => Promise<void>) | undefined;
  const accepted = new Map<string, PaymentProviderRefundInput>();
  let submitCalls = 0, queryCalls = 0;
  let heldSubmit: ServerResponse | undefined, heldQuery: ServerResponse | undefined;
  let expected: CrashRefundInputs | undefined;
  const server = createServer((req, res) => { void (async () => {
    if (req.method !== 'POST' || !['/submit', '/query'].includes(req.url ?? '')) { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const raw of req) { const chunk = Buffer.from(raw); size += chunk.length; if (size > 8192) throw new Error('Oversized synthetic PSP request'); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PaymentProviderRefundInput;
    assert.ok(expected);
    assert.equal(input.idempotencyReference, input.localRefundId);
    assert.equal(input.tenantId, expected.tenantId);
    assert.equal(input.originalLocalOrderId, expected.orderId);
    assert.equal(input.providerOrderId, expected.orderId);
    assert.equal(input.merchantId, expected.binding.merchantId);
    assert.equal(input.providerKey, 'alipay'); assert.equal(input.amountMinorUnits, '125'); assert.equal(input.currency, 'CNY');
    const persist = (kind: string) => {
      const fd = openSync(journal, 'a', 0o600);
      try { writeSync(fd, `${JSON.stringify({ kind, bindingId: expected!.binding.id, input })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    };
    if (req.url === '/submit') {
      const previous = accepted.get(input.localRefundId);
      if (previous) assert.deepEqual(input, previous, 'same PSP id with different payload must be rejected');
      submitCalls++; persist('submit-call');
      if (!accepted.has(input.localRefundId)) { persist('accepted'); accepted.set(input.localRefundId, input); }
      heldSubmit = res; // Durable acceptance, intentionally no submit ACK.
      return;
    }
    queryCalls++; persist('query-call');
    const stored = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string; bindingId: string; input: PaymentProviderRefundInput });
    const originalFact = stored.find(fact => fact.kind === 'accepted' && fact.input.localRefundId === input.localRefundId);
    assert.equal(originalFact?.bindingId, expected.binding.id);
    const original = originalFact?.input;
    assert.ok(original, 'query must address the original durable PSP acceptance');
    assert.deepEqual({ ...input, providerRefundId: null }, original);
    if (queryCalls === 1) { heldQuery = res; return; } // Real worker dies while this query lease is in flight.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...input, providerRefundId: `synthetic-${input.localRefundId}`, status: 'succeeded' }));
  })().catch(() => { res.writeHead(500).end(); }); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => {
    try {
      await Promise.allSettled(children.map(stopOwned));
      for (const socket of sockets) socket.destroy();
      await within(new Promise<void>(resolveClose => server.close(() => resolveClose())), 5000, 'PSP listener cleanup deadline');
      await restoreControl?.();
    } finally {
      await within(Promise.allSettled([cp.close(), migrator.close()]), 10000, 'Database cleanup deadline');
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  await cp.verifySchema();
  await verifySaasRuntimeDatabasePrivileges(cp, 'control_plane');
  const version = (await migrator.query<{ version: string }>(`SELECT current_setting('server_version_num') AS version`)).rows[0]!.version;
  const postgresMajor = Math.floor(Number(version) / 10000);
  assert.ok([15, 18].includes(postgresMajor), 'this isolated drill requires real PG15 or PG18');
  await within(new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); }), 5000, 'PSP listen deadline');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const tenantId = randomUUID(), actorId = randomUUID(), sessionId = randomUUID(), credentialId = randomUUID(), namespace = randomUUID();
  await migrator.transaction(async tx => {
    await tx.query('INSERT INTO saas_users(id,email) VALUES($1,$2)', [actorId, `crash-${namespace}@example.test`]);
    await tx.query('INSERT INTO saas_tenants(id,name,slug) VALUES($1,$2,$2)', [tenantId, `crash-${namespace}`]);
    await tx.query("INSERT INTO saas_memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')", [tenantId, actorId]);
    await tx.query("INSERT INTO saas_platform_role_assignments(user_id,role) VALUES($1,'finance'),($1,'operations')", [actorId]);
    await tx.query("INSERT INTO saas_mfa_credentials(id,user_id,kind,encrypted_secret,verified_at) VALUES($1,$2,'totp',decode('7b7d','hex'),clock_timestamp())", [credentialId, actorId]);
    await tx.query("INSERT INTO saas_platform_sessions(id,user_id,credential_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')", [sessionId, actorId, credentialId, createHash('sha256').update(namespace).digest('hex'), 'c'.repeat(64)]);
  });
  const binding = { id: `crash-${namespace}`, providerKey: 'alipay' as const, merchantId: `synthetic-app-${namespace}`, sellerId: `synthetic-seller-${namespace}`, currency: 'CNY' as const, descriptorDigest: createHash('sha256').update(namespace).digest('hex') };
  const endpoint = `http://127.0.0.1:${address.port}`;
  const resolver = new ReadonlyPaymentBindingResolver([crashRefundBinding({ binding, endpoint })]);
  await registerPaymentBindings(cp, resolver);
  const initial = await getPaymentControl(cp);
  assert.equal(initial.mode, 'disabled', 'use a fresh isolated DB; do not share global payment control with another drill');
  const actor = { actorId, sessionId, actorRoles: ['finance', 'operations'] };
  restoreControl = async () => { const control = await getPaymentControl(cp); await setPaymentControl(cp, resolver, { ...actor, expectedRevision: control.revision, mode: initial.mode, activeBindingId: initial.activeBindingId }); };
  await setPaymentControl(cp, resolver, { ...actor, expectedRevision: initial.revision, mode: 'enabled', activeBindingId: binding.id });
  const payments = new PaymentFulfillmentService(cp, resolver, {});
  const order = await payments.createWalletTopUp({ tenantId, clientRequestId: `fund-${namespace}`, amountMinorUnits: '125', currency: 'CNY' });
  const event: NormalizedPaymentProviderEvent = { providerEventId: `funded-${namespace}`, eventType: 'trade.success', providerOrderId: order.id, tenantId, merchantId: binding.merchantId, status: 'succeeded', amountMinorUnits: '125', currency: 'CNY', occurredAt: new Date().toISOString() };
  await payments.handleWebhook({}, Buffer.from(JSON.stringify(event)), binding.id);
  await payments.processPendingWebhooks();
  assert.equal((await payments.getWalletTopUp({ tenantId, orderId: order.id }))?.status, 'fulfilled');
  const funded = await snapshot(migrator, tenantId);
  assert.deepEqual(funded.financial, { balance: '125', funding: '1', refunds: '0', freezes: '0', frozen: '0', holds: '0', attempts: '0', unbalanced: '0', ledger_balance: '125' });
  assert.equal(funded.inbox.length, 1); assert.equal(funded.refunds.length, 0);
  expected = { binding, endpoint, tenantId, orderId: order.id, actorId, sessionId, clientRequestId: `refund-${namespace}` };
  writeFileSync(inputPath, JSON.stringify(expected), { mode: 0o600 });
  const submitChild = launch('submit', urls[1], inputPath); children.push(submitChild);
  await until(async () => accepted.size === 1 && heldSubmit !== undefined, 'PSP did not durably accept the original refund');
  const submitted = await snapshot(migrator, tenantId);
  assert.equal(submitted.refunds.length, 1);
  const submittedRefund = submitted.refunds[0] as Record<string, unknown>;
  const refundId = String(submittedRefund.id);
  assert.equal(submittedRefund.state, 'submitting'); assert.equal(submittedRefund.lease_action, 'submit');
  assert.equal(Number(submittedRefund.provider_attempts), 1); assert.equal(submittedRefund.provider_refund_id, null);
  assert.equal(submittedRefund.binding_id, binding.id); assert.equal(submittedRefund.original_local_order_ref, order.id);
  assert.equal(submittedRefund.amount_minor_units, '125'); assert.ok(submittedRefund.lease_token); assert.ok(submittedRefund.lease_expires_at);
  assert.equal(accepted.has(refundId), true); assert.equal(submitCalls, 1);
  assert.equal(submitted.financial.balance, '125'); assert.equal(submitted.financial.refunds, '0'); assert.equal(submitted.financial.frozen, '125'); assert.equal(submitted.financial.freezes, '1');
  assert.deepEqual(submitted.inbox, funded.inbox);
  signalOwned(submitChild, 'SIGKILL');
  const submitExit = await within(submitChild.exit, 5000, 'Submit child SIGKILL deadline');
  assert.equal(submitExit.signal, 'SIGKILL');
  assert.ok(submitChild.messages.some(message => message.kind === 'ready' && message.mode === 'submit'));
  const killedSubmit = await snapshot(migrator, tenantId);
  assert.deepEqual(killedSubmit, submitted, 'process death does not rewrite the original durable financial facts');
  expected = { ...expected, refundId }; writeFileSync(inputPath, JSON.stringify(expected), { mode: 0o600 });
  const firstWorker = launch('worker', urls[1], inputPath); children.push(firstWorker);
  await until(async () => queryCalls === 1 && heldQuery !== undefined, 'Recovery worker did not query after natural submit lease expiry');
  const querying = await snapshot(migrator, tenantId);
  const queryRefund = querying.refunds[0] as Record<string, unknown>;
  assert.equal(queryRefund.id, refundId); assert.equal(queryRefund.state, 'unknown'); assert.equal(queryRefund.lease_action, 'query');
  assert.notEqual(queryRefund.lease_token, submittedRefund.lease_token); assert.equal(Number(queryRefund.provider_attempts), 1);
  assert.deepEqual(querying.financial, submitted.financial); assert.deepEqual(querying.inbox, funded.inbox);
  signalOwned(firstWorker, 'SIGKILL');
  const workerExit = await within(firstWorker.exit, 5000, 'Query worker SIGKILL deadline'); assert.equal(workerExit.signal, 'SIGKILL');
  assert.ok(firstWorker.messages.some(message => message.kind === 'ready' && message.mode === 'worker'));
  assert.deepEqual(await snapshot(migrator, tenantId), querying);
  const recoveredWorker = launch('worker', urls[1], inputPath); children.push(recoveredWorker);
  const recoveredExit = await within(recoveredWorker.exit, 30000, 'Recovery worker terminal deadline'); assert.deepEqual(recoveredExit, { code: 0, signal: null });
  assert.ok(recoveredWorker.messages.some(message => message.kind === 'terminal' && message.refundId === refundId && message.status === 'succeeded'));
  const completed = await snapshot(migrator, tenantId);
  const finalRefund = completed.refunds[0] as Record<string, unknown>;
  assert.equal(finalRefund.id, refundId); assert.equal(finalRefund.binding_id, binding.id); assert.equal(finalRefund.original_local_order_ref, order.id);
  assert.equal(finalRefund.state, 'succeeded'); assert.equal(finalRefund.lease_action, null); assert.equal(finalRefund.lease_token, null); assert.equal(finalRefund.lease_expires_at, null);
  assert.equal(Number(finalRefund.provider_attempts), 1); assert.ok(finalRefund.wallet_refund_transaction_id);
  assert.deepEqual(completed.financial, { balance: '0', funding: '1', refunds: '1', freezes: '0', frozen: '0', holds: '0', attempts: '0', unbalanced: '0', ledger_balance: '0' });
  assert.deepEqual(completed.inbox, funded.inbox); assert.equal(completed.refunds.length, 1);
  const replayChild = launch('replay', urls[1], inputPath); children.push(replayChild);
  assert.deepEqual(await within(replayChild.exit, 20000, 'Original refund replay deadline'), { code: 0, signal: null });
  assert.deepEqual(await snapshot(migrator, tenantId), completed);
  const finalWorker = launch('worker', urls[1], inputPath); children.push(finalWorker);
  assert.deepEqual(await within(finalWorker.exit, 20000, 'Terminal worker replay deadline'), { code: 0, signal: null });
  assert.deepEqual(await snapshot(migrator, tenantId), completed);
  const facts = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string; bindingId: string; input: PaymentProviderRefundInput });
  assert.equal(facts.filter(fact => fact.kind === 'accepted').length, 1); assert.equal(submitCalls, 1); assert.equal(queryCalls, 2);
  assert.ok(facts.every(fact => fact.bindingId === binding.id && fact.input.localRefundId === refundId && fact.input.idempotencyReference === refundId));
  const evidence = { boundary: `synthetic-loopback-PSP; real PG${postgresMajor}/restricted CP/SIGKILL; no live Alipay acceptance`, postgresMajor, signals: [submitExit.signal, workerExit.signal], submitCalls, queryCalls, funded, submitted, querying, completed };
  const evidencePath = process.env.MODEL_ROUTER_PAYMENT_CRASH_EVIDENCE_FILE;
  if (evidencePath) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  t.diagnostic(JSON.stringify({ boundary: evidence.boundary, postgresMajor: evidence.postgresMajor, signals: evidence.signals, submitCalls, queryCalls, refundTransactions: completed.financial.refunds }));
});
