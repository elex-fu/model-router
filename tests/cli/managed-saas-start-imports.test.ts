import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { MODEL_ROUTER_DEPLOYMENT_MODE, SAAS_DEPLOYMENT_ENV_NAMES } from '../../src/saas/deployment.js';

const exec = promisify(execFile);
const importTrap = 'CLI_UNSELECTED_MODULE_IMPORTED';
const commandModules = [
  'saas-backup',
  'saas-deploy',
  'saas-doctor',
  'saas-management',
  'saas-migrate-legacy-112',
  'saas-migration-audit',
  'saas-migrations',
  'saas-platform-mfa-enrollment',
  'saas-upgrade',
  'v2',
  'v2-management',
] as const;

function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env[MODEL_ROUTER_DEPLOYMENT_MODE];
  for (const key of SAAS_DEPLOYMENT_ENV_NAMES) delete env[key];
  return env;
}

/** Reject forbidden loads in both the project's CommonJS tsx graph and ESM imports. */
function importGuard(pattern: string): string {
  const esmLoader = `
    const forbidden = new RegExp(${JSON.stringify(pattern)});
    export async function load(url, context, nextLoad) {
      if (forbidden.test(url)) throw new Error(${JSON.stringify(importTrap)});
      return nextLoad(url, context);
    }
  `;
  const preload = `
    import Module, { register } from 'node:module';
    const forbidden = new RegExp(${JSON.stringify(pattern)});
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function(specifier) {
      if (forbidden.test(specifier)) throw new Error(${JSON.stringify(importTrap)});
      return originalRequire.call(this, specifier);
    };
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(esmLoader)}`)});
  `;
  return `data:text/javascript,${encodeURIComponent(preload)}`;
}

function forbiddenPattern(allowBackup = false): string {
  const commands = commandModules.filter((name) => !allowBackup || name !== 'saas-backup');
  return `(?:^|/)(?:${commands.join('|')}|server/(?:index|managed-saas)|control/store)\\.(?:[cm]?js|ts)$`;
}

async function run(args: string[], pattern: string) {
  const nodeArgs = ['--import', 'tsx', '--import', importGuard(pattern), ...args];
  try {
    const result = await exec(process.execPath, nodeArgs, { env: environment(), timeout: 10_000 });
    return { ...result, code: 0 };
  } catch (error) {
    const failure = error as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
    assert.notEqual(failure.killed, true, 'CLI child exceeded the unchanged 10-second deadline');
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

test('CLI help and invalid managed deployment do not load command or server compositions', async () => {
  const pattern = forbiddenPattern();
  // Prove the module hook is active before relying on the absence of a load.
  const trap = await run(['--eval', 'require("./src/cli/saas-backup.ts")'], pattern);
  assert.equal(trap.code, 1);
  assert.match(trap.stderr, new RegExp(importTrap));

  const help = await run(['src/cli/index.ts', '--help'], pattern);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /saas:backup-status/);
  assert.match(help.stdout, /saas:backup-verify-restore/);
  assert.match(help.stdout, /saas:backup\s/);

  const invalid = await run(['src/cli/index.ts', 'start', '--role', 'gateway'], pattern);
  assert.equal(invalid.code, 1);
  assert.match(
    `${invalid.stdout}\n${invalid.stderr}`,
    /Managed SaaS deployment requires: MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL/,
  );
  assert.doesNotMatch(`${invalid.stdout}\n${invalid.stderr}`, new RegExp(importTrap));
});

test('a selected backup action loads its implementation without other command compositions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-router-cli-imports-'));
  try {
    const result = await run(
      ['src/cli/index.ts', 'saas:backup-status', '--policy', join(dir, 'missing-policy.json')],
      forbiddenPattern(true),
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_BACKUP_POLICY');
    assert.doesNotMatch(result.stderr, new RegExp(importTrap));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
