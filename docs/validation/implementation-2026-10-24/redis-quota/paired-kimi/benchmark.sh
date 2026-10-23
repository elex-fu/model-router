set -eu
cd /opt/model-router
node --input-type=module <<'NODE'
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const reportDir = 'operations/paired-kimi-20261024-01';
fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const legacy = JSON.parse(fs.readFileSync('/etc/model-router/config.json', 'utf8'));
const current = JSON.parse(fs.readFileSync('/var/lib/model-router/current/config.json', 'utf8'));
const enabled = legacy.upstreams.filter(x => x.enabled !== false);
const active = current.upstreams.filter(x => x.enabled);
if (enabled.length !== 1 || active.length !== 1) throw new Error('Expected exactly one upstream for controlled comparison');
const upstream = enabled[0];
const directUrl = active[0].baseUrl.replace(/\/$/, '') + '/' + active[0].endpoints.generate.replace(/^\//, '');
const gatewayUrl = 'http://127.0.0.1:15005/v1/messages';
const proxyKey = legacy.proxyKeys.find(x => x.enabled !== false).key;
const secretValues = [proxyKey, ...(upstream.apiKeys ?? [])];
const clean = value => secretValues.reduce((s, key) => key ? s.split(key).join('[REDACTED]') : s, String(value ?? '')).slice(0, 160);
const manifest = JSON.parse(fs.readFileSync('.model-router-deploy-manifest.json', 'utf8'));
const servicePid = () => Number(execFileSync('systemctl', ['show', 'model-router.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim());
const pid = servicePid();
const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const body = JSON.stringify({ model: 'kimi-k2.6', messages: [{ role: 'user', content: 'Reply with exactly OK.' }], max_tokens: 32, stream: true, thinking: { type: 'disabled' } });
const round2 = x => Math.round(x * 100) / 100;
function proc() {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const cpu = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
  return { ticks: Number(fields[11]) + Number(fields[12]), rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0), cpuTotal: cpu.reduce((a,b) => a+b, 0), cpuIdle: cpu[3] + cpu[4] };
}
function stats(values) {
  const sorted = values.filter(x => x !== null && Number.isFinite(x)).sort((a,b) => a-b);
  if (!sorted.length) return { n: 0 };
  const mean = sorted.reduce((a,b) => a+b, 0) / sorted.length;
  const quantile = p => sorted[Math.max(0, Math.ceil(sorted.length*p)-1)];
  return { n: sorted.length, mean: round2(mean), p50: round2(quantile(.5)), p95: round2(quantile(.95)), min: round2(sorted[0]), max: round2(sorted.at(-1)), sampleSd: sorted.length > 1 ? round2(Math.sqrt(sorted.reduce((sum,v) => sum+(v-mean)**2, 0)/(sorted.length-1))) : 0 };
}
const metrics = ['headersMs', 'firstByteMs', 'firstTextMs', 'totalMs'];
function summarize(samples) {
  const result = { samples: samples.length, success: samples.filter(s => s.ok).length, failed: samples.filter(s => !s.ok).length };
  for (const metric of metrics) result[metric] = stats(samples.filter(s => s.ok).map(s => s[metric]));
  result.outputTokens = stats(samples.filter(s => s.ok).map(s => s.usage.output_tokens ?? null));
  result.statuses = samples.reduce((all,s) => { all[String(s.status)] = (all[String(s.status)] ?? 0) + 1; return all; }, {});
  return result;
}
function compare(samples) {
  const direct = summarize(samples.filter(s => s.leg === 'direct'));
  const gateway = summarize(samples.filter(s => s.leg === 'gateway'));
  const pairs = new Map();
  for (const sample of samples) { const key = `${sample.round}:${sample.pair}`; const pair = pairs.get(key) ?? {}; pair[sample.leg] = sample; pairs.set(key, pair); }
  const complete = [...pairs.values()].filter(p => p.direct?.ok && p.gateway?.ok);
  const differences = {};
  for (const metric of metrics) differences[metric] = stats(complete.map(p => p.gateway[metric] - p.direct[metric]));
  const meanTotalPercent = complete.length ? round2((gateway.totalMs.mean/direct.totalMs.mean - 1)*100) : null;
  return { direct, gateway, pairedGatewayMinusDirectMs: differences, gatewayMeanTotalChangePercent: meanTotalPercent };
}
const report = {
  startedAt: new Date().toISOString(), artifactSha256: manifest.artifactSha256, baseCommit: manifest.commit,
  scope: 'Existing optimized self-hosted production server; direct versus loopback gateway, same remote load client. Includes real upstream network and generation. Not an isolated measurement of pure router CPU or public client latency.',
  design: { rounds: 5, pairsPerRound: 10, formalPerLeg: 50, warmupPerLeg: 2, concurrency: 1, order: 'Alternate direct-gateway and gateway-direct pairs, exactly five of each order per round', gapBetweenRoundsMs: 3000, retries: 0, excludeOutliers: false },
  request: JSON.parse(body), host: { cpus: os.cpus().length, totalMemoryMiB: Math.round(os.totalmem()/1048576), loadAtStart: os.loadavg() },
  warmups: [], samples: [], rounds: []
};
const save = () => fs.writeFileSync(`${reportDir}/raw.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
async function request(leg, round, pair, position, sequence) {
  const started = performance.now();
  const sample = { leg, round, pair, position, sequence, startedAt: new Date().toISOString(), status: null, headersMs: null, firstByteMs: null, firstTextMs: null, totalMs: null, terminal: false, textChars: 0, textMatchesExpected: false, usage: {}, error: null, ok: false };
  let fullText = '';
  try {
    const response = await fetch(leg === 'direct' ? directUrl : gatewayUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + (leg === 'direct' ? upstream.apiKeys[0] : proxyKey), 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', Accept: 'text/event-stream' }, body, signal: AbortSignal.timeout(30000), redirect: 'error' });
    sample.status = response.status;
    sample.headersMs = performance.now() - started;
    if (response.status !== 200) {
      let errorBody; try { errorBody = await response.json(); } catch {}
      sample.error = clean(errorBody?.error?.type || errorBody?.error?.code || 'http_error');
    } else {
      let pending = '';
      const decoder = new TextDecoder();
      const event = frame => {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let item; try { item = JSON.parse(data); } catch { continue; }
          if (item.type === 'message_stop') sample.terminal = true;
          if (item.type === 'error') sample.error = clean(item.error?.type || item.error?.code || 'stream_error');
          if (item.message?.usage) sample.usage = { ...sample.usage, ...item.message.usage };
          if (item.usage) sample.usage = { ...sample.usage, ...item.usage };
          if (item.type === 'content_block_delta' && typeof item.delta?.text === 'string' && item.delta.text.length) {
            sample.firstTextMs ??= performance.now() - started;
            sample.textChars += item.delta.text.length;
            fullText += item.delta.text;
          }
        }
      };
      for await (const chunk of response.body) {
        sample.firstByteMs ??= performance.now() - started;
        pending += decoder.decode(chunk, { stream: true });
        const frames = pending.split(/\r?\n\r?\n/); pending = frames.pop(); for (const frame of frames) event(frame);
      }
      pending += decoder.decode(); if (pending.trim()) event(pending);
    }
  } catch (error) { sample.error = clean(error.cause?.code ?? error.name); }
  sample.totalMs = performance.now() - started;
  sample.textMatchesExpected = fullText.trim() === 'OK';
  sample.ok = sample.status === 200 && sample.terminal && sample.textChars > 0 && !sample.error;
  return sample;
}
let sequence = 0;
for (const leg of ['direct', 'gateway', 'gateway', 'direct']) {
  const sample = await request(leg, 0, 0, sequence, sequence++); report.warmups.push(sample); save();
  console.log(JSON.stringify({ type: 'warmup', leg, status: sample.status, ok: sample.ok, totalMs: round2(sample.totalMs) }));
  if (!sample.ok) { report.stoppedAfterFailure = true; save(); process.exit(1); }
}
let failed = false;
for (let round = 1; round <= report.design.rounds && !failed; round++) {
  const before = proc(); const start = performance.now(); const samples = []; let rssMax = before.rssKiB;
  for (let pair = 1; pair <= report.design.pairsPerRound && !failed; pair++) {
    const order = (pair + round) % 2 === 0 ? ['direct', 'gateway'] : ['gateway', 'direct'];
    for (let position = 0; position < order.length; position++) {
      const sample = await request(order[position], round, pair, position, sequence++); samples.push(sample); report.samples.push(sample); save();
      if (!sample.ok) { failed = true; report.stoppedAfterFailure = true; break; }
    }
    rssMax = Math.max(rssMax, proc().rssKiB);
  }
  const elapsedMs = performance.now() - start; const after = proc();
  const summary = { round, elapsedMs: round2(elapsedMs), ...compare(samples), routerCpuPercent: round2((after.ticks-before.ticks)/hz/(elapsedMs/1000)*100), hostCpuBusyPercent: round2((1-(after.cpuIdle-before.cpuIdle)/(after.cpuTotal-before.cpuTotal))*100), routerRssMaxMiB: round2(rssMax/1024), loadAfter: os.loadavg() };
  report.rounds.push(summary); save(); console.log(JSON.stringify({ type: 'round', ...summary }));
  if (round < report.design.rounds && !failed) await delay(report.design.gapBetweenRoundsMs);
}
report.finishedAt = new Date().toISOString(); report.host.loadAtEnd = os.loadavg(); report.sameRouterProcess = servicePid() === pid;
report.aggregate = compare(report.samples);
report.byPairOrder = Object.fromEntries(['direct', 'gateway'].map(first => [first + 'First', compare(report.samples.filter(s => ((s.pair+s.round)%2===0 ? 'direct' : 'gateway') === first))]));
report.expectedTextCount = report.samples.filter(s => s.textMatchesExpected).length;
save(); console.log(JSON.stringify({ type: 'aggregate', ...report.aggregate, sameRouterProcess: report.sameRouterProcess, expectedTextCount: report.expectedTextCount, reportDir }));
if (failed || !report.sameRouterProcess) process.exitCode = 1;
NODE
