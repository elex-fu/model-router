import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';
import { SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS } from '../../../../src/saas/db/runtime-privileges.js';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import {
  PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION,
  PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE,
  PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE,
} from '../../../../src/saas/db/migrations/060_prepared_evidence_claim_generated_account.js';
import { SaasPreparedRequestEvidenceError, SaasPreparedRequestEvidenceService } from '../../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  CANCELLATION_PG_REQUIRED, cancellationPgConfigured, cancellationDatabases, cancellationTransaction,
} from '../../gateway/pre-dispatch-postgres-fixture.js';
import { phase, seedFixture, type Phase } from '../../metering/normal-success-postgres-fixture.js';

// Exact finite vocabulary from a480's phase/safeCodes projection. These are
// diagnostics only: none participates in a success/rejection predicate.
const helperPhases: readonly Phase[] = ['readiness', 'setup', 'admission', 'quote_setup', 'reserve',
  'evidence_register', 'evidence_preflight', 'evidence_claim', 'dispatch_observation', 'first_complete',
  'replay', 'conflict', 'legacy_complete', 'immutability', 'acl', 'snapshot', 'cleanup'];
const helperCodes = ['METERING_STORAGE_ERROR', 'METERING_INVALID_INPUT', 'USAGE_DUPLICATE_CONFLICT',
  'USAGE_SETTLEMENT_CONFLICT', 'ATTEMPT_TRANSITION_INVALID', 'REQUEST_TRANSITION_INVALID',
  'FINANCIAL_TRANSITION_INVALID', 'SIGNATURE_INVALID', 'AUTHORITY_MISMATCH', 'STORAGE_ERROR',
  'PRICING_STORAGE_ERROR', 'SUPPLY_STORAGE_ERROR', 'BILLING_STORAGE_ERROR', 'INSUFFICIENT_FUNDS',
  'INVALID_INPUT', 'INVALID_AMOUNT', 'IDEMPOTENCY_CONFLICT', 'RESERVATION_STATE_CONFLICT', 'unknown'] as const;
const nativeStates = ['42501', '55000', '55006', '23502', '23503', '23505', '23514',
  '42P01', '42703', '42P08', '42883', '42601', '40P01', '40001', '55P03', '57014'] as const;
const nativeOperations = {
  migrator_query: 'setup', migrator_tx_query: 'setup', migrator_transaction: 'setup',
  gateway_query: 'fixture', gateway_tx_query: 'fixture', gateway_transaction: 'fixture',
  claim_bind: 'evidence_claim', claim_audit: 'evidence_claim', bound_read: 'evidence_claim', facts_read: 'snapshot',
} as const;
type DiagnosticCheck = 'fixture_seed' | 'claim_identity' | 'dispatch_stop' | 'binding_ack' | 'bound_identity' |
  'audit_ack' | 'expected_stop' | 'fixture_complete' | 'facts_read' | 'facts_row_count' |
  'claim_facts' | 'replay_denial' | 'replay_facts' | 'acl_manifest' | 'acl_denial' | 'acl_facts' |
  'sibling_source' | 'sibling_insert_ack' | 'sibling_claim_denial' | 'sibling_facts' | 'rollback_facts';
