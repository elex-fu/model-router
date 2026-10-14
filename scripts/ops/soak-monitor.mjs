#!/usr/bin/env node
// soak-monitor.mjs — hourly runtime inspection for long-running model-router daemons.
//
// Collects one JSONL line per cycle into ~/.model-router/soak/inspect-YYYYMMDD.jsonl:
//   process   RSS (KB) and uptime for the daemon PID (from --pid-file)
//   sockets   lsof counts by TCP state (ESTABLISHED / CLOSE_WAIT / LISTEN ...)
//   files     byte sizes of logs.sqlite / telemetry.sqlite / control.sqlite + WAL sidecars
//   data      row counts + oldest/newest timestamps from requests / attempts / live_request_minute
//   probe     /healthz status + one tiny proxied request (skipped without SOAK_PROXY_KEY)
//   warns     flat list of threshold flags (CLOSE_WAIT>0, RSS>2x baseline, WAL>100MB)
//
// Modes:  --once   single cycle, then exit (cron-friendly)
//         --watch  default; cycle every --interval seconds (default 3600)
//
// No secrets in this file: the probe proxy key is read from SOAK_PROXY_KEY env.
// SQLite access is read-only (sqlite3 "file:...?mode=ro" URI).

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const dataDir = arg('data-dir', path.join(homedir(), '.model-router'));
const soakDir = path.join(dataDir, 'soak');
const pidFile = arg('pid-file', path.join(dataDir, 'router.pid'));
const healthUrl = arg('health-url', 'http://127.0.0.1:15005/healthz');
const intervalSec = Number(arg('interval', 3600));
const mode = process.argv.includes('--once') ? 'once' : 'watch';

mkdirSync(soakDir, { recursive: true });
const statePath = path.join(soakDir, 'baseline.json');
const baseline = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;

function sh(cmd, args, fallback = '') {
  return run(cmd, args, { timeout: 15_000 }).then((r) => r.stdout).catch(() => fallback);
}

async function collectProcess(pid) {
  if (!pid) return { pid: null };
  const out = await sh('ps', ['-o', 'rss=,etime=', String(pid)]);
  const parts = out.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { pid, alive: false };
  return { pid, alive: true, rssKb: Number(parts[0]), uptime: parts[1] };
}

async function collectSockets(pid) {
  if (!pid) return {};
  const out = await sh('lsof', ['-nP', '-a', '-p', String(pid), '-i', 'TCP']);
  const counts = {};
  for (const line of out.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    const state = cols[cols.length - 1];
    if (state && state !== 'TCP') counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}

function collectFiles() {
  const files = {};
  for (const name of [
    'logs.sqlite', 'logs.sqlite-wal', 'logs.sqlite-shm',
    'telemetry.sqlite', 'telemetry.sqlite-wal', 'telemetry.sqlite-shm',
    'control.sqlite', 'control.sqlite-wal', 'control.sqlite-shm',
  ]) {
    const p = path.join(dataDir, name);
    if (existsSync(p)) files[name] = statSync(p).size;
  }
  return files;
}

async function collectData() {
  const db = path.join(dataDir, 'logs.sqlite');
  if (!existsSync(db)) return {};
  const uri = `file:${db}?mode=ro`;
  const q = async (sql) =>
    (await sh('sqlite3', ['-readonly', uri, sql])).trim();
  const out = {};
  const rows = await q("SELECT COUNT(*), COALESCE(MIN(datetime(started_at_ms/1000,'unixepoch')),'-'), COALESCE(MAX(datetime(started_at_ms/1000,'unixepoch')),'-') FROM requests");
  const [rc, rmin, rmax] = rows.split('|');
  out.requests = { count: Number(rc), oldest: rmin, newest: rmax };
  const arows = await q("SELECT COUNT(*), SUM(CASE WHEN status='200' THEN 1 ELSE 0 END), SUM(CASE WHEN status NOT IN ('200','') THEN 1 ELSE 0 END) FROM attempts");
  const [ac, aok, afail] = arows.split('|');
  out.attempts = { count: Number(ac), ok: Number(aok ?? 0), failed: Number(afail ?? 0) };
  out.liveMinuteRows = Number(await q('SELECT COUNT(*) FROM live_request_minute'));
  out.credentialDist = (await q("SELECT credential_id||':'||COUNT(*) FROM attempts WHERE upstream_id='kimi-code' GROUP BY credential_id")).split('\n').filter(Boolean);
  return out;
}

async function collectProbe() {
  const entry = {};
  try {
    const t0 = Date.now();
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
    entry.healthz = r.status;
    entry.healthzMs = Date.now() - t0;
  } catch (e) {
    entry.healthz = 'error';
    entry.healthzError = String(e.cause ?? e).slice(0, 120);
  }
  const key = process.env.SOAK_PROXY_KEY;
  if (!key) {
    entry.probe = 'skipped (SOAK_PROXY_KEY not set)';
    return entry;
  }
  try {
    const t0 = Date.now();
    const r = await fetch(new URL('/v1/messages', healthUrl).toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-code', max_tokens: 8,
        messages: [{ role: 'user', content: 'reply ok' }],
      }),
    });
    entry.probeStatus = r.status;
    entry.probeMs = Date.now() - t0;
  } catch (e) {
    entry.probeStatus = 'error';
    entry.probeError = String(e.cause ?? e).slice(0, 120);
  }
  return entry;
}

