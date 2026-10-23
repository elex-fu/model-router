import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('npm deployment package includes examples and excludes operator connection and recovery files', {
  timeout: 30_000,
}, async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const directory = await mkdtemp(join(tmpdir(), 'model-router-package-policy-'));
  try {
    const deploy = join(directory, 'deploy');
    await mkdir(join(deploy, 'compose'), { recursive: true });
    await mkdir(join(deploy, 'systemd'), { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'model-router-package-policy-fixture',
        version: '1.0.0',
        files: ['deploy'],
      }),
    );
    await writeFile(join(deploy, '.npmignore'), await readFile(join(root, 'deploy/.npmignore')));
    const localFiles = [
      'remote-server.env',
      'remote-server.local.env',
      'remote-server.staging.env',
      'remote-client.local.env',
      'remote-server-ip-ca.local.pem',
      'compose/.env',
      'compose/.env.local',
      'systemd/worker.env',
      'recovery.key',
      'recovery.pem',
      'secrets.local.md',
    ];
    const examples = ['compose/.env.example', 'systemd/backup.env.example', 'remote-server.env.example'];
    for (const file of [...localFiles, ...examples]) {
      await writeFile(join(deploy, file), 'LOCAL_PACKAGE_POLICY_FIXTURE=yes\n');
    }
    const output = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result: unknown = JSON.parse(output);
    assert.ok(Array.isArray(result) && result.length === 1);
    const files = result[0].files as Array<{ path: string }>;
    assert.ok(Array.isArray(files));
    const packed = new Set(files.map((file) => file.path));
    for (const file of localFiles) assert.equal(packed.has(`deploy/${file}`), false, file);
    for (const file of examples) assert.equal(packed.has(`deploy/${file}`), true, file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
