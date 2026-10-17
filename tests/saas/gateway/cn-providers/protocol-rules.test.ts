import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cnProviderOperationForProtocol,
  cnProviderRouteOverride,
  cnProviderSupportsNativeResponses,
  normalizeCnProviderApiProtocol,
  resolveCnNativeProtocol,
  resolveCnProviderApiProtocol,
} from '../../../../src/saas/gateway/cn-providers/protocol-rules.js';
import { MINIMAX_PROVIDER_ID, ZHIPU_PROVIDER_ID } from '../../../../src/saas/gateway/cn-providers/catalog-identity.js';

test('resolveCnNativeProtocol routes the full provider × api_protocol × client matrix', () => {
  const cases: readonly {
    readonly name: string;
    readonly providerId: string;
    readonly apiProtocol: Parameters<typeof resolveCnNativeProtocol>[0]['apiProtocol'];
    readonly clientProtocol: Parameters<typeof resolveCnNativeProtocol>[0]['clientProtocol'];
    readonly expected: string | null;
  }[] = [
    // Pinned chat_completions: every client protocol lands on the openai native.
    { name: 'zhipu cc + anthropic client', providerId: ZHIPU_PROVIDER_ID, apiProtocol: 'chat_completions', clientProtocol: 'anthropic', expected: 'openai' },
    { name: 'zhipu cc + openai client', providerId: ZHIPU_PROVIDER_ID, apiProtocol: 'chat_completions', clientProtocol: 'openai', expected: 'openai' },
    { name: 'zhipu cc + responses client', providerId: ZHIPU_PROVIDER_ID, apiProtocol: 'chat_completions', clientProtocol: 'responses', expected: 'openai' },
    // Pinned anthropic.
    { name: 'minimax anthropic + openai client', providerId: MINIMAX_PROVIDER_ID, apiProtocol: 'anthropic', clientProtocol: 'openai', expected: 'anthropic' },
    { name: 'minimax anthropic + anthropic client', providerId: MINIMAX_PROVIDER_ID, apiProtocol: 'anthropic', clientProtocol: 'anthropic', expected: 'anthropic' },
    // Pinned responses: minimax native, zhipu has none (falls back per the
    // sub2api GetAPIProtocol zhipu matrix row).
    { name: 'minimax responses pin', providerId: MINIMAX_PROVIDER_ID, apiProtocol: 'responses', clientProtocol: 'openai', expected: 'responses' },
    { name: 'zhipu responses pin falls back to adaptive', providerId: ZHIPU_PROVIDER_ID, apiProtocol: 'responses', clientProtocol: 'openai', expected: 'openai' },
    { name: 'zhipu responses pin + anthropic client', providerId: ZHIPU_PROVIDER_ID, apiProtocol: 'responses', clientProtocol: 'anthropic', expected: 'anthropic' },
    // Adaptive: the native follows the inbound client protocol.
    { name: 'zhipu adaptive + anthropic client → anthropic native', providerId: ZHIPU_PROVIDER_ID, apiProtocol: 'adaptive', clientProtocol: 'anthropic', expected: 'anthropic' },
    { name: 'zhipu adaptive + openai client → chat native', providerId: ZHIPU_PROVIDER_ID, apiProtocol: 'adaptive', clientProtocol: 'openai', expected: 'openai' },
    { name: 'zhipu adaptive + responses client → bridges to chat', providerId: ZHIPU_PROVIDER_ID, apiProtocol: 'adaptive', clientProtocol: 'responses', expected: 'openai' },
    { name: 'minimax adaptive + responses client → native responses', providerId: MINIMAX_PROVIDER_ID, apiProtocol: 'adaptive', clientProtocol: 'responses', expected: 'responses' },
    { name: 'minimax adaptive + anthropic client → anthropic native', providerId: MINIMAX_PROVIDER_ID, apiProtocol: 'adaptive', clientProtocol: 'anthropic', expected: 'anthropic' },
    // gemini clients have no servable ADAPTIVE native (fail closed). A
    // pinned native still resolves (the compile layer's bridge gate — no
    // gemini→openai pair — is the fail-closed point for pinned routes).
    { name: 'zhipu adaptive + gemini client → blocked', providerId: ZHIPU_PROVIDER_ID, apiProtocol: 'adaptive', clientProtocol: 'gemini', expected: null },
    { name: 'minimax adaptive + gemini client → blocked', providerId: MINIMAX_PROVIDER_ID, apiProtocol: 'adaptive', clientProtocol: 'gemini', expected: null },
    { name: 'minimax cc + gemini client → openai native (compiler gate blocks)', providerId: MINIMAX_PROVIDER_ID, apiProtocol: 'chat_completions', clientProtocol: 'gemini', expected: 'openai' },
  ];
  for (const { name, providerId, apiProtocol, clientProtocol, expected } of cases) {
    assert.equal(
      resolveCnNativeProtocol({ providerId, apiProtocol, clientProtocol }),
      expected,
      name,
    );
  }
});