interface FixtureDiagnostic {
  case: 'signed_claim' | 'acl_denial' | 'sibling_claim' | 'rollback'; check: DiagnosticCheck;
  firstCaught: { phase: typeof nativeOperations[keyof typeof nativeOperations]; operation: keyof typeof nativeOperations;
    sqlState: typeof nativeStates[number] | 'unrecognized' } | null;
  firstCheck: DiagnosticCheck | null;
  helper: { phase: Phase | 'unrecognized'; code: typeof helperCodes[number] | 'unrecognized';
    sqlState: typeof nativeStates[number] | 'unknown' | 'unrecognized' };
  stopped: boolean; bindingAck: boolean; auditAck: boolean; claimStarted: boolean; siblingInsertAck: boolean;
}
function finite<T extends string>(values: readonly T[], value: string): value is T {
  return values.some((allowed) => allowed === value);
}
function cleanedHelperFailure(error: unknown): FixtureDiagnostic['helper'] {
  const unrecognized: FixtureDiagnostic['helper'] = { phase: 'unrecognized', code: 'unrecognized', sqlState: 'unrecognized' };
  try {
    // Only seedFixture's already-cleaned rejection reaches this parser. Native
    // query catches below never read message or traverse an error cause.
    if (!(error instanceof Error) || Object.getPrototypeOf(error) !== Error.prototype) return unrecognized;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof value !== 'string' || value.length > 192) return unrecognized;
    const match = /^FIN057 phase=([a-z_]+) code=([A-Z_]+|unknown) sqlState=([0-9A-Z]{5}|unknown)$/.exec(value);
    if (!match || match[0] !== value) return unrecognized;
    const [, helperPhase, code, state] = match;
    if (helperPhase === undefined || code === undefined || state === undefined ||
      !finite(helperPhases, helperPhase) || !finite(helperCodes, code) ||
      (state !== 'unknown' && !finite(nativeStates, state))) return unrecognized;
    return { phase: helperPhase, code, sqlState: state };
  } catch { return unrecognized; }
}
async function observedOperation<T>(diagnostic: FixtureDiagnostic, operation: keyof typeof nativeOperations,
  work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    try {
      // First caught boundary, not a claim of unique native failure causality.
      if (diagnostic.firstCaught === null) {
        const descriptor = error !== null && typeof error === 'object'
          ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
        const code: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
        diagnostic.firstCaught = { phase: nativeOperations[operation], operation,
          sqlState: typeof code === 'string' && finite(nativeStates, code) ? code : 'unrecognized' };
      }
      diagnostic.firstCheck ??= diagnostic.check;
    } catch { /* Observation cannot replace the original result/exception. */ }
    throw error;
  }
}
async function diagnosedCase(t: TestContext, caseName: FixtureDiagnostic['case'], phaseName: Phase,
  work: (diagnostic: FixtureDiagnostic) => Promise<void>): Promise<void> {
  const diagnostic: FixtureDiagnostic = { case: caseName, check: 'fixture_seed', firstCaught: null, firstCheck: null,
    helper: { phase: 'unrecognized', code: 'unrecognized', sqlState: 'unrecognized' },
    stopped: false, bindingAck: false, auditAck: false, claimStarted: false, siblingInsertAck: false };
  try { await phase(phaseName, () => work(diagnostic)); } catch (error) {
    try {
      diagnostic.firstCheck ??= diagnostic.check;
      t.diagnostic(`060_claim_fixture ${JSON.stringify(diagnostic)}`);
    } catch { /* Diagnostic output never replaces the original test failure. */ }
    throw error;
  }
}

// Normal complete CLI 060 deployment and managed roles are prerequisites.
// The first child rehearses the frozen SQL in a rollback-only MIG transaction;
// it is not a 059-to-060 CLI upgrade proof. All real claims use deployed 060.
// Only MIG seeds fixture authority; every claim/attempt write is GW.
const attemptClaimSql = 'UPDATE saas_attempts ' +
  'SET prepared_evidence_id = $3, state_version = state_version + 1, ' +
  'updated_at = GREATEST(updated_at, clock_timestamp()) ' +
  'WHERE tenant_id = $1 AND id = $2 AND prepared_evidence_id IS NULL ' +
  'AND request_id = $4 AND ordinal = $5 AND state_version = $6::bigint ' +
  "AND binding_state = 'bound' AND dispatch_authority_state = 'bound' " +
  "AND dispatch_state = 'not_sent' AND result_state = 'pending' AND response_started = false " +
  'AND response_started_at IS NULL AND result_http_status IS NULL AND unknown_reason IS NULL RETURNING id';
