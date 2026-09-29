import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { type ConfigV2, defaultConfigV2 } from '../../src/config/v2-schema.js';
import { unusedLoopbackPorts } from './loopback-ports.js';

const exec = promisify(execFile);
async function cli(configPath: string, ...args: string[]) {
  try {
    const result = await exec(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', ...args, '--config', configPath],
      { cwd: process.cwd() },
    );
    return { code: 0, ...result };
  } catch (error: any) {
    return { code: error.code as number, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}
async function fixture() {
  const ports = await unusedLoopbackPorts();
  const dir = mkdtempSync(join(tmpdir(), 'mr-v2-cli-'));
  const configPath = join(dir, 'config.json');
  const config = defaultConfigV2(configPath, 'router-cli-test');
  config.server.port = ports.server;
  config.server.publicProxyBaseUrl = `http://127.0.0.1:${ports.server}`;
  config.admin.port = ports.admin;
  config.admin.publicAdminBaseUrl = `http://127.0.0.1:${ports.admin}`;
  config.storage.dataDir = dir;
  writeFileSync(configPath, JSON.stringify(config));
  return {
    dir,
    configPath,
    read: () => JSON.parse(readFileSync(configPath, 'utf8')) as ConfigV2,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('V2 key lifecycle hashes plaintext and refuses secret recovery', async () => {
  const f = await fixture();
  try {
    const created = await cli(f.configPath, 'key:create', 'alice', '--rpm', '30');
    assert.equal(created.code, 0, created.stderr);
    const token = /Key: (\S+)/.exec(created.stdout)?.[1];
    assert.ok(token);
    assert.equal(readFileSync(f.configPath, 'utf8').includes(token), false);
    assert.equal(f.read().proxyKeys[0].name, 'alice');
    const listed = await cli(f.configPath, 'key:list');
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.stdout.includes(token), false);
    const forbidden = await cli(f.configPath, 'key:list', '--show-secrets');
    assert.equal(forbidden.code, 1);
    assert.match(forbidden.stderr, /cannot be recovered/);
    assert.equal((await cli(f.configPath, 'key:disable', 'alice')).code, 0);
    assert.equal(f.read().proxyKeys[0].enabled, false);
    assert.equal((await cli(f.configPath, 'key:enable', 'alice')).code, 0);
    const updated = await cli(
      f.configPath,
      'key:update',
      'alice',
      '--description',
      'owner',
      '--rpm',
      '15',
      '--models',
      'coder-*',
    );
    assert.equal(updated.code, 0, updated.stderr);
    assert.equal(f.read().proxyKeys[0].description, 'owner');
    assert.equal(f.read().proxyKeys[0].rpm, 15);
    assert.deepEqual(f.read().proxyKeys[0].allowedModels, ['coder-*']);
    const rotated = await cli(f.configPath, 'key:rotate', 'alice');
    assert.equal(rotated.code, 0, rotated.stderr);
    assert.equal(
      readFileSync(f.configPath, 'utf8').includes(/New key: (\S+)/.exec(rotated.stdout)?.[1] ?? 'none'),
      false,
    );
    assert.equal((await cli(f.configPath, 'key:delete', 'alice')).code, 0);
    assert.equal(f.read().proxyKeys.length, 0);
  } finally {
    f.close();
  }
});

test('V2 no-auth upstream and map commands edit routes by revision', async () => {
  const f = await fixture();
  try {
    const refused = await cli(
      f.configPath,
      'upstream:add',
      'ollama',
      'custom-openai',
      'openai',
      'http://127.0.0.1:11434/v1',
      '-',
      '--auth-mode',
      'none',
      '--models',
      'qwen2.5-coder:7b',
    );
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /HTTP upstream URLs require/);
    const publicHttp = await cli(
      f.configPath,
      'upstream:add',
      'public',
      'custom-openai',
      'openai',
      'http://example.invalid/v1',
      '-',
      '--auth-mode',
      'none',
      '--allow-insecure-http',
    );
    assert.equal(publicHttp.code, 1);
    assert.match(publicHttp.stderr, /HTTP is allowed only for localhost/);
    const add = await cli(
      f.configPath,
      'upstream:add',
      'ollama',
      'custom-openai',
      'openai',
      'http://127.0.0.1:11434/v1',
      '-',
      '--auth-mode',
      'none',
      '--models',
      'qwen2.5-coder:7b',
      '--allow-insecure-http',
    );
    assert.equal(add.code, 0, add.stderr);
    assert.equal(f.read().upstreams[0].auth.mode, 'none');
    assert.equal(f.read().upstreams[0].policy.allowInsecureHttp, true);
    const help = await cli(f.configPath, 'upstream:add', '--help');
    assert.match(help.stdout, /plaintext HTTP[\s\S]*credentials and prompts may be exposed/);
    assert.deepEqual(f.read().upstreams[0].credentials, []);
    const mapped = await cli(f.configPath, 'upstream:map:set', 'ollama', 'coder-*', 'qwen2.5-coder:7b');
    assert.equal(mapped.code, 0, mapped.stderr);
    assert.equal(f.read().routes[0].targets[0].upstreamId, f.read().upstreams[0].id);
    assert.equal((await cli(f.configPath, 'upstream:map:list', 'ollama')).stdout.includes('coder-*'), true);
    const referenced = await cli(f.configPath, 'upstream:delete', 'ollama');
    assert.equal(referenced.code, 1);
    assert.match(referenced.stderr, /referenced/);
    assert.equal((await cli(f.configPath, 'upstream:map:delete', 'ollama', 'coder-*')).code, 0);
    assert.equal((await cli(f.configPath, 'upstream:delete', 'ollama')).code, 0);
    assert.equal(f.read().upstreams.length, 0);
    assert.ok(f.read().revision >= 5);
  } finally {
    f.close();
  }
});

test('V2 credential is encrypted in ControlStore, not config', async () => {
  const f = await fixture();
  try {
    const secret = 'sk-cli-secret-should-not-appear';
    const add = await cli(
      f.configPath,
      'upstream:add',
      'remote',
      'deepseek-chat',
      'openai',
      'https://example.invalid',
      secret,
      '--models',
      'deepseek-chat',
    );
    assert.equal(add.code, 0, add.stderr);
    assert.equal(readFileSync(f.configPath, 'utf8').includes(secret), false);
    assert.equal(f.read().upstreams[0].credentials[0].secret.type, 'secret');
    const denied = await cli(f.configPath, 'upstream:list', '--show-secrets');
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /cannot be displayed/);
  } finally {
    f.close();
  }
});

test('V2 writes refuse an active server and a concurrent CLI lock', async () => {
  const f = await fixture();
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.end('ok');
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const config = f.read();
    config.server.port = address.port;
    writeFileSync(f.configPath, JSON.stringify(config));
    const blocked = await cli(f.configPath, 'key:create', 'blocked');
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /server is running/);
    assert.equal(f.read().proxyKeys.length, 0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    writeFileSync(`${f.configPath}.cli.lock`, 'other writer');
    const concurrent = await cli(f.configPath, 'key:create', 'blocked');
    assert.equal(concurrent.code, 1);
    assert.match(concurrent.stderr, /Another V2 CLI write/);
    assert.equal(f.read().proxyKeys.length, 0);
  } finally {
    server.close();
    f.close();
  }
});

test('V2 chat requires a raw proxy key', async () => {
  const f = await fixture();
  try {
    const without = await cli(f.configPath, 'chat', 'model');
    assert.equal(without.code, 1);
    assert.match(without.stderr, /cannot be recovered/);
    const create = await cli(f.configPath, 'key:create', 'alice');
    assert.equal(create.code, 0);
    const byName = await cli(f.configPath, 'chat', 'model', '--key', 'alice');
    assert.equal(byName.code, 1);
    assert.match(byName.stderr, /names cannot be resolved/);
  } finally {
    f.close();
  }
});
