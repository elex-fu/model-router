import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMetricsRegistry } from '../../src/server/metrics.js';

const DEFAULT_BUCKET_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/** Extract all sample lines (non-comment) from a rendered exposition. */
function sampleLines(text: string): string[] {
  return text.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
}

function findSamples(text: string, name: string): string[] {
  return sampleLines(text).filter((line) => {
    const spaceIdx = line.lastIndexOf(' ');
    const sampleName = line.slice(0, spaceIdx);
    return sampleName === name || sampleName.startsWith(`${name}{`);
  });
}

test('counter accumulates per label-set and ignores non-positive token deltas', () => {
  const m = createMetricsRegistry();
  m.incRequest({ proto: 'anthropic', upstream: 'up1', status: 200 });
  m.incRequest({ proto: 'anthropic', upstream: 'up1', status: 200 });
  m.incRequest({ proto: 'anthropic', upstream: 'up1', status: 500 });
  const text = m.render();
  assert.equal(
    findSamples(text, 'model_router_requests_total').includes(
      'model_router_requests_total{proto="anthropic",status="200",upstream="up1"} 2',
    ),
    true,
  );
  assert.equal(
    findSamples(text, 'model_router_requests_total').includes(
      'model_router_requests_total{proto="anthropic",status="500",upstream="up1"} 1',
    ),
    true,
  );

  m.addTokens('input', 'up1', 100);
  m.addTokens('input', 'up1', 50);
  m.addTokens('input', 'up1', 0); // ignored
  m.addTokens('input', 'up1', -7); // ignored
  m.addTokens('input', 'up1', Number.NaN); // ignored
  const text2 = m.render();
  assert.equal(
    findSamples(text2, 'model_router_tokens_total').includes(
      'model_router_tokens_total{direction="input",upstream="up1"} 150',
    ),
    true,
  );
});

test('observeRequest without duration counts the request but records no histogram series', () => {
  const m = createMetricsRegistry();
  m.observeRequest({ proto: 'openai', upstream: 'up2', status: 429 });
  const text = m.render();
  assert.equal(findSamples(text, 'model_router_requests_total').length, 1);
  assert.equal(findSamples(text, 'model_router_request_duration_ms_bucket').length, 0);
  assert.equal(findSamples(text, 'model_router_request_duration_ms_sum').length, 0);
  assert.equal(findSamples(text, 'model_router_request_duration_ms_count').length, 0);
});

test('histogram accumulates across bucket boundaries, including above the last bucket', () => {
  const m = createMetricsRegistry();
  m.observeDuration({ proto: 'anthropic', upstream: 'up1' }, 5); // exactly le=5 boundary
  m.observeDuration({ proto: 'anthropic', upstream: 'up1' }, 7); // le=10
  m.observeDuration({ proto: 'anthropic', upstream: 'up1' }, 26); // le=50
  m.observeDuration({ proto: 'anthropic', upstream: 'up1' }, 20000); // above le=10000 -> +Inf only
  const text = m.render();

  const bucketLines = findSamples(text, 'model_router_request_duration_ms_bucket').filter((line) =>
    line.includes('proto="anthropic"'),
  );
  assert.equal(bucketLines.length, DEFAULT_BUCKET_BOUNDS.length + 1); // bounds + +Inf

  const byBound = new Map<string, number>();
  for (const line of bucketLines) {
    const le = /le="([^"]+)"/.exec(line)?.[1];
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    assert.ok(le !== undefined);
    byBound.set(le, value);
  }
  assert.equal(byBound.get('5'), 1);
  assert.equal(byBound.get('10'), 2);
  assert.equal(byBound.get('25'), 2);
  assert.equal(byBound.get('50'), 3);
  assert.equal(byBound.get('100'), 3);
  assert.equal(byBound.get('10000'), 3);
  assert.equal(byBound.get('+Inf'), 4);

  const sumLine = findSamples(text, 'model_router_request_duration_ms_sum').find((line) =>
    line.includes('proto="anthropic"'),
  );
  const countLine = findSamples(text, 'model_router_request_duration_ms_count').find((line) =>
    line.includes('proto="anthropic"'),
  );
  assert.ok(sumLine?.endsWith(' 20038'));
  assert.ok(countLine?.endsWith(' 4'));

  // Buckets are monotonic non-decreasing and +Inf equals the count.
  let prev = -1;
  for (const bound of [...DEFAULT_BUCKET_BOUNDS.map(String), '+Inf']) {
    const v = byBound.get(bound);
    assert.ok(v !== undefined && v >= prev, `bucket le=${bound} must be >= previous`);
    prev = v as number;
  }
  assert.equal(prev, 4);
});

