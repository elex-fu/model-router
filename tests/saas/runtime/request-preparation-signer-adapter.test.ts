import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import { test } from 'node:test';
import {
  canonicalPreparedRequestEvidencePayload,
  type PreparedRequestEvidenceInput,
} from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  createTrustedPreparedRequestVerifierKeyRegistry,
  type TrustedPreparedRequestVerifierKeyRegistry,
} from '../../../src/saas/runtime/prepared-evidence-verifier-keys.js';
import {
  PreparedRequestEvidenceSigner,
  PreparedRequestEvidenceSignerError,
} from '../../../src/saas/runtime/prepared-request-evidence-signer.js';
import {
  REQUEST_PREPARATION_SIGNING_FAILED_MESSAGE,
  type RequestPreparationSigner,
  RequestPreparationSignerAdapter,
  type RequestPreparationSignerInput,
} from '../../../src/saas/runtime/request-preparation-signer-adapter.js';

const KEY_ID = 'prepared-verifier-1';

function baseEvidence(verifierKeyId = KEY_ID): PreparedRequestEvidenceInput {
  return {
    evidenceId: 'evidence-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    attemptOrdinal: 1,
    proxyKeyId: 'key-1',
    entitlementId: 'entitlement-1',
    entitlementVersion: '1',
    supplyProfileId: 'profile-1',
    supplyProfileVersion: '1',
    modelScopeVersion: '1',
    supplyMode: 'byok',
    principalKind: 'member',
    principalId: 'user-1',
    authzVersion: '1',
    configVersion: '1',
    projectPolicyVersion: '1',
    publicModel: 'claude-test',
    protocol: 'anthropic',
    endpoint: '/v1/messages',
    routeConfigId: 'route-1',
    routeConfigVersion: '1',
    routePublicModelId: 'public-model-1',
    routePublicModelVersion: '1',
    routeProtocol: 'anthropic',
    routeTargetMode: 'tenant_account',
    routeUpstreamId: 'upstream-1',
    upstreamId: 'upstream-1',
    accountOwnerKind: 'tenant',
    accountId: 'account-1',
    providerId: 'provider-1',
    productId: 'product-1',
    resolvedModel: 'provider-model-1',
    dispatchProfileId: 'profile-1',
    supplyProfileAuthzVersion: '1',
    credentialId: 'credential-1',
    credentialVersion: '1',
    credentialAuthzVersion: '1',
    accountAuthzVersion: '1',
    profileAccountAuthzVersion: '1',
    poolId: null,
    poolAuthzVersion: null,
    poolMemberAccountAuthzVersion: null,
    poolMemberAuthzVersion: null,
    poolGrantAuthzVersion: null,
    poolGrantProfileAuthzVersion: null,
    poolGrantPoolAuthzVersion: null,
    customerMeteringPolicyId: 'customer-policy-1',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'provider-policy-1',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'attestation-1',
    customerPriceVersion: 'price-1',
    supplierCostVersion: null,
    payloadSha256: 'a'.repeat(64),
    usage: {
      inputTotalUpperBound: '100',
      inputUncachedUpperBound: '100',
      cacheReadUpperBound: '0',
      cacheWriteUpperBound: '0',
      cacheWrite5mUpperBound: '0',
      cacheWrite1hUpperBound: '0',
      outputTotalUpperBound: '50',
      reasoningOutputUpperBound: '50',
      feasibleInputBuckets: ['input'],
    },
    maxHoldCurrency: null,
    maxHoldMinorUnits: '0',
    dispatchDeadline: '2026-09-28T00:10:00.000Z',
    expiresAt: '2026-09-28T00:15:00.000Z',
    retryBudget: 2,
    verifierKeyId,
    signatureBase64: '',
    audit: {
      actorUserId: 'system-user',
      entryPoint: 'test',
      sourceIp: null,
      userAgent: null,
      requestId: null,
    },
  };
}

function activeSigner(): {
  readonly signer: PreparedRequestEvidenceSigner;
  readonly registry: TrustedPreparedRequestVerifierKeyRegistry;
} {
  const keyPair = generateKeyPairSync('ed25519');
  const registry = createTrustedPreparedRequestVerifierKeyRegistry({
    keys: [{ keyId: KEY_ID, publicKey: keyPair.publicKey, status: 'active' }],
  });
  return {
    signer: new PreparedRequestEvidenceSigner({
      registry,
      verifierKeyId: KEY_ID,
      privateKey: keyPair.privateKey,
    }),
    registry,
  };
}

