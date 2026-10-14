#!/usr/bin/env node
// bench-ollama.mjs — local load test for the model-router proxy using Ollama as upstream.
//
// Traffic shape: Anthropic-protocol clients (a→o bridge → Ollama qwen2.5-coder:7b).
// Phases (all against one proxy key, concurrency limit 10 → expect 429s beyond that):
//   1. baseline        serial, 6 requests          — per-request latency floor
//   2. concurrency ramp 1/2/4/8/12/16, 2 rounds each — throughput scaling + 429 boundary
//   3. streaming       4 parallel SSE requests     — first-byte latency, chunk integrity
//
// Usage:
//   MR_BENCH_KEY=<proxy key> node scripts/ops/bench-ollama.mjs [--model ollama|kimi-code] [--max-tokens N]
//   MR_BENCH_KEY=<proxy key> node scripts/ops/bench-ollama.mjs --sustain --model kimi-code --concurrency 4 --minutes 5
//     Sustained mode: fixed concurrency for N minutes, per-minute latency windows and
//     per-minute resource sampling (proxy RSS via pid file, ollama CPU/RSS via pgrep).
//     Note: kimi-code spends real upstream quota — prefer small --minutes/--max-tokens.
// No secrets in this file: the proxy key is read from MR_BENCH_KEY env.

const BASE = process.env.MR_BENCH_URL ?? 'http://127.0.0.1:15005';
const KEY = process.env.MR_BENCH_KEY;

// Model profiles: sensible per-target defaults. kimi-code spends real quota, so its
// default max_tokens stays small and its prompt asks for a terse reply (the model's
// thinking phase consumes tokens invisibly — budget for ~4x the visible reply).
const MODEL_PROFILES = {
  'ollama':   { maxTokens: 60,  prompt: (i) => `用一句话介绍数字 ${i}` },
  'kimi-code': { maxTokens: 96,  prompt: (i) => `只回复两个字：正常${i % 10}` },
  'longcat':  { maxTokens: 64,  prompt: (i) => `只回复两个字：正常${i % 10}` },
};
const MODEL = arg('model', 'ollama');
const PROFILE = MODEL_PROFILES[MODEL] ?? { maxTokens: 60, prompt: (i) => `Reply OK ${i}.` };
const MAX_TOKENS = Number(arg('max-tokens', PROFILE.maxTokens));
const PROMPT = PROFILE.prompt;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
if (!KEY) {
  console.error('Set MR_BENCH_KEY to the proxy key before running.');
  process.exit(1);
}

const stats = { ok: 0, fail: 0, status: {}, latencies: [], firstBytes: [], chunks: 0, chars: 0 };

function record(status, ms) {
  stats.status[status] = (stats.status[status] ?? 0) + 1;
  if (status === 200) { stats.ok++; stats.latencies.push(ms); } else stats.fail++;
}

async function oneRequest(i) {
  const t0 = performance.now();
  try {
    const r = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      signal: AbortSignal.timeout(180_000),
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: PROMPT(i) }],
      }),
    });
    const body = await r.text();
    record(r.status, performance.now() - t0);
    if (r.status === 200) {
      try { stats.chars += JSON.parse(body).content?.[0]?.text?.length ?? 0; } catch {}
    }
  } catch (e) {
    record(`error:${String(e.cause?.code ?? e.name).slice(0, 20)}`, performance.now() - t0);
  }
}

async function oneStream(i) {
  const t0 = performance.now();
  let firstByteMs = null;
  try {
    const r = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      signal: AbortSignal.timeout(180_000),
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: MAX_TOKENS, stream: true,
        messages: [{ role: 'user', content: MODEL === 'kimi-code' ? '只回复两个字：成功' : '从1数到10，只输出数字' }],
      }),
    });
    stats.status[r.status] = (stats.status[r.status] ?? 0) + 1;
    if (r.status !== 200) { stats.fail++; return; }
    stats.ok++;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs === null) { firstByteMs = performance.now() - t0; stats.firstBytes.push(firstByteMs); }
      stats.chunks += dec.decode(value, { stream: true }).split('\n').filter((l) => l.startsWith('data:')).length;
    }
    record(200, performance.now() - t0); // total duration tracked separately below
    stats.latencies.pop(); // streams: don't pollute non-stream latency stats
  } catch (e) {
    stats.fail++;
    stats.status[`error:${String(e.cause?.code ?? e.name).slice(0, 20)}`] = 1;
  }
}

const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
function reportLatencies(label, arr) {
  const s = [...arr].sort((x, y) => x - y);
  console.log(`${label}: n=${s.length} p50=${pct(s, .5).toFixed(0)}ms p90=${pct(s, .9).toFixed(0)}ms p99=${pct(s, .99).toFixed(0)}ms max=${Math.max(...s, 0).toFixed(0)}ms`);
}

async function phase(name, concurrency, rounds) {
  const t0 = performance.now();
  const batch = [];
  for (let i = 0; i < rounds * concurrency; i++) batch.push(i);
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < batch.length) { const i = batch[idx++]; await oneRequest(i); }
  });
  await Promise.all(workers);
  const dur = (performance.now() - t0) / 1000;
  const oks = stats.status[200] ?? 0;
  console.log(`${name}: c=${concurrency} n=${batch.length} ${dur.toFixed(1)}s ${(batch.length / dur).toFixed(2)} req/s | ${stats.status[429] ?? 0}×429 ${stats.status[504] ?? 0}×504 ${stats.fail} fail`);
}

