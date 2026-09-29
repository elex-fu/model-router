import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createProviderHttpTestAddressCapability,
  isGlobalProviderAddress,
  isProviderHttpTestAddressCapability,
  selectPinnedProviderAddress,
} from '../../../src/saas/gateway/provider-http-address.js';

const TEST_CA = '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----';

test('loopback provider addresses require both test-runner capability and NODE_ENV=test', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const capability = createProviderHttpTestAddressCapability(TEST_CA);
    assert.equal(isProviderHttpTestAddressCapability(capability), true);
    assert.equal(isGlobalProviderAddress('127.0.0.1'), false);
    assert.throws(() => selectPinnedProviderAddress('127.0.0.1', []));
    assert.deepEqual(selectPinnedProviderAddress('127.0.0.1', [], capability), {
      address: '127.0.0.1',
      family: 4,
    });
    assert.throws(() => selectPinnedProviderAddress('localhost', [{ address: '127.0.0.1', family: 4 }], capability));
    assert.throws(() => selectPinnedProviderAddress('192.168.1.2', [], capability));

    process.env.NODE_ENV = 'production';
    assert.equal(isProviderHttpTestAddressCapability(capability), false);
    assert.throws(() => selectPinnedProviderAddress('127.0.0.1', [], capability));
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test('the test address capability cannot be minted outside the Node test runner', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => createProviderHttpTestAddressCapability(TEST_CA));
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});
