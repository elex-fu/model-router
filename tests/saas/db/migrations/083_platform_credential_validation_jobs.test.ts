import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PLATFORM_CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/083_platform_credential_validation_jobs.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = PLATFORM_CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const TABLE = 'saas_platform_provider_credential_validation_jobs';

test('083 registers after 082 as the assigned Track D slot with the documented gaps', () => {
  assert.equal(migration.version, 83);
  assert.equal(migration.name, 'platform_credential_validation_jobs');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(0, 60).map(({ version }) => version),
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.equal(registered.includes(61), false);
  assert.equal(registered.includes(62), false);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false, `${skipped} stays a retired Track D-G gap`);
  }
  assert.equal(SAAS_MIGRATIONS[64], migration);
});

test('083 mirrors the 035 job authority shape without any tenant dimension', () => {
  assert.match(commands, new RegExp(`CREATE TABLE ${TABLE} \\(`));
  assert.doesNotMatch(commands, /tenant_id/i);
  for (const fragment of [
    "status text NOT NULL DEFAULT 'queued'",
    "CHECK (status IN ('queued', 'leased', 'verified', 'failed', 'cancelled'))",
    'attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)',
    'lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0)',
    'cardinality(allowed_models) BETWEEN 1 AND 256',
    'target_model = ANY (allowed_models)',
    "CHECK (idempotency_key ~ '^[0-9a-f]{64}$')",
    "CHECK ((status = 'leased') = (lease_until IS NOT NULL))",
    "CHECK ((status IN ('verified', 'failed', 'cancelled')) = (completed_at IS NOT NULL))",
    'FOREIGN KEY (account_id, provider_id, product_id)\n    REFERENCES saas_platform_provider_accounts (id, provider_id, product_id)',
    'FOREIGN KEY (credential_id, account_id)\n    REFERENCES saas_platform_provider_credentials (id, account_id)',
    'FOREIGN KEY (credential_id, credential_version)\n    REFERENCES saas_platform_provider_credential_versions (credential_id, version)',
    'UNIQUE (credential_id, credential_version)',
    'UNIQUE (idempotency_key)',
  ]) {
    assert.ok(commands.includes(fragment), fragment);
  }
  assert.match(
    commands,
    new RegExp(
      `CREATE INDEX ${TABLE}_claim_idx\\s+ON ${TABLE} \\(available_at, created_at, id\\)\\s+WHERE status IN \\('queued', 'leased'\\)`,
    ),
  );
  // Only the claim index: no expression/unique secondary index sneaks in.
  assert.equal([...commands.matchAll(/CREATE (UNIQUE )?INDEX/g)].length, 1);
});

test('083 platform triggers preserve the 035 immutability and invalidation contract', () => {
  // Identity immutability: every authority snapshot field except tenant_id.
  const identity =
    /CREATE FUNCTION saas_platform_credential_validation_job_identity_immutable\(\) RETURNS trigger\nLANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/;
  const identityMatch = identity.exec(commands);
  assert.ok(identityMatch, 'platform identity function exists');
  for (const field of [
    'id',
    'account_id',
    'credential_id',
    'credential_version',
    'provider_id',
    'product_id',
    'credential_type',
    'allowed_models',
    'target_model',
    'target_endpoint',
    'capability_version',
    'idempotency_key',
    'created_at',
  ]) {
    assert.match(identityMatch![1]!, new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`));
  }
  assert.doesNotMatch(identityMatch![1]!, /tenant/);
  assert.match(
    commands,
    /BEFORE UPDATE ON saas_platform_provider_credential_validation_jobs\s+FOR EACH ROW EXECUTE FUNCTION saas_platform_credential_validation_job_identity_immutable\(\)/,
  );

  // Credential/account invalidation wrappers are born with the exact 058
  // execution metadata: SECURITY DEFINER + pinned search_path.
  for (const name of [
    'saas_platform_invalidate_credential_validation_jobs',
    'saas_platform_invalidate_account_credential_validation_jobs',
  ]) {
    assert.match(commands, new RegExp(`ALTER FUNCTION ${name}\\(\\) SECURITY DEFINER;`));
    assert.match(
      commands,
      new RegExp(`ALTER FUNCTION ${name}\\(\\)\\s+SET search_path TO pg_catalog, model_router_saas, pg_temp;`),
    );
  }
  const credentialWrapper =
    /CREATE FUNCTION saas_platform_invalidate_credential_validation_jobs\(\) RETURNS trigger\nLANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/.exec(
      commands,
    );
  assert.ok(credentialWrapper);
  assert.match(credentialWrapper![1]!, /UPDATE saas_platform_provider_credential_validation_jobs/);
  assert.match(credentialWrapper![1]!, /WHERE credential_id = NEW\.id/);
  assert.match(credentialWrapper![1]!, /AND status IN \('queued', 'leased'\)/);
  assert.match(credentialWrapper![1]!, /NEW\.current_version IS DISTINCT FROM OLD\.current_version/);
  assert.match(
    credentialWrapper![1]!,
    /NEW\.status IN \('disabled', 'revoked'\) AND NEW\.status IS DISTINCT FROM OLD\.status/,
  );
  assert.match(
    commands,
    /AFTER UPDATE OF current_version, status ON saas_platform_provider_credentials\s+FOR EACH ROW EXECUTE FUNCTION saas_platform_invalidate_credential_validation_jobs\(\)/,
  );

  const accountWrapper =
    /CREATE FUNCTION saas_platform_invalidate_account_credential_validation_jobs\(\) RETURNS trigger\nLANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/.exec(
      commands,
    );
  assert.ok(accountWrapper);
  assert.match(accountWrapper![1]!, /WHERE account_id = NEW\.id/);
  assert.match(
    commands,
    /AFTER UPDATE OF status ON saas_platform_provider_accounts\s+FOR EACH ROW EXECUTE FUNCTION saas_platform_invalidate_account_credential_validation_jobs\(\)/,
  );

  // No-delete reuses the shared 035 reject function; nothing is deleted ever.
  assert.match(
    commands,
    /BEFORE DELETE ON saas_platform_provider_credential_validation_jobs\s+FOR EACH ROW EXECUTE FUNCTION saas_provider_credential_validation_job_reject_delete\(\)/,
  );
  assert.equal([...commands.matchAll(/CREATE TRIGGER/g)].length, 4);
});

test('083 touches no tenant queue, ACL, ledger or lifecycle shape', () => {
  assert.doesNotMatch(commands, /saas_tenant_provider_credential_validation_jobs/);
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /DROP /i);
  assert.doesNotMatch(commands, /ALTER TABLE/i);
  assert.doesNotMatch(commands, /authz_version/i);
  // The shared no-delete function is referenced by attachment only, never redefined.
  assert.doesNotMatch(commands, /CREATE FUNCTION saas_provider_credential_validation_job_reject_delete/);
});
