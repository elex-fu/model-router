import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { createSaasGatewayHandler } from '../../../src/saas/gateway/http-handler.js';
import type { SaasModelPlazaPort } from '../../../src/saas/gateway/model-plaza/endpoint.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';

class FakeRequest extends EventEmitter {
  readonly socket = { remoteAddress: '127.0.0.1' };
  aborted = false;
  url: string;
  method: string;
  readonly headers: IncomingHttpHeaders;

  constructor(options: { readonly url?: string; readonly method?: string; readonly headers?: IncomingHttpHeaders }) {
    super();
    this.url = options.url ?? '/v1/model-plaza';
    this.method = options.method ?? 'GET';
    this.headers = { ...(options.headers ?? {}) };
  }

  resume(): this {
    return this;
  }
}

class FakeResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  readonly writeHeadCalls: Array<{ status: number; headers: Record<string, unknown> }> = [];
  readonly setHeaders = new Map<string, unknown>();
  endCount = 0;
  endBody: unknown;

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.headersSent = true;
    this.writeHeadCalls.push({ status, headers });
    return this;
  }

  setHeader(name: string, value: unknown): this {
    this.setHeaders.set(name.toLowerCase(), value);
    return this;
  }

  end(body?: unknown): this {
    this.writableEnded = true;
    this.endCount += 1;
    this.endBody = body;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

function present<T>(value: T | null | undefined, message?: string): T {
  assert.ok(value !== null && value !== undefined, message);
  return value;
}

function plazaPort(overrides: Partial<SaasModelPlazaPort['serve']> = {}): SaasModelPlazaPort & {
  readonly calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async serve(input) {
      calls.push({ ...input });
      if (overrides.result) return overrides.result();
      return { status: 200, contentType: 'application/json; charset=utf-8', body: '{"groups":[]}' };
    },
  };
}

function handler(plaza: SaasModelPlazaPort | undefined): ReturnType<typeof createSaasGatewayHandler> {
  return createSaasGatewayHandler({
    authenticator: {
      async authenticate(): Promise<AuthenticatedApiKey | null> {
        return null;
      },
    },
    preparation: {
      async prepare() {
        throw new Error('the plaza must never enter preparation');
      },
    },
    dispatch: {
      async dispatch() {
        throw new Error('the plaza must never dispatch');
      },
    },
    ...(plaza ? { modelPlaza: plaza } : {}),
    maxBodyBytes: 1024,
  });
}

test('GET /v1/model-plaza delegates to the port with extracted credentials and the resolved client address', async () => {
  const port = plazaPort();
  const response = new FakeResponse();
  const handled = await handler(port)(
    new FakeRequest({
      headers: {
        authorization: 'Bearer plaza-secret',
        cookie: 'other=1; mr_saas_session=session-token; x=y',
      },
    }) as unknown as IncomingMessage,
    response as unknown as ServerResponse,
  );
  assert.equal(handled, true);
  assert.equal(present(response.writeHeadCalls[0]).status, 200);
  assert.equal(response.endBody, '{"groups":[]}');
  assert.equal(present(response.writeHeadCalls[0]).headers['cache-control'], 'no-store');
  assert.equal(port.calls.length, 1);
  assert.equal(present(port.calls[0]).bearerToken, 'plaza-secret');
  assert.equal(present(port.calls[0]).sessionToken, 'session-token');
  assert.equal(present(port.calls[0]).clientAddress, '127.0.0.1');
  assert.equal(typeof present(port.calls[0]).authenticateProxyKey, 'function');
});

test('the plaza is GET-only and fails closed without a port (405 / 503)', async () => {
  const methodResponse = new FakeResponse();
  const handled = await handler(plazaPort())(
    new FakeRequest({ method: 'POST' }) as unknown as IncomingMessage,
    methodResponse as unknown as ServerResponse,
  );
  assert.equal(handled, true);
  assert.equal(present(methodResponse.writeHeadCalls[0]).status, 405);

  const unavailable = new FakeResponse();
  const handledToo = await handler(undefined)(
    new FakeRequest({}) as unknown as IncomingMessage,
    unavailable as unknown as ServerResponse,
  );
  assert.equal(handledToo, true);
  assert.equal(present(unavailable.writeHeadCalls[0]).status, 503);
  const body = JSON.parse(String(unavailable.endBody)) as { error: { code: string; requestId: string } };
  assert.equal(body.error.code, 'GATEWAY_UNAVAILABLE');
  assert.match(body.error.requestId, /^gateway_/);
});

test('a port failure maps to 503 and never leaks internals; error bodies flow verbatim from the port', async () => {
  const failing = plazaPort({
    result: () => {
      throw new Error('plaza internals');
    },
  });
  const response = new FakeResponse();
  await handler(failing)(new FakeRequest({}) as unknown as IncomingMessage, response as unknown as ServerResponse);
  assert.equal(present(response.writeHeadCalls[0]).status, 503);

  const disabled: SaasModelPlazaPort = {
    async serve() {
      return {
        status: 404,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          error: { code: 'PLAZA_DISABLED', message: 'The model plaza is not enabled', requestId: 'req-1' },
        }),
      };
    },
  };
  const disabledResponse = new FakeResponse();
  await handler(disabled)(
    new FakeRequest({}) as unknown as IncomingMessage,
    disabledResponse as unknown as ServerResponse,
  );
  assert.equal(present(disabledResponse.writeHeadCalls[0]).status, 404);
  assert.deepEqual(JSON.parse(String(disabledResponse.endBody)), {
    error: { code: 'PLAZA_DISABLED', message: 'The model plaza is not enabled', requestId: 'req-1' },
  });
});

test('the session cookie is bounded and only the known name is parsed', async () => {
  const port = plazaPort();
  const response = new FakeResponse();
  await handler(port)(
    new FakeRequest({ headers: { cookie: `mr_saas_session=${'a'.repeat(5000)}` } }) as unknown as IncomingMessage,
    response as unknown as ServerResponse,
  );
  assert.equal(present(port.calls[0]).sessionToken, null, 'oversized cookie values are rejected');

  const noCookie = plazaPort();
  await handler(noCookie)(
    new FakeRequest({ headers: { cookie: 'session=other-name' } }) as unknown as IncomingMessage,
    new FakeResponse() as unknown as ServerResponse,
  );
  assert.equal(present(noCookie.calls[0]).sessionToken, null);

  const empty = plazaPort();
  await handler(empty)(
    new FakeRequest({ headers: { authorization: 'Bearer plaza-secret' } }) as unknown as IncomingMessage,
    new FakeResponse() as unknown as ServerResponse,
  );
  assert.equal(present(empty.calls[0]).bearerToken, 'plaza-secret');
  assert.equal(present(empty.calls[0]).sessionToken, null);
});

test('non-plaza paths are untouched by the plaza port', async () => {
  const port = plazaPort();
  const response = new FakeResponse();
  const handled = await handler(port)(
    new FakeRequest({ url: '/v1/models' }) as unknown as IncomingMessage,
    response as unknown as ServerResponse,
  );
  assert.equal(handled, true);
  assert.equal(port.calls.length, 0, 'the plaza port is only called for /v1/model-plaza');
});
