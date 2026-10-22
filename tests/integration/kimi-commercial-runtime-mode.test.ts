import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  kimiCommercialCliEnvironment,
  provisionKimiCommercialFixture,
} from '../../scripts/ops/verify-commercial-kimi.js';
import { SAAS_DATABASE_PREPARED_STATEMENTS_ENV } from '../../src/saas/db/database.js';

test('Kimi commercial CLI environment defaults to explicit prepared statements off', () => {
  const result = kimiCommercialCliEnvironment({});
  assert.equal(result.postgresPreparedStatements, 'off');
  assert.equal(result.environment[SAAS_DATABASE_PREPARED_STATEMENTS_ENV], result.postgresPreparedStatements);
});

test('Kimi commercial CLI environment propagates only the resolved off or native mode', () => {
  for (const mode of ['off', 'native'] as const) {
    const result = kimiCommercialCliEnvironment({
      [SAAS_DATABASE_PREPARED_STATEMENTS_ENV]: mode,
      UNRELATED_TEST_SETTING: 'excluded',
    });
    assert.equal(result.postgresPreparedStatements, mode);
    assert.equal(result.environment[SAAS_DATABASE_PREPARED_STATEMENTS_ENV], result.postgresPreparedStatements);
    assert.equal(result.environment.UNRELATED_TEST_SETTING, undefined);
  }
});

test('Kimi commercial CLI environment rejects unrecognized prepared statement modes without coercion', () => {
  for (const mode of ['', 'true', '1', 'NATIVE', ' native', 'native ', 'automatic']) {
    assert.throws(() => kimiCommercialCliEnvironment({ [SAAS_DATABASE_PREPARED_STATEMENTS_ENV]: mode }), {
      name: 'TypeError',
      message: `${SAAS_DATABASE_PREPARED_STATEMENTS_ENV} must be off or native`,
    });
  }
});

test('Kimi commercial fixture rejects an invalid database mode before URL checks or fixture resources', async () => {
  const previous = process.env[SAAS_DATABASE_PREPARED_STATEMENTS_ENV];
  process.env[SAAS_DATABASE_PREPARED_STATEMENTS_ENV] = 'invalid';
  try {
    await assert.rejects(provisionKimiCommercialFixture(`local-test-unused-${randomUUID()}`), {
      name: 'TypeError',
      message: `${SAAS_DATABASE_PREPARED_STATEMENTS_ENV} must be off or native`,
    });
  } finally {
    if (previous === undefined) delete process.env[SAAS_DATABASE_PREPARED_STATEMENTS_ENV];
    else process.env[SAAS_DATABASE_PREPARED_STATEMENTS_ENV] = previous;
  }
});
