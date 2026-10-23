import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const roleNames = [
  'MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL',
  'MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL',
  'MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL',
];
const required = process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED === '1';
const anyConfigured = roleNames.some((name) => Boolean(process.env[name]?.trim()));

test('managed process SIGTERM drains accepted platform SSE and durable financial cleanup', {
  skip: !required && !anyConfigured ? 'requires three real PostgreSQL role URLs and local HTTPS sockets' : false,
  timeout: 180_000,
}, async () => {
  for (const name of roleNames) assert.ok(process.env[name]?.trim(), `missing ${name}`);
  const child = fork(resolve('tests/saas/gateway/managed-postgres-commercial-gateway.integration.test.ts'), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED: '1', MODEL_ROUTER_MANAGED_SIGTERM_DRILL: '1' },
    // Do not forward environment, synthetic credentials, or arbitrary child logs.
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let firstFrame = false;
  let draining = false;
  let converged = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('event' in message)) return;
    if (message.event === 'first_frame') {
      firstFrame = true;
      child.kill('SIGTERM');
    } else if (message.event === 'draining') {
      draining = true;
      child.send({ event: 'release_terminal' });
    } else if (message.event === 'financial_converged') converged = true;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      exit,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SIGTERM drill child deadline exceeded')), 150_000); }),
    ]);
    assert.equal(firstFrame, true, 'child must observe the actual client first SSE frame');
    assert.equal(draining, true, 'SIGTERM must reach installed managed runtime handler');
    assert.equal(converged, true, 'client EOF, one usage/settlement, wallet/ledger/hold/lease must converge');
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
  }
});
