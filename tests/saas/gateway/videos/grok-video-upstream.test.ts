import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_MAX_VIDEO_CONTENT_BYTES,
  GrokVideoUpstreamError,
  GrokVideoUpstreamForwarder,
  grokVideoSignedContentUrl,
  resolveGrokVideoUrl,
} from '../../../../src/saas/gateway/videos/grok-video-upstream.js';

/**
 * Batch 4 §4.3 (task #17) — the bound-account status/content forwarder:
 * the SSRF hard gate (OAuth official-hosts-only, api-key allowlist), the
 * video URL family, the CLI proxy masquerade, redirect rejection, bounded
 * bodies, and the signed vidgen.x.ai content semantics.
 */

function response(status: number, body: Uint8Array | string = '', headers: Record<string, string> = {}): Response {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return new Response(
    bytes.byteLength === 0
      ? null
      : (new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }) as unknown as BodyInit),
    { status, headers },
  );
}

const ACCOUNT = { accountId: 'account-1', credentialId: 'credential-1', credentialVersion: '1' };

function apiCredential(): { kind: 'api-key'; apiKey: string } {
  return { kind: 'api-key', apiKey: 'xai-key' };
}

test('4.3: the video URL family resolves under the account base with an encoded task id', () => {
  const status = resolveGrokVideoUrl({ credentialKind: 'api-key', kind: 'status', requestId: 'req-1' });
  assert.equal(status.toString(), 'https://api.x.ai/v1/videos/req-1');
  const content = resolveGrokVideoUrl({ credentialKind: 'api-key', kind: 'content', requestId: 'req-1' });
  assert.equal(content.toString(), 'https://api.x.ai/v1/videos/req-1/content');
  const encoded = resolveGrokVideoUrl({
    credentialKind: 'api-key',
    kind: 'status',
    requestId: 'req+1',
  });
  assert.equal(encoded.pathname, '/v1/videos/req%2B1');
});

test('4.3: the SSRF hard gate pins OAuth traffic to official xAI hosts', () => {
  assert.equal(
    resolveGrokVideoUrl({ credentialKind: 'oauth', kind: 'status', requestId: 'r' }).toString(),
    'https://cli-chat-proxy.grok.com/v1/videos/r',
  );
  assert.equal(
    resolveGrokVideoUrl({
      credentialKind: 'oauth',
      kind: 'status',
      requestId: 'r',
      baseUrl: 'https://api.x.ai/v1',
    }).toString(),
    'https://api.x.ai/v1/videos/r',
  );
  assert.throws(
    () =>
      resolveGrokVideoUrl({
        credentialKind: 'oauth',
        kind: 'status',
        requestId: 'r',
        baseUrl: 'https://evil.example/v1',
      }),
    (error: unknown) => error instanceof GrokVideoUpstreamError && error.code === 'HOST_NOT_ALLOWED',
  );
  for (const base of ['http://api.x.ai/v1', 'https://user:pass@api.x.ai/v1', 'https://api.x.ai/v1?x=1']) {
    assert.throws(
      () => resolveGrokVideoUrl({ credentialKind: 'api-key', kind: 'status', requestId: 'r', baseUrl: base }),
      (error: unknown) => error instanceof GrokVideoUpstreamError && error.code === 'HOST_NOT_ALLOWED',
    );
  }
});

test('4.3: a custom api-key base host requires the operator allowlist', () => {
  assert.equal(
    resolveGrokVideoUrl({
      credentialKind: 'api-key',
      kind: 'status',
      requestId: 'r',
      baseUrl: 'https://grok-proxy.internal/v1',
      operatorHostAllowlist: ['grok-proxy.internal'],
    }).toString(),
    'https://grok-proxy.internal/v1/videos/r',
  );
  assert.throws(
    () =>
      resolveGrokVideoUrl({
        credentialKind: 'api-key',
        kind: 'status',
        requestId: 'r',
        baseUrl: 'https://grok-proxy.internal/v1',
      }),
    (error: unknown) => error instanceof GrokVideoUpstreamError && error.code === 'HOST_NOT_ALLOWED',
  );
});

test('4.3: an invalid task id is rejected before any URL is built', () => {
  for (const requestId of ['', '  ', 'has space', 'üñí']) {
    assert.throws(
      () => resolveGrokVideoUrl({ credentialKind: 'api-key', kind: 'status', requestId }),
      (error: unknown) => error instanceof GrokVideoUpstreamError && error.code === 'INVALID_INPUT',
    );
  }
});

test('4.3: only https vidgen.x.ai URLs count as signed content URLs', () => {
  assert.equal(grokVideoSignedContentUrl('https://vidgen.x.ai/a.mp4?x=1'), 'https://vidgen.x.ai/a.mp4?x=1');
  assert.equal(grokVideoSignedContentUrl('http://vidgen.x.ai/a.mp4'), null);
  assert.equal(grokVideoSignedContentUrl('https://user:pass@vidgen.x.ai/a.mp4'), null);
  assert.equal(grokVideoSignedContentUrl('https://evil.example/a.mp4'), null);
  assert.equal(grokVideoSignedContentUrl('https://vidgen.x.ai:8443/a.mp4'), null);
  assert.equal(grokVideoSignedContentUrl('  '), null);
});

