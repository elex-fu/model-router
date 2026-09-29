import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../src/saas/db/database.js';
import {
  SaasRuntimePrivilegeError,
  verifySaasRuntimeDatabasePrivileges,
} from '../../../src/saas/db/runtime-privileges.js';

const configuredConnectionString = process.env.MODEL_ROUTER_SAAS_RUNTIME_PRIVILEGE_TEST_URL;
const connectionString =
  configuredConnectionString && configuredConnectionString.length > 0 ? configuredConnectionString : undefined;

test('dedicated production-like PostgreSQL role passes and unsafe search_path order fails the live probe', {
  skip:
    connectionString === undefined
      ? 'set MODEL_ROUTER_SAAS_RUNTIME_PRIVILEGE_TEST_URL for a disposable role-template database'
      : false,
}, async () => {
  if (!connectionString) return;
  const database = createSaasDatabase({ connectionString, max: 1 });
  try {
    const result = await database.query<{ current_user: string }>('SELECT current_user');
    assert.equal(result.rows[0]?.current_user, 'model_router_saas_control_plane');
    await verifySaasRuntimeDatabasePrivileges(database);
    await database.transaction(async (transaction) => {
      await transaction.query('SET LOCAL search_path TO model_router_saas, pg_catalog');
      await assert.rejects(verifySaasRuntimeDatabasePrivileges(transaction), SaasRuntimePrivilegeError);
    });
  } finally {
    await database.close();
  }
});
