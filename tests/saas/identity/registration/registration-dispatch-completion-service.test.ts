import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase, SqlResult } from '../../../../src/saas/db/types.js';
import { canonicalContractAttestationPayload } from '../../../../src/saas/gateway/commercial-metering-policy-service.js';
import {
  REGISTRATION_DEFAULT_ACCESS_ENV,
  REGISTRATION_DEFAULT_ACCESS_SOURCE,
} from '../../../../src/saas/identity/registration-default-access-service.js';
import type {
  RegistrationContractTestInput,
  RegistrationContractTestPort,
  RegistrationDispatchCompletionConfig,
  RegistrationDispatchCompletionErrorCode,
} from '../../../../src/saas/identity/registration-dispatch-completion-service.js';
import {
  REGISTRATION_DISPATCH_COMPLETION_ENV,
  RegistrationDispatchCompletionError,
  RegistrationDispatchCompletionService,
  registrationDispatchCompletionConfigFromEnv,
} from '../../../../src/saas/identity/registration-dispatch-completion-service.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PROJECT_ID = '10000000-0000-4000-8000-000000000002';
const POOL_ID = 'unit-registration-platform-pool';
const PROFILE_ID = 'registration-default-platform';
const SUITE_VERSION = 'registration-contract-v1';
const VERIFIER_KEY_ID = 'unit-contract-verifier';
const TEST_VECTOR_DIGEST = createHash('sha256').update('unit-contract-vector').digest('hex');
const KEY_PAIR = generateKeyPairSync('ed25519');
const CONFIG: RegistrationDispatchCompletionConfig = {
  poolId: POOL_ID,
  modelScopes: ['model-a', 'model-b'],
  currency: 'USD',
  usageDimensions: ['input_total', 'output_total'],
  tokenSource: 'upstream',
  roundingVersion: 'rounding-v1',
  roundingMode: 'half_up',
  commercialPolicyVersion: 'commercial-v1',
  tenant: { requestsPerMinute: 120, tokensPerMinute: 1_000_000, maxConcurrentRequests: 12 },
  project: { requestsPerMinute: 60, tokensPerMinute: 500_000, maxConcurrentRequests: 6 },
};

// biome-ignore lint/suspicious/noExplicitAny: the SQL fake intentionally models heterogeneous dynamic row shapes.
type Row = Record<string, any>;

interface State {
  tenants: Row[];
  projects: Row[];
  access: Row[];
  models: Row[];
  modelVersions: Row[];
  capabilities: Row[];
  customerPrices: Row[];
  supplierCosts: Row[];
  routeHeads: Row[];
  routeVersions: Row[];
  customerHeads: Row[];
  customerVersions: Row[];
  providerHeads: Row[];
  providerVersions: Row[];
  attestations: Row[];
  bindings: Row[];
  projectPolicies: Row[];
  audits: Row[];
  capacityAudits: Row[];
  poolReady: boolean;
}

function rows<Row>(values: readonly Row[] = []): SqlResult<Row> {
  return { rows: structuredClone([...values]), rowCount: values.length };
}

