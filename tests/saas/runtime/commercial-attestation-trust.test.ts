import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { parseCommercialAttestationTrust, loadCommercialAttestationTrust, CommercialAttestationTrustError } from '../../../src/saas/runtime/commercial-attestation-trust.js';
import type { ManagedSaasDeploymentConfig } from '../../../src/saas/deployment.js';

const pair = generateKeyPairSync('ed25519');
const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const source = () => ({ version: 1, keys: [{ keyId: 'commercial-verifier-v1', publicKeyPem }], testVectorDigests: [{ suiteVersion: 'commercial-suite-v1', sha256: 'a'.repeat(64) }] });

test('commercial trust loads distinct public verification keys and suite digest maps', () => {
  const trust = parseCommercialAttestationTrust(source());
  assert.equal((trust.trustedVerifierPublicKeys as Record<string, typeof pair.publicKey>)['commercial-verifier-v1']?.asymmetricKeyType, 'ed25519');
  assert.equal((trust.trustedTestVectorDigests as Record<string, string>)['commercial-suite-v1'], 'a'.repeat(64));
  assert.ok(Object.isFrozen(trust.trustedVerifierPublicKeys));
});

test('commercial trust rejects private material, duplicate identities, missing suite digests and unknown fields', () => {
  const valid = source();
  for (const value of [
    { ...valid, signer: 'not-allowed' },
    { ...valid, keys: [...valid.keys, ...valid.keys] },
    { ...valid, testVectorDigests: [] },
    { ...valid, testVectorDigests: [...valid.testVectorDigests, ...valid.testVectorDigests] },
    { ...valid, keys: [{ keyId: 'private', publicKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }] },
    { ...valid, testVectorDigests: [{ suiteVersion: 'suite', sha256: 'A'.repeat(64) }] },
  ]) assert.throws(() => parseCommercialAttestationTrust(value), CommercialAttestationTrustError);
});

test('commercial trust is absent without config and forbidden on gateway', async () => {
  assert.equal(await loadCommercialAttestationTrust({ workloadRole: 'control-plane' } as ManagedSaasDeploymentConfig, {}), undefined);
  await assert.rejects(loadCommercialAttestationTrust({ workloadRole: 'gateway' } as ManagedSaasDeploymentConfig, { MODEL_ROUTER_SAAS_COMMERCIAL_ATTESTATION_TRUST_FILE: '/not-opened' }), CommercialAttestationTrustError);
});
