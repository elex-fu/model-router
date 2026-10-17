import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLocalBrandSnapshot } from '../../../../src/saas/platform/brand/local.js';

/**
 * Batch 5 §5.2 OEM white-label: the BYOK local brand.json override — same
 * strict grammar as the materialized SaaS snapshot, missing file = empty
 * snapshot, invalid file fails closed to the empty snapshot.
 */

test('a missing brand.json is the empty snapshot', () => {
  const snapshot = readLocalBrandSnapshot(join(tmpdir(), 'definitely-missing-brand.json'));
  assert.equal(snapshot.siteName, '');
  assert.equal(snapshot.customPages.length, 0);
});

test('a valid brand.json parses with the shared strict grammar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-local-'));
  try {
    const path = join(dir, 'brand.json');
    writeFileSync(
      path,
      JSON.stringify({
        siteName: 'Acme Router',
        siteLogo: 'https://cdn.oem.test/logo.png',
        customPages: [{ slug: 'terms', title: 'Terms', mode: 'markdown', content: '# Terms' }],
        frameAncestors: ['https://portal.acme.test'],
      }),
    );
    const snapshot = readLocalBrandSnapshot(path);
    assert.equal(snapshot.siteName, 'Acme Router');
    assert.equal(snapshot.siteLogo, 'https://cdn.oem.test/logo.png');
    assert.equal(snapshot.customPages[0]?.slug, 'terms');
    assert.deepEqual(snapshot.frameAncestors, ['https://portal.acme.test']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid brand.json fails closed to the empty snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-local-'));
  try {
    const path = join(dir, 'brand.json');
    writeFileSync(path, '{not json');
    assert.equal(readLocalBrandSnapshot(path).siteName, '');
    writeFileSync(path, JSON.stringify({ siteLogo: 'javascript:alert(1)' }));
    assert.equal(readLocalBrandSnapshot(path).siteLogo, '');
    assert.equal(readLocalBrandSnapshot(path).siteName, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