function stableUuid(value: string): string {
  const hex = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '89ab'[Number.parseInt(hex[16] ?? '0', 16) & 3] ?? '8';
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function price(model: Row, version: Row, kind: 'customer' | 'supplier'): Row {
  return {
    id: `${kind}-${model.alias}`,
    version: 1,
    public_model_id: model.id,
    public_model_version: version.version,
    provider_id: version.provider_id,
    product_id: version.product_id,
    ...(kind === 'supplier' ? { resolved_model: version.resolved_model } : {}),
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    currency: 'USD',
    commercial_policy_version: 'commercial-v1',
    rounding_version: 'rounding-v1',
    rounding_mode: 'half_up',
    rounding_boundary: 'total',
    effective_at: new Date('2020-01-01T00:00:00Z'),
    expires_at: null,
  };
}

function initialState(): State {
  const sourceRef = `${REGISTRATION_DEFAULT_ACCESS_SOURCE}:${TENANT_ID}:${PROJECT_ID}`;
  const models = ['model-a', 'model-b'].map((alias) => ({
    id: `public-${alias}`,
    alias,
    status: 'active',
  }));
  const modelVersions = models.map((model) => ({
    public_model_id: model.id,
    version: 1,
    provider_id: 'unit-provider',
    product_id: 'unit-product',
    resolved_model: `resolved-${model.alias}`,
    endpoint_scope: ['/v1/chat/completions'],
    status: 'active',
  }));
  return {
    tenants: [
      {
        id: TENANT_ID,
        status: 'active',
        capacity_policy_revision: 1,
        requests_per_minute: null,
        tokens_per_minute: null,
        max_concurrent_requests: null,
      },
    ],
    projects: [
      {
        tenant_id: TENANT_ID,
        id: PROJECT_ID,
        is_default: true,
        inference_policy_version: 1,
        inference_policy_status: 'suspended',
      },
    ],
    access: [
      {
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        pool_id: POOL_ID,
        entitlement_id: stableUuid(`${REGISTRATION_DEFAULT_ACCESS_SOURCE}:${TENANT_ID}:${PROJECT_ID}`),
        entitlement_authz_version: 1,
        entitlement_status: 'active',
        entitlement_profile_id: PROFILE_ID,
        entitlement_supply_mode: 'platform',
        entitlement_scopes: [...CONFIG.modelScopes],
        entitlement_source_type: 'admin_grant',
        entitlement_source_ref: sourceRef,
        profile_status: 'active',
        profile_supply_mode: 'platform',
        profile_scopes: [...CONFIG.modelScopes],
        profile_authz_version: 1,
        pool_status: 'active',
        pool_validation_state: 'verified',
        pool_authz_version: 3,
        pool_provider_id: 'unit-provider',
        pool_product_id: 'unit-product',
        grant_status: 'active',
        grant_supply_mode: 'platform',
        grant_profile_authz_version: 1,
        grant_pool_authz_version: 3,
        grant_expires_at: null,
        grant_evidence_ref: sourceRef,
        grant_evidence_sha256: createHash('sha256').update(sourceRef, 'utf8').digest('hex'),
        grant_effective: true,
      },
    ],
    models,
    modelVersions,
    capabilities: modelVersions.map((version) => ({
      provider_id: version.provider_id,
      product_id: version.product_id,
      model: version.resolved_model,
      endpoint: '/v1/chat/completions',
      protocol: 'openai',
      version: 1,
      support_level: 'supported',
      validation_state: 'verified',
    })),
    customerPrices: models.map((model, index) => price(model, modelVersions[index] as Row, 'customer')),
    supplierCosts: models.map((model, index) => price(model, modelVersions[index] as Row, 'supplier')),
    routeHeads: [],
    routeVersions: [],
    customerHeads: [],
    customerVersions: [],
    providerHeads: [],
    providerVersions: [],
    attestations: [],
    bindings: [],
    projectPolicies: [
      {
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        version: 1,
        status: 'suspended',
        changed_by_user_id: null,
        requests_per_minute: null,
        tokens_per_minute: null,
        max_concurrent_requests: null,
      },
    ],
    audits: [],
    capacityAudits: [],
    poolReady: true,
  };
}

class DispatchDatabase {
  state = initialState();
  readonly statements: string[] = [];

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.statements.push(statement);
    return this.execute<Row>(statement, values);
  }

  async transaction<T>(work: (tx: { query: DispatchDatabase['query'] }) => Promise<T>): Promise<T> {
    const before = structuredClone(this.state);
    try {
      return await work({ query: this.query.bind(this) });
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  private policyTables(kind: 'customer' | 'provider'): { heads: Row[]; versions: Row[] } {
    return kind === 'customer'
      ? { heads: this.state.customerHeads, versions: this.state.customerVersions }
      : { heads: this.state.providerHeads, versions: this.state.providerVersions };
  }

  private async execute<Row>(statement: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r] = values;
    if (statement.startsWith('select set_config(') || statement.startsWith('select pg_advisory_xact_lock')) {
      return rows<Row>();
    }
    if (statement.startsWith('select p.id, p.inference_policy_version')) {
      return rows<Row>(
        this.state.projects
          .filter((project) => project.tenant_id === a && project.is_default)
          .map((project) => {
            const tenant = this.state.tenants.find((candidate) => candidate.id === project.tenant_id) as Row;
            return {
              id: project.id,
              inference_policy_version: project.inference_policy_version,
              inference_policy_status: project.inference_policy_status,
              tenant_status: tenant.status,
              capacity_policy_revision: tenant.capacity_policy_revision,
              tenant_rpm: tenant.requests_per_minute,
              tenant_tpm: tenant.tokens_per_minute,
              tenant_concurrency: tenant.max_concurrent_requests,
            };
          }) as Row[],
      );
    }
    if (statement.startsWith('select e.id as entitlement_id')) {
      return rows<Row>(
        this.state.access.filter(
          (access) =>
            access.tenant_id === a && access.project_id === b && access.entitlement_id === c && access.pool_id === d,
        ) as Row[],
      );
    }
    if (statement.startsWith('select m.id, m.alias, v.version')) {
      const model = this.state.models.find((candidate) => candidate.alias === a && candidate.status === 'active');
      if (!model) return rows<Row>();
      return rows<Row>(
        this.state.modelVersions
          .filter((version) => version.public_model_id === model.id && version.status === 'active')
          .map((version) => ({ ...model, ...version, id: model.id, resolved_model: version.resolved_model })) as Row[],
      );
    }
    if (statement.startsWith('select cap.protocol, cap.endpoint')) {
      const eligible = this.state.capabilities.filter(
        (capability) =>
          capability.provider_id === a &&
          capability.product_id === b &&
          capability.model === c &&
          (d as string[]).includes(capability.endpoint) &&
          capability.validation_state === 'verified' &&
          ['supported', 'limited'].includes(capability.support_level),
      );
      return rows<Row>(eligible.map(({ protocol, endpoint }) => ({ protocol, endpoint })) as Row[]);
    }
    if (statement.startsWith('select id,currency,commercial_policy_version')) {
      const customer = statement.includes('from saas_customer_price_versions');
      const source = customer ? this.state.customerPrices : this.state.supplierCosts;
      const protocol = String(customer ? e : f);
      const endpoint = String(customer ? f : g);
      const currency = String(customer ? g : h);
      const commercialPolicyVersion = String(customer ? h : i);
      const roundingVersion = String(customer ? i : j);
      const roundingMode = String(customer ? j : k);
      const matches = source.filter(
        (candidate) =>
          candidate.public_model_id === a &&
          String(candidate.public_model_version) === String(b) &&
          candidate.provider_id === c &&
          candidate.product_id === d &&
          (customer || candidate.resolved_model === e) &&
          candidate.protocol === protocol &&
          candidate.endpoint === endpoint &&
          candidate.currency === currency &&
          candidate.effective_at <= new Date() &&
          (candidate.expires_at === null || candidate.expires_at > new Date()) &&
          candidate.commercial_policy_version === commercialPolicyVersion &&
          candidate.rounding_version === roundingVersion &&
          candidate.rounding_mode === roundingMode &&
          candidate.rounding_boundary === 'total',
      );
      matches.sort(
        (left, right) => right.effective_at.getTime() - left.effective_at.getTime() || right.version - left.version,
      );
      return rows<Row>(matches.slice(0, 1) as Row[]);
    }
    if (statement.startsWith('select a.id from saas_platform_provider_pools')) {
      return rows<Row>(this.state.poolReady ? ([{ id: 'unit-ready-account' }] as Row[]) : []);
    }
    if (statement.startsWith('select current_version,status from saas_route_config_heads')) {
      return rows<Row>(
        this.state.routeHeads.filter(
          (head) => head.tenant_id === a && head.project_id === b && head.route_id === c,
        ) as Row[],
      );
    }
    if (
      statement.startsWith(
        'select public_model_id,public_model_version,protocol,supply_mode,target_mode,upstream_id,endpoint,status',
      )
    ) {
      return rows<Row>(
        this.state.routeVersions.filter(
          (version) =>
            version.tenant_id === a &&
            version.project_id === b &&
            version.route_id === c &&
            String(version.version) === String(d),
        ) as Row[],
      );
    }
    if (statement.startsWith('insert into saas_route_config_versions')) {
      const version = {
        tenant_id: a,
        project_id: b,
        route_id: c,
        version: Number(d),
        status: e,
        public_model_id: f,
        public_model_version: g,
        protocol: h,
        supply_mode: 'platform',
        target_mode: 'platform_pool',
        upstream_id: i,
        endpoint: j,
        changed_by_user_id: null,
      };
      this.state.routeVersions.push(version);
      return rows<Row>([version] as Row[]);
    }
    if (statement.startsWith('insert into saas_route_config_heads')) {
      const head = {
        tenant_id: a,
        project_id: b,
        route_id: c,
        current_version: 1,
        status: 'draft',
        changed_by_user_id: null,
      };
      this.state.routeHeads.push(head);
      return rows<Row>([head] as Row[]);
    }
    if (statement.startsWith('update saas_route_config_heads')) {
      const head = this.state.routeHeads.find(
        (candidate) =>
          candidate.tenant_id === a &&
          candidate.project_id === b &&
          candidate.route_id === c &&
          candidate.current_version === 1 &&
          candidate.status === 'draft',
      );
      if (!head) return rows<Row>();
      head.current_version = 2;
      head.status = 'active';
      return rows<Row>([{ route_id: c }] as Row[]);
    }
    for (const kind of ['customer', 'provider'] as const) {
      const tables = this.policyTables(kind);
      if (statement.startsWith(`select current_version,status from saas_${kind}_metering_policy_heads`)) {
        return rows<Row>(
          tables.heads.filter((head) => head.tenant_id === a && head.project_id === b && head.policy_id === c) as Row[],
        );
      }
      if (statement.startsWith(`select * from saas_${kind}_metering_policy_versions`)) {
        return rows<Row>(
          tables.versions.filter(
            (version) =>
              version.tenant_id === a &&
              version.project_id === b &&
              version.policy_id === c &&
              String(version.version) === String(d),
          ) as Row[],
        );
      }
      if (statement.startsWith(`insert into saas_${kind}_metering_policy_versions`)) {
        const common = {
          tenant_id: a,
          project_id: b,
          policy_id: c,
          version: Number(d),
          status: e,
          public_model_id: f,
          public_model_version: g,
          changed_by_user_id: null,
        };
        const version =
          kind === 'customer'
            ? {
                ...common,
                protocol: h,
                endpoint: i,
                supply_mode: 'platform',
                target_mode: 'platform_pool',
                customer_price_version: j,
                usage_dimensions: k,
                token_source: l,
                rounding_version: m,
                rounding_mode: n,
                rounding_boundary: 'total',
                commercial_policy_version: o,
              }
            : {
                ...common,
                provider_id: h,
                product_id: i,
                resolved_model: j,
                protocol: k,
                endpoint: l,
                supply_mode: 'platform',
                target_mode: 'platform_pool',
                supplier_cost_version: m,
                usage_dimensions: n,
                token_source: o,
                rounding_version: p,
                rounding_mode: q,
                rounding_boundary: 'total',
                commercial_policy_version: r,
              };
        tables.versions.push(version);
        return rows<Row>([version] as Row[]);
      }
      if (statement.startsWith(`insert into saas_${kind}_metering_policy_heads`)) {
        const head = {
          tenant_id: a,
          project_id: b,
          policy_id: c,
          current_version: 1,
          status: 'draft',
          changed_by_user_id: null,
        };
        tables.heads.push(head);
        return rows<Row>([head] as Row[]);
      }
      if (statement.startsWith(`update saas_${kind}_metering_policy_heads`)) {
        const head = tables.heads.find(
          (candidate) =>
            candidate.tenant_id === a &&
            candidate.project_id === b &&
            candidate.policy_id === c &&
            candidate.current_version === 1 &&
            candidate.status === 'draft',
        );
        if (!head) return rows<Row>();
        head.current_version = 2;
        head.status = 'active';
        return rows<Row>([{ policy_id: c }] as Row[]);
      }
    }
    if (statement.startsWith('select provider_policy_id,provider_policy_version,public_model_id')) {
      return rows<Row>(
        this.state.attestations.filter(
          (attestation) => attestation.tenant_id === a && attestation.project_id === b && attestation.id === c,
        ) as Row[],
      );
    }
    if (statement.startsWith('insert into saas_contract_test_attestations')) {
      const attestation = {
        tenant_id: a,
        project_id: b,
        id: c,
        provider_policy_id: d,
        provider_policy_version: 2,
        public_model_id: e,
        public_model_version: f,
        protocol: g,
        endpoint: h,
        supply_mode: 'platform',
        target_mode: 'platform_pool',
        contract_digest: i,
        suite_version: j,
        test_vector_digest: k,
        verifier_key_id: l,
        signature_base64: m,
        verification_result: 'verified',
        verified_at: new Date(),
      };
      this.state.attestations.push(attestation);
      return rows<Row>([attestation] as Row[]);
    }
    if (statement.startsWith('select customer_policy_id,customer_policy_version')) {
      return rows<Row>(
        this.state.bindings.filter(
          (binding) =>
            binding.tenant_id === a &&
            binding.project_id === b &&
            binding.route_id === c &&
            binding.route_version === 2,
        ) as Row[],
      );
    }
    if (statement.startsWith('insert into saas_route_config_commercial_authorities')) {
      const binding = {
        tenant_id: a,
        project_id: b,
        route_id: c,
        route_version: 2,
        customer_policy_id: d,
        customer_policy_version: 2,
        provider_policy_id: e,
        provider_policy_version: 2,
        contract_attestation_id: f,
        customer_price_version: g,
        supplier_cost_version: h,
        created_by_user_id: null,
      };
      this.state.bindings.push(binding);
      return rows<Row>([binding] as Row[]);
    }
    if (statement.startsWith('select route_id from saas_route_config_dispatchable')) {
      const route = this.state.routeHeads.find(
        (head) =>
          head.tenant_id === a &&
          head.project_id === b &&
          head.route_id === c &&
          head.current_version === 2 &&
          head.status === 'active',
      );
      const binding = this.state.bindings.find(
        (candidate) =>
          candidate.tenant_id === a &&
          candidate.project_id === b &&
          candidate.route_id === c &&
          candidate.route_version === 2,
      );
      return rows<Row>(route && binding ? ([{ route_id: c }] as Row[]) : []);
    }
    if (statement.startsWith('update saas_tenants set requests_per_minute')) {
      const tenant = this.state.tenants.find(
        (candidate) =>
          candidate.id === a &&
          String(candidate.capacity_policy_revision) === String(e) &&
          candidate.requests_per_minute === null &&
          candidate.tokens_per_minute === null &&
          candidate.max_concurrent_requests === null,
      );
      if (!tenant) return rows<Row>();
      tenant.requests_per_minute = b;
      tenant.tokens_per_minute = c;
      tenant.max_concurrent_requests = d;
      tenant.capacity_policy_revision += 1;
      return rows<Row>([{ id: a }] as Row[]);
    }
    if (statement.startsWith('select status,requests_per_minute,tokens_per_minute,max_concurrent_requests')) {
      return rows<Row>(
        this.state.projectPolicies.filter(
          (policy) => policy.tenant_id === a && policy.project_id === b && String(policy.version) === String(c),
        ) as Row[],
      );
    }
    if (statement.startsWith('insert into saas_project_inference_policy_versions')) {
      const policy = {
        tenant_id: a,
        project_id: b,
        version: Number(c),
        status: d,
        changed_by_user_id: null,
        requests_per_minute: e,
        tokens_per_minute: f,
        max_concurrent_requests: g,
      };
      this.state.projectPolicies.push(policy);
      return rows<Row>([policy] as Row[]);
    }
    if (statement.startsWith('update saas_projects set inference_policy_version')) {
      const activating = statement.includes("inference_policy_status='active'");
      const project = this.state.projects.find(
        (candidate) =>
          candidate.tenant_id === a &&
          candidate.id === b &&
          String(candidate.inference_policy_version) === String(d) &&
          (!activating || candidate.inference_policy_status === 'suspended'),
      );
      if (!project) return rows<Row>();
      project.inference_policy_version = Number(c);
      if (activating) project.inference_policy_status = 'active';
      return rows<Row>([{ id: b }] as Row[]);
    }
    if (statement.startsWith('insert into saas_audit_events')) {
      const audit = { id: a, tenant_id: b, actor_user_id: null, statement, values: [...values] };
      this.state.audits.push(audit);
      return rows<Row>([{ id: a }] as Row[]);
    }
    if (statement.startsWith('insert into saas_capacity_policy_audit_details')) {
      this.state.capacityAudits.push({ audit_event_id: a, scope: b, tenant_id: c, project_id: d, values: [...values] });
      return rows<Row>([{ audit_event_id: a }] as Row[]);
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }
}

function contractTests(
  executions: RegistrationContractTestInput[] = [],
  invalidSignature = false,
): RegistrationContractTestPort {
  return {
    async execute(input) {
      executions.push(input);
      const definition = input.definition;
      const evidence = {
        contractDigest: createHash('sha256').update(`contract:${input.providerPolicyId}`).digest('hex'),
        suiteVersion: SUITE_VERSION,
        testVectorDigest: TEST_VECTOR_DIGEST,
        verifierKeyId: VERIFIER_KEY_ID,
      };
      const payload = canonicalContractAttestationPayload({
        ...evidence,
        providerPolicyId: input.providerPolicyId,
        providerPolicyVersion: '2',
        publicModelId: definition.publicModelId,
        publicModelVersion: String(definition.publicModelVersion),
        protocol: definition.protocol,
        endpoint: definition.endpoint,
        supplyMode: 'platform',
        targetMode: 'platform_pool',
        usageDimensions: definition.usageDimensions,
        tokenSource: definition.tokenSource,
        roundingVersion: definition.roundingVersion,
        roundingMode: definition.roundingMode,
        roundingBoundary: 'total',
      });
      const signature = sign(null, Buffer.from(payload), KEY_PAIR.privateKey);
      if (invalidSignature) signature[0] = (signature[0] ?? 0) ^ 1;
      return { ...evidence, signatureBase64: signature.toString('base64') };
    },
  };
}

function service(
  database: DispatchDatabase,
  options: {
    readonly config?: RegistrationDispatchCompletionConfig;
    readonly contractTests?: RegistrationContractTestPort;
  } = {},
): RegistrationDispatchCompletionService {
  return new RegistrationDispatchCompletionService({
    database: database as unknown as SaasDatabase,
    config: options.config === undefined ? CONFIG : options.config,
    contractTests: 'contractTests' in options ? options.contractTests : contractTests(),
    trustedVerifierPublicKeys: { [VERIFIER_KEY_ID]: KEY_PAIR.publicKey },
    trustedTestVectorDigests: { [SUITE_VERSION]: TEST_VECTOR_DIGEST },
  });
}

async function expectCode(operation: Promise<unknown>, code: RegistrationDispatchCompletionErrorCode): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof RegistrationDispatchCompletionError);
    assert.equal(error.code, code);
    return true;
  });
}

