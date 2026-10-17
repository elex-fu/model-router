import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SaasBillingGroupsService } from '../../../src/saas/billing/groups/service.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { SaasModelPlazaService } from '../../../src/saas/gateway/model-plaza/service.js';
import { resolveModelPlazaSettings } from '../../../src/saas/gateway/model-plaza/settings.js';
import { PostgresModelPlazaFacts } from '../../../src/saas/gateway/model-plaza/store.js';
import type { ModelPlazaAccess, ModelPlazaSettings } from '../../../src/saas/gateway/model-plaza/types.js';
import { SaasPricingService } from '../../../src/saas/pricing/service.js';

/*
 * Model plaza PostgreSQL gate (task #22): validates the zero-storage facts
 * SQL (catalog targets × account pools × capabilities) and the same-chain
 * price resolution (`resolveCustomerPriceVersion` on the snapshot executor)
 * under the real restricted gateway role, against the same disposable
 * database contract as the other gateway gates.
 */

const REQUIRED_FLAG = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roleUrls = {
  migrator: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL?.trim(),
  control_plane: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL?.trim(),
  gateway: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL?.trim(),
};
const anyConfigured = Object.values(roleUrls).some(Boolean);

function disposableRoleTargets(): Record<keyof typeof roleUrls, string> {
  let target: string | undefined;
  const validated = {} as Record<keyof typeof roleUrls, string>;
  for (const role of Object.keys(roleUrls) as Array<keyof typeof roleUrls>) {
    const value = roleUrls[role];
    assert.ok(value, `the disposable gateway E2E ${role} URL is required`);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`the disposable gateway E2E ${role} URL must be a valid PostgreSQL URL`);
    }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'the test target must be PostgreSQL');
    assert.equal(decodeURIComponent(parsed.username), `model_router_saas_${role}`);
    assert.equal(parsed.hash, '', 'database URL fragments are not supported');
    assert.equal(parsed.search, '', 'database URLs must not carry connection overrides');
    const hostname = parsed.hostname.toLowerCase();
    const port = Number(parsed.port);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    const ciTarget = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const localTarget =
      ['127.0.0.1', '[::1]'].includes(hostname) &&
      Boolean(parsed.port) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535 &&
      ![5432, 6432].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(
      ciTarget || localTarget,
      'use the designated CI service or a disposable model_router_saas_ci/model_router_test_* loopback database on an explicit nondefault port',
    );
    const currentTarget = `${hostname}:${port}/${database}`;
    target ??= currentTarget;
    assert.equal(currentTarget, target, 'all three roles must use the same disposable database');
    validated[role] = value;
  }
  return validated;
}

const SUITE = randomUUID().slice(0, 8);

async function seedShowcase(migrator: SaasDatabase): Promise<{
  readonly modelAlias: string;
  readonly vipGroupId: string;
}> {
  const modelAlias = `claude-x-${SUITE}`;
  const publicModelId = `plaza-model-${SUITE}`;
  const vipGroupId = `plaza-vip-${SUITE}`;
  const rightsId = `plaza-rights-${SUITE}`;
  const accountId = `plaza-account-${SUITE}`;
  const evidence = `${'a'.repeat(64)}`;
  await migrator.query(
    `INSERT INTO saas_provider_products (provider_id, product_id, display_name)
     VALUES ('claude', 'claude-code', 'Claude Code') ON CONFLICT DO NOTHING`,
  );
  await migrator.query(
    `INSERT INTO saas_provider_rights
       (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
        model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
     VALUES ($1, 1, 'claude', 'claude-code', 'oauth', 'platform', 'global', 'inference',
        ARRAY['claude-x-${SUITE}'], ARRAY['claude-messages'], '2020-01-01T00:00:00Z', 'plaza-gate',
        'active', 'plaza-gate', $2)`,
    [rightsId, evidence],
  );
  await migrator.query(`INSERT INTO saas_public_models (id, alias, display_name) VALUES ($1, $2, 'Claude X Plaza')`, [
    publicModelId,
    modelAlias,
  ]);
  await migrator.query(
    `INSERT INTO saas_public_model_versions
       (public_model_id, version, provider_id, product_id, model, endpoint_scope)
     VALUES ($1, 1, 'claude', 'claude-code', $2, ARRAY['claude-messages'])`,
    [publicModelId, `claude-x-${SUITE}`],
  );
  await migrator.query(
    `INSERT INTO saas_provider_capabilities
       (provider_id, product_id, model, endpoint, protocol, version, support_level, validation_state,
        evidence_version, discovery_source, evidence_ref, evidence_sha256)
     VALUES ('claude', 'claude-code', $1, 'claude-messages', 'anthropic', 1, 'supported', 'verified',
        'plaza-gate-v1', 'preset', 'plaza-gate', $2)`,
    [`claude-x-${SUITE}`, evidence],
  );
  await migrator.query(
    `INSERT INTO saas_platform_provider_accounts
       (id, display_name, provider_id, product_id, credential_type, region, purpose,
        rights_id, rights_version, status, validation_state)
     VALUES ($1, 'Plaza Gate Account', 'claude', 'claude-code', 'oauth', 'global', 'inference',
        $2, 1, 'active', 'verified')`,
    [accountId, rightsId],
  );
  await migrator.query(
    `INSERT INTO saas_platform_provider_account_capabilities
       (account_id, provider_id, product_id, model, endpoint, capability_version)
     VALUES ($1, 'claude', 'claude-code', $2, 'claude-messages', 1)`,
    [accountId, `claude-x-${SUITE}`],
  );
  await migrator.query(
    `INSERT INTO saas_billing_groups (id, display_name, rate_multiplier_num, rate_multiplier_den)
     VALUES ($1, 'Plaza VIP', 2, 1)`,
    [vipGroupId],
  );
  await migrator.query(
    `INSERT INTO saas_billing_group_account_pools (group_id, account_id, priority)
     VALUES ($1, $2, 50)`,
    [vipGroupId, accountId],
  );
  // $3/1M input, $15/1M output, $0.30/1M cache read (minor units: cents).
  await migrator.query(
    `INSERT INTO saas_customer_price_versions
       (id, version, public_model_id, public_model_version, provider_id, product_id, protocol, endpoint,
        currency, commercial_policy_version, calculator_version, rounding_version, rounding_mode,
        rounding_boundary, input_rate_numerator_minor_units, input_rate_denominator_units,
        cache_read_rate_numerator_minor_units, cache_read_rate_denominator_units,
        output_rate_numerator_minor_units, output_rate_denominator_units,
        effective_at, idempotency_key, definition_digest)
     VALUES ($1, 1, $2, 1, 'claude', 'claude-code', 'anthropic', 'claude-messages',
        'USD', 'plaza-gate-v1', 'commercial-token-v1', 'plaza-gate-v1', 'half_up',
        'total', 300, 1000000, 30, 1000000, 1500, 1000000,
        '2020-01-01T00:00:00Z', $3, $4)`,
    [`plaza-price-${SUITE}`, publicModelId, `plaza-gate-${SUITE}`, evidence],
  );
  return { modelAlias, vipGroupId };
}

