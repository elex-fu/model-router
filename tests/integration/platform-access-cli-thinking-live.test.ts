import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capturePlatformAccessCliThinkingWorkflow, runPlatformAccessCliThinkingObservationWorkflow } from '../../scripts/ops/verify-platform-access-cli-workflow.js';
import { verifyPlatformAccessFirstRequest } from '../../scripts/ops/verify-platform-access-first-request.js';

const live = process.env.RUN_PLATFORM_ACCESS_CLI_THINKING_LIVE === '1';
const captureOnly = process.env.RUN_PLATFORM_ACCESS_CLI_THINKING_CAPTURE === '1';

// Independent, provider-free preflight:
// RUN_PLATFORM_ACCESS_CLI_THINKING_CAPTURE=1 node --import tsx --test <this file>
// This is the thinking-enabled counterpart of the omitted observation scene:
// with a positive thinking budget the observed CLI 2.1.216 requests adaptive
// thinking and must replay the provider thinking sequence in assistant history.
test('enabled-thinking CLI capture and optional controlled two-Read accounting observation', {
  skip: !live && !captureOnly ? 'Requires explicit platform CLI thinking live or capture opt-in' : false,
  timeout: 300_000,
}, async (t) => {
  if (live) {
    assert.equal(process.env.PLATFORM_ACCESS_CLI_WORKFLOW_RUNNER, 'platform-cli-thinking', 'Use the named disposable PG18 runner');
    assert.equal(process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED, '1');
    assert.equal(process.env.RUN_PLATFORM_ACCESS_FIRST_REQUEST_LIVE, '1');
    assert.ok(process.env.KIMI_CODE_API_KEY, 'Ephemeral live provider material is required');
  }

  const capture = await capturePlatformAccessCliThinkingWorkflow({ signal: t.signal });
  assert.equal(capture.messageObserved, true);
  assert.equal(capture.upstreamContacted, false);
  assert.ok(Number.isSafeInteger(capture.request.maxTokens) && capture.request.maxTokens > 0 && capture.request.maxTokens <= 1536);
  assert.equal(capture.request.thinking, 'adaptive');
  assert.equal(capture.request.stream, true);
  assert.equal(capture.request.toolCount, 1);
  t.diagnostic(JSON.stringify({ phase: 'cli-enabled-thinking-capture', cliVersion: capture.cliVersion,
    messageObserved: capture.messageObserved, upstreamContacted: capture.upstreamContacted,
    request: { maxTokens: capture.request.maxTokens, thinking: capture.request.thinking,
      stream: capture.request.stream, toolCount: capture.request.toolCount } }));
  if (!live) return;

  // Normal P01 provisioning and explicit Key, followed by at most three
  // generation requests; parent checks native numeric usage and durable sums.
  await verifyPlatformAccessFirstRequest((value) => t.diagnostic(JSON.stringify(value)), {
    cliWorkflow: { kind: 'claude-two-read-thinking-enabled-observation', run: runPlatformAccessCliThinkingObservationWorkflow },
  });
  t.diagnostic(JSON.stringify({ phase: 'cli-enabled-thinking-complete', scope: 'two-Read/native-numeric/accounting-observation',
    thinkingModeProven: true, thinkingReplayRequired: true, backendRevisionProven: false, providerHardLimitProven: false, productionGo: false }));
});
