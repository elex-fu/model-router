import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAdminServer } from '../../src/admin/server.js';
import { type ConfigV2, defaultConfigV2 } from '../../src/config/v2-schema.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';
import { unusedLoopbackPorts } from './loopback-ports.js';

const exec = promisify(execFile);
async function cli(configPath: string, ...args: string[]) {
  try {
    const output = await exec(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', ...args, '--config', configPath],
      { cwd: process.cwd() },
    );
    return { code: 0, ...output };
  } catch (error) {
    const failure = error as Error & { code: number; stdout?: string; stderr?: string };
    return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function cliWithStdin(configPath: string, lines: string[], ...args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args, '--config', configPath], {
      cwd: process.cwd(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${lines.join('\n')}\n`);
  });
}

async function ptyRun(command: string, args: string[], answers: Array<[string, string]>) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const driver = `import json,os,pty,select,signal,sys,time
argv=json.loads(sys.argv[1]); answers=json.loads(sys.argv[2]); pid,fd=pty.fork()
if pid==0: os.execvp(argv[0],argv)
out=bytearray(); index=0; deadline=time.monotonic()+10
while time.monotonic()<deadline:
  readable,_,_=select.select([fd],[],[],0.1)
  if readable:
    try: chunk=os.read(fd,4096)
    except OSError: break
    if not chunk: break
    out.extend(chunk)
    while index<len(answers) and answers[index][0].encode() in out:
      answer=answers[index][1]
      os.write(fd,answer.encode() if answer=='\\x03' else (answer+'\\n').encode()); index+=1
  done,status=os.waitpid(pid,os.WNOHANG)
  if done: break
else: os.kill(pid,signal.SIGKILL)
sys.stdout.buffer.write(out)
sys.stderr.write('PTY_ANSWERS='+str(index)+'\\n')`;
    const child = spawn('python3', ['-c', driver, JSON.stringify([command, ...args]), JSON.stringify(answers)], {
      cwd: process.cwd(),
    });
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (!stderr.includes(`PTY_ANSWERS=${answers.length}`))
        reject(new Error(`PTY driver failed: ${stderr} ${output}`));
      else resolve({ code, output });
    });
  });
}

async function fixture() {
  const ports = await unusedLoopbackPorts();
  const dir = mkdtempSync(join(tmpdir(), 'mr-cli-management-'));
  const configPath = join(dir, 'config.json');
  const config = defaultConfigV2(configPath, 'cli-management-test');
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

// Used ONLY by the two Docker helper PTY tests. Own data/config and real admin
// handler, never the hard-coded helper port or an existing user's admin store.
async function dockerBootstrapFixture() {
  const f = await fixture();
  const app = createAdminServer({
    configPath: f.configPath,
    bootstrapToken: 'OWNED_DOCKER_FIXTURE_TOKEN_NOT_SUBMITTED',
    bootstrapExpiresAt: Date.now() + 60_000,
  });
  let requests = 0;
  let wrongRequests = 0;
  const statuses: number[] = [];
  let ownedHost = '';
  app.server.on('request', (req, res) => {
    requests++;
    if (req.method !== 'POST' || req.url !== '/admin/api/v1/bootstrap' || req.headers.host !== ownedHost)
      wrongRequests++;
    res.once('finish', () => statuses.push(res.statusCode));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); resolve(); });
    });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    assert.notEqual(address.port, 15006);
    ownedHost = `127.0.0.1:${address.port}`;
    const endpoint = `http://${ownedHost}/admin/api/v1/bootstrap`;
    const preload = fileURLToPath(new URL('./docker-bootstrap-owned-fetch.preload.mjs', import.meta.url));
    return {
      app,
      args: (mode: 'submit' | 'cancel') => ['--import', preload, 'deploy/docker/bootstrap.mjs',
        `--owned-bootstrap-url=${endpoint}`, `--owned-bootstrap-mode=${mode}`],
      observations: () => ({ requests, wrongRequests, statuses: [...statuses] }),
      close: async () => { try { await app.close(); } finally { f.close(); } },
    };
  } catch (error) {
    try { await app.close(); } finally { f.close(); }
    throw error;
  }
}

test('config:validate is read-only and config:apply uses CAS and checks secret references', async () => {
  const f = await fixture();
  try {
    const original = readFileSync(f.configPath, 'utf8');
    const validate = await cli(f.configPath, 'config:validate');
    assert.equal(validate.code, 0, validate.stderr);
    assert.equal(JSON.parse(validate.stdout).valid, true);
    assert.equal(readFileSync(f.configPath, 'utf8'), original);
    const source = join(f.dir, 'next.json');
    const next = f.read();
    next.server.maxAttempts = 4;
    writeFileSync(source, JSON.stringify(next));
    const stale = await cli(f.configPath, 'config:apply', source, '--expected-revision', '99');
    assert.equal(stale.code, 1);
    assert.equal(readFileSync(f.configPath, 'utf8'), original);
    const applied = await cli(f.configPath, 'config:apply', source, '--expected-revision', '1');
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(f.read().revision, 2);
    assert.equal(f.read().server.maxAttempts, 4);
    const implicitConflict = await cli(f.configPath, 'config:apply', source);
    assert.equal(implicitConflict.code, 1);
    assert.equal(f.read().revision, 2);
    const conflicting = await cli(f.configPath, 'config:apply', source, '--expected-revision', '1');
    assert.equal(conflicting.code, 1);
    assert.equal(f.read().revision, 2);

    const invalid = f.read();
    invalid.upstreams.push({
      id: 'up',
      name: 'Secret upstream',
      provider: 'custom',
      protocol: 'openai',
      enabled: true,
      baseUrl: 'https://example.invalid/v1',
      endpoints: { generate: 'chat/completions' },
      auth: { mode: 'bearer' },
      credentials: [{ id: 'cred', label: 'Key', enabled: true, secret: { type: 'secret', id: 'sec_missing' } }],
      models: [],
      priority: 0,
      sortIndex: 0,
      policy: {},
    });
    writeFileSync(source, JSON.stringify(invalid));
    const denied = await cli(f.configPath, 'config:apply', source);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /secret_unavailable/);
    assert.equal(f.read().revision, 2);
  } finally {
    f.close();
  }
});

test('config:migrate dry-run agrees with real V2 shape and writes nothing; migration encrypts secrets', async () => {
  const f = await fixture();
  try {
    const legacySecret = 'sk-legacy-never-print-me';
    const isolatedServerPort = f.read().server.port;
    const legacy = {
      server: { port: isolatedServerPort, bindAddress: '127.0.0.1' },
      upstreams: [
        {
          name: 'remote',
          provider: 'custom',
          protocol: 'openai',
          baseUrl: 'https://example.invalid/v1',
          apiKeys: [legacySecret],
          models: ['model-a'],
          modelMap: { alias: 'model-a' },
          enabled: true,
        },
      ],
      proxyKeys: [{ name: 'client', key: 'proxy-legacy-never-print-me', enabled: true, createdAt: '2026-09-25T00:00:00.000Z', allowedUpstreams: ['remote'] }],
      request_logs: [{ key: 'legacy-log-marker', request: { secret: legacySecret } }],
    };
    writeFileSync(f.configPath, JSON.stringify(legacy));
    const before = readFileSync(f.configPath, 'utf8');
    const dry = await cli(f.configPath, 'config:migrate', '--dry-run');
    assert.equal(dry.code, 0, `${dry.stderr}\n${dry.stdout}`);
    const preview = JSON.parse(dry.stdout);
    assert.equal(preview.valid, true);
    assert.equal(preview.summary.credentials, 1);
    assert.equal(preview.summary.upstreams[0].models.includes('model-a'), true);
    assert.equal(preview.summary.upstreams[0].urlMigration.sourceBase, 'https://example.invalid/v1');
    assert.equal(preview.summary.upstreams[0].urlMigration.v2Prefix, 'https://example.invalid/v1');
    assert.equal(preview.summary.upstreams[0].urlMigration.relativeEndpoint, 'v1/chat/completions');
    assert.equal(preview.summary.upstreams[0].urlMigration.finalUrl, 'https://example.invalid/v1/v1/chat/completions');
    assert.equal(preview.summary.routes[0].targets[0].model, 'model-a');
    assert.equal(preview.summary.proxyKeys[0].name, 'client');
    assert.match(preview.summary.legacyLogHandling, /not imported/);
    assert.equal(preview.previewKind, 'v2_candidate');
    assert.equal(readFileSync(f.configPath, 'utf8'), before);
    assert.deepEqual(readdirSync(f.dir), ['config.json']);
    assert.doesNotMatch(dry.stdout + dry.stderr, /sk-legacy-never-print-me|proxy-legacy-never-print-me|legacy-log-marker/);
    const migrated = await cli(f.configPath, 'config:migrate');
    assert.equal(migrated.code, 0, migrated.stderr);
    assert.equal(f.read().schemaVersion, 2);
    assert.deepEqual(
      f.read().upstreams.map(({ id, name, provider, protocol, enabled, baseUrl, endpoints, models }) => ({
        id,
        name,
        provider,
        protocol,
        enabled,
        baseUrl,
        generateUrl: endpoints.generate,
        models: models.map((model) => model.id),
      })),
      preview.summary.upstreams.map(({ id, name, provider, protocol, enabled, urlMigration, models }) => ({
        id,
        name,
        provider,
        protocol,
        enabled,
        baseUrl: urlMigration.v2Prefix,
        generateUrl: urlMigration.relativeEndpoint,
        models,
      })),
    );
    assert.deepEqual(
      f.read().routes.map(({ match, clientProtocols, publishedModels, targets }) => ({ match, clientProtocols, publishedModels, targets })),
      preview.summary.routes.map(({ match, clientProtocols, publishedModels, targets }) => ({ match, clientProtocols, publishedModels, targets })),
    );
    assert.equal(f.read().upstreams[0].credentials[0].secret.type, 'secret');
    assert.equal(readFileSync(f.configPath, 'utf8').includes(legacySecret), false);
    assert.equal(migrated.stdout.includes(legacySecret), false);
    assert.equal(
      readdirSync(f.dir).some((name) => name.endsWith('.bak')),
      false,
    );
    assert.equal(existsSync(join(f.dir, 'master.key')), true);
  } finally {
    f.close();
  }
});

test('config:migrate dry-run reports conversion blockers without writing or leaking secrets', async () => {
  const f = await fixture();
  try {
    const secret = 'private-upstream-value';
    const legacy = {
      upstreams: [{ name: 'broken', protocol: 'openai', baseUrl: 'https://user:url-password@example.invalid/v1?token=query-secret', apiKey: secret, models: ['m'] }],
      proxyKeys: [],
    };
    writeFileSync(f.configPath, JSON.stringify(legacy));
    const before = readFileSync(f.configPath, 'utf8');
    const dry = await cli(f.configPath, 'config:migrate', '--dry-run');
    assert.equal(dry.code, 1, `${dry.stderr}\n${dry.stdout}`);
    const preview = JSON.parse(dry.stdout);
    assert.equal(preview.valid, false);
    assert.ok(preview.blockers.some((item: string) => item.includes('url')));
    assert.equal(readFileSync(f.configPath, 'utf8'), before);
    assert.deepEqual(readdirSync(f.dir), ['config.json']);
    assert.doesNotMatch(dry.stdout + dry.stderr, /private-upstream-value|url-password|query-secret/);
  } finally {
    f.close();
  }
});

test('admin:bootstrap uses local API, keeps credentials out of output, and reports failures', async () => {
  const f = await fixture();
  const oneTimeToken = 'one-time-token-test-only';
  const password = 'strong-password-12345';
  const app = createAdminServer({
    configPath: f.configPath,
    bootstrapToken: oneTimeToken,
    bootstrapExpiresAt: Date.now() + 60_000,
  });
  try {
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const config = f.read();
    config.admin.port = address.port;
    writeFileSync(f.configPath, JSON.stringify(config));
    const noninteractive = await cli(f.configPath, 'admin:bootstrap');
    assert.equal(noninteractive.code, 1);
    assert.match(noninteractive.stderr, /Interactive terminal required/);
    const pty = await ptyRun(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', 'admin:bootstrap', '--config', f.configPath],
      [
        ['One-time bootstrap token: ', 'DUMMY_TOKEN'],
        ['Administrator name: ', 'owner'],
        ['Administrator password: ', 'DUMMY_PASSWORD_123'],
        ['Confirm password: ', 'DUMMY_PASSWORD_123'],
      ],
    );
    assert.match(pty.output, /Invalid or expired one-time bootstrap token/);
    assert.doesNotMatch(pty.output, /DUMMY_TOKEN|DUMMY_PASSWORD_123/);
    const cancelled = await ptyRun(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', 'admin:bootstrap', '--config', f.configPath],
      [['One-time bootstrap token: ', '\x03']],
    );
    assert.match(cancelled.output, /Input cancelled/);
    assert.equal(app.store.hasAdmin(), false);
    const invalid = await cliWithStdin(
      f.configPath,
      ['wrong-token', 'owner', password],
      'admin:bootstrap',
      '--test-stdin',
    );
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /Invalid or expired one-time bootstrap token/);
    const success = await cliWithStdin(
      f.configPath,
      [oneTimeToken, 'owner', password],
      'admin:bootstrap',
      '--test-stdin',
    );
    assert.equal(success.code, 0, success.stderr);
    assert.match(success.stdout, /Administrator created/);
    assert.equal(app.store.hasAdmin(), true);
    const repeated = await cliWithStdin(
      f.configPath,
      [oneTimeToken, 'again', password],
      'admin:bootstrap',
      '--test-stdin',
    );
    assert.equal(repeated.code, 1);
    assert.match(repeated.stderr, /already initialized/);
    for (const result of [noninteractive, invalid, success, repeated]) {
      assert.equal((result.stdout + result.stderr).includes(oneTimeToken), false);
      assert.equal((result.stdout + result.stderr).includes(password), false);
    }
  } finally {
    await app.close();
    f.close();
  }
});

