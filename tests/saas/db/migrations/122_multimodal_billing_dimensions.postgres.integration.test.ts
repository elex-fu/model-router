import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';
import { SaasPricingService } from '../../../../src/saas/pricing/service.js';
import type { PriceHoldInput } from '../../../../src/saas/pricing/types.js';

/**
 * Batch 4 §4.1 (task #15) migration 122 gate on the real disposable
 * PostgreSQL database: the per-unit columns/CHECKs exist and enforce, the
 * recreated 024 immutability function freezes the new evidence columns, the
 * re-applied role template grants the gateway the new INSERT columns, and
 * the full per-unit billing chain (version registration → customer price
 * snapshot with the media hold witness → usage settlement) runs against
 * live SQL. Same env contract as the 112/121 gates.
 */
const required = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roles = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configured = roles.map(([name]) => process.env[name]?.trim());
function safeRoleUrls(): string[] {
  let target: string | undefined;
  return roles.map(([name, role], index) => {
    const value = configured[index];
    assert.ok(value, `${name} is required for the 122 gate`);
    let url: URL;
    let user: string;
    let database: string;
    try {
      url = new URL(value);
      user = decodeURIComponent(url.username);
      database = decodeURIComponent(url.pathname.slice(1));
    } catch {
      throw new Error(`${name} must be a valid PostgreSQL URL`);
    }
    assert.ok(user === role, `${name} must use its exact managed role`);
    const host = url.hostname.toLowerCase();
    const port = Number(url.port);
    const ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local =
      ['127.0.0.1', '[::1]'].includes(host) &&
      Boolean(url.port) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535 &&
      ![5432, 6432].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, `${name} must use designated CI or an explicit disposable exact-loopback target`);
    const identity = `${host}:${port}/${database}`;
    target ??= identity;
    assert.ok(identity === target, 'all 122 roles must use the same disposable target');
    return value;
  });
}

const RUN = randomUUID();

