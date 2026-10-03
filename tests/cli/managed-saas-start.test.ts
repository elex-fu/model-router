import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  DEPLOYMENT_ENV_VARS,
  MODEL_ROUTER_DEPLOYMENT_MODE,
  MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE,
  MODEL_ROUTER_SAAS_WORKLOAD_ROLE,
  SAAS_DEPLOYMENT_ENV_NAMES,
} from '../../src/saas/deployment.js';

const execFileAsync = promisify(execFile);

type CliResult = {
  stdout: string;
  stderr: string;
  code: number;
};

async function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: process.cwd(),
      env,
      timeout: 10_000,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      code: typeof failure.code === 'number' ? failure.code : 1,
    };
  }
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  delete environment[MODEL_ROUTER_DEPLOYMENT_MODE];
  for (const name of SAAS_DEPLOYMENT_ENV_NAMES) delete environment[name];
  return environment;
}

function validationWorkerCliEnvironment(): NodeJS.ProcessEnv {
  const environment = cleanEnvironment();
  // Deliberately closed loopback port: never a user PostgreSQL target.
  environment[DEPLOYMENT_ENV_VARS.saas.validationWorkerDatabaseUrl] =
    'postgresql://validation-worker:cli-fixture@127.0.0.1:1/unused?connect_timeout=1';
  environment[DEPLOYMENT_ENV_VARS.saas.validationWorkerProviderCredentialDecryptKmsModule] = 'trusted-cli-worker-kms';
  environment[DEPLOYMENT_ENV_VARS.saas.deploymentId] = 'cli-validation-test';
  environment[DEPLOYMENT_ENV_VARS.saas.environmentId] = 'test';
  return environment;
}

test('start exposes explicit managed SaaS role flags', async () => {
  const result = await runCli(['start', '--help'], cleanEnvironment());
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--role <role>/);
  assert.match(result.stdout, /--workload-role <role>/);
});

test('start --role gateway selects managed SaaS before local JSON/SQLite construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'model-router-gateway-cli-'));
  const configPath = join(directory, 'invalid-config.json');
  writeFileSync(configPath, '{not-json');
  try {
    const result = await runCli(['start', '--role', 'gateway', '--config', configPath], cleanEnvironment());
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.code, 0);
    assert.match(output, /Managed SaaS deployment requires: MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL/);
    assert.doesNotMatch(output, /Unexpected token/);
    assert.equal(existsSync(join(directory, 'logs.sqlite')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('start --role gateway reaches the managed PostgreSQL gate before any listener bind', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'model-router-gateway-cli-pg-'));
  const configPath = join(directory, 'invalid-config.json');
  writeFileSync(configPath, '{not-json');
  const environment = cleanEnvironment();
  environment[DEPLOYMENT_ENV_VARS.saas.gatewayDatabaseUrl] =
    'postgresql://router:secret@127.0.0.1:1/saas?connect_timeout=1';
  environment[DEPLOYMENT_ENV_VARS.saas.gatewayProviderCredentialDecryptKmsModule] = 'trusted-gateway-kms';
  environment[DEPLOYMENT_ENV_VARS.saas.gatewayRuntimeModule] = 'trusted-gateway-runtime';
  environment[DEPLOYMENT_ENV_VARS.saas.deploymentId] = 'cli-gateway-test';
  environment[DEPLOYMENT_ENV_VARS.saas.environmentId] = 'test';
  environment[DEPLOYMENT_ENV_VARS.listeners.gateway.bindAddress] = '127.0.0.1';
  environment[DEPLOYMENT_ENV_VARS.listeners.gateway.port] = '45150';
  environment[DEPLOYMENT_ENV_VARS.listeners.gateway.origin] = 'http://127.0.0.1:45150';
  try {
    const result = await runCli(['start', '--role', 'gateway', '--config', configPath], environment);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.code, 0);
    assert.match(output, /Managed SaaS PostgreSQL ping failed/);
    assert.doesNotMatch(output, /Unexpected token/);
    assert.equal(existsSync(join(directory, 'logs.sqlite')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('start --role fails closed on a conflicting supervisor workload role', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'model-router-gateway-cli-conflict-'));
  const configPath = join(directory, 'invalid-config.json');
  writeFileSync(configPath, '{not-json');
  const environment = cleanEnvironment();
  environment[MODEL_ROUTER_DEPLOYMENT_MODE] = 'managed-saas';
  environment[MODEL_ROUTER_SAAS_WORKLOAD_ROLE] = 'control-plane';
  try {
    const result = await runCli(['start', '--role', 'gateway', '--config', configPath], environment);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.code, 0);
    assert.match(output, /--role conflicts with MODEL_ROUTER_SAAS_WORKLOAD_ROLE/);
    assert.equal(existsSync(join(directory, 'logs.sqlite')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('standard CLI forwards worker metadata setting to deployment parsing before database or local configuration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'model-router-validation-cli-setting-'));
  const configPath = join(directory, 'invalid-config.json');
  writeFileSync(configPath, '{not-json');
  try {
    for (const flag of ['--role', '--workload-role']) {
      const environment = validationWorkerCliEnvironment();
      environment[MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE] = ' private-cli-target-module-secret ';
      const result = await runCli(['start', flag, 'credential-validation-worker', '--config', configPath], environment);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.code, 0);
      assert.match(output, /MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE must be a non-empty/);
      assert.doesNotMatch(output, /private-cli-target-module-secret|PostgreSQL ping|Unexpected token/);
      assert.equal(existsSync(join(directory, 'logs.sqlite')), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('standard CLI rejects metadata module settings for every non-worker workload without disclosing the specifier', async () => {
  for (const role of ['combined', 'control-plane', 'gateway']) {
    const environment = cleanEnvironment();
    environment.NODE_ENV = 'test';
    environment[MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE] =
      'https://private-cli-target.example.test/module.mjs?key=private-cli-target-secret';
    const result = await runCli(['start', '--role', role], environment);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.code, 0);
    assert.match(output, /MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE is permitted only/);
    assert.doesNotMatch(output, /private-cli-target|https:\/\/|PostgreSQL ping|listen EADDR/);
  }
});

test('standard worker CLI with metadata configuration reaches the PostgreSQL gate before module or KMS loading', async () => {
  const environment = validationWorkerCliEnvironment();
  environment[MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE] = 'private-cli-module-that-does-not-exist';
  const result = await runCli(['start', '--role', 'credential-validation-worker'], environment);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.code, 0);
  assert.match(output, /Managed SaaS credential-validation worker PostgreSQL ping failed/);
  assert.doesNotMatch(output, /private-cli-module|cli-fixture|could not be loaded|KMS readiness|Unexpected token/);
});
