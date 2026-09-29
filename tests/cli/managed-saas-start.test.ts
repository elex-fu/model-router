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
