import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

function initializer(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `missing fixture declaration: ${declaration}`);
  assert.equal(source.lastIndexOf(declaration), start, 'fixture declaration must be unique');
  const end = source.indexOf('};', start);
  assert.ok(end > start, 'fixture initializer must be complete');
  return source.slice(start + declaration.length, end);
}

test('FIN057 admission and signed evidence use the same published route version', () => {
  // Source contract only: do not import the PG fixture or an integration root.
  const source = readFileSync(resolve(process.cwd(), 'tests/saas/metering/normal-success-postgres-fixture.ts'), 'utf8');
  assert.match(source, /const route = await phase\('setup', \(\) => routes\.publish\(\{/);
  const routeFacts = initializer(source, 'const routeFacts = {');
  assert.match(routeFacts, /\brouteConfigVersion:\s*route\.version\b/);

  for (const declaration of [
    'const admissionInput: PreparedRequestAdmissionInput = {',
    'const unsigned: PreparedRequestEvidenceInput = {',
  ]) {
    const input = initializer(source, declaration);
    assert.match(input, /\.\.\.routeFacts\b/);
    const configVersions = [...input.matchAll(/\bconfigVersion:\s*([^,\n}]+)/g)]
      .map((match) => match[1]?.trim());
    assert.deepEqual(configVersions, ['route.version'], 'configVersion must bind the published version exactly once');
  }
});