interface Identity { tenantId: string; requestId: string; attemptId: string; evidenceId: string }
interface Facts {
  version: string; prepared: string | null; base_equals_generated: boolean;
  account_matches_evidence: boolean; credential_epoch_matches_evidence: boolean;
  dispatch: string; result: string; response: boolean; execution: string; financial: string;
  evidence_status: string; claimed: boolean; claimed_attempt: string | null; claim_audits: string;
  attempts: string; evidence: string; usage: string; settlements: string; balance: string; held: string;
}
async function facts(executor: SqlExecutor, identity: Identity, diagnostic: FixtureDiagnostic): Promise<Facts> {
  const previousCheck = diagnostic.check;
  diagnostic.check = 'facts_read';
  const result = await observedOperation(diagnostic, 'facts_read', () => executor.query<Facts>(`SELECT a.state_version::text AS version,
    a.prepared_evidence_id::text AS prepared, a.account_id = a.platform_account_id AS base_equals_generated,
    a.platform_account_id = e.account_id AS account_matches_evidence,
    a.credential_authz_version = e.credential_authz_version AS credential_epoch_matches_evidence,
    a.dispatch_state AS dispatch, a.result_state AS result, a.response_started AS response,
    r.execution_state AS execution, r.financial_status AS financial,
    e.status AS evidence_status, e.claimed_at IS NOT NULL AS claimed, e.claimed_attempt_id::text AS claimed_attempt,
    (SELECT count(*)::text FROM saas_audit_events WHERE tenant_id = $1
      AND action = 'saas_prepared_request_evidence.claimed' AND target_id = $4::text) AS claim_audits,
    (SELECT count(*)::text FROM saas_attempts WHERE tenant_id = $1 AND request_id = $2::uuid) AS attempts,
    (SELECT count(*)::text FROM saas_prepared_request_evidence WHERE tenant_id = $1 AND request_id = $2::uuid) AS evidence,
    (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id = $1 AND request_id = $2::uuid) AS usage,
    (SELECT count(*)::text FROM saas_usage_settlements WHERE tenant_id = $1 AND request_id = $2::uuid) AS settlements,
    (SELECT COALESCE(sum(posted_balance_minor_units), 0)::text FROM saas_wallets WHERE tenant_id = $1) AS balance,
    (SELECT COALESCE(sum(amount_minor_units), 0)::text FROM saas_billing_reservations
      WHERE tenant_id = $1 AND request_id = $2::text AND state = 'reserved') AS held
    FROM saas_attempts a JOIN saas_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
    JOIN saas_prepared_request_evidence e ON e.tenant_id = a.tenant_id AND e.id = $4::uuid
    WHERE a.tenant_id = $1 AND a.request_id = $2::uuid AND a.id = $3::uuid`,
  [identity.tenantId, identity.requestId, identity.attemptId, identity.evidenceId]));
  diagnostic.check = 'facts_row_count';
  assert.equal(result.rows.length, 1);
  diagnostic.check = previousCheck;
  return result.rows[0]!;
}
function sqlState(error: unknown): string | null {
  const seen = new Set<object>();
  for (let depth = 0; depth < 8 && error !== null && typeof error === 'object' && !seen.has(error); depth += 1) {
    seen.add(error);
    const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (code === '23514' || code === '55000' || code === '42501') return code;
    const cause = Object.getOwnPropertyDescriptor(error, 'cause');
    error = cause && Object.hasOwn(cause, 'value') ? cause.value : undefined;
  }
  return null;
}