test('api_protocol normalization applies the per-provider matrix leniently', () => {
  assert.equal(cnProviderSupportsNativeResponses(MINIMAX_PROVIDER_ID), true);
  assert.equal(cnProviderSupportsNativeResponses(ZHIPU_PROVIDER_ID), false);
  // Unknown/missing values resolve adaptive; 'responses' downgrades for zhipu.
  assert.equal(normalizeCnProviderApiProtocol(ZHIPU_PROVIDER_ID, undefined), 'adaptive');
  assert.equal(normalizeCnProviderApiProtocol(ZHIPU_PROVIDER_ID, 'nonsense'), 'adaptive');
  assert.equal(normalizeCnProviderApiProtocol(ZHIPU_PROVIDER_ID, 'responses'), 'adaptive');
  assert.equal(normalizeCnProviderApiProtocol(MINIMAX_PROVIDER_ID, 'responses'), 'responses');
  assert.equal(normalizeCnProviderApiProtocol(MINIMAX_PROVIDER_ID, 'anthropic'), 'anthropic');
});

test('cnProviderRouteOverride distinguishes pass-through, override, and blocked', () => {
  // Non-CN provider: pass-through sentinel (null).
  assert.equal(
    cnProviderRouteOverride({ providerId: 'opencode-go', apiProtocol: 'adaptive', clientProtocol: 'openai' }),
    null,
  );
  // Blocked (gemini client).
  assert.deepEqual(
    cnProviderRouteOverride({ providerId: ZHIPU_PROVIDER_ID, apiProtocol: 'adaptive', clientProtocol: 'gemini' }),
    { blocked: true },
  );
  // Override carries the canonical operation mapping.
  assert.deepEqual(
    cnProviderRouteOverride({ providerId: MINIMAX_PROVIDER_ID, apiProtocol: 'adaptive', clientProtocol: 'responses' }),
    { providerProtocol: 'responses', providerOperation: 'responses' },
  );
  assert.deepEqual(
    cnProviderRouteOverride({ providerId: ZHIPU_PROVIDER_ID, apiProtocol: 'adaptive', clientProtocol: 'anthropic' }),
    { providerProtocol: 'anthropic', providerOperation: 'messages' },
  );
  assert.deepEqual(
    cnProviderRouteOverride({ providerId: MINIMAX_PROVIDER_ID, apiProtocol: 'chat_completions', clientProtocol: 'anthropic' }),
    { providerProtocol: 'openai', providerOperation: 'chat.completions' },
  );
});

test('cnProviderOperationForProtocol maps to the compiler vocabulary', () => {
  assert.equal(cnProviderOperationForProtocol('openai'), 'chat.completions');
  assert.equal(cnProviderOperationForProtocol('anthropic'), 'messages');
  assert.equal(cnProviderOperationForProtocol('responses'), 'responses');
});

test('resolveCnProviderApiProtocol applies explicit map → config → adaptive default precedence', () => {
  // Default: adaptive.
  assert.equal(resolveCnProviderApiProtocol(undefined, ZHIPU_PROVIDER_ID), 'adaptive');
  assert.equal(resolveCnProviderApiProtocol({}, ZHIPU_PROVIDER_ID), 'adaptive');
  // Explicit map wins.
  assert.equal(
    resolveCnProviderApiProtocol({ apiProtocol: { zhipu: 'anthropic' } }, ZHIPU_PROVIDER_ID),
    'anthropic',
  );
  // Unknown provider key falls through.
  assert.equal(
    resolveCnProviderApiProtocol({ apiProtocol: { zhipu: 'anthropic' } }, MINIMAX_PROVIDER_ID),
    'adaptive',
  );
  // Lenient config loader: raw string, wrapper record, per-provider map — and
  // the zhipu 'responses' downgrade applies.
  assert.equal(resolveCnProviderApiProtocol({ config: 'anthropic' }, ZHIPU_PROVIDER_ID), 'anthropic');
  assert.equal(
    resolveCnProviderApiProtocol({ config: { api_protocol: 'chat_completions' } }, MINIMAX_PROVIDER_ID),
    'chat_completions',
  );
  assert.equal(
    resolveCnProviderApiProtocol({ config: { zhipu: 'responses', minimax: 'responses' } }, ZHIPU_PROVIDER_ID),
    'adaptive',
  );
  assert.equal(
    resolveCnProviderApiProtocol({ config: { zhipu: 'responses', minimax: 'responses' } }, MINIMAX_PROVIDER_ID),
    'responses',
  );
  // Explicit map beats config.
  assert.equal(
    resolveCnProviderApiProtocol(
      { apiProtocol: { zhipu: 'anthropic' }, config: { api_protocol: 'chat_completions' } },
      ZHIPU_PROVIDER_ID,
    ),
    'anthropic',
  );
  // Malformed config falls back to adaptive.
  assert.equal(resolveCnProviderApiProtocol({ config: { api_protocol: 42 } }, ZHIPU_PROVIDER_ID), 'adaptive');
  assert.equal(resolveCnProviderApiProtocol({ config: ['nope'] }, ZHIPU_PROVIDER_ID), 'adaptive');
});