test('Docker bootstrap helper does not echo token or password in a PTY', async () => {
  const owned = await dockerBootstrapFixture();
  try {
  const pty = await ptyRun(
    process.execPath,
    owned.args('submit'),
    [
      ['One-time bootstrap token: ', 'DUMMY_TOKEN'],
      ['Administrator name: ', 'owner'],
      ['Administrator password: ', 'DUMMY_PASSWORD_123'],
    ],
  );
  assert.match(pty.output, /One-time bootstrap token:/);
  assert.doesNotMatch(pty.output, /DUMMY_TOKEN|DUMMY_PASSWORD_123/);
  assert.match(pty.output, /DOCKER_FIXTURE_READY=SUBMIT/);
  assert.match(pty.output, /DOCKER_FIXTURE_FETCH=OWNED_POST/);
  assert.match(pty.output, /DOCKER_FIXTURE_STATUS=403/);
  assert.match(pty.output, /Invalid bootstrap token/);
  assert.deepEqual(owned.observations(), { requests: 1, wrongRequests: 0, statuses: [403] });
  assert.equal(owned.app.store.hasAdmin(), false);
  } finally { await owned.close(); }
});

test('Docker bootstrap Ctrl+C cancels hidden input and restores terminal handling', async () => {
  const owned = await dockerBootstrapFixture();
  try {
  const pty = await ptyRun(process.execPath, owned.args('cancel'), [['One-time bootstrap token: ', '\x03']]);
  assert.match(pty.output, /Input cancelled/);
  assert.doesNotMatch(pty.output, /DUMMY_TOKEN/);
  assert.match(pty.output, /DOCKER_FIXTURE_READY=CANCEL/);
  assert.doesNotMatch(pty.output, /DOCKER_FIXTURE_FETCH=|DOCKER_FIXTURE_STATUS=/);
  assert.deepEqual(owned.observations(), { requests: 0, wrongRequests: 0, statuses: [] });
  assert.equal(owned.app.store.hasAdmin(), false);
  } finally { await owned.close(); }
});

