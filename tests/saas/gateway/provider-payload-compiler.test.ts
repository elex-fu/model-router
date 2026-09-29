import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ModelResolutionProvenance } from '../../../src/saas/gateway/contracts.js';
import {
  createProviderPayloadCompiler,
  type ProviderCompiledPayload,
  type ProviderPayloadCompilerInput,
  type ProviderPayloadCompilerOptions,
  type ProviderUsageUpperBoundEstimator,
} from '../../../src/saas/gateway/provider-payload-compiler.js';
import type { RequestPreparationAuthority } from '../../../src/saas/gateway/request-preparation-service.js';

const USAGE = Object.freeze({
  inputTotalUpperBound: 12,
  inputUncachedUpperBound: 12,
  cacheReadUpperBound: 0,
  cacheWriteUpperBound: 0,
  cacheWrite5mUpperBound: 0,
  cacheWrite1hUpperBound: 0,
  outputTotalUpperBound: 8,
  reasoningOutputUpperBound: 0,
  feasibleInputBuckets: ['input'],
});

const RESOLUTION: ModelResolutionProvenance = Object.freeze({
  requestedModel: 'public-alias',
  mappedModel: 'catalog-model',
  resolvedModel: 'provider-model',
  mappingSource: 'alias',
  mappingVersion: 3,
});

function authority(
  overrides: {
    readonly clientProtocol?: 'anthropic' | 'openai' | 'gemini' | 'responses';
    readonly publicModel?: string;
    readonly resolvedModel?: string;
  } = {},
): RequestPreparationAuthority {
  return {
    route: {
      tenantId: 'tenant-a',
      projectId: 'project-a',
      publicModel: overrides.publicModel ?? 'public-alias',
      publicModelId: 'public-model-a',
      publicModelVersion: 1,
      routeConfigId: 'route-a',
      routeConfigVersion: 1,
      protocol: overrides.clientProtocol ?? 'openai',
      targetMode: 'tenant_account',
      upstreamId: 'upstream-a',
      endpoint: 'server-owned-route',
    },
    candidate: {
      tenantId: 'tenant-a',
      projectId: 'project-a',
      proxyKeyId: 'key-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'byok',
      accountOwnerKind: 'tenant',
      upstreamId: 'upstream-a',
      accountId: 'account-a',
      credentialId: 'credential-a',
      credentialVersion: 1,
      credentialAuthzVersion: 1,
      accountAuthzVersion: 1,
      dispatchProfileId: 'dispatch-a',
      supplyProfileAuthzVersion: 1,
      resolvedModel: overrides.resolvedModel ?? 'provider-model',
      protocol: overrides.clientProtocol ?? 'openai',
      endpoint: 'server-owned-route',
      supplierCostVersion: null,
      profileAccountAuthzVersion: 1,
      providerId: 'provider-a',
      productId: 'product-a',
    },
    poolMemberAuthzVersion: null,
    credentialRef: 'credential-a',
    configVersion: 1,
    commercial: {
      customerMeteringPolicyId: 'customer-policy-a',
      customerMeteringPolicyVersion: 1,
      providerMeteringPolicyId: 'provider-policy-a',
      providerMeteringPolicyVersion: 1,
      contractAttestationId: 'attestation-a',
      customerPriceVersion: null,
      supplierCostVersion: null,
    },
  };
}

function input(
  clientRequest: unknown,
  overrides: Partial<ProviderPayloadCompilerInput> = {},
): ProviderPayloadCompilerInput {
  return {
    caller: {} as ProviderPayloadCompilerInput['caller'],
    entitlement: {} as ProviderPayloadCompilerInput['entitlement'],
    authority: authority(),
    clientRequest,
    ...overrides,
  };
}

function estimator(implementation?: ProviderUsageUpperBoundEstimator['estimate']): ProviderUsageUpperBoundEstimator {
  return {
    version: 'tokens-v1',
    estimate: implementation ?? (() => USAGE),
  };
}

function options(overrides: Partial<ProviderPayloadCompilerOptions> = {}): ProviderPayloadCompilerOptions {
  return {
    providerProtocol: 'openai',
    operation: 'chat/completions',
    estimator: estimator(),
    modelResolution: RESOLUTION,
    modelCompatibility: () => true,
    ...overrides,
  };
}

