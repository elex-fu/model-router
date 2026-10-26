import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { FastGatewayExecutionError } from '../../../../src/saas/gateway/fast/executor.js';
import {
  type FastGatewayFailureDiagnostic,
  reportFastGatewayFailure,
} from '../../../../src/saas/gateway/fast/failure-diagnostic.js';
import { FastGatewaySnapshotError } from '../../../../src/saas/gateway/fast/snapshots.js';

test('failure diagnostics retain only fixed codes, relative frames and server UUID', () => {
  const seen: FastGatewayFailureDiagnostic[] = [];
  const requestId = randomUUID();
  const sensitive = `private-${randomUUID()}`;
  const error = Object.assign(new Error(sensitive), {
    name: sensitive,
    code: '40001',
    query: sensitive,
    parameters: [sensitive],
    cause: new Error(sensitive),
    stack: `${sensitive}\n    at ${sensitive} (/private/${sensitive}/dist/saas/gateway/fast/snapshots.js:627:36)\n    at ${sensitive} (https://${sensitive}/credentials:1:2)\n    at ${sensitive} (/private/${sensitive}/src/saas/gateway/fast/executor.ts:240:20)`,
  });
  reportFastGatewayFailure(
    (event) => {
      seen.push(event);
    },
    error,
    requestId,
    false,
  );
  assert.deepEqual(seen, [
    {
      requestId,
      headersSent: false,
      category: 'error',
      code: '40001',
      frames: [
        { source: 'dist/saas/gateway/fast/snapshots.js', line: 627, column: 36 },
        { source: 'src/saas/gateway/fast/executor.ts', line: 240, column: 20 },
      ],
    },
  ]);
  assert.equal(JSON.stringify(seen).includes(sensitive), false);
  error.code = sensitive;
  reportFastGatewayFailure(
    (event) => {
      seen.push(event);
    },
    error,
    sensitive,
    true,
  );
  assert.equal(seen[1].code, null);
  assert.equal(seen[1].requestId, undefined);
  assert.equal(seen[1].headersSent, true);
});

test('failure diagnostics classify known denials without translating them into transient errors', () => {
  const seen: FastGatewayFailureDiagnostic[] = [];
  for (const error of [
    new FastGatewaySnapshotError('SNAPSHOT_DENIED'),
    new FastGatewaySnapshotError('SNAPSHOT_UNAVAILABLE'),
    new FastGatewayExecutionError(429, 'FAST_RATE_LIMITED'),
    new TypeError('private'),
    new RangeError('private'),
    new SyntaxError('private'),
    'private',
  ])
    reportFastGatewayFailure(
      (event) => {
        seen.push(event);
      },
      error,
      randomUUID(),
      false,
    );
  assert.deepEqual(
    seen.map(({ category, code }) => ({ category, code })),
    [
      { category: 'snapshot', code: 'SNAPSHOT_DENIED' },
      { category: 'snapshot', code: 'SNAPSHOT_UNAVAILABLE' },
      { category: 'execution', code: 'FAST_RATE_LIMITED' },
      { category: 'type-error', code: null },
      { category: 'range-error', code: null },
      { category: 'syntax-error', code: null },
      { category: 'unknown', code: null },
    ],
  );
});

test('failure diagnostics bound stack output and contain hostile accessors and observers', async () => {
  const seen: FastGatewayFailureDiagnostic[] = [];
  const capture = (event: FastGatewayFailureDiagnostic) => {
    seen.push(event);
  };
  reportFastGatewayFailure(
    capture,
    { stack: `private\n${'    at /src/saas/gateway/fast/snapshots.ts:1:2\n'.repeat(10000)}` },
    randomUUID(),
    false,
  );
  assert.equal(seen[0].frames.length, 8);
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('private');
      },
      getPrototypeOf() {
        throw new Error('private');
      },
    },
  );
  assert.doesNotThrow(() => reportFastGatewayFailure(capture, hostile, randomUUID(), false));
  assert.equal(seen[1].category, 'unknown');
  assert.doesNotThrow(() =>
    reportFastGatewayFailure(
      () => {
        throw new Error('observer');
      },
      hostile,
      randomUUID(),
      false,
    ),
  );
  assert.doesNotThrow(() =>
    reportFastGatewayFailure(
      async () => {
        throw new Error('observer');
      },
      hostile,
      randomUUID(),
      false,
    ),
  );
  assert.doesNotThrow(() => reportFastGatewayFailure(undefined, hostile, randomUUID(), false));
  await new Promise<void>((resolve) => setImmediate(resolve));
});
