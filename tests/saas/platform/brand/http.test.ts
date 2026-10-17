import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { createPublicBrandSettingsHttpHandler } from '../../../../src/saas/platform/brand/http.js';
import type { PublicBrandSnapshot } from '../../../../src/saas/platform/brand/snapshot.js';

/**
 * Batch 5 §5.2 OEM white-label: the unauthenticated public brand surface —
 * GET /settings/public and GET /settings/public/pages/:slug — with the exact
 * 404/405 semantics and the fail-open read posture. Fabricated
 * request/response objects (the settings http.test.ts harness shape).
 */

interface ResponseCapture {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function brandedSnapshot(): PublicBrandSnapshot {
  return {
    siteName: 'Acme Router',
    siteSubtitle: 'Acme AI gateway',
    siteLogo: 'https://cdn.oem.test/logo.png',
    apiBaseUrl: 'https://api.acme.test',
    contactUrl: 'mailto:ops@acme.test',
    docUrl: 'https://docs.acme.test',
    customMenuItems: [{ label: 'Docs', url: 'https://docs.acme.test', pageSlug: 'handbook' }],
    customEndpoints: [{ name: 'EU', url: 'https://eu.api.acme.test', description: '' }],
    customPages: [
      {
        slug: 'terms',
        title: 'Terms',
        mode: 'markdown',
        content: '# Terms of service',
        url: '',
        userIdParam: false,
        themeParam: false,
        langParam: false,
      },
      {
        slug: 'handbook',
        title: 'Handbook',
        mode: 'iframe',
        content: '',
        url: 'https://docs.acme.test/handbook',
        userIdParam: true,
        themeParam: false,
        langParam: true,
      },
    ],
    frameAncestors: ['https://portal.acme.test'],
  };
}

function harness(read: () => Promise<PublicBrandSnapshot>) {
  const errors: unknown[] = [];
  const handler = createPublicBrandSettingsHttpHandler({
    read,
    onError: (error) => errors.push(error),
  });
  const request = async (url: string, method = 'GET'): Promise<ResponseCapture & { readonly handled: boolean }> => {
    const req = {
      url,
      method,
      headers: {},
      resume() {
        return req;
      },
    } as unknown as IncomingMessage;
    let status = 200;
    let headers: Record<string, string | string[]> = {};
    let body = '';
    const res = {
      writeHead(code: number, head: Record<string, string | string[]> = {}) {
        status = code;
        headers = head;
        return res;
      },
      end(value?: unknown) {
        body = value === undefined ? '' : String(value);
        return res;
      },
    } as unknown as ServerResponse;
    const handled = await handler(req, res);
    return { status, headers, body, handled };
  };
  return { handler, request, errors };
}

test('GET /settings/public serves the full snapshot unauthenticated with a 60s cache window', async () => {
  const { request } = harness(async () => brandedSnapshot());
  const response = await request('/settings/public');
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'public, max-age=60');
  const payload = JSON.parse(response.body) as { data: Record<string, unknown> };
  assert.equal(payload.data.siteName, 'Acme Router');
  assert.deepEqual(payload.data.frameAncestors, ['https://portal.acme.test']);
  // Markdown pages carry content; iframe pages carry url + param switches.
  const pages = payload.data.customPages as Array<Record<string, unknown>>;
  assert.equal(pages[0]?.content, '# Terms of service');
  assert.equal(pages[1]?.url, 'https://docs.acme.test/handbook');
  assert.equal(pages[1]?.userIdParam, true);
  assert.equal(pages[1]?.langParam, true);
  assert.equal('content' in (pages[1] as object), false);
});

test('non-GET methods on the matched paths answer 405 with allow: GET', async () => {
  const { request } = harness(async () => brandedSnapshot());
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const root = await request('/settings/public', method);
    assert.equal(root.handled, true);
    assert.equal(root.status, 405);
    assert.equal(root.headers.allow, 'GET');
    const page = await request('/settings/public/pages/terms', method);
    assert.equal(page.handled, true);
    assert.equal(page.status, 405);
  }
});

test('paths outside the brand surface are not handled', async () => {
  const { request } = harness(async () => brandedSnapshot());
  for (const path of ['/settings', '/settings/private', '/v1/messages', '/settings/publicx', '/console/api/v1/keys']) {
    const response = await request(path);
    assert.equal(response.handled, false, `${path} must not be handled`);
  }
});

test('page content: markdown served as text/markdown, iframe and unknown slugs 404', async () => {
  const { request } = harness(async () => brandedSnapshot());
  const markdown = await request('/settings/public/pages/terms');
  assert.equal(markdown.status, 200);
  assert.equal(markdown.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal(markdown.body, '# Terms of service');
  // An iframe-mode page has no markdown body endpoint.
  const iframe = await request('/settings/public/pages/handbook');
  assert.equal(iframe.status, 404);
  // Unknown, malformed and space-bearing slugs all answer the same 404.
  // Dot-segment slugs are collapsed by URL parsing into /settings/public/
  // itself — unhandled by this handler, the outer routing 404s them.
  for (const slug of ['missing', 'a%2Fb', 'x'.repeat(65), 'bad%20slug']) {
    const response = await request(`/settings/public/pages/${slug}`);
    assert.equal(response.handled, true, `slug ${slug} must be handled`);
    assert.equal(response.status, 404, `slug ${slug} must 404`);
  }
  for (const slug of ['..', '../..']) {
    const response = await request(`/settings/public/pages/${slug}`);
    assert.equal(response.handled, false, `slug ${slug} is collapsed by URL normalization`);
  }
});

test('a failed read serves the empty snapshot fail-open and reports the error once', async () => {
  const { request, errors } = harness(() => Promise.reject(new Error('snapshot store down')));
  const response = await request('/settings/public');
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body) as { data: Record<string, unknown> };
  assert.equal(payload.data.siteName, '');
  assert.deepEqual(payload.data.customPages, []);
  assert.equal(errors.length, 1);
});