test('122 multimodal billing dimensions hold on live PostgreSQL (columns, CHECKs, immutability, chain)', {
  skip: process.env[required] !== '1' ? `set ${required}=1 with the disposable role-template database` : false,
}, async () => {
  const [migratorUrl, , gatewayUrl] = safeRoleUrls();
  const migrator: SaasDatabase = createSaasDatabase({ connectionString: migratorUrl, max: 2 });
  const gateway: SaasDatabase = createSaasDatabase({ connectionString: gatewayUrl, max: 2 });
  try {
    const applied = await migrator.query<{ version: number; name: string }>(
      'SELECT version, name FROM model_router_saas.saas_schema_migrations WHERE version = 122',
    );
    assert.equal(applied.rows.length, 1, 'migration 122 must be applied');
    assert.equal(applied.rows[0]?.name, 'multimodal_billing_dimensions');

    // --- The per-unit columns on both price-version tables. ---
    const versionColumns = await migrator.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'model_router_saas'
          AND table_name IN ('saas_customer_price_versions', 'saas_supplier_cost_versions')
          AND column_name IN ('per_unit_rate_numerator_minor_units', 'per_unit_rate_denominator_units',
                              'per_unit_tier_rates', 'token_multipliers')`,
    );
    const seen = new Set(versionColumns.rows.map((row) => `${row.table_name}.${row.column_name}`));
    for (const table of ['saas_customer_price_versions', 'saas_supplier_cost_versions']) {
      for (const column of [
        'per_unit_rate_numerator_minor_units',
        'per_unit_rate_denominator_units',
        'per_unit_tier_rates',
        'token_multipliers',
      ]) {
        assert.ok(seen.has(`${table}.${column}`), `${table}.${column} must exist`);
      }
    }
    for (const [table, column, type, nullable] of [
      ['saas_request_customer_price_snapshots', 'hold_input_per_unit_units', 'bigint', 'NO'],
      ['saas_request_customer_price_snapshots', 'hold_input_size_tier', 'text', 'YES'],
      ['saas_usage_events', 'billing_mode', 'text', 'NO'],
      ['saas_usage_events', 'units', 'bigint', 'YES'],
      ['saas_usage_events', 'size_tier', 'text', 'YES'],
      ['saas_prepared_request_evidence', 'usage_per_unit_units_upper_bound', 'bigint', 'NO'],
      ['saas_prepared_request_evidence', 'usage_size_tier', 'text', 'YES'],
    ] as const) {
      const columnInfo = await migrator.query<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'model_router_saas' AND table_name = $1 AND column_name = $2`,
        [table, column],
      );
      assert.equal(columnInfo.rows[0]?.data_type, type, `${table}.${column} type`);
      assert.equal(columnInfo.rows[0]?.is_nullable, nullable, `${table}.${column} nullability`);
      // Every NOT NULL column carries its neutral DEFAULT (anti-drift).
      if (nullable === 'NO') {
        assert.ok(columnInfo.rows[0]?.column_default, `${table}.${column} must default`);
      }
    }

    // --- The CHECK constraints enforce the registry and shapes. ---
    const label = `mm122-${RUN}`;
    const nowIso = new Date().toISOString();
    await migrator.query(
      `INSERT INTO model_router_saas.saas_provider_products (provider_id, product_id, display_name)
       VALUES ($1, $1, $1)`,
      [`${label}-provider`],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_public_models (id, alias, display_name)
       VALUES ($1, $1, $1)`,
      [`${label}-model`],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_public_model_versions
         (public_model_id, version, provider_id, product_id, model, endpoint_scope)
       VALUES ($1, 1, $2, $2, $2, ARRAY['images.generations'])`,
      [`${label}-model`, `${label}-provider`],
    );

    const insertVersion = async (
      rates: { readonly numerator: string | null; readonly denominator: string | null },
      tiers: unknown,
      multipliers: unknown,
    ) =>
      migrator.query(
        `INSERT INTO model_router_saas.saas_customer_price_versions
           (id, version, public_model_id, public_model_version, provider_id, product_id, protocol, endpoint,
            currency, commercial_policy_version, calculator_version, rounding_version, rounding_mode,
            rounding_boundary, input_rate_numerator_minor_units, input_rate_denominator_units,
            output_rate_numerator_minor_units, output_rate_denominator_units,
            per_unit_rate_numerator_minor_units, per_unit_rate_denominator_units,
            per_unit_tier_rates, token_multipliers, effective_at, idempotency_key, definition_digest)
         VALUES ($1, 1, $2, 1, $3, $3, 'openai', 'images.generations', 'USD', $4, $4, $4, 'half_up', 'total',
                 0, 1, 0, 1, $5, $6, $7::jsonb, $8::jsonb, $9, $4, $10)`,
        [
          `${label}-price`,
          `${label}-model`,
          `${label}-provider`,
          `${label}-policy`,
          rates.numerator,
          rates.denominator,
          tiers === null ? null : JSON.stringify(tiers),
          multipliers === null ? null : JSON.stringify(multipliers),
          nowIso,
          'a'.repeat(64),
        ],
      );

    // An off-registry tier key is rejected by the shape CHECK.
    await assert.rejects(
      () =>
        insertVersion(
          { numerator: '1000', denominator: '1' },
          { '8k': { numeratorMinorUnits: '1', denominatorUnits: '1' } },
          null,
        ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    // A non-registry service tier is rejected in the multiplier policy.
    await assert.rejects(
      () =>
        insertVersion(
          { numerator: '1000', denominator: '1' },
          { '1k': { numeratorMinorUnits: '1', denominatorUnits: '1' } },
          { serviceTiers: { turbo: { numerator: '2', denominator: '1' } } },
        ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    // A denominator-only per-unit pair violates the pair CHECK.
    await assert.rejects(
      () => insertVersion({ numerator: null, denominator: '1' }, null, null),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    // A well-formed row registers.
    await insertVersion(
      { numerator: '1000', denominator: '1' },
      { '1k': { numeratorMinorUnits: '500', denominatorUnits: '1' } },
      { serviceTiers: { flex: { numerator: '1', denominator: '2' } } },
    );

    // --- The recreated 024 immutability function freezes the new columns. ---
    // The live function body (the artifact migration 122 replaces via CREATE
    // OR REPLACE, keeping the trigger bound to the same OID) enumerates the
    // new columns in BOTH the OLD and the NEW ROW shapes, and the trigger
    // remains attached. A behavioral UPDATE probe runs in the shared 024-
    // family gates, which own the full evidence FK chain seeding.
    const functionDef = await migrator.query<{ definition: string }>(
      `SELECT pg_get_functiondef('model_router_saas.saas_prepared_request_evidence_immutable()'::regprocedure) AS definition`,
    );
    const definition = functionDef.rows[0]?.definition ?? '';
    assert.match(definition, /OLD\.usage_per_unit_units_upper_bound, OLD\.usage_size_tier/);
    assert.match(definition, /NEW\.usage_per_unit_units_upper_bound, NEW\.usage_size_tier/);
    assert.match(definition, /RAISE EXCEPTION 'Prepared-request evidence facts are immutable'/);
    const triggers = await migrator.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'model_router_saas.saas_prepared_request_evidence'::regclass
          AND tgname = 'saas_prepared_request_evidence_immutable' AND NOT tgisinternal`,
    );
    assert.equal(triggers.rows.length, 1, 'the immutability trigger must remain attached');

    // --- The gateway role holds the new INSERT columns (grants mirror). ---
    const gatewayProbe = await gateway.query(
      `SELECT has_column_privilege('model_router_saas.saas_usage_events', 'billing_mode', 'INSERT') AS billing_mode,
              has_column_privilege('model_router_saas.saas_usage_events', 'units', 'INSERT') AS units,
              has_column_privilege('model_router_saas.saas_usage_events', 'size_tier', 'INSERT') AS size_tier,
              has_column_privilege('model_router_saas.saas_request_customer_price_snapshots', 'hold_input_per_unit_units', 'INSERT') AS hold_units,
              has_column_privilege('model_router_saas.saas_request_customer_price_snapshots', 'hold_input_size_tier', 'INSERT') AS hold_tier,
              has_column_privilege('model_router_saas.saas_usage_events', 'billing_mode', 'SELECT') AS select_billing_mode,
              has_column_privilege('model_router_saas.saas_usage_events', 'billing_mode', 'UPDATE') AS update_billing_mode`,
    );
    assert.deepEqual(
      gatewayProbe.rows[0],
      {
        billing_mode: true,
        units: true,
        size_tier: true,
        hold_units: true,
        hold_tier: true,
        // Read tables carry the dynamic all-column SELECT; UPDATE stays denied.
        select_billing_mode: true,
        update_billing_mode: false,
      },
      'the gateway role must hold exactly the mirrored INSERT grants',
    );

    // --- The full per-unit billing chain against live SQL. ---
    // Seed the request FK chain (tenant → user → project → membership → key
    // → entitlement → supply profile → route/policy/attestation → request).
    const tenantUuid = randomUUID();
    const userUuid = randomUUID();
    const projectUuid = randomUUID();
    const keyUuid = randomUUID();
    const entitlementUuid = randomUUID();
    const requestUuid2 = randomUUID();
    const keyHash = createHash('sha256').update(keyUuid).digest('hex');
    const profileId = `${label}-profile`;
    const routeId = `${label}-route`;
    const customerPolicyId = `${label}-customer-policy`;
    const providerPolicyId = `${label}-provider-policy`;
    const attestationId = `${label}-attestation`;
    await migrator.query(`INSERT INTO model_router_saas.saas_tenants (id, name, slug) VALUES ($1, $2, $2)`, [
      tenantUuid,
      label,
    ]);
    await migrator.query(`INSERT INTO model_router_saas.saas_users (id, email) VALUES ($1, $2)`, [
      userUuid,
      `${label}@example.test`,
    ]);
    await migrator.query(
      `INSERT INTO model_router_saas.saas_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [tenantUuid, userUuid],
    );
    // The project insert's head-guard trigger creates the active version-2
    // policy row for inference_policy_version = 2.
    await migrator.query(
      `INSERT INTO model_router_saas.saas_projects
         (tenant_id, id, name, slug, inference_policy_version, inference_policy_status)
       VALUES ($1, $2, $3, $3, 2, 'active')`,
      [tenantUuid, projectUuid, label],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_project_memberships (tenant_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [tenantUuid, projectUuid, userUuid],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_supply_profiles
         (tenant_id, id, supply_mode, status, model_scopes)
       VALUES ($1, $2, 'platform', 'active', ARRAY[$3])`,
      [tenantUuid, profileId, `${label}-model`],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_project_entitlements
         (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes)
       VALUES ($1, $2, $3, $4, 'platform', ARRAY[$5])`,
      [entitlementUuid, tenantUuid, projectUuid, profileId, `${label}-model`],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_api_keys
         (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode, entitlement_id,
          entitlement_authz_version, supply_profile_authz_version,
          execution_principal_type, execution_principal_id, created_by_user_id,
          name, prefix, key_hash, model_scopes)
       VALUES ($1, $2, $3, $4, $5, 'platform', $10, 1, 1, 'member', $4, $4, $6, $7, $8, ARRAY[$9])`,
      [
        keyUuid,
        tenantUuid,
        projectUuid,
        userUuid,
        profileId,
        label,
        `mr_live_${label.replace(/-/g, '').slice(0, 16)}`,
        keyHash,
        `${label}-model`,
        entitlementUuid,
      ],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_route_config_versions
         (tenant_id, project_id, route_id, version, status, public_model_id, public_model_version,
          protocol, supply_mode, target_mode, upstream_id, endpoint, changed_by_user_id)
       VALUES ($1, $2, $3, 1, 'active', $4, 1, 'openai', 'platform', 'platform_pool', $5,
               'images.generations', $6)`,
      [tenantUuid, projectUuid, routeId, `${label}-model`, `${label}-upstream`, userUuid],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_route_config_heads
         (tenant_id, project_id, route_id, current_version, status, changed_by_user_id)
       VALUES ($1, $2, $3, 1, 'active', $4)`,
      [tenantUuid, projectUuid, routeId, userUuid],
    );

    const pricing = new SaasPricingService(migrator, {
      now: () => new Date('2026-10-17T00:00:00Z'),
      idFactory: () => `${label}-${randomUUID()}`,
    });
    const perUnitRates = {
      input: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      output: { numeratorMinorUnits: 0, denominatorUnits: 1 },
      per_unit: { numeratorMinorUnits: '1000', denominatorUnits: '1' },
      per_unit_tiers: {
        '1k': { numeratorMinorUnits: '500', denominatorUnits: '1' },
        '4k': { numeratorMinorUnits: '4000', denominatorUnits: '1' },
      },
    };
    const identity = {
      publicModelId: `${label}-model`,
      publicModelVersion: 1,
      providerId: `${label}-provider`,
      productId: `${label}-provider`,
      protocol: 'openai',
      endpoint: 'images.generations',
      currency: 'USD',
    };
    const customer = await pricing.appendCustomerPriceVersion({
      ...identity,
      idempotencyKey: `${label}-customer`,
      effectiveAt: '2026-01-01T00:00:00.000Z',
      commercialPolicyVersion: `${label}-policy`,
      calculatorVersion: `${label}-calculator`,
      roundingVersion: `${label}-rounding`,
      roundingMode: 'half_up',
      rates: perUnitRates,
      tokenMultipliers: {
        serviceTiers: { flex: { numerator: '1', denominator: '2' } },
        longContext: {
          inputThreshold: '200000',
          thresholdInclusive: true,
          inputMultiplier: { numerator: '2', denominator: '1' },
          outputMultiplier: { numerator: '3', denominator: '2' },
        },
      },
    });
    // Registration round-trips the whole per-unit family from live storage.
    assert.equal(customer.rates.per_unit?.numeratorMinorUnits, 1000n);
    assert.deepEqual(Object.keys(customer.rates.per_unit_tiers ?? {}).sort(), ['1k', '4k']);
    assert.ok(customer.tokenMultipliers !== null);
    assert.equal(customer.tokenMultipliers.serviceTiers.flex?.numerator, 1n);
    assert.equal(customer.tokenMultipliers.longContext?.inputThreshold, 200000n);
    // Idempotent replay under the same key (identical terms, including the
    // multiplier policy) returns the same row with its own digest.
    const replay = await pricing.appendCustomerPriceVersion({
      ...identity,
      idempotencyKey: `${label}-customer`,
      effectiveAt: '2026-01-01T00:00:00.000Z',
      commercialPolicyVersion: `${label}-policy`,
      calculatorVersion: `${label}-calculator`,
      roundingVersion: `${label}-rounding`,
      roundingMode: 'half_up',
      rates: perUnitRates,
      tokenMultipliers: {
        serviceTiers: { flex: { numerator: '1', denominator: '2' } },
        longContext: {
          inputThreshold: '200000',
          thresholdInclusive: true,
          inputMultiplier: { numerator: '2', denominator: '1' },
          outputMultiplier: { numerator: '3', denominator: '2' },
        },
      },
    });
    assert.equal(replay.id, customer.id);
    assert.equal(replay.definitionDigest, customer.definitionDigest);

    const supplier = await pricing.appendSupplierCostVersion({
      ...identity,
      resolvedModel: `${label}-provider-model`,
      idempotencyKey: `${label}-supplier`,
      effectiveAt: '2026-01-01T00:00:00.000Z',
      commercialPolicyVersion: `${label}-policy`,
      calculatorVersion: `${label}-calculator`,
      roundingVersion: `${label}-rounding`,
      roundingMode: 'half_up',
      rates: {
        input: { numeratorMinorUnits: 0, denominatorUnits: 1 },
        output: { numeratorMinorUnits: 0, denominatorUnits: 1 },
        per_unit: { numeratorMinorUnits: '400', denominatorUnits: '1' },
        per_unit_tiers: { '1k': { numeratorMinorUnits: '200', denominatorUnits: '1' } },
      },
    });

    // Bind the prices to the route through the commercial authority chain
    // (policy versions + heads, contract attestation, route authority), then
    // seed the request and its attempt.
    await migrator.query(
      `INSERT INTO model_router_saas.saas_customer_metering_policy_versions
         (tenant_id, project_id, policy_id, version, status, public_model_id, public_model_version,
          protocol, endpoint, supply_mode, target_mode, customer_price_version, usage_dimensions,
          token_source, rounding_version, rounding_mode, rounding_boundary, commercial_policy_version,
          changed_by_user_id)
       VALUES ($1, $2, $3, 1, 'active', $4, 1, 'openai', 'images.generations', 'platform', 'platform_pool',
               $5, ARRAY['input_total', 'output_total'], 'upstream', $6, 'half_up', 'total', $6, $7)`,
      [tenantUuid, projectUuid, customerPolicyId, `${label}-model`, customer.id, `${label}-rounding`, userUuid],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_customer_metering_policy_heads
         (tenant_id, project_id, policy_id, current_version, status, changed_by_user_id)
       VALUES ($1, $2, $3, 1, 'active', $4)`,
      [tenantUuid, projectUuid, customerPolicyId, userUuid],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_provider_metering_policy_versions
         (tenant_id, project_id, policy_id, version, status, public_model_id, public_model_version,
          provider_id, product_id, resolved_model, protocol, endpoint, supply_mode, target_mode,
          supplier_cost_version, usage_dimensions, token_source, rounding_version, rounding_mode,
          rounding_boundary, commercial_policy_version, changed_by_user_id)
       VALUES ($1, $2, $3, 1, 'active', $4, 1, $5, $5, $6, 'openai', 'images.generations', 'platform',
               'platform_pool', $7, ARRAY['input_total', 'output_total'], 'upstream', $8, 'half_up',
               'total', $8, $9)`,
      [
        tenantUuid,
        projectUuid,
        providerPolicyId,
        `${label}-model`,
        `${label}-provider`,
        `${label}-provider-model`,
        supplier.id,
        `${label}-rounding`,
        userUuid,
      ],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_provider_metering_policy_heads
         (tenant_id, project_id, policy_id, current_version, status, changed_by_user_id)
       VALUES ($1, $2, $3, 1, 'active', $4)`,
      [tenantUuid, projectUuid, providerPolicyId, userUuid],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_contract_test_attestations
         (tenant_id, project_id, id, provider_policy_id, provider_policy_version, public_model_id,
          public_model_version, protocol, endpoint, supply_mode, target_mode, contract_digest,
          suite_version, test_vector_digest, verifier_key_id, signature_base64, verification_result,
          verified_at)
       VALUES ($1, $2, $3, $4, 1, $5, 1, 'openai', 'images.generations', 'platform', 'platform_pool',
               $6, 'suite-v1', $7, $8, $9, 'verified', now())`,
      [
        tenantUuid,
        projectUuid,
        attestationId,
        providerPolicyId,
        `${label}-model`,
        '1'.repeat(64),
        '2'.repeat(64),
        `${label}-verifier`,
        'c2lnbmF0dXJl',
      ],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_route_config_commercial_authorities
         (tenant_id, project_id, route_id, route_version, customer_policy_id, customer_policy_version,
          provider_policy_id, provider_policy_version, contract_attestation_id, customer_price_version,
          supplier_cost_version, created_by_user_id)
       VALUES ($1, $2, $3, 1, $4, 1, $5, 1, $6, $7, $8, $9)`,
      [
        tenantUuid,
        projectUuid,
        routeId,
        customerPolicyId,
        providerPolicyId,
        attestationId,
        customer.id,
        supplier.id,
        userUuid,
      ],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_requests
         (id, tenant_id, project_id, proxy_key_id, entitlement_id, supply_profile_id, supply_profile_version,
          model_scope_version, supply_mode, principal_kind, principal_id, authz_version, entitlement_version,
          config_version, project_policy_version, route_config_id, route_config_version, route_public_model_id,
          route_public_model_version, route_protocol, route_target_mode, route_upstream_id,
          customer_metering_policy_id, customer_metering_policy_version, provider_metering_policy_id,
          provider_metering_policy_version, contract_attestation_id, customer_price_version,
          public_model, protocol, endpoint, request_fingerprint, request_fingerprint_version,
          financial_status)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 'platform', 'member', $7, 1, 1, 1, 2, $8, 1, $9, 1,
               'openai', 'platform_pool', $10, $11, 1, $12, 1, $13, $14, $15, 'openai',
               'images.generations', $16, 'canonical-v1', 'pending')`,
      [
        requestUuid2,
        tenantUuid,
        projectUuid,
        keyUuid,
        entitlementUuid,
        profileId,
        userUuid,
        routeId,
        `${label}-model`,
        `${label}-upstream`,
        customerPolicyId,
        providerPolicyId,
        attestationId,
        customer.id,
        `${label}-model`,
        'f'.repeat(64),
      ],
    );
    // The usage-event media CHECKs exist as live constraints (their
    // vocabulary enforcement is additionally covered by the static migration
    // test and the metering unit suite; a live insert probe would need the
    // full attempt supply chain owned by the 058-family gates).
    const usageChecks = await migrator.query<{ conname: string; pg_get_constraintdef: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS pg_get_constraintdef
         FROM pg_constraint
        WHERE conrelid = 'model_router_saas.saas_usage_events'::regclass
          AND conname LIKE 'saas_usage_events%'
          AND pg_get_constraintdef(oid) LIKE '%billing_mode%'`,
    );
    assert.equal(usageChecks.rows.length, 1);
    assert.match(usageChecks.rows[0].pg_get_constraintdef, /'token'.*'per_request'.*'image'.*'video'.*'audio'/);

    // The media hold witness snapshot: 3 units at the 4k tier = 12000 held.
    const holdInput: PriceHoldInput = {
      inputTotal: 0,
      inputUncached: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      outputTotal: 0,
      reasoningOutput: 0,
      perUnitUnits: '3',
      sizeTier: '4k',
    };
    const snapshot = await pricing.createCustomerPriceSnapshot({
      tenantId: tenantUuid,
      requestId: requestUuid2,
      customerPriceVersion: customer.id,
      holdInput,
      admissionExpiresAt: '2026-10-17T00:05:00.000Z',
      idempotencyKey: requestUuid2,
    });
    assert.equal(snapshot.snapshot.holdAmountMinorUnits, 12000n);
    assert.equal(snapshot.snapshot.holdInput.perUnitUnits, 3n);
    assert.equal(snapshot.snapshot.holdInput.sizeTier, '4k');
    // The snapshot row persists the witness columns on live SQL.
    const storedSnapshot = await migrator.query<{ hold_input_per_unit_units: string; hold_input_size_tier: string }>(
      `SELECT hold_input_per_unit_units::text, hold_input_size_tier
         FROM model_router_saas.saas_request_customer_price_snapshots WHERE id = $1`,
      [snapshot.snapshot.id],
    );
    assert.equal(storedSnapshot.rows[0]?.hold_input_per_unit_units, '3');
    assert.equal(storedSnapshot.rows[0]?.hold_input_size_tier, '4k');

    // Settlement with media usage: 2 units at the 1k tier.
    const settlement = await pricing.calculateSettlement({
      customerPriceVersion: customer.id,
      supplierCostVersion: supplier.id,
      usage: {
        inputTotal: null,
        inputUncached: null,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
        outputTotal: null,
        reasoningOutput: null,
        perUnitUnits: '2',
        sizeTier: '1k',
      },
      requireComplete: true,
    });
    // Customer: 2 × 500 = 1000; supplier: 2 × 200 = 400 (its 1k tier).
    assert.equal(settlement.customer.amountMinorUnits, 1000n);
    assert.equal(settlement.customer.complete, true);
    assert.deepEqual(settlement.customer.chargedMetrics, ['per_unit']);
    assert.equal(settlement.supplier.amountMinorUnits, 400n);

    // A tier the version does not price fails closed on live SQL too.
    await assert.rejects(
      () =>
        pricing.calculateSettlement({
          customerPriceVersion: customer.id,
          supplierCostVersion: supplier.id,
          usage: {
            inputTotal: null,
            inputUncached: null,
            cacheRead: null,
            cacheWrite: null,
            cacheWrite5m: null,
            cacheWrite1h: null,
            outputTotal: null,
            reasoningOutput: null,
            perUnitUnits: '2',
            sizeTier: '720p',
          },
          requireComplete: true,
        }),
      (error: unknown) => (error as { code?: string }).code === 'PRICE_RATE_MISSING',
    );
  } finally {
    await migrator.close();
    await gateway.close();
  }
});
