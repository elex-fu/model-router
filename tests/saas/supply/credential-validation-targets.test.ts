import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CredentialValidationTargetError,
  compileApprovedCredentialValidationTargets,
  credentialValidationJobSnapshotSha256,
  credentialValidationTargetEvidenceSha256,
  credentialValidationTargetRequestUrl,
  resolveApprovedCredentialValidationTarget,
} from '../../../src/saas/supply/credential-validation-targets.js';
import { prepareCredentialValidationRequeue } from '../../../src/saas/supply/credential-validation-worker.js';
import type {
  CredentialValidationRequeueCapabilityEvidence,
  CredentialValidationRequeueCommand,
} from '../../../src/saas/supply/types.js';
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
    { ...job, providerId: 'another' },
    { ...job, productId: 'custom-anthropic' },
    { ...job, credentialType: 'oauth' },
    { ...job, allowedModels: ['other/model'] },
    { ...job, target: { ...job.target, model: 'other/model' } },
    { ...job, target: { ...job.target, endpoint: 'messages' } },
    { ...job, target: { ...job.target, version: 2 } },
    { ...job, target: { ...job.target, url: 'https://changed.example/v1/' } },
  ])
    assert.equal(resolveApprovedCredentialValidationTarget(registry, candidate), null);
  assert.equal(resolveApprovedCredentialValidationTarget(compileApprovedCredentialValidationTargets(), job), null);
});

