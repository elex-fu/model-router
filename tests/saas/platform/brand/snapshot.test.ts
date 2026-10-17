import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BRAND_CSP_BASELINE,
  BRAND_CSP_NONCE_PLACEHOLDER,
  BRAND_SETTINGS_KEYS,
  BrandSettingsError,
  buildBrandContentSecurityPolicy,
  EMPTY_BRAND_SNAPSHOT,
  injectBrandAppConfig,
  isEmptyBrandSnapshot,
  type PublicBrandSnapshot,
  parseBrandCustomPagesSetting,
  parseBrandSiteLogoSetting,
  parseBrandSiteNameSetting,
  parsePublicBrandSnapshot,
  resolveBrandSnapshotFromSettings,
  sanitizeBrandUrl,
  serializeBrandAppConfigAssignment,
} from '../../../../src/saas/platform/brand/snapshot.js';
import { getPlatformSettingDefinition } from '../../../../src/saas/platform/settings/registry.js';

/**
 * Batch 5 §5.2 OEM white-label: the pure snapshot grammar — URL sanitization
 * allowlist, strict per-field parsers, the CSP derivation matrix, and the
 * `window.__APP_CONFIG__` injection with its XSS-escape negatives (the
 * sub2api setting_public.go / embed_on.go reference, ported to the shared
 * strict-grammar convention).
 */

const LOGO = 'https://cdn.oem.test/logo.png';
const FRAME = 'https://docs.oem.test/handbook';

function snapshot(overrides: Partial<PublicBrandSnapshot> = {}): PublicBrandSnapshot {
  return { ...EMPTY_BRAND_SNAPSHOT, ...overrides };
}

test('sanitizeBrandUrl accepts exactly the allowlist and rejects everything else', () => {
  // relative paths
  assert.equal(sanitizeBrandUrl('/logo.png', 'image'), '/logo.png');
  assert.equal(sanitizeBrandUrl('/console/legal', 'link'), '/console/legal');
  // http(s) absolute
  assert.equal(sanitizeBrandUrl('https://cdn.oem.test/logo.png', 'image'), 'https://cdn.oem.test/logo.png');
  assert.equal(sanitizeBrandUrl('http://internal.oem.test/logo.png', 'image'), 'http://internal.oem.test/logo.png');
  // mailto on the contact surface only
  assert.equal(sanitizeBrandUrl('mailto:ops@oem.test', 'contact'), 'mailto:ops@oem.test');
  // data: images on the image surface only
  assert.equal(sanitizeBrandUrl('data:image/png;base64,iVBORw0KGgo=', 'image'), 'data:image/png;base64,iVBORw0KGgo=');
  // negatives
  const rejects = (value: unknown, context: Parameters<typeof sanitizeBrandUrl>[1]) =>
    assert.throws(() => sanitizeBrandUrl(value, context), BrandSettingsError);
  rejects('javascript:alert(1)', 'image');
  rejects('JavaScript:alert(1)', 'link');
  rejects('javascript:alert(1)', 'frame');
  rejects('vbscript:msgbox(1)', 'link');
  rejects('file:///etc/passwd', 'link');
  rejects('data:text/html;base64,PHNjcmlwdD4=', 'image');
  rejects('data:image/png;base64,iVBORw0KGgo=', 'link');
  rejects('mailto:ops@oem.test', 'link');
  rejects('//cdn.oem.test/logo.png', 'image');
  rejects('https://oem.test/a b', 'link');
  rejects('https://oem.test/\u0007', 'link');
  rejects(42, 'link');
  rejects('', 'link');
  rejects('x'.repeat(2049), 'link');
});

test('site name and logo go through the strict per-key grammar', () => {
  assert.equal(parseBrandSiteNameSetting('  Acme Router '), 'Acme Router');
  // Empty clears (brand rows are never deleted; '' is the unset state).
  assert.equal(parseBrandSiteNameSetting(''), '');
  assert.throws(() => parseBrandSiteNameSetting('x'.repeat(65)), BrandSettingsError);
  assert.throws(() => parseBrandSiteNameSetting('bad\u0001name'), BrandSettingsError);
  assert.equal(parseBrandSiteLogoSetting(''), '');
  assert.equal(parseBrandSiteLogoSetting(LOGO), LOGO);
  assert.throws(() => parseBrandSiteLogoSetting('javascript:alert(1)'), BrandSettingsError);
});

