#!/usr/bin/env node
// Capture one release-gate run as an evidence record with native node:test
// counts. The script never reads or prints credential-bearing environment; it
// only parses the child reporter's ℹ count lines. Evidence is markdown on
// stdout (or appended with --out) for docs/evidence/* templates.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseGateCounts, promotableGateRun, sourceIdentity } from './ci/gate-evidence.mjs';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}
const gate = option('gate');
const testRoot = option('test');
const out = option('out');
const pg = option('pg');
if (
  !gate || !/^[a-z0-9][a-z0-9-]*$/.test(gate) ||
  !testRoot || !testRoot.startsWith(`tests${sep}`) || !testRoot.endsWith('.ts') || testRoot.includes('..') ||
  (pg !== undefined && !['15', '18'].includes(pg))
) {
  console.error('Usage: node scripts/capture-gate-evidence.mjs --gate <gate-id> --test tests/<root>.ts [--pg 15|18] [--out file]');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const absoluteTest = resolve(root, testRoot);
if (!absoluteTest.startsWith(`${root}${sep}tests${sep}`) || !existsSync(absoluteTest)) {
  console.error(`test root must be an existing file under tests/: ${testRoot}`);
  process.exit(2);
}

const before = sourceIdentity(root);

const started = new Date();
const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=spec', testRoot], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const stdout = typeof run.stdout === 'string' ? run.stdout : '';
const stderr = typeof run.stderr === 'string' ? run.stderr : '';

const counts = parseGateCounts(stdout);
if (counts.tests === null || counts.pass === null || counts.fail === null) {
  console.error('native reporter counts not found; refusing to fabricate evidence');
  process.exit(1);
}
const after = sourceIdentity(root);
const conclusion = promotableGateRun(run.status, counts, before, after) ? 'GO' : 'NO-GO';
const row = [
  started.toISOString().slice(0, 10),
  before.sha,
  gate,
  pg ?? 'n/a',
  `${counts.tests}/${counts.pass}/${counts.fail}/${counts.skipped}/${counts.todo}`,
  Math.round(counts.duration_ms ?? 0),
  conclusion,
  '',
].join(' | ');
const record = `| ${row} |\n`;
if (out) appendFileSync(resolve(root, out), record);
else process.stdout.write(record);
if (conclusion !== 'GO') {
  // Failure signature only: never embed child output (may mention URLs/hosts).
  console.error(`gate ${gate} NO-GO: exit=${run.status ?? 'signal'} fail=${counts.fail} cancelled=${counts.cancelled} skipped=${counts.skipped} todo=${counts.todo} clean=${before.clean && after.clean} sourceStable=${before.sha === after.sha && before.fingerprint === after.fingerprint}`);
  if (stderr.trim() !== '') console.error('child stderr withheld from evidence; inspect the CI log directly');
  process.exit(1);
}
