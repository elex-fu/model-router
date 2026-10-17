/**
 * Privilege-mirror generator CLI (DOps-2026-10-17 plan §4).
 *
 *   npx tsx scripts/generate-privileges.ts            regenerate the four mirror files
 *   npx tsx scripts/generate-privileges.ts --check    verify byte-identity, exit 1 on drift
 *   npx tsx scripts/generate-privileges.ts --extract  reverse-extract the manifest from
 *                                                     the current mirrors (one-time bootstrap;
 *                                                     overwrites hand edits to the manifest)
 *
 * The generation engine lives in src/saas/db/privileges-generation.ts so it is
 * type-checked, linted and directly importable from the regenerability tests.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MIRROR_REGENERATIONS,
  extractPrivilegeManifest,
  readMirror,
  regenerateMirrorContents,
  serializePrivilegeManifest,
} from '../src/saas/db/privileges-generation.js';

const mode = process.argv[2] ?? '';

if (mode === '--extract') {
  const manifestPath = resolve(process.cwd(), 'src/saas/db/privileges-manifest.ts');
  writeFileSync(manifestPath, serializePrivilegeManifest(extractPrivilegeManifest()));
  console.log(`manifest written: ${manifestPath}`);
  process.exit(0);
}

const regenerated = regenerateMirrorContents();
let drift = false;
for (const mirror of MIRROR_REGENERATIONS) {
  const current = readMirror(mirror.path);
  const expected = regenerated[mirror.path];
  if (current === expected) {
    console.log(`up to date: ${mirror.path}`);
    continue;
  }
  drift = true;
  if (mode === '--check') {
    console.error(`DRIFT: ${mirror.path} differs from its regeneration from the manifest`);
  } else {
    writeFileSync(resolve(process.cwd(), mirror.path), expected);
    console.log(`regenerated: ${mirror.path}`);
  }
}
if (drift && mode !== '--check') {
  console.log('mirror files regenerated; review the diff and commit it together with the manifest change.');
}
process.exit(drift && mode === '--check' ? 1 : 0);
