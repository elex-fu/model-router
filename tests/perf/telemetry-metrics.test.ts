import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeTelemetryPerf } from '../../scripts/benchmark-console.mjs';

test('telemetry performance aggregation reports P50/P95 and watermarks without payload fields', () => {
  const summary = summarizeTelemetryPerf([
    { kind: 'telemetry-read-perf', endpoint: 'usageSummary', workerLifecycleMs: 20,
      workerTotalMs: 10, sequence: 41, stages: { summaryRequestSqlMs: 2, summaryAttemptSqlMs: 4 } },
    { kind: 'telemetry-read-perf', endpoint: 'usageSummary', workerLifecycleMs: 40,
      workerTotalMs: 20, sequence: 42, stages: { summaryRequestSqlMs: 6, summaryAttemptSqlMs: 8 } },
    { kind: 'telemetry-response-perf', endpoint: 'usage-summary', responseAssemblyMs: 1, sequence: 42 },
    { kind: 'telemetry-write-perf', batchSize: 2, queueMs: [1, 3], workerAckMs: [4, 8], enqueueToCommitMs: [5, 11] },
  ]);
  assert.deepEqual(summary.stages['usageSummary.summaryRequestSqlMs'], { samples: 2, p50: 2, p95: 6 });
  assert.deepEqual(summary.stages['usageSummary.workerLifecycleMs'], { samples: 2, p50: 20, p95: 40 });
  assert.deepEqual(summary.stages['writer.queueMs'], { samples: 2, p50: 1, p95: 3 });
  assert.deepEqual(summary.stages['writer.workerAckMs'], { samples: 2, p50: 4, p95: 8 });
  assert.deepEqual(summary.watermarks, [
    { endpoint: 'usageSummary', sequence: 41 },
    { endpoint: 'usageSummary', sequence: 42 },
    { endpoint: 'usage-summary', sequence: 42 },
  ]);
  assert.equal(JSON.stringify(summary).includes('secret'), false);
  assert.equal(JSON.stringify(summary).includes('payload'), false);
});
