import { createInterface } from 'node:readline';
import { createSaasDatabase, type SaasDatabase, type SaasDatabaseOptions } from '../saas/db/index.js';
import { SaasIdentityError, SaasIdentityService } from '../saas/identity/index.js';

type SaasIdentityServicePort = Pick<
  SaasIdentityService,
  'bootstrapStatus' | 'issueBootstrapToken' | 'bootstrapPlatformAdmin'
>;

export interface SaasBootstrapPromptIO {
  ask(prompt: string, hidden?: boolean): Promise<string>;
  close?: () => void | Promise<void>;
}

export interface SaasBootstrapAdminDependencies {
  env?: NodeJS.ProcessEnv;
  createDatabase?: (options: SaasDatabaseOptions) => SaasDatabase;
  createIdentityService?: (database: SaasDatabase) => SaasIdentityServicePort;
  prompt?: SaasBootstrapPromptIO;
  writeLine?: (line: string) => void;
}

export class SaasManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaasManagementError';
  }
}

const MIGRATIONS_REQUIRED_MESSAGE =
  'SaaS database schema is missing or unavailable. Apply SaaS migrations separately; this command never runs migrations.';
const DATABASE_ERROR_MESSAGE =
  'Unable to connect to the SaaS PostgreSQL database; verify MODEL_ROUTER_SAAS_DATABASE_URL and connectivity.';
const GENERIC_BOOTSTRAP_ERROR = 'Unable to complete SaaS platform-admin bootstrap.';
const PROMPT_ERROR_MESSAGE = 'Unable to read administrator details from the secure interactive prompt.';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function databaseError(): SaasManagementError {
  return new SaasManagementError(DATABASE_ERROR_MESSAGE);
}

function identityError(error: unknown, operation: 'status' | 'issue' | 'bootstrap'): SaasManagementError {
  if (error instanceof SaasIdentityError) {
    switch (error.code) {
      case 'BOOTSTRAP_ALREADY_COMPLETED':
        return new SaasManagementError('SaaS platform is already initialized; bootstrap was not performed.');
      case 'BOOTSTRAP_TOKEN_ALREADY_ISSUED':
        return new SaasManagementError(
          'A valid SaaS bootstrap token already exists; no new token was issued and bootstrap was not performed.',
        );
      case 'IDENTITY_STORAGE_ERROR':
        return new SaasManagementError(MIGRATIONS_REQUIRED_MESSAGE);
      case 'INVALID_INPUT':
        return new SaasManagementError(
          operation === 'bootstrap'
            ? 'Invalid administrator details; email, display name, and password do not meet SaaS requirements.'
            : GENERIC_BOOTSTRAP_ERROR,
        );
      case 'EMAIL_ALREADY_EXISTS':
        return new SaasManagementError('An account already exists for that administrator email address.');
      case 'BOOTSTRAP_TOKEN_INVALID':
        return new SaasManagementError('The internally generated SaaS bootstrap token was not accepted.');
      default:
        return new SaasManagementError(GENERIC_BOOTSTRAP_ERROR);
    }
  }

  return new SaasManagementError(operation === 'status' ? MIGRATIONS_REQUIRED_MESSAGE : GENERIC_BOOTSTRAP_ERROR);
}

function requireInteractiveTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new SaasManagementError(
      'Interactive TTY required; run saas:bootstrap-admin from a secure terminal (for example, docker compose exec -it).',
    );
  }
}

function createInteractivePrompt(): SaasBootstrapPromptIO {
  requireInteractiveTerminal();

  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const terminal = readline as typeof readline & { _writeToOutput: (value: string) => void };
  let closed = false;

  const ask = (prompt: string, hidden = false): Promise<string> => {
    if (closed) return Promise.reject(new SaasManagementError('Interactive input was cancelled.'));

    return new Promise<string>((resolve, reject) => {
      const originalWrite = terminal._writeToOutput;
      const cleanup = () => {
        readline.off('line', onLine);
        readline.off('SIGINT', onSigint);
        readline.off('close', onClose);
        terminal._writeToOutput = originalWrite;
      };
      const onLine = (value: string) => {
        cleanup();
        if (hidden) process.stdout.write('\n');
        resolve(value);
      };
      const onClose = () => {
        cleanup();
        if (hidden) process.stdout.write('\n');
        reject(new SaasManagementError('Interactive input was cancelled.'));
      };
      const onSigint = () => {
        readline.close();
      };

      readline.once('line', onLine);
      readline.once('SIGINT', onSigint);
      readline.once('close', onClose);
      if (hidden) terminal._writeToOutput = () => {};
      process.stdout.write(prompt);
    });
  };

  return {
    ask,
    close: () => {
      if (!closed) {
        closed = true;
        readline.close();
      }
    },
  };
}

