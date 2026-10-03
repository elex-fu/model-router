import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Pool as PgPool, type PoolClient } from 'pg';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { UNKNOWN_OUTCOME_RECONCILIATION_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/049_unknown_outcome_reconciliation.js';
import { UNKNOWN_OUTCOME_SUPPORT_TICKET_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/051_unknown_outcome_support_ticket.js';

const migration = UNKNOWN_OUTCOME_SUPPORT_TICKET_SAAS_MIGRATION;
const sql = migration.sql;
const migration051TestUrl = process.env.MODEL_ROUTER_SAAS_MIGRATION_051_TEST_URL?.trim();
const workerSource = readFileSync(
  resolve(process.cwd(), 'src/saas/metering/unknown-outcome-recovery-worker.ts'),
  'utf8',
);

interface Migration051Fixture {
  readonly tenantId: string;
  readonly userId: string;
  readonly projectId: string;
  readonly profileId: string;
  readonly entitlementId: string;
  readonly apiKeyId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly auditEventId: string;
}

function createMigration051Fixture(): Migration051Fixture {
  return {
    tenantId: randomUUID(),
    userId: randomUUID(),
    projectId: randomUUID(),
    profileId: 'migration-051-profile',
    entitlementId: randomUUID(),
    apiKeyId: randomUUID(),
    requestId: randomUUID(),
    attemptId: randomUUID(),
    auditEventId: randomUUID(),
  };
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function assertPostgresError(operation: () => Promise<unknown>, code: string, message: RegExp): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal(postgresErrorCode(error), code);
    const errorMessage =
      typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message?: unknown }).message)
        : String(error);
    assert.match(errorMessage, message);
    return true;
  });
}

async function setMigration051SearchPath(client: PoolClient, schema: string): Promise<void> {
  await client.query(`SET search_path TO "${schema}", pg_catalog`);
  const result = await client.query<{ current_schema: string; schemas: string[] }>(
    'SELECT pg_catalog.current_schema() AS current_schema, pg_catalog.current_schemas(false)::text[] AS schemas',
  );
  assert.equal(result.rows[0]?.current_schema, schema);
  assert.deepEqual(result.rows[0]?.schemas, [schema, 'pg_catalog']);
}

