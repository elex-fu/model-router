import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMPOSITE_TARGET_PLATFORMS,
  type CompositeModelRoute,
  compositeRouteEndpointFromProtocol,
  compositeRouteModelResolutionSource,
  detectCompositeModelPlatform,
  isConcreteCompositeTargetPlatform,
  matchCompositeRoute,
  normalizeCompositeRouteEndpoint,
  resolveCompositeRoute,
} from '../../../src/saas/gateway/composite-route-resolver.js';

/**
 * Batch 4 §4.4 (task #18): the pure three-level composite resolver — the
 * five-key route sort, the account-ownership semantics, the built-in prefix
 * detector, and the two fail-closed paths (ambiguous ownership and unknown
 * models). Sub2api reference: composite_route_resolver.go +
 * composite_platform.go.
 */

const PLATFORMS = Object.fromEntries(COMPOSITE_TARGET_PLATFORMS.map((id) => [id, id]));
const ANTHROPIC = PLATFORMS['anthropic-claude'];
const OPENAI = PLATFORMS['openai-codex'];
const GEMINI = PLATFORMS['google-gemini'];
const GROK = PLATFORMS['xai-grok'];
const ZHIPU = PLATFORMS.zhipu;
const MINIMAX = PLATFORMS.minimax;
const DEEPSEEK = PLATFORMS.deepseek;
const KIMI = PLATFORMS.kimi;

let nextId = 1;

function route(overrides: Partial<CompositeModelRoute> = {}): CompositeModelRoute {
  return {
    id: String(nextId++),
    groupId: 'group-a',
    publicModel: 'public-model',
    matchType: 'exact',
    targetPlatform: ANTHROPIC,
    upstreamModel: '',
    endpoint: 'any',
    priority: 100,
    enabled: true,
    notes: '',
    ...overrides,
  };
}

test('the detector maps every platform family and fails closed on unknown names', () => {
  const cases: readonly [string, string | null][] = [
    ['claude-sonnet-4-6', ANTHROPIC],
    ['anthropic.claude-opus-4', ANTHROPIC],
    ['anthropic/claude-3-7-sonnet', ANTHROPIC],
    ['claude/claude-3', ANTHROPIC],
    ['gpt-5', OPENAI],
    ['chatgpt-4o-latest', OPENAI],
    ['codex-mini-latest', OPENAI],
    ['o1', OPENAI],
    ['o3-mini', OPENAI],
    ['o4', OPENAI],
    ['o5-pro', OPENAI],
    ['text-embedding-3-large', OPENAI],
    ['omni-moderation-latest', OPENAI],
    ['dall-e-3', OPENAI],
    ['gpt-image-1', OPENAI],
    ['tts-1-hd', OPENAI],
    ['whisper-1', OPENAI],
    ['openai/gpt-5.1', OPENAI],
    ['chatgpt/gpt-5', OPENAI],
    ['gemini-2.5-pro', GEMINI],
    ['learnlm-1.5', GEMINI],
    ['google/gemini-2.5-flash', GEMINI],
    ['gemini/gemini-exp', GEMINI],
    ['grok', GROK],
    ['grok-4.3', GROK],
    ['xai/grok-code', GROK],
    ['glm-4.6', ZHIPU],
    ['zhipu/glm-4.5', ZHIPU],
    ['bigmodel/glm-4', ZHIPU],
    ['minimax-m2', MINIMAX],
    ['abab5.5-chat', MINIMAX],
    ['abab6.5s-chat', MINIMAX],
    ['abab7-chat', MINIMAX],
    ['minimax/abab6', MINIMAX],
    ['deepseek-v4', DEEPSEEK],
    ['deepseek/deepseek-r2', DEEPSEEK],
    ['kimi-k2', KIMI],
    ['moonshot-v1-128k', KIMI],
    ['k3', KIMI],
    ['k3-256k', KIMI],
    ['models/gpt-5', OPENAI],
    // Unknown names never guess a platform.
    ['', null],
    ['my-private-model', null],
    ['o', null],
    ['olmo-3', null],
    ['grokk', null],
    ['claude', null],
  ];
  for (const [model, expected] of cases) {
    assert.equal(
      detectCompositeModelPlatform(model),
      expected,
      `detect(${JSON.stringify(model)}) expected ${String(expected)}`,
    );
  }
});

test('every composite target platform is a concrete vocabulary member', () => {
  for (const platform of [ANTHROPIC, OPENAI, GEMINI, GROK, ZHIPU, MINIMAX, DEEPSEEK, KIMI]) {
    assert.equal(isConcreteCompositeTargetPlatform(platform), true);
  }
  assert.equal(isConcreteCompositeTargetPlatform('not-a-platform'), false);
  assert.equal(isConcreteCompositeTargetPlatform(''), false);
});

