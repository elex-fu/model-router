import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── .env loader (no external dependency) ──────────────────────────────
function loadEnv(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf-8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

const env = loadEnv();

function assertEnv(keys: string[]): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `Missing .env keys: ${missing.join(', ')}. Please add them to .env and re-run.`
    );
  }
}

// ── test harness ──────────────────────────────────────────────────────
function tmpConfigPath(): string {
  return path.join(os.tmpdir(), `mr-cli-test-${randomUUID()}.json`);
}

async function run(args: string[], configPath: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      'npx',
      ['tsx', 'src/cli/index.ts', ...args, '--config', configPath],
      { cwd: process.cwd(), timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error?.code && typeof error.code === 'number' ? error.code : 0;
        resolve({ stdout, stderr, code });
      }
    );
  });
}

// ── suite ─────────────────────────────────────────────────────────────

test('upstream:add, upstream:list, upstream:delete', async () => {
  assertEnv(['UPSTREAM_NAME', 'UPSTREAM_PROVIDER', 'UPSTREAM_PROTOCOL', 'UPSTREAM_BASE_URL', 'UPSTREAM_API_KEY']);

  const configPath = tmpConfigPath();
  try {
    // add
    const addRes = await run(
      [
        'upstream:add',
        env.UPSTREAM_NAME,
        env.UPSTREAM_PROVIDER,
        env.UPSTREAM_PROTOCOL,
        env.UPSTREAM_BASE_URL,
        env.UPSTREAM_API_KEY,
        '--models',
        env.UPSTREAM_REAL_MODEL ?? 'default-model',
      ],
      configPath
    );
    assert.equal(addRes.code, 0, `upstream:add failed: ${addRes.stderr}`);
    assert.ok(addRes.stdout.includes('Created upstream'));

    // list
    const listRes = await run(['upstream:list'], configPath);
    assert.equal(listRes.code, 0);
    assert.ok(listRes.stdout.includes(env.UPSTREAM_NAME));

    // delete
    const delRes = await run(['upstream:delete', env.UPSTREAM_NAME], configPath);
    assert.equal(delRes.code, 0);
    assert.ok(delRes.stdout.includes('Deleted upstream'));

    // list again should be empty
    const list2 = await run(['upstream:list'], configPath);
    assert.ok(list2.stdout.includes('No upstreams found') || list2.code !== 0);
  } finally {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  }
});

test('key:create, key:list, key:disable, key:enable, key:rotate, key:delete', async () => {
  const configPath = tmpConfigPath();
  try {
    // create
    const createRes = await run(['key:create', 'alice', '--upstreams', 'kimi-code', '--rpm', '30'], configPath);
    assert.equal(createRes.code, 0, `key:create failed: ${createRes.stderr}`);
    assert.ok(createRes.stdout.includes('Created proxy key'));

    // list (masked)
    const listRes = await run(['key:list'], configPath);
    assert.equal(listRes.code, 0);
    assert.ok(listRes.stdout.includes('alice'));

    // disable
    const disableRes = await run(['key:disable', 'alice'], configPath);
    assert.equal(disableRes.code, 0);
    assert.ok(disableRes.stdout.includes('Disabled'));

    // enable
    const enableRes = await run(['key:enable', 'alice'], configPath);
    assert.equal(enableRes.code, 0);
    assert.ok(enableRes.stdout.includes('Enabled'));

    // rotate
    const rotateRes = await run(['key:rotate', 'alice'], configPath);
    assert.equal(rotateRes.code, 0);
    assert.ok(rotateRes.stdout.includes('Rotated'));

    // delete
    const delRes = await run(['key:delete', 'alice'], configPath);
    assert.equal(delRes.code, 0);
    assert.ok(delRes.stdout.includes('Deleted'));

    // list empty
    const list2 = await run(['key:list'], configPath);
    assert.ok(list2.stdout.includes('No proxy keys found'));
  } finally {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  }
});

test('upstream:map:set, upstream:map:list, upstream:map:delete', async () => {
  assertEnv(['UPSTREAM_NAME', 'UPSTREAM_PROVIDER', 'UPSTREAM_PROTOCOL', 'UPSTREAM_BASE_URL', 'UPSTREAM_API_KEY']);

  const configPath = tmpConfigPath();
  try {
    await run(
      [
        'upstream:add',
        env.UPSTREAM_NAME,
        env.UPSTREAM_PROVIDER,
        env.UPSTREAM_PROTOCOL,
        env.UPSTREAM_BASE_URL,
        env.UPSTREAM_API_KEY,
      ],
      configPath
    );

    const setRes = await run(
      ['upstream:map:set', env.UPSTREAM_NAME, 'claude-*', 'kimi-k2.6'],
      configPath
    );
    assert.equal(setRes.code, 0);
    assert.ok(setRes.stdout.includes('Set'));

    const listRes = await run(['upstream:map:list', env.UPSTREAM_NAME], configPath);
    assert.equal(listRes.code, 0);
    assert.ok(listRes.stdout.includes('claude-*'));

    const delRes = await run(
      ['upstream:map:delete', env.UPSTREAM_NAME, 'claude-*'],
      configPath
    );
    assert.equal(delRes.code, 0);
    assert.ok(delRes.stdout.includes('Deleted'));

    const list2 = await run(['upstream:map:list', env.UPSTREAM_NAME], configPath);
    assert.ok(list2.stdout.includes('No modelMap entries'));
  } finally {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  }
});

test('test <upstream> — real connectivity probe', async () => {
  assertEnv([
    'UPSTREAM_NAME',
    'UPSTREAM_PROVIDER',
    'UPSTREAM_PROTOCOL',
    'UPSTREAM_BASE_URL',
    'UPSTREAM_API_KEY',
    'UPSTREAM_REAL_MODEL',
  ]);

  const configPath = tmpConfigPath();
  try {
    await run(
      [
        'upstream:add',
        env.UPSTREAM_NAME,
        env.UPSTREAM_PROVIDER,
        env.UPSTREAM_PROTOCOL,
        env.UPSTREAM_BASE_URL,
        env.UPSTREAM_API_KEY,
        '--models',
        env.UPSTREAM_REAL_MODEL,
      ],
      configPath
    );

    const probeRes = await run(['test', env.UPSTREAM_NAME], configPath);
    // We expect this to succeed with real credentials; if the network is
    // unreachable or key invalid we surface the output so the user knows.
    assert.equal(
      probeRes.code,
      0,
      `Upstream probe failed. stdout: ${probeRes.stdout}\nstderr: ${probeRes.stderr}`
    );
    assert.ok(probeRes.stdout.includes('OK'));
  } finally {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  }
});

test('logs and stats commands run without crashing', async () => {
  const configPath = tmpConfigPath();
  try {
    const logsRes = await run(['logs', '--tail', '5'], configPath);
    assert.equal(logsRes.code, 0);

    const statsRes = await run(['stats'], configPath);
    assert.equal(statsRes.code, 0);
  } finally {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  }
});
