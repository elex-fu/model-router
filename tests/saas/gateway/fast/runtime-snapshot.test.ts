import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelResolutionProvenance } from '../../../../src/saas/gateway/contracts.js';
import {
  createRuntimeFastGatewaySnapshotSource,
  fastGatewayModelCompatibility,
} from '../../../../src/saas/gateway/fast/runtime-snapshot.js';
import { CachedFastGatewaySnapshots } from '../../../../src/saas/gateway/fast/snapshots.js';
import { fastExecutorFixture } from './executor-fixture.js';

test('deployment compatibility/header callbacks run only on cold snapshot, never warm', async () => {
  const f = fastExecutorFixture();
  let sourceReads = 0,
    capabilityReads = 0,
    headerReads = 0;
  const source = createRuntimeFastGatewaySnapshotSource(
    {
      resolve: async () => {
        sourceReads++;
        return f.snapshot;
      },
    },
    {
      modelCompatibility: async () => {
        capabilityReads++;
        return true;
      },
      authenticationHeader: async () => {
        headerReads++;
        return 'authorization';
      },
    },
  );
  const cache = new CachedFastGatewaySnapshots(source);
  const first = await cache.resolve(f.input);
  const second = await cache.resolve(f.input);
  assert.equal(first, second);
  assert.equal(sourceReads, 1);
  assert.equal(capabilityReads, 1);
  assert.equal(headerReads, 1);
  assert.equal(first?.observedAtMs, f.snapshot.observedAtMs);
  assert.equal(first?.validUntilMs, f.snapshot.validUntilMs);
  assert.notEqual(first?.revision, f.snapshot.revision);
  assert.ok(first);
  const candidate = first.candidates[0];
  const modelInput = {
    providerId: 'provider-a',
    productId: 'product-a',
    providerModel: 'model-a',
    providerProtocol: 'openai' as const,
    providerOperation: 'chat.completions' as const,
    modelResolution: createModelResolutionProvenance('model-a', 'model-a'),
  };
  assert.equal(fastGatewayModelCompatibility(candidate, modelInput), true);
  assert.equal(fastGatewayModelCompatibility(candidate, { ...modelInput, providerModel: 'other-model' }), false);
  assert.equal(
    fastGatewayModelCompatibility(
      { ...candidate, authority: { ...candidate.authority, providerId: 'other-provider' } },
      modelInput,
    ),
    false,
  );
});

test('cold runtime policy denial cannot mint cached compatibility', async () => {
  const f = fastExecutorFixture();
  let headerReads = 0;
  const source = createRuntimeFastGatewaySnapshotSource(
    { resolve: async () => f.snapshot },
    {
      modelCompatibility: () => false,
      authenticationHeader: () => {
        headerReads++;
        return 'authorization';
      },
    },
  );
  assert.equal(await source.resolve(f.input), null);
  assert.equal(headerReads, 0);
});

test('unsafe runtime authentication header fails before cache or send', async () => {
  const f = fastExecutorFixture();
  const source = createRuntimeFastGatewaySnapshotSource(
    { resolve: async () => f.snapshot },
    { modelCompatibility: () => true, authenticationHeader: () => 'cookie' },
  );
  await assert.rejects(() => source.resolve(f.input));
});