test('histogram accepts custom buckets and drops non-positive / non-finite durations', () => {
  const m = createMetricsRegistry({ durationBuckets: [1, 2, 3] });
  m.observeDuration({ proto: 'openai', upstream: 'up1' }, 2.5);
  m.observeDuration({ proto: 'openai', upstream: 'up1' }, -1); // ignored
  m.observeDuration({ proto: 'openai', upstream: 'up1' }, Number.NaN); // ignored
  const text = m.render();
  const bucketLines = findSamples(text, 'model_router_request_duration_ms_bucket');
  assert.equal(bucketLines.length, 4); // 3 bounds + +Inf
  assert.ok(bucketLines.includes('model_router_request_duration_ms_bucket{le="1",proto="openai",upstream="up1"} 0'));
  assert.ok(bucketLines.includes('model_router_request_duration_ms_bucket{le="2",proto="openai",upstream="up1"} 0'));
  assert.ok(bucketLines.includes('model_router_request_duration_ms_bucket{le="3",proto="openai",upstream="up1"} 1'));
  assert.ok(bucketLines.includes('model_router_request_duration_ms_bucket{le="+Inf",proto="openai",upstream="up1"} 1'));
  assert.ok(
    findSamples(text, 'model_router_request_duration_ms_sum').includes(
      'model_router_request_duration_ms_sum{proto="openai",upstream="up1"} 2.5',
    ),
  );
  assert.ok(
    findSamples(text, 'model_router_request_duration_ms_count').includes(
      'model_router_request_duration_ms_count{proto="openai",upstream="up1"} 1',
    ),
  );
});

test('gauges: in_flight set/add and circuit state per upstream', () => {
  const m = createMetricsRegistry();
  m.addInFlight();
  m.addInFlight();
  m.addInFlight(-1);
  let text = m.render();
  assert.ok(findSamples(text, 'model_router_in_flight').includes('model_router_in_flight 1'));

  m.setInFlight(7);
  m.setCircuitState('up1', 0);
  m.setCircuitState('up2', 2);
  m.setCircuitState('up2', 1); // overwrite
  text = m.render();
  assert.ok(findSamples(text, 'model_router_in_flight').includes('model_router_in_flight 7'));
  assert.ok(
    findSamples(text, 'model_router_upstream_circuit_state').includes(
      'model_router_upstream_circuit_state{upstream="up1"} 0',
    ),
  );
  assert.ok(
    findSamples(text, 'model_router_upstream_circuit_state').includes(
      'model_router_upstream_circuit_state{upstream="up2"} 1',
    ),
  );

  m.setInFlight(Number.NaN); // ignored
  assert.ok(m.render().includes('model_router_in_flight 7'));
});

test('label values are sanitized to the safe charset', () => {
  const m = createMetricsRegistry();
  m.incRequest({ proto: 'anthropic extra/chars', upstream: 'up#1', status: 200 });
  m.addTokens('input tokens!', 'up#1', 5);
  m.setCircuitState('up/with:space', 0);
  const text = m.render();
  assert.ok(text.includes('model_router_requests_total{proto="anthropic_extra_chars",status="200",upstream="up_1"} 1'));
  assert.ok(text.includes('model_router_tokens_total{direction="input_tokens_",upstream="up_1"} 5'));
  assert.ok(text.includes('model_router_upstream_circuit_state{upstream="up_with:space"} 0'));
});

