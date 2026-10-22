import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../../src/saas/db/index.js';

const migratorUrl = process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL?.trim();
const required = process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED === '1';

test('installed compact provenance CHECKs accept only native compact pairs and preserve generation pairs', {
  skip: !required && !migratorUrl ? 'requires the disposable managed SaaS migration database' : false,
}, async () => {
  assert.ok(migratorUrl, 'MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL is required');
  const parsed = new URL(migratorUrl);
  assert.equal(decodeURIComponent(parsed.username), 'model_router_saas_migrator');
  const name = decodeURIComponent(parsed.pathname.slice(1));
  const ci = parsed.hostname === 'postgres' && parsed.port === '5432' && name === 'model_router_saas_ci';
  const disposable =
    ['127.0.0.1', '[::1]'].includes(parsed.hostname) &&
    parsed.port !== '' &&
    !['5432', '6432'].includes(parsed.port) &&
    (name === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(name));
  assert.ok(ci || disposable, 'compact CHECK validation requires an explicit disposable database');
  const database = createSaasDatabase({ connectionString: migratorUrl, max: 1 });
  try {
    const constraints = await database.query<{ name: string; expression: string }>(`
      SELECT constraint_record.conname AS name,
             pg_get_expr(constraint_record.conbin, constraint_record.conrelid) AS expression
        FROM pg_constraint constraint_record
        JOIN pg_class table_record ON table_record.oid=constraint_record.conrelid
        JOIN pg_namespace schema_record ON schema_record.oid=table_record.relnamespace
       WHERE schema_record.nspname='model_router_saas'
         AND constraint_record.conname IN (
           'saas_attempts_provider_payload_provenance_shape',
           'saas_prepared_request_evidence_provider_payload_provenance_shape')`);
    assert.equal(constraints.rows.length, 2);
    for (const constraint of constraints.rows) {
      // Evaluate the installed expression over controlled rows. This reads
      // the real migrated CHECK without writing to any persistent table.
      const evaluate = async (
        protocol: string,
        provider: string,
        clientOperation: string,
        providerOperation: string,
      ) => {
        const result = await database.query<{ accepted: boolean }>(
          `
          WITH trial AS (SELECT $1::text AS protocol, $2::text AS provider_protocol,
            $3::text AS client_operation, $4::text AS provider_operation,
            $5::text AS request_fingerprint, 'fingerprint-v1'::text AS request_fingerprint_version,
            'compiler-v1'::text AS payload_compiler_version, 'estimator-v1'::text AS usage_estimator_version,
            $5::text AS payload_sha256)
          SELECT (${constraint.expression}) AS accepted FROM trial`,
          [protocol, provider, clientOperation, providerOperation, 'a'.repeat(64)],
        );
        return result.rows[0]?.accepted;
      };
      assert.equal(
        await evaluate('responses', 'responses', 'responses.compact', 'responses.compact'),
        true,
        constraint.name,
      );
      assert.equal(await evaluate('responses', 'responses', 'responses', 'responses'), true, constraint.name);
      assert.equal(await evaluate('openai', 'openai', 'chat.completions', 'chat.completions'), true, constraint.name);
      assert.equal(await evaluate('responses', 'responses', 'responses.compact', 'responses'), false, constraint.name);
      assert.equal(await evaluate('responses', 'responses', 'responses', 'responses.compact'), false, constraint.name);
      assert.equal(
        await evaluate('openai', 'responses', 'chat.completions', 'responses.compact'),
        false,
        constraint.name,
      );
      assert.equal(await evaluate('responses', 'anthropic', 'responses.compact', 'messages'), false, constraint.name);
    }
  } finally {
    await database.close();
  }
});