// --- Sustained mode: fixed concurrency, N minutes, per-minute windows + resource sampling
if (process.argv.includes('--sustain')) {
  const C = Number(arg('concurrency', 8));
  const MINUTES = Number(arg('minutes', 10));
  const pidFile = arg('pid-file', `${process.env.HOME}/.model-router/router.pid`);
  const t0 = performance.now();
  const windows = []; // per-minute {latencies, status, proxyRss, ollamaCpu, ollamaRss}
  let cur = { latencies: [], status: {}, proxyRss: 0, ollamaCpu: 0, ollamaRss: 0 };
  let reqIdx = 0, totalOk = 0, totalFail = 0;

  async function sampleResources() {
    try {
      const pid = (await promisify(execFile)('cat', [pidFile])).stdout.trim();
      const ps = (await promisify(execFile)('ps', ['-o', 'rss=,%cpu=', pid])).stdout.trim().split(/\s+/);
      cur.proxyRss = Number(ps[0]); cur.proxyCpu = Number(ps[1]);
    } catch { cur.proxyRss = cur.proxyRss || 0; }
    try {
      const pids = (await promisify(execFile)('pgrep', ['-x', 'ollama'])).stdout.trim().split('\n').filter(Boolean);
      let cpu = 0, rss = 0;
      for (const p of pids) {
        const ps = (await promisify(execFile)('ps', ['-o', 'rss=,%cpu=', p])).stdout.trim().split(/\s+/);
        rss += Number(ps[0]); cpu += Number(ps[1]);
      }
      cur.ollamaRss = rss; cur.ollamaCpu = cpu;
    } catch { cur.ollamaCpu = cur.ollamaCpu || 0; }
  }

  const minuteTimer = setInterval(async () => {
    windows.push(cur);
    console.log(`min ${windows.length}: ok=${cur.latencies.length} p50=${pct([...cur.latencies].sort((a,b)=>a-b), .5).toFixed(0)}ms p90=${pct([...cur.latencies].sort((a,b)=>a-b), .9).toFixed(0)}ms 429=${cur.status[429] ?? 0} proxy=${(cur.proxyRss/1024).toFixed(0)}MB/${cur.proxyCpu ?? '?'}% ollama=${(cur.ollamaRss/1024).toFixed(0)}MB/${cur.ollamaCpu.toFixed(0)}%`);
    cur = { latencies: [], status: {}, proxyRss: 0, ollamaCpu: 0, ollamaRss: 0 };
    void sampleResources();
  }, 60_000);
  void sampleResources();

  async function sustainWorker() {
    const deadline = t0 + MINUTES * 60_000;
    while (performance.now() < deadline) {
      const i = reqIdx++;
      const s0 = performance.now();
      try {
        const r = await fetch(`${BASE}/v1/messages`, {
          method: 'POST',
          signal: AbortSignal.timeout(180_000),
          headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: MODEL, max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: PROMPT(i) }],
          }),
        });
        await r.text();
        cur.status[r.status] = (cur.status[r.status] ?? 0) + 1;
        if (r.status === 200) { totalOk++; cur.latencies.push(performance.now() - s0); }
        else totalFail++;
      } catch { totalFail++; cur.status.error = (cur.status.error ?? 0) + 1; }
    }
  }

  console.log(`sustained bench: c=${C} for ${MINUTES}min, model=${MODEL} max_tokens=${MAX_TOKENS}`);
  await Promise.all(Array.from({ length: C }, sustainWorker));
  clearInterval(minuteTimer);
  const wall = (performance.now() - t0) / 1000;

  console.log('---');
  const all = windows.flatMap((w) => w.latencies).sort((a, b) => a - b);
  reportLatencies('sustained all-200', all);
  const first = windows[0]?.latencies ?? [], lastWin = [...windows].reverse().find((w) => w.latencies.length)?.latencies ?? [];
  reportLatencies('first minute   ', first);
  reportLatencies('last busy minute', lastWin);
  console.log(`totals: ${totalOk} ok / ${totalFail} fail in ${wall.toFixed(0)}s = ${(totalOk / wall).toFixed(2)} req/s sustained`);
  const statuses = Object.entries(windows.reduce((acc, w) => { for (const [k, v] of Object.entries(w.status)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {}));
  console.log(`status codes: ${JSON.stringify(Object.fromEntries(statuses))}`);
  const rssTrend = windows.map((w) => (w.proxyRss / 1024).toFixed(0));
  console.log(`proxy RSS per minute (MB): ${rssTrend.join(' → ')}`);
  process.exit(0);
}

// --- Phase 1: serial baseline
console.log(`bench target: ${BASE} model=${MODEL} max_tokens=${MAX_TOKENS} (upstream: Ollama via a→o bridge)`);
await phase('serial baseline   ', 1, 6);
const baselineCopy = [...stats.latencies];

// --- Phase 2: concurrency ramp (429s expected beyond limit 10)
for (const c of [2, 4, 8, 12, 16]) await phase('ramp             ', c, 2);

// --- Phase 3: streaming
const preFail = stats.fail;
await Promise.all([oneStream(1), oneStream(2), oneStream(3), oneStream(4)]);
console.log(`streaming         : c=4 done, ${stats.chunks} SSE events, ${stats.fail - preFail} fail`);

console.log('---');
reportLatencies('serial latency ', baselineCopy);
reportLatencies('all 200 latency', stats.latencies);
if (stats.firstBytes.length) reportLatencies('stream TTFB    ', stats.firstBytes);
console.log(`status codes: ${JSON.stringify(stats.status)} | ok=${stats.ok} fail=${stats.fail}`);
