import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KIMI_CODE_CREDENTIAL_VALIDATION_TIMEOUT_MS,
  validateProviderCredential,
} from '../../src/saas/supply/credential-validation-adapters.js';
import type { ProviderCredentialValidationJobRecord } from '../../src/saas/supply/types.js';

// One real onboarding adapter dispatch; it does not import or mutate an account.
// Opt in directly: RUN_KIMI_CODE_ONBOARDING_SMOKE=1 node --test --import tsx
//   tests/integration/kimi-code-onboarding-live.test.ts
// Requires KIMI_CODE_API_KEY. No credential, provider body, thinking or signature
// is logged or saved; assertion diagnostics contain only health metadata.
const enabled = process.env.RUN_KIMI_CODE_ONBOARDING_SMOKE === '1';
const credential = process.env.KIMI_CODE_API_KEY;
const productId = process.env.KIMI_CODE_ONBOARDING_PRODUCT ?? 'kimi-code';
const model = process.env.KIMI_CODE_LIVE_MODEL ?? 'kimi-for-coding';

test('Kimi Code live onboarding adapter verifies the complete bounded Messages envelope', {
  skip: !enabled
    ? 'Set RUN_KIMI_CODE_ONBOARDING_SMOKE=1 to opt in'
    : !credential
      ? 'Set KIMI_CODE_API_KEY to run the live onboarding probe'
      : false,
  timeout: KIMI_CODE_CREDENTIAL_VALIDATION_TIMEOUT_MS + 5_000,
}, async () => {
  assert.ok(credential, 'Set KIMI_CODE_API_KEY to run the live onboarding probe');
  assert.ok(productId === 'kimi-code' || productId === 'kimi-code-global', 'Choose a fixed Kimi Code product');
  const now = new Date().toISOString();
  const job: ProviderCredentialValidationJobRecord = {
    id: 'live-onboarding-job',
    ownerKind: 'platform',
    tenantId: null,
    accountId: 'live-onboarding-account',
    credentialId: 'live-onboarding-credential',
    credentialVersion: 1,
    providerId: 'kimi',
    productId,
    credentialType: 'api-key',
    allowedModels: [model],
    target: { model, endpoint: 'messages', version: 1 },
    idempotencyKey: 'a'.repeat(64),
    state: 'queued',
    attemptCount: 0,
    availableAt: now,
    leaseUntil: null,
    leaseGeneration: 0,
    lastErrorCode: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const secret = Buffer.from(credential);
  try {
    const result = await validateProviderCredential(job, secret);
    assert.deepEqual(result, {
      state: 'verified',
      adapterId: productId === 'kimi-code' ? 'kimi-code-messages-v1' : 'kimi-code-global-messages-v1',
      httpStatus: 200,
      durationMs: result.durationMs,
    });
    assert.equal(JSON.stringify(result).includes(credential), false);
  } finally {
    secret.fill(0);
  }
});