test('binding digest covers exact URL/profile/model/version/approval and rejects malformed or unreviewed configuration', () => {
  const target = approvedTarget();
  for (const changes of [
    { baseUrl: 'https://changed.example/v1/' },
    { approvalReference: 'different-review' },
    { capabilityVersion: 2 },
    { model: 'other/model' },
    { evidenceSha256: 'a'.repeat(64) },
  ])
    assert.throws(
      () => compileApprovedCredentialValidationTargets([{ ...target, ...changes }]),
      CredentialValidationTargetError,
    );
  for (const baseUrl of [
    'http://validation.example/v1/',
    'https://user:secret@validation.example/v1/',
    'https://validation.example/v1/?key=secret',
    'https://validation.example/v1/#fragment',
    'https://VALIDATION.example/v1/',
    'https://validation.example.:443/v1/',
    'https://validation.example/v1',
    'https://validation.example/../v1/',
    'https://validation.example:0/v1/',
    'https://validation.example/%2e%2e/v1/',
    'https://validation.example/v1/\\messages/',
  ])
    assert.throws(() => approvedTarget({ baseUrl }), CredentialValidationTargetError);
  assert.throws(() => compileApprovedCredentialValidationTargets([target, target]), CredentialValidationTargetError);
  const unreviewed: ApprovedCredentialValidationTarget = { ...target };
  assert.equal(
    Reflect.defineProperty(unreviewed, 'headers', {
      value: { 'user-agent': 'claude-code' },
      enumerable: true,
      writable: true,
      configurable: true,
    }),
    true,
  );
  assert.throws(() => compileApprovedCredentialValidationTargets([unreviewed]), CredentialValidationTargetError);
  assert.throws(() => approvedTarget({ productId: 'custom-anthropic' }), CredentialValidationTargetError);
  for (const model of [
    '',
    'model with space',
    'model\r\nx-api-key: forged',
    'https://private/model',
    'model?secret=x',
    'x'.repeat(257),
  ]) {
    assert.throws(() => approvedTarget({ model }), CredentialValidationTargetError);
  }
  const old = approvedTarget({ expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.equal(
    resolveApprovedCredentialValidationTarget(compileApprovedCredentialValidationTargets([old]), customJob(old)),
    null,
  );
  const messages = approvedTarget({
    productId: 'custom-anthropic',
    endpoint: 'messages',
    protocol: 'anthropic-compatible',
    authProfile: 'anthropic-api-key-2023-06-01',
    baseUrl: 'https://validation.example/anthropic/v1/',
  });
  const messageBinding = resolveApprovedCredentialValidationTarget(
    compileApprovedCredentialValidationTargets([messages]),
    customJob(messages),
  );
  assert.ok(messageBinding);
  assert.equal(
    credentialValidationTargetRequestUrl(messageBinding).href,
    'https://validation.example/anthropic/v1/messages',
  );
  assert.equal(credentialValidationTargetEvidenceSha256(messages), messages.evidenceSha256);
});

test('manual exact-snapshot requeue intent covers custom AND all six fixed targets without resetting attempts or executing SQL', () => {
  const target = approvedTarget();
  const registry = compileApprovedCredentialValidationTargets([target]);
  const candidates = [
    customJob(target),
    ...[
      ['kimi', 'kimi-platform', 'chat-completions', 'openai-compatible'],
      ['kimi', 'kimi-platform-global', 'chat-completions', 'openai-compatible'],
      ['deepseek', 'deepseek-chat', 'chat-completions', 'openai-compatible'],
      ['kimi', 'kimi-code', 'messages', 'anthropic-compatible'],
      ['kimi', 'kimi-code-global', 'messages', 'anthropic-compatible'],
      ['deepseek', 'deepseek-anthropic', 'messages', 'anthropic-compatible'],
    ].map(([providerId, productId, endpoint]) => ({
      ...customJob(target),
      providerId,
      productId,
      allowedModels: ['model-a'],
      target: { model: 'model-a', endpoint, version: 1 },
    })),
  ];
  for (const job of candidates) {
    const command: CredentialValidationRequeueCommand = {
      jobId: job.id,
      expectedLeaseGeneration: job.leaseGeneration,
      expectedSnapshotSha256: credentialValidationJobSnapshotSha256(job),
      idempotencyKey: 'b'.repeat(64),
      actorUserId: 'operator-fixture',
      requestId: 'request-fixture',
      reasonCode: 'target_approved',
    };
    const capability: CredentialValidationRequeueCapabilityEvidence = {
      providerId: job.providerId,
      productId: job.productId,
      model: job.target.model,
      endpoint: job.target.endpoint,
      capabilityVersion: job.target.version,
      protocol: job.target.endpoint === 'messages' ? 'anthropic-compatible' : 'openai-compatible',
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
    for (const changes of [
      { expectedLeaseGeneration: 0 },
      { expectedSnapshotSha256: 'f'.repeat(64) },
      { actorUserId: '' },
      { requestId: '' },
    ]) {
      assert.throws(
        () => prepareCredentialValidationRequeue(job, { ...command, ...changes }, capability, registry),
        CredentialValidationTargetError,
      );
    }
    assert.throws(
      () => prepareCredentialValidationRequeue({ ...job, state: 'leased' }, command, capability, registry),
      CredentialValidationTargetError,
    );
    assert.throws(
      () => prepareCredentialValidationRequeue(job, command, { ...capability, capabilityVersion: 2 }, registry),
      CredentialValidationTargetError,
    );
  }
});

test('platform-owner jobs fail closed out of the tenant-only 061 requeue channel', () => {
  const target = approvedTarget();
  const registry = compileApprovedCredentialValidationTargets([target]);
  const base = customJob(target);
  const capability: CredentialValidationRequeueCapabilityEvidence = {
    providerId: base.providerId,
    productId: base.productId,
    model: base.target.model,
    endpoint: base.target.endpoint,
    capabilityVersion: base.target.version,
    protocol: 'openai-compatible',
    evidenceSha256: target.evidenceSha256,
  };
  for (const job of [
    // Platform jobs never requeue through the tenant-bound 061 writer; their
    // recovery is a fresh enqueue under the platform queue's own idempotency.
    { ...base, ownerKind: 'platform' as const, tenantId: null },
    // A tenant-scope row without tenant identity is store corruption, not a default.
    { ...base, tenantId: null },
  ]) {
    const command: CredentialValidationRequeueCommand = {
      jobId: job.id,
      expectedLeaseGeneration: job.leaseGeneration,
      expectedSnapshotSha256: 'c'.repeat(64),
      idempotencyKey: 'b'.repeat(64),
      actorUserId: 'operator-fixture',
      requestId: 'request-fixture',
      reasonCode: 'target_approved',
    };
    assert.throws(
      () => prepareCredentialValidationRequeue(job, command, capability, registry),
      CredentialValidationTargetError,
    );
  }
});

import { createHash as canonicalTargetHash } from 'node:crypto';
import { credentialValidationTargetProbeProfile as canonicalProbeProfile } from '../../../src/saas/supply/credential-validation-targets.js';
import type { ApprovedCredentialValidationTarget } from '../../../src/saas/supply/types.js';

function canonicalTargetV2(
  kind: 'chat' | 'messages' = 'chat',
  expiresAt: string | null = null,
): ApprovedCredentialValidationTarget {
  const descriptor: Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'> = {
    schemaVersion: 2,
    providerId: 'custom',
    credentialType: 'api-key',
    model: 'organisation/model-v1',
    capabilityVersion: 1,
    baseUrl: 'https://validation.example/v1/',
    approvalReference: 'review-v2',
    expiresAt,
    ...(kind === 'chat'
      ? ({
          productId: 'custom-openai',
          endpoint: '/v1/chat/completions',
          protocol: 'openai',
          wirePath: 'chat/completions',
          wireProtocol: 'openai',
          authProfile: 'openai-bearer-v1',
        } as const)
      : ({
          productId: 'custom-anthropic',
          endpoint: '/v1/messages',
          protocol: 'anthropic',
          wirePath: 'messages',
          wireProtocol: 'anthropic',
          authProfile: 'anthropic-api-key-2023-06-01',
        } as const)),
  };
  return { ...descriptor, evidenceSha256: credentialValidationTargetEvidenceSha256(descriptor) };
}

test('v1 target digest, URL, field set and immutable job snapshot retain the original canonical bytes', () => {
  const original = approvedTarget();
  const oldPayload = {
    schema: 'model-router-credential-validation-target-v1',
    providerId: original.providerId,
    productId: original.productId,
    credentialType: original.credentialType,
    model: original.model,
    endpoint: original.endpoint,
    capabilityVersion: original.capabilityVersion,
    protocol: original.protocol,
    authProfile: original.authProfile,
    baseUrl: original.baseUrl,
    requestUrl: 'https://validation.example/v1/chat/completions',
    approvalReference: original.approvalReference,
    expiresAt: original.expiresAt,
  };
  assert.equal(original.evidenceSha256, canonicalTargetHash('sha256').update(JSON.stringify(oldPayload)).digest('hex'));
  const resolved = resolveApprovedCredentialValidationTarget(
    compileApprovedCredentialValidationTargets([original]),
    customJob(original),
  );
  assert.ok(resolved);
  assert.deepEqual(Object.keys(resolved), Object.keys(original));
  assert.deepEqual(resolved, original);
  assert.equal(credentialValidationTargetRequestUrl(resolved).href, oldPayload.requestUrl);
  const job = customJob(original);
  const snapshot = [
    'model-router-credential-validation-job-v1',
    job.id,
    job.tenantId,
    job.accountId,
    job.credentialId,
    job.credentialVersion,
    job.providerId,
    job.productId,
    job.credentialType,
    job.allowedModels,
    job.target.model,
    job.target.endpoint,
    job.target.version,
    job.idempotencyKey,
    job.createdAt,
  ];
  assert.equal(
    credentialValidationJobSnapshotSha256(job),
    canonicalTargetHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
  );
});

test('v2 binds one canonical capability to its exact fixed wire profile and keeps real compiler origin', () => {
  for (const kind of ['chat', 'messages'] as const) {
    const original = canonicalTargetV2(kind);
    const job = customJob(original);
    const registry = compileApprovedCredentialValidationTargets([original]);
    const binding = resolveApprovedCredentialValidationTarget(registry, job);
    assert.ok(binding);
    assert.equal(binding.endpoint, kind === 'chat' ? '/v1/chat/completions' : '/v1/messages');
    assert.equal(binding.protocol, kind === 'chat' ? 'openai' : 'anthropic');
    assert.equal(binding.schemaVersion, 2);
    assert.deepEqual(canonicalProbeProfile(binding), {
      adapterId: kind === 'chat' ? 'custom-openai-chat-v1' : 'custom-anthropic-messages-v1',
      kind,
    });
    assert.equal(credentialValidationTargetRequestUrl(binding).pathname, binding.endpoint);
    assert.equal(Object.isFrozen(binding), true);
    assert.deepEqual(Object.keys(registry), []);
    assert.throws(() => credentialValidationTargetRequestUrl({ ...binding }), CredentialValidationTargetError);
    assert.throws(() => canonicalProbeProfile({ ...binding }), CredentialValidationTargetError);
    Reflect.set(original, 'baseUrl', 'https://changed.example/v1/');
    assert.equal(binding.baseUrl, 'https://validation.example/v1/');
    assert.equal(
      job.target.endpoint,
      binding.endpoint,
      'the job has exactly the same capability, not a second binding',
    );
  }
});

test('v2 canonical evidence binds every authority/wire field and rejects omissions, tuple mixing and accessors', () => {
  const original = canonicalTargetV2();
  const changes: Array<Partial<ApprovedCredentialValidationTarget>> = [
    { model: 'other/model' },
    { capabilityVersion: 2 },
    { baseUrl: 'https://other.example/v1/' },
    { approvalReference: 'another-review' },
    { expiresAt: '2099-01-01T00:00:00.000Z' },
    { endpoint: '/v1/messages' },
    { protocol: 'anthropic' },
    { wirePath: 'messages' },
    { wireProtocol: 'anthropic' },
    { authProfile: 'anthropic-api-key-2023-06-01' },
    { productId: 'custom-anthropic' },
    { evidenceSha256: 'a'.repeat(64) },
  ];
  for (const change of changes) {
    assert.throws(
      () => compileApprovedCredentialValidationTargets([{ ...original, ...change }]),
      CredentialValidationTargetError,
    );
  }
  for (const field of Object.keys(original)) {
    const missing = { ...original };
    Reflect.deleteProperty(missing, field);
    assert.throws(() => compileApprovedCredentialValidationTargets([missing]), CredentialValidationTargetError);
  }
  assert.throws(
    () => compileApprovedCredentialValidationTargets([original, original]),
    CredentialValidationTargetError,
  );
  const v1 = approvedTarget();
  assert.throws(
    () => compileApprovedCredentialValidationTargets([{ ...v1, schemaVersion: 2 }]),
    CredentialValidationTargetError,
  );
  let accessorCalls = 0;
  const accessor = Object.defineProperty({ ...original }, 'wirePath', {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return 'chat/completions';
    },
  });
  assert.throws(() => compileApprovedCredentialValidationTargets([accessor]), CredentialValidationTargetError);
  assert.equal(accessorCalls, 0);
  const hidden = Object.defineProperty({ ...original }, 'approved', { value: true });
  assert.throws(() => compileApprovedCredentialValidationTargets([hidden]), CredentialValidationTargetError);
  const symbolic = { ...original, [Symbol('untrusted')]: true };
  assert.throws(() => compileApprovedCredentialValidationTargets([symbolic]), CredentialValidationTargetError);
  const unknownEndpoint = { ...original };
  Reflect.set(unknownEndpoint, 'endpoint', '/v1/other');
  assert.throws(() => credentialValidationTargetEvidenceSha256(unknownEndpoint), CredentialValidationTargetError);
});

test('v2 canonical hash uses its distinct full byte domain; no v1 hash or protocol omission can authorize it', () => {
  const original = canonicalTargetV2();
  const fullPayload = {
    schema: 'model-router-credential-validation-target-v2',
    schemaVersion: 2,
    purpose: 'credential-validation',
    providerId: original.providerId,
    productId: original.productId,
    credentialType: original.credentialType,
    model: original.model,
    endpoint: original.endpoint,
    capabilityVersion: original.capabilityVersion,
    protocol: original.protocol,
    wirePath: original.wirePath,
    wireProtocol: original.wireProtocol,
    authProfile: original.authProfile,
    baseUrl: original.baseUrl,
    requestUrl: 'https://validation.example/v1/chat/completions',
    approvalReference: original.approvalReference,
    expiresAt: original.expiresAt,
  };
  assert.equal(
    original.evidenceSha256,
    canonicalTargetHash('sha256').update(JSON.stringify(fullPayload)).digest('hex'),
  );
  assert.notEqual(original.evidenceSha256, approvedTarget().evidenceSha256);
  assert.throws(
    () =>
      compileApprovedCredentialValidationTargets([{ ...original, evidenceSha256: approvedTarget().evidenceSha256 }]),
    CredentialValidationTargetError,
  );
  const job = customJob(original);
  for (const changed of [
    { ...job, target: { ...job.target, endpoint: 'chat-completions' } },
    { ...job, target: { ...job.target, version: 2 } },
    { ...job, productId: 'custom-anthropic' },
    { ...job, allowedModels: ['another/model'] },
  ])
    assert.equal(
      resolveApprovedCredentialValidationTarget(compileApprovedCredentialValidationTargets([original]), changed),
      null,
    );
});

test('v2 expiry and stale requeue generation reject at the exact deadline without mutating the original job', () => {
  const expiresAt = '2099-01-01T00:00:00.000Z';
  const target = canonicalTargetV2('chat', expiresAt);
  const job = customJob(target);
  const registry = compileApprovedCredentialValidationTargets([target]);
  assert.ok(resolveApprovedCredentialValidationTarget(registry, job, Date.parse(expiresAt) - 1));
  assert.equal(resolveApprovedCredentialValidationTarget(registry, job, Date.parse(expiresAt)), null);
  const command: CredentialValidationRequeueCommand = {
    jobId: job.id,
    expectedLeaseGeneration: job.leaseGeneration,
    expectedSnapshotSha256: credentialValidationJobSnapshotSha256(job),
    idempotencyKey: 'b'.repeat(64),
    actorUserId: 'operator-fixture',
    requestId: 'request-fixture',
    reasonCode: 'retry_provider_validation',
  };
  const capability: CredentialValidationRequeueCapabilityEvidence = {
    providerId: target.providerId,
    productId: target.productId,
    model: target.model,
    endpoint: target.endpoint,
    capabilityVersion: target.capabilityVersion,
    protocol: target.protocol,
    evidenceSha256: target.evidenceSha256,
  };
  const before = JSON.stringify(job);
  assert.equal(
    prepareCredentialValidationRequeue(job, command, capability, registry).targetEvidenceSha256,
    target.evidenceSha256,
  );
  for (const changed of [
    { ...command, expectedLeaseGeneration: job.leaseGeneration + 1 },
    { ...command, expectedSnapshotSha256: 'c'.repeat(64) },
  ]) {
    assert.throws(
      () => prepareCredentialValidationRequeue(job, changed, capability, registry),
      CredentialValidationTargetError,
    );
  }
  assert.throws(
    () => prepareCredentialValidationRequeue(job, command, { ...capability, protocol: 'openai-compatible' }, registry),
    CredentialValidationTargetError,
  );
  assert.equal(JSON.stringify(job), before);
});

function stableSnapshotFixture(
  schema: 'v1' | 'v2',
  kind: 'chat' | 'messages' = 'chat',
): ApprovedCredentialValidationTarget {
  if (schema === 'v2') return canonicalTargetV2(kind);
  return kind === 'chat'
    ? approvedTarget()
    : approvedTarget({
        productId: 'custom-anthropic',
        endpoint: 'messages',
        protocol: 'anthropic-compatible',
        authProfile: 'anthropic-api-key-2023-06-01',
      });
}

test('both schemas authenticate captured descriptor values, never a Proxy get that changes the wire URL between passes', () => {
  for (const schema of ['v1', 'v2'] as const) {
    for (const kind of ['chat', 'messages'] as const) {
      const reviewed = stableSnapshotFixture(schema, kind);
      let getCalls = 0;
      let urlGets = 0;
      const untrusted = new Proxy(
        { ...reviewed },
        {
          get(target, field, receiver) {
            getCalls += 1;
            if (field === 'baseUrl') {
              urlGets += 1;
              return urlGets === 1 ? 'https://changed.example/v1/' : reviewed.baseUrl;
            }
            return Reflect.get(target, field, receiver);
          },
        },
      );
      const binding = resolveApprovedCredentialValidationTarget(
        compileApprovedCredentialValidationTargets([untrusted]),
        customJob(reviewed),
      );
      const reference = resolveApprovedCredentialValidationTarget(
        compileApprovedCredentialValidationTargets([reviewed]),
        customJob(reviewed),
      );
      assert.ok(binding && reference);
      assert.equal(getCalls, 0, 'authenticated fields are never read through the caller get trap');
      assert.deepEqual(binding, reference);
      assert.equal(binding.evidenceSha256, reviewed.evidenceSha256);
      assert.equal(
        credentialValidationTargetRequestUrl(binding).href,
        credentialValidationTargetRequestUrl(reference).href,
      );
      assert.equal(credentialValidationTargetEvidenceSha256(binding), reviewed.evidenceSha256);
      assert.equal(credentialValidationTargetEvidenceSha256(untrusted), reviewed.evidenceSha256);
      assert.equal(getCalls, 0, 'the public digest API uses the same own-data rule');
      assert.equal(Object.isFrozen(binding), true);
    }
  }
});

test('both schemas reject first observed descriptor URL/digest mismatch instead of re-reading a later reviewed value', () => {
  for (const schema of ['v1', 'v2'] as const) {
    for (const poisoned of ['baseUrl', 'evidenceSha256'] as const) {
      const reviewed = stableSnapshotFixture(schema);
      const reads = new Map<PropertyKey, number>();
      let getCalls = 0;
      const untrusted = new Proxy(
        { ...reviewed },
        {
          get(target, field, receiver) {
            getCalls += 1;
            return Reflect.get(target, field, receiver);
          },
          getOwnPropertyDescriptor(target, field) {
            const count = (reads.get(field) ?? 0) + 1;
            reads.set(field, count);
            const descriptor = Reflect.getOwnPropertyDescriptor(target, field);
            if (descriptor && field === poisoned && count === 1) {
              return { ...descriptor, value: field === 'baseUrl' ? 'https://changed.example/v1/' : 'f'.repeat(64) };
            }
            return descriptor;
          },
        },
      );
      assert.throws(() => compileApprovedCredentialValidationTargets([untrusted]), CredentialValidationTargetError);
      assert.equal(reads.get('baseUrl'), 1);
      assert.equal(reads.get('evidenceSha256'), 1);
      assert.equal(reads.get('schemaVersion'), 1, 'classification descriptor is reused, not recaptured');
      assert.equal(getCalls, 0);
    }
  }
});

test('both schemas keep one reviewed snapshot when caller metadata changes after its fields and digest are captured', () => {
  for (const schema of ['v1', 'v2'] as const) {
    const reviewed = stableSnapshotFixture(schema);
    const mutable = { ...reviewed };
    const reads = new Map<PropertyKey, number>();
    let getCalls = 0;
    const untrusted = new Proxy(mutable, {
      get(target, field, receiver) {
        getCalls += 1;
        return Reflect.get(target, field, receiver);
      },
      getOwnPropertyDescriptor(target, field) {
        reads.set(field, (reads.get(field) ?? 0) + 1);
        const descriptor = Reflect.getOwnPropertyDescriptor(target, field);
        if (field === 'evidenceSha256') {
          Reflect.set(target, 'baseUrl', 'https://changed.example/v1/');
          Reflect.set(target, 'model', 'other/model');
          Reflect.set(target, 'approvalReference', 'another-review');
        }
        return descriptor;
      },
    });
    const binding = resolveApprovedCredentialValidationTarget(
      compileApprovedCredentialValidationTargets([untrusted]),
      customJob(reviewed),
    );
    assert.ok(binding);
    assert.equal(mutable.baseUrl, 'https://changed.example/v1/', 'fixture really changed the caller-owned source');
    assert.equal(mutable.model, 'other/model');
    assert.equal(binding.baseUrl, reviewed.baseUrl);
    assert.equal(binding.model, reviewed.model);
    assert.equal(binding.approvalReference, reviewed.approvalReference);
    assert.equal(binding.evidenceSha256, reviewed.evidenceSha256);
    assert.equal(credentialValidationTargetEvidenceSha256(binding), binding.evidenceSha256);
    assert.equal(credentialValidationTargetRequestUrl(binding).href, 'https://validation.example/v1/chat/completions');
    assert.equal(reads.get('baseUrl'), 1);
    assert.equal(reads.get('model'), 1);
    assert.equal(reads.get('approvalReference'), 1);
    assert.equal(reads.get('evidenceSha256'), 1);
    assert.equal(reads.get('schemaVersion'), 1);
    assert.equal(getCalls, 0);
  }
});

test('both schemas perform only one caller enumeration and deny accessor/trap failures without borrowing later metadata', () => {
  for (const schema of ['v1', 'v2'] as const) {
    const reviewed = stableSnapshotFixture(schema);
    let enumerations = 0;
    let schemaReads = 0;
    const untrusted = new Proxy(
      { ...reviewed },
      {
        ownKeys(target) {
          enumerations += 1;
          if (enumerations > 1) Reflect.set(target, 'baseUrl', 'https://changed.example/v1/');
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, field) {
          if (field === 'schemaVersion') schemaReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, field);
        },
        get() {
          throw new Error('fixture get trap cannot supply authority');
        },
      },
    );
    const binding = resolveApprovedCredentialValidationTarget(
      compileApprovedCredentialValidationTargets([untrusted]),
      customJob(reviewed),
    );
    assert.ok(binding);
    assert.equal(enumerations, 1);
    assert.equal(schemaReads, 1);
    assert.equal(binding.baseUrl, reviewed.baseUrl);
    assert.equal(binding.evidenceSha256, reviewed.evidenceSha256);
    assert.equal(credentialValidationTargetEvidenceSha256(binding), reviewed.evidenceSha256);

    let accessors = 0;
    const accessor = Object.defineProperty({ ...reviewed }, 'baseUrl', {
      enumerable: true,
      get() {
        accessors += 1;
        return reviewed.baseUrl;
      },
    });
    assert.throws(() => compileApprovedCredentialValidationTargets([accessor]), CredentialValidationTargetError);
    assert.equal(accessors, 0);
    for (const failure of ['enumeration', 'descriptor'] as const) {
      const refused = new Proxy(
        { ...reviewed },
        {
          ownKeys(target) {
            if (failure === 'enumeration') throw new Error('fixture enumeration failure');
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, field) {
            if (failure === 'descriptor' && field === 'baseUrl') throw new Error('fixture descriptor failure');
            return Reflect.getOwnPropertyDescriptor(target, field);
          },
        },
      );
      assert.throws(() => compileApprovedCredentialValidationTargets([refused]), CredentialValidationTargetError);
    }
  }
});