/** Delegate original service SQL/parameters/results exactly; only bounded test stops are injected. */
async function preparedFixture(migrator: SaasDatabase, gateway: SaasDatabase,
  stop: 'before_bind' | 'after_claim_audit' | 'before_dispatch', diagnostic: FixtureDiagnostic) {
  const sentinel = new Error('060 synthetic fixture boundary');
  let identity: Identity | undefined;
  let before: Facts | undefined;
  let stopped = false;
  let bindingAcks = 0;
  let auditAcks = 0;
  let boundVersion: string | undefined;
  const observedMigrator: SaasDatabase = {
    ...migrator,
    query: <Row>(sql: string, values?: readonly unknown[]) =>
      observedOperation(diagnostic, 'migrator_query', () => migrator.query<Row>(sql, values)),
    transaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => observedOperation(diagnostic, 'migrator_transaction',
      () => migrator.transaction((tx) => work({ query: <Row>(sql: string, values?: readonly unknown[]) =>
        observedOperation(diagnostic, 'migrator_tx_query', () => tx.query<Row>(sql, values)) }))),
  };
  const observed: SaasDatabase = {
    query: <Row>(sql: string, values?: readonly unknown[]) =>
      observedOperation(diagnostic, 'gateway_query', () => gateway.query<Row>(sql, values)), migrate: gateway.migrate.bind(gateway),
    verifySchema: gateway.verifySchema.bind(gateway), ping: gateway.ping.bind(gateway), close: gateway.close.bind(gateway),
    transaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => observedOperation(diagnostic, 'gateway_transaction',
      () => cancellationTransaction(gateway, (tx) => work({
      async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
        if (sql === attemptClaimSql) {
          diagnostic.check = 'claim_identity';
          assert.equal(identity, undefined, 'one real claim only');
          const [tenantId, attemptId, evidenceId, requestId] = values;
          assert.ok(typeof tenantId === 'string' && typeof requestId === 'string' &&
            typeof attemptId === 'string' && typeof evidenceId === 'string');
          identity = { tenantId, requestId, attemptId, evidenceId };
          before = await facts(migrator, identity, diagnostic);
          if (stop === 'before_bind') { stopped = true; throw sentinel; }
        }
        // This fixture exercises signed registration/preflight/claim only, not
        // a fabricated dispatch without the gateway capacity/admission port.
        if (stop === 'before_dispatch' && identity && sql.startsWith('UPDATE saas_attempts\n') &&
          sql.includes('SET dispatch_state = $4,') && values[3] === 'dispatching') {
          diagnostic.check = 'dispatch_stop';
          assert.equal(values[0], identity.tenantId); assert.equal(values[1], identity.requestId);
          assert.equal(values[2], identity.attemptId); assert.equal(bindingAcks, 1); assert.equal(auditAcks, 1);
          stopped = true; throw sentinel;
        }
        const claimAudit = identity !== undefined && sql.startsWith('INSERT INTO saas_audit_events ') &&
          values[3] === 'saas_prepared_request_evidence.claimed';
        if (sql === attemptClaimSql) diagnostic.claimStarted = true;
        const result = await observedOperation(diagnostic,
          sql === attemptClaimSql ? 'claim_bind' : claimAudit ? 'claim_audit' : 'gateway_tx_query',
          () => tx.query<Row>(sql, values));
        if (sql === attemptClaimSql) {
          diagnostic.check = 'binding_ack';
          assert.equal(result.rowCount, 1); bindingAcks += 1;
          assert.ok(identity);
          const boundValues = [identity.tenantId, identity.attemptId];
          const bound = (await observedOperation(diagnostic, 'bound_read', () => tx.query<{ version: string; correct_account: boolean }>(
            `SELECT state_version::text AS version, account_id = platform_account_id AS correct_account
             FROM saas_attempts WHERE tenant_id = $1 AND id = $2`, boundValues))).rows[0];
          diagnostic.check = 'bound_identity';
          assert.ok(bound); assert.equal(bound.correct_account, true); boundVersion = bound.version;
        }
        if (identity && sql.startsWith('INSERT INTO saas_audit_events ') &&
          values[3] === 'saas_prepared_request_evidence.claimed') {
          diagnostic.check = 'audit_ack';
          assert.equal(values[1], identity.tenantId); assert.equal(values[4], 'saas_prepared_request_evidence');
          assert.equal(values[5], identity.evidenceId); assert.equal(result.rowCount, 1); auditAcks += 1;
          if (stop === 'after_claim_audit') { stopped = true; throw sentinel; }
        }
        return result;
      },
    }))),
  };
  try {
    await assert.rejects(seedFixture(observedMigrator, observed, 'platform'), (error: unknown) => {
    diagnostic.helper = cleanedHelperFailure(error);
    diagnostic.firstCheck ??= diagnostic.check;
    diagnostic.check = 'expected_stop';
    // FIN fixture sanitizes the original sentinel through its real service
    // storage wrapper. No unrelated exception or SQL failure is acceptable.
    const expected = stop === 'before_dispatch'
      ? 'FIN057 phase=dispatch_observation code=METERING_STORAGE_ERROR sqlState=unknown'
      : stop === 'after_claim_audit'
        // The unchanged FIN helper's finite projection does not list AUDIT_FAILED.
        ? 'FIN057 phase=evidence_claim code=unknown sqlState=unknown'
        : 'FIN057 phase=evidence_claim code=STORAGE_ERROR sqlState=unknown';
    return stopped && error instanceof Error && error.message === expected;
    });
  } finally {
    diagnostic.stopped = stopped; diagnostic.bindingAck = bindingAcks === 1; diagnostic.auditAck = auditAcks === 1;
  }
  diagnostic.check = 'fixture_complete';
  assert.ok(identity && before, 'complete signed fixture must reach the actual claim boundary');
  assert.equal(stopped, true);
  // The accepted synthetic stop is not a subsequent assertion's native cause.
  diagnostic.firstCaught = null; diagnostic.firstCheck = null;
  return { identity, before, bindingAcks, auditAcks, boundVersion };
}

