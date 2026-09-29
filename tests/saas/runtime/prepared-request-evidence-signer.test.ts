import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
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
  type PreparedRequestEvidencePrivateKey,
  PreparedRequestEvidenceSigner,
  PreparedRequestEvidenceSignerError,
} from '../../../src/saas/runtime/prepared-request-evidence-signer.js';

const KEY_ID = 'prepared-verifier-1';
const OTHER_KEY_ID = 'prepared-verifier-2';
const primary = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

function baseInput(): PreparedRequestEvidenceInput {
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
    verifierKeyId: 'caller-supplied-key',
    signatureBase64: 'caller-supplied-signature',
    audit: {
      actorUserId: 'system-user',
      entryPoint: 'test',
      sourceIp: null,
      userAgent: null,
      requestId: null,
    },
  };
}

function activeRegistry(
  keyId = KEY_ID,
  publicKey: typeof primary.publicKey = primary.publicKey,
): TrustedPreparedRequestVerifierKeyRegistry {
  return createTrustedPreparedRequestVerifierKeyRegistry({
    keys: [{ keyId, publicKey, status: 'active' }],
  });
}

function signer(
  privateKey: PreparedRequestEvidencePrivateKey = primary.privateKey,
  registry = activeRegistry(),
  verifierKeyId = KEY_ID,
): PreparedRequestEvidenceSigner {
  return new PreparedRequestEvidenceSigner({ registry, verifierKeyId, privateKey });
}

function expectSignerError(action: () => unknown, code: PreparedRequestEvidenceSignerError['code']): void {
  assert.throws(action, (error: unknown) => error instanceof PreparedRequestEvidenceSignerError && error.code === code);
}

function verifyWithRegistry(
  input: PreparedRequestEvidenceInput,
  registry: TrustedPreparedRequestVerifierKeyRegistry,
): boolean {
  const signature = Buffer.from(input.signatureBase64, 'base64');
  const publicKey = registry.get(input.verifierKeyId);
  if (!publicKey || signature.length !== 64) return false;
  return verifySignature(
    null,
    Buffer.from(canonicalPreparedRequestEvidencePayload(input), 'utf8'),
    publicKey,
    signature,
  );
}

test('signs complete evidence with KeyObject, PEM, and PKCS8 DER private keys', () => {
  const privatePem = primary.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const privateDer = primary.privateKey.export({ type: 'pkcs8', format: 'der' });

  for (const privateKey of [primary.privateKey, privatePem, privateDer]) {
    const registry = activeRegistry();
    const input = baseInput();
    const output = signer(privateKey, registry).sign(input);

    assert.notStrictEqual(output, input);
    assert.equal(output.verifierKeyId, KEY_ID);
    assert.equal(input.verifierKeyId, 'caller-supplied-key');
    assert.equal(input.signatureBase64, 'caller-supplied-signature');
    assert.match(output.signatureBase64, /^[A-Za-z0-9+/]{86}==$/);
    assert.equal(Buffer.from(output.signatureBase64, 'base64').length, 64);
    assert.deepEqual(output.usage, input.usage);
    assert.deepEqual(output.audit, input.audit);
    assert.equal(verifyWithRegistry(output, registry), true);
  }
});

test('requires an active registry key and exact public-key match at startup', () => {
  const retiredRegistry = createTrustedPreparedRequestVerifierKeyRegistry({
    keys: [
      { keyId: KEY_ID, publicKey: primary.publicKey, status: 'retired' },
      { keyId: OTHER_KEY_ID, publicKey: other.publicKey, status: 'active' },
    ],
  });
  expectSignerError(() => signer(primary.privateKey, retiredRegistry), 'INACTIVE_VERIFIER_KEY');

  expectSignerError(
    () => signer(primary.privateKey, activeRegistry(OTHER_KEY_ID, other.publicKey), OTHER_KEY_ID),
    'PRIVATE_KEY_MISMATCH',
  );
  expectSignerError(
    () => signer(primary.privateKey, activeRegistry(OTHER_KEY_ID, other.publicKey), KEY_ID),
    'UNKNOWN_VERIFIER_KEY',
  );
});

test('rejects public, malformed, and non-Ed25519 private-key formats', () => {
  const publicPem = primary.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const malformedDer = Uint8Array.from([0x30, 0x01, 0x00]);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

  expectSignerError(() => signer(publicPem), 'INVALID_PRIVATE_KEY');
  expectSignerError(() => signer(malformedDer), 'INVALID_PRIVATE_KEY');
  expectSignerError(() => signer(rsa.privateKey), 'UNSUPPORTED_KEY_ALGORITHM');
  expectSignerError(() => signer(primary.publicKey), 'INVALID_PRIVATE_KEY');
});

test('binds the configured verifier key and evidence fields to the canonical signature', () => {
  const registry = activeRegistry();
  const output = signer(primary.privateKey, registry).sign(baseInput());
  const canonical = canonicalPreparedRequestEvidencePayload(output);
  const verified = verifySignature(
    null,
    Buffer.from(canonical, 'utf8'),
    registry.getRequired(KEY_ID),
    Buffer.from(output.signatureBase64, 'base64'),
  );
  assert.equal(verified, true);

  const tenantTampered = { ...output, tenantId: 'tenant-tampered' };
  const usageTampered = {
    ...output,
    usage: { ...output.usage, inputTotalUpperBound: '101' },
  };
  const keyIdTampered = { ...output, verifierKeyId: 'different-key' };
  for (const tampered of [tenantTampered, usageTampered, keyIdTampered]) {
    assert.equal(
      verifySignature(
        null,
        Buffer.from(canonicalPreparedRequestEvidencePayload(tampered), 'utf8'),
        registry.getRequired(KEY_ID),
        Buffer.from(output.signatureBase64, 'base64'),
      ),
      false,
    );
  }
});

test('fails closed for incomplete evidence and does not expose private key material', () => {
  const preparedSigner = signer();
  const invalidInput = { ...baseInput(), evidenceId: undefined };
  expectSignerError(() => preparedSigner.sign(invalidInput), 'INVALID_INPUT');
  assert.equal(Object.hasOwn(preparedSigner, 'privateKey'), false);
  assert.equal(JSON.stringify(preparedSigner).includes('BEGIN'), false);
});
