import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { AdminRollups } from '../../src/admin/rollups.js';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

const exec = promisify(execFile);
async function cli(...args: string[]) {
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: process.cwd(),
      timeout: 15_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mr-rebuild-cli-'));
  const configPath = join(dir, 'config.json');
  const dbPath = join(dir, 'logs.sqlite');
  const config = defaultConfigV2(configPath, 'rebuild-cli-test');
  config.storage.dataDir = dir;
  config.server.bindAddress = '127.0.0.1';
  config.server.port = await freePort();
  config.admin.enabled = false;
  writeFileSync(configPath, JSON.stringify(config));
  const store = new SQLiteTelemetryStore(dbPath);
  await store.init();
  await store.close();
  return {
    dir,
    configPath,
    dbPath,
    port: config.server.port,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const command = (configPath: string, revision = '1') =>
  cli('telemetry:rebuild-live', '--config', configPath, '--expected-revision', revision);

test('offline CLI migrates pre-live database with nonzero request and attempt rows', async () => {
  const f = await fixture();
  try {
    const db = new Database(f.dbPath);
    db.prepare(`INSERT INTO requests(id,source,client_protocol,state,started_at_ms)
      VALUES('r1','production','openai','completed',?)`).run(Date.now() - 10_000);
    db.prepare(`INSERT INTO attempts(id,request_id,ordinal,upstream_id,protocol,outcome,started_at_ms)
      VALUES('a1','r1',1,'u','openai','completed',?)`).run(Date.now() - 9_000);
    db.exec('DROP TABLE live_request_minute; DROP TABLE live_attempt_minute; DROP TABLE live_aggregate_state');
    db.close();
    const result = await command(f.configPath);
    assert.equal(result.code, 0, result.stderr);
    const value = JSON.parse(result.stdout) as {
      rows: number;
      requests: number;
      attempts: number;
      sequence: number;
      durationMs: number;
    };
    assert.equal(value.rows, 1);
    assert.equal(value.requests, 1);
    assert.equal(value.attempts, 1);
    assert.ok(value.sequence >= 2);
    assert.ok(value.durationMs >= 0);
    const check = new Database(f.dbPath, { readonly: true });
    try {
      const covered = check.prepare('SELECT covered_sequence AS n FROM live_aggregate_state').get() as { n: number };
      assert.equal(covered.n, value.sequence);
    } finally {
      check.close();
    }
  } finally {
    f.close();
  }
});

test('empty database returns zero counts; stale revision and V1 are refused', async () => {
  const f = await fixture();
  try {
    const empty = await command(f.configPath);
    assert.equal(empty.code, 0, empty.stderr);
    assert.deepEqual(((v) => [v.requests, v.attempts])(JSON.parse(empty.stdout)), [0, 0]);
    const stale = await command(f.configPath, '2');
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /revision conflict/);
    const config = JSON.parse(readFileSync(f.configPath, 'utf8')) as Record<string, unknown>;
    config.schemaVersion = 1;
    writeFileSync(f.configPath, JSON.stringify(config));
    const old = await command(f.configPath);
    assert.equal(old.code, 1);
    assert.match(old.stderr, /requires an existing V2/);
  } finally {
    f.close();
  }
});

test('configured listener or another process with DB open refuses rebuild', async () => {
  const f = await fixture();
  const listener = createServer();
  try {
    await new Promise<void>((resolve) => listener.listen(f.port, '127.0.0.1', resolve));
    const online = await command(f.configPath);
    assert.equal(online.code, 1);
    assert.match(online.stderr, /listener.*occupied|stop the instance/);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const child = spawn(
      process.execPath,
      [
        '-e',
        'const D=require("better-sqlite3");const db=new D(process.argv[1],{readonly:true});console.log("ready");setInterval(()=>void db,1000)',
        f.dbPath,
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout?.once('data', (data) => {
          if (String(data).includes('ready')) resolve();
        });
        child.once('exit', () => reject(new Error('holder exited')));
      });
      const held = await command(f.configPath);
      assert.equal(held.code, 1);
      assert.match(held.stderr, /open in another process/);
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  } finally {
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
    f.close();
  }
});

test('archived frozen day is not rewritten by offline live rebuild', async () => {
  const f = await fixture();
  try {
    const db = new Database(f.dbPath);
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const old = day - 2 * 86_400_000;
    db.prepare(`INSERT INTO requests(id,source,client_protocol,state,started_at_ms)
      VALUES('old','production','openai','completed',?)`).run(old + 1000);
    new AdminRollups(db).archiveAndPurge(day - 86_400_000);
    const before = db
      .prepare('SELECT * FROM admin_usage_daily_v2 WHERE day_start_ms=? AND source=?')
      .get(old, 'production');
    db.close();
    const result = await command(f.configPath);
    assert.equal(result.code, 0, result.stderr);
    const value = JSON.parse(result.stdout) as { requests: number; attempts: number };
    assert.equal(value.requests, 0);
    assert.equal(value.attempts, 0);
    const check = new Database(f.dbPath, { readonly: true });
    try {
      assert.deepEqual(
        check.prepare('SELECT * FROM admin_usage_daily_v2 WHERE day_start_ms=? AND source=?').get(old, 'production'),
        before,
      );
    } finally {
      check.close();
    }
  } finally {
    f.close();
  }
});
