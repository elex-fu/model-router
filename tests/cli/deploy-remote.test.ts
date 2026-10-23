import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mr-deploy-test-'));
  const remote = join(root, 'remote');
  const bin = join(root, 'bin');
  const events = join(root, 'events.jsonl');
  for (const dir of [bin, remote, join(root, 'scripts'), join(root, 'deploy')]) mkdirSync(dir);
  copyFileSync(join(project, 'scripts/deploy-remote.sh'), join(root, 'scripts/deploy-remote.sh'));
  copyFileSync(join(project, 'deploy/remote-server.env.example'), join(root, 'deploy/remote-server.env.example'));
  writeFileSync(join(root, '.gitignore'), '/deploy/remote-server*.env\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture']);

  const mock = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.F_EVENTS, JSON.stringify({tool,args})+'\n');
function run(command, args) {
  const result = spawnSync(command,args,{stdio:'inherit',env:process.env});
  process.exit(result.status ?? 1);
}
if (tool === 'sshpass') {
  const password = fs.readFileSync(3,'utf8');
  if (!password.startsWith('fixture-secret-')) process.exit(9);
  if (process.env.REMOTE_PASSWORD) process.exit(10);
  run(args[2],args.slice(3));
}
if (tool === 'ssh') {
  if (args.includes('-M') || args.includes('-O') || args.includes('-t')) process.exit(0);
  run('/bin/bash',['-c',args.at(-1)]);
}
if (tool === 'rsync') {
  const manifest = fs.readFileSync(args.find(x=>x.startsWith('--files-from=')).slice(13),'utf8');
  fs.writeFileSync(process.env.F_MANIFEST,manifest);
  const source = args.at(-2);
  const destination = args.at(-1).match(/:(\/.*)$/)[1];
  for (const file of manifest.split('\0').filter(Boolean)) {
    fs.mkdirSync(path.dirname(path.join(destination,file)),{recursive:true});
    fs.copyFileSync(path.join(source,file),path.join(destination,file));
  }
  process.exit(0);
}
if (tool === 'docker') {
  if (args[0]==='inspect') console.log(process.env.F_STATE || 'running healthy');
  if (args.includes('--quiet') && !process.env.F_MISSING) console.log(args.at(-1)+'-container');
  if (args[0]==='exec') process.exit(Number(process.env.F_HTTP_EXIT || 0));
  process.exit(0);
}
process.exit(2);
`;
  for (const command of ['ssh', 'sshpass', 'rsync', 'docker']) writeFileSync(join(bin, command), mock, { mode: 0o755 });
  const config = join(root, 'deploy/remote-server.local.env');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, F_EVENTS: events, F_MANIFEST: join(root, 'manifest') };
  return {
    root, remote, config,
    configure(extra = '', kind = 'self-hosted') {
      writeFileSync(config, `SERVER_IP=fixture.invalid\nSERVER_PORT=0022\nSERVER_USERNAME=fixture\nSERVER_DEPLOY_DIR=${remote}\nDEPLOYMENT_KIND=${kind}\n${extra}`);
    },
    run(args: string[], overrides: Record<string, string> = {}) {
      return spawnSync('/bin/bash', [join(root, 'scripts/deploy-remote.sh'), ...args], {
        cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15_000,
      });
    },
    events(): { tool: string; args: string[] }[] {
      return existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test('remote config init is private, does not overwrite, and rejects blank parameters before SSH', () => {
  const f = fixture();
  try {
    assert.equal(f.run(['--init']).status, 0);
    assert.equal(statSync(f.config).mode & 0o777, 0o600);
    const original = readFileSync(f.config, 'utf8');
    assert.notEqual(f.run(['--init']).status, 0);
    assert.equal(readFileSync(f.config, 'utf8'), original);
    assert.notEqual(f.run(['--check']).status, 0);
    assert.deepEqual(f.events(), []);
  } finally { f.cleanup(); }
});

test('password is literal, supplied via a descriptor, and absent from output and command arguments', () => {
  const f = fixture();
  try {
    const marker = join(f.root, 'must-not-exist');
    const secret = `fixture-secret-$(touch ${marker}) ! # spaces`;
    f.configure(`SERVER_PASSWORD=${secret}\n`);
    const result = f.run(['--check'], { REMOTE_PASSWORD: 'inherited-should-be-unexported' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SSH authentication: OK/);
    assert.equal(existsSync(marker), false);
    assert.equal((result.stdout + result.stderr + JSON.stringify(f.events())).includes(secret), false);
    assert.ok(f.events().some(event => event.tool === 'sshpass' && event.args[0] === '-d'));
    assert.equal(statSync(f.config).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test('private key with spaces takes priority over password and does not use sshpass', () => {
  const f = fixture();
  try {
    const key = join(f.root, 'private key');
    writeFileSync(key, 'fixture');
    f.configure(`SERVER_SSH_KEY=${key}\nSERVER_PASSWORD=fixture-secret-unused\n`);
    const result = f.run(['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.events().some(event => event.tool === 'sshpass'), false);
    const master = f.events().find(event => event.tool === 'ssh' && event.args.includes('-M'))!;
    assert.equal(master.args[master.args.indexOf('-i') + 1], key);
    assert.ok(master.args.includes('StrictHostKeyChecking=ask'));
  } finally { f.cleanup(); }
});

test('upload excludes even tracked secrets, preserves remote settings and removes previously deployed stale source', () => {
  const f = fixture();
  try {
    const privateKey = join(f.root, 'arbitrary-private-key-name');
    writeFileSync(privateKey, 'fixture-key');
    f.configure(`SERVER_SSH_KEY=${privateKey}\n`);
    writeFileSync(join(f.root, 'source.js'), 'current');
    writeFileSync(join(f.root, 'deploy/accidental.env'), 'fixture-secret-private');
    writeFileSync(join(f.root, 'deploy/recovery.pem'), 'fixture-key');
    execFileSync('git', ['-C', f.root, 'add', 'source.js', 'deploy/accidental.env', 'deploy/recovery.pem', 'arbitrary-private-key-name']);
    writeFileSync(join(f.remote, 'old.js'), 'stale');
    writeFileSync(join(f.remote, 'settings.env'), 'remote-settings');
    writeFileSync(join(f.remote, '.model-router-deploy-files'), 'old.js\0settings.env\0');
    const result = f.run(['--upload', '--yes']);
    assert.equal(result.status, 0, result.stderr);
    const uploaded = readFileSync(join(f.root, 'manifest'), 'utf8').split('\0');
    assert.ok(uploaded.includes('source.js'));
    assert.ok(uploaded.includes('deploy/remote-server.env.example'));
    for (const file of ['deploy/remote-server.local.env', 'deploy/accidental.env', 'deploy/recovery.pem', 'arbitrary-private-key-name']) {
      assert.equal(uploaded.includes(file), false, file);
      assert.equal(existsSync(join(f.remote, file)), false, file);
    }
    assert.equal(existsSync(join(f.remote, 'old.js')), false);
    assert.equal(readFileSync(join(f.remote, 'settings.env'), 'utf8'), 'remote-settings');
    assert.equal(f.events().some(event => event.tool === 'docker'), false);
  } finally { f.cleanup(); }
});

test('verification is read-only and fails for missing, unhealthy, or HTTP-unready services', () => {
  const f = fixture();
  try {
    f.configure('', 'managed-saas');
    mkdirSync(join(f.remote, 'deploy/compose/modules'), { recursive: true });
    writeFileSync(join(f.remote, 'deploy/compose/.env'), 'fixture');
    assert.equal(f.run(['--verify']).status, 0);
    assert.notEqual(f.run(['--verify'], { F_STATE: 'running unhealthy' }).status, 0);
    assert.notEqual(f.run(['--verify'], { F_MISSING: 'yes' }).status, 0);
    assert.notEqual(f.run(['--verify'], { F_HTTP_EXIT: '1' }).status, 0);
    const events = f.events();
    assert.equal(events.some(event => event.tool === 'rsync'), false);
    assert.equal(events.some(event => event.tool === 'docker' && event.args.some(arg => ['build', 'up', 'down', 'run'].includes(arg))), false);
    assert.ok(events.some(event => event.tool === 'docker' && event.args[0] === 'exec' && event.args.at(-1)!.includes('/readyz')));
  } finally { f.cleanup(); }
});

test('deploy builds and starts, then propagates readiness failure', () => {
  const f = fixture();
  try {
    f.configure();
    const result = f.run(['--deploy', '--yes'], { F_HTTP_EXIT: '1' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /HTTP readiness: PASS|Server action completed/);
    const docker = f.events().filter(event => event.tool === 'docker');
    assert.ok(docker.some(event => event.args.includes('build')));
    assert.ok(docker.some(event => event.args.includes('up') && event.args.includes('--wait')));
    assert.ok(docker.some(event => event.args[0] === 'exec'));
  } finally { f.cleanup(); }
});