async function registeredLedger(executor: SqlExecutor): Promise<void> {
  const migration = PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION;
  assert.equal(migration.version, 60);
  assert.equal(migration.name, 'prepared_evidence_claim_generated_account');
  assert.equal(SAAS_MIGRATIONS[59], migration, 'exact normal registered 060 required');
  assert.deepEqual(SAAS_MIGRATIONS.map(({ version }) => version),
    Array.from({ length: 60 }, (_, index) => index + 1), 'complete normal 001-060 registry required');
  const expected = SAAS_MIGRATIONS.map(({ version, name, sql }) => ({ version, name,
    checksum: createHash('sha256').update(name).update('\0').update(sql).digest('hex') }));
  const applied = await executor.query<{ version: number; name: string; checksum: string }>(
    'SELECT version, name, checksum FROM model_router_saas.saas_schema_migrations ORDER BY version ASC');
  assert.deepEqual(applied.rows, expected, 'complete actual ledger must match the current registered release');
}

async function catalog(migrator: SqlExecutor) {
  const result = await migrator.query<{ source: string; metadata: unknown; bindings: unknown; relations: unknown; ledger: unknown }>(
    `SELECT p.prosrc AS source, to_jsonb(p) - 'prosrc' AS metadata,
       (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t WHERE t.tgfoid = p.oid) AS bindings,
       jsonb_build_object(
         'acl', (SELECT jsonb_agg(jsonb_build_array(c.oid, c.relowner, c.relacl) ORDER BY c.oid)
           FROM pg_class c WHERE c.oid IN ('model_router_saas.saas_attempts'::regclass,
             'model_router_saas.saas_prepared_request_evidence'::regclass)),
         'columns', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid, a.attnum)
           FROM pg_attribute a WHERE a.attrelid IN ('model_router_saas.saas_attempts'::regclass,
             'model_router_saas.saas_prepared_request_evidence'::regclass)),
         'constraints', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid)
           FROM pg_constraint c WHERE c.conrelid IN ('model_router_saas.saas_attempts'::regclass,
             'model_router_saas.saas_prepared_request_evidence'::regclass)),
         'triggers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid)
           FROM pg_trigger t WHERE t.tgrelid IN ('model_router_saas.saas_attempts'::regclass,
             'model_router_saas.saas_prepared_request_evidence'::regclass))) AS relations,
       (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.version) FROM model_router_saas.saas_schema_migrations m) AS ledger
     FROM pg_proc p WHERE p.oid = 'model_router_saas.saas_attempts_guard_prepared_evidence_claim_pool()'::regprocedure`);
  assert.equal(result.rows.length, 1); return result.rows[0]!;
}