function enabledSettings(overrides: Partial<ModelPlazaSettings> = {}): ModelPlazaSettings {
  return resolveModelPlazaSettings({ 'saas.plaza.enabled': true, ...overridesRecord(overrides) }, {});
}

function overridesRecord(overrides: Partial<ModelPlazaSettings>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  if (overrides.exclusiveGroupIds !== undefined) {
    record['saas.plaza.exclusive_groups'] = [...overrides.exclusiveGroupIds];
  }
  if (overrides.description !== undefined) {
    record['saas.plaza.description'] = overrides.description;
  }
  return record;
}

const anonymous: ModelPlazaAccess = { tier: 'anonymous', proxyKeyCaller: null, sessionUserId: null };

test('the plaza aggregates live groups and resolves display prices through the same chain under the gateway role', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three disposable gateway E2E role URLs to require this gate`
      : false,
  timeout: 180_000,
}, async (t) => {
  const urls = disposableRoleTargets();
  const migrator = createSaasDatabase({ connectionString: urls.migrator, max: 2 });
  const gateway = createSaasDatabase({ connectionString: urls.gateway, max: 4 });
  t.after(async () => {
    await Promise.allSettled([migrator.close(), gateway.close()]);
  });
  await migrator.verifySchema();
  await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
  const { modelAlias, vipGroupId } = await seedShowcase(migrator);

  const service = new SaasModelPlazaService({
    facts: new PostgresModelPlazaFacts({
      database: gateway,
      pricing: new SaasPricingService(gateway),
      groups: new SaasBillingGroupsService(gateway),
    }),
    officialPricing: { lookup: async () => null } as never,
  });

  // Anonymous view: the seeded unrestricted 'default' group plus the pooled
  // VIP group; every other group from earlier gates carries no servable
  // model for this alias and drops out.
  const anonymousView = await service.list({ access: anonymous, settings: enabledSettings() });
  const defaultGroup = anonymousView.groups.find((group) => group.id === 'default');
  const vipGroup = anonymousView.groups.find((group) => group.id === vipGroupId);
  assert.ok(defaultGroup, 'the unrestricted default group surfaces the pooled model');
  assert.ok(vipGroup, 'the pooled VIP group surfaces the model');
  assert.equal(vipGroup.rateMultiplier.numerator, '2');

  const defaultModel = defaultGroup.models.find((model) => model.model === modelAlias);
  const vipModel = vipGroup.models.find((model) => model.model === modelAlias);
  assert.ok(defaultModel, 'the seeded public model alias appears in the default group');
  assert.ok(vipModel);
  assert.equal(defaultModel.platform, 'claude');
  assert.equal(defaultModel.displayName, 'Claude X Plaza');
  assert.ok(defaultModel.pricing, 'the same-chain price resolution found the seeded price version');
  assert.equal(defaultModel.pricing.currency, 'USD');
  assert.equal(defaultModel.pricing.rates.input!.numeratorMinorUnits, '300');
  assert.equal(defaultModel.pricing.rates.input!.perMillionUnits, '3');
  assert.equal(defaultModel.pricing.rates.output!.perMillionUnits, '15');
  assert.equal(defaultModel.pricing.rates.cacheRead!.perMillionUnits, '0.3');
  // 实收口径: the VIP group charges the same version × its 2/1 multiplier.
  assert.equal(vipModel.pricing!.rates.input!.numeratorMinorUnits, '600');
  assert.equal(vipModel.pricing!.rates.input!.perMillionUnits, '6');
  assert.equal(vipModel.pricing!.rates.output!.perMillionUnits, '30');

  // Exclusive visibility: an exclusive VIP group disappears from the
  // anonymous view while the public groups stay.
  const exclusiveView = await service.list({
    access: anonymous,
    settings: enabledSettings({ exclusiveGroupIds: new Set([vipGroupId]) }),
  });
  assert.equal(
    exclusiveView.groups.some((group) => group.id === vipGroupId),
    false,
    'an exclusive group is invisible to anonymous callers',
  );
  assert.ok(exclusiveView.groups.some((group) => group.id === 'default'));
});
