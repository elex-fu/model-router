#!/usr/bin/env tsx
/**
 * Model Router Benchmark / Evaluation Script
 *
 * Usage:
 *   cp scripts/benchmark.env.example .env
 *   npx tsx scripts/benchmark.ts
 *
 * Measures:
 *   - Latency (TTFB, total, JSON parse)
 *   - Throughput (successful requests / sec)
 *   - Correctness (HTTP status, JSON shape, non-empty content)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";

// ── Minimal .env parser ──────────────────────────────────────────────
export function loadEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

// ── Config ───────────────────────────────────────────────────────────
const env = { ...loadEnv(resolve(".env")), ...process.env };

const BASE_URL = (env.BASE_URL ?? env.BENCHMARK_BASE_URL ?? "").replace(
  /\/+$/,
  ""
);
const BASE_URL_IP = (env.BASE_URL_IP ?? "").replace(/\/+$/, "");
const API_KEY = env.API_KEY ?? env.BENCHMARK_API_KEY ?? "";
const MODEL = env.MODEL ?? "kimi-k2.6";
const MAX_TOKENS = Number(env.MAX_TOKENS ?? 256);
const CONCURRENCY = Number(env.CONCURRENCY ?? 5);
const REQUESTS = Number(env.REQUESTS ?? 20);
const WARMUP = Number(env.WARMUP ?? 2);
const TIMEOUT_MS = Number(env.TIMEOUT_MS ?? 30000);
const PROMPT =
  env.PROMPT ??
  "用一句话总结 model-router 的设计目标，并列出它的三个核心特性。";

const insecureAgent = new Agent({
  connect: { rejectUnauthorized: false },
});

function requireConfig(): void {
  const missing: string[] = [];
  if (!BASE_URL) missing.push("BASE_URL");
  if (!API_KEY) missing.push("API_KEY");
  if (missing.length) {
    console.error(`Missing config: ${missing.join(", ")}`);
    console.error("Set them in .env or environment variables.");
    process.exit(1);
  }
}

// ── Types ────────────────────────────────────────────────────────────
export interface BenchmarkResult {
  ok: boolean;
  status: number;
  ttfbMs: number;
  totalMs: number;
  parseMs: number;
  contentLength: number;
  error?: string;
}

export interface Summary {
  count: number;
  success: number;
  failed: number;
  ttfb: { min: number; max: number; avg: number; p50: number; p95: number; p99: number };
  latency: { min: number; max: number; avg: number; p50: number; p95: number; p99: number };
  rps: number;
  durationSec: number;
}

interface SendOptions {
  urlBase: string;
  dispatcher?: Agent;
}

// ── Core request ─────────────────────────────────────────────────────
async function sendRequest(opts: SendOptions): Promise<BenchmarkResult> {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${opts.urlBase}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: PROMPT }],
      }),
      signal: controller.signal,
      dispatcher: opts.dispatcher,
    });

    const ttfb = performance.now() - start;

    const text = await res.text();
    const total = performance.now() - start;

    let json: unknown;
    let parseMs = 0;
    if (res.ok) {
      const p0 = performance.now();
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      parseMs = performance.now() - p0;
    }

    // Validation
    let error: string | undefined;
    if (!res.ok) {
      error = `HTTP ${res.status}`;
    } else if (!isValidAnthropicResponse(json)) {
      error = "Invalid response shape";
    }

    return {
      ok: res.ok && !error,
      status: res.status,
      ttfbMs: ttfb,
      totalMs: total,
      parseMs,
      contentLength: text.length,
      error,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ttfbMs: performance.now() - start,
      totalMs: performance.now() - start,
      parseMs: 0,
      contentLength: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function isValidAnthropicResponse(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.type !== "message") return false;
  if (!Array.isArray(b.content) || b.content.length === 0) return false;
  return b.content.some((block: unknown) => {
    if (!block || typeof block !== "object") return false;
    const bb = block as Record<string, unknown>;
    return typeof bb.text === "string" && bb.text.trim().length > 0;
  });
}

// ── Concurrency helper ───────────────────────────────────────────────
async function runBatch(
  count: number,
  concurrency: number,
  opts: SendOptions
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < count) {
      const i = idx++;
      const r = await sendRequest(opts);
      results[i] = r;
      if (r.ok) {
        process.stdout.write(".");
      } else {
        process.stdout.write("x");
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  process.stdout.write("\n");
  return results;
}

// ── Stats ────────────────────────────────────────────────────────────
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function summarize(results: BenchmarkResult[], durationSec: number): Summary {
  const ok = results.filter((r) => r.ok);
  const ttfb = ok.map((r) => r.ttfbMs).sort((a, b) => a - b);
  const total = ok.map((r) => r.totalMs).sort((a, b) => a - b);

  const stats = (arr: number[]) => ({
    min: arr[0] ?? 0,
    max: arr[arr.length - 1] ?? 0,
    avg: arr.reduce((a, b) => a + b, 0) / (arr.length || 1),
    p50: percentile(arr, 50),
    p95: percentile(arr, 95),
    p99: percentile(arr, 99),
  });

  return {
    count: results.length,
    success: ok.length,
    failed: results.length - ok.length,
    ttfb: stats(ttfb),
    latency: stats(total),
    rps: ok.length / (durationSec || 1),
    durationSec,
  };
}

function printSummary(s: Summary): void {
  const fmt = (n: number) => n.toFixed(2);
  console.log("\n=== Summary ===");
  console.log(`Requests : ${s.count} (success=${s.success}, failed=${s.failed})`);
  console.log(`Duration : ${fmt(s.durationSec)}s`);
  console.log(`RPS      : ${fmt(s.rps)}`);
  console.log(`\nLatency (ms)          TTFB    Total`);
  console.log(`  min   :          ${fmt(s.ttfb.min).padStart(8)} ${fmt(s.latency.min).padStart(8)}`);
  console.log(`  avg   :          ${fmt(s.ttfb.avg).padStart(8)} ${fmt(s.latency.avg).padStart(8)}`);
  console.log(`  p50   :          ${fmt(s.ttfb.p50).padStart(8)} ${fmt(s.latency.p50).padStart(8)}`);
  console.log(`  p95   :          ${fmt(s.ttfb.p95).padStart(8)} ${fmt(s.latency.p95).padStart(8)}`);
  console.log(`  p99   :          ${fmt(s.ttfb.p99).padStart(8)} ${fmt(s.latency.p99).padStart(8)}`);
  console.log(`  max   :          ${fmt(s.ttfb.max).padStart(8)} ${fmt(s.latency.max).padStart(8)}`);
}

async function runSuite(label: string, opts: SendOptions): Promise<Summary> {
  console.log(`\n>>> ${label} : ${opts.urlBase}/v1/messages`);
  console.log(`Warmup   : ${WARMUP}`);
  console.log(`Requests : ${REQUESTS}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Timeout  : ${TIMEOUT_MS}ms\n`);

  if (WARMUP > 0) {
    console.log("Warming up...");
    await runBatch(WARMUP, 1, opts);
  }

  console.log("Benchmarking...");
  const t0 = performance.now();
  const results = await runBatch(REQUESTS, CONCURRENCY, opts);
  const durationSec = (performance.now() - t0) / 1000;

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log("\nFailed requests:");
    for (const f of failed.slice(0, 5)) {
      console.log(`  - status=${f.status} error=${f.error}`);
    }
    if (failed.length > 5) console.log(`  ... and ${failed.length - 5} more`);
  }

  const summary = summarize(results, durationSec);
  printSummary(summary);
  return summary;
}

function printComparison(
  domain: Summary,
  ip: Summary
): void {
  const fmt = (n: number) => n.toFixed(2);
  const deltaPct = (a: number, b: number) =>
    a > 0 ? `${(((b - a) / a) * 100).toFixed(1)}%` : "N/A";

  console.log("\n========== Domain vs IP Direct Comparison ==========");
  console.log(`                     Domain                IP Direct          Delta`);
  console.log(`Success             ${String(domain.success).padStart(6)} / ${String(domain.count).padEnd(3)}        ${String(ip.success).padStart(6)} / ${String(ip.count).padEnd(3)}`);
  console.log(`Duration            ${fmt(domain.durationSec).padStart(10)}s        ${fmt(ip.durationSec).padStart(10)}s`);
  console.log(`RPS                 ${fmt(domain.rps).padStart(10)}          ${fmt(ip.rps).padStart(10)}`);
  console.log(`TTFB avg            ${fmt(domain.ttfb.avg).padStart(10)}ms       ${fmt(ip.ttfb.avg).padStart(10)}ms       ${deltaPct(ip.ttfb.avg, domain.ttfb.avg)}`);
  console.log(`TTFB p95            ${fmt(domain.ttfb.p95).padStart(10)}ms       ${fmt(ip.ttfb.p95).padStart(10)}ms       ${deltaPct(ip.ttfb.p95, domain.ttfb.p95)}`);
  console.log(`Total avg           ${fmt(domain.latency.avg).padStart(10)}ms       ${fmt(ip.latency.avg).padStart(10)}ms       ${deltaPct(ip.latency.avg, domain.latency.avg)}`);
  console.log(`Total p95           ${fmt(domain.latency.p95).padStart(10)}ms       ${fmt(ip.latency.p95).padStart(10)}ms       ${deltaPct(ip.latency.p95, domain.latency.p95)}`);
  console.log("=====================================================");

  const domainConnectOverhead = domain.ttfb.avg - ip.ttfb.avg;
  if (domainConnectOverhead > 1000) {
    console.log(`\nObservation: Domain is ~${fmt(domainConnectOverhead)}ms slower on TTFB than IP direct.`);
    console.log("This suggests CDN/Cloudflare layer adds significant connection/setup latency.");
  } else if (domainConnectOverhead < -1000) {
    console.log(`\nObservation: IP direct is ~${fmt(-domainConnectOverhead)}ms slower on TTFB than domain.`);
    console.log("This suggests the origin server (IP) has higher latency than the CDN edge.");
  } else {
    console.log("\nObservation: TTFB difference is within 1s — DNS/CDN overhead is negligible.");
  }

  const coreProcessing = Math.min(ip.ttfb.avg, domain.ttfb.avg);
  if (coreProcessing > 5000) {
    console.log(`Core upstream processing alone averages ${fmt(coreProcessing)}ms, which is the dominant bottleneck.`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  requireConfig();

  console.log(`Model    : ${MODEL}`);
  console.log(`Prompt   : ${PROMPT.slice(0, 60)}${PROMPT.length > 60 ? "..." : ""}`);

  const domainOpts: SendOptions = { urlBase: BASE_URL };
  const domainSummary = await runSuite("Domain", domainOpts);

  let ipSummary: Summary | undefined;
  if (BASE_URL_IP) {
    const ipOpts: SendOptions = { urlBase: BASE_URL_IP, dispatcher: insecureAgent };
    ipSummary = await runSuite("IP Direct", ipOpts);
    printComparison(domainSummary, ipSummary);
  } else {
    console.log("\n(No BASE_URL_IP configured — skipping IP direct comparison.)");
  }

  // Show one sample response from domain
  console.log("\n=== Sample Response (Domain) ===");
  try {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: PROMPT }],
      }),
    });
    const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const textBlock = body.content?.find((b) => b.type === "text");
    console.log(textBlock?.text ?? "(no text)");
  } catch {
    console.log("(unable to fetch sample)");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