function requestInput(evidence = baseEvidence()): RequestPreparationSignerInput {
  const canonicalPayload = canonicalPreparedRequestEvidencePayload(evidence);
  return {
    verifierKeyId: KEY_ID,
    canonicalPayload,
    canonicalPayloadSha256: createHash('sha256').update(Buffer.from(canonicalPayload, 'utf8')).digest('hex'),
    evidence,
  };
}

function assertSigningFailed(result: Awaited<ReturnType<RequestPreparationSignerAdapter['sign']>>): void {
  assert.equal(result.decision, 'block');
  if (result.decision !== 'block') return;
  assert.equal(result.code, 'signing_failed');
  assert.equal(result.message, REQUEST_PREPARATION_SIGNING_FAILED_MESSAGE);
}

test('signs only the verified request-preparation payload and returns a registry-verifiable signature', async () => {
  const { signer, registry } = activeSigner();
  const adapter = new RequestPreparationSignerAdapter({ signer, runtimeVerifierKeyId: KEY_ID });
  const input = requestInput();

  const result = await adapter.sign(input);

  assert.equal(result.decision, 'allow');
  if (result.decision !== 'allow') return;
  const signatureBase64 = result.value.signatureBase64;
  assert.match(signatureBase64, /^[A-Za-z0-9+/]{86}==$/);
  assert.equal(Buffer.from(signatureBase64, 'base64').length, 64);
  assert.equal(Buffer.from(signatureBase64, 'base64').toString('base64'), signatureBase64);

  const signedEvidence = { ...input.evidence, signatureBase64 };
  assert.equal(
    verifySignature(
      null,
      Buffer.from(canonicalPreparedRequestEvidencePayload(signedEvidence), 'utf8'),
      registry.getRequired(KEY_ID),
      Buffer.from(signatureBase64, 'base64'),
    ),
    true,
  );
});

test('blocks canonical payload, key id, and hash tampering before signing', async () => {
  const { signer } = activeSigner();
  const adapter = new RequestPreparationSignerAdapter(signer, KEY_ID);
  const input = requestInput();

  assertSigningFailed(await adapter.sign({ ...input, canonicalPayload: `${input.canonicalPayload}tampered` }));
  assertSigningFailed(await adapter.sign({ ...input, verifierKeyId: 'different-verifier' }));
  assertSigningFailed(
    await adapter.sign({
      ...input,
      canonicalPayloadSha256: `${input.canonicalPayloadSha256[0] === '0' ? '1' : '0'}${input.canonicalPayloadSha256.slice(1)}`,
    }),
  );
  assertSigningFailed(await adapter.sign({ ...input, evidence: baseEvidence('different-verifier') }));
});

test('blocks signer output that changes bound evidence fields', async () => {
  const { signer } = activeSigner();
  const tamperingSigner: RequestPreparationSigner = {
    verifierKeyId: KEY_ID,
    sign(input) {
      return { ...signer.sign(input), tenantId: 'tampered-tenant' };
    },
  };
  const adapter = new RequestPreparationSignerAdapter({ signer: tamperingSigner, verifierKeyId: KEY_ID });

  assertSigningFailed(await adapter.sign(requestInput()));
});

test('maps signer exceptions to one safe stable block decision', async () => {
  const secret = 'private-key-material-must-not-escape';
  const throwingSigner: RequestPreparationSigner = {
    verifierKeyId: KEY_ID,
    sign() {
      throw new Error(secret);
    },
  };
  const adapter = new RequestPreparationSignerAdapter({ signer: throwingSigner, runtimeVerifierKeyId: KEY_ID });

  const result = await adapter.sign(requestInput());

  assertSigningFailed(result);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('leaves inactive and invalid signer configuration to the real signer', () => {
  const keyPair = generateKeyPairSync('ed25519');
  const activeKeyPair = generateKeyPairSync('ed25519');
  const registry = createTrustedPreparedRequestVerifierKeyRegistry({
    keys: [
      { keyId: KEY_ID, publicKey: keyPair.publicKey, status: 'retired' },
      { keyId: 'active-verifier', publicKey: activeKeyPair.publicKey, status: 'active' },
    ],
  });

  assert.throws(
    () => new PreparedRequestEvidenceSigner({ registry, verifierKeyId: KEY_ID, privateKey: keyPair.privateKey }),
    (error: unknown) => error instanceof PreparedRequestEvidenceSignerError && error.code === 'INACTIVE_VERIFIER_KEY',
  );
  assert.throws(
    () =>
      new PreparedRequestEvidenceSigner({
        registry,
        verifierKeyId: 'active-verifier',
        privateKey: activeKeyPair.publicKey,
      }),
    (error: unknown) => error instanceof PreparedRequestEvidenceSignerError && error.code === 'INVALID_PRIVATE_KEY',
  );
});