function writeCount(database: DispatchDatabase): number {
  return database.statements.filter(
    (statement) => statement.startsWith('insert into') || statement.startsWith('update '),
  ).length;
}

test('disabled configuration is a no-op and default-access-only environment stays disabled', async () => {
  const database = new DispatchDatabase();
  const disabled = new RegistrationDispatchCompletionService({ database: database as unknown as SaasDatabase });
  assert.deepEqual(await disabled.complete({ tenantId: TENANT_ID }), { status: 'disabled' });
  assert.equal(database.statements.length, 0);
  assert.equal(
    registrationDispatchCompletionConfigFromEnv({
      [REGISTRATION_DEFAULT_ACCESS_ENV.poolId]: POOL_ID,
      [REGISTRATION_DEFAULT_ACCESS_ENV.modelScopes]: 'model-a',
    }),
    undefined,
  );
});

test('partial or invalid enabled environment fails closed before any write', async () => {
  const database = new DispatchDatabase();
  const partial = registrationDispatchCompletionConfigFromEnv({
    [REGISTRATION_DISPATCH_COMPLETION_ENV.tenantRequestsPerMinute]: '120',
  });
  assert.ok(partial);
  await expectCode(service(database, { config: partial }).complete({ tenantId: TENANT_ID }), 'INVALID_CONFIGURATION');
  assert.equal(writeCount(database), 0);

  const invalid = registrationDispatchCompletionConfigFromEnv({
    [REGISTRATION_DEFAULT_ACCESS_ENV.poolId]: POOL_ID,
    [REGISTRATION_DEFAULT_ACCESS_ENV.modelScopes]: 'model-a,model-b',
    [REGISTRATION_DISPATCH_COMPLETION_ENV.tenantRequestsPerMinute]: '120',
    [REGISTRATION_DISPATCH_COMPLETION_ENV.tenantTokensPerMinute]: '1000000',
    [REGISTRATION_DISPATCH_COMPLETION_ENV.tenantMaxConcurrentRequests]: '12',
    [REGISTRATION_DISPATCH_COMPLETION_ENV.projectRequestsPerMinute]: '60',
    [REGISTRATION_DISPATCH_COMPLETION_ENV.projectTokensPerMinute]: '500000',
    [REGISTRATION_DISPATCH_COMPLETION_ENV.projectMaxConcurrentRequests]: '6',
    [REGISTRATION_DISPATCH_COMPLETION_ENV.currency]: 'USD',
    [REGISTRATION_DISPATCH_COMPLETION_ENV.usageDimensions]: 'input_total,output_total',
    [REGISTRATION_DISPATCH_COMPLETION_ENV.tokenSource]: 'upstream',
    [REGISTRATION_DISPATCH_COMPLETION_ENV.roundingVersion]: 'rounding-v1',
    [REGISTRATION_DISPATCH_COMPLETION_ENV.roundingMode]: 'half_up',
    [REGISTRATION_DISPATCH_COMPLETION_ENV.commercialPolicyVersion]: 'commercial-v1',
  });
  assert.ok(invalid);
  const result = await service(database, { config: invalid }).complete({ tenantId: TENANT_ID });
  assert.equal(result.status, 'completed');
});

