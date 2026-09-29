import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { type SaasBootstrapAdminDependencies, saasBootstrapAdmin } from '../../src/cli/saas-management.js';
import type { SaasDatabase, SaasDatabaseOptions, SqlExecutor, SqlResult } from '../../src/saas/db/types.js';
import type { BootstrapAdminInput, SafeIdentity } from '../../src/saas/identity/index.js';
import { SaasIdentityError } from '../../src/saas/identity/index.js';

const exec = promisify(execFile);

const password = 'correct horse battery staple';
const token = 'internal-one-time-bootstrap-token';

function fakeDatabase(events: string[], pingError?: Error): SaasDatabase {
  const executor: SqlExecutor = {
    async query<Row>(): Promise<SqlResult<Row>> {
      return { rows: [], rowCount: 0 };
    },
  };

  return {
    query: executor.query,
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return work(executor);
    },
    async migrate(): Promise<void> {
      events.push('migrate');
    },
    async ping(): Promise<void> {
      events.push('ping');
      if (pingError) throw pingError;
    },
    async close(): Promise<void> {
      events.push('close');
    },
  };
}

function safeIdentity(): SafeIdentity {
  return {
    id: 'admin-id',
    email: 'owner@example.com',
    displayName: 'Initial Owner',
    status: 'active',
    emailVerifiedAt: null,
    createdAt: '2026-09-28T12:15:00.000Z',
  };
}

function fakePrompt(events: string[], values: string[]) {
  let index = 0;
  return {
    async ask(prompt: string, hidden = false): Promise<string> {
      events.push(`prompt:${prompt}:${hidden}`);
      return values[index++] ?? '';
    },
    close(): void {
      events.push('prompt-close');
    },
  };
}

function dependencies(
  events: string[],
  database: SaasDatabase,
  identityService: {
    bootstrapStatus: () => Promise<{ initialized: boolean; bootstrapRequired: boolean }>;
    issueBootstrapToken: () => Promise<{ token: string; expiresAt: string }>;
    bootstrapPlatformAdmin: (input: BootstrapAdminInput) => Promise<SafeIdentity>;
  },
  prompt: SaasBootstrapAdminDependencies['prompt'],
  output: string[],
): SaasBootstrapAdminDependencies {
  return {
    env: { MODEL_ROUTER_SAAS_DATABASE_URL: 'postgresql://cli-user:cli-secret@localhost/saas' },
    createDatabase: (options: SaasDatabaseOptions) => {
      events.push(`create:${options.connectionString}`);
      return database;
    },
    createIdentityService: () => identityService,
    prompt,
    writeLine: (line: string) => output.push(line),
  };
}

test('saas:bootstrap-admin requires the SaaS PostgreSQL URL before opening a prompt or database', async () => {
  let created = false;
  let prompted = false;
  await assert.rejects(
    saasBootstrapAdmin({
      env: {},
      prompt: {
        async ask(): Promise<string> {
          prompted = true;
          return '';
        },
      },
      createDatabase: () => {
        created = true;
        throw new Error('must not create a database');
      },
    }),
    /MODEL_ROUTER_SAAS_DATABASE_URL is required for saas:bootstrap-admin/,
  );
  assert.equal(created, false);
  assert.equal(prompted, false);
});

test('saas:bootstrap-admin collects all fields before issuing and immediately consumes an internal token', async () => {
  const events: string[] = [];
  const output: string[] = [];
  const database = fakeDatabase(events);
  let issueCalls = 0;
  let bootstrapInput: BootstrapAdminInput | undefined;
  const prompt = fakePrompt(events, ['owner@example.com', 'Initial Owner', password, password]);

  await saasBootstrapAdmin(
    dependencies(
      events,
      database,
      {
        async bootstrapStatus() {
          events.push('status');
          return { initialized: false, bootstrapRequired: true };
        },
        async issueBootstrapToken() {
          events.push('issue');
          issueCalls += 1;
          return { token, expiresAt: '2026-09-28T12:15:00.000Z' };
        },
        async bootstrapPlatformAdmin(input) {
          events.push('bootstrap');
          bootstrapInput = input;
          return safeIdentity();
        },
      },
      prompt,
      output,
    ),
  );

  assert.deepEqual(events, [
    'create:postgresql://cli-user:cli-secret@localhost/saas',
    'ping',
    'status',
    'prompt:Administrator email: :false',
    'prompt:Administrator display name: :false',
    'prompt:Administrator password: :true',
    'prompt:Confirm administrator password: :true',
    'issue',
    'bootstrap',
    'prompt-close',
    'close',
  ]);
  assert.equal(issueCalls, 1);
  assert.deepEqual(bootstrapInput, {
    token,
    email: 'owner@example.com',
    displayName: 'Initial Owner',
    password,
  });
  assert.deepEqual(output, ['SaaS platform administrator created successfully.']);
  assert.doesNotMatch(output.join('\n'), new RegExp(token));
  assert.doesNotMatch(output.join('\n'), new RegExp(password));
  assert.equal(events.includes('migrate'), false);
});