test('cardinality cap folds excess label-sets into a single overflow series', () => {
  const warnings: string[] = [];
  const m = createMetricsRegistry({
    maxLabelSets: 2,
    logger: { warn: (msg) => warnings.push(msg) },
  });
  for (let i = 0; i < 5; i++) {
    m.incRequest({ proto: 'anthropic', upstream: `up${i}`, status: 200 });
  }
  const text = m.render();
  const requestSamples = findSamples(text, 'model_router_requests_total');
  // 2 real series + 1 folded overflow series.
  assert.equal(requestSamples.length, 3);
  assert.ok(
    requestSamples.includes('model_router_requests_total{proto="overflow",status="overflow",upstream="overflow"} 3'),
  );
  // The one-time warning fired exactly once and mentions the family.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] as string, /requests_total/);
  // The silent overflow counter is exposed and counts every folded increment.
  assert.ok(
    findSamples(text, 'model_router_metrics_cardinality_overflow_total').includes(
      'model_router_metrics_cardinality_overflow_total{metric="model_router_requests_total"} 3',
    ),
  );
});

test('no logger means no console.log and no throw on overflow', () => {
  const m = createMetricsRegistry({ maxLabelSets: 1 });
  m.incRequest({ proto: 'a', upstream: 'u1', status: 200 });
  m.incRequest({ proto: 'a', upstream: 'u2', status: 200 });
  m.incRequest({ proto: 'a', upstream: 'u3', status: 200 });
  const text = m.render();
  assert.ok(text.includes('model_router_requests_total{proto="overflow",status="overflow",upstream="overflow"} 2'));
});

test('render emits exact Prometheus text for a crafted scenario', () => {
  const m = createMetricsRegistry();
  m.setInFlight(2);
  m.setCircuitState('up1', 0);
  m.observeRequest({ proto: 'anthropic', upstream: 'up1', status: 200 }, 12);
  m.observeRequest({ proto: 'anthropic', upstream: 'up1', status: 200 }, 4);
  m.observeRequest({ proto: 'openai', upstream: 'up2', status: 500 }, 6000);
  m.addTokens('input', 'up1', 100);
  m.addTokens('output', 'up1', 250);

  // RSS is sampled at scrape time; mask it for the exact-text comparison.
  const actual = m.render().replace(/(model_router_process_resident_memory_bytes )\d+/, '$1RSS');
  const expected = [
    '# HELP model_router_requests_total Total proxy requests by protocol, upstream and response status.',
    '# TYPE model_router_requests_total counter',
    'model_router_requests_total{proto="anthropic",status="200",upstream="up1"} 2',
    'model_router_requests_total{proto="openai",status="500",upstream="up2"} 1',
    '# HELP model_router_request_duration_ms Request duration in milliseconds by protocol and upstream.',
    '# TYPE model_router_request_duration_ms histogram',
    'model_router_request_duration_ms_bucket{le="5",proto="anthropic",upstream="up1"} 1',
    'model_router_request_duration_ms_bucket{le="10",proto="anthropic",upstream="up1"} 1',
    'model_router_request_duration_ms_bucket{le="25",proto="anthropic",upstream="up1"} 2',
    'model_router_request_duration_ms_bucket{le="50",proto="anthropic",upstream="up1"} 2',
    'model_router_request_duration_ms_bucket{le="100",proto="anthropic",upstream="up1"} 2',
    'model_router_request_duration_ms_bucket{le="250",proto="anthropic",upstream="up1"} 2',
    'model_router_request_duration_ms_bucket{le="500",proto="anthropic",upstream="up1"} 2',
    'model_router_request_duration_ms_bucket{le="1000",proto="anthropic",upstream="up1"} 2',
    'model_router_request_duration_ms_bucket{le="2500",proto="anthropic",upstream="up1"} 2',
    'model_router_request_duration_ms_bucket{le="5000",proto="anthropic",upstream="up1"} 2',
    'model_router_request_duration_ms_bucket{le="10000",proto="anthropic",upstream="up1"} 2',
    'model_router_request_duration_ms_bucket{le="+Inf",proto="anthropic",upstream="up1"} 2',
    'model_router_request_duration_ms_sum{proto="anthropic",upstream="up1"} 16',
    'model_router_request_duration_ms_count{proto="anthropic",upstream="up1"} 2',
    'model_router_request_duration_ms_bucket{le="5",proto="openai",upstream="up2"} 0',
    'model_router_request_duration_ms_bucket{le="10",proto="openai",upstream="up2"} 0',
    'model_router_request_duration_ms_bucket{le="25",proto="openai",upstream="up2"} 0',
    'model_router_request_duration_ms_bucket{le="50",proto="openai",upstream="up2"} 0',
    'model_router_request_duration_ms_bucket{le="100",proto="openai",upstream="up2"} 0',
    'model_router_request_duration_ms_bucket{le="250",proto="openai",upstream="up2"} 0',
    'model_router_request_duration_ms_bucket{le="500",proto="openai",upstream="up2"} 0',
    'model_router_request_duration_ms_bucket{le="1000",proto="openai",upstream="up2"} 0',
    'model_router_request_duration_ms_bucket{le="2500",proto="openai",upstream="up2"} 0',
    'model_router_request_duration_ms_bucket{le="5000",proto="openai",upstream="up2"} 0',
    'model_router_request_duration_ms_bucket{le="10000",proto="openai",upstream="up2"} 1',
    'model_router_request_duration_ms_bucket{le="+Inf",proto="openai",upstream="up2"} 1',
    'model_router_request_duration_ms_sum{proto="openai",upstream="up2"} 6000',
    'model_router_request_duration_ms_count{proto="openai",upstream="up2"} 1',
    '# HELP model_router_tokens_total Total tokens observed by direction and upstream.',
    '# TYPE model_router_tokens_total counter',
    'model_router_tokens_total{direction="input",upstream="up1"} 100',
    'model_router_tokens_total{direction="output",upstream="up1"} 250',
    '# HELP model_router_in_flight Number of requests currently being processed by the proxy.',
    '# TYPE model_router_in_flight gauge',
    'model_router_in_flight 2',
    '# HELP model_router_upstream_circuit_state Upstream circuit breaker state (0 closed, 1 half-open, 2 open).',
    '# TYPE model_router_upstream_circuit_state gauge',
    'model_router_upstream_circuit_state{upstream="up1"} 0',
    '# HELP model_router_process_resident_memory_bytes Resident memory size of the proxy process in bytes.',
    '# TYPE model_router_process_resident_memory_bytes gauge',
    'model_router_process_resident_memory_bytes RSS',
    '',
  ].join('\n');
  assert.equal(actual, expected);
});