test('custom pages enforce slug grammar, mode shape, bounds and uniqueness', () => {
  const pages = parseBrandCustomPagesSetting([
    { slug: 'terms', title: 'Terms', mode: 'markdown', content: '# Terms' },
    {
      slug: 'handbook',
      title: 'Handbook',
      mode: 'iframe',
      url: FRAME,
      userIdParam: true,
      themeParam: true,
    },
  ]);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0], {
    slug: 'terms',
    title: 'Terms',
    mode: 'markdown',
    content: '# Terms',
    url: '',
    userIdParam: false,
    themeParam: false,
    langParam: false,
  });
  assert.deepEqual(pages[1], {
    slug: 'handbook',
    title: 'Handbook',
    mode: 'iframe',
    content: '',
    url: FRAME,
    userIdParam: true,
    themeParam: true,
    langParam: false,
  });
  // negative matrix
  const rejects = (value: unknown) => assert.throws(() => parseBrandCustomPagesSetting(value), BrandSettingsError);
  rejects([{ slug: '../escape', title: 'x', mode: 'markdown', content: 'y' }]);
  rejects([{ slug: 'a/b', title: 'x', mode: 'markdown', content: 'y' }]);
  rejects([{ slug: 'x'.repeat(65), title: 'x', mode: 'markdown', content: 'y' }]);
  rejects([{ slug: 'ok', title: 'x', mode: 'teleport', content: 'y' }]);
  rejects([{ slug: 'ok', title: 'x', mode: 'markdown' }]);
  rejects([{ slug: 'ok', title: 'x', mode: 'markdown', content: 'y'.repeat(32 * 1024 + 1) }]);
  rejects([{ slug: 'ok', title: 'x', mode: 'iframe' }]);
  rejects([{ slug: 'ok', title: 'x', mode: 'iframe', url: 'javascript:alert(1)' }]);
  rejects([
    { slug: 'dup', title: 'x', mode: 'markdown', content: 'y' },
    { slug: 'dup', title: 'z', mode: 'markdown', content: 'w' },
  ]);
  rejects(
    Array.from({ length: 21 }, (_, index) => ({ slug: `p${index}`, title: 't', mode: 'markdown', content: 'c' })),
  );
});

test('resolveBrandSnapshotFromSettings fills absent keys with the empty defaults', () => {
  const composed = resolveBrandSnapshotFromSettings({
    [BRAND_SETTINGS_KEYS.siteName]: 'Acme Router',
    [BRAND_SETTINGS_KEYS.customMenuItems]: [{ label: 'Docs', url: 'https://docs.oem.test' }],
  });
  assert.equal(composed.siteName, 'Acme Router');
  assert.equal(composed.siteLogo, '');
  // Absolute URLs are stored in their URL-normalized form.
  assert.deepEqual(composed.customMenuItems, [{ label: 'Docs', url: 'https://docs.oem.test/' }]);
  assert.deepEqual(resolveBrandSnapshotFromSettings({}), EMPTY_BRAND_SNAPSHOT);
  // A corrupted stored row fails the whole compose (fail-closed materialization).
  assert.throws(
    () => resolveBrandSnapshotFromSettings({ [BRAND_SETTINGS_KEYS.siteLogo]: 'javascript:alert(1)' }),
    BrandSettingsError,
  );
});

test('parsePublicBrandSnapshot re-validates the materialized row shape', () => {
  const parsed = parsePublicBrandSnapshot({ siteName: 'Acme', frameAncestors: ['https://portal.oem.test'] });
  assert.equal(parsed.siteName, 'Acme');
  assert.deepEqual(parsed.frameAncestors, ['https://portal.oem.test']);
  assert.deepEqual(parsePublicBrandSnapshot({}), EMPTY_BRAND_SNAPSHOT);
  assert.throws(() => parsePublicBrandSnapshot('nope'), BrandSettingsError);
  assert.throws(() => parsePublicBrandSnapshot({ siteLogo: 'data:text/html;base64,x' }), BrandSettingsError);
  assert.throws(() => parsePublicBrandSnapshot({ frameAncestors: ['http://insecure.test'] }), BrandSettingsError);
  assert.throws(() => parsePublicBrandSnapshot({ frameAncestors: ['https://oem.test/path'] }), BrandSettingsError);
});

test('every brand settings key is registered in the platform settings registry as plain', () => {
  for (const key of Object.values(BRAND_SETTINGS_KEYS)) {
    const definition = getPlatformSettingDefinition(key);
    assert.ok(definition, `${key} must be registered`);
    assert.equal(definition.kind, 'plain', `${key} must be a plain (non-secret) key`);
    assert.equal(definition.key, key);
  }
});