function allowed(
  value: Awaited<ReturnType<ReturnType<typeof createProviderPayloadCompiler>['compile']>>,
): ProviderCompiledPayload {
  assert.equal(value.decision, 'allow');
  if (value.decision !== 'allow') throw new Error('expected compiler allow decision');
  return value.value;
}

test('produces stable bytes and a SHA-256 fingerprint for identical input', async () => {
  const request = {
    messages: [{ role: 'user', content: 'hello' }],
    model: 'public-alias',
  };
  const compiler = createProviderPayloadCompiler(options());
  const first = allowed(await compiler.compile(input(request)));
  const second = allowed(
    await compiler.compile(input({ model: 'public-alias', messages: [{ role: 'user', content: 'hello' }] })),
  );

  assert.deepEqual([...first.payloadBytes], [...second.payloadBytes]);
  assert.equal(first.requestFingerprint, second.requestFingerprint);
  assert.equal(first.requestFingerprintVersion, 'provider-payload-compiler/v1');
  assert.equal(first.requestFingerprint, createHash('sha256').update(first.payloadBytes).digest('hex'));
  assert.equal(
    new TextDecoder().decode(first.payloadBytes),
    '{"messages":[{"content":"hello","role":"user"}],"model":"provider-model"}',
  );
});

test('retains requested, mapped, and resolved model provenance', async () => {
  const result = allowed(
    await createProviderPayloadCompiler(options()).compile(
      input({ model: 'public-alias', messages: [{ role: 'user', content: 'hello' }] }),
    ),
  );

  assert.deepEqual(result.modelResolution, RESOLUTION);
  assert.equal(JSON.parse(new TextDecoder().decode(result.payloadBytes)).model, 'provider-model');
});

test('uses the explicitly supported OpenAI to Anthropic request bridge', async () => {
  const result = allowed(
    await createProviderPayloadCompiler(options({ providerProtocol: 'anthropic', operation: 'messages' })).compile(
      input(
        {
          model: 'public-alias',
          messages: [{ role: 'user', content: 'hello' }],
        },
        { authority: authority({ clientProtocol: 'openai' }) },
      ),
    ),
  );
  const payload = JSON.parse(new TextDecoder().decode(result.payloadBytes)) as Record<string, unknown>;

  assert.equal(payload.model, 'provider-model');
  assert.equal(payload.max_tokens, 1024);
  assert.deepEqual(payload.messages, [{ role: 'user', content: 'hello' }]);
  assert.equal(result.providerProtocol, 'anthropic');
});

test('uses the explicitly supported Anthropic to Gemini request bridge', async () => {
  const result = allowed(
    await createProviderPayloadCompiler(options({ providerProtocol: 'gemini', operation: 'generateContent' })).compile(
      input(
        {
          model: 'public-alias',
          system: 'Be concise',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 8,
        },
        { authority: authority({ clientProtocol: 'anthropic' }) },
      ),
    ),
  );
  const payload = JSON.parse(new TextDecoder().decode(result.payloadBytes)) as {
    readonly contents: readonly [{ readonly role: string; readonly parts: readonly [{ readonly text: string }] }];
    readonly generationConfig: { readonly maxOutputTokens: number };
  };

  assert.equal(payload.contents[0].role, 'user');
  assert.equal(payload.contents[0].parts[0].text, 'hello');
  assert.equal(payload.generationConfig.maxOutputTokens, 8);
  assert.equal(result.providerProtocol, 'gemini');
});

test('uses the explicitly supported Anthropic to Responses request bridge', async () => {
  const result = allowed(
    await createProviderPayloadCompiler(options({ providerProtocol: 'responses', operation: 'responses' })).compile(
      input(
        {
          model: 'public-alias',
          system: 'Be concise',
          messages: [{ role: 'user', content: 'hello' }],
        },
        { authority: authority({ clientProtocol: 'anthropic' }) },
      ),
    ),
  );
  const payload = JSON.parse(new TextDecoder().decode(result.payloadBytes)) as {
    readonly model: string;
    readonly instructions: string;
    readonly input: readonly [{ readonly content: readonly [{ readonly text: string }] }];
  };

  assert.equal(payload.model, 'provider-model');
  assert.equal(payload.instructions, 'Be concise');
  assert.equal(payload.input[0].content[0].text, 'hello');
  assert.equal(result.providerProtocol, 'responses');
});