test('fresh registry renders only the always-present gauges', () => {
  const m = createMetricsRegistry();
  const text = m.render();
  assert.ok(text.includes('# TYPE model_router_in_flight gauge'));
  assert.ok(/model_router_process_resident_memory_bytes \d+\n$/.test(text));
  assert.ok(!text.includes('requests_total'));
  assert.ok(!text.includes('request_duration_ms'));
  assert.ok(!text.includes('tokens_total'));
  assert.ok(!text.includes('upstream_circuit_state'));
  // Every line ends with exactly one terminating newline at the end of the exposition.
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.endsWith('\n\n'));
});

test('reset clears all series and gauges', () => {
  const m = createMetricsRegistry({ maxLabelSets: 1 });
  m.observeRequest({ proto: 'anthropic', upstream: 'up1', status: 200 }, 10);
  m.incRequest({ proto: 'anthropic', upstream: 'up2', status: 200 }); // folds to overflow
  m.addTokens('input', 'up1', 10);
  m.setCircuitState('up1', 2);
  m.setInFlight(4);
  m.reset();
  const text = m.render();
  assert.ok(!text.includes('requests_total{'));
  assert.ok(!text.includes('request_duration_ms_bucket'));
  assert.ok(!text.includes('tokens_total{'));
  assert.ok(!text.includes('upstream_circuit_state{'));
  assert.ok(!text.includes('cardinality_overflow'));
  assert.ok(text.includes('model_router_in_flight 0'));
  // Post-reset increments land on fresh series, overflow included.
  m.incRequest({ proto: 'openai', upstream: 'up9', status: 200 });
  assert.ok(m.render().includes('model_router_requests_total{proto="openai",status="200",upstream="up9"} 1'));
});

test('custom prefix renames every metric', () => {
  const m = createMetricsRegistry({ prefix: 'mr_test_' });
  m.incRequest({ proto: 'anthropic', upstream: 'up1', status: 200 });
  m.setInFlight(1);
  const text = m.render();
  assert.ok(text.includes('# TYPE mr_test_requests_total counter'));
  assert.ok(text.includes('mr_test_requests_total{proto="anthropic",status="200",upstream="up1"} 1'));
  assert.ok(text.includes('mr_test_in_flight 1'));
  assert.ok(!text.includes('model_router_'));
});