test('CSP matrix: baseline, logo origin, iframe frame-src, frame-ancestors override, nonce', () => {
  // 1. The no-brand baseline is byte-identical to the pre-OEM header.
  assert.equal(buildBrandContentSecurityPolicy(EMPTY_BRAND_SNAPSHOT), BRAND_CSP_BASELINE);
  assert.equal(
    BRAND_CSP_BASELINE,
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  // 2. An external logo origin joins img-src; relative/data logos do not.
  assert.match(
    buildBrandContentSecurityPolicy(snapshot({ siteLogo: LOGO })),
    /img-src 'self' data: https:\/\/cdn\.oem\.test/,
  );
  assert.equal(buildBrandContentSecurityPolicy(snapshot({ siteLogo: '/logo.png' })), BRAND_CSP_BASELINE);
  assert.equal(
    buildBrandContentSecurityPolicy(snapshot({ siteLogo: 'data:image/png;base64,iVBORw0KGgo=' })),
    BRAND_CSP_BASELINE,
  );
  // 3. Iframe pages add frame-src with their origins; markdown pages do not.
  const withIframe = buildBrandContentSecurityPolicy(
    snapshot({
      customPages: [
        {
          slug: 'h',
          title: 'H',
          mode: 'iframe',
          content: '',
          url: FRAME,
          userIdParam: false,
          themeParam: false,
          langParam: false,
        },
      ],
    }),
  );
  assert.match(withIframe, /frame-src 'self' https:\/\/docs\.oem\.test/);
  assert.doesNotMatch(buildBrandContentSecurityPolicy(EMPTY_BRAND_SNAPSHOT), /frame-src/);
  // 4. frame-ancestors is replaced only by explicit configuration.
  assert.match(
    buildBrandContentSecurityPolicy(snapshot({ frameAncestors: ['https://portal.oem.test', 'https://hub.oem.test'] })),
    /frame-ancestors https:\/\/portal\.oem\.test https:\/\/hub\.oem\.test$/,
  );
  // 5. The injection nonce adds script-src and nothing else changes.
  const withNonce = buildBrandContentSecurityPolicy(snapshot({ siteName: 'Acme' }), { scriptNonce: 'n-123' });
  assert.match(withNonce, /script-src 'self' 'nonce-n-123'/);
  assert.ok(withNonce.endsWith("frame-ancestors 'none'"));
  // 6. A URL can never smuggle CSP syntax: origins are URL.parsed.
  const crafted = buildBrandContentSecurityPolicy(snapshot({ siteLogo: 'https://oem.test/a.png;script-src%20*' }));
  assert.doesNotMatch(crafted, /script-src \*/);
});

test('__APP_CONFIG__ serialization escapes every HTML breaker (XSS negatives)', () => {
  const hostile = snapshot({
    siteName: '</script><script>alert(1)</script>',
    siteSubtitle: '<>&\u2028\u2029',
  });
  const assignment = serializeBrandAppConfigAssignment(hostile);
  assert.ok(assignment.startsWith('{'));
  // No raw breaker survives inside the JSON payload.
  assert.ok(!assignment.includes('<'), 'raw < must not survive');
  assert.ok(!assignment.includes('>'), 'raw > must not survive');
  assert.ok(!assignment.includes('&'), 'raw & must not survive');
  assert.ok(!assignment.includes('\u2028'), 'raw U+2028 must not survive');
  assert.ok(!assignment.includes('\u2029'), 'raw U+2029 must not survive');
  // The escapes are the JSON \u forms, so the payload still parses.
  const parsed = JSON.parse(assignment) as Record<string, unknown>;
  assert.equal(parsed.siteName, '</script><script>alert(1)</script>');
  assert.equal(parsed.siteSubtitle, '<>&\u2028\u2029');
});

test('injectBrandAppConfig: no-brand passthrough, branded injection, nonce rewrite, headless fallback', () => {
  const html = `<!doctype html><html><head><title>x</title><script nonce="${BRAND_CSP_NONCE_PLACEHOLDER}">hook()</script></head><body></body></html>`;
  // Empty snapshot: byte-identical html + baseline CSP.
  const passthrough = injectBrandAppConfig(html, EMPTY_BRAND_SNAPSHOT);
  assert.equal(passthrough.html, html);
  assert.equal(passthrough.contentSecurityPolicy, BRAND_CSP_BASELINE);
  // Branded: config script before </head>, placeholder rewritten, CSP nonce'd.
  const branded = injectBrandAppConfig(html, snapshot({ siteName: 'Acme', siteLogo: LOGO }));
  assert.ok(branded.html.includes('<script nonce="'));
  assert.ok(branded.html.includes('window.__APP_CONFIG__='));
  assert.ok(branded.html.includes('"siteName":"Acme"'));
  assert.ok(!branded.html.includes(BRAND_CSP_NONCE_PLACEHOLDER));
  assert.match(branded.contentSecurityPolicy, /script-src 'self' 'nonce-[^']+'/);
  assert.match(branded.contentSecurityPolicy, /img-src 'self' data: https:\/\/cdn\.oem\.test/);
  // The injected script must be self-contained before </head> (no </script> inside the JSON).
  const injectedScript = /<script nonce="[^"]+">window\.__APP_CONFIG__=([\s\S]*?);<\/script>/.exec(branded.html);
  assert.ok(injectedScript, 'the config script must parse as one element');
  // HTML without </head>: the script is prepended instead of dropped.
  const headless = injectBrandAppConfig('<html><body></body></html>', snapshot({ siteName: 'Acme' }));
  assert.ok(headless.html.startsWith('<script nonce="'));
  assert.ok(isEmptyBrandSnapshot(EMPTY_BRAND_SNAPSHOT));
});
