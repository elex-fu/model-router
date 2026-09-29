import { createSaasDatabase, type SaasDatabase, type SaasDatabaseOptions } from '../saas/db/index.js';

export interface SaasMigrationDependencies {
  env?: NodeJS.ProcessEnv;
  createDatabase?: (options: SaasDatabaseOptions) => SaasDatabase;
  writeLine?: (line: string) => void;
}

export class SaasMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaasMigrationError';
  }
}

const MISSING_DATABASE_URL_MESSAGE =
  'MODEL_ROUTER_SAAS_DATABASE_URL is required for saas:migrate; set it to the SaaS PostgreSQL URL.';
const CONNECTION_ERROR_MESSAGE =
  'Unable to connect to the SaaS PostgreSQL database; verify MODEL_ROUTER_SAAS_DATABASE_URL and connectivity.';
const MIGRATION_ERROR_MESSAGE =
  'Unable to apply SaaS database migrations; verify database permissions and connectivity.';
const CLOSE_ERROR_MESSAGE = 'Unable to close the SaaS PostgreSQL database connection.';
const SUCCESS_MESSAGE =
  'SaaS database migrations applied successfully. Server startup never runs migrations; run model-router saas:migrate explicitly.';

export async function saasMigrate(dependencies: SaasMigrationDependencies = {}): Promise<void> {
  const environment = dependencies.env ?? process.env;
  const connectionString = environment.MODEL_ROUTER_SAAS_DATABASE_URL;
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new SaasMigrationError(MISSING_DATABASE_URL_MESSAGE);
  }

  const createDatabase = dependencies.createDatabase ?? createSaasDatabase;
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));
  let database: SaasDatabase | undefined;
  let failure: SaasMigrationError | undefined;
  let cleanupFailure: SaasMigrationError | undefined;

  try {
    try {
      database = createDatabase({ connectionString });
      await database.ping();
    } catch {
      throw new SaasMigrationError(CONNECTION_ERROR_MESSAGE);
    }

    try {
      await database.migrate();
    } catch {
      throw new SaasMigrationError(MIGRATION_ERROR_MESSAGE);
    }
  } catch (error) {
    failure = error instanceof SaasMigrationError ? error : new SaasMigrationError(MIGRATION_ERROR_MESSAGE);
  } finally {
    if (database) {
      try {
        await database.close();
      } catch {
        if (!failure) cleanupFailure = new SaasMigrationError(CLOSE_ERROR_MESSAGE);
      }
    }
  }

  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;

  try {
    writeLine(SUCCESS_MESSAGE);
  } catch {
    throw new SaasMigrationError('SaaS database migrations completed, but the result could not be reported.');
  }
}