test('legacy namespace-shaped and non-enumerable data retain v1 bytes while canonical v2 keeps its stricter field contract', () => {
  const reviewed = approvedTarget();
  const namespaceShaped = { ...reviewed };
  Object.setPrototypeOf(namespaceShaped, null);
  Object.defineProperty(namespaceShaped, Symbol.toStringTag, { value: 'Module' });
  Object.preventExtensions(namespaceShaped);
  const nonEnumerable = Object.defineProperty({ ...reviewed }, 'baseUrl', {
    value: reviewed.baseUrl,
    enumerable: false,
  });
  for (const input of [namespaceShaped, nonEnumerable]) {
    const binding = resolveApprovedCredentialValidationTarget(
      compileApprovedCredentialValidationTargets([input]),
      customJob(reviewed),
    );
    assert.ok(binding);
    assert.deepEqual(binding, reviewed);
    assert.deepEqual(Object.keys(binding), Object.keys(reviewed));
    assert.equal(credentialValidationTargetEvidenceSha256(input), reviewed.evidenceSha256);
    assert.equal(credentialValidationTargetEvidenceSha256(binding), reviewed.evidenceSha256);
    assert.equal(credentialValidationTargetRequestUrl(binding).href, 'https://validation.example/v1/chat/completions');
  }
  const canonical = canonicalTargetV2();
  const canonicalNull = { ...canonical };
  Object.setPrototypeOf(canonicalNull, null);
  const canonicalBinding = resolveApprovedCredentialValidationTarget(
    compileApprovedCredentialValidationTargets([canonicalNull]),
    customJob(canonical),
  );
  assert.ok(canonicalBinding);
  assert.equal(canonicalBinding.evidenceSha256, canonical.evidenceSha256);
  assert.equal(credentialValidationTargetEvidenceSha256(canonicalBinding), canonical.evidenceSha256);
  assert.throws(
    () =>
      compileApprovedCredentialValidationTargets([
        Object.defineProperty({ ...canonical }, 'baseUrl', { value: canonical.baseUrl, enumerable: false }),
      ]),
    CredentialValidationTargetError,
  );
  assert.throws(
    () =>
      compileApprovedCredentialValidationTargets([
        Object.defineProperty({ ...canonical }, Symbol.toStringTag, { value: 'Module' }),
      ]),
    CredentialValidationTargetError,
  );
});