test('creates one dispatchable route per scope and exact reruns adopt without new writes or tests', async () => {
  const database = new DispatchDatabase();
  const executions: RegistrationContractTestInput[] = [];
  await service(database, { contractTests: contractTests(executions) }).complete({ tenantId: TENANT_ID });
  const afterFirst = structuredClone(database.state);
  const writesAfterFirst = writeCount(database);
  const result = await service(database, { contractTests: undefined }).complete({ tenantId: TENANT_ID });

  assert.equal(result.status, 'completed');
  assert.equal(database.state.routeHeads.length, 2);
  assert.equal(database.state.customerHeads.length, 2);
  assert.equal(database.state.providerHeads.length, 2);
  assert.equal(database.state.attestations.length, 2);
  assert.equal(database.state.bindings.length, 2);
  assert.equal(executions.length, 2);
  assert.equal(database.state.tenants[0]?.capacity_policy_revision, 2);
  assert.equal(database.state.projects[0]?.inference_policy_version, 3);
  assert.equal(database.state.projects[0]?.inference_policy_status, 'active');
  assert.deepEqual(
    database.state.projectPolicies.map((policy) => [policy.version, policy.status]),
    [
      [1, 'suspended'],
      [2, 'suspended'],
      [3, 'active'],
    ],
  );
  assert.ok(
    database.state.routeVersions.every(
      (version) =>
        version.supply_mode === 'platform' &&
        version.target_mode === 'platform_pool' &&
        version.upstream_id === POOL_ID,
    ),
  );
  assert.ok(database.state.attestations.every((attestation) => attestation.verification_result === 'verified'));
  assert.ok(database.state.audits.every((audit) => audit.actor_user_id === null));
  assert.deepEqual(database.state, afterFirst);
  assert.equal(writeCount(database), writesAfterFirst);
});

