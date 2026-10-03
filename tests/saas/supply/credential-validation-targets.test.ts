import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compileApprovedCredentialValidationTargets,
  credentialValidationJobSnapshotSha256,
  credentialValidationTargetEvidenceSha256,
  credentialValidationTargetRequestUrl,
  CredentialValidationTargetError,
  resolveApprovedCredentialValidationTarget,
} from '../../../src/saas/supply/credential-validation-targets.js';
import { prepareCredentialValidationRequeue } from '../../../src/saas/supply/credential-validation-worker.js';
import type { CredentialValidationRequeueCapabilityEvidence, CredentialValidationRequeueCommand } from '../../../src/saas/supply/types.js';
import { approvedTarget, customJob } from './credential-validation-test-fixture.js';

test('approved targets are copied, private and exact-tuple/version keyed; slash models are body-only', () => {
  const target = approvedTarget();
  const registry = compileApprovedCredentialValidationTargets([target]);
  const binding = resolveApprovedCredentialValidationTarget(registry, customJob(target));
  assert.ok(binding);
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(binding), true);
  assert.deepEqual(Object.keys(registry), []);
  assert.equal(credentialValidationTargetRequestUrl(binding).href, 'https://validation.example/v1/chat/completions');
  const mutable = target as { baseUrl: string };
  mutable.baseUrl = 'https://changed.example/v1/';
  assert.equal(binding.baseUrl, 'https://validation.example/v1/');
  const job = customJob(binding);
  for (const candidate of [
    { ...job, providerId: 'another' }, { ...job, productId: 'custom-anthropic' },
    { ...job, credentialType: 'oauth' }, { ...job, allowedModels: ['other/model'] },
    { ...job, target: { ...job.target, model: 'other/model' } },
    { ...job, target: { ...job.target, endpoint: 'messages' } },
    { ...job, target: { ...job.target, version: 2 } },
    { ...job, target: { ...job.target, url: 'https://changed.example/v1/' } },
  ]) assert.equal(resolveApprovedCredentialValidationTarget(registry, candidate), null);
  assert.equal(resolveApprovedCredentialValidationTarget(compileApprovedCredentialValidationTargets(), job), null);
});

