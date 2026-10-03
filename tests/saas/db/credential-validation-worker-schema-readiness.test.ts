import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SAAS_CREDENTIAL_VALIDATION_WORKER_SCHEMA_READINESS_SQL,
  SaasCredentialValidationWorkerSchemaReadinessError,
  verifyCredentialValidationWorkerSchemaReadiness,
} from '../../../src/saas/db/credential-validation-worker-schema-readiness.js';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import { CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS } from '../../../src/saas/db/migrations/058_credential_validation_invalidation_trigger_execution.js';

const ready = {
  server_ready: true, session_ready: true, owner_ready: true, tables_ready: true, columns_ready: true,
  keys_ready: true, indexes_ready: true, checks_ready: true, triggers_ready: true, routines_ready: true,
};
function executor(rows: readonly unknown[]): SqlExecutor {
  return { async query<Row>() { return { rows: [...rows] as Row[], rowCount: rows.length }; } };
}

test('worker structural readiness uses one real catalog query and inert expected artifacts, never history/DDL/application data', async () => {
  let calls = 0;
  await verifyCredentialValidationWorkerSchemaReadiness({
    async query<Row>(sql: string, values?: readonly unknown[]) {
      calls += 1;
      assert.equal(sql, SAAS_CREDENTIAL_VALIDATION_WORKER_SCHEMA_READINESS_SQL);
      assert.doesNotMatch(sql, /saas_schema_migrations|(?:FROM|JOIN)\s+(?:model_router_saas\.)?saas_/i);
      // CREATE is a legitimate ACL privilege name in a catalog predicate,
      // not a DDL statement. Check statement starts, not string literals.
      assert.doesNotMatch(sql, /(?:^|;)\s*(?:INSERT|UPDATE|DELETE|GRANT|ALTER|CREATE|TRUNCATE|DROP)\b/im);
      assert.ok(values && values.length === 1 && typeof values[0] === 'string');
      const contract = JSON.parse(values[0]);
      assert.equal(contract.tables.length, 9);
      assert.ok(contract.columns.some((column: { column_name: string; type_name: string }) =>
        column.column_name === 'evidence_sha256' && column.type_name === 'text'));
      assert.ok(contract.keys.some((key: { kind: string; name: string }) => key.kind === 'f' && key.name.endsWith('_version_fk')));
      assert.ok(contract.indexes.some((index: { name: string }) => index.name.endsWith('_claim_idx')));
      assert.ok(contract.checks.some((check: { name: string | null }) => check.name?.endsWith('_lease_shape')));
      assert.ok(contract.triggers.some((trigger: { name: string; type: number }) =>
        trigger.name === 'saas_tenant_provider_credential_validation_jobs_identity_immutable'.slice(0, 63) && trigger.type === 19));
      assert.ok(contract.keys.some((key: { name: string }) =>
        key.name === 'saas_tenant_provider_credential_validation_jobs_idempotency_unique'.slice(0, 63)));
      assert.ok([...contract.keys, ...contract.triggers, ...contract.checks].every((item: { name: string | null }) =>
        item.name === null || Buffer.byteLength(item.name, 'utf8') <= 63));
      assert.ok(contract.triggers.some((trigger: { name: string; type: number }) =>
        trigger.name.endsWith('_byok_fence') && trigger.type === 23));
      const elevated = contract.routines.filter((routine: { definer: boolean }) => routine.definer);
      assert.deepEqual(elevated.map((routine: { signature: string }) => routine.signature).sort(), [
        'saas_invalidate_account_credential_validation_jobs()',
        'saas_invalidate_credential_validation_jobs()',
        'saas_prepared_evidence_authorization_writer_fence()',
      ]);
      for (const routine of elevated) assert.deepEqual(routine.config, ['search_path=pg_catalog, model_router_saas, pg_temp']);
      for (const routine of contract.routines.filter((routine: { definer: boolean }) => !routine.definer)) {
        assert.equal(routine.config, null, `${routine.signature} must remain an unconfigured invoker`);
      }
      for (const { signature, source } of CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS) {
        const routine = contract.routines.find((routine: { signature: string }) => routine.signature === signature);
        assert.ok(routine);
        assert.equal(routine.source, source, '058 cannot replace any 035 body');
        assert.equal(routine.definer, signature.startsWith('saas_invalidate_'));
      }
      assert.ok(contract.routines.every((routine: { source: string }) => routine.source.length > 0));
      assert.match(contract.routines.find((routine: { signature: string }) =>
        routine.signature === 'saas_provider_credential_version_immutable()')?.source ?? '', /old_row jsonb := to_jsonb\(OLD\)/);
      return { rows: [ready as Row], rowCount: 1 };
    },
  });
  assert.equal(calls, 1);
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_SCHEMA_READINESS_SQL, /pg_catalog\.pg_attribute/);
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_SCHEMA_READINESS_SQL, /i\.indisvalid AND i\.indisready AND i\.indislive/);
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_SCHEMA_READINESS_SQL, /k\.convalidated/);
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_SCHEMA_READINESS_SQL, /t\.tgenabled = 'O'/);
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_SCHEMA_READINESS_SQL, /p\.prosrc = e\.source/);
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_SCHEMA_READINESS_SQL, /NOT pg_catalog\.has_function_privilege/);
});

test('every missing or unsafe structural check fails closed with only its static check name', async () => {
  for (const check of Object.keys(ready)) {
    await assert.rejects(verifyCredentialValidationWorkerSchemaReadiness(executor([{ ...ready, [check]: false }])),
      (error: unknown) => error instanceof SaasCredentialValidationWorkerSchemaReadinessError &&
        error.code === 'SAAS_VALIDATION_WORKER_SCHEMA_NOT_READY' &&
        JSON.stringify(error.failedChecks) === JSON.stringify([check]));
  }
});

test('absent, duplicate, partial and non-boolean catalog responses are not readiness evidence', async () => {
  const partial = { ...ready };
  Reflect.deleteProperty(partial, 'routines_ready');
  for (const rows of [[], [ready, ready], [null], [partial], [{ ...ready, owner_ready: 'true' }]]) {
    await assert.rejects(verifyCredentialValidationWorkerSchemaReadiness(executor(rows)), SaasCredentialValidationWorkerSchemaReadinessError);
  }
});

test('driver errors are sanitized without pretending a missing metadata privilege is readiness', async () => {
  const sensitive = 'fixture-db-driver-context-not-for-diagnostics';
  await assert.rejects(verifyCredentialValidationWorkerSchemaReadiness({
    async query() { throw Object.assign(new Error(sensitive), { code: '42501', detail: sensitive }); },
  }), (error: unknown) => error instanceof SaasCredentialValidationWorkerSchemaReadinessError &&
    !JSON.stringify(error).includes(sensitive) && !error.message.includes(sensitive) && !Object.hasOwn(error, 'cause'));
});