function forwarder(
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  options: { readonly baseUrl?: string; readonly operatorHostAllowlist?: readonly string[] } = {},
): GrokVideoUpstreamForwarder {
  return new GrokVideoUpstreamForwarder({
    fetch,
    resolveCredential: async (_input, use) => use(apiCredential()),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.operatorHostAllowlist === undefined ? {} : { operatorHostAllowlist: options.operatorHostAllowlist }),
  });
}

test('4.3: the status fetch dials the account-bound URL with bearer auth and a bounded body', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> | Headers; init: RequestInit }> = [];
  const result = await forwarder(async (url, init) => {
    seen.push({ url, headers: init.headers as Record<string, string>, init });
    return response(200, JSON.stringify({ status: 'done', video: { url: 'https://vidgen.x.ai/a.mp4' } }), {
      'content-type': 'application/json',
    });
  }).fetchStatus({ account: ACCOUNT, requestId: 'req-1' });
  assert.equal(result.kind, 'response');
  if (result.kind !== 'response') return;
  assert.equal(result.status, 200);
  const first = seen[0];
  assert.ok(first !== undefined);
  assert.equal(first.url, 'https://api.x.ai/v1/videos/req-1');
  assert.equal(first.init.method, 'GET');
  assert.equal((first.headers as Record<string, string>).authorization, 'Bearer xai-key');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(result.body)), {
    status: 'done',
    video: { url: 'https://vidgen.x.ai/a.mp4' },
  });
});

test('4.3: the CLI proxy target carries the Grok CLI identity masquerade', async () => {
  const seen: RequestInit[] = [];
  const forwarderOauth = new GrokVideoUpstreamForwarder({
    fetch: async (_url, init) => {
      seen.push(init);
      return response(200, '{}');
    },
    resolveCredential: async (_input, use) => use({ kind: 'oauth', accessToken: 'oauth-token' }),
    baseUrl: 'https://cli-chat-proxy.grok.com/v1',
  });
  const result = await forwarderOauth.fetchStatus({ account: ACCOUNT, requestId: 'req-1' });
  assert.equal(result.kind, 'response');
  const headers = seen[0]?.headers as Record<string, string> | undefined;
  assert.ok(headers !== undefined);
  assert.equal(headers['x-xai-token-auth'], 'xai-grok-cli');
  assert.equal(headers['x-grok-client-identifier'], 'grok-shell');
  assert.equal(headers.authorization, 'Bearer oauth-token');
});

test('4.3: an upstream error status is surfaced with its body for pass-through', async () => {
  const result = await forwarder(async () => response(404, '{"error":{"code":"not_found"}}')).fetchStatus({
    account: ACCOUNT,
    requestId: 'req-1',
  });
  assert.equal(result.kind, 'response');
  if (result.kind !== 'response') return;
  assert.equal(result.status, 404);
});

test('4.3: redirects are rejected', async () => {
  const result = await forwarder(
    async () => new Response(null, { status: 302, headers: { location: 'https://x' } }),
  ).fetchStatus({ account: ACCOUNT, requestId: 'req-1' });
  assert.equal(result.kind, 'error');
  if (result.kind !== 'error') return;
  assert.equal(result.code, 'REDIRECT_REJECTED');
  assert.equal(result.status, 302);
});

test('4.3: a signed content URL dials without credentials; the bound content URL with them', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> });
    return response(200, new Uint8Array([9, 9]), { 'content-type': 'video/mp4' });
  };
  const signed = await forwarder(fetch).fetchContent({
    account: ACCOUNT,
    requestId: 'req-1',
    signedContentUrl: 'https://vidgen.x.ai/signed.mp4',
    range: 'bytes=0-1',
  });
  assert.equal(signed.kind, 'response');
  assert.equal(seen[0]?.url, 'https://vidgen.x.ai/signed.mp4');
  assert.equal(seen[0]?.headers.authorization, undefined);
  assert.equal(seen[0]?.headers.range, 'bytes=0-1');

  seen.length = 0;
  const bound = await forwarder(fetch).fetchContent({
    account: ACCOUNT,
    requestId: 'req-1',
    signedContentUrl: 'https://elsewhere.example/unsigned.mp4',
    range: null,
  });
  assert.equal(bound.kind, 'response');
  assert.equal(seen[0]?.url, 'https://api.x.ai/v1/videos/req-1/content');
  assert.equal(seen[0]?.headers.authorization, 'Bearer xai-key');
  assert.equal(seen[0]?.headers.range, undefined);
});

test('4.3: a content body above the ceiling fails BODY_TOO_LARGE', async () => {
  const big = new Uint8Array(1025);
  const result = await new GrokVideoUpstreamForwarder({
    fetch: async () => response(200, big),
    resolveCredential: async (_input, use) => use(apiCredential()),
    maxContentBytes: 1024,
  }).fetchContent({ account: ACCOUNT, requestId: 'req-1', signedContentUrl: null, range: null });
  assert.equal(result.kind, 'error');
  if (result.kind !== 'error') return;
  assert.equal(result.code, 'BODY_TOO_LARGE');
  assert.equal(DEFAULT_MAX_VIDEO_CONTENT_BYTES, 64 * 1024 * 1024);
});

test('4.3: a network failure is reported without leaking the task', async () => {
  const result = await forwarder(async () => {
    throw new Error('ECONNREFUSED');
  }).fetchStatus({ account: ACCOUNT, requestId: 'req-1' });
  assert.equal(result.kind, 'error');
  if (result.kind !== 'error') return;
  assert.equal(result.code, 'NETWORK_ERROR');
});