test('binding digest covers exact URL/profile/model/version/approval and rejects malformed or unreviewed configuration', () => {
  const target = approvedTarget();
  for (const changes of [
    { baseUrl: 'https://changed.example/v1/' }, { approvalReference: 'different-review' },
    { capabilityVersion: 2 }, { model: 'other/model' }, { evidenceSha256: 'a'.repeat(64) },
  ]) assert.throws(() => compileApprovedCredentialValidationTargets([{ ...target, ...changes }]), CredentialValidationTargetError);
  for (const baseUrl of [
    'http://validation.example/v1/', 'https://user:secret@validation.example/v1/',
    'https://validation.example/v1/?key=secret', 'https://validation.example/v1/#fragment',
    'https://VALIDATION.example/v1/', 'https://validation.example.:443/v1/',
    'https://validation.example/v1', 'https://validation.example/../v1/',
    'https://validation.example:0/v1/',
    'https://validation.example/%2e%2e/v1/', 'https://validation.example/v1/\\messages/',
  ]) assert.throws(() => approvedTarget({ baseUrl }), CredentialValidationTargetError);
  assert.throws(() => compileApprovedCredentialValidationTargets([target, target]), CredentialValidationTargetError);
  assert.throws(() => compileApprovedCredentialValidationTargets([{ ...target, headers: { 'user-agent': 'claude-code' } }]), CredentialValidationTargetError);
  assert.throws(() => approvedTarget({ productId: 'custom-anthropic' }), CredentialValidationTargetError);
  for (const model of ['', 'model with space', 'model\r\nx-api-key: forged', 'https://private/model', 'model?secret=x', 'x'.repeat(257)]) {
    assert.throws(() => approvedTarget({ model }), CredentialValidationTargetError);
  }
  const old = approvedTarget({ expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.equal(resolveApprovedCredentialValidationTarget(compileApprovedCredentialValidationTargets([old]), customJob(old)), null);
  const messages = approvedTarget({ productId: 'custom-anthropic', endpoint: 'messages', protocol: 'anthropic-compatible',
    authProfile: 'anthropic-api-key-2023-06-01', baseUrl: 'https://validation.example/anthropic/v1/' });
  const messageBinding = resolveApprovedCredentialValidationTarget(compileApprovedCredentialValidationTargets([messages]), customJob(messages));
  assert.ok(messageBinding);
  assert.equal(credentialValidationTargetRequestUrl(messageBinding).href, 'https://validation.example/anthropic/v1/messages');
  assert.equal(credentialValidationTargetEvidenceSha256(messages), messages.evidenceSha256);
});

test('manual exact-snapshot requeue intent covers custom AND all six fixed targets without resetting attempts or executing SQL', () => {
  const target = approvedTarget();
  const registry = compileApprovedCredentialValidationTargets([target]);
  const candidates = [customJob(target), ...[
    ['kimi', 'kimi-platform', 'chat-completions', 'openai-compatible'],
    ['kimi', 'kimi-platform-global', 'chat-completions', 'openai-compatible'],
    ['deepseek', 'deepseek-chat', 'chat-completions', 'openai-compatible'],
    ['kimi', 'kimi-code', 'messages', 'anthropic-compatible'],
    ['kimi', 'kimi-code-global', 'messages', 'anthropic-compatible'],
    ['deepseek', 'deepseek-anthropic', 'messages', 'anthropic-compatible'],
  ].map(([providerId, productId, endpoint]) => ({ ...customJob(target), providerId, productId,
    allowedModels: ['model-a'], target: { model: 'model-a', endpoint, version: 1 } }))];
  for (const job of candidates) {
    const command: CredentialValidationRequeueCommand = { jobId: job.id, expectedLeaseGeneration: job.leaseGeneration,
      expectedSnapshotSha256: credentialValidationJobSnapshotSha256(job), idempotencyKey: 'b'.repeat(64),
      actorUserId: 'operator-fixture', requestId: 'request-fixture', reasonCode: 'target_approved' };
    const capability: CredentialValidationRequeueCapabilityEvidence = {
      providerId: job.providerId, productId: job.productId, model: job.target.model, endpoint: job.target.endpoint,
      capabilityVersion: job.target.version, protocol: job.target.endpoint === 'messages' ? 'anthropic-compatible' : 'openai-compatible',
      evidenceSha256: job.providerId === 'custom' ? target.evidenceSha256 : 'c'.repeat(64),
    };
    const before = JSON.stringify(job);
    const intent = prepareCredentialValidationRequeue(job, command, capability, registry);
    assert.equal(intent.requiresAtomicAuditHistory, true);
    assert.equal(intent.priorAttemptCount, 5);
    assert.equal(intent.priorErrorCode, 'adapter_unsupported');
    assert.equal(intent.expectedLeaseGeneration, job.leaseGeneration);
    assert.equal(JSON.stringify(job), before);
    assert.equal(Object.isFrozen(intent), true);
    for (const changes of [{ expectedLeaseGeneration: 0 }, { expectedSnapshotSha256: 'f'.repeat(64) },
      { actorUserId: '' }, { requestId: '' }]) {
      assert.throws(() => prepareCredentialValidationRequeue(job, { ...command, ...changes }, capability, registry), CredentialValidationTargetError);
    }
    assert.throws(() => prepareCredentialValidationRequeue({ ...job, state: 'leased' }, command, capability, registry), CredentialValidationTargetError);
    assert.throws(() => prepareCredentialValidationRequeue(job, command, { ...capability, capabilityVersion: 2 }, registry), CredentialValidationTargetError);
  }
});