test('matching draft route and policies resume by appending active versions', async () => {
  const database = new DispatchDatabase();
  await service(database).complete({ tenantId: TENANT_ID });
  const route = database.state.routeHeads[0];
  assert.ok(route);
  const binding = database.state.bindings.find((candidate) => candidate.route_id === route.route_id);
  assert.ok(binding);
  database.state.bindings = database.state.bindings.filter((candidate) => candidate.route_id !== route.route_id);
  database.state.attestations = database.state.attestations.filter(
    (candidate) => candidate.id !== binding.contract_attestation_id,
  );
  database.state.routeVersions = database.state.routeVersions.filter(
    (candidate) => candidate.route_id !== route.route_id || candidate.version === 1,
  );
  route.current_version = 1;
  route.status = 'draft';
  for (const [heads, versions, policyId] of [
    [database.state.customerHeads, database.state.customerVersions, binding.customer_policy_id],
    [database.state.providerHeads, database.state.providerVersions, binding.provider_policy_id],
  ] as const) {
    const head = heads.find((candidate) => candidate.policy_id === policyId);
    assert.ok(head);
    head.current_version = 1;
    head.status = 'draft';
    const version = versions.find((candidate) => candidate.policy_id === policyId && candidate.version === 1);
    assert.ok(version);
    version.status = 'draft';
    const retained = versions.filter((candidate) => candidate.policy_id !== policyId || candidate.version === 1);
    if (heads === database.state.customerHeads) database.state.customerVersions = retained;
    else database.state.providerVersions = retained;
  }

  const resumedTargets = new Set([
    `${PROJECT_ID}:${route.route_id}`,
    `${PROJECT_ID}:${binding.customer_policy_id}`,
    `${PROJECT_ID}:${binding.provider_policy_id}`,
    `${PROJECT_ID}:${binding.contract_attestation_id}`,
  ]);
  database.state.audits = database.state.audits.filter((audit) => !resumedTargets.has(audit.values[4]));

  const executions: RegistrationContractTestInput[] = [];
  await service(database, { contractTests: contractTests(executions) }).complete({ tenantId: TENANT_ID });
  assert.equal(executions.length, 1);
  assert.equal(route.current_version, 2);
  assert.equal(route.status, 'active');
  assert.equal(database.state.routeVersions.filter((candidate) => candidate.route_id === route.route_id).length, 2);
  assert.equal(database.state.attestations.length, 2);
  assert.equal(database.state.bindings.length, 2);
});

