import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL,
  SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
  saasAdvisoryKey,
  sortAndDedupeAdvisoryKeys,
} from '../../../src/saas/db/advisory-lock-keys.js';

test('matches migration 046 global authorization writer fence SQL', () => {
  assert.equal(
    SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
    "SELECT set_config('lock_timeout', '2s', TRUE), set_config('statement_timeout', '10s', TRUE)",
  );
  assert.equal(SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL, 'SELECT pg_advisory_xact_lock(1396788563, 46)');
});

test('preserves existing tenant, project, user, pool, and supply-profile advisory keys', () => {
  assert.equal(saasAdvisoryKey.tenant('tenant:1'), 'saas-authz:tenant:tenant:1');
  assert.equal(saasAdvisoryKey.project('tenant:1', 'project:2'), 'saas-authz:project:tenant:1:project:2');
  assert.equal(saasAdvisoryKey.user('user:3'), 'user:3');
  assert.equal(saasAdvisoryKey.platformPool('pool:4'), 'saas_platform_pool:706f6f6c3a34');
  assert.equal(
    saasAdvisoryKey.supplyProfile('tenant:1', 'profile:5'),
    'saas_supply_profile:74656e616e743a31:70726f66696c653a35',
  );
});

test('hex-encodes Unicode and colon-containing components for new advisory keys', () => {
  assert.equal(
    saasAdvisoryKey.apiKey('租户:一', '项目:二', 'key:🔑'),
    'saas-authz:api-key:e7a79fe688b73ae4b880:e9a1b9e79bae3ae4ba8c:6b65793af09f9491',
  );
});

test('builds all new advisory key namespaces', () => {
  assert.deepEqual(
    {
      commercialCustomer: saasAdvisoryKey.commercialCustomer('tenant:1', 'head:2'),
      commercialProvider: saasAdvisoryKey.commercialProvider('provider:3', 'head:4'),
      tenantProviderAccount: saasAdvisoryKey.tenantProviderAccount('tenant:5', 'account:6'),
      platformProviderAccount: saasAdvisoryKey.platformProviderAccount('account:7'),
      tenantProviderCredential: saasAdvisoryKey.tenantProviderCredential('tenant:8', 'credential:9'),
      platformProviderCredential: saasAdvisoryKey.platformProviderCredential('credential:10'),
      credentialVersion: saasAdvisoryKey.credentialVersion('tenant', 'tenant:11', 'credential:12', 42),
      supplyProfileAccount: saasAdvisoryKey.supplyProfileAccount('tenant:13', 'profile:14', 'account:15'),
    },
    {
      commercialCustomer: 'saas-authz:commercial-customer:74656e616e743a31:686561643a32',
      commercialProvider: 'saas-authz:commercial-provider:70726f76696465723a33:686561643a34',
      tenantProviderAccount: 'saas-authz:tenant-provider-account:74656e616e743a35:6163636f756e743a36',
      platformProviderAccount: 'saas-authz:platform-provider-account:6163636f756e743a37',
      tenantProviderCredential: 'saas-authz:tenant-provider-credential:74656e616e743a38:63726564656e7469616c3a39',
      platformProviderCredential: 'saas-authz:platform-provider-credential:63726564656e7469616c3a3130',
      credentialVersion: 'saas-authz:credential-version:tenant:74656e616e743a3131:63726564656e7469616c3a3132:42',
      supplyProfileAccount:
        'saas-authz:supply-profile-account:74656e616e743a3133:70726f66696c653a3134:6163636f756e743a3135',
    },
  );
});

test('rejects credential versions that are not safe positive integers', () => {
  for (const version of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => saasAdvisoryKey.credentialVersion('tenant', 'owner', 'credential', version),
      /safe positive integer/,
    );
  }

  assert.equal(
    saasAdvisoryKey.credentialVersion('platform', 'owner', 'credential', Number.MAX_SAFE_INTEGER),
    'saas-authz:credential-version:platform:6f776e6572:63726564656e7469616c:9007199254740991',
  );
});

test('dedupes and lexicographically sorts complete advisory keys', () => {
  assert.deepEqual(
    sortAndDedupeAdvisoryKeys([
      'saas-authz:tenant:z',
      'user:2',
      'saas-authz:tenant:a',
      'user:2',
      'saas-authz:tenant:z',
    ]),
    ['saas-authz:tenant:a', 'saas-authz:tenant:z', 'user:2'],
  );
});