test('normal registered 060 real restricted PostgreSQL generated-account claim regression', {
  skip: process.env[CANCELLATION_PG_REQUIRED] !== '1' && !cancellationPgConfigured
    ? `set ${CANCELLATION_PG_REQUIRED}=1 and all three disposable gateway E2E role URLs` : false,
  timeout: 120_000,
}, async (t) => {
  let databases: SaasDatabase[] = [];
  try {
    const connected = await phase('readiness', () => cancellationDatabases());
    databases = connected.databases;
    const { migrator, gateway } = connected;
    await phase('readiness', () => registeredLedger(migrator));
    await t.test('exact one-field forward repair preserves owner/security/ACL/binding and historical ledger', () => phase('readiness', async () => {
      const deployed = await catalog(migrator);
      assert.equal(deployed.source, PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE, 'normal deployed 060 body required');
      const rollbackSentinel = new Error('060 transactional forward rehearsal rollback');
      let forwardRepairAck = false;
      await assert.rejects(cancellationTransaction(migrator, async (tx) => {
        await tx.query('LOCK TABLE model_router_saas.saas_attempts, model_router_saas.saas_prepared_request_evidence IN ACCESS EXCLUSIVE MODE');
        assert.deepEqual(await catalog(tx), deployed, 'deployed catalog must remain unchanged before rehearsal');
        // Trusted historical export only; no persisted downgrade, ledger write,
        // security/ACL override or fixture business writes in this transaction.
        await tx.query(`CREATE OR REPLACE FUNCTION model_router_saas.saas_attempts_guard_prepared_evidence_claim_pool()
          RETURNS trigger LANGUAGE plpgsql AS $rehearsal_claim_guard$${PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE}$rehearsal_claim_guard$;`);
        const before = await catalog(tx);
        assert.equal(before.source, PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE);
        assert.deepEqual({ ...before, source: deployed.source }, deployed, 'historical reconstruction changes only source');
        await tx.query(PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION.sql);
        const after = await catalog(tx);
        assert.equal(after.source, PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE);
        assert.deepEqual({ ...after, source: before.source }, before, 'only the target source field may change');
        assert.deepEqual(after, deployed, 'forward SQL must exactly restore the deployed catalog and complete ledger');
        forwardRepairAck = true;
        throw rollbackSentinel;
      }), (error: unknown) => error === rollbackSentinel);
      assert.equal(forwardRepairAck, true, 'real forward SQL and every invariant must be acknowledged before rollback');
      assert.deepEqual(await catalog(migrator), deployed, 'transaction rollback must leave normal 060 fully unchanged');
      await migrator.verifySchema();
      await registeredLedger(migrator);
      const privileges = (await gateway.query<{ direct_guard: boolean; account_update: boolean; key_update: boolean;
        attempt_account_update: boolean; attempt_credential_epoch_update: boolean }>(
        `SELECT has_function_privilege(current_user, 'saas_attempts_guard_prepared_evidence_claim_pool()', 'EXECUTE') AS direct_guard,
          has_any_column_privilege(current_user, 'saas_platform_provider_accounts', 'UPDATE') AS account_update,
          has_any_column_privilege(current_user, 'saas_api_keys', 'UPDATE') AS key_update,
          has_column_privilege(current_user, 'saas_attempts', 'platform_account_id', 'UPDATE') AS attempt_account_update,
          has_column_privilege(current_user, 'saas_attempts', 'credential_authz_version', 'UPDATE') AS attempt_credential_epoch_update`)).rows[0];
      assert.deepEqual(privileges, { direct_guard: false, account_update: false, key_update: false,
        attempt_account_update: false, attempt_credential_epoch_update: false });
    }));
    await t.test('real signed service claim commits one binding/version/audit and repeat claim is denied', (child) => diagnosedCase(child, 'signed_claim', 'evidence_claim', async (diagnostic) => {
      const fixture = await preparedFixture(migrator, gateway, 'before_dispatch', diagnostic);
      diagnostic.check = 'claim_facts';
      assert.equal(fixture.before.version, '1'); assert.equal(fixture.bindingAcks, 1); assert.equal(fixture.auditAcks, 1);
      assert.equal(fixture.boundVersion, '2');
      const actual = await facts(migrator, fixture.identity, diagnostic);
      assert.deepEqual(actual, { ...fixture.before, version: '2', prepared: fixture.identity.evidenceId,
        evidence_status: 'claimed', claimed: true, claimed_attempt: fixture.identity.attemptId, claim_audits: '1' });
      assert.equal(actual.base_equals_generated, true);
      assert.equal(actual.dispatch, 'not_sent'); assert.equal(actual.result, 'pending'); assert.equal(actual.response, false);
      assert.equal(actual.usage, '0'); assert.equal(actual.settlements, '0'); assert.equal(actual.balance, '100'); assert.equal(actual.held, '50');
      // Already-claimed rejection occurs before signature verification; an
      // unavailable verifier must not replace the exact ALREADY_CLAIMED code.
      const evidence = new SaasPreparedRequestEvidenceService(gateway, { trustedVerifierPublicKeys: new Map() });
      diagnostic.check = 'replay_denial';
      await assert.rejects(evidence.claimForDispatch(fixture.identity.evidenceId,
        { actorUserId: null, entryPoint: '060-claim-replay' }),
      (error: unknown) => error instanceof SaasPreparedRequestEvidenceError && error.code === 'ALREADY_CLAIMED');
      diagnostic.check = 'replay_facts';
      assert.deepEqual(await facts(migrator, fixture.identity, diagnostic), actual);
    }));
    await t.test('GW cannot UPDATE INSERT-only account or credential authority: exact ACL denial leaves facts unchanged', (child) => diagnosedCase(child, 'acl_denial', 'acl', async (diagnostic) => {
      const fixture = await preparedFixture(migrator, gateway, 'before_bind', diagnostic);
      diagnostic.check = 'acl_facts';
      assert.equal(fixture.bindingAcks, 0); assert.equal(fixture.auditAcks, 0);
      assert.deepEqual(await facts(migrator, fixture.identity, diagnostic), fixture.before);
      assert.equal(fixture.before.account_matches_evidence, true);
      assert.equal(fixture.before.credential_epoch_matches_evidence, true);
      for (const update of [
        { column: 'platform_account_id',
          sql: `UPDATE saas_attempts SET platform_account_id = $4, state_version = state_version + 1,
            updated_at = GREATEST(updated_at, clock_timestamp()) WHERE tenant_id = $1 AND request_id = $2 AND id = $3`,
          values: [fixture.identity.tenantId, fixture.identity.requestId, fixture.identity.attemptId,
            `060-wrong-account-${randomUUID()}`] },
        { column: 'credential_authz_version',
          sql: `UPDATE saas_attempts SET credential_authz_version = credential_authz_version + 1,
          state_version = state_version + 1, updated_at = GREATEST(updated_at, clock_timestamp())
          WHERE tenant_id = $1 AND request_id = $2 AND id = $3`,
          values: [fixture.identity.tenantId, fixture.identity.requestId, fixture.identity.attemptId] },
      ] as const) {
        diagnostic.check = 'acl_manifest';
        assert.ok(SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(([table, column, grant]) =>
          table === 'saas_attempts' && column === update.column && grant === 'INSERT'));
        assert.equal(SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(([table, column, grant]) =>
          table === 'saas_attempts' && column === update.column && grant === 'UPDATE'), false);
        diagnostic.check = 'acl_denial';
        await assert.rejects(cancellationTransaction(gateway, (tx) => tx.query(update.sql, update.values)),
          (error: unknown) => sqlState(error) === '42501');
        diagnostic.check = 'acl_facts';
        assert.deepEqual(await facts(migrator, fixture.identity, diagnostic), fixture.before);
      }
    }));
    await t.test('acknowledged valid GW sibling INSERT then evidence-attempt claim mismatch rejects 23514 and rolls back', (child) => diagnosedCase(child, 'sibling_claim', 'conflict', async (diagnostic) => {
      const fixture = await preparedFixture(migrator, gateway, 'before_bind', diagnostic);
      diagnostic.check = 'sibling_source';
      assert.equal(fixture.bindingAcks, 0); assert.equal(fixture.auditAcks, 0);
      assert.deepEqual(await facts(migrator, fixture.identity, diagnostic), fixture.before);
      const columns = SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(([table, , grant]) => table === 'saas_attempts' && grant === 'INSERT')
        .map(([, column]) => column);
      assert.equal(new Set(columns).size, columns.length);
      const original = (await migrator.query<Record<string, unknown>>(`SELECT ${columns.map((name) => `"${name}"`).join(', ')}
        FROM saas_attempts WHERE tenant_id = $1 AND id = $2`, [fixture.identity.tenantId, fixture.identity.attemptId])).rows[0];
      assert.ok(original);
      const siblingId = randomUUID(); const sibling: Record<string, unknown> = { ...original, id: siblingId, ordinal: 2 };
      // The valid sibling INSERT succeeds under GW; only the mismatched binding
      // then fails. Both are in one real transaction and must roll back together.
      let siblingInsertAck = false;
      let claimStarted = false;
      diagnostic.check = 'sibling_claim_denial';
      await assert.rejects(cancellationTransaction(gateway, async (tx) => {
        const inserted = await tx.query(`INSERT INTO saas_attempts (${columns.map((name) => `"${name}"`).join(', ')})
          VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`, columns.map((name) => sibling[name]));
        diagnostic.check = 'sibling_insert_ack';
        assert.equal(inserted.rowCount, 1); siblingInsertAck = true; diagnostic.siblingInsertAck = true;
        claimStarted = true; diagnostic.claimStarted = true; diagnostic.check = 'sibling_claim_denial';
        return tx.query(attemptClaimSql, [fixture.identity.tenantId, siblingId, fixture.identity.evidenceId,
          fixture.identity.requestId, 2, 1]);
      }), (error: unknown) => siblingInsertAck && claimStarted && sqlState(error) === '23514');
      assert.equal(siblingInsertAck, true); assert.equal(claimStarted, true);
      diagnostic.check = 'sibling_facts';
      assert.deepEqual(await facts(migrator, fixture.identity, diagnostic), fixture.before);
      // 019's INSERT guard requires the current credential epoch; 024's
      // registration guard binds evidence to that exact persisted attempt epoch.
      // An invalid/stale sibling INSERT is not a credential-only claim proof.
      // The frozen static regression separately preserves that claim predicate.
    }));
    await t.test('acknowledged real binding and claim audit roll back atomically on original transaction failure', (child) => diagnosedCase(child, 'rollback', 'evidence_claim', async (diagnostic) => {
      const fixture = await preparedFixture(migrator, gateway, 'after_claim_audit', diagnostic);
      diagnostic.check = 'rollback_facts';
      assert.equal(fixture.bindingAcks, 1); assert.equal(fixture.auditAcks, 1); assert.equal(fixture.boundVersion, '2');
      assert.deepEqual(await facts(migrator, fixture.identity, diagnostic), fixture.before);
      assert.equal(fixture.before.version, '1'); assert.equal(fixture.before.prepared, null);
      assert.equal(fixture.before.evidence_status, 'registered'); assert.equal(fixture.before.claimed, false);
      assert.equal(fixture.before.claimed_attempt, null); assert.equal(fixture.before.claim_audits, '0');
      assert.equal(fixture.before.attempts, '1'); assert.equal(fixture.before.evidence, '1');
      assert.equal(fixture.before.usage, '0'); assert.equal(fixture.before.settlements, '0');
      assert.equal(fixture.before.balance, '100'); assert.equal(fixture.before.held, '50');
    }));
    await t.test('nonhistorical function lineage is refused without a second body/ACL/ledger change', () => phase('readiness', async () => {
      const before = await catalog(migrator);
      assert.equal(before.source, PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE);
      await assert.rejects(cancellationTransaction(migrator, (tx) => tx.query(PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION.sql)),
        (error: unknown) => sqlState(error) === '55000');
      assert.deepEqual(await catalog(migrator), before);
      await migrator.verifySchema();
      await registeredLedger(migrator);
    }));
  } catch (error) {
    // No driver message/detail/context/SQL/values/cause/stack survives a failure.
    // Native assertions contain only this test's synthetic facts and counters.
    if (error instanceof assert.AssertionError) throw error;
    const safe = new Error(`060 staged claim PostgreSQL failure: sqlState=${sqlState(error) ?? 'unknown'}`);
    safe.stack = undefined; throw safe;
  } finally { await phase('cleanup', () => Promise.all(databases.map((database) => database.close()))); }
});
