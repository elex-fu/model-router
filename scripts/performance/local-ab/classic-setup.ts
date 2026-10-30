// Classic-mode performance baseline setup (plan D2 prerequisite,
// docs/standalone-relay-capability-plan-2026-10-30.md).
//
// Creates a fresh V2 configuration (defaultConfigV2) in a run directory,
// then drives the offline CLI to register the benchmark upstream + proxy key
// and captures the generated key into <dir>/api-key. The classic server is
// started separately (see run-classic-baseline.sh) so the baseline measures
// the full production path including SQLite telemetry.
//
// Usage: node --import tsx scripts/performance/local-ab/classic-setup.mts <runDir> [proxyPort] [adminPort]
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defaultConfigV2 } from '../../../src/config/v2-schema.js';

const runDir = resolve(process.argv[2] ?? '/tmp/mr-classic-bench');
const proxyPort = Number(process.argv[3] ?? 19005);
const adminPort = Number(process.argv[4] ?? 19006);
// Run from the repository root (the sibling run-*.sh scripts enforce this).
const repoRoot = process.cwd();

mkdirSync(runDir, { recursive: true });
const configPath = resolve(runDir, 'config.json');
const config = defaultConfigV2(configPath, `classic-bench-${randomUUID()}`);
config.server.port = proxyPort;
config.server.publicProxyBaseUrl = `http://127.0.0.1:${proxyPort}`;
config.admin.port = adminPort;
config.admin.publicAdminBaseUrl = `http://127.0.0.1:${adminPort}`;
config.storage.dataDir = runDir;
writeFileSync(configPath, JSON.stringify(config, null, 2));

const cli = (...args: string[]) =>
  execFileSync(process.execPath, ['dist/cli/index.js', ...args, '-c', configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });

// The TLS mock from the local-ab tooling (same source as the SaaS runs).
cli(
  'upstream:add',
  'bench',
  'custom-openai',
  'openai',
  'https://127.0.0.1:18453',
  'sk-classic-bench-key',
  '--models',
  'native-fast-ci-model',
);
const keyOutput = cli('key:create', 'bench');
const match = /^Key: (\S+)$/m.exec(keyOutput);
if (!match) throw new Error(`key:create output missing key:\n${keyOutput}`);
writeFileSync(resolve(runDir, 'api-key'), `${match[1]}\n`, { mode: 0o600 });
console.log(JSON.stringify({ runDir, configPath, proxyPort, adminPort }));
