import assert from 'node:assert/strict';
import test from 'node:test';
import type { Dispatcher } from 'undici';
import {
  FastGatewayExecutor,
  type FastGatewayExecutorOptions,
  type FastReceiptInput,
} from '../../../../src/saas/gateway/fast/executor.js';
import { CachedFastGatewaySnapshots } from '../../../../src/saas/gateway/fast/snapshots.js';
import { fastExecutorFixture } from './executor-fixture.js';

type Boundary = 'compile' | 'reserve' | 'pre-ticket' | 'pre-unseal' | 'unseal' | 'pre-send';
type Change = 'revoke' | 'version' | 'key-expiry' | 'candidate-expiry' | 'price-epoch' | 'outage';

async function dispatchCase(boundary?: Boundary, change?: Change) {
  const { input, snapshot } = fastExecutorFixture('tenant-a', Date.now(), true);
  // A frozen Date is intentionally nonprimitive so that its internal-slot
  // mutation tests the retained full-parse path at actual dispatch fences.
  Object.defineProperty(snapshot.candidates[0].credential.version, 'expiresAt', {
    value:
      change === 'candidate-expiry'
        ? new Date(snapshot.validUntilMs + 1000)
        : new Date(snapshot.validUntilMs + 1000).toISOString(),
  });
  const cache = new CachedFastGatewaySnapshots({ resolve: async () => snapshot });
  const held = await cache.resolve(input);
  assert.ok(held);
  let injected = false;
  const inject = (at: Boundary) => {
    if (boundary !== at) return;
    injected = true;
    const m = input.authenticatedCaller.metadata;
    const a = input.authenticatedCaller.authorization;
    if (change === 'revoke') Object.defineProperty(m, 'revokedAt', { value: new Date().toISOString() });
    if (change === 'version') {
      Object.defineProperty(m, 'authzVersion', { value: 2 });
      Object.defineProperty(a, 'authzVersion', { value: 2 });
    }
    if (change === 'key-expiry') Object.defineProperty(m, 'expiresAt', { value: new Date(1).toISOString() });
    if (change === 'candidate-expiry') (held.candidates[0].credential.version.expiresAt as unknown as Date).setTime(1);
    if (change === 'price-epoch') {
      const price = snapshot.candidates[0].customerPrice;
      assert.ok(price);
      Object.defineProperty(price, 'id', { value: 'new-price-version' });
      cache.invalidate(1n);
    }
    if (change === 'outage') cache.markUnavailable();
  };
  const receipts: FastReceiptInput[] = [];
  let sends = 0;
  let admissions = 0;
  let intents = 0;
  let releases = 0;
  let leaseChecks = 0;
  let ended = false;
  const options: FastGatewayExecutorOptions = {
    snapshots: cache,
    admission: {
      acquire: async () => {
        admissions++;
        return {
          allowed: true,
          lease: {
            fencingToken: 'lease-a',
            renewIntervalMs: 1000,
            assertValid: async () => {
              const at = ['pre-ticket', 'pre-unseal', 'pre-send'] as const;
              inject(at[leaseChecks++]);
              return true;
            },
            renew: async () => {},
            release: async () => {
              releases++;
            },
          },
        };
      },
    },
    journal: {
      reserveIntent: async () => {
        intents++;
        inject('reserve');
        return { kind: 'created', intent: { id: 'intent-a' } };
      },
      appendReceipt: async (receipt) => {
        receipts.push(receipt);
      },
    },
    payload: () => ({
      compile: async (request) => {
        inject('compile');
        return {
          decision: 'allow',
          value: {
            payloadBytes: Buffer.from(JSON.stringify(request.clientRequest)),
            requestFingerprint: 'fingerprint',
            requestFingerprintVersion: 'v1',
            compilerVersion: 'test/v1',
            estimatorVersion: 'bound/v1',
            requestedModel: 'model-a',
            mappedModel: 'model-a',
            resolvedModel: 'model-a',
            modelResolution: {
              requestedModel: 'model-a',
              mappedModel: 'model-a',
              resolvedModel: 'model-a',
              mappingSource: 'none',
              mappingVersion: null,
            },
            providerProtocol: 'openai',
            providerOperation: 'chat.completions',
            usage: {
              inputTotalUpperBound: 80,
              inputUncachedUpperBound: 80,
              cacheReadUpperBound: 80,
              cacheWriteUpperBound: 80,
              cacheWrite5mUpperBound: 80,
              cacheWrite1hUpperBound: 80,
              outputTotalUpperBound: 64,
              reasoningOutputUpperBound: 64,
              feasibleInputBuckets: ['input'],
            },
          },
        };
      },
    }),
    transport: {
      fetch: async () => {
        sends++;
        return new Response(
          JSON.stringify({
            id: 'reply',
            object: 'chat.completion',
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
      resolveDispatchProfile: async () => ({ url: 'https://provider.example/v1/chat/completions' }),
      resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
      createConnector: () => ({ dispatcher: {} as Dispatcher, close: async () => {}, destroy: async () => {} }),
      endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
      timeoutMs: 1000,
    },
    unsealer: {
      withCredential: async (_input, callback) => {
        inject('unseal');
        return callback(Buffer.from('test-only'));
      },
    },
    allocationOwner: 'owner-a',
    timeoutMs: 1000,
  };
  assert.ok(input.clientAddress);
  const clientAddress = input.clientAddress;
  const execute = () =>
    new FastGatewayExecutor(options).execute({
      requestId: 'request-a',
      authenticatedCaller: input.authenticatedCaller,
      path: '/v1/chat/completions',
      publicModel: 'model-a',
      protocol: 'openai',
      body: { model: 'model-a', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64 },
      clientAddress,
      client: {
        signal: new AbortController().signal,
        start() {},
        write() {},
        end() {
          ended = true;
        },
        abort() {},
      },
    });
  if (!boundary) {
    assert.equal(await execute(), true);
    assert.equal(sends, 1);
    assert.equal(leaseChecks, 3);
    assert.equal(ended, true);
    assert.equal(receipts[0].outcome, 'succeeded');
  } else {
    await assert.rejects(execute);
    assert.equal(injected, true, 'the test reached its selected asynchronous boundary');
    assert.equal(sends, 0, 'no HTTP send occurs after authority changed');
    assert.equal(ended, false);
    assert.equal(admissions, boundary === 'compile' ? 0 : 1);
    assert.equal(intents, boundary === 'compile' ? 0 : 1);
    const definitelyUnsent = boundary === 'reserve' || boundary === 'pre-ticket';
    assert.equal(releases, definitelyUnsent ? 1 : 0, 'existing conservative release policy is unchanged');
    if (boundary !== 'compile') {
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].outcome, definitelyUnsent ? 'failed' : 'unknown');
      assert.equal(receipts[0].chargeMinorUnits, definitelyUnsent ? '0' : null);
    }
  }
}

test('cached static parsing retains a successful one-send control through every dispatch fence', async () => {
  await dispatchCase();
});

for (const boundary of ['compile', 'reserve', 'pre-ticket', 'pre-unseal', 'unseal', 'pre-send'] as const) {
  for (const change of ['revoke', 'version', 'key-expiry', 'candidate-expiry', 'price-epoch', 'outage'] as const) {
    test(`cached static parsing cannot bypass ${change} at ${boundary}`, async () => {
      await dispatchCase(boundary, change);
    });
  }
}
