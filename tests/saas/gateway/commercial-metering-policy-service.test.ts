import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/023_commercial_metering_policy_authority.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  type ContractTestAttestationInput,
  canonicalContractAttestationPayload,
  type ProviderMeteringPolicyDefinition,
  SaasCommercialMeteringPolicyError,
  SaasCommercialMeteringPolicyService,
} from '../../../src/saas/gateway/commercial-metering-policy-service.js';

type Row = Record<string, unknown>;

function result<T>(rows: T[] = []): SqlResult<T> {
  return { rows, rowCount: rows.length };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface FakeState {
  customerHeads: Row[];
  customerPolicies: Row[];
  providerHeads: Row[];
  providerPolicies: Row[];
  attestations: Row[];
  routes: Row[];
  authorities: Row[];
  audits: Row[];
}

function emptyState(): FakeState {
  return {
    customerHeads: [],
    customerPolicies: [],
    providerHeads: [],
    providerPolicies: [],
    attestations: [],
    routes: [
      {
        tenant_id: 'tenant-a',
        project_id: 'project-a',
        route_id: 'route-a',
        version: '2',
        status: 'active',
        public_model_id: 'public-model-a',
        public_model_version: '1',
        protocol: 'openai',
        endpoint: '/v1/chat/completions',
        supply_mode: 'platform',
        target_mode: 'platform_pool',
        current_version: '2',
        head_status: 'active',
      },
    ],
    authorities: [],
    audits: [],
  };
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

class FakeCommercialDatabase implements SaasDatabase {
  readonly sql: string[] = [];
  readonly advisoryFenceKeys: string[] = [];
  state = emptyState();
  failAudit = false;

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    const statement = normalize(sql);
    this.sql.push(statement);
    return result(this.execute(statement, values) as RowType[]);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const snapshot = clone(this.state);
    const sqlLength = this.sql.length;
    try {
      return await work(this);
    } catch (error) {
      this.state = snapshot;
      this.sql.splice(sqlLength);
      throw error;
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  private execute(statement: string, values: readonly unknown[]): Row[] {
    if (statement.startsWith('SELECT pg_advisory_xact_lock')) {
      this.advisoryFenceKeys.push(String(values[0]));
      return [];
    }
    if (statement.startsWith('SELECT policy_id FROM saas_customer_metering_policy_heads')) {
      return this.state.customerHeads.filter((row) => this.headMatches(row, values));
    }
    if (statement.startsWith('SELECT policy_id FROM saas_provider_metering_policy_heads')) {
      return this.state.providerHeads.filter((row) => this.headMatches(row, values));
    }
    if (
      statement.startsWith(
        'SELECT tenant_id, project_id, policy_id, current_version, status FROM saas_customer_metering_policy_heads',
      )
    ) {
      return this.state.customerHeads.filter((row) => this.headMatches(row, values));
    }
    if (
      statement.startsWith(
        'SELECT tenant_id, project_id, policy_id, current_version, status FROM saas_provider_metering_policy_heads',
      )
    ) {
      return this.state.providerHeads.filter((row) => this.headMatches(row, values));
    }
    if (statement.startsWith('SELECT * FROM saas_customer_metering_policy_versions')) {
      return this.state.customerPolicies.filter((row) => this.policyMatches(row, values));
    }
    if (statement.startsWith('SELECT * FROM saas_provider_metering_policy_versions')) {
      return this.state.providerPolicies.filter((row) => this.policyMatches(row, values));
    }
    if (statement.startsWith('INSERT INTO saas_customer_metering_policy_versions')) {
      return this.insertPolicy('customer', values);
    }
    if (statement.startsWith('INSERT INTO saas_provider_metering_policy_versions')) {
      return this.insertPolicy('provider', values);
    }
    if (statement.startsWith('INSERT INTO saas_customer_metering_policy_heads')) {
      this.state.customerHeads.push({
        tenant_id: values[0],
        project_id: values[1],
        policy_id: values[2],
        current_version: values[3],
        status: 'draft',
      });
      return [];
    }
    if (statement.startsWith('INSERT INTO saas_provider_metering_policy_heads')) {
      this.state.providerHeads.push({
        tenant_id: values[0],
        project_id: values[1],
        policy_id: values[2],
        current_version: values[3],
        status: 'draft',
      });
      return [];
    }
    if (statement.startsWith('UPDATE saas_customer_metering_policy_heads')) {
      return this.updateHead('customer', values);
    }
    if (statement.startsWith('UPDATE saas_provider_metering_policy_heads')) {
      return this.updateHead('provider', values);
    }
    if (statement.startsWith('SELECT rv.tenant_id, rv.project_id, rv.route_id, rv.version, rv.status')) {
      return this.state.routes.filter(
        (row) =>
          String(row.tenant_id) === String(values[0]) &&
          String(row.project_id) === String(values[1]) &&
          String(row.route_id) === String(values[2]) &&
          String(row.version) === String(values[3]),
      );
    }
    if (statement.startsWith('SELECT tenant_id, project_id, id, provider_policy_id')) {
      return this.state.attestations.filter(
        (row) =>
          String(row.tenant_id) === String(values[0]) &&
          String(row.project_id) === String(values[1]) &&
          String(row.id) === String(values[2]),
      );
    }
    if (statement.startsWith('INSERT INTO saas_contract_test_attestations')) {
      const row = {
        tenant_id: values[0],
        project_id: values[1],
        id: values[2],
        provider_policy_id: values[3],
        provider_policy_version: values[4],
        public_model_id: values[5],
        public_model_version: values[6],
        protocol: values[7],
        endpoint: values[8],
        supply_mode: values[9],
        target_mode: values[10],
        contract_digest: values[11],
        suite_version: values[12],
        test_vector_digest: values[13],
        verifier_key_id: values[14],
        signature_base64: values[15],
        verification_result: 'verified',
        verified_at: values[16],
        created_at: values[16],
      };
      this.state.attestations.push(row);
      return [row];
    }
    if (statement.startsWith('INSERT INTO saas_route_config_commercial_authorities')) {
      const row = {
        tenant_id: values[0],
        project_id: values[1],
        route_id: values[2],
        route_version: values[3],
        customer_policy_id: values[4],
        customer_policy_version: values[5],
        provider_policy_id: values[6],
        provider_policy_version: values[7],
        contract_attestation_id: values[8],
        customer_price_version: values[9],
        supplier_cost_version: values[10],
      };
      this.state.authorities.push(row);
      return [row];
    }
    if (
      statement.startsWith('SELECT tenant_id, project_id, route_id, version,') &&
      statement.includes('saas_route_config_dispatchable')
    ) {
      return this.state.authorities.map((row) => ({
        tenant_id: row.tenant_id,
        project_id: row.project_id,
        route_id: row.route_id,
        version: row.route_version,
        customer_policy_id: row.customer_policy_id,
        customer_policy_version: row.customer_policy_version,
        provider_policy_id: row.provider_policy_id,
        provider_policy_version: row.provider_policy_version,
        contract_attestation_id: row.contract_attestation_id,
        customer_price_version: row.customer_price_version,
        supplier_cost_version: row.supplier_cost_version,
      }));
    }
    if (statement.startsWith('INSERT INTO saas_audit_events')) {
      if (this.failAudit) throw new Error('audit unavailable');
      this.state.audits.push({ action: values[3], target_id: values[5] });
      return [];
    }
    throw new Error(`unexpected SQL: ${statement}`);
  }

  private headMatches(row: Row, values: readonly unknown[]): boolean {
    return (
      String(row.tenant_id) === String(values[0]) &&
      String(row.project_id) === String(values[1]) &&
      String(row.policy_id) === String(values[2])
    );
  }

  private policyMatches(row: Row, values: readonly unknown[]): boolean {
    return (
      String(row.tenant_id) === String(values[0]) &&
      String(row.project_id) === String(values[1]) &&
      String(row.policy_id) === String(values[2]) &&
      String(row.version) === String(values[3])
    );
  }

  private insertPolicy(kind: 'customer' | 'provider', values: readonly unknown[]): Row[] {
    const provider = kind === 'provider';
    const row: Row = {
      tenant_id: values[0],
      project_id: values[1],
      policy_id: values[2],
      version: values[3],
      status: values[4],
      public_model_id: values[5],
      public_model_version: values[6],
      protocol: values[7],
      endpoint: values[8],
      supply_mode: values[9],
      target_mode: values[10],
      usage_dimensions: values[provider ? 15 : 12],
      token_source: values[provider ? 16 : 13],
      rounding_version: values[provider ? 17 : 14],
      rounding_mode: values[provider ? 18 : 15],
      rounding_boundary: values[provider ? 19 : 16],
      commercial_policy_version: values[provider ? 20 : 17],
      changed_by_user_id: values[provider ? 21 : 18],
      created_at: values[provider ? 22 : 19],
    };
    if (provider) {
      row.provider_id = values[11];
      row.product_id = values[12];
      row.resolved_model = values[13];
      row.supplier_cost_version = values[14];
      this.state.providerPolicies.push(row);
    } else {
      row.customer_price_version = values[11];
      this.state.customerPolicies.push(row);
    }
    return [];
  }

  private updateHead(kind: 'customer' | 'provider', values: readonly unknown[]): Row[] {
    const rows = kind === 'customer' ? this.state.customerHeads : this.state.providerHeads;
    const row = rows.find(
      (candidate) =>
        this.headMatches(candidate, values) && String(candidate.current_version) === String(values[6] ?? values[7]),
    );
    if (!row) return [];
    const nextVersion = values[3];
    row.current_version = nextVersion;
    row.status = values[4];
    return [row];
  }
}

const audit = { actorUserId: 'user-a', entryPoint: 'commercial-test' };
const providerDefinition: ProviderMeteringPolicyDefinition = {
  publicModelId: 'public-model-a',
  publicModelVersion: 1,
  providerId: 'provider-a',
  productId: 'product-a',
  resolvedModel: 'provider-model-a',
  protocol: 'openai',
  endpoint: '/v1/chat/completions',
  supplyMode: 'platform',
  targetMode: 'platform_pool',
  supplierCostVersion: 'cost-v1',
  usageDimensions: ['input_total', 'output_total'],
  tokenSource: 'upstream',
  roundingVersion: 'rounding-v1',
  roundingMode: 'half_up',
  roundingBoundary: 'total',
  commercialPolicyVersion: 'commercial-v1',
};

const customerDefinition = {
  publicModelId: 'public-model-a',
  publicModelVersion: 1,
  protocol: 'openai' as const,
  endpoint: '/v1/chat/completions',
  supplyMode: 'platform' as const,
  targetMode: 'platform_pool' as const,
  customerPriceVersion: 'price-v1',
  usageDimensions: ['input_total', 'output_total'] as const,
  tokenSource: 'upstream' as const,
  roundingVersion: 'rounding-v1',
  roundingMode: 'half_up' as const,
  roundingBoundary: 'total' as const,
  commercialPolicyVersion: 'commercial-v1',
};

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function service(database: FakeCommercialDatabase): SaasCommercialMeteringPolicyService {
  return new SaasCommercialMeteringPolicyService(database, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
    trustedVerifierPublicKeys: new Map([['verifier-a', publicKey]]),
    trustedTestVectorDigests: new Map([['suite-v1', 'c'.repeat(64)]]),
  });
}

function attestationInput(overrides: Partial<ContractTestAttestationInput> = {}): ContractTestAttestationInput {
  const base: ContractTestAttestationInput = {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    id: 'attestation-a',
    providerPolicyId: 'provider-policy-a',
    providerPolicyVersion: 2,
    publicModelId: providerDefinition.publicModelId,
    publicModelVersion: providerDefinition.publicModelVersion,
    protocol: providerDefinition.protocol,
    endpoint: providerDefinition.endpoint,
    supplyMode: providerDefinition.supplyMode,
    targetMode: providerDefinition.targetMode,
    contractDigest: 'a'.repeat(64),
    suiteVersion: 'suite-v1',
    testVectorDigest: 'c'.repeat(64),
    verifierKeyId: 'verifier-a',
    signatureBase64: '',
    usageDimensions: providerDefinition.usageDimensions,
    tokenSource: providerDefinition.tokenSource,
    roundingVersion: providerDefinition.roundingVersion,
    roundingMode: providerDefinition.roundingMode,
    roundingBoundary: 'total',
    audit,
  };
  const payload = canonicalContractAttestationPayload({
    contractDigest: overrides.contractDigest ?? base.contractDigest,
    suiteVersion: overrides.suiteVersion ?? base.suiteVersion,
    testVectorDigest: overrides.testVectorDigest ?? base.testVectorDigest,
    providerPolicyId: overrides.providerPolicyId ?? base.providerPolicyId,
    providerPolicyVersion: String(overrides.providerPolicyVersion ?? base.providerPolicyVersion),
    publicModelId: overrides.publicModelId ?? base.publicModelId,
    publicModelVersion: String(overrides.publicModelVersion ?? base.publicModelVersion),
    protocol: overrides.protocol ?? base.protocol,
    endpoint: overrides.endpoint ?? base.endpoint,
    supplyMode: overrides.supplyMode ?? base.supplyMode,
    targetMode: overrides.targetMode ?? base.targetMode,
    usageDimensions: overrides.usageDimensions ?? base.usageDimensions,
    tokenSource: overrides.tokenSource ?? base.tokenSource,
    roundingVersion: overrides.roundingVersion ?? base.roundingVersion,
    roundingMode: overrides.roundingMode ?? base.roundingMode,
    roundingBoundary: 'total',
  });
  return {
    ...base,
    ...overrides,
    signatureBase64: overrides.signatureBase64 ?? sign(null, Buffer.from(payload), privateKey).toString('base64'),
  };
}

test('commercial fences encode arbitrary text and precede policy-head row locks', async () => {
  const database = new FakeCommercialDatabase();
  const tenantId = '租户:1';
  const projectId = '项目/2';
  const policyId = '价格头:3';
  await service(database).createCustomerPolicy({
    tenantId,
    projectId,
    policyId,
    definition: customerDefinition,
    audit,
  });

  const expectedCommercialKey = `saas-authz:commercial-customer:${Buffer.from(tenantId, 'utf8').toString('hex')}:${Buffer.from(
    policyId,
    'utf8',
  ).toString('hex')}`;
  assert.deepEqual(database.advisoryFenceKeys.slice(0, 2), [
    `saas-authz:tenant:${tenantId}`,
    `saas-authz:project:${tenantId}:${projectId}`,
  ]);
  assert.ok(database.advisoryFenceKeys.includes(expectedCommercialKey));
  const lastFenceIndex = database.sql.reduce(
    (index, statement, current) => (statement.startsWith('SELECT pg_advisory_xact_lock') ? current : index),
    -1,
  );
  const headLockIndex = database.sql.findIndex(
    (statement) => statement.includes('metering_policy_heads') && statement.includes('FOR UPDATE'),
  );
  assert.ok(lastFenceIndex >= 0 && headLockIndex > lastFenceIndex);
});

async function createPublishedPolicies(database: FakeCommercialDatabase): Promise<SaasCommercialMeteringPolicyService> {
  const policies = service(database);
  await policies.createCustomerPolicy({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    policyId: 'customer-policy-a',
    definition: customerDefinition,
    audit,
  });
  await policies.createProviderPolicy({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    policyId: 'provider-policy-a',
    definition: providerDefinition,
    audit,
  });
  await policies.publishCustomerPolicy({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    policyId: 'customer-policy-a',
    expectedVersion: 1,
    definition: customerDefinition,
    audit,
  });
  await policies.publishProviderPolicy({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    policyId: 'provider-policy-a',
    expectedVersion: 1,
    definition: providerDefinition,
    audit,
  });
  return policies;
}

test('023 is forward-only, immutable, and makes commercial authority a prerequisite for dispatch', () => {
  assert.equal(COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.version, 23);
  assert.match(
    COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql,
    /CREATE TABLE saas_customer_metering_policy_versions/,
  );
  assert.match(
    COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql,
    /CREATE TABLE saas_provider_metering_policy_versions/,
  );
  assert.match(COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql, /CREATE TABLE saas_contract_test_attestations/);
  assert.match(
    COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql,
    /CREATE TABLE saas_route_config_commercial_authorities/,
  );
  assert.match(COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql, /CREATE VIEW saas_route_config_dispatchable/);
  assert.match(COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql, /clock_timestamp\(\)/);
  assert.match(
    COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql,
    /Historical SaaS attempts cannot be assigned commercial authority/,
  );
  assert.doesNotMatch(
    COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql,
    /UPDATE saas_route_config_versions|UPDATE saas_requests SET|UPDATE saas_attempts SET/,
  );
});

test('attestation requires a configured trusted key, trusted vector, and a real signature', async () => {
  const database = new FakeCommercialDatabase();
  const policies = await createPublishedPolicies(database);
  const attestation = await policies.attestProviderContract(attestationInput());
  assert.equal(attestation.verificationResult, 'verified');
  assert.equal(database.state.attestations.length, 1);

  await assert.rejects(
    service(database).attestProviderContract(attestationInput({ id: 'unknown-key', verifierKeyId: 'missing-key' })),
    (error: unknown) => error instanceof SaasCommercialMeteringPolicyError && error.code === 'ATTESTATION_UNKNOWN_KEY',
  );
  await assert.rejects(
    policies.attestProviderContract(
      attestationInput({ id: 'bad-signature', signatureBase64: Buffer.from('bad').toString('base64') }),
    ),
    (error: unknown) =>
      error instanceof SaasCommercialMeteringPolicyError && error.code === 'ATTESTATION_BAD_SIGNATURE',
  );
  await assert.rejects(
    policies.attestProviderContract({ ...attestationInput(), id: 'changed-digest', contractDigest: 'b'.repeat(64) }),
    (error: unknown) =>
      error instanceof SaasCommercialMeteringPolicyError && error.code === 'ATTESTATION_BAD_SIGNATURE',
  );
  await assert.rejects(
    policies.attestProviderContract(attestationInput({ id: 'changed-vector', testVectorDigest: 'd'.repeat(64) })),
    (error: unknown) =>
      error instanceof SaasCommercialMeteringPolicyError && error.code === 'ATTESTATION_VECTOR_MISMATCH',
  );
});

test('policy heads use expected-version CAS and audit failure rolls the version back', async () => {
  const database = new FakeCommercialDatabase();
  const policies = service(database);
  await policies.createCustomerPolicy({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    policyId: 'customer-policy-a',
    definition: customerDefinition,
    audit,
  });
  await assert.rejects(
    policies.publishCustomerPolicy({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      policyId: 'customer-policy-a',
      expectedVersion: 9,
      definition: customerDefinition,
      audit,
    }),
    (error: unknown) => error instanceof SaasCommercialMeteringPolicyError && error.code === 'CAS_CONFLICT',
  );
  database.failAudit = true;
  await assert.rejects(
    policies.publishCustomerPolicy({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      policyId: 'customer-policy-a',
      expectedVersion: 1,
      definition: customerDefinition,
      audit,
    }),
    (error: unknown) => error instanceof SaasCommercialMeteringPolicyError && error.code === 'STORAGE_ERROR',
  );
  assert.equal(database.state.customerPolicies.length, 1);
  assert.equal(database.state.customerHeads[0]?.current_version, '1');
  assert.equal(database.state.audits.length, 1);
});

test('route binding is fail-closed until active exact policies and attestation exist', async () => {
  const database = new FakeCommercialDatabase();
  const policies = await createPublishedPolicies(database);
  await assert.rejects(
    policies.bindRoute({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      routeId: 'route-a',
      routeVersion: 2,
      customerPolicyId: 'missing-customer-policy',
      customerPolicyVersion: 2,
      providerPolicyId: 'provider-policy-a',
      providerPolicyVersion: 2,
      contractAttestationId: 'missing-attestation',
      audit,
    }),
    (error: unknown) => error instanceof SaasCommercialMeteringPolicyError && error.code === 'MISSING_AUTHORITY',
  );
  await policies.attestProviderContract(attestationInput());
  const authority = await policies.bindRoute({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    routeId: 'route-a',
    routeVersion: 2,
    customerPolicyId: 'customer-policy-a',
    customerPolicyVersion: 2,
    providerPolicyId: 'provider-policy-a',
    providerPolicyVersion: 2,
    contractAttestationId: 'attestation-a',
    audit,
  });
  assert.equal(authority.customerPriceVersion, 'price-v1');
  assert.equal(authority.supplierCostVersion, 'cost-v1');
  assert.equal((await policies.resolveDispatchableRoute('tenant-a', 'project-a', 'route-a', 2))?.routeVersion, '2');
});

test('dispatch readers use shared commercial fences before their final authority read', async () => {
  const database = new FakeCommercialDatabase();
  const policies = await createPublishedPolicies(database);
  await policies.attestProviderContract(attestationInput());
  await policies.bindRoute({
    tenantId: 'tenant-a',
    projectId: 'project-a',
    routeId: 'route-a',
    routeVersion: 2,
    customerPolicyId: 'customer-policy-a',
    customerPolicyVersion: 2,
    providerPolicyId: 'provider-policy-a',
    providerPolicyVersion: 2,
    contractAttestationId: 'attestation-a',
    audit,
  });
  database.sql.length = 0;
  database.advisoryFenceKeys.length = 0;

  assert.equal((await policies.resolveDispatchableRoute('tenant-a', 'project-a', 'route-a', 2))?.routeVersion, '2');
  const finalRouteRead = database.sql.reduce(
    (index, statement, current) => (statement.includes('FROM saas_route_config_dispatchable') ? current : index),
    -1,
  );
  const lastFence = database.sql.reduce(
    (index, statement, current) => (statement.startsWith('SELECT pg_advisory_xact_lock') ? current : index),
    -1,
  );
  assert.ok(lastFence >= 0 && finalRouteRead > lastFence);
  assert.ok(database.sql.some((statement) => statement.startsWith('SELECT pg_advisory_xact_lock_shared')));
});
