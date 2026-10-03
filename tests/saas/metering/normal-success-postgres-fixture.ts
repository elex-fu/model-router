import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import { createProviderCredentialContext, sealProviderCredential } from '../../../src/saas/credentials/provider-crypto.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SaasDatabasePool, SqlResult } from '../../../src/saas/db/types.js';
import { canonicalContractAttestationPayload, SaasCommercialMeteringPolicyService,
  type ContractAttestationPayload, type CustomerMeteringPolicyDefinition } from '../../../src/saas/gateway/commercial-metering-policy-service.js';
import type { NormalSuccessTransactionInput } from '../../../src/saas/gateway/dispatch-usage-settlement.js';
import { canonicalPreparedRequestEvidencePayload, SaasPreparedRequestEvidenceService,
  type PreparedRequestEvidenceInput } from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import { SaasProjectInferencePolicyService } from '../../../src/saas/gateway/project-policy-service.js';
import { SaasRouteConfigService } from '../../../src/saas/gateway/route-config-service.js';
import { SaasMeteringService, type PreparedRequestAdmissionInput } from '../../../src/saas/metering/service.js';
import { digestClientKey, sha256Hex } from '../../../src/saas/metering/digest.js';
import type { AttemptRecord, InitialAttemptInput, NormalizedUsageExact } from '../../../src/saas/metering/types.js';
import { SaasPricingService } from '../../../src/saas/pricing/service.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import type { ProviderSupplyOwner } from '../../../src/saas/supply/types.js';

// Private to the FIN057 integration test. It is not a runtime/fault seam.
export const REQUIRED_FLAG = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roles = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
export const anyRoleConfigured = roles.some(([name]) => Boolean(process.env[name]?.trim()));