test('offline writes refuse responding server; upstream:update and upstream:test use V2', async () => {
  const f = await fixture();
  const server = createServer(async (request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(403);
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const current = f.read();
    current.server.port = address.port;
    current.upstreams.push({
      id: 'up',
      name: 'Local',
      provider: 'custom',
      protocol: 'openai',
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      endpoints: { generate: 'chat/completions' },
      auth: { mode: 'none' },
      credentials: [],
      models: [{ id: 'model-a', enabled: true, capabilities: {}, capabilitiesSource: 'manual' }],
      priority: 0,
      sortIndex: 0,
      policy: { allowInsecureHttp: true },
    });
    writeFileSync(f.configPath, JSON.stringify(current));
    const blocked = await cli(f.configPath, 'upstream:update', 'Local', '--disable');
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /server is responding/);
    assert.equal(f.read().upstreams[0].enabled, true);
    const probe = await cli(f.configPath, 'upstream:test', 'Local');
    assert.equal(probe.code, 0, probe.stderr);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const updated = await cli(f.configPath, 'upstream:update', 'Local', '--disable', '--model', 'model-b');
    assert.equal(updated.code, 0, updated.stderr);
    assert.equal(f.read().upstreams[0].enabled, false);
    assert.equal(f.read().upstreams[0].models[1].id, 'model-b');
  } finally {
    server.close();
    f.close();
  }
});

test('backup:create reuses admin SQLite backup and requires telemetry', async () => {
  const f = await fixture();
  try {
    const missing = await cli(f.configPath, 'backup:create');
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /Telemetry database is missing/);
    const telemetry = new SQLiteTelemetryStore(join(f.dir, 'logs.sqlite'));
    await telemetry.init();
    await telemetry.close();
    const created = await cli(f.configPath, 'backup:create');
    assert.equal(created.code, 0, created.stderr);
    const result = JSON.parse(created.stdout) as { backupId: string; path: string; revision: number };
    assert.match(result.backupId, /^bak_/);
    assert.equal(result.revision, 1);
    assert.equal(existsSync(join(result.path, 'control.sqlite')), true);
    assert.equal(existsSync(join(result.path, 'telemetry.sqlite')), true);
    assert.equal(existsSync(join(result.path, 'master.key')), true);
    assert.equal(JSON.parse(readFileSync(join(result.path, 'manifest.json'), 'utf8')).revision, 1);
  } finally {
    f.close();
  }
});
