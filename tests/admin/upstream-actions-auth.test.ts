import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UpstreamActions } from '../../src/admin/upstream-actions.js';
import type { UpstreamDefinition } from '../../src/config/v2-schema.js';
import { ControlError, type ControlService } from '../../src/control/service.js';

const secret = 'private-test-credential';
const baseUrl = 'https://provider.example/v1';

function upstream(auth: UpstreamDefinition['auth']): UpstreamDefinition {
  return {
    id: 'vendor',
    name: 'Vendor',
    provider: 'custom',
    protocol: 'openai',
    enabled: true,
    baseUrl,
    endpoints: { models: 'models', generate: 'chat/completions' },
    auth,
    credentials:
      auth.mode === 'none'
        ? []
        : [{ id: 'credential', label: 'Credential', enabled: true, secret: { type: 'secret', id: 'stored' } }],
    models: [{ id: 'model-1', enabled: true, capabilities: {}, capabilitiesSource: 'manual' }],
    priority: 0,
    sortIndex: 0,
    policy: {},
  };
}

function actions(configured: UpstreamDefinition): UpstreamActions {
  const control = {
    raw: async () => ({ upstreams: [configured] }),
    store: { secrets: { get: (id: string) => (id === 'stored' ? secret : undefined) } },
  } as unknown as ControlService;
  return new UpstreamActions(control);
}

test('custom-header uses the resolved credential for discovery, test and generation', async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    assert.ok(init);
    seen.push({ url: String(input), init });
    const data =
      init.method === 'GET'
        ? { data: [{ id: 'model-1' }] }
        : { model: 'model-1', choices: [{ message: { content: `hello ${secret}` } }] };
    return Response.json(data);
  };
  try {
    const api = actions(upstream({ mode: 'custom-header', headerName: 'X-Vendor-Key' }));
    const discovered = await api.discoverModels('vendor');
    const checked = await api.test('vendor', 'model-1', new AbortController().signal);
    const generated = await api.generate('vendor', 'model-1', 'hi', 16, undefined, new AbortController().signal);
    assert.deepEqual(discovered.models, [{ id: 'model-1', source: 'discovered' }]);
    assert.equal(checked.ok, true);
    assert.equal(generated.output, 'hello [redacted]');
    assert.equal(JSON.stringify({ discovered, checked, generated }).includes(secret), false);
    assert.deepEqual(
      seen.map(({ url }) => url),
      [`${baseUrl}/models`, `${baseUrl}/chat/completions`, `${baseUrl}/chat/completions`],
    );
    assert.deepEqual(
      seen.map(({ init }) => init.method),
      ['GET', 'POST', 'POST'],
    );
    for (const { init } of seen) {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('x-vendor-key'), secret);
      assert.equal(headers.has('authorization'), false);
      assert.equal(headers.has('host'), false);
      assert.equal(headers.has('x-forwarded-for'), false);
      assert.equal(init.redirect, 'manual');
      assert.equal(JSON.stringify(init.body ?? '').includes(secret), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reserved custom headers fail before any outbound request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({});
  };
  try {
    for (const headerName of [
      'Host',
      'Authorization',
      'X-Forwarded-For',
      'Proxy-Authorization',
      'Sec-Fetch-Site',
      'X-Model-Router-Key',
    ]) {
      const api = actions(upstream({ mode: 'custom-header', headerName }));
      await assert.rejects(
        api.discoverModels('vendor'),
        (error: unknown) => error instanceof ControlError && error.code === 'INVALID_AUTH_HEADER',
      );
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('none remains usable and unsupported authentication modes fail explicitly', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('x-api-key'), false);
    return Response.json({ data: [{ id: 'model-1' }] });
  };
  try {
    assert.equal((await actions(upstream({ mode: 'none' })).discoverModels('vendor')).status, 200);
    for (const mode of ['oauth', 'google', 'pass-through'] as const) {
      await assert.rejects(
        actions(upstream({ mode })).discoverModels('vendor'),
        (error: unknown) => error instanceof ControlError && error.code === 'AUTH_UNSUPPORTED_FOR_TEST',
      );
    }
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('redirects are never followed for discovery, test or generation', async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (input, init) => {
    seen.push(String(input));
    assert.equal(init?.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'https://different.example/collect' } });
  };
  try {
    const api = actions(upstream({ mode: 'custom-header', headerName: 'X-Vendor-Key' }));
    await assert.rejects(
      api.discoverModels('vendor'),
      (error: unknown) => error instanceof ControlError && error.code === 'UPSTREAM_DISCOVERY_FAILED',
    );
    assert.equal((await api.test('vendor', 'model-1', new AbortController().signal)).ok, false);
    assert.equal(
      (await api.generate('vendor', 'model-1', 'hi', 16, undefined, new AbortController().signal)).ok,
      false,
    );
    assert.deepEqual(seen, [`${baseUrl}/models`, `${baseUrl}/chat/completions`, `${baseUrl}/chat/completions`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider errors cannot echo the resolved credential into action results', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { message: `rejected ${secret}` } }, { status: 401 });
  try {
    const api = actions(upstream({ mode: 'custom-header', headerName: 'X-Vendor-Key' }));
    await assert.rejects(
      api.discoverModels('vendor'),
      (error: unknown) =>
        error instanceof ControlError &&
        error.code === 'UPSTREAM_DISCOVERY_FAILED' &&
        error.message === 'rejected [redacted]',
    );
    const checked = await api.test('vendor', 'model-1', new AbortController().signal);
    const generated = await api.generate('vendor', 'model-1', 'hi', 16, undefined, new AbortController().signal);
    assert.equal(checked.error, 'rejected [redacted]');
    assert.equal(generated.error, 'rejected [redacted]');
    assert.equal(JSON.stringify({ checked, generated }).includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
