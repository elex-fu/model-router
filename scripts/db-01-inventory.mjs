#!/usr/bin/env node
// DB-01 inventory runner: execute the read-only saas:migration-audit gate once
// per reviewed environment manifest entry and archive per-database evidence.
//
// Red lines (sub2api-commercialization-integration-plan §11 DB-01, §3.2):
// - read-only: the audit command itself opens a REPEATABLE READ READ ONLY
//   transaction; this script adds no write path of its own;
// - never generates, promotes, or self-approves catalog baselines;
// - never prints or persists connection strings: DSNs arrive only through the
//   per-entry named environment variable and are scrubbed from archived output.
//
// Usage:
//   node scripts/db-01-inventory.mjs --manifest <manifest.json> --outdir <dir>
//
// Manifest (reviewed JSON, contains no secrets):
// {
//   "format": "db-01-inventory-manifest-v1",
//   "releaseId": "release-label",
//   "schema": "model_router_saas",
//   "catalogBaseline": "reviewed/baseline.json",        // optional shared default
//   "environments": [{
//     "deploymentId": "label", "environmentId": "label", "database": "db_name",
//     "auditUrlEnv": "DB01_AUDIT_URL_EXAMPLE",           // env var NAME, not a DSN
//     "catalogBaseline": "optional/override.json",       // optional per entry
//     "allowLocalPlaintext": false,                       // optional, default false
//     "legacyChecksums": ["22=<64hex>:<evidenceId>"]      // optional, reviewed
//   }]
// }
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
const LEGACY_MAPPING = /^(22|23)=([0-9a-f]{64}):([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/;
const AUDIT_URL_ENV = 'MODEL_ROUTER_SAAS_AUDIT_DATABASE_URL';
const MAX_ENVIRONMENTS = 64;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function fail(message) {
  console.error(`db-01-inventory: ${message}`);
  process.exit(2);
}
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}
const manifestPath = option('manifest');
const outdir = option('outdir');
if (!manifestPath || !outdir || args.length !== 4) {
  fail('usage: node scripts/db-01-inventory.mjs --manifest <manifest.json> --outdir <dir>');
}
const root = resolve(import.meta.dirname, '..');

let manifest;
try {
  const text = readFileSync(resolve(manifestPath), 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('too large');
  manifest = JSON.parse(text);
} catch {
  fail('manifest is not readable bounded JSON');
}
function isLabel(value) { return typeof value === 'string' && LABEL.test(value); }
function isPath(value) {
  return typeof value === 'string' && value.trim() !== '' && !value.includes('\0') && !value.includes('..');
}
if (!manifest || manifest.format !== 'db-01-inventory-manifest-v1'
  || !isLabel(manifest.releaseId) || !isLabel(manifest.schema)
  || (manifest.catalogBaseline !== undefined && !isPath(manifest.catalogBaseline))
  || !Array.isArray(manifest.environments)
  || manifest.environments.length === 0
  || manifest.environments.length > MAX_ENVIRONMENTS) {
  fail('manifest fails the db-01-inventory-manifest-v1 contract');
}
const seenEnvironments = new Set();
for (const entry of manifest.environments) {
  const valid = entry && typeof entry === 'object'
    && isLabel(entry.deploymentId) && isLabel(entry.environmentId) && isLabel(entry.database)
    && typeof entry.auditUrlEnv === 'string' && ENV_NAME.test(entry.auditUrlEnv)
    && (entry.catalogBaseline === undefined || isPath(entry.catalogBaseline))
    && (entry.allowLocalPlaintext === undefined || typeof entry.allowLocalPlaintext === 'boolean')
    && (entry.legacyChecksums === undefined || (Array.isArray(entry.legacyChecksums)
      && entry.legacyChecksums.length <= 8
      && entry.legacyChecksums.every((mapping) => typeof mapping === 'string' && LEGACY_MAPPING.test(mapping))
      && new Set(entry.legacyChecksums).size === entry.legacyChecksums.length));
  if (!valid) fail(`manifest entry ${JSON.stringify(entry?.environmentId)} fails the environment contract`);
  if (seenEnvironments.has(entry.environmentId)) fail(`duplicate environmentId ${entry.environmentId}`);
  seenEnvironments.add(entry.environmentId);
}

const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (commit.error || commit.status !== 0) fail('git rev-parse HEAD failed');
const commitSha = commit.stdout.trim();
const outdirAbsolute = resolve(outdir);
mkdirSync(outdirAbsolute, { recursive: true });

const rows = [];
let blocked = 0;
let errored = 0;
for (const entry of manifest.environments) {
  const started = new Date();
  const dsn = process.env[entry.auditUrlEnv];
  const cliArgs = [
    '--import', 'tsx', 'src/cli/index.ts', 'saas:migration-audit',
    '--deployment-id', entry.deploymentId,
    '--environment-id', entry.environmentId,
    '--database', entry.database,
    '--schema', manifest.schema,
    '--release-id', manifest.releaseId,
  ];
  const baseline = entry.catalogBaseline ?? manifest.catalogBaseline;
  if (baseline !== undefined) cliArgs.push('--catalog-baseline', resolve(baseline));
  for (const mapping of entry.legacyChecksums ?? []) cliArgs.push('--legacy-checksum', mapping);
  if (entry.allowLocalPlaintext === true) cliArgs.push('--allow-local-plaintext');

  let parsed = null;
  let note = '';
  if (typeof dsn !== 'string' || dsn.trim() === '') {
    errored += 1;
    note = `env ${entry.auditUrlEnv} unset; entry skipped`;
  } else {
    const run = spawnSync(process.execPath, cliArgs, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        [AUDIT_URL_ENV]: dsn,
      },
    });
    const stdout = typeof run.stdout === 'string' ? run.stdout : '';
    // Defense in depth: never archive output that echoes the connection string.
    if (stdout.includes(dsn)) {
      errored += 1;
      note = 'child output contained the connection string; report withheld';
    } else {
      try {
        const lines = stdout.trim().split('\n').filter((line) => line.trim() !== '');
        const candidate = JSON.parse(lines.at(-1));
        if (candidate?.format !== 'saas-migration-audit-command-v1') throw new Error('unexpected format');
        parsed = candidate;
      } catch {
        errored += 1;
        note = `audit child produced no safe report (exit ${run.status ?? 'signal'})`;
      }
    }
    if (parsed) {
      writeFileSync(
        resolve(outdirAbsolute, `${entry.environmentId}.report.json`),
        `${JSON.stringify(parsed, null, 2)}\n`,
        'utf8',
      );
      if (parsed.exitCode !== 0) blocked += 1;
    }
  }
  const report = parsed?.report ?? null;
  const issueCodes = report ? [...new Set(report.issues.map((issue) => issue.code))].join(',') : '';
  const matched = report ? report.migrations.filter((migration) => migration.state === 'match').length : 0;
  const total = report ? report.migrations.length : 0;
  const catalog = report?.catalog?.actualChecksum ? report.catalog.actualChecksum.slice(0, 12) : 'n/a';
  const pgMajor = report?.actualTarget?.postgresMajor ?? 'n/a';
  const conclusion = parsed && parsed.exitCode === 0 ? 'GO' : 'NO-GO';
  rows.push([
    started.toISOString().slice(0, 10), commitSha.slice(0, 12),
    entry.deploymentId, entry.environmentId, `pg${pgMajor}`,
    `${matched}/${total}`, catalog, parsed ? parsed.status : 'error',
    issueCodes || note || '-', conclusion,
  ]);
}

const summary = [
  '# DB-01 存量盘点运行记录',
  '',
  `commit: ${commitSha}`,
  `releaseId: ${manifest.releaseId}  schema: ${manifest.schema}`,
  '',
  '| date | commit | deployment | environment | pg | ledger match | catalog sha | status | issues | GO |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((row) => `| ${row.join(' | ')} |`),
  '',
].join('\n');
writeFileSync(resolve(outdirAbsolute, 'db-01-inventory-summary.md'), summary, 'utf8');
process.stdout.write(summary);
if (errored > 0) process.exit(2);
process.exit(blocked > 0 ? 1 : 0);
