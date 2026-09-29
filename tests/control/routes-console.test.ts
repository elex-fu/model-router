import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfigV2, RouteDefinition } from '../../src/config/v2-schema.js';
import { ControlService } from '../../src/control/service.js';
import { routeConflicts, targetTransport } from '../../web/src/features/routes.js';

const route = (
  id: string,
  order: number,
  match: RouteDefinition['match'],
  protocol: RouteDefinition['clientProtocols'][number] = 'openai',
): RouteDefinition => ({
  id,
  name: id,
  enabled: true,
  order,
  match,
  clientProtocols: [protocol],
  publishedModels: match.kind === 'exact' ? [match.value] : [],
  targets: [{ upstreamId: 'up', model: 'real-model' }],
});

test('console highlights definite match overlaps only for shared client protocols', () => {
  const exact = route('exact', 1, { kind: 'exact', value: 'public-model' });
  const glob = route('glob', 0, { kind: 'glob', value: 'public-*' });
  const otherProtocol = route('anthropic', 2, { kind: 'exact', value: 'public-model' }, 'anthropic');
  const differentGlob = route('different-glob', 3, { kind: 'glob', value: '*-model' });
  assert.deepEqual(
    routeConflicts(exact, [exact, glob, otherProtocol]).map((item) => item.id),
    ['glob'],
  );
  assert.deepEqual(routeConflicts(glob, [glob, differentGlob]), []);
  assert.deepEqual(routeConflicts({ ...exact, enabled: false }, [exact, glob]), []);
});

test('console protocol labels distinguish native, bridge, experimental and unsupported', () => {
  assert.equal(targetTransport('responses', 'responses'), '原生');
  assert.equal(targetTransport('openai', 'anthropic'), '桥接');
  assert.equal(targetTransport('anthropic', 'gemini'), '实验性');
  assert.equal(targetTransport('openai', 'gemini'), '不支持');
  assert.equal(targetTransport('responses', 'openai'), '不支持');
});

test('route preview prioritizes exact matches and reports protocol rejection without calling upstream', async () => {
  const routes = [
    route('glob-first', 0, { kind: 'glob', value: 'public-*' }),
    route('exact-second', 1, { kind: 'exact', value: 'public-model' }),
    route('anthropic-only', 2, { kind: 'exact', value: 'public-model' }, 'anthropic'),
  ];
  const control = {
    raw: async () =>
      ({
        routes,
        upstreams: [{ id: 'up', protocol: 'openai', enabled: true, models: [{ id: 'real-model', enabled: true }] }],
      }) as unknown as ConfigV2,
  } as unknown as ControlService;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('preview must not call upstream');
  };
  try {
    const openai = await ControlService.prototype.previewRoute.call(control, 'public-model', 'openai');
    assert.equal(openai.routeId, 'exact-second');
    assert.equal(openai.candidates.length, 1);
    assert.equal(openai.candidates[0].upstreamId, 'up');
    const anthropic = await ControlService.prototype.previewRoute.call(control, 'public-model', 'anthropic');
    assert.deepEqual(anthropic, {
      matched: false,
      reason: 'unsupported_client_protocol',
      routeId: 'exact-second',
      candidates: [],
    });
    const missing = await ControlService.prototype.previewRoute.call(control, 'missing', 'openai');
    assert.equal(missing.matched, false);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
