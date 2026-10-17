import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowRequestPreparation,
  rejectRequestPreparation,
  type RequestPreparationAuthorityPort,
} from '../../../../src/saas/gateway/request-preparation-service.js';
import {
  applyCnProvidersProtocolRouting,
  createCnProvidersProtocolRoutingAuthority,
} from '../../../../src/server/managed-saas-gateway.js';
import {
  CN_PROVIDER_ENDPOINTS,
  MINIMAX_ENDPOINT,
  MINIMAX_PROVIDER_ID,
  ZHIPU_CODING_ENDPOINT,
  ZHIPU_ENDPOINT,
  ZHIPU_PROVIDER_ID,
} from '../../../../src/saas/gateway/cn-providers/catalog-identity.js';
import type { CnProvidersProtocolRoutingConfig } from '../../../../src/saas/gateway/cn-providers/protocol-rules.js';
import { cnProvidersFixedRequestHeaders } from '../../../../src/saas/gateway/cn-providers/transport-headers.js';

/** The compile-layer route shape the routing helpers rewrite. */
function route(overrides: Partial<Parameters<typeof applyCnProvidersProtocolRouting>[0]> = {}) {
  return {
    clientProtocol: 'anthropic' as const,
    providerProtocol: 'anthropic' as const,
    clientOperation: 'messages',
    providerOperation: 'messages',
    modelResolution: { requestedModel: 'glm-5.3', mappedModel: 'glm-5.3', source: 'alias' as const },
    ...overrides,
  };
}

test('applyCnProvidersProtocolRouting rewrites the provider side per api_protocol', () => {
  // Adaptive (default): the anthropic client keeps the anthropic native.
  const adaptive = applyCnProvidersProtocolRouting(route(), { providerId: ZHIPU_PROVIDER_ID }, undefined);
  assert.equal(adaptive.blocked, false);
  assert.deepEqual(adaptive.route, route(), 'adaptive + anthropic client: provider side unchanged');

  // Pinned chat_completions: the anthropic client bridges onto the openai native.
  const pinned = applyCnProvidersProtocolRouting(
    route(),
    { providerId: ZHIPU_PROVIDER_ID },
    { apiProtocol: { zhipu: 'chat_completions' } },
  );
  assert.deepEqual(pinned.route, {
    ...route(),
    providerProtocol: 'openai',
    providerOperation: 'chat.completions',
  });

  // MiniMax pinned responses from an anthropic client.
  const responses = applyCnProvidersProtocolRouting(
    route(),
    { providerId: MINIMAX_PROVIDER_ID },
    { apiProtocol: { minimax: 'responses' } },
  );
  assert.deepEqual(responses.route, { ...route(), providerProtocol: 'responses', providerOperation: 'responses' });

  // A gemini client under adaptive: blocked (fail closed in the compile layer).
  const blocked = applyCnProvidersProtocolRouting(
    route({ clientProtocol: 'gemini', clientOperation: 'generateContent' }),
    { providerId: ZHIPU_PROVIDER_ID },
    undefined,
  );
  assert.equal(blocked.blocked, true);

  // Non-CN provider: untouched by reference.
  const foreign = route();
  const untouched = applyCnProvidersProtocolRouting(foreign, { providerId: 'opencode-go' }, undefined);
  assert.equal(untouched.blocked, false);
  assert.equal(untouched.route, foreign);
});

test('the authority decorator signs the resolved native protocol into the route', async () => {
  function fixtureAuthority(providerId: string, providerProtocol: string): RequestPreparationAuthorityPort {
    return {
      // The minimal decision surface the decorator reads: the candidate's
      // provider id and the route's protocol pair.
      resolve: async () =>
        allowRequestPreparation({
          route: { protocol: 'anthropic', providerProtocol, providerOperation: 'messages' },
          candidate: { providerId, resolvedModel: 'glm-5.3' },
        }),
    } as unknown as RequestPreparationAuthorityPort;
  }

  // A zhipu account whose route already says anthropic under adaptive: the
  // decision object passes through untouched.
  const sameNative = createCnProvidersProtocolRoutingAuthority(
    fixtureAuthority(ZHIPU_PROVIDER_ID, 'anthropic'),
    undefined,
  );
  const passthrough = await sameNative.resolve({} as never);
  assert.equal(passthrough.decision, 'allow');

  // An openai-native route under adaptive + anthropic client: rewritten.
  const rewrite = createCnProvidersProtocolRoutingAuthority(
    fixtureAuthority(ZHIPU_PROVIDER_ID, 'openai'),
    undefined,
  );
  const rewritten = await rewrite.resolve({} as never);
  assert.equal(rewritten.decision, 'allow');
  if (rewritten.decision === 'allow') {
    assert.equal(rewritten.value.route.providerProtocol, 'anthropic');
    assert.equal(rewritten.value.route.providerOperation, 'messages');
  }

  // Pinned minimax responses: rewritten even from an anthropic client.
  const pinned = createCnProvidersProtocolRoutingAuthority(fixtureAuthority(MINIMAX_PROVIDER_ID, 'anthropic'), {
    apiProtocol: { minimax: 'responses' },
  } satisfies CnProvidersProtocolRoutingConfig);
  const pinnedDecision = await pinned.resolve({} as never);
  assert.equal(pinnedDecision.decision, 'allow');
  if (pinnedDecision.decision === 'allow') {
    assert.equal(pinnedDecision.value.route.providerProtocol, 'responses');
    assert.equal(pinnedDecision.value.route.providerOperation, 'responses');
  }

  // Non-CN providers pass through unchanged.
  const foreign = createCnProvidersProtocolRoutingAuthority(
    fixtureAuthority('opencode-go', 'openai'),
    { apiProtocol: { zhipu: 'responses' } },
  );
  const foreignDecision = await foreign.resolve({} as never);
  assert.equal(foreignDecision.decision, 'allow');
  if (foreignDecision.decision === 'allow') {
    assert.equal(foreignDecision.value.route.providerProtocol, 'openai');
  }

  // Rejections pass through unchanged.
  const rejecting = createCnProvidersProtocolRoutingAuthority(
    { resolve: async () => rejectRequestPreparation('account_denied', 'fixture refusal') },
    undefined,
  );
  const rejected = await rejecting.resolve({} as never);
  assert.equal(rejected.decision, 'reject');
});

test('fixed request headers add anthropic-version only on the anthropic native of CN scopes', () => {
  for (const endpoint of CN_PROVIDER_ENDPOINTS) {
    assert.deepEqual(cnProvidersFixedRequestHeaders({ endpoint, providerProtocol: 'anthropic' }), {
      'anthropic-version': '2023-06-01',
    });
    assert.equal(cnProvidersFixedRequestHeaders({ endpoint, providerProtocol: 'openai' }), null);
    assert.equal(cnProvidersFixedRequestHeaders({ endpoint, providerProtocol: 'responses' }), null);
  }
  assert.equal(cnProvidersFixedRequestHeaders({ endpoint: 'opencode-go-zen', providerProtocol: 'anthropic' }), null);
  assert.equal(cnProvidersFixedRequestHeaders({ endpoint: undefined, providerProtocol: 'anthropic' }), null);

  // The three endpoint scopes are exactly the dispatch registration set.
  assert.deepEqual(CN_PROVIDER_ENDPOINTS, [ZHIPU_ENDPOINT, ZHIPU_CODING_ENDPOINT, MINIMAX_ENDPOINT]);
});
