import type { SaasDatabase } from './types.js';

export {
  SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
  SaasCredentialValidationWorkerPrivilegeError,
  verifyCredentialValidationWorkerRuntimePrivileges,
} from './credential-validation-worker-privileges.js';
export { createSaasDatabase } from './database.js';
export {
  verifySaasMigrations,
  verifyUnknownOutcomeSaasMigrations,
} from './migrate.js';
export {
  SAAS_RUNTIME_PRIVILEGE_PROBE_SQL,
  SaasRuntimePrivilegeError,
  verifySaasRuntimeDatabasePrivileges,
} from './runtime-privileges.js';
export type {
  SaasDatabase,
  SaasDatabaseClient,
  SaasDatabaseOptions,
  SaasDatabasePool,
  SqlExecutor,
  SqlResult,
} from './types.js';

export function migrateSaasDatabase(database: SaasDatabase): Promise<void> {
  return database.migrate();
}

export function verifySaasDatabase(database: SaasDatabase): Promise<void> {
  return database.verifySchema();
}

export function pingSaasDatabase(database: SaasDatabase): Promise<void> {
  return database.ping();
}

export function closeSaasDatabase(database: SaasDatabase): Promise<void> {
  return database.close();
}
