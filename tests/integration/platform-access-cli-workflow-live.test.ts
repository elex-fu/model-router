import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capturePlatformAccessCliWorkflow, runPlatformAccessCliWorkflow } from '../../scripts/ops/verify-platform-access-cli-workflow.js';
import { verifyPlatformAccessFirstRequest } from '../../scripts/ops/verify-platform-access-first-request.js';

const live = process.env.RUN_PLATFORM_ACCESS_CLI_WORKFLOW_LIVE === '1';
const captureOnly = process.env.RUN_PLATFORM_ACCESS_CLI_WORKFLOW_CAPTURE === '1';

// Independent, provider-free entry:
// RUN_PLATFORM_ACCESS_CLI_WORKFLOW_CAPTURE=1 node --import tsx --test <this file>
// Live acceptance must instead use the named disposable PG18 runner suite.
// Importing this root in the normal offline suite never starts a real CLI.
test('explicit platform CLI capture preflight and optional bounded formal provisioning workflow', {
  skip: !live && !captureOnly ? 'Requires explicit CLI capture or platform-cli live opt-in' : false,
  timeout: 300_000,
}, async (t) => {
  if (live) {
    assert.equal(process.env.PLATFORM_ACCESS_CLI_WORKFLOW_RUNNER, 'platform-cli', 'Use the named disposable runner suite');
    assert.equal(process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED, '1');
    assert.equal(process.env.RUN_PLATFORM_ACCESS_FIRST_REQUEST_LIVE, '1');
    assert.ok(process.env.KIMI_CODE_API_KEY, 'Ephemeral live provider material is required');
  }

  // This is completed before normal onboarding can probe the provider. The
  // capture driver uses a dummy key and an owned local observer, not PG/GW/PSP.
  const capture = await capturePlatformAccessCliWorkflow({ signal: t.signal });
  assert.equal(capture.messageObserved, true);
  assert.equal(capture.upstreamContacted, false);
  assert.ok(Number.isSafeInteger(capture.request.maxTokens) && capture.request.maxTokens > 0 && capture.request.maxTokens <= 512);
  assert.ok(capture.request.thinking === 'omitted' || capture.request.thinking === 'disabled');
  assert.equal(capture.request.stream, true);
  assert.ok(Number.isSafeInteger(capture.request.toolCount) && capture.request.toolCount > 0);
  assert.ok(Object.values(capture.flags).every((value) => typeof value === 'boolean'));
  t.diagnostic(JSON.stringify({ phase: 'cli-capture-preflight', cliVersion: capture.cliVersion,
    messageObserved: capture.messageObserved, upstreamContacted: capture.upstreamContacted,
    request: { maxTokens: capture.request.maxTokens, thinking: capture.request.thinking,
      stream: capture.request.stream, toolCount: capture.request.toolCount }, flags: capture.flags }));
  if (!live) return;
  assert.equal(capture.request.thinking, 'disabled', 'Live onboarding requires actual explicit thinking disabled in the captured request');

  // Reuse the normal P01 operation and explicit customer Key fixture. Its
  // narrow callback owns exactly three generation request IDs and verifies
  // durable usage/settlement, balances and cleanup through the existing path.
  await verifyPlatformAccessFirstRequest((value) => t.diagnostic(JSON.stringify(value)), {
    cliWorkflow: { kind: 'claude-two-read-thinking-disabled', run: runPlatformAccessCliWorkflow },
  });
});
