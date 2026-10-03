import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import { SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS } from '../../../src/saas/db/runtime-privileges.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { createRequestAdmissionReservationBusinessKey } from '../../../src/saas/gateway/admission.js';
import type { ModelResolutionProvenance } from '../../../src/saas/gateway/contracts.js';
import { GatewayRequestIdempotencyStore } from '../../../src/saas/gateway/request-idempotency.js';
import { SaasPreparedRequestEvidenceService, type PreparedRequestEvidenceInput } from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import type { RequestPreparationCompensationInput, RequestPreparationPreparedResult } from '../../../src/saas/gateway/request-preparation-service.js';
import { createPreparedRequestEvidenceSigner } from '../../../src/saas/runtime/prepared-request-evidence-signer.js';
import { TrustedPreparedRequestVerifierKeyRegistry } from '../../../src/saas/runtime/prepared-evidence-verifier-keys.js';

export const CANCELLATION_PG_REQUIRED = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roles = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
export const cancellationPgConfigured = roles.some(([name]) => Boolean(process.env[name]?.trim()));
function targets() {
  let target: string | undefined;
  return roles.map(([name, role]) => {
    const value = process.env[name]?.trim();
    assert.ok(value, `${name} required for cancellation PG gate`);
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error('Cancellation PG target URL invalid; details redacted'); }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
    assert.equal(decodeURIComponent(parsed.username), role, 'exact managed role required');
    assert.ok(parsed.search === '' && parsed.hash === '', 'no connection overrides');
    const host = parsed.hostname.toLowerCase(); const port = Number(parsed.port);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    const ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(host) && Boolean(parsed.port) && Number.isInteger(port)
      && port > 0 && port <= 65535 && ![5432, 6432, 53782].includes(port)
      && (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, 'designated disposable PG target on explicit nondefault loopback port required');
    const identity = `${host}:${port}/${database}`; target ??= identity;
    assert.equal(identity, target, 'all cancellation roles must use the same disposable target');
    return value;
  });
}
export async function cancellationDatabases() {
  const databases = targets().map((connectionString) => createSaasDatabase({ connectionString, max: 4 }));
  try {
    for (let i = 0; i < databases.length; i++) {
      const current = (await databases[i]!.query<{ role: string; session: string; superuser: boolean; version: string }>(
        `SELECT current_user AS role, session_user AS session, r.rolsuper AS superuser,
          current_setting('server_version_num') AS version FROM pg_roles r WHERE rolname = current_user`)).rows[0]!;
      assert.equal(current.role, roles[i]![1]); assert.equal(current.session, roles[i]![1]);
      assert.equal(current.superuser, false); assert.ok([15, 18].includes(Math.floor(Number(current.version) / 10000)));
    }
    await databases[0]!.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(databases[1]!, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(databases[2]!, 'gateway');
    return { databases, migrator: databases[0]!, gateway: databases[2]! };
  } catch (error) { await Promise.all(databases.map((db) => db.close())); throw error; }
}
export async function cancellationTransaction<T>(database: SaasDatabase, work: (tx: SqlExecutor) => Promise<T>) {
  return database.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query("SET LOCAL statement_timeout = '15s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");
    return work(tx);
  });
}
export function cancellationSqlState(error: unknown): string | undefined {
  const visited = new Set<object>();
  while (error && typeof error === 'object' && !visited.has(error)) {
    visited.add(error);
    if ('code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)) return error.code;
    error = 'cause' in error ? error.cause : undefined;
  }
  return undefined;
}
export function safeCancellationFailure(error: unknown): Error {
  // Assertions in these fixtures contain only synthetic identifiers/status/amounts.
  if (error instanceof assert.AssertionError) return error;
  const state = cancellationSqlState(error);
  return new Error(`Cancellation PostgreSQL operation failed${state ? ` (${state})` : ''}; details redacted`);
}

type Row = Record<string, unknown>;
type Table = 'saas_requests' | 'saas_attempts' | 'saas_gateway_capacity_reservations';
function fixtureModelResolution(row: Row): ModelResolutionProvenance {
  const requestedModel = row.model_resolution_requested_model;
  const mappedModel = row.model_resolution_mapped_model;
  const resolvedModel = row.resolved_model;
  const mappingSource = row.model_resolution_mapping_source;
  assert.ok(typeof requestedModel === 'string' && requestedModel.trim() !== '', 'stored requested model required');
  assert.ok(typeof mappedModel === 'string' && mappedModel.trim() !== '', 'stored mapped model required');
  assert.ok(typeof resolvedModel === 'string' && resolvedModel.trim() !== '', 'stored resolved model required');
  assert.ok(mappingSource === 'none' || mappingSource === 'alias' || mappingSource === 'wildcard', 'stored mapping source required');
  // 029 stores a nullable bigint; the in-memory contract uses a safe number.
  // Check the exact integer before converting the default PG string parser result.
  const storedVersion = row.model_resolution_mapping_version;
  let mappingVersion: number | null;
  if (storedVersion === null) mappingVersion = null;
  else if (typeof storedVersion === 'number') {
    assert.ok(Number.isSafeInteger(storedVersion) && storedVersion > 0, 'stored mapping revision must be a positive safe integer');
    mappingVersion = storedVersion;
  } else {
    assert.ok(typeof storedVersion === 'bigint' ||
      (typeof storedVersion === 'string' && /^[1-9][0-9]*$/.test(storedVersion)), 'stored mapping revision must be a positive bigint');
    const exactVersion = typeof storedVersion === 'bigint' ? storedVersion : BigInt(storedVersion);
    assert.ok(exactVersion > 0n && exactVersion <= BigInt(Number.MAX_SAFE_INTEGER), 'stored mapping revision exceeds the typed range');
    mappingVersion = Number(exactVersion);
  }
  if (mappingSource === 'none') {
    assert.equal(mappingVersion, null, 'passthrough mapping must have no revision');
    assert.equal(mappedModel, requestedModel); assert.equal(resolvedModel, requestedModel);
  } else assert.notEqual(mappingVersion, null, 'mapped model requires a revision');
  return { requestedModel, mappedModel, resolvedModel, mappingSource, mappingVersion };
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
async function source(tx: SqlExecutor, table: Table, request: string, tenant: string) {
  const columns = SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(([name, , privilege]) => name === table && privilege === 'INSERT')
    .map(([, column]) => column);
  const predicate = table === 'saas_requests' ? 'id' : 'request_id';
  const result = await tx.query<Row>(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(table)}
    WHERE tenant_id = $1 AND ${predicate} = $2`, [tenant, request]);
  assert.equal(result.rows.length, 1, 'exact successful synthetic HTTP fixture required');
  return { table, columns, row: result.rows[0]! };
}
async function insert(tx: SqlExecutor, original: Awaited<ReturnType<typeof source>>, patch: Row) {
  for (const key of Object.keys(patch)) assert.ok(original.columns.includes(key), 'fixture patch must use existing exact gateway INSERT grant');
  const row = { ...original.row, ...patch };
  const result = await tx.query(`INSERT INTO ${quote(original.table)} (${original.columns.map(quote).join(', ')})
    VALUES (${original.columns.map((_, i) => `$${i + 1}`).join(', ')})`, original.columns.map((key) => row[key]));
  assert.equal(result.rowCount, 1);
}

/** Requires prior successful dual-mode real HTTP fixture; no bootstrap, grants, trigger bypass or upstream network. */
export async function cancellationFixture(migrator: SaasDatabase, gateway: SaasDatabase, mode: 'byok' | 'platform') {
  const original = (await migrator.query<Row>(
    `SELECT e.* FROM saas_prepared_request_evidence e JOIN saas_requests r
      ON r.tenant_id = e.tenant_id AND r.id = e.request_id JOIN saas_projects p
      ON p.tenant_id = r.tenant_id AND p.id = r.project_id
     WHERE p.slug LIKE 'gateway-e2e-project-%' AND e.account_id LIKE 'gateway-e2e-%'
       AND e.credential_id LIKE 'gateway-e2e-%' AND e.supply_mode = $1 AND e.status = 'claimed'
       AND r.execution_state = 'succeeded' ORDER BY e.created_at DESC LIMIT 1`, [mode])).rows[0];
  assert.ok(original, 'cancellation PG requires prior successful real HTTP fixture for each mode');
  const tenantId = String(original.tenant_id); const projectId = String(original.project_id); const proxyKeyId = String(original.proxy_key_id);
  const originalRequestId = String(original.request_id);
  const parents = await Promise.all((['saas_requests', 'saas_attempts', 'saas_gateway_capacity_reservations'] as const)
    .map((table) => source(migrator, table, originalRequestId, tenantId)));
  const requestId = randomUUID(); const attemptId = randomUUID(); const evidenceId = randomUUID();
  const payloadBytes = Buffer.from('{"model":"synthetic-model","messages":[{"role":"user","content":"cancellation fixture"}]}');
  const payloadSha256 = createHash('sha256').update(payloadBytes).digest('hex');
  const quota = randomUUID(); const rate = randomUUID();
  const keys = generateKeyPairSync('ed25519'); const keyId = 'pre-dispatch-test-only';
  const registry = new TrustedPreparedRequestVerifierKeyRegistry({ keys: [{ keyId, publicKey: keys.publicKey, status: 'active' }] });
  const signer = createPreparedRequestEvidenceSigner({ registry, verifierKeyId: keyId, privateKey: keys.privateKey });
  const evidenceService = new SaasPreparedRequestEvidenceService(gateway, { trustedVerifierPublicKeys: registry.trustedVerifierPublicKeys });
  const billing = new PlatformWalletLedgerService();
  const idempotency = new GatewayRequestIdempotencyStore({ hmacKey: new Uint8Array(32).fill(59) });
  const fingerprint = String(original.request_fingerprint); const fingerprintVersion = String(original.request_fingerprint_version);
  const created = await cancellationTransaction(gateway, async (tx) => {
    const deadline = (await tx.query<{ deadline: Date }>("SELECT clock_timestamp() + interval '5 minutes' AS deadline")).rows[0]!.deadline;
    const claim = await idempotency.claim(tx, { tenantId, projectId, proxyKeyId, requestId,
      clientKey: `pre-dispatch-test:${requestId}`, requestFingerprint: fingerprint, requestFingerprintVersion: fingerprintVersion });
    assert.equal(claim.kind, 'claimed'); if (claim.kind !== 'claimed') throw new Error('fresh fixture claim required');
    await insert(tx, parents[0]!, { id: requestId, execution_state: 'pending', financial_status: mode === 'byok' ? 'not_applicable' : 'pending',
      reconciliation_state: 'none', state_version: 1 });
    await insert(tx, parents[1]!, { id: attemptId, request_id: requestId, dispatch_state: 'not_sent', result_state: 'pending',
      response_started: false, state_version: 1, payload_sha256: payloadSha256 });
    await insert(tx, parents[2]!, { request_id: requestId, attempt_id: attemptId, idempotency_scope_key: claim.keyDigest,
      quota_reservation_id: quota, rate_reservation_id: rate });
    let holdReservation: RequestPreparationCompensationInput['admission']['holdReservation'] = null;
    if (mode === 'platform') {
      const originalHold = (await migrator.query<{ price_snapshot_ref: string }>(
        'SELECT price_snapshot_ref FROM saas_billing_reservations WHERE tenant_id = $1 AND request_id = $2', [tenantId, originalRequestId])).rows[0];
      assert.ok(originalHold);
      const hold = await billing.reserve(tx, { supplyMode: 'platform', tenantId, requestId,
        currency: String(original.max_hold_currency), amountMinorUnits: String(original.max_hold_minor_units),
        businessKey: createRequestAdmissionReservationBusinessKey(tenantId, requestId),
        priceSnapshotRef: originalHold.price_snapshot_ref, metadataRef: `pre-dispatch:${requestId}`, expiresAt: deadline });
      holdReservation = { reference: hold.id, reservationId: hold.id, state: 'reserved', tenantId, requestId,
        currency: hold.currency, amountMinorUnits: hold.amountMinorUnits, priceSnapshotRef: hold.priceSnapshotRef, expiresAt: hold.expiresAt };
    }
    const camel = (name: string) => name.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
    const fields = Object.fromEntries(Object.entries(original).map(([name, value]) => [camel(name), value]));
    const usage = Object.fromEntries(Object.entries(original).filter(([name]) => name.startsWith('usage_'))
      .map(([name, value]) => [camel(name.slice(6)), value]));
    const modelResolution = fixtureModelResolution(original);
    const evidence = await evidenceService.register(signer.sign({ ...fields, evidenceId, requestId, attemptId, payloadSha256,
      dispatchDeadline: deadline, expiresAt: deadline, verifierKeyId: keyId, signatureBase64: '', usage,
      modelResolution,
      audit: { actorUserId: null, entryPoint: 'pre-dispatch-pg-test' },
    } as unknown as PreparedRequestEvidenceInput), { executor: tx });
    const admission: RequestPreparationCompensationInput['admission'] = {
      quotaReservation: { reference: quota, state: 'reserved' }, rateReservation: { reference: rate, state: 'reserved' }, holdReservation,
      idempotencyBinding: { state: 'created', keyDigest: claim.keyDigest, tenantId, projectId, proxyKeyId, requestId,
        requestFingerprint: fingerprint, requestFingerprintVersion: fingerprintVersion },
      deadlineAtMs: deadline.getTime(), dispatchDeadline: deadline, expiresAt: deadline, remainingAttempts: 1,
      retryBudget: 0, attemptOrdinal: Number(original.attempt_ordinal), usageBudget: null,
    };
    return { evidence, admission };
  });
  const command: RequestPreparationCompensationInput = { tenantId, requestId, attemptId, evidenceId,
    admission: created.admission, expectedAttempt: { dispatchState: 'not_sent', resultState: 'pending', responseStarted: false },
    failedStage: 'dispatch', failureCode: 'client_cancelled' };
  const prepared = { outcome: 'prepared', requestId, attemptId, admission: created.admission, evidence: created.evidence,
    payloadBytes, caller: { tenantId, projectId, supplyMode: mode },
  } as unknown as RequestPreparationPreparedResult;
  return { tenantId, projectId, proxyKeyId, requestId, attemptId, evidenceId, command, prepared, billing, evidenceService };
}

export async function cancellationSnapshot(migrator: SqlExecutor, fixture: Awaited<ReturnType<typeof cancellationFixture>>) {
  const result = await migrator.query<Row>(
    `SELECT r.execution_state, r.financial_status, r.reconciliation_state, r.state_version AS request_version,
      a.dispatch_state, a.result_state, a.response_started, a.state_version AS attempt_version,
      c.state AS capacity_state, i.state AS idempotency_state,
      (SELECT state FROM saas_billing_reservations WHERE tenant_id = r.tenant_id AND request_id = r.id) AS hold_state,
      (SELECT count(*)::text FROM saas_audit_events WHERE tenant_id = r.tenant_id AND request_id = r.id
        AND action = 'saas.request.pre_dispatch_released') AS released_audits,
      (SELECT count(*)::text FROM saas_audit_events WHERE tenant_id = r.tenant_id AND request_id = r.id
        AND action = 'saas.request.pre_dispatch_retained') AS retained_audits,
      (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id = r.tenant_id AND source_type = 'billing_settlement') AS settlements,
      (SELECT jsonb_agg(jsonb_build_array(id, currency, posted_balance_minor_units) ORDER BY id)
        FROM saas_wallets WHERE tenant_id = r.tenant_id) AS wallets
     FROM saas_requests r JOIN saas_attempts a ON a.tenant_id = r.tenant_id AND a.request_id = r.id
      JOIN saas_gateway_capacity_reservations c ON c.tenant_id = r.tenant_id AND c.request_id = r.id
      JOIN saas_gateway_request_idempotency_keys i ON i.tenant_id = r.tenant_id AND i.request_id = r.id
     WHERE r.tenant_id = $1 AND r.id = $2 AND a.id = $3`, [fixture.tenantId, fixture.requestId, fixture.attemptId]);
  assert.equal(result.rows.length, 1); return result.rows[0]!;
}
