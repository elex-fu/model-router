#!/usr/bin/env node
// Capture one release-gate run as an evidence record with native node:test
// counts. The script never reads or prints credential-bearing environment; it
// only parses the child reporter's ℹ count lines. Evidence is markdown on
// stdout (or appended with --out) for docs/evidence/* templates.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

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

const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (commit.error || commit.status !== 0) {
  console.error('git rev-parse HEAD failed');
  process.exit(1);
}

const started = new Date();
const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', testRoot], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const stdout = typeof run.stdout === 'string' ? run.stdout : '';
const stderr = typeof run.stderr === 'string' ? run.stderr : '';

function count(name) {
  const matches = [...stdout.matchAll(new RegExp(`^ℹ ${name} (\\d+(?:\\.\\d+)?)$`, 'gm'))];
  if (matches.length === 0) return null;
  return matches.reduce((total, match) => total + Number(match[1]), 0);
}
const counts = {
  tests: count('tests'),
  pass: count('pass'),
  fail: count('fail'),
  cancelled: count('cancelled'),
  skipped: count('skipped'),
  duration_ms: count('duration_ms'),
};
if (counts.tests === null || counts.pass === null || counts.fail === null) {
  console.error('native reporter counts not found; refusing to fabricate evidence');
  process.exit(1);
}
const conclusion = run.status === 0 && counts.fail === 0 && counts.cancelled === 0 ? 'GO' : 'NO-GO';
const row = [
  started.toISOString().slice(0, 10),
  commit.stdout.trim().slice(0, 12),
  gate,
  pg ?? 'n/a',
  `${counts.tests}/${counts.pass}/${counts.fail}/${counts.skipped}`,
  Math.round(counts.duration_ms ?? 0),
  conclusion,
  '',
].join(' | ');
const record = `| ${row} |\n`;
if (out) appendFileSync(resolve(root, out), record);
else process.stdout.write(record);
if (conclusion !== 'GO') {
  // Failure signature only: never embed child output (may mention URLs/hosts).
  console.error(`gate ${gate} NO-GO: exit=${run.status ?? 'signal'} fail=${counts.fail} cancelled=${counts.cancelled}`);
  if (stderr.trim() !== '') console.error('child stderr withheld from evidence; inspect the CI log directly');
  process.exit(1);
}