test('saas:bootstrap-admin refuses initialized platforms before prompting or issuing', async () => {
  const events: string[] = [];
  const output: string[] = [];
  let issueCalls = 0;
  let promptCalls = 0;
  const prompt = {
    async ask(): Promise<string> {
      promptCalls += 1;
      return '';
    },
    close(): void {
      events.push('prompt-close');
    },
  };

  await assert.rejects(
    saasBootstrapAdmin(
      dependencies(
        events,
        fakeDatabase(events),
        {
          async bootstrapStatus() {
            events.push('status');
            return { initialized: true, bootstrapRequired: false };
          },
          async issueBootstrapToken() {
            issueCalls += 1;
            throw new Error('must not issue');
          },
          async bootstrapPlatformAdmin() {
            throw new Error('must not bootstrap');
          },
        },
        prompt,
        output,
      ),
    ),
    /already initialized/,
  );
  assert.equal(issueCalls, 0);
  assert.equal(promptCalls, 0);
  assert.deepEqual(events, ['create:postgresql://cli-user:cli-secret@localhost/saas', 'ping', 'status', 'close']);
  assert.deepEqual(output, []);
});

test('saas:bootstrap-admin validates prompt input before issuing a token', async () => {
  const events: string[] = [];
  const output: string[] = [];
  let issueCalls = 0;
  await assert.rejects(
    saasBootstrapAdmin(
      dependencies(
        events,
        fakeDatabase(events),
        {
          async bootstrapStatus() {
            events.push('status');
            return { initialized: false, bootstrapRequired: true };
          },
          async issueBootstrapToken() {
            issueCalls += 1;
            throw new Error('must not issue');
          },
          async bootstrapPlatformAdmin() {
            throw new Error('must not bootstrap');
          },
        },
        fakePrompt(events, ['owner@example.com', 'Initial Owner', 'short', 'short']),
        output,
      ),
    ),
    /Invalid administrator details/,
  );
  assert.equal(issueCalls, 0);
  assert.deepEqual(events.slice(-2), ['prompt-close', 'close']);
  assert.deepEqual(output, []);
});

test('saas:bootstrap-admin reports missing tables safely and closes on identity errors', async () => {
  const events: string[] = [];
  const output: string[] = [];
  await assert.rejects(
    saasBootstrapAdmin(
      dependencies(
        events,
        fakeDatabase(events),
        {
          async bootstrapStatus() {
            throw new SaasIdentityError(500, 'IDENTITY_STORAGE_ERROR');
          },
          async issueBootstrapToken() {
            throw new Error('must not issue');
          },
          async bootstrapPlatformAdmin() {
            throw new Error('must not bootstrap');
          },
        },
        fakePrompt(events, []),
        output,
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Apply SaaS migrations separately/);
      assert.doesNotMatch(error.message, /cli-secret|saas_platform_state/);
      return true;
    },
  );
  assert.deepEqual(events.slice(-1), ['close']);
  assert.deepEqual(output, []);
});

test('saas:bootstrap-admin closes the database when ping fails without leaking database errors', async () => {
  const events: string[] = [];
  const output: string[] = [];
  await assert.rejects(
    saasBootstrapAdmin(
      dependencies(
        events,
        fakeDatabase(events, new Error('password=super-secret connection detail')),
        {
          async bootstrapStatus() {
            throw new Error('must not check status');
          },
          async issueBootstrapToken() {
            throw new Error('must not issue');
          },
          async bootstrapPlatformAdmin() {
            throw new Error('must not bootstrap');
          },
        },
        fakePrompt(events, []),
        output,
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /PostgreSQL database/);
      assert.doesNotMatch(error.message, /super-secret|password=/);
      return true;
    },
  );
  assert.deepEqual(events, ['create:postgresql://cli-user:cli-secret@localhost/saas', 'ping', 'close']);
});

test('saas:bootstrap-admin sanitizes bootstrap failures and never reports credentials', async () => {
  const events: string[] = [];
  const output: string[] = [];
  await assert.rejects(
    saasBootstrapAdmin(
      dependencies(
        events,
        fakeDatabase(events),
        {
          async bootstrapStatus() {
            events.push('status');
            return { initialized: false, bootstrapRequired: true };
          },
          async issueBootstrapToken() {
            events.push('issue');
            return { token, expiresAt: '2026-09-28T12:15:00.000Z' };
          },
          async bootstrapPlatformAdmin() {
            events.push('bootstrap');
            throw new Error(`password=${password} token=${token}`);
          },
        },
        fakePrompt(events, ['owner@example.com', 'Initial Owner', password, password]),
        output,
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Unable to complete SaaS platform-admin bootstrap/);
      assert.doesNotMatch(error.message, new RegExp(`${password}|${token}`));
      return true;
    },
  );
  assert.deepEqual(output, []);
  assert.deepEqual(events.slice(-2), ['prompt-close', 'close']);
});

test('saas:bootstrap-admin is registered, requires a TTY by default, and replaces the token-only command', async () => {
  const env = { ...process.env, MODEL_ROUTER_SAAS_DATABASE_URL: 'postgresql://user:secret@localhost/saas' };
  const help = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--help'], {
    cwd: process.cwd(),
    env,
  });
  assert.match(help.stdout, /saas:bootstrap-admin/);
  assert.doesNotMatch(help.stdout, /saas:bootstrap-token/);
  assert.match(help.stdout, /admin:bootstrap/);

  await assert.rejects(
    exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:bootstrap-admin'], {
      cwd: process.cwd(),
      env,
    }),
    (error: unknown) => {
      const result = error as { stderr?: string; code?: number };
      assert.equal(result.code, 1);
      assert.match(result.stderr ?? '', /Interactive TTY required/);
      assert.doesNotMatch(result.stderr ?? '', /secret/);
      return true;
    },
  );
});