test('rejects unsupported operations and unsupported gemini to anthropic conversion', async () => {
  const unsupportedOperation = await createProviderPayloadCompiler(
    options({ providerProtocol: 'responses', operation: 'responses.compact' }),
  ).compile(input({ model: 'public-alias', messages: [{ role: 'user', content: 'hello' }] }));
  assert.equal(unsupportedOperation.decision, 'block');
  if (unsupportedOperation.decision === 'block') assert.equal(unsupportedOperation.code, 'capability_unavailable');

  const unsupportedPair = await createProviderPayloadCompiler(
    options({ providerProtocol: 'anthropic', operation: 'messages' }),
  ).compile(
    input(
      { model: 'public-alias', contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
      {
        authority: authority({ clientProtocol: 'gemini' }),
        clientOperation: 'generateContent',
      },
    ),
  );
  assert.equal(unsupportedPair.decision, 'block');
  if (unsupportedPair.decision === 'block') assert.equal(unsupportedPair.code, 'capability_unavailable');
});

test('fails closed when the versioned estimator is absent or returns invalid bounds', async () => {
  const missingEstimator = await createProviderPayloadCompiler(
    options({ estimator: undefined, usageEstimator: undefined }),
  ).compile(input({ model: 'public-alias', messages: [{ role: 'user', content: 'hello' }] }));
  assert.equal(missingEstimator.decision, 'block');
  if (missingEstimator.decision === 'block') assert.equal(missingEstimator.code, 'payload_bounds_unavailable');

  const invalidBounds = await createProviderPayloadCompiler(
    options({
      estimator: estimator(() => ({ ...USAGE, inputTotalUpperBound: 1, inputUncachedUpperBound: 2 })),
    }),
  ).compile(input({ model: 'public-alias', messages: [{ role: 'user', content: 'hello' }] }));
  assert.equal(invalidBounds.decision, 'block');
  if (invalidBounds.decision === 'block') assert.equal(invalidBounds.code, 'payload_bounds_unavailable');
});

test('requires explicit provider/model compatibility and can use authority protocol defaults', async () => {
  const missingCompatibility = await createProviderPayloadCompiler(options({ modelCompatibility: undefined })).compile(
    input({ model: 'public-alias', messages: [{ role: 'user', content: 'hello' }] }),
  );
  assert.equal(missingCompatibility.decision, 'block');
  if (missingCompatibility.decision === 'block') assert.equal(missingCompatibility.code, 'capability_unavailable');

  const sameProtocol = await createProviderPayloadCompiler(
    options({ providerProtocol: undefined, operation: undefined }),
  ).compile(input({ model: 'public-alias', messages: [{ role: 'user', content: 'hello' }] }));
  assert.equal(sameProtocol.decision, 'allow');
});

test('fails closed for provider/model incompatibility and oversized payloads', async () => {
  const incompatible = await createProviderPayloadCompiler(options({ modelCompatibility: async () => false })).compile(
    input({ model: 'public-alias', messages: [{ role: 'user', content: 'hello' }] }),
  );
  assert.equal(incompatible.decision, 'block');
  if (incompatible.decision === 'block') assert.equal(incompatible.code, 'capability_unavailable');

  const oversized = await createProviderPayloadCompiler(options({ maxPayloadBytes: 32 })).compile(
    input({ model: 'public-alias', messages: [{ role: 'user', content: 'this request is intentionally too large' }] }),
  );
  assert.equal(oversized.decision, 'block');
  if (oversized.decision === 'block') assert.equal(oversized.code, 'payload_invalid');
});

test('does not expose credentials or estimator error details in failure messages', async () => {
  const secret = 'sk-live-provider-secret';
  const estimatorFailure = await createProviderPayloadCompiler(
    options({
      estimator: estimator(() => {
        throw new Error(secret);
      }),
    }),
  ).compile(input({ model: 'public-alias', messages: [{ role: 'user', content: 'hello' }] }));
  assert.equal(estimatorFailure.decision, 'block');
  assert.equal(estimatorFailure.decision === 'block' && estimatorFailure.message.includes(secret), false);

  const credentialBody = await createProviderPayloadCompiler(options()).compile(
    input({
      model: 'public-alias',
      authorization: secret,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  );
  assert.equal(credentialBody.decision, 'block');
  assert.equal(credentialBody.decision === 'block' && credentialBody.message.includes(secret), false);
});