test('the client protocol maps onto the endpoint family', () => {
  assert.equal(compositeRouteEndpointFromProtocol('anthropic'), 'messages');
  assert.equal(compositeRouteEndpointFromProtocol('responses'), 'responses');
  assert.equal(compositeRouteEndpointFromProtocol('openai'), 'chat_completions');
  assert.equal(compositeRouteEndpointFromProtocol('gemini'), 'gemini');
});

test('endpoint spelling normalizes with unknown values folding to any', () => {
  assert.equal(normalizeCompositeRouteEndpoint('MESSAGES'), 'messages');
  assert.equal(normalizeCompositeRouteEndpoint(' chat_completions '), 'chat_completions');
  assert.equal(normalizeCompositeRouteEndpoint(''), 'any');
  assert.equal(normalizeCompositeRouteEndpoint('bogus'), 'any');
});

test('the five-key sort picks the winner at every discrimination level', () => {
  // Key 1: exact (strength 2) beats prefix (strength 1) regardless of the
  // other keys.
  assert.equal(
    matchCompositeRoute(
      [
        route({ id: '1', publicModel: 'deep', matchType: 'prefix', priority: 0 }),
        route({ id: '2', publicModel: 'deepseek', matchType: 'exact', priority: 1000 }),
      ],
      'deepseek',
      'any',
    )?.id,
    '2',
  );

  // Key 2 (within exact): an endpoint-specific route beats `any`.
  assert.equal(
    matchCompositeRoute(
      [
        route({ id: '1', publicModel: 'model-a', endpoint: 'any', priority: 0 }),
        route({ id: '2', publicModel: 'model-a', endpoint: 'messages', priority: 1000 }),
      ],
      'model-a',
      'messages',
    )?.id,
    '2',
  );
  // ...but an `any` route still matches an endpoint the registry does not pin.
  assert.equal(
    matchCompositeRoute([route({ id: '1', publicModel: 'model-a', endpoint: 'messages' })], 'model-a', 'responses')?.id,
    undefined,
  );

  // Key 3 (within prefix + same endpoint weight): the longer pattern wins.
  assert.equal(
    matchCompositeRoute(
      [
        route({ id: '1', publicModel: 'deepseek', matchType: 'prefix', priority: 0 }),
        route({ id: '2', publicModel: 'deepseek-v4', matchType: 'prefix', priority: 1000 }),
      ],
      'deepseek-v4-pro',
      'any',
    )?.id,
    '2',
  );

  // Key 4: a lower priority value wins on identical specificity.
  assert.equal(
    matchCompositeRoute(
      [
        route({ id: '1', publicModel: 'model-a', priority: 50 }),
        route({ id: '2', publicModel: 'model-a', priority: 10 }),
      ],
      'model-a',
      'any',
    )?.id,
    '2',
  );

  // Key 5: the lower route id is the deterministic final tie-break.
  assert.equal(
    matchCompositeRoute(
      [
        route({ id: '90', publicModel: 'model-a', priority: 10 }),
        route({ id: '7', publicModel: 'model-a', priority: 10 }),
      ],
      'model-a',
      'any',
    )?.id,
    '7',
  );
  // ...including bigserial ids compared numerically, never lexically.
  assert.equal(
    matchCompositeRoute(
      [
        route({ id: '10', publicModel: 'model-a', priority: 10 }),
        route({ id: '9', publicModel: 'model-a', priority: 10 }),
      ],
      'model-a',
      'any',
    )?.id,
    '9',
  );

  // Composite key order: endpoint specificity beats a longer prefix, and
  // exact beats both.
  assert.equal(
    matchCompositeRoute(
      [
        route({ id: '1', publicModel: 'deepseek-v4-pro', matchType: 'prefix', endpoint: 'any' }),
        route({ id: '2', publicModel: 'deepseek', matchType: 'prefix', endpoint: 'responses' }),
      ],
      'deepseek-v4-pro',
      'responses',
    )?.id,
    '2',
  );
  assert.equal(
    matchCompositeRoute(
      [
        route({ id: '1', publicModel: 'deepseek-v4-pro', matchType: 'prefix', endpoint: 'responses' }),
        route({ id: '2', publicModel: 'deepseek-v4-pro', matchType: 'exact', endpoint: 'any' }),
      ],
      'deepseek-v4-pro',
      'responses',
    )?.id,
    '2',
  );

  // No matching route at all.
  assert.equal(matchCompositeRoute([route({ publicModel: 'other' })], 'model-a', 'any'), null);
  // Disabled and malformed rows never participate (the store loads enabled
  // rows only; the guard is defense in depth).
  assert.equal(
    matchCompositeRoute(
      [route({ id: '1', publicModel: 'model-a', enabled: false }), route({ id: '2', publicModel: '', enabled: true })],
      'model-a',
      'any',
    ),
    null,
  );
});