interface CollectedAdminInput {
  email: string;
  displayName: string;
  password: string;
}

function validateCollectedAdminInput(input: CollectedAdminInput, confirmation: string): void {
  const email = input.email.trim();
  const displayName = input.displayName.trim();
  if (email.length > 254 || !EMAIL_PATTERN.test(email) || displayName.length < 1 || displayName.length > 120) {
    throw new SaasManagementError(
      'Invalid administrator details; email, display name, and password do not meet SaaS requirements.',
    );
  }
  if (
    input.password.length < 12 ||
    Buffer.byteLength(input.password, 'utf8') > 1024 ||
    input.password !== confirmation
  ) {
    throw new SaasManagementError(
      input.password === confirmation
        ? 'Invalid administrator details; email, display name, and password do not meet SaaS requirements.'
        : 'Passwords do not match; bootstrap was not performed.',
    );
  }
}

async function collectAdminInput(prompt: SaasBootstrapPromptIO): Promise<CollectedAdminInput> {
  let email: string;
  let displayName: string;
  let password: string;
  let confirmation: string;
  try {
    email = await prompt.ask('Administrator email: ', false);
    displayName = await prompt.ask('Administrator display name: ', false);
    password = await prompt.ask('Administrator password: ', true);
    confirmation = await prompt.ask('Confirm administrator password: ', true);
  } catch {
    throw new SaasManagementError(PROMPT_ERROR_MESSAGE);
  }
  const input = { email, displayName, password };
  validateCollectedAdminInput(input, confirmation);
  return input;
}

export async function saasBootstrapAdmin(dependencies: SaasBootstrapAdminDependencies = {}): Promise<void> {
  const environment = dependencies.env ?? process.env;
  const connectionString = environment.MODEL_ROUTER_SAAS_DATABASE_URL;
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new SaasManagementError(
      'MODEL_ROUTER_SAAS_DATABASE_URL is required for saas:bootstrap-admin; set it to the SaaS PostgreSQL URL.',
    );
  }

  if (!dependencies.prompt) requireInteractiveTerminal();

  const createDatabase = dependencies.createDatabase ?? createSaasDatabase;
  const createIdentityService =
    dependencies.createIdentityService ?? ((database: SaasDatabase) => new SaasIdentityService(database));
  const prompt = dependencies.prompt;
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));
  let database: SaasDatabase | undefined;
  let activePrompt: SaasBootstrapPromptIO | undefined;
  let failure: SaasManagementError | undefined;
  let cleanupFailure: SaasManagementError | undefined;

  try {
    try {
      database = createDatabase({ connectionString });
      await database.ping();
    } catch {
      throw databaseError();
    }

    let identityService: SaasIdentityServicePort;
    try {
      identityService = createIdentityService(database);
    } catch {
      throw new SaasManagementError('Unable to initialize the SaaS identity service; bootstrap was not performed.');
    }

    let status: Awaited<ReturnType<SaasIdentityServicePort['bootstrapStatus']>>;
    try {
      status = await identityService.bootstrapStatus();
    } catch (error) {
      throw identityError(error, 'status');
    }
    if (status.initialized) {
      throw new SaasManagementError('SaaS platform is already initialized; bootstrap was not performed.');
    }

    activePrompt = prompt ?? createInteractivePrompt();
    const input = await collectAdminInput(activePrompt);

    let issued: Awaited<ReturnType<SaasIdentityServicePort['issueBootstrapToken']>>;
    try {
      issued = await identityService.issueBootstrapToken();
    } catch (error) {
      throw identityError(error, 'issue');
    }

    try {
      await identityService.bootstrapPlatformAdmin({
        token: issued.token,
        email: input.email,
        displayName: input.displayName,
        password: input.password,
      });
    } catch (error) {
      throw identityError(error, 'bootstrap');
    }

    try {
      writeLine('SaaS platform administrator created successfully.');
    } catch {
      throw new SaasManagementError('SaaS platform administrator was created, but the result could not be reported.');
    }
  } catch (error) {
    failure = error instanceof SaasManagementError ? error : new SaasManagementError(GENERIC_BOOTSTRAP_ERROR);
  } finally {
    if (activePrompt?.close) {
      try {
        await activePrompt.close();
      } catch {
        if (!failure && !cleanupFailure) {
          cleanupFailure = new SaasManagementError('Unable to close the secure interactive prompt.');
        }
      }
    }
    if (database) {
      try {
        await database.close();
      } catch {
        if (!failure && !cleanupFailure) {
          cleanupFailure = new SaasManagementError('Unable to close the SaaS PostgreSQL database connection.');
        }
      }
    }
  }

  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
}
