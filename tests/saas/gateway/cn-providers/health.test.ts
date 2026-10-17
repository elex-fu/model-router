import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyCnProviderUpstreamError,
  cnProviderResponseIndicatesInsufficientBalance,
  shouldFailoverCnProvider,
} from '../../../../src/saas/gateway/cn-providers/health.js';

test('the payg insufficient-balance text markers match the sub2api set', () => {
  for (const body of [
    '{"error":{"message":"余额不足，请充值"}}',
    '{"error":{"message":"Insufficient Balance"}}',
    '{"code":"insufficient_credit"}',
    'balance is not enough for this request',
    'no enough balance',
  ]) {
    assert.equal(cnProviderResponseIndicatesInsufficientBalance(body), true, body);
  }
  for (const body of ['', 'usage limit reached', 'quota will reset soon', '{"error":"rate limited"}']) {
    assert.equal(cnProviderResponseIndicatesInsufficientBalance(body), false, body);
  }
});

test('a 429 carrying a balance body classifies insufficient-balance BEFORE the shared matrix', () => {
  const cases: readonly [body: string, expected: string][] = [
    ['{"error":{"message":"余额不足"}}', 'insufficient-balance'],
    ['insufficient balance', 'insufficient-balance'],
    ['{"error":{"message":"rate limited, retry later"}}', 'rate-limited'],
    ['', 'rate-limited'],
  ];
  for (const [bodyText, expected] of cases) {
    assert.deepEqual(
      classifyCnProviderUpstreamError({ status: 429, bodyText }),
      { kind: expected, status: 429 },
      bodyText,
    );
  }
});

test('every other status delegates to the shared classifier unchanged', () => {
  // 402 → insufficient-balance unconditionally (the shared matrix).
  assert.deepEqual(classifyCnProviderUpstreamError({ status: 402, bodyText: 'anything' }), {
    kind: 'insufficient-balance',
    status: 402,
  });
  // A balance body on a non-429/402 status does NOT become a balance signal.
  assert.deepEqual(classifyCnProviderUpstreamError({ status: 400, bodyText: 'insufficient balance' }), {
    kind: 'request-error',
    status: 400,
  });
  // Coding-plan window exhaustion 403 → rate-limited (the shared CN matrix).
  assert.deepEqual(classifyCnProviderUpstreamError({ status: 403, bodyText: 'usage limit reached' }), {
    kind: 'rate-limited',
    status: 403,
  });
  // 401 auth-revoked passthrough.
  assert.deepEqual(classifyCnProviderUpstreamError({ status: 401, bodyText: '{"type":"token_revoked"}' }), {
    kind: 'auth-revoked',
    status: 401,
  });
});

test('the failover decision follows the shared matrix', () => {
  assert.equal(shouldFailoverCnProvider({ kind: 'insufficient-balance', status: 429 }), true);
  assert.equal(shouldFailoverCnProvider({ kind: 'rate-limited', status: 429 }), true);
  assert.equal(shouldFailoverCnProvider({ kind: 'transient', status: 500 }), false);
  assert.equal(shouldFailoverCnProvider({ kind: 'request-error', status: 400 }), false);
});