test('an active route with a different definition conflicts and is never rewritten', async () => {
  const database = new DispatchDatabase();
  await service(database).complete({ tenantId: TENANT_ID });
  const route = database.state.routeVersions.find((version) => version.version === 2);
  assert.ok(route);
  route.endpoint = '/operator-changed';
  const before = structuredClone(database.state);
  await expectCode(service(database).complete({ tenantId: TENANT_ID }), 'PROVISIONING_CONFLICT');
  assert.deepEqual(database.state, before);
});

test('missing active public model fails closed without inventing catalog or route rows', async () => {
  const database = new DispatchDatabase();
  const model = database.state.models[0];
  assert.ok(model);
  model.status = 'disabled';
  await expectCode(service(database).complete({ tenantId: TENANT_ID }), 'PUBLIC_MODEL_UNAVAILABLE');
  assert.equal(database.state.routeHeads.length, 0);
  assert.equal(database.state.customerHeads.length, 0);
  assert.equal(database.state.providerHeads.length, 0);
  assert.equal(database.state.models.length, 2);
});

test('missing effective exact pricing fails closed', async () => {
  const database = new DispatchDatabase();
  database.state.customerPrices = [];
  await expectCode(service(database).complete({ tenantId: TENANT_ID }), 'PRICING_UNAVAILABLE');
  assert.equal(database.state.routeHeads.length, 0);
});