function deriveWarns(record, base) {
  const warns = [];
  if ((record.sockets.CLOSE_WAIT ?? 0) > 0) warns.push(`CLOSE_WAIT=${record.sockets.CLOSE_WAIT}`);
  if (base?.rssKb && record.process.rssKb > base.rssKb * 2) {
    warns.push(`RSS ${record.process.rssKb}KB > 2x baseline ${base.rssKb}KB`);
  }
  for (const [name, size] of Object.entries(record.files)) {
    if (name.endsWith('-wal') && size > 100 * 1024 * 1024) warns.push(`${name} ${size} > 100MB`);
  }
  if (record.probe.probeStatus !== undefined && record.probe.probeStatus !== 200) {
    warns.push(`probe=${record.probe.probeStatus}`);
  }
  return warns;
}

async function cycle() {
  const pidStr = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '';
  const pid = /^\d+$/.test(pidStr) ? Number(pidStr) : null;
  const record = {
    ts: new Date().toISOString(),
    process: await collectProcess(pid),
    sockets: await collectSockets(pid),
    files: collectFiles(),
    data: await collectData(),
    probe: await collectProbe(),
  };
  record.warns = deriveWarns(record, baseline);
  if (!baseline && record.process.rssKb) {
    writeFileSync(statePath, JSON.stringify({ rssKb: record.process.rssKb, ts: record.ts }));
    record.note = 'baseline captured';
  }
  const outPath = path.join(soakDir, `inspect-${record.ts.slice(0, 10)}.jsonl`);
  appendFileSync(outPath, JSON.stringify(record) + '\n');
  const line = [
    record.ts.slice(11, 19),
    `rss=${record.process.rssKb ?? '?'}KB`,
    `est=${record.sockets.ESTABLISHED ?? 0} cw=${record.sockets.CLOSE_WAIT ?? 0}`,
    `req=${record.data.requests?.count ?? '?'}`,
    `probe=${record.probe.probeStatus ?? record.probe.probe ?? record.probe.healthz}`,
    record.warns.length ? `WARNS: ${record.warns.join('; ')}` : 'ok',
  ].join(' ');
  console.log(line);
  return record;
}

if (mode === 'once') {
  await cycle();
} else {
  console.log(`soak-monitor watching every ${intervalSec}s, output under ${soakDir}`);
  await cycle();
  setInterval(() => { void cycle(); }, intervalSec * 1000);
}
