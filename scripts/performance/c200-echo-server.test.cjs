'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BODY, appendBounded, requestId, parseArgs, clockAnchor } = require('./c200-echo-server.cjs');

test('echo response and identity are fixed diagnostic bytes', () => {
  assert.deepEqual(JSON.parse(BODY), { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  assert.equal(Buffer.byteLength(BODY), 61);
  assert.equal(requestId(1), '00000000-0000-4000-8000-000000000001');
  assert.equal(requestId(338), '00000000-0000-4000-8000-000000000338');
});
test('setup is bounded and requires explicit absolute artifact paths', () => {
  assert.deepEqual(parseArgs(['--state','/workspace/state.json','--out','/workspace/out.json']), {
    port: 0, delayMs: 5, stateFile: '/workspace/state.json', outputFile: '/workspace/out.json' });
  for (const extra of [['--port','-1'],['--port','65536'],['--delay-ms','101'],['--delay-ms','0.5'],['--unknown','x'],['--out','relative']]) {
    assert.throws(() => parseArgs(['--state','/workspace/state.json','--out','/workspace/out.json',...extra]));
  }
});
test('bounded telemetry reports every discarded row', () => {
  const rows = [], drops = { requests: 0 };
  for (let i = 0; i < 5; i++) appendBounded(rows, { id: i }, 2, drops, 'requests');
  assert.deepEqual(rows, [{ id: 0 }, { id: 1 }]); assert.equal(drops.requests, 3);
});
test('clock anchor brackets a millisecond-resolution wall observation', () => {
  const anchor = clockAnchor();
  assert.ok(BigInt(anchor.monotonicAfterNs) >= BigInt(anchor.monotonicBeforeNs));
  assert.equal(anchor.wallResolutionNs, '1000000');
  assert.equal(BigInt(anchor.wallUnixNs) % 1000000n, 0n);
});
