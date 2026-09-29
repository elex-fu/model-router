import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Route } from '../../web/src/api/types.ts';
import { duplicatePublishedAliases, routeConflicts, targetTransport } from '../../web/src/features/routes.tsx';

function route(overrides: Partial<Route> = {}): Route {
  return {
    id: 'route-a',
    name: 'Route A',
    enabled: true,
    clientProtocols: ['openai'],
    match: { kind: 'exact', value: 'alias-a' },
    order: 0,
    publishedModels: ['alias-a'],
    targets: [{ upstreamId: 'up-a', model: 'model-a' }],
    ...overrides,
  };
}

test('reports exact and exact-to-glob overlaps only for enabled routes sharing a protocol', () => {
  const exact = route();
  assert.deepEqual(
    routeConflicts(exact, [exact, route({ id: 'route-b', name: 'Route B' })]).map((item) => item.name),
    ['Route B'],
  );
  assert.deepEqual(
    routeConflicts(exact, [exact, route({ id: 'route-b', match: { kind: 'glob', value: 'alias-*' } })]).length,
    1,
  );
  assert.equal(routeConflicts(exact, [exact, route({ id: 'route-b', clientProtocols: ['anthropic'] })]).length, 0);
  assert.equal(routeConflicts(exact, [exact, route({ id: 'route-b', enabled: false })]).length, 0);
  assert.equal(
    routeConflicts(exact, [exact, route({ id: 'route-b', match: { kind: 'glob', value: 'other-*' } })]).length,
    0,
  );
});

test('reports duplicate published aliases only within intersecting enabled client protocols', () => {
  const current = route({ publishedModels: ['shared', 'shared'] });
  const sameProtocol = route({ id: 'route-b', name: 'Route B', publishedModels: ['shared'] });
  const otherProtocol = route({
    id: 'route-c',
    name: 'Route C',
    clientProtocols: ['anthropic'],
    publishedModels: ['shared'],
  });
  assert.deepEqual(duplicatePublishedAliases(current, [current, sameProtocol, otherProtocol]), [
    { alias: 'shared', routes: ['Route A', 'Route B'] },
  ]);
  assert.deepEqual(duplicatePublishedAliases(route({ enabled: false }), [route({ enabled: false })]), []);
});

test('classifies protocol handling without claiming unsupported Responses bridges', () => {
  assert.equal(targetTransport('openai', 'openai'), '原生');
  assert.equal(targetTransport('anthropic', 'openai'), '桥接');
  assert.equal(targetTransport('responses', 'openai'), '不支持');
  assert.equal(targetTransport('openai', 'gemini'), '不支持');
  assert.equal(targetTransport('anthropic', 'gemini'), '实验性');
});