async function seedMigration051Dependencies(client: PoolClient, fixture: Migration051Fixture): Promise<void> {
  const digest = 'a'.repeat(64);
  await client.query(
    `INSERT INTO saas_users (id, email)
     VALUES ($1, 'migration-051@example.com')`,
    [fixture.userId],
  );
  await client.query(
    `INSERT INTO saas_tenants (id, name, slug)
     VALUES ($1, 'Migration 051 tenant', 'migration-051-tenant')`,
    [fixture.tenantId],
  );
  await client.query(
    `INSERT INTO saas_memberships (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [fixture.tenantId, fixture.userId],
  );
  await client.query(
    `INSERT INTO saas_projects (tenant_id, id, name, slug)
     VALUES ($1, $2, 'Migration 051 project', 'migration-051-project')`,
    [fixture.tenantId, fixture.projectId],
  );
  await client.query(
    `INSERT INTO saas_project_memberships (tenant_id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [fixture.tenantId, fixture.projectId, fixture.userId],
  );
  await client.query(
    `INSERT INTO saas_supply_profiles (tenant_id, id, supply_mode, model_scopes)
     VALUES ($1, $2, 'byok', ARRAY['fixture-model'])`,
    [fixture.tenantId, fixture.profileId],
  );
  await client.query(
    `INSERT INTO saas_project_entitlements
       (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes)
     VALUES ($1, $2, $3, $4, 'byok', ARRAY['fixture-model'])`,
    [fixture.entitlementId, fixture.tenantId, fixture.projectId, fixture.profileId],
  );
  await client.query(
    `INSERT INTO saas_api_keys
       (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode,
        name, prefix, key_hash, model_scopes, entitlement_id)
     VALUES ($1, $2, $3, $4, $5, 'byok',
        'Migration 051 key', 'mr_live_migration051', $6, ARRAY['fixture-model'], $7)`,
    [
      fixture.apiKeyId,
      fixture.tenantId,
      fixture.projectId,
      fixture.userId,
      fixture.profileId,
      digest,
      fixture.entitlementId,
    ],
  );
}

async function seedMigration051Request(client: PoolClient, fixture: Migration051Fixture): Promise<void> {
  await client.query(
    `INSERT INTO saas_requests
       (id, tenant_id, project_id, proxy_key_id, entitlement_id, supply_profile_id,
        supply_profile_version, model_scope_version, supply_mode, principal_kind,
        principal_id, authz_version, entitlement_version, config_version, public_model,
        protocol, endpoint, request_fingerprint, request_fingerprint_version,
        execution_state, financial_status, reconciliation_state)
     VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 'byok', 'member', $7, 1, 1, 1,
        'fixture-model', 'openai', '/v1/chat/completions', $8, 'fixture-v1',
        'unknown', 'not_applicable', 'pending')`,
    [
      fixture.requestId,
      fixture.tenantId,
      fixture.projectId,
      fixture.apiKeyId,
      fixture.entitlementId,
      fixture.profileId,
      fixture.userId,
      'b'.repeat(64),
    ],
  );
  await client.query(
    `INSERT INTO saas_attempts
       (id, tenant_id, request_id, ordinal, upstream_id, resolved_model, protocol,
        dispatch_state, result_state, response_started, unknown_reason)
     VALUES ($1, $2, $3, 1, 'fixture-provider', 'fixture-model', 'openai',
        'unknown', 'unknown', false, 'migration-051 fixture')`,
    [fixture.attemptId, fixture.tenantId, fixture.requestId],
  );
}

async function seedMigration051AuditEvent(
  client: PoolClient,
  fixture: Migration051Fixture,
  targetId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO saas_audit_events
       (id, tenant_id, actor_user_id, action, target_type, target_id, entry_point)
     VALUES ($1, $2, $3, 'unknown_outcome_resolution', 'unknown_outcome_case', $4,
        'migration-051-test')`,
    [fixture.auditEventId, fixture.tenantId, fixture.userId, targetId],
  );
}

async function seedLegacyResolvedCase(client: PoolClient, fixture: Migration051Fixture, caseId: string): Promise<void> {
  await seedMigration051AuditEvent(client, fixture, caseId);
  await client.query(
    `INSERT INTO saas_unknown_outcome_reconciliation_cases
       (id, tenant_id, project_id, request_id, supply_mode, case_state,
        resolution_idempotency_key, resolution_digest, resolution_actor_user_id,
        resolution_reason, resolution_evidence_digest, resolution_audit_event_id, resolved_at)
     VALUES ($1, $2, $3, $4, 'byok', 'resolved', 'legacy-migration-051', $5, $6,
        'legacy resolved fixture', $7, $8, '2026-09-29T00:00:00Z')`,
    [
      caseId,
      fixture.tenantId,
      fixture.projectId,
      fixture.requestId,
      'c'.repeat(64),
      fixture.userId,
      'd'.repeat(64),
      fixture.auditEventId,
    ],
  );
}

function triggerBody(name: string): string {
  const match = sql.match(
    new RegExp(`CREATE FUNCTION ${name}\\(\\) RETURNS trigger\\nLANGUAGE plpgsql AS \\$\\$([\\s\\S]*?)\\n\\$\\$;`),
  );
  assert.ok(match, `expected migration SQL to define ${name}`);
  if (!match) throw new Error(`expected migration SQL to define ${name}`);
  return match[1];
}

function constraintBody(name: string): string {
  const match = sql.match(new RegExp(`ADD CONSTRAINT ${name}\\s+CHECK \\(([\\s\\S]*?)\\) NOT VALID;`));
  assert.ok(match, `expected migration SQL to define ${name}`);
  if (!match) throw new Error(`expected migration SQL to define ${name}`);
  return match[1];
}

test('migration 051 is registered in append order and remains forward-only', () => {
  assert.equal(migration.version, 51);
  assert.equal(migration.name, 'unknown_outcome_support_ticket');
  assert.equal(SAAS_MIGRATIONS[50], migration);
  assert.equal(SAAS_MIGRATIONS.filter(({ version }) => version === 51).length, 1);
  assert.deepEqual(
    SAAS_MIGRATIONS.map(({ version }) => version),
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|TRIGGER|FUNCTION)\b/i);
  assert.doesNotMatch(sql, /\bGRANT\s+/i);
  assert.match(
    readFileSync(resolve(process.cwd(), 'src/saas/db/migrations/001_initial_schema.ts'), 'utf8'),
    /UNKNOWN_OUTCOME_SUPPORT_TICKET_SAAS_MIGRATION/,
  );
});

test('migration 051 adds nullable, bounded support-ticket references with subquery-free control and whitespace fences', () => {
  assert.match(
    sql,
    /ALTER TABLE saas_unknown_outcome_reconciliation_cases\s+ADD COLUMN IF NOT EXISTS resolution_support_ticket_ref text;/,
  );
  assert.match(
    sql,
    /ALTER TABLE saas_unknown_outcome_reconciliation_observations\s+ADD COLUMN IF NOT EXISTS support_ticket_ref text;/,
  );
  for (const [column, constraint] of [
    ['resolution_support_ticket_ref', 'saas_unknown_outcome_cases_resolution_support_ticket_ref_check'],
    ['support_ticket_ref', 'saas_unknown_outcome_observations_support_ticket_ref_check'],
  ] as const) {
    const check = constraintBody(constraint);
    assert.match(sql, new RegExp(`char_length\\(${column}\\) BETWEEN 1 AND 255`));
    assert.match(sql, new RegExp(`btrim\\(${column}\\) = ${column}`));
    assert.match(sql, new RegExp(`${column} !~ '\\^\\[\\[:space:\\]\\]'`));
    assert.match(sql, new RegExp(`${column} !~ '\\[\\[:space:\\]\\]\\$'`));
    assert.match(sql, new RegExp(`${column} !~ '\\[\\[:cntrl:\\]\\]'`));
    assert.match(check, new RegExp(`${column} !~ '\\[\\[:cntrl:\\]\\]'`));
    assert.doesNotMatch(check, /\b(?:NOT EXISTS|generate_series)\b/);
  }
  assert.match(sql, /resolution_support_ticket_ref IS NULL OR case_state = 'resolved'/);
  assert.match(sql, /support_ticket_ref IS NULL OR observation_kind = 'operator_resolution'/);
  assert.match(sql, /External support-system locator only; it is not Provider evidence/);
});

test('migration 051 keeps observations append-only while requiring new operator resolutions to carry a ticket', () => {
  assert.match(
    UNKNOWN_OUTCOME_RECONCILIATION_SAAS_MIGRATION.sql,
    /CREATE TRIGGER saas_unknown_outcome_observations_immutable\s+BEFORE UPDATE OR DELETE ON saas_unknown_outcome_reconciliation_observations/,
  );
  assert.match(
    sql,
    /CREATE TRIGGER saas_unknown_outcome_support_ticket_observation_insert_guard\s+BEFORE INSERT ON saas_unknown_outcome_reconciliation_observations/,
  );
  assert.doesNotMatch(sql, /BEFORE UPDATE OR DELETE ON saas_unknown_outcome_reconciliation_observations/);
  const observationGuard = triggerBody('saas_guard_unknown_outcome_support_ticket_observation_insert');
  assert.match(observationGuard, /NEW\.observation_kind <> 'operator_resolution'/);
  assert.match(observationGuard, /NEW\.support_ticket_ref IS NULL/);
  assert.match(observationGuard, /existing\.support_ticket_ref IS DISTINCT FROM NEW\.support_ticket_ref/);
});

test('migration 051 preserves legacy resolved NULLs and fences every new resolved transition', () => {
  const caseGuard = triggerBody('saas_guard_unknown_outcome_support_ticket_case');
  assert.match(caseGuard, /OLD\.case_state = 'resolved'/);
  assert.match(caseGuard, /NEW\.resolution_support_ticket_ref IS DISTINCT FROM OLD\.resolution_support_ticket_ref/);
  assert.match(caseGuard, /A new resolved unknown-outcome case requires a support ticket reference/);
  assert.match(caseGuard, /NEW\.resolution_digest !~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /Legacy resolved rows remain NULL-compatible and are never backfilled/);
  assert.doesNotMatch(sql, /UPDATE saas_unknown_outcome_reconciliation_cases[\s\S]+resolution_support_ticket_ref\s*=/i);
});

test('case and operator-resolution observation references share one commit contract and the service digest includes it', () => {
  const contract = sql.match(
    /CREATE FUNCTION saas_validate_unknown_outcome_support_ticket_contract\(\)[\s\S]*?\n\$\$;/,
  )?.[0];
  assert.ok(contract);
  assert.match(contract, /current_resolution_digest/);
  assert.match(contract, /target_case_id/);
  assert.doesNotMatch(contract, /o\.case_id = case_id/);
  assert.match(contract, /o\.support_ticket_ref IS DISTINCT FROM current_support_ticket_ref/);
  assert.match(sql, /resolution_digest/);
  assert.match(
    workerSource,
    /JSON\.stringify\(\{ tenantId, caseId, actorUserId, supportTicketRef, idempotencyKey, reason, coverage \}\)/,
  );
});

test('migration 051 executes after its 049 schema prerequisite in a disposable schema without registry writes', {
  skip: migration051TestUrl
    ? false
    : 'MODEL_ROUTER_SAAS_MIGRATION_051_TEST_URL is not configured; isolated PostgreSQL execution is skipped',
}, async () => {
  if (!migration051TestUrl) return;

  const configuredDatabaseUrl = new URL(migration051TestUrl);
  assert.ok(configuredDatabaseUrl.port, 'the isolated PostgreSQL URL must specify its port explicitly');
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
  assert.ok(
    !loopbackHosts.has(configuredDatabaseUrl.hostname) || Number(configuredDatabaseUrl.port) > 1024,
    'loopback PostgreSQL tests must use a dedicated high port; CI service DNS may use its isolated 5432',
  );

  const pool = new PgPool({
    connectionString: migration051TestUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    application_name: 'model-router-migration-051-test',
  });
  const schema = `saas_migration_051_${randomUUID().replaceAll('-', '')}`;
  const fixture = createMigration051Fixture();
  const validFixture = {
    ...fixture,
    requestId: randomUUID(),
    attemptId: randomUUID(),
    auditEventId: randomUUID(),
  };
  const legacyCaseId = randomUUID();
  const validCaseId = randomUUID();
  const validObservationId = randomUUID();
  let client: PoolClient | undefined;
  let schemaCreated = false;
  let transactionOpen = false;

  try {
    const connectedClient = await pool.connect();
    client = connectedClient;
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await setMigration051SearchPath(client, schema);

    const migrationsThrough049 = SAAS_MIGRATIONS.filter(({ version }) => version <= 49);
    assert.deepEqual(
      migrationsThrough049.map(({ version }) => version),
      Array.from({ length: 49 }, (_, index) => index + 1),
      'the isolated fixture must replay registered migrations 001 through the 049 prerequisite',
    );

    for (const priorMigration of migrationsThrough049) {
      await client.query(priorMigration.sql);
      if (priorMigration.version === 6) {
        await seedMigration051Dependencies(client, fixture);
      }
      if (priorMigration.version === 10) {
        await seedMigration051Request(client, fixture);
        await seedMigration051Request(client, validFixture);
      }
    }

    const pre051Tables = await client.query<{ table_name: string; table_exists: boolean }>(
      `SELECT required.table_name,
                pg_catalog.to_regclass(pg_catalog.format('%I.%I', $1::text, required.table_name)) IS NOT NULL
                  AS table_exists
         FROM unnest($2::text[]) AS required(table_name)
        ORDER BY required.table_name`,
      [schema, ['saas_unknown_outcome_reconciliation_cases', 'saas_unknown_outcome_reconciliation_observations']],
    );
    assert.deepEqual(
      pre051Tables.rows,
      [
        { table_name: 'saas_unknown_outcome_reconciliation_cases', table_exists: true },
        { table_name: 'saas_unknown_outcome_reconciliation_observations', table_exists: true },
      ],
      'the isolated fixture must contain the 049 tables before 051 is applied',
    );

    await seedLegacyResolvedCase(client, fixture, legacyCaseId);

    // Execute the migration text itself.  Do not call the registry runner: 051
    // is intentionally outside the registry and this probe must not record it.
    await client.query(sql);

    const registry = await client.query<{ registry: string | null }>('SELECT pg_catalog.to_regclass($1) AS registry', [
      `${schema}.saas_schema_migrations`,
    ]);
    assert.equal(registry.rows[0]?.registry, null, 'the execution probe must not create migration history');

    const columns = await client.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1
          AND (
            (table_name = 'saas_unknown_outcome_reconciliation_cases'
              AND column_name = 'resolution_support_ticket_ref')
            OR (table_name = 'saas_unknown_outcome_reconciliation_observations'
              AND column_name = 'support_ticket_ref')
          )
        ORDER BY table_name, column_name`,
      [schema],
    );
    assert.deepEqual(columns.rows, [
      {
        table_name: 'saas_unknown_outcome_reconciliation_cases',
        column_name: 'resolution_support_ticket_ref',
        is_nullable: 'YES',
      },
      {
        table_name: 'saas_unknown_outcome_reconciliation_observations',
        column_name: 'support_ticket_ref',
        is_nullable: 'YES',
      },
    ]);

    const constraintNames = [
      'saas_unknown_outcome_cases_resolution_support_ticket_ref_check',
      'saas_unknown_outcome_cases_resolution_support_ticket_ref_state_check',
      'saas_unknown_outcome_observations_support_ticket_ref_check',
      'saas_unknown_outcome_observations_support_ticket_ref_kind_check',
    ];
    const postgresConstraintNames = constraintNames.map((name) => name.slice(0, 63));
    const constraints = await client.query<{
      constraint_name: string;
      constraint_type: string;
      validated: boolean;
      definition: string;
    }>(
      `SELECT constraint_record.conname AS constraint_name,
              constraint_record.contype AS constraint_type,
              constraint_record.convalidated AS validated,
              pg_catalog.pg_get_constraintdef(constraint_record.oid) AS definition
         FROM pg_catalog.pg_constraint AS constraint_record
         JOIN pg_catalog.pg_class AS relation_record
           ON relation_record.oid = constraint_record.conrelid
         JOIN pg_catalog.pg_namespace AS namespace_record
           ON namespace_record.oid = relation_record.relnamespace
        WHERE namespace_record.nspname = $1
          AND constraint_record.conname = ANY($2::text[])
        ORDER BY constraint_record.conname`,
      [schema, postgresConstraintNames],
    );
    assert.deepEqual(
      constraints.rows.map(({ constraint_name, constraint_type, validated }) => [
        constraint_name,
        constraint_type,
        validated,
      ]),
      postgresConstraintNames.sort().map((constraintName) => [constraintName, 'c', false]),
      '051 checks must be installed as NOT VALID constraints',
    );
    assert.match(
      constraints.rows.find(
        ({ constraint_name }) =>
          constraint_name === 'saas_unknown_outcome_cases_resolution_support_ticket_ref_state_check'.slice(0, 63),
      )?.definition ?? '',
      /case_state = 'resolved'/,
    );
    assert.match(
      constraints.rows.find(({ constraint_name }) => constraint_name.endsWith('support_ticket_ref_kind_check'))
        ?.definition ?? '',
      /observation_kind = 'operator_resolution'/,
    );

    const triggerNames = [
      'saas_unknown_outcome_observations_immutable',
      'saas_unknown_outcome_support_ticket_observation_insert_guard',
      'saas_unknown_outcome_support_ticket_case_guard',
      'saas_unknown_outcome_support_ticket_case_contract',
      'saas_unknown_outcome_support_ticket_observation_contract',
    ];
    const triggers = await client.query<{ trigger_name: string; definition: string }>(
      `SELECT trigger_record.tgname AS trigger_name,
              pg_catalog.pg_get_triggerdef(trigger_record.oid) AS definition
         FROM pg_catalog.pg_trigger AS trigger_record
         JOIN pg_catalog.pg_class AS relation_record
           ON relation_record.oid = trigger_record.tgrelid
         JOIN pg_catalog.pg_namespace AS namespace_record
           ON namespace_record.oid = relation_record.relnamespace
        WHERE namespace_record.nspname = $1
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgname = ANY($2::text[])
        ORDER BY trigger_record.tgname`,
      [schema, triggerNames],
    );
    assert.deepEqual(
      triggers.rows.map(({ trigger_name }) => trigger_name),
      triggerNames.sort(),
      '049 immutability and all 051 trigger layers must be installed',
    );
    assert.match(
      triggers.rows.find(
        ({ trigger_name }) => trigger_name === 'saas_unknown_outcome_support_ticket_observation_insert_guard',
      )?.definition ?? '',
      /BEFORE INSERT/,
    );
    assert.match(
      triggers.rows.find(({ trigger_name }) => trigger_name === 'saas_unknown_outcome_support_ticket_case_guard')
        ?.definition ?? '',
      /BEFORE INSERT OR UPDATE/,
    );
    assert.match(
      triggers.rows.find(
        ({ trigger_name }) => trigger_name === 'saas_unknown_outcome_support_ticket_observation_contract',
      )?.definition ?? '',
      /DEFERRABLE INITIALLY DEFERRED/,
    );

    const legacyCase = await client.query<{ resolution_support_ticket_ref: string | null }>(
      `SELECT resolution_support_ticket_ref
         FROM saas_unknown_outcome_reconciliation_cases
        WHERE id = $1`,
      [legacyCaseId],
    );
    assert.deepEqual(legacyCase.rows, [{ resolution_support_ticket_ref: null }]);

    const supportTicketRef = 'SUP-051-VALID';
    await seedMigration051AuditEvent(client, validFixture, validCaseId);
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(
      `INSERT INTO saas_unknown_outcome_reconciliation_cases
         (id, tenant_id, project_id, request_id, supply_mode, case_state,
          resolution_idempotency_key, resolution_digest, resolution_actor_user_id,
          resolution_reason, resolution_evidence_digest, resolution_audit_event_id,
          resolved_at, resolution_support_ticket_ref)
       VALUES ($1, $2, $3, $4, 'byok', 'resolved', 'valid-migration-051', $5, $6,
          'valid resolution fixture', $7, $8, '2026-09-29T00:00:00Z', $9)`,
      [
        validCaseId,
        fixture.tenantId,
        fixture.projectId,
        validFixture.requestId,
        'e'.repeat(64),
        fixture.userId,
        'f'.repeat(64),
        validFixture.auditEventId,
        supportTicketRef,
      ],
    );
    await client.query(
      `INSERT INTO saas_unknown_outcome_reconciliation_observations
         (id, tenant_id, case_id, request_id, attempt_id, observation_kind,
          evidence_reference, operator_outcome, actor_user_id, reason, audit_event_id,
          support_ticket_ref)
       VALUES ($1, $2, $3, $4, $5, 'operator_resolution', $6, 'not_executed',
          $7, $8, $9, $10)`,
      [
        validObservationId,
        fixture.tenantId,
        validCaseId,
        validFixture.requestId,
        validFixture.attemptId,
        `support-ticket://${supportTicketRef}`,
        fixture.userId,
        'valid resolution fixture',
        validFixture.auditEventId,
        supportTicketRef,
      ],
    );
    await client.query('COMMIT');
    transactionOpen = false;

    const committedCase = await client.query<{
      case_state: string;
      resolution_support_ticket_ref: string | null;
    }>(
      `SELECT case_state, resolution_support_ticket_ref
         FROM saas_unknown_outcome_reconciliation_cases
        WHERE id = $1`,
      [validCaseId],
    );
    assert.deepEqual(committedCase.rows, [{ case_state: 'resolved', resolution_support_ticket_ref: supportTicketRef }]);
    const committedObservation = await client.query<{ support_ticket_ref: string | null }>(
      `SELECT support_ticket_ref
         FROM saas_unknown_outcome_reconciliation_observations
        WHERE id = $1`,
      [validObservationId],
    );
    assert.deepEqual(committedObservation.rows, [{ support_ticket_ref: supportTicketRef }]);

    const invalidResolvedCase = randomUUID();
    await assertPostgresError(
      () =>
        connectedClient.query(
          `INSERT INTO saas_unknown_outcome_reconciliation_cases
             (id, tenant_id, project_id, request_id, supply_mode, case_state,
              resolution_idempotency_key, resolution_digest, resolution_actor_user_id,
              resolution_reason, resolution_evidence_digest, resolution_audit_event_id,
              resolved_at)
           VALUES ($1, $2, $3, $4, 'byok', 'resolved', 'missing-ticket-migration-051', $5, $6,
              'invalid resolution fixture', $7, $8, '2026-09-29T00:00:00Z')`,
          [
            invalidResolvedCase,
            fixture.tenantId,
            fixture.projectId,
            fixture.requestId,
            '1'.repeat(64),
            fixture.userId,
            '2'.repeat(64),
            fixture.auditEventId,
          ],
        ),
      '23514',
      /requires a support ticket reference/,
    );

    const invalidObservationId = randomUUID();
    await assertPostgresError(
      () =>
        connectedClient.query(
          `INSERT INTO saas_unknown_outcome_reconciliation_observations
             (id, tenant_id, case_id, request_id, attempt_id, observation_kind,
              evidence_reference, operator_outcome, actor_user_id, reason, audit_event_id)
           VALUES ($1, $2, $3, $4, $5, 'operator_resolution', $6, 'not_executed',
              $7, $8, $9)`,
          [
            invalidObservationId,
            fixture.tenantId,
            validCaseId,
            fixture.requestId,
            fixture.attemptId,
            'support-ticket://missing-ref',
            fixture.userId,
            'missing ticket fixture',
            fixture.auditEventId,
          ],
        ),
      '23514',
      /requires a valid support ticket reference/,
    );

    const mismatchedObservationId = randomUUID();
    await assertPostgresError(
      () =>
        connectedClient.query(
          `INSERT INTO saas_unknown_outcome_reconciliation_observations
             (id, tenant_id, case_id, request_id, attempt_id, observation_kind,
              evidence_reference, operator_outcome, actor_user_id, reason, audit_event_id,
              support_ticket_ref)
           VALUES ($1, $2, $3, $4, $5, 'operator_resolution', $6, 'not_executed',
              $7, $8, $9, $10)`,
          [
            mismatchedObservationId,
            fixture.tenantId,
            validCaseId,
            validFixture.requestId,
            validFixture.attemptId,
            'support-ticket://mismatch',
            fixture.userId,
            'mismatch fixture',
            validFixture.auditEventId,
            'SUP-051-MISMATCH',
          ],
        ),
      '23514',
      /references differ|must use one support ticket reference/,
    );

    const nonOperatorObservationId = randomUUID();
    await assertPostgresError(
      () =>
        connectedClient.query(
          `INSERT INTO saas_unknown_outcome_reconciliation_observations
             (id, tenant_id, case_id, request_id, observation_kind, supply_mode,
              execution_state, reconciliation_state, financial_status, request_state_version,
              support_ticket_ref)
           VALUES ($1, $2, $3, $4, 'request_snapshot', 'byok', 'unknown', 'pending',
              'not_applicable', 1, 'SUP-051-NON-OPERATOR')`,
          [nonOperatorObservationId, fixture.tenantId, validCaseId, validFixture.requestId],
        ),
      '23514',
      /support_ticket_ref_kind_check/,
    );

    await assertPostgresError(
      () =>
        connectedClient.query(
          `UPDATE saas_unknown_outcome_reconciliation_cases
              SET resolution_support_ticket_ref = 'SUP-051-CHANGED'
            WHERE id = $1`,
          [validCaseId],
        ),
      '55000',
      /immutable/,
    );
    await assertPostgresError(
      () =>
        connectedClient.query(
          `UPDATE saas_unknown_outcome_reconciliation_observations
              SET reason = 'changed after append'
            WHERE id = $1`,
          [validObservationId],
        ),
      '55000',
      /immutable/,
    );
  } finally {
    if (transactionOpen && client) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    client?.release();
    if (schemaCreated) {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await pool.end();
  }
});