test('a grant that is not yet effective fails closed with an access mismatch', async () => {
  const database = new DispatchDatabase();
  const access = database.state.access[0];
  assert.ok(access);
  access.grant_effective = false;
  await expectCode(service(database).complete({ tenantId: TENANT_ID }), 'REGISTRATION_ACCESS_MISMATCH');
  assert.equal(database.state.routeHeads.length, 0);
  assert.equal(database.state.customerHeads.length, 0);
  assert.equal(database.state.bindings.length, 0);
});

test('a newer price row with a different commercial policy never masks the exact effective row', async () => {
  const database = new DispatchDatabase();
  const exact = database.state.customerPrices[0];
  assert.ok(exact);
  database.state.customerPrices.push({
    ...exact,
    id: 'customer-newer-incompatible',
    version: 2,
    effective_at: new Date(),
    commercial_policy_version: 'commercial-v2',
  });
  const result = await service(database).complete({ tenantId: TENANT_ID });
  assert.equal(result.status, 'completed');
  assert.equal(database.state.routeHeads.length, 2);
  assert.equal(database.state.bindings.length, 2);

  // With the exact row gone, the newer incompatible row must not satisfy
  // pricing: selection happens on the full policy predicate, not a post-filter.
  const masked = new DispatchDatabase();
  const maskedExact = masked.state.customerPrices[0];
  assert.ok(maskedExact);
  masked.state.customerPrices = masked.state.customerPrices.map((row) =>
    row.id === maskedExact.id ? { ...row, commercial_policy_version: 'commercial-v2', effective_at: new Date() } : row,
  );
  await expectCode(service(masked).complete({ tenantId: TENANT_ID }), 'PRICING_UNAVAILABLE');
  assert.equal(masked.state.routeHeads.length, 0);
});

