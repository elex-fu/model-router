import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { importPricingProfiles, PricingImportShapeError } from '../../src/admin/pricing-import.js';
import { PricingImportCliError, pricingImport, pricingImportCli } from '../../src/cli/pricing-import.js';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { ControlStore } from '../../src/control/store.js';
import { unusedLoopbackPorts } from './loopback-ports.js';

interface StoredProfile {
  id: string;
  body: string;
  parsed: Record<string, unknown>;
}

const modelsDevDoc = [
  { model_id: 'claude-sonnet-4-5', pricing: { input: '3', output: '15', cache_read: '0.3', cache_write: '3.75' } },
  { model_id: 'gpt-5', pricing: { input: 1.25, output: 10 } },
  { model_id: 'gpt-4o-mini', pricing: { input: '0.15', output: '0.6', cache_read: '0.075' } },
  { model_id: 'broken-rate', pricing: { input: '0.25.9', output: '1' } },
  { model_id: 'missing-output', pricing: { input: '0.5' } },
];

const localDoc = [
  {
    id: 'gpt-5-usd',
    model: 'gpt-5',
    currency: 'USD',
    inputPerMillion: '1.25',
    outputPerMillion: '10',
    cacheReadPerMillion: '0.125',
    cacheWrite5mPerMillion: '1.25',
    cacheWrite1hPerMillion: '2.5',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    provider: 'openai',
    upstreamId: 'up-1',
  },
];

const parseRows = (rows: Array<{ id: string; body: string }>): StoredProfile[] =>
  rows.map((row) => ({ id: row.id, body: row.body, parsed: JSON.parse(row.body) as Record<string, unknown> }));

function withStore(dir: string, action: (store: ControlStore) => void): void {
  const store = new ControlStore(dir);
  try {
    action(store);
  } finally {
    store.close();
  }
}

function storedPricing(store: ControlStore): StoredProfile[] {
  return parseRows(store.db.prepare('SELECT id, body FROM pricing').all() as Array<{ id: string; body: string }>);
}

function auditActions(store: ControlStore): string[] {
  return (
    store.db.prepare('SELECT action FROM audit_events ORDER BY created_at, id').all() as Array<{
      action: string;
    }>
  ).map((row) => row.action);
}

