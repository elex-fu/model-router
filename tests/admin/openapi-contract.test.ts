import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminRequestSchemas } from '../../src/admin/contracts.js';
import { adminBodylessActions, adminContractOperations, adminOpenApiDocument, parseAdminRequest } from '../../src/admin/openapi.js';
import { adminDispatchOperations } from '../../src/admin/server.js';

test('OpenAPI 3.1 is generated from shared Zod contracts and contains no credential values', () => {
  assert.equal(adminOpenApiDocument.openapi, '3.1.0');
  assert.ok(adminOpenApiDocument.paths['/openapi.json']);
  for (const operation of adminContractOperations) {
    const path = adminOpenApiDocument.paths[operation.path] as Record<string, Record<string, unknown>> | undefined;
    assert.ok(path?.[operation.method], `${operation.method.toUpperCase()} ${operation.path} must be documented`);
    if (operation.schema) {
      const requestBody = path[operation.method].requestBody as {
        content: { 'application/json': { schema: { type?: string } } };
      };
      assert.ok(requestBody.content['application/json'].schema);
      assert.ok(adminRequestSchemas[operation.schema]);
    }
  }
  const json = JSON.stringify(adminOpenApiDocument);
  for (const value of ['local-secret-value', 'sk-live-example', 'mr_live-example', 'client_secret_value'])
    assert.equal(json.includes(value), false);
});

test('covered contract method/path set is unique and runtime parser enforces its documented Zod schema', () => {
  const keys = adminContractOperations.map((route) => `${route.method} ${route.path}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.throws(
    () => parseAdminRequest('POST', '/session', { name: '', password: 'x' }),
    (error: unknown) => error instanceof Error && error.message.includes('documented schema'),
  );
  assert.deepEqual(parseAdminRequest('POST', '/routes/order', { ids: ['route-a'] }), { ids: ['route-a'] });
  assert.deepEqual(parseAdminRequest('POST', '/upstreams/upstream-a/test-jobs/job-1/cancel', {}), {});
  assert.throws(
    () => parseAdminRequest('PUT', '/routes/order', { ids: ['route-a'], secret: 'must-not-appear' }),
    (error: unknown) => error instanceof Error && !error.message.includes('must-not-appear'),
  );
  assert.throws(
    () => parseAdminRequest('POST', '/upstreams/upstream-a/test-jobs/job-1/cancel', { cancelAll: true }),
    (error: unknown) => error instanceof Error && !error.message.includes('cancelAll'),
  );
  assert.deepEqual(parseAdminRequest('DELETE', '/upstreams/upstream-1', {}), {});
});

test('OpenAPI method/path manifest exactly matches admin dispatch routes', () => {
  const documented = adminContractOperations.map(({ method, path }) => `${method.toUpperCase()} ${path}`).sort();
  assert.deepEqual(documented, [...adminDispatchOperations].sort());
  for (const operation of adminContractOperations) {
    if (!['get', 'delete'].includes(operation.method) && !adminBodylessActions.has(`${operation.method.toUpperCase()} ${operation.path}`)) assert.ok(operation.schema, `${operation.method} ${operation.path} requires a runtime body schema`);
  }
});

test('non-JSON response media types and accepted job statuses are accurate', () => {
  const path = (name: string, method = 'get') => adminOpenApiDocument.paths[name][method] as any;
  assert.ok(path('/openapi.json').responses['200'].content['application/vnd.oai.openapi+json;version=3.1']);
  assert.ok(path('/events').responses['200'].content['text/event-stream']);
  assert.ok(path('/exports/{id}/download').responses['200'].content['text/csv']);
  assert.ok(path('/config/export').responses['200'].content['application/json']);
  for (const name of ['/exports','/playground/runs','/maintenance/jobs']) {
    const operation = path(name, 'post');
    assert.ok(operation.responses['202']);
    assert.equal(operation.responses['200'], undefined);
  }
  assert.ok(path('/requests').parameters.some((parameter: any) => parameter.in === 'query' && parameter.name === 'cursor'));
});

test('telemetry operations document only their supported query parameters and parser bounds', () => {
  const operation = (path: string) => adminOpenApiDocument.paths[path].get as any;
  const queryParameters = (path: string) =>
    operation(path).parameters.filter((parameter: any) => parameter.in === 'query');
  const queryNames = (path: string) => queryParameters(path).map((parameter: any) => parameter.name).sort();
  const querySchema = (path: string, name: string) =>
    queryParameters(path).find((parameter: any) => parameter.name === name)?.schema;
  const common = ['from', 'keyId', 'model', 'protocol', 'source', 'to', 'upstreamId'];

  assert.deepEqual(queryNames('/usage/summary'), common);
  assert.deepEqual(queryNames('/usage/timeseries'), [...common, 'grain'].sort());
  assert.deepEqual(queryNames('/usage/breakdown'), [...common, 'groupBy', 'upstreamFilterMode'].sort());
  assert.deepEqual(queryNames('/requests'), [...common, 'cursor', 'limit', 'state', 'status'].sort());
  for (const path of ['/usage/summary', '/usage/timeseries', '/usage/breakdown', '/requests']) {
    assert.equal(querySchema(path, 'from').format, 'date-time');
    assert.match(querySchema(path, 'from').description, /timezone offset.*400 days/);
    assert.deepEqual(querySchema(path, 'source').enum, ['production', 'playground', 'health', 'all', 'proxy']);
    for (const name of ['keyId', 'upstreamId', 'model', 'protocol'])
      assert.equal(querySchema(path, name).maxLength, 200);
    assert.equal(querySchema(path, 'currency'), undefined);
  }
  assert.deepEqual(querySchema('/usage/timeseries', 'grain').enum, ['hour', 'day']);
  assert.deepEqual(querySchema('/usage/breakdown', 'groupBy').enum, [
    'keyId', 'upstreamId', 'model', 'protocol', 'source', 'upstream',
  ]);
  assert.deepEqual(querySchema('/usage/breakdown', 'upstreamFilterMode').enum, ['final', 'attempt']);
  assert.equal(querySchema('/requests', 'limit').minimum, 1);
  assert.equal(querySchema('/requests', 'limit').maximum, 200);
  assert.equal(querySchema('/requests', 'cursor').maxLength, 512);
  assert.ok(querySchema('/requests', 'state').enum.includes('succeeded'));
  assert.deepEqual(
    (operation('/requests/{id}').parameters as any[]).map(({ name, in: location }) => [name, location]),
    [['id', 'path']],
  );
});
