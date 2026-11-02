import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SaasCatalogError } from '../../../src/saas/catalog/errors.js';
import {
  OPERATOR_ASSERTION_EVIDENCE_KIND,
  type OperatorAssertionEvidenceReference,
  type RegisterOperatorAssertedRightsInput,
  registerOperatorAssertedRights,
} from '../../../src/saas/catalog/operator-assertion-registration.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import type {
  ProviderEligibilityRequest,
  ProviderRightsAuditContext,
  RegisterProviderCapabilityInput,
  RegisterProviderRightsVersionInput,
} from '../../../src/saas/catalog/types.js';
import { FakeCatalogDatabase } from './fake-database.js';

const NOW = new Date('2026-11-02T00:00:00.000Z');
const ASSERTED_AT = '2026-11-01T23:00:00.000Z';
const EVIDENCE_HASH = 'a'.repeat(64);
const AUDIT: ProviderRightsAuditContext = {
  actorUserId: 'operator-user-1',
  entryPoint: 'bulk_import',
  requestId: 'import-job-1',
};

function assertionInput(
  overrides: Partial<RegisterOperatorAssertedRightsInput> = {},
): RegisterOperatorAssertedRightsInput {
  return {
    rightsId: 'operator-rights-1',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'oauth',
    supplyMode: 'platform',
    region: 'global',
    purpose: 'inference',
    modelScope: ['model-a'],
    endpointScope: ['messages'],
    effectiveAt: '2026-11-01T00:00:00.000Z',
    assertedAt: ASSERTED_AT,
    description: 'Operator approved this supply scope for platform inference.',
    audit: AUDIT,
    ...overrides,
  };
}

function eligibilityRequest(): ProviderEligibilityRequest {
  return {
    providerId: 'provider-a',
    productId: 'product-a',
    model: 'model-a',
    endpoint: 'messages',
    credentialType: 'oauth',
    supplyMode: 'platform',
    region: 'global',
    purpose: 'inference',
  };
}

function capability(overrides: Partial<RegisterProviderCapabilityInput> = {}): RegisterProviderCapabilityInput {
  return {
    providerId: 'provider-a',
    productId: 'product-a',
    model: 'model-a',
    endpoint: 'messages',
    protocol: 'anthropic',
    supportLevel: 'supported',
    validationState: 'verified',
    evidenceVersion: 'probe-v1',
    discoverySource: 'manual',
    evidenceReference: 'capability-probe-1',
    evidenceSha256: EVIDENCE_HASH,
    ...overrides,
  };
}

async function setup(validationState: 'verified' | 'unverified' = 'verified'): Promise<{
  database: FakeCatalogDatabase;
  service: SaasCatalogService;
}> {
  const database = new FakeCatalogDatabase();
  const service = new SaasCatalogService(database, { now: () => NOW });
  await service.registerProviderProduct({
    providerId: 'provider-a',
    productId: 'product-a',
    displayName: 'Provider A Product',
  });
  await service.registerProviderCapability(capability({ validationState }));
  return { database, service };
}

test('operator assertion registers auditable active rights accepted by eligibility resolution', async () => {
  const { database, service } = await setup();
  const registered = await registerOperatorAssertedRights(service, assertionInput());

  assert.equal(registered.version, 1);
  assert.equal(registered.status, 'active');
  assert.equal(registered.rightsId, 'operator-rights-1');
  assert.equal(registered.credentialType, 'oauth');
  assert.equal(registered.supplyMode, 'platform');
  assert.deepEqual(registered.modelScope, ['model-a']);
  assert.deepEqual(registered.endpointScope, ['messages']);
  const evidence = JSON.parse(registered.evidenceReference) as OperatorAssertionEvidenceReference;
  assert.deepEqual(evidence, {
    kind: OPERATOR_ASSERTION_EVIDENCE_KIND,
    assertedBy: AUDIT.actorUserId,
    assertedAt: ASSERTED_AT,
    description: 'Operator approved this supply scope for platform inference.',
  });
  assert.equal(
    registered.evidenceSha256,
    createHash('sha256').update(registered.evidenceReference, 'utf8').digest('hex'),
  );
  assert.equal(database.state.auditEvents.length, 1);
  assert.equal(database.state.auditEvents[0]?.actor_user_id, AUDIT.actorUserId);
  assert.equal(database.state.auditEvents[0]?.action, 'provider_rights.version_registered');

  const allowed = await service.evaluateProviderEligibility(eligibilityRequest(), NOW);
  assert.equal(allowed.decision, 'allow');
  if (allowed.decision === 'allow') {
    assert.equal(allowed.rights.rightsId, registered.rightsId);
    assert.equal(allowed.rights.version, 1);
    assert.equal(allowed.rights.status, 'active');
    assert.equal(allowed.capability.validationState, 'verified');
  }
});

test('revoking operator-asserted rights appends a version and makes eligibility fail closed', async () => {
  const { service } = await setup();
  const registered = await registerOperatorAssertedRights(service, assertionInput());
  assert.equal((await service.evaluateProviderEligibility(eligibilityRequest(), NOW)).decision, 'allow');

  const revoked = await service.revokeProviderRights({
    rightsId: registered.rightsId,
    approvalReference: 'operator-revocation-1',
    effectiveAt: NOW,
    evidenceReference: 'operator-revocation-evidence-1',
    evidenceSha256: 'b'.repeat(64),
    audit: { ...AUDIT, requestId: 'revoke-job-1' },
  });
  assert.equal(revoked.version, 2);
  assert.equal(revoked.status, 'revoked');

  const denied = await service.evaluateProviderEligibility(eligibilityRequest(), NOW);
  assert.equal(denied.decision, 'deny');
  if (denied.decision === 'deny') assert.equal(denied.reason, 'rights_revoked');
});

test('existing free-form rights evidence keeps its validation and eligibility behavior', async () => {
  const { service } = await setup();
  const freeFormRights = {
    rightsId: 'upstream-evidence-rights-1',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'oauth',
    supplyMode: 'platform',
    region: 'global',
    purpose: 'inference',
    modelScope: ['model-a'],
    endpointScope: ['messages'],
    effectiveAt: '2026-11-01T00:00:00.000Z',
    approvalReference: 'upstream-approval-1',
    status: 'active',
    evidenceReference: 'upstream-contract-reference-1',
    evidenceSha256: EVIDENCE_HASH,
  } satisfies RegisterProviderRightsVersionInput;
  const registered = await service.registerProviderRightsVersion(freeFormRights);
  assert.equal(registered.evidenceReference, 'upstream-contract-reference-1');
  assert.equal((await service.evaluateProviderEligibility(eligibilityRequest(), NOW)).decision, 'allow');

  await assert.rejects(
    service.registerProviderRightsVersion({
      ...freeFormRights,
      rightsId: 'invalid-upstream-evidence-rights-1',
      evidenceSha256: 'invalid-hash',
    }),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'INVALID_INPUT',
  );
});

test('operator assertion does not relax provider capability verification', async () => {
  const { service } = await setup('unverified');
  await registerOperatorAssertedRights(service, assertionInput());

  const denied = await service.evaluateProviderEligibility(eligibilityRequest(), NOW);
  assert.equal(denied.decision, 'deny');
  if (denied.decision === 'deny') assert.equal(denied.reason, 'capability_unverified');
});