test('missing real contract-test execution fails closed and rolls back all route writes', async () => {
  const database = new DispatchDatabase();
  const withoutRunner = new RegistrationDispatchCompletionService({
    database: database as unknown as SaasDatabase,
    config: CONFIG,
    trustedVerifierPublicKeys: { [VERIFIER_KEY_ID]: KEY_PAIR.publicKey },
    trustedTestVectorDigests: { [SUITE_VERSION]: TEST_VECTOR_DIGEST },
  });
  await expectCode(withoutRunner.complete({ tenantId: TENANT_ID }), 'ATTESTATION_REQUIRED');
  assert.equal(database.state.routeHeads.length, 0);
  assert.equal(database.state.customerHeads.length, 0);
  assert.equal(database.state.providerHeads.length, 0);
  assert.equal(database.state.attestations.length, 0);
  assert.equal(database.state.bindings.length, 0);
});

test('invalid contract-test signatures are rejected and never persisted', async () => {
  const database = new DispatchDatabase();
  await expectCode(
    service(database, { contractTests: contractTests([], true) }).complete({ tenantId: TENANT_ID }),
    'ATTESTATION_INVALID',
  );
  assert.equal(database.state.attestations.length, 0);
  assert.equal(database.state.bindings.length, 0);
  assert.equal(database.state.routeHeads.length, 0);
});

test('unready pool fails closed before route writes', async () => {
  const database = new DispatchDatabase();
  database.state.poolReady = false;
  await expectCode(service(database).complete({ tenantId: TENANT_ID }), 'PUBLIC_MODEL_UNAVAILABLE');
  assert.equal(database.state.routeHeads.length, 0);
});

test('operator-disabled route remains disabled and rerun is a non-error signal', async () => {
  const database = new DispatchDatabase();
  await service(database).complete({ tenantId: TENANT_ID });
  const head = database.state.routeHeads[0];
  assert.ok(head);
  head.status = 'disabled';
  const version = database.state.routeVersions.find(
    (candidate) => candidate.route_id === head.route_id && candidate.version === 2,
  );
  assert.ok(version);
  version.status = 'disabled';
  const before = structuredClone(database.state);
  assert.deepEqual(await service(database).complete({ tenantId: TENANT_ID }), {
    status: 'operator_disabled',
    tenantId: TENANT_ID,
  });
  assert.deepEqual(database.state, before);
});

test('operator-disabled commercial policy remains disabled', async () => {
  const database = new DispatchDatabase();
  await service(database).complete({ tenantId: TENANT_ID });
  const head = database.state.customerHeads[0];
  assert.ok(head);
  head.status = 'disabled';
  const version = database.state.customerVersions.find(
    (candidate) => candidate.policy_id === head.policy_id && candidate.version === 2,
  );
  assert.ok(version);
  version.status = 'disabled';
  const before = structuredClone(database.state);
  assert.equal((await service(database).complete({ tenantId: TENANT_ID })).status, 'operator_disabled');
  assert.deepEqual(database.state, before);
});

test('operator-disabled project and registration entitlement are never revived', async () => {
  for (const target of ['project', 'entitlement'] as const) {
    const database = new DispatchDatabase();
    await service(database).complete({ tenantId: TENANT_ID });
    if (target === 'project') {
      const project = database.state.projects[0];
      assert.ok(project);
      project.inference_policy_status = 'disabled';
    } else {
      const access = database.state.access[0];
      assert.ok(access);
      access.entitlement_status = 'disabled';
    }
    const before = structuredClone(database.state);
    assert.equal((await service(database).complete({ tenantId: TENANT_ID })).status, 'operator_disabled');
    assert.deepEqual(database.state, before);
  }
});
