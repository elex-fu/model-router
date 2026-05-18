import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OAuthTokenResolver } from '../../src/server/oauth.js';

async function startMockTokenServer(
  handler: (req: http.IncomingMessage, body: string) => { status: number; body: any }
): Promise<{ url: string; close(): Promise<void>; requests: { body: string; headers: http.IncomingHttpHeaders }[] }> {
  const requests: { body: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf-8');
    requests.push({ body, headers: req.headers });
    const out = handler(req, body);
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('listen failed');
  return {
    url: `http://127.0.0.1:${addr.port}/token`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    requests,
  };
}

test('resolve: fetches token via client_credentials', async () => {
  const server = await startMockTokenServer((_req, body) => {
    const params = new URLSearchParams(body);
    assert.equal(params.get('grant_type'), 'client_credentials');
    assert.equal(params.get('client_id'), 'cid');
    assert.equal(params.get('client_secret'), 'csec');
    assert.equal(params.get('scope'), 'read');
    return { status: 200, body: { access_token: 'tok-123', expires_in: 3600 } };
  });
  try {
    const resolver = new OAuthTokenResolver();
    const token = await resolver.resolve({
      tokenUrl: server.url,
      clientId: 'cid',
      clientSecret: 'csec',
      scope: 'read',
    });
    assert.equal(token, 'tok-123');
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].headers['content-type'], 'application/x-www-form-urlencoded');
  } finally {
    await server.close();
  }
});

test('resolve: caches token and reuses before expiry', async () => {
  let callCount = 0;
  const server = await startMockTokenServer(() => {
    callCount++;
    return { status: 200, body: { access_token: `tok-${callCount}`, expires_in: 3600 } };
  });
  try {
    const resolver = new OAuthTokenResolver();
    const config = { tokenUrl: server.url, clientId: 'cid', clientSecret: 'csec' };
    const t1 = await resolver.resolve(config);
    const t2 = await resolver.resolve(config);
    assert.equal(t1, 'tok-1');
    assert.equal(t2, 'tok-1');
    assert.equal(callCount, 1);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('resolve: refreshes when cache is near expiry', async () => {
  let callCount = 0;
  const server = await startMockTokenServer(() => {
    callCount++;
    return { status: 200, body: { access_token: `tok-${callCount}`, expires_in: 60 } };
  });
  try {
    const resolver = new OAuthTokenResolver();
    const config = { tokenUrl: server.url, clientId: 'cid', clientSecret: 'csec' };
    const t1 = await resolver.resolve(config);
    const t2 = await resolver.resolve(config);
    assert.equal(t1, 'tok-1');
    assert.equal(t2, 'tok-2');
    assert.equal(callCount, 2);
  } finally {
    await server.close();
  }
});

test('resolve: throws on non-200 response', async () => {
  const server = await startMockTokenServer(() => ({ status: 401, body: { error: 'invalid_client' } }));
  try {
    const resolver = new OAuthTokenResolver();
    await assert.rejects(
      resolver.resolve({ tokenUrl: server.url, clientId: 'cid', clientSecret: 'csec' }),
      /OAuth token request failed: 401/
    );
  } finally {
    await server.close();
  }
});

test('resolve: throws when access_token missing', async () => {
  const server = await startMockTokenServer(() => ({ status: 200, body: { token_type: 'bearer' } }));
  try {
    const resolver = new OAuthTokenResolver();
    await assert.rejects(
      resolver.resolve({ tokenUrl: server.url, clientId: 'cid', clientSecret: 'csec' }),
      /OAuth response missing access_token/
    );
  } finally {
    await server.close();
  }
});

test('resolve: scope is omitted when not provided', async () => {
  const server = await startMockTokenServer((_req, body) => {
    const params = new URLSearchParams(body);
    assert.equal(params.get('scope'), null);
    return { status: 200, body: { access_token: 'tok-1', expires_in: 3600 } };
  });
  try {
    const resolver = new OAuthTokenResolver();
    await resolver.resolve({ tokenUrl: server.url, clientId: 'cid', clientSecret: 'csec' });
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('clear: removes cached tokens', async () => {
  let callCount = 0;
  const server = await startMockTokenServer(() => {
    callCount++;
    return { status: 200, body: { access_token: `tok-${callCount}`, expires_in: 3600 } };
  });
  try {
    const resolver = new OAuthTokenResolver();
    const config = { tokenUrl: server.url, clientId: 'cid', clientSecret: 'csec' };
    await resolver.resolve(config);
    resolver.clear();
    await resolver.resolve(config);
    assert.equal(callCount, 2);
  } finally {
    await server.close();
  }
});
