import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RouteDefinition } from '../../src/config/v2-schema.js';
import {
  matchRoute,
  type RoutingSnapshot,
  resolveRoute,
  routeHasAuthorizedTarget,
  selectRouteTargets,
} from '../../src/router/routes.js';

const upstream = (id: string) => ({
  id,
  name: id,
  provider: 'custom-openai',
  protocol: 'openai' as const,
  baseUrl: 'https://example.test/v1',
  apiKeys: ['k'],
  models: [`actual-${id}`],
  enabled: true,
});
const route = (
  id: string,
  order: number,
  protocols: Array<'openai' | 'anthropic' | 'responses'>,
  kind: 'exact' | 'glob',
  value: string,
  targets: string[],
): RouteDefinition => ({
  id,
  name: id,
  enabled: true,
  clientProtocols: protocols,
  match: { kind, value },
  order,
  publishedModels: [],
  targets: targets.map((upstreamId) => ({ upstreamId, model: `actual-${upstreamId}` })),
});

test('exact route wins over an earlier glob and targets retain configured order', () => {
  const snapshot: RoutingSnapshot = {
    upstreams: [upstream('a'), upstream('b')],
    routes: [
      route('fallback', 30, ['openai'], 'glob', 'qwen*', ['b']),
      route('wrong-protocol', 20, ['anthropic'], 'exact', 'qwen', ['b']),
      route('chosen', 10, ['openai'], 'exact', 'qwen', ['b', 'a']),
    ],
  };
  assert.deepEqual(
    selectRouteTargets('qwen', 'openai', snapshot).map((item) => [item.upstream.name, item.resolvedModel]),
    [
      ['b', 'actual-b'],
      ['a', 'actual-a'],
    ],
  );
  assert.deepEqual(
    selectRouteTargets('qwen', 'anthropic', snapshot).map((item) => item.upstream.name),
    [],
  );
  assert.deepEqual(selectRouteTargets('other', 'openai', snapshot), []);
  assert.equal(matchRoute('qwen', 'openai', snapshot)?.id, 'chosen');
});

test('a protocol-incompatible exact route blocks fallback to matching glob', () => {
  const snapshot: RoutingSnapshot = {
    upstreams: [upstream('a')],
    routes: [
      route('glob', 0, ['openai'], 'glob', 'qwen*', ['a']),
      route('exact', 10, ['anthropic'], 'exact', 'qwen', ['a']),
    ],
  };
  assert.deepEqual(resolveRoute('qwen', 'openai', snapshot), {
    route: snapshot.routes[1],
    reason: 'unsupported_client_protocol',
  });
  assert.equal(matchRoute('qwen', 'openai', snapshot), undefined);
  assert.deepEqual(selectRouteTargets('qwen', 'openai', snapshot), []);
  assert.equal(routeHasAuthorizedTarget('qwen', snapshot), true);
  assert.equal(
    routeHasAuthorizedTarget('qwen', snapshot, {
      name: 'key',
      key: 'k',
      enabled: true,
      createdAt: 'now',
      allowedModels: ['other*'],
    }),
    false,
  );
  assert.equal(
    routeHasAuthorizedTarget('qwen', snapshot, {
      name: 'key',
      key: 'k',
      enabled: true,
      createdAt: 'now',
      allowedUpstreamIds: ['other'],
    }),
    false,
  );
});

test('matching exact and glob rules prioritize exact regardless of order, then order within kind', () => {
  const snapshot: RoutingSnapshot = {
    upstreams: [upstream('a'), upstream('b')],
    routes: [
      route('glob', -1, ['openai'], 'glob', 'qwen*', ['a']),
      route('exact-late', 20, ['openai'], 'exact', 'qwen', ['b']),
      route('exact-early', 5, ['openai'], 'exact', 'qwen', ['a']),
    ],
  };
  assert.equal(matchRoute('qwen', 'openai', snapshot)?.id, 'exact-early');
  assert.deepEqual(
    selectRouteTargets('qwen', 'openai', snapshot).map((item) => item.upstream.id),
    ['a'],
  );
});
