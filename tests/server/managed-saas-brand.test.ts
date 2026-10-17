import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPublicBrandSettingsHttpHandler } from '../../src/saas/platform/brand/http.js';
import { EMPTY_BRAND_SNAPSHOT, type PublicBrandSnapshot } from '../../src/saas/platform/brand/snapshot.js';
import { createGatewayHandler, serveMountedStatic } from '../../src/server/managed-saas.js';

/**
 * Batch 5 §5.2 OEM white-label: the two managed-SaaS injection points wired
 * end to end over a real HTTP server —
 *
 * 1. serveMountedStatic (the customer /console and platform /admin mounts):
 *    branded HTML carries window.__APP_CONFIG__ with a nonce'd script, the
 *    placeholder is rewritten and the CSP is snapshot-derived; the no-brand
 *    response stays byte-identical with the baseline CSP; non-HTML assets
 *    stream unchanged.
 * 2. createGatewayHandler: the unauthenticated GET /settings/public surface
 *    mounts ahead of the gateway routing with its own 404/405 semantics.
 */

const BRANDED: PublicBrandSnapshot = {
  ...EMPTY_BRAND_SNAPSHOT,
  siteName: 'Acme Router',
  siteLogo: 'https://cdn.oem.test/logo.png',
  customPages: [
    {
      slug: 'handbook',
      title: 'Handbook',
      mode: 'iframe',
      content: '',
      url: 'https://docs.acme.test/handbook',
      userIdParam: false,
      themeParam: false,
      langParam: false,
    },
  ],
};

const INDEX_HTML =
  '<!doctype html><html><head><title>x</title><script nonce="__MR_CSP_NONCE__">hook()</script></head><body></body></html>';
const BASELINE_CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

interface Response {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

async function listen(handler: http.RequestListener): Promise<Server> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function request(
  server: Server,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<Response> {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}

test('serveMountedStatic injects __APP_CONFIG__ with the derived CSP and keeps the no-brand path byte-identical', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'brand-dist-'));
  try {
    writeFileSync(join(dist, 'index.html'), INDEX_HTML);
    writeFileSync(join(dist, 'app.js'), 'console.log("app");\n');
    let snapshot: PublicBrandSnapshot = EMPTY_BRAND_SNAPSHOT;
    const handler: http.RequestListener = (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://brand.test').pathname;
      void serveMountedStatic(req, res, pathname, '/console', dist, {
        read: async () => snapshot,
      }).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    };
    const server = await listen(handler);
    try {
      // No brand: byte-identical body, baseline CSP, no-cache.
      const plain = await request(server, '/console/');
      assert.equal(plain.status, 200);
      assert.equal(plain.body, INDEX_HTML);
      assert.equal(plain.headers['content-security-policy'], BASELINE_CSP);
      assert.equal(plain.headers['cache-control'], 'no-cache');
      // Branded: config script injected before </head>, nonce rewritten,
      // CSP carries the nonce and the logo origin + iframe frame-src.
      snapshot = BRANDED;
      const branded = await request(server, '/console/');
      assert.equal(branded.status, 200);
      assert.ok(branded.body.includes('window.__APP_CONFIG__='));
      assert.ok(branded.body.includes('"siteName":"Acme Router"'));
      assert.ok(!branded.body.includes('__MR_CSP_NONCE__'));
      assert.ok(branded.body.indexOf('window.__APP_CONFIG__') < branded.body.indexOf('</head>'));
      const brandedCsp = branded.headers['content-security-policy'] ?? '';
      assert.match(String(brandedCsp), /script-src 'self' 'nonce-[^']+'/);
      assert.match(String(brandedCsp), /img-src 'self' data: https:\/\/cdn\.oem\.test/);
      assert.match(String(brandedCsp), /frame-src 'self' https:\/\/docs\.acme\.test/);
      // A brand-reader failure serves the empty snapshot fail-open.
      const server2 = await listen((_req, res) => {
        void serveMountedStatic(_req, res, '/console/', '/console', dist, {
          read: () => Promise.reject(new Error('store down')),
        }).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      try {
        const failed = await request(server2, '/console/');
        assert.equal(failed.status, 200);
        assert.equal(failed.body, INDEX_HTML);
        assert.equal(failed.headers['content-security-policy'], BASELINE_CSP);
      } finally {
        server2.close();
      }
      // Non-HTML assets stream with the fixed baseline CSP.
      const asset = await request(server, '/console/app.js');
      assert.equal(asset.status, 200);
      assert.equal(asset.body, 'console.log("app");\n');
      assert.equal(asset.headers['content-security-policy'], BASELINE_CSP);
      assert.equal(asset.headers['cache-control'], 'public, max-age=3600');
      // Client-side routing fallback still resolves to index.html (the
      // browser's text/html accept header).
      const deepLink = await request(server, '/console/settings/keys', 'GET', { accept: 'text/html' });
      assert.equal(deepLink.status, 200);
      assert.ok(deepLink.body.includes('window.__APP_CONFIG__='));
    } finally {
      server.close();
    }
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('createGatewayHandler mounts /settings/public ahead of the gateway routing', async () => {
  const server = await listen(
    createGatewayHandler(undefined, createPublicBrandSettingsHttpHandler({ read: async () => BRANDED })),
  );
  try {
    const publicBrand = await request(server, '/settings/public');
    assert.equal(publicBrand.status, 200);
    assert.equal((JSON.parse(publicBrand.body) as { data: { siteName: string } }).data.siteName, 'Acme Router');
    const page = await request(server, '/settings/public/pages/handbook');
    assert.equal(page.status, 404, 'iframe-mode pages have no markdown body endpoint');
    const method = await request(server, '/settings/public', 'POST');
    assert.equal(method.status, 405);
    // /metrics keeps its own contract; unknown /v1 paths without a gateway
    // composition answer GATEWAY_UNAVAILABLE (the pre-brand behavior).
    assert.equal((await request(server, '/metrics')).status, 200);
    const unavailable = await request(server, '/v1/messages');
    assert.equal(unavailable.status, 503);
  } finally {
    server.close();
  }
});