export function roleUrls(): [string, string, string] {
  let target: string | undefined;
  const urls = roles.map(([name, role]) => {
    const value = process.env[name]?.trim();
    assert.ok(value, `${name} is required for the FIN057 real-PG gate`);
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${name} must be a PostgreSQL URL`); }
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), `${name} must be PostgreSQL`);
    let username: string, database: string;
    try {
      username = decodeURIComponent(url.username);
      database = decodeURIComponent(url.pathname.slice(1));
    } catch { throw new Error(`${name} contains invalid URL encoding`); }
    assert.ok(username === role, `${name} must use the designated role`);
    assert.ok(url.search === '', `${name} must not contain connection overrides`);
    assert.ok(url.hash === '', `${name} must not contain a fragment`);
    const host = url.hostname.toLowerCase();
    const port = Number(url.port);
    const ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(host) && Boolean(url.port) && Number.isInteger(port) &&
      port > 0 && port <= 65_535 && ![5432, 6432, 53782].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, `${name} must identify an authorized disposable CI or nondefault loopback test database`);
    const identity = `${host}:${port}/${database}`;
    target ??= identity;
    assert.ok(identity === target, 'all FIN057 roles must use the same disposable database');
    return value;
  });
  assert.ok(urls[0] && urls[1] && urls[2]);
  return [urls[0], urls[1], urls[2]];
}

export type Phase = 'readiness' | 'setup' | 'admission' | 'quote_setup' | 'reserve' | 'evidence_register' |
  'evidence_preflight' | 'evidence_claim' | 'dispatch_observation' | 'first_complete' | 'replay' |
  'conflict' | 'legacy_complete' | 'immutability' | 'acl' | 'snapshot' | 'cleanup';
const sqlStates = new Set(['42501', '55000', '55006', '23502', '23503', '23505', '23514',
  '42P01', '42703', '42P08', '42883', '42601', '40P01', '40001', '55P03', '57014']);
const domainCodes = new Set(['METERING_STORAGE_ERROR', 'METERING_INVALID_INPUT', 'USAGE_DUPLICATE_CONFLICT',
  'USAGE_SETTLEMENT_CONFLICT', 'ATTEMPT_TRANSITION_INVALID', 'REQUEST_TRANSITION_INVALID',
  'FINANCIAL_TRANSITION_INVALID', 'SIGNATURE_INVALID', 'AUTHORITY_MISMATCH', 'STORAGE_ERROR',
  'PRICING_STORAGE_ERROR', 'SUPPLY_STORAGE_ERROR', 'BILLING_STORAGE_ERROR', 'INSUFFICIENT_FUNDS',
  'INVALID_INPUT', 'INVALID_AMOUNT', 'IDEMPOTENCY_CONFLICT', 'RESERVATION_STATE_CONFLICT']);
function own(object: unknown, name: string): unknown {
  if (object === null || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
export function safeCodes(error: unknown): { code: string; sqlState: string; hasSqlState: boolean } {
  const seen = new Set<unknown>();
  let code = 'unknown';
  let sqlState = 'unknown';
  let hasSqlState = false;
  for (let depth = 0; error !== undefined && depth < 8 && !seen.has(error); depth += 1) {
    seen.add(error);
    const value = own(error, 'code');
    if (typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value)) hasSqlState = true;
    if (typeof value === 'string' && domainCodes.has(value) && code === 'unknown') code = value;
    if (typeof value === 'string' && sqlStates.has(value)) sqlState = value;
    error = own(error, 'cause');
  }
  return { code, sqlState, hasSqlState };
}
export async function phase<T>(name: Phase, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    // Never retain a raw driver error/cause/message/detail/stack or parameters.
    const codes = safeCodes(error);
    const safe = new Error(`FIN057 phase=${name} code=${codes.code} sqlState=${codes.sqlState}`);
    safe.stack = undefined;
    throw safe;
  }
}

export function observedDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 5_000,
    statement_timeout: 15_000, lock_timeout: 5_000, idle_in_transaction_session_timeout: 20_000 });
  const commands = { insert: 0, update: 0, delete: 0 };
  function observe(command: string): void {
    if (command === 'INSERT') commands.insert += 1;
    if (command === 'UPDATE') commands.update += 1;
    if (command === 'DELETE') commands.delete += 1;
  }
  const clientQuery = async <Row>(client: PoolClient, sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> => {
    const result = await client.query(sql, [...values]);
    observe(result.command);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  };
  const adapter: SaasDatabasePool = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      const result = await pool.query(sql, [...values]);
      observe(result.command);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
    async connect() {
      const client = await pool.connect();
      return { query: <Row>(sql: string, values?: readonly unknown[]) => clientQuery<Row>(client, sql, values),
        release: (error?: Error | boolean) => client.release(error) };
    },
    end: () => pool.end(),
  };
  return { database: createSaasDatabase({ connectionString, pool: adapter }), commands };
}

export interface Fixture {
  readonly tenantId: string;
  readonly input: NormalSuccessTransactionInput;
  readonly metering: SaasMeteringService;
  readonly billing: PlatformWalletLedgerService;
  readonly sent: AttemptRecord;
  readonly settlementKeyDigest: string;
}
const endpoint = '/v1/chat/completions';
export function observedUsage(): NormalizedUsageExact {
  return { inputTotal: '3', inputUncached: '3', cacheRead: '0', cacheWrite: '0', cacheWrite5m: '0', cacheWrite1h: '0',
    outputTotal: '2', reasoningOutput: '0', status: 'reported', source: 'upstream',
    semanticsVersion: 'provider-usage-v1', measurementKind: 'snapshot', billableBasis: 'exact' };
}

/** Fixture authority only; no HTTP/bootstrap/real provider/KMS and no grant/DDL bypass. */
export async function seedFixture(migrator: SaasDatabase, gateway: SaasDatabase, mode: 'byok' | 'platform'): Promise<Fixture> {
  const label = randomUUID();
  const tenantId = randomUUID(), projectId = randomUUID(), userId = randomUUID(), keyId = randomUUID();
  const entitlementId = randomUUID(), publicModelId = randomUUID(), requestId = randomUUID(), attemptId = randomUUID();
  const providerId = `fin057-provider-${label}`, productId = `fin057-product-${label}`;
  const model = `fin057-model-${label}`, alias = `fin057-alias-${label}`, profileId = `fin057-profile-${label}`;
  const accountId = `fin057-account-${label}`, credentialId = `fin057-credential-${label}`;
  const routeId = `fin057-route-${label}`, upstreamId = `fin057-upstream-${label}`;
  const audit = { actorUserId: userId, entryPoint: 'fin057-pg-fixture', requestId: randomUUID() };
  const now = new Date().toISOString(), effectiveAt = new Date(Date.now() - 60_000).toISOString();

  await phase('setup', () => migrator.transaction(async (tx) => {
    assert.equal((await tx.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role, 'model_router_saas_migrator');
    await tx.query('INSERT INTO saas_users (id, email) VALUES ($1, $2)', [userId, `fin057-${label}@example.test`]);
    await tx.query('INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $2)', [tenantId, `fin057-${label}`]);
    await tx.query("INSERT INTO saas_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [tenantId, userId]);
    await tx.query('INSERT INTO saas_projects (tenant_id, id, name, slug) VALUES ($1, $2, $3, $3)',
      [tenantId, projectId, `fin057-${label}`]);
    await tx.query("INSERT INTO saas_project_memberships (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'owner')",
      [tenantId, projectId, userId]);
    await tx.query('INSERT INTO saas_supply_profiles (tenant_id, id, supply_mode, model_scopes) VALUES ($1, $2, $3, $4)',
      [tenantId, profileId, mode, [alias]]);
    await tx.query(`INSERT INTO saas_project_entitlements
      (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes, source_type, effective_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'admin_grant', $7)`, [entitlementId, tenantId, projectId, profileId, mode, [alias], effectiveAt]);
    await tx.query(`INSERT INTO saas_api_keys
      (id, tenant_id, project_id, principal_user_id, execution_principal_type, execution_principal_id,
       created_by_user_id, entitlement_id, supply_profile_id, supply_mode, name, prefix, key_hash, model_scopes,
       authz_version, model_scope_version, entitlement_authz_version, supply_profile_authz_version)
      VALUES ($1, $2, $3, $4, 'member', $4, $4, $5, $6, $7, 'FIN057', 'mr_live_fin057_probe', $8, $9, 1, 1, 1, 1)`,
    [keyId, tenantId, projectId, userId, entitlementId, profileId, mode, sha256Hex(`fin057-key:${keyId}`), [alias]]);
  }));
  const policy = await phase('setup', () => new SaasProjectInferencePolicyService(migrator).enable({
    tenantId, projectId, expectedVersion: 1, audit,
  }));
  const catalog = new SaasCatalogService(migrator);
  await phase('setup', () => catalog.registerProviderProduct({ providerId, productId, displayName: 'FIN057 synthetic product' }));
  await phase('setup', () => catalog.registerPublicModelAlias({ publicModelId, alias, displayName: 'FIN057 synthetic model',
    providerId, productId, model, endpointScope: [endpoint] }));
  const capability = await phase('setup', () => catalog.registerProviderCapability({ providerId, productId, model,
    endpoint, protocol: 'openai', supportLevel: 'supported', validationState: 'verified',
    evidenceVersion: 'fin057-fixture-v1', discoverySource: 'manual', evidenceReference: `fin057-capability-${label}`,
    evidenceSha256: 'a'.repeat(64) }));
  const rights = await phase('setup', () => catalog.registerProviderRightsVersion({ rightsId: `fin057-rights-${label}`,
    providerId, productId, credentialType: 'api-key', supplyMode: mode, region: 'test', purpose: 'inference',
    modelScope: [model], endpointScope: [endpoint], effectiveAt, approvalReference: `fin057-approval-${label}`,
    status: 'active', evidenceReference: `fin057-rights-${label}`, evidenceSha256: 'b'.repeat(64), audit }));

  const owner: ProviderSupplyOwner = mode === 'byok' ? { ownerKind: 'tenant', tenantId, supplyMode: 'byok' }
    : { ownerKind: 'platform', tenantId: null, supplyMode: 'platform' };
  const repository = new PostgresProviderSupplyRepository(migrator);
  const account = await phase('setup', () => repository.createAccount({ owner, id: accountId,
    displayName: 'FIN057 synthetic account', providerId, productId, credentialType: 'api-key', region: 'test', purpose: 'inference',
    rightsId: rights.rightsId, rightsVersion: rights.version, capabilities: [{ model, endpoint, version: capability.version }],
    status: 'active', validationState: 'verified', createdAt: now, updatedAt: now }));
  await phase('setup', () => repository.createCredential({ owner, id: credentialId, accountId, providerId, productId,
    credentialType: 'api-key', status: 'pending', validationState: 'unverified', expiresAt: null, createdAt: now, updatedAt: now }));
  const envelope = await phase('setup', () => sealProviderCredential(Buffer.from('fin057-synthetic-provider-key'), createProviderCredentialContext({
    ...owner, deployment: 'fin057-test', environment: 'test', purpose: 'inference', providerId, productId,
    accountId, credentialId, credentialVersion: 1, credentialType: 'api-key',
  }), { generateDataKey: async () => ({ plaintextKey: Buffer.alloc(32, 0x57), ciphertextBlob: Buffer.from('fin057-synthetic-dek') }) },
  'fin057-synthetic-kms'));
  const appended = await phase('setup', () => repository.appendCredentialVersion({
    credential: { ownerKind: owner.ownerKind, tenantId: owner.tenantId, accountId, credentialId, version: 1 },
    providerId, productId, envelope, kmsPurpose: 'inference', wrappingRevision: 1, expectedCurrentVersion: null,
    createdAt: now, expiresAt: null,
  }));
  // Match the existing commercial fixture's setup-only validation seed. Use
  // actual SQL CAS and all normal credential/035/058 guards, not worker/KMS
  // validation or a driver bigint parser override. Never run this as GW.
  await phase('setup', async () => {
    const table = mode === 'byok' ? 'saas_tenant_provider_credentials' : 'saas_platform_provider_credentials';
    const result = await migrator.query(`UPDATE ${table}
      SET validation_state = 'verified', validation_error_code = NULL,
          last_validated_at = $1, status = 'active', updated_at = $1, authz_version = authz_version + 1
      WHERE account_id = $2 AND id = $3 AND authz_version = $4
        ${mode === 'byok' ? 'AND tenant_id = $5' : ''}`,
    [now, accountId, credentialId, appended.credential.authzVersion, ...(mode === 'byok' ? [tenantId] : [])]);
    assert.equal(result.rowCount, 1, 'setup credential validation must win its real SQL CAS');
  });
  const credential = await phase('setup', () => repository.getCredential({
    ownerKind: owner.ownerKind, tenantId: owner.tenantId, accountId, credentialId,
  }));
  assert.ok(credential && credential.status === 'active');

  let poolId: string | null = null;
  let poolVersion: number | null = null;
  let grantVersion: number | null = null;
  let grantProfileVersion: number | null = null;
  let grantPoolVersion: number | null = null;
  if (mode === 'byok') {
    await phase('setup', () => repository.createTenantByokProfileAccount({ tenantId, supplyProfileId: profileId, accountId,
      effectiveAt, expiresAt: null, evidenceReference: `fin057-mapping-${label}`, evidenceSha256: 'c'.repeat(64) }));
  } else {
    const supply = new ProviderSupplyService(migrator, { deployment: 'fin057-test', environment: 'test',
      kmsKeyId: 'fin057-synthetic-kms', sealingKms: { generateDataKey: async () => ({ plaintextKey: Buffer.alloc(32, 0x57),
        ciphertextBlob: Buffer.from('fin057-synthetic-dek') }) } });
    const pool = await phase('setup', () => supply.createPlatformProviderPool({ id: `fin057-pool-${label}`,
      displayName: 'FIN057 pool', providerId, productId, credentialType: 'api-key', region: 'test', purpose: 'inference',
      rightsId: rights.rightsId, rightsVersion: rights.version, capabilities: [{ model, endpoint, version: capability.version }],
      status: 'active', validationState: 'verified' }));
    await phase('setup', () => supply.addPlatformPoolMember({ poolId: pool.id, accountId, expectedAccountAuthzVersion: account.authzVersion }));
    const grant = await phase('setup', () => supply.grantPlatformPoolToProfile({ poolId: pool.id, tenantId,
      supplyProfileId: profileId, evidenceReference: `fin057-grant-${label}`, evidenceSha256: 'd'.repeat(64) }));
    poolId = pool.id; poolVersion = pool.authzVersion; grantVersion = grant.authzVersion;
    grantProfileVersion = grant.profileAuthzVersion; grantPoolVersion = grant.poolAuthzVersion;
  }

  const pricing = new SaasPricingService(migrator);
  const priceBase = { publicModelId, publicModelVersion: 1, providerId, productId, protocol: 'openai', endpoint,
    currency: 'USD', commercialPolicyVersion: 'fin057-commercial-v1', calculatorVersion: 'fin057-calculator-v1',
    roundingVersion: 'fin057-rounding-v1', roundingMode: 'half_up' as const, roundingBoundary: 'total' as const, effectiveAt };
  const rates = { input: { numeratorMinorUnits: 2, denominatorUnits: 1 }, output: { numeratorMinorUnits: 3, denominatorUnits: 1 },
    cache_read: { numeratorMinorUnits: 2, denominatorUnits: 1 }, cache_write: { numeratorMinorUnits: 2, denominatorUnits: 1 },
    cache_write_5m: { numeratorMinorUnits: 2, denominatorUnits: 1 }, cache_write_1h: { numeratorMinorUnits: 2, denominatorUnits: 1 } };
  const price = mode === 'platform' ? await phase('setup', () => pricing.appendCustomerPriceVersion({ ...priceBase,
    rates, idempotencyKey: `fin057-customer-${label}` })) : null;
  const cost = mode === 'platform' ? await phase('setup', () => pricing.appendSupplierCostVersion({ ...priceBase,
    resolvedModel: model, rates, idempotencyKey: `fin057-supplier-${label}` })) : null;
  const definition: CustomerMeteringPolicyDefinition = { publicModelId, publicModelVersion: 1, protocol: 'openai', endpoint,
    supplyMode: mode, targetMode: mode === 'byok' ? 'tenant_account' : 'platform_pool', customerPriceVersion: price?.id ?? null,
    usageDimensions: ['input_total', 'output_total'], tokenSource: 'upstream', roundingVersion: priceBase.roundingVersion,
    roundingMode: 'half_up', roundingBoundary: 'total', commercialPolicyVersion: priceBase.commercialPolicyVersion };
  const providerDefinition = { ...definition, providerId, productId, resolvedModel: model, supplierCostVersion: cost?.id ?? null };
  const keyPair = generateKeyPairSync('ed25519');
  const keyIdForSignature = `fin057-verifier-${label}`, vector = 'e'.repeat(64);
  const commercial = new SaasCommercialMeteringPolicyService(migrator, {
    trustedVerifierPublicKeys: new Map([[keyIdForSignature, keyPair.publicKey]]),
    trustedTestVectorDigests: new Map([['fin057-suite-v1', vector]]),
  });
  const customerPolicyId = `fin057-customer-policy-${label}`, providerPolicyId = `fin057-provider-policy-${label}`;
  await phase('setup', () => commercial.createCustomerPolicy({ tenantId, projectId, policyId: customerPolicyId, definition, audit }));
  await phase('setup', () => commercial.createProviderPolicy({ tenantId, projectId, policyId: providerPolicyId, definition: providerDefinition, audit }));
  const customerPolicy = await phase('setup', () => commercial.publishCustomerPolicy({ tenantId, projectId,
    policyId: customerPolicyId, expectedVersion: 1, definition, audit }));
  const providerPolicy = await phase('setup', () => commercial.publishProviderPolicy({ tenantId, projectId,
    policyId: providerPolicyId, expectedVersion: 1, definition: providerDefinition, audit }));
  const attestationFacts: ContractAttestationPayload = { contractDigest: 'f'.repeat(64), suiteVersion: 'fin057-suite-v1', testVectorDigest: vector,
    providerPolicyId, providerPolicyVersion: providerPolicy.version, publicModelId, publicModelVersion: '1',
    protocol: 'openai' as const, endpoint, supplyMode: mode, targetMode: definition.targetMode,
    usageDimensions: definition.usageDimensions, tokenSource: definition.tokenSource,
    roundingVersion: definition.roundingVersion, roundingMode: definition.roundingMode, roundingBoundary: 'total' };
  const attestationId = `fin057-attestation-${label}`;
  await phase('setup', () => commercial.attestProviderContract({ ...attestationFacts, publicModelVersion: 1,
    tenantId, projectId, id: attestationId, verifierKeyId: keyIdForSignature,
    signatureBase64: sign(null, Buffer.from(canonicalContractAttestationPayload(attestationFacts)), keyPair.privateKey).toString('base64'), audit }));
  const routes = new SaasRouteConfigService(migrator);
  const routeDefinition = { publicModelId, publicModelVersion: 1, protocol: 'openai' as const, endpoint,
    supplyMode: mode, targetMode: definition.targetMode, upstreamId };
  await phase('setup', () => routes.create({ tenantId, projectId, routeId, definition: routeDefinition, audit }));
  const route = await phase('setup', () => routes.publish({ tenantId, projectId, routeId, expectedVersion: 1,
    definition: routeDefinition, audit }));
  await phase('setup', () => commercial.bindRoute({ tenantId, projectId, routeId, routeVersion: route.version,
    customerPolicyId, customerPolicyVersion: customerPolicy.version, providerPolicyId,
    providerPolicyVersion: providerPolicy.version, contractAttestationId: attestationId, audit }));

  const routeFacts = { projectPolicyVersion: policy.version, routeConfigId: routeId, routeConfigVersion: route.version,
    routePublicModelId: publicModelId, routePublicModelVersion: 1, routeProtocol: 'openai' as const,
    routeTargetMode: definition.targetMode, routeUpstreamId: upstreamId, customerPriceVersion: price?.id ?? null,
    customerMeteringPolicyId: customerPolicyId, customerMeteringPolicyVersion: customerPolicy.version,
    providerMeteringPolicyId: providerPolicyId, providerMeteringPolicyVersion: providerPolicy.version,
    contractAttestationId: attestationId };
  const modelResolution = { requestedModel: alias, mappedModel: model, resolvedModel: model,
    mappingSource: 'alias' as const, mappingVersion: 1 };
  const fingerprint = sha256Hex(`fin057-request:${requestId}`), payload = sha256Hex(`fin057-payload:${requestId}`);
  const compiler = { modelResolution, clientProtocol: 'openai' as const, providerProtocol: 'openai' as const,
    clientOperation: 'chat.completions', providerOperation: 'chat.completions', requestFingerprint: fingerprint,
    requestFingerprintVersion: 'canonical-v1', payloadSha256: payload, payloadCompilerVersion: 'fin057-compiler-v1',
    usageEstimatorVersion: 'fin057-estimator-v1' };
  const attemptBase = { ...routeFacts, ...compiler, ordinal: 1, upstreamId, accountId, providerId, productId,
    resolvedModel: model, protocol: 'openai' as const, endpoint, dispatchProfileId: profileId,
    supplyProfileAuthzVersion: 1, credentialId, credentialVersion: 1, credentialAuthzVersion: credential.authzVersion,
    accountAuthzVersion: account.authzVersion, supplierCostVersion: cost?.id ?? null };
  let initialAttempt: InitialAttemptInput;
  if (mode === 'byok') initialAttempt = { ...attemptBase, accountOwnerKind: 'tenant', profileAccountAuthzVersion: 1 };
  else {
    assert.ok(poolId && poolVersion && grantVersion && grantProfileVersion && grantPoolVersion);
    initialAttempt = { ...attemptBase, accountOwnerKind: 'platform', poolId, poolAuthzVersion: poolVersion,
      poolMemberAccountAuthzVersion: account.authzVersion, poolMemberAuthzVersion: 1, poolGrantAuthzVersion: grantVersion,
      poolGrantProfileAuthzVersion: grantProfileVersion, poolGrantPoolAuthzVersion: grantPoolVersion };
  }
  // Exercise the real private HMAC path; never retain/log any deployment key.
  const syntheticHmac = Uint8Array.from([5, 7, 0, 1, 3, 8, 2, 1]);
  const metering = new SaasMeteringService(gateway, { idempotencyHmacSecret: syntheticHmac });
  const billing = new PlatformWalletLedgerService();
  const admissionInput: PreparedRequestAdmissionInput = { ...routeFacts, requestId, attemptId, tenantId, projectId,
    proxyKeyId: keyId, entitlementId, supplyProfileId: profileId, supplyProfileVersion: 1, modelScopeVersion: 1,
    supplyMode: mode, principalKind: 'member', principalId: userId, authzVersion: 1, entitlementVersion: 1,
    configVersion: route.version, publicModel: alias, protocol: 'openai', endpoint, requestFingerprint: fingerprint,
    requestFingerprintVersion: 'canonical-v1', initialAttempt };
  const admitted = await phase('admission', () => metering.admitPreparedRequest(admissionInput));
  assert.equal(admitted.kind, 'created');
  if (admitted.kind !== 'created' || !admitted.initialAttempt) throw new Error('FIN057 prepared admission did not create an attempt');

  let reservationId: string | null = null, priceSnapshotRef: string | null = null;
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
  if (price) {
    // Quote/snapshot and balanced funding are test-owned immutable fixture
    // metadata under the setup identity. This is NOT a quote-issuance/HTTP
    // admission proof. Reservation/settlement and every metering effect are GW.
    await phase('setup', () => fundWallet(migrator, tenantId));
    const snapshot = await phase('quote_setup', () => pricing.createCustomerPriceSnapshot({ tenantId, requestId,
      customerPriceVersion: price.id, holdInput: { inputTotal: 10, inputUncached: 10, cacheRead: 0,
        cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, outputTotal: 10, reasoningOutput: 0 },
      admissionExpiresAt: deadline, idempotencyKey: requestId }));
    assert.equal(snapshot.admissionTerms.amountMinorUnits, 50n);
    priceSnapshotRef = snapshot.admissionTerms.priceSnapshotRef;
    const hold = await phase('reserve', () => gateway.transaction((tx) => billing.reserve(tx, { supplyMode: 'platform',
      tenantId, requestId, businessKey: `saas-request-admission:${tenantId}:${requestId}`,
      currency: 'USD', amountMinorUnits: '50', priceSnapshotRef: snapshot.admissionTerms.priceSnapshotRef, expiresAt: deadline })));
    reservationId = hold.id;
  }
  const unsigned: PreparedRequestEvidenceInput = { ...routeFacts, ...compiler, evidenceId: randomUUID(), tenantId, projectId,
    requestId, attemptId, attemptOrdinal: 1, proxyKeyId: keyId, entitlementId, entitlementVersion: 1,
    supplyProfileId: profileId, supplyProfileVersion: 1, modelScopeVersion: 1, supplyMode: mode,
    principalKind: 'member', principalId: userId, authzVersion: 1, configVersion: route.version, publicModel: alias,
    protocol: 'openai', endpoint, upstreamId, accountOwnerKind: owner.ownerKind, accountId, providerId, productId,
    resolvedModel: model, dispatchProfileId: profileId, supplyProfileAuthzVersion: 1, credentialId, credentialVersion: 1,
    credentialAuthzVersion: credential.authzVersion, accountAuthzVersion: account.authzVersion,
    profileAccountAuthzVersion: mode === 'byok' ? 1 : null, poolId, poolAuthzVersion: poolVersion,
    poolMemberAccountAuthzVersion: mode === 'byok' ? null : account.authzVersion,
    poolMemberAuthzVersion: mode === 'byok' ? null : 1, poolGrantAuthzVersion: grantVersion,
    poolGrantProfileAuthzVersion: grantProfileVersion, poolGrantPoolAuthzVersion: grantPoolVersion,
    supplierCostVersion: cost?.id ?? null, usage: { inputTotalUpperBound: 10, inputUncachedUpperBound: 10,
      cacheReadUpperBound: 0, cacheWriteUpperBound: 0, cacheWrite5mUpperBound: 0, cacheWrite1hUpperBound: 0,
      outputTotalUpperBound: 10, reasoningOutputUpperBound: 0, feasibleInputBuckets: ['input'] },
    maxHoldCurrency: mode === 'platform' ? 'USD' : null, maxHoldMinorUnits: mode === 'platform' ? 50 : 0,
    dispatchDeadline: deadline, expiresAt: deadline, retryBudget: 0, verifierKeyId: keyIdForSignature,
    signatureBase64: '', audit };
  const signed = { ...unsigned, signatureBase64: sign(null,
    Buffer.from(canonicalPreparedRequestEvidencePayload(unsigned)), keyPair.privateKey).toString('base64') };
  const evidenceService = new SaasPreparedRequestEvidenceService(gateway,
    { trustedVerifierPublicKeys: new Map([[keyIdForSignature, keyPair.publicKey]]) });
  const registered = await phase('evidence_register', () => evidenceService.register(signed));
  await phase('evidence_preflight', () => evidenceService.preflightForDispatch(registered.evidenceId, audit, { payloadSha256: payload }));
  await phase('evidence_claim', () => evidenceService.claimForDispatch(registered.evidenceId, audit, { payloadSha256: payload }));
  const claimed = await phase('dispatch_observation', () => metering.getAttempt(tenantId, requestId, attemptId));
  assert.ok(claimed && claimed.preparedEvidenceId === registered.evidenceId);
  const dispatching = await phase('dispatch_observation', () => metering.transitionAttempt({ tenantId, requestId, attemptId,
    expectedDispatchState: 'not_sent', expectedResultState: 'pending', expectedResponseStarted: false,
    expectedStateVersion: claimed.stateVersion, dispatchState: 'dispatching' }));
  const sent = await phase('dispatch_observation', () => metering.transitionAttempt({ tenantId, requestId, attemptId,
    expectedDispatchState: 'dispatching', expectedResultState: 'pending', expectedResponseStarted: false,
    expectedStateVersion: dispatching.stateVersion, dispatchState: 'sent', responseStarted: true, resultHttpStatus: 200 }));
  const settlementKey = `fin057-settlement:${requestId}`;
  return { tenantId, metering, billing, sent, settlementKeyDigest: digestClientKey(settlementKey, syntheticHmac),
    input: { tenantId, requestId, attemptId, supplyMode: mode, responseStarted: true,
    reservationId, priceSnapshotRef, currency: price ? 'USD' : null, customerPriceVersion: price?.id ?? null,
    chargeAmountMinorUnits: price ? '12' : null, usageEventKey: `fin057-usage:${attemptId}`,
    settlementKey, usageEvidenceRef: sha256Hex(`fin057-opaque-original:${requestId}`),
    usage: observedUsage() } };
}

async function fundWallet(migrator: SaasDatabase, tenantId: string): Promise<void> {
  const walletId = randomUUID(), fundingId = randomUUID(), reference = `fin057-funding-${randomUUID()}`;
  await migrator.transaction(async (tx) => {
    await tx.query("INSERT INTO saas_wallets (id, tenant_id, currency) VALUES ($1, $2, 'USD')", [walletId, tenantId]);
    await tx.query(`INSERT INTO saas_ledger_transactions
      (id, tenant_id, currency, idempotency_namespace, business_key, source_type, amount_minor_units, metadata_ref, source_order_ref)
      VALUES ($1, $2, 'USD', 'fin057.seed', $3, 'wallet_funding', 100, $3, $3)`, [fundingId, tenantId, reference]);
    await tx.query(`INSERT INTO saas_ledger_entries
      (id, transaction_id, tenant_id, currency, direction, amount_minor_units, account_type, account_ref, wallet_id)
      VALUES ($1, $3, $4, 'USD', 'credit', 100, 'wallet', $5::text, $5::uuid),
             ($2, $3, $4, 'USD', 'debit', 100, 'funding_source', $6, NULL)`,
    [randomUUID(), randomUUID(), fundingId, tenantId, walletId, reference]);
    await tx.query("SELECT set_config('saas.billing_ledger_projection_write', 'on', true), set_config('saas.billing_ledger_transaction_id', $1, true)", [fundingId]);
    assert.equal((await tx.query('UPDATE saas_wallets SET posted_balance_minor_units = 100 WHERE id = $1 AND tenant_id = $2',
      [walletId, tenantId])).rowCount, 1);
  });
}

/** New legacy-format fixture inserts only: not a historical rewrite or a pre057 runtime claim. */
export async function completeLegacy(gateway: SaasDatabase, fixture: Fixture): Promise<void> {
  const i = fixture.input;
  await gateway.transaction(async (tx) => {
    const event = await fixture.metering.recordUsageEvent({ ...i, eventKey: i.usageEventKey }, { executor: tx });
    const settlement = await fixture.metering.createUsageSettlement({ tenantId: i.tenantId,
      usageEventId: event.id, settlementKey: i.settlementKey }, { executor: tx });
    assert.equal(settlement.normalSuccessEvidenceRef, null);
    if (i.supplyMode === 'platform') {
      assert.ok(i.currency && i.priceSnapshotRef && i.chargeAmountMinorUnits);
      const result = await fixture.billing.settle(tx, { supplyMode: 'platform', tenantId: i.tenantId, requestId: i.requestId,
        businessKey: `saas-request-admission:${i.tenantId}:${i.requestId}`, currency: i.currency,
        priceSnapshotRef: i.priceSnapshotRef, settlementId: i.settlementKey, usageEvidenceRef: i.usageEvidenceRef,
        actualAmountMinorUnits: i.chargeAmountMinorUnits });
      assert.equal(result.state, 'settled');
    }
    await fixture.metering.transitionAttempt({ ...i, executor: tx, expectedDispatchState: 'sent',
      expectedResultState: 'pending', expectedResponseStarted: true, expectedStateVersion: fixture.sent.stateVersion,
      dispatchState: 'sent', resultState: 'succeeded', responseStarted: true });
    const pending = await fixture.metering.transitionRequest({ ...i, executor: tx, expectedResultState: 'pending',
      expectedReconciliationState: 'none', expectedStateVersion: 1, resultState: 'pending', reconciliationState: 'pending' });
    const complete = await fixture.metering.transitionRequest({ ...i, executor: tx, expectedResultState: 'pending',
      expectedReconciliationState: 'pending', expectedStateVersion: pending.stateVersion,
      resultState: 'succeeded', reconciliationState: 'resolved' });
    if (i.supplyMode === 'platform') await fixture.metering.transitionFinancialStatus({ ...i, executor: tx,
      expectedFinancialStatus: 'pending', expectedStateVersion: complete.stateVersion, financialStatus: 'settled' });
  });
}
