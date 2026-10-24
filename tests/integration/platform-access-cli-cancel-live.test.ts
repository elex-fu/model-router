import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPlatformAccessCliCancelObservationWorkflow } from '../../scripts/ops/verify-platform-access-cli-workflow.js';
import { verifyPlatformAccessFirstRequest } from '../../scripts/ops/verify-platform-access-first-request.js';

const live = process.env.RUN_PLATFORM_ACCESS_CLI_CANCEL_LIVE === '1';

// The client-cancel observation: the observer terminates the CLI mid-stream
// during the first generation (user-abort shape). The workflow must fail
// closed; the parent's failure-observation readback then asserts the
// platform cancel contract from durable state.
test('client-cancel observation keeps the platform cancel contract (no duplicate dispatch, honest hold)', {
  skip: !live ? 'Requires explicit platform CLI cancel live opt-in' : false,
  timeout: 300_000,
}, async (t) => {
  assert.equal(process.env.PLATFORM_ACCESS_CLI_WORKFLOW_RUNNER, 'platform-cli-cancel', 'Use the named disposable PG18 runner');
  assert.equal(process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED, '1');
  assert.equal(process.env.RUN_PLATFORM_ACCESS_FIRST_REQUEST_LIVE, '1');
  assert.ok(process.env.KIMI_CODE_API_KEY, 'Ephemeral live provider material is required');

  const diagnostics: Array<Record<string, any>> = [];
  const pushDiagnostic = (value: unknown) => {
    if (value !== null && typeof value === 'object') diagnostics.push(value as Record<string, any>);
  };
  // The cancel scene is expected to fail closed by design; capture the
  // diagnostic stream instead of letting the rejection escape unobserved.
  let rejected: unknown;
  try {
    await verifyPlatformAccessFirstRequest(pushDiagnostic, {
      cliWorkflow: { kind: 'claude-two-read-client-cancel-observation', run: runPlatformAccessCliCancelObservationWorkflow },
    });
  } catch (error) {
    rejected = error;
  }
  assert.ok(rejected instanceof Error, 'The cancel observation must fail closed');
  assert.match(String((rejected as Error).message), /real-claude-cli-two-read-client-cancel-observation/u);

  const failure = diagnostics.find((value) => value.scope === 'claude-two-read-client-cancel-failure-observation');
  assert.ok(failure, 'The scoped failure-observation readback must be present');
  const durable = failure.durable as Record<string, any> | undefined;
  assert.ok(durable && durable.available === true, 'The scoped durable readback must be available');
  const financial = durable!.financial as Record<string, string>;
  // Core invariant 1: exactly one admitted request and one attempt — the
  // cancelled generation must never be re-dispatched.
  assert.equal(financial.requests, '1', 'Client cancel must not create additional admitted requests');
  assert.equal(financial.attempts, '1', 'Client cancel must not re-dispatch the cancelled attempt');
  // Core invariant 2: the hold is honest — either fully compensated (0) or
  // explicitly retained pending reconciliation with a snapshot present.
  if (financial.hold !== '0') {
    assert.ok(Number(financial.snapshots) >= 1, 'A retained hold must carry an explicit reconciliation snapshot');
    const requests = Array.isArray(durable!.requests) ? durable!.requests : [];
    for (const request of requests as Array<Record<string, any>>) {
      assert.ok(request.executionState === 'unknown' || request.financialStatus === 'reconciliation_pending',
        'A cancelled request must be classified honestly (unknown / reconciliation_pending), never settled');
      const hold = request.hold as Record<string, unknown> | undefined;
      assert.ok(hold === undefined || hold.state === 'reconciliation_pending',
        'A retained hold must be labelled reconciliation_pending');
    }
  }
  const observed = diagnostics.find((value) => value.failedStage === 'real-claude-cli-two-read-client-cancel-observation');
  assert.ok(observed, 'The failed stage diagnostic must be present');
  t.diagnostic(JSON.stringify({ phase: 'cli-client-cancel-complete', scope: 'client-cancel/no-duplicate-dispatch/honest-hold',
    requests: financial.requests, attempts: financial.attempts, hold: financial.hold,
    snapshots: financial.snapshots, settlements: financial.settlements, productionGo: false }));
});