test('models.dev shape imports valid rows and reports invalid rows per model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-pricing-import-'));
  try {
    withStore(dir, (store) => {
      const outcome = importPricingProfiles(modelsDevDoc, store);
      assert.equal(outcome.imported, 3);
      assert.equal(outcome.skipped, 0);
      assert.equal(outcome.failed.length, 2);
      assert.deepEqual(outcome.failed.map((failure) => failure.model).sort(), ['broken-rate', 'missing-output']);
      assert.ok(outcome.failed.every((failure) => failure.reason.length > 0));
      const rows = storedPricing(store);
      assert.equal(rows.length, 3);
      const sonnet = rows.find((row) => row.parsed.model === 'claude-sonnet-4-5');
      assert.ok(sonnet);
      assert.equal(sonnet.parsed.currency, 'USD');
      assert.equal(sonnet.parsed.inputPerMillion, '3');
      assert.equal(sonnet.parsed.outputPerMillion, '15');
      assert.equal(sonnet.parsed.cacheReadPerMillion, '0.3');
      assert.equal(sonnet.parsed.cacheWritePerMillion, '3.75');
      assert.ok(String(sonnet.parsed.id).startsWith('imp-claude-sonnet-4-5-'));
      assert.ok(String(sonnet.parsed.id).length <= 128);
      assert.ok(typeof sonnet.parsed.effectiveFrom === 'string');
      const versions = store.db.prepare('SELECT profile_id FROM pricing_versions').all() as Array<{
        profile_id: string;
      }>;
      assert.equal(versions.length, 3);
      const actions = auditActions(store);
      assert.equal(actions.filter((action) => action === 'pricing.update').length, 3);
      assert.equal(actions.filter((action) => action === 'pricing.import').length, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-importing the same models.dev document skips identical rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-pricing-import-'));
  try {
    withStore(dir, (store) => {
      const first = importPricingProfiles(modelsDevDoc, store);
      assert.equal(first.imported, 3);
      const second = importPricingProfiles(modelsDevDoc, store);
      assert.equal(second.imported, 0);
      assert.equal(second.skipped, 3);
      assert.equal(second.failed.length, 2);
      assert.ok(second.skippedRows.every((row) => row.reason.includes('identical')));
      const versions = store.db.prepare('SELECT profile_id FROM pricing_versions').all() as Array<{
        profile_id: string;
      }>;
      assert.equal(versions.length, 3);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local pricing schema shape passes through and upserts by model+currency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-pricing-import-'));
  try {
    withStore(dir, (store) => {
      const first = importPricingProfiles([...localDoc, ...localDoc], store);
      assert.equal(first.imported, 1);
      assert.equal(first.skipped, 1);
      assert.equal(first.failed.length, 0);
      const rows = storedPricing(store);
      assert.equal(rows.length, 1);
      const stored = rows[0];
      assert.equal(stored.id, 'gpt-5-usd');
      assert.equal(stored.parsed.currency, 'USD');
      assert.equal(stored.parsed.inputPerMillion, '1.25');
      assert.equal(stored.parsed.outputPerMillion, '10');
      assert.equal(stored.parsed.cacheReadPerMillion, '0.125');
      assert.equal(stored.parsed.cacheWrite5mPerMillion, '1.25');
      assert.equal(stored.parsed.cacheWrite1hPerMillion, '2.5');
      assert.equal(stored.parsed.effectiveFrom, '2026-01-01T00:00:00.000Z');
      assert.equal(stored.parsed.provider, 'openai');
      assert.equal(stored.parsed.upstreamId, 'up-1');

      const changed = [{ ...localDoc[0], outputPerMillion: '12' }];
      const second = importPricingProfiles(changed, store);
      assert.equal(second.imported, 1);
      assert.equal(second.skipped, 0);
      const versions = store.db.prepare('SELECT profile_id FROM pricing_versions').all() as Array<{
        profile_id: string;
      }>;
      assert.equal(versions.length, 2);
      assert.equal(storedPricing(store)[0].parsed.outputPerMillion, '12');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry run validates and reports without writing anything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-pricing-import-'));
  try {
    withStore(dir, (store) => {
      const result = importPricingProfiles(modelsDevDoc, store, { dryRun: true });
      assert.equal(result.dryRun, true);
      assert.equal(result.imported, 3);
      assert.equal(result.failed.length, 2);
      assert.equal(storedPricing(store).length, 0);
      const versions = store.db.prepare('SELECT profile_id FROM pricing_versions').all() as Array<{
        profile_id: string;
      }>;
      assert.equal(versions.length, 0);
      assert.deepEqual(auditActions(store), []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown document shapes are rejected with an offending sample', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-pricing-import-'));
  try {
    withStore(dir, (store) => {
      assert.throws(
        () => importPricingProfiles({ not: 'an array' }, store),
        (error: unknown) =>
          error instanceof PricingImportShapeError &&
          error.message.includes('non-empty array') &&
          error.sample.includes('not'),
      );
      assert.throws(
        () => importPricingProfiles([{ foo: 'bar' }], store),
        (error: unknown) => error instanceof PricingImportShapeError && error.sample.includes('foo'),
      );
      const mixed = [
        { model_id: 'a-model', pricing: { input: '1', output: '1' } },
        { model: 'b-model', inputPerMillion: '1', outputPerMillion: '1' },
      ];
      assert.throws(
        () => importPricingProfiles(mixed, store),
        (error: unknown) => error instanceof PricingImportShapeError && error.sample.includes('a-model'),
      );
      assert.throws(() => importPricingProfiles(['not-an-object'], store), PricingImportShapeError);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('currency override relabels the currency without converting amounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-pricing-import-'));
  try {
    withStore(dir, (store) => {
      importPricingProfiles(modelsDevDoc.slice(0, 1), store, { currencyOverride: 'CNY' });
      const rows = storedPricing(store);
      assert.equal(rows.length, 1);
      const sonnet = rows[0];
      assert.equal(sonnet.parsed.currency, 'CNY');
      assert.equal(sonnet.parsed.inputPerMillion, '3');
      assert.equal(sonnet.parsed.outputPerMillion, '15');

      importPricingProfiles(localDoc, store, { currencyOverride: 'EUR' });
      const local = storedPricing(store).find((row) => row.parsed.model === 'gpt-5');
      assert.ok(local);
      assert.equal(local.parsed.currency, 'EUR');
      assert.equal(local.parsed.inputPerMillion, '1.25');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default provider and upstream options are applied and local rows missing currency fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-pricing-import-'));
  try {
    withStore(dir, (store) => {
      const result = importPricingProfiles(modelsDevDoc.slice(0, 3), store, {
        defaultProvider: 'openai',
        defaultUpstreamId: 'up-9',
      });
      assert.equal(result.imported, 3);
      const sonnet = storedPricing(store).find((row) => row.parsed.model === 'claude-sonnet-4-5');
      assert.ok(sonnet);
      assert.equal(sonnet.parsed.provider, 'openai');
      assert.equal(sonnet.parsed.upstreamId, 'up-9');

      const missing = [{ model: 'no-currency', inputPerMillion: '1', outputPerMillion: '1' }];
      const failed = importPricingProfiles(missing, store);
      assert.equal(failed.imported, 0);
      assert.equal(failed.failed.length, 1);
      assert.equal(failed.failed[0].model, 'no-currency');
      assert.ok(failed.failed[0].reason.includes('currency'));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface CliFixture {
  dir: string;
  configPath: string;
  ports: { server: number; admin: number };
  close: () => void;
}

async function cliFixture(): Promise<CliFixture> {
  const ports = await unusedLoopbackPorts();
  const dir = mkdtempSync(join(tmpdir(), 'mr-pricing-import-cli-'));
  const configPath = join(dir, 'config.json');
  const config = defaultConfigV2(configPath, 'pricing-import-test');
  config.server.port = ports.server;
  config.admin.port = ports.admin;
  config.storage.dataDir = dir;
  writeFileSync(configPath, JSON.stringify(config));
  return { dir, configPath, ports, close: () => rmSync(dir, { recursive: true, force: true }) };
}

function controlRows(fixture: CliFixture): StoredProfile[] {
  const dbPath = join(fixture.dir, 'control.sqlite');
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pricing'").get();
    if (table === undefined) return [];
    return parseRows(db.prepare('SELECT id, body FROM pricing').all() as Array<{ id: string; body: string }>);
  } finally {
    db.close();
  }
}

const listen = (server: Server, port: number) =>
  new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
const shutDown = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

test('CLI imports a local JSON file into the offline control store', async () => {
  const fixture = await cliFixture();
  try {
    const docPath = join(fixture.dir, 'prices.json');
    writeFileSync(docPath, JSON.stringify(modelsDevDoc));
    const result = await pricingImport(docPath, { config: fixture.configPath, provider: 'openai' });
    assert.equal(result.imported, 3);
    assert.equal(result.failed.length, 2);
    const rows = controlRows(fixture);
    assert.equal(rows.length, 3);
    const sonnet = rows.find((row) => row.parsed.model === 'claude-sonnet-4-5');
    assert.ok(sonnet);
    assert.equal(sonnet.parsed.provider, 'openai');
    assert.equal(sonnet.parsed.currency, 'USD');
  } finally {
    fixture.close();
  }
});

test('CLI fetches an https URL through the injected fetch and stores the result', async () => {
  const fixture = await cliFixture();
  try {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify(modelsDevDoc), { status: 200 });
    };
    const result = await pricingImport('https://models.example.test/api.json', {
      config: fixture.configPath,
      fetchImpl,
      upstream: 'up-42',
    });
    assert.deepEqual(calls, ['https://models.example.test/api.json']);
    assert.equal(result.imported, 3);
    const rows = controlRows(fixture);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.parsed.upstreamId === 'up-42'));
  } finally {
    fixture.close();
  }
});

test('CLI rejects http URLs before any fetch and reports fetch failures', async () => {
  const fixture = await cliFixture();
  try {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response('[]', { status: 200 });
    };
    await assert.rejects(
      pricingImport('http://models.example.test/api.json', {
        config: fixture.configPath,
        fetchImpl,
      }),
      (error: unknown) => error instanceof PricingImportCliError && error.message.includes('https'),
    );
    assert.equal(calls.length, 0);
    const failing: typeof fetch = async () => new Response('server error', { status: 500 });
    await assert.rejects(
      pricingImport('https://models.example.test/api.json', {
        config: fixture.configPath,
        fetchImpl: failing,
      }),
      (error: unknown) => error instanceof PricingImportCliError && error.message.includes('HTTP 500'),
    );
  } finally {
    fixture.close();
  }
});

test('CLI rejects downloads larger than the 10MB cap', async () => {
  const fixture = await cliFixture();
  try {
    const oversized = JSON.stringify([
      { model_id: 'big', pricing: { input: '1', output: '1', pad: 'x'.repeat(10 * 1024 * 1024 + 64) } },
    ]);
    const fetchImpl: typeof fetch = async () => new Response(oversized, { status: 200 });
    await assert.rejects(
      pricingImport('https://models.example.test/api.json', {
        config: fixture.configPath,
        fetchImpl,
      }),
      (error: unknown) => error instanceof PricingImportCliError && error.message.includes('10MB'),
    );
    assert.equal(controlRows(fixture).length, 0);
  } finally {
    fixture.close();
  }
});

test('CLI dry run validates the document and writes nothing', async () => {
  const fixture = await cliFixture();
  try {
    const docPath = join(fixture.dir, 'prices.json');
    writeFileSync(docPath, JSON.stringify(modelsDevDoc));
    const result = await pricingImport(docPath, { config: fixture.configPath, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.imported, 3);
    assert.equal(result.failed.length, 2);
    assert.equal(controlRows(fixture).length, 0);
  } finally {
    fixture.close();
  }
});

test('CLI offline write is refused while a server is responding on the configured port', async () => {
  const fixture = await cliFixture();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  try {
    await listen(server, fixture.ports.server);
    const docPath = join(fixture.dir, 'prices.json');
    writeFileSync(docPath, JSON.stringify(modelsDevDoc));
    await assert.rejects(
      pricingImport(docPath, { config: fixture.configPath }),
      (error: unknown) => error instanceof PricingImportCliError && error.message.includes('server is responding'),
    );
    assert.equal(controlRows(fixture).length, 0);
  } finally {
    await shutDown(server);
    fixture.close();
  }
});

test('CLI validates the currency option and propagates shape errors', async () => {
  const fixture = await cliFixture();
  try {
    const docPath = join(fixture.dir, 'prices.json');
    writeFileSync(docPath, JSON.stringify(modelsDevDoc));
    await assert.rejects(
      pricingImport(docPath, { config: fixture.configPath, currency: 'usd' }),
      (error: unknown) => error instanceof PricingImportCliError && error.message.includes('ISO 4217'),
    );
    writeFileSync(docPath, JSON.stringify({ unknown: 'shape' }));
    await assert.rejects(pricingImport(docPath, { config: fixture.configPath }), PricingImportShapeError);
    writeFileSync(docPath, '{ not json');
    await assert.rejects(
      pricingImport(docPath, { config: fixture.configPath }),
      (error: unknown) => error instanceof PricingImportCliError && error.message.includes('not valid JSON'),
    );
  } finally {
    fixture.close();
  }
});

test('CLI command entry prints the import report', async () => {
  const fixture = await cliFixture();
  try {
    const docPath = join(fixture.dir, 'prices.json');
    writeFileSync(docPath, JSON.stringify(modelsDevDoc));
    const lines: string[] = [];
    await pricingImportCli(docPath, {
      config: fixture.configPath,
      currency: 'EUR',
      writeLine: (line) => lines.push(line),
    });
    assert.ok(lines.some((line) => line === 'Pricing import: 3 imported, 0 skipped, 2 failed.'));
    assert.ok(lines.some((line) => line.includes('failed broken-rate')));
    assert.ok(lines.every((line) => !line.includes('Dry run')));
    assert.ok(controlRows(fixture).every((row) => row.parsed.currency === 'EUR'));
  } finally {
    fixture.close();
  }
});
