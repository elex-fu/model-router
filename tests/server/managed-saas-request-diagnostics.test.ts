import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeploymentRequestDiagnostics } from '../../src/server/managed-saas.js';
import { RequestDiagnosticTrace } from '../../src/saas/gateway/request-diagnostic-trace.js';

test('standard request diagnostics are disabled by default and sample every configured N', () => {
  assert.equal(createDeploymentRequestDiagnostics({}), undefined);
  for (const value of ['0', '-1', ' 2', '1.5', '1000000000']) assert.throws(() => createDeploymentRequestDiagnostics({ MODEL_ROUTER_REQUEST_DIAGNOSTICS_SAMPLE_EVERY: value }), /REQUEST_DIAGNOSTICS_CONFIG_INVALID/u);
  const observer = createDeploymentRequestDiagnostics({ MODEL_ROUTER_REQUEST_DIAGNOSTICS_SAMPLE_EVERY: '2' })!;
  assert.equal(observer.select('one'), false);
  assert.equal(observer.select('two'), true);
  assert.equal(observer.select('three'), false);
});

test('diagnostic sink queues bounded numeric-only snapshots without synchronously writing', async () => {
  const lines: string[] = [];
  const observer = createDeploymentRequestDiagnostics({ MODEL_ROUTER_REQUEST_DIAGNOSTICS_SAMPLE_EVERY: '1' }, (line) => { lines.push(line); })!;
  const trace = new RequestDiagnosticTrace().snapshot();
  observer.observe({ requestId: 'server-id', trace: { ...trace, secret: 'must-never-be-emitted' } as typeof trace });
  assert.equal(lines.length, 0);
  for (let index = 0; index < 100; index++) observer.observe({ requestId: 'server-id', trace });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.length < 4096);
  assert.equal(lines[0]!.includes('must-never-be-emitted'), false);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.kind, 'request-diagnostic-v1');
  assert.equal(parsed.phases.length, 6);
});