test('Level 1 uses the route upstream model with passthrough on empty', () => {
  const fixed = resolveCompositeRoute({
    groupId: 'group-a',
    model: 'public-model',
    endpoint: 'messages',
    routes: [route({ id: '1', publicModel: 'public-model', targetPlatform: OPENAI, upstreamModel: 'gpt-5.1' })],
    ownership: { outcome: 'not-matched' },
  });
  assert.deepEqual(
    [fixed.matched, fixed.source, fixed.targetPlatform, fixed.upstreamModel, fixed.routeId],
    [true, 'route', OPENAI, 'gpt-5.1', '1'],
  );

  const passthrough = resolveCompositeRoute({
    groupId: 'group-a',
    model: 'public-model',
    endpoint: 'any',
    routes: [route({ id: '2', publicModel: 'public-model', targetPlatform: OPENAI, upstreamModel: '' })],
    ownership: { outcome: 'matched', targetPlatform: GEMINI },
  });
  // Level 1 wins over ownership; empty upstream passes the requested model.
  assert.deepEqual(
    [passthrough.matched, passthrough.source, passthrough.targetPlatform, passthrough.upstreamModel],
    [true, 'route', OPENAI, 'public-model'],
  );
});

test('Level 2 resolves account model ownership and fails closed on ambiguity', () => {
  const matched = resolveCompositeRoute({
    groupId: 'group-a',
    model: 'provider-model-a',
    endpoint: 'any',
    routes: [],
    ownership: { outcome: 'matched', targetPlatform: ZHIPU },
  });
  assert.deepEqual(
    [matched.matched, matched.source, matched.targetPlatform, matched.upstreamModel],
    [true, 'account_model', ZHIPU, 'provider-model-a'],
  );

  // A model exposed by multiple platforms never guesses.
  const ambiguous = resolveCompositeRoute({
    groupId: 'group-a',
    model: 'shared-model',
    endpoint: 'any',
    routes: [],
    ownership: { outcome: 'ambiguous' },
  });
  assert.equal(ambiguous.matched, false);
  assert.equal(ambiguous.reason, 'model is exposed by multiple provider platforms');

  // A non-concrete platform is ownership drift, not a routing decision.
  const drifted = resolveCompositeRoute({
    groupId: 'group-a',
    model: 'shared-model',
    endpoint: 'any',
    routes: [],
    ownership: { outcome: 'matched', targetPlatform: 'bogus' },
  });
  assert.equal(drifted.matched, false);
  assert.equal(drifted.reason, 'account model ownership has no concrete target platform');
});

test('an unavailable ownership catalog degrades to the detector only for detectable models', () => {
  const detectable = resolveCompositeRoute({
    groupId: 'group-a',
    model: 'gpt-5',
    endpoint: 'any',
    routes: [],
    ownership: { outcome: 'unavailable' },
  });
  assert.deepEqual([detectable.matched, detectable.source, detectable.targetPlatform], [true, 'detector', OPENAI]);

  const undetectable = resolveCompositeRoute({
    groupId: 'group-a',
    model: 'my-private-model',
    endpoint: 'any',
    routes: [],
    ownership: { outcome: 'unavailable' },
  });
  assert.equal(undetectable.matched, false);
  assert.equal(undetectable.reason, 'account model ownership is unavailable for an unrecognized model');
});

test('Level 3 detects standard families and unknown models fail closed', () => {
  const detected = resolveCompositeRoute({
    groupId: 'group-a',
    model: 'glm-4.6',
    endpoint: 'chat_completions',
    routes: [],
    ownership: { outcome: 'not-matched' },
  });
  assert.deepEqual(
    [detected.matched, detected.source, detected.targetPlatform, detected.upstreamModel],
    [true, 'detector', ZHIPU, 'glm-4.6'],
  );

  const unknown = resolveCompositeRoute({
    groupId: 'group-a',
    model: 'my-private-model',
    endpoint: 'any',
    routes: [route({ publicModel: 'other-model' })],
    ownership: { outcome: 'not-matched' },
  });
  assert.equal(unknown.matched, false);
  assert.equal(unknown.reason, 'no explicit route or built-in detector match');

  assert.equal(
    resolveCompositeRoute({ groupId: 'g', model: '  ', endpoint: 'any', routes: [], ownership: null }).matched,
    false,
  );
});

test('the provenance helper rewrites only non-identity decisions', () => {
  const rewrite = resolveCompositeRoute({
    groupId: 'group-a',
    model: 'public-model',
    endpoint: 'any',
    routes: [route({ id: '1', publicModel: 'public-model', targetPlatform: OPENAI, upstreamModel: 'gpt-5.1' })],
    ownership: null,
  });
  assert.deepEqual(compositeRouteModelResolutionSource(rewrite), {
    requestedModel: 'public-model',
    mappedModel: 'gpt-5.1',
    resolvedModel: 'gpt-5.1',
    mappingSource: 'alias',
    mappingVersion: 1,
  });

  const passthrough = resolveCompositeRoute({
    groupId: 'group-a',
    model: 'gpt-5',
    endpoint: 'any',
    routes: [],
    ownership: null,
  });
  assert.equal(compositeRouteModelResolutionSource(passthrough), null);
});
