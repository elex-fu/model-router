import { describe, it } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEnv,
  isValidAnthropicResponse,
  percentile,
  summarize,
} from "../../scripts/benchmark.js";
import type { BenchmarkResult } from "../../scripts/benchmark.js";

describe("loadEnv", () => {
  it("parses standard key-value pairs", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-"));
    const path = join(dir, ".env");
    writeFileSync(path, "BASE_URL=https://example.com\nAPI_KEY=secret\n");
    deepStrictEqual(loadEnv(path), {
      BASE_URL: "https://example.com",
      API_KEY: "secret",
    });
    rmSync(dir, { recursive: true });
  });

  it("strips quotes from values", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-"));
    const path = join(dir, ".env");
    writeFileSync(path, 'MODEL="kimi-k2.6"\nPROMPT=\'hello world\'\n');
    deepStrictEqual(loadEnv(path), {
      MODEL: "kimi-k2.6",
      PROMPT: "hello world",
    });
    rmSync(dir, { recursive: true });
  });

  it("ignores empty lines and comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-"));
    const path = join(dir, ".env");
    writeFileSync(path, "# comment\n\nKEY=value\n  \n");
    deepStrictEqual(loadEnv(path), { KEY: "value" });
    rmSync(dir, { recursive: true });
  });

  it("returns empty object when file does not exist", () => {
    deepStrictEqual(loadEnv("/nonexistent/path/.env"), {});
  });
});

describe("isValidAnthropicResponse", () => {
  it("accepts a standard message response", () => {
    strictEqual(
      isValidAnthropicResponse({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      }),
      true
    );
  });

  it("accepts response with thinking block before text", () => {
    strictEqual(
      isValidAnthropicResponse({
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "..." },
          { type: "text", text: "result" },
        ],
      }),
      true
    );
  });

  it("rejects empty content array", () => {
    strictEqual(
      isValidAnthropicResponse({
        type: "message",
        role: "assistant",
        content: [],
      }),
      false
    );
  });

  it("rejects when no text block exists", () => {
    strictEqual(
      isValidAnthropicResponse({
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "..." },
          { type: "thinking", thinking: "..." },
        ],
      }),
      false
    );
  });

  it("rejects non-message type", () => {
    strictEqual(
      isValidAnthropicResponse({
        type: "error",
        error: { message: "oops" },
      }),
      false
    );
  });
});

describe("percentile", () => {
  it("calculates p50 and p95 correctly", () => {
    const arr = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    strictEqual(percentile([...arr].sort((a, b) => a - b), 50), 50);
    strictEqual(percentile([...arr].sort((a, b) => a - b), 95), 100);
  });

  it("returns 0 for empty array", () => {
    strictEqual(percentile([], 50), 0);
  });
});

describe("summarize", () => {
  it("computes summary statistics correctly", () => {
    const results: BenchmarkResult[] = [
      { ok: true, status: 200, ttfbMs: 100, totalMs: 200, parseMs: 5, contentLength: 50 },
      { ok: true, status: 200, ttfbMs: 200, totalMs: 300, parseMs: 5, contentLength: 50 },
      { ok: false, status: 500, ttfbMs: 50, totalMs: 50, parseMs: 0, contentLength: 0, error: "err" },
    ];
    const s = summarize(results, 10);
    strictEqual(s.count, 3);
    strictEqual(s.success, 2);
    strictEqual(s.failed, 1);
    strictEqual(s.ttfb.min, 100);
    strictEqual(s.ttfb.max, 200);
    strictEqual(s.latency.min, 200);
    strictEqual(s.latency.max, 300);
    strictEqual(s.rps, 0.2);
    strictEqual(s.durationSec, 10);
  });
});
