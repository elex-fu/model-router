#!/usr/bin/env node
import { resolve } from 'node:path';
import { sourceIdentity } from './ci/gate-evidence.mjs';
import { readReleaseManifest, releaseReadiness } from './ci/release-readiness.mjs';

const path = process.argv[2];
if (!path || process.argv.length !== 3) {
  console.error('Usage: node scripts/check-release-readiness.mjs /path/to/release-manifest.json');
  process.exit(2);
}
try {
  const result = releaseReadiness(readReleaseManifest(path), sourceIdentity(resolve(import.meta.dirname, '..')));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
} catch {
  console.error('NO-GO: release manifest or candidate source cannot be read');
  process.exitCode = 1;
}
