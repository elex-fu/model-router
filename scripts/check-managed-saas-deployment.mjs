#!/usr/bin/env node
// B3/RUN-01 executable least-privilege check for managed SaaS deployments.
// Verifies the supervisor/env-file posture documented in
// deploy/systemd/managed-saas/README.md without printing any secret value:
// only key names, file modes and directive presence are ever reported.
//
// Usage:
//   node scripts/check-managed-saas-deployment.mjs [--units <dir>] [--env <dir>]
//
// Defaults: --units /etc/systemd/system --env /etc/model-router-saas
// Installed units are also compared against the reviewed repo copies under
// deploy/systemd/managed-saas/.
// Exit: 0 all pass, 1 any check failed, 2 usage/io error.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (index + 1 >= args.length) {
    console.error(`check-managed-saas-deployment: --${name} requires a value`);
    process.exit(2);
  }
  return args[index + 1];
}
const unitsDir = option('units', '/etc/systemd/system');
const envDir = option('env', '/etc/model-router-saas');
const root = resolve(import.meta.dirname, '..');

const UNITS = {
  'model-router-saas-control-plane.service': 'control-plane',
  'model-router-saas-gateway.service': 'gateway',
  'model-router-saas-credential-validation-worker.service': 'credential-validation-worker',
};
const TARGET = 'model-router-saas.target';
const ROLE_DB_ENV = {
  'control-plane': 'MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL',
  gateway: 'MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL',
  'credential-validation-worker': 'MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL',
};
const ALL_DB_ENVS = new Set([...Object.values(ROLE_DB_ENV), 'MODEL_ROUTER_SAAS_DATABASE_URL']);
const SECRET_KEY = /(DATABASE_URL|MASTER_KEY|PASSWORD|SECRET|TOKEN)$/;
const REQUIRED_UNIT_DIRECTIVES = [
  'NoNewPrivileges=true',
  'PrivateTmp=true',
  'ProtectSystem=strict',
  'ProtectHome=true',
  'Restart=on-failure',
  'Environment=NODE_ENV=production',
  'Environment=MODEL_ROUTER_DEPLOYMENT_MODE=managed-saas',
];

let failures = 0;
function check(ok, label, detail) {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}\n`);
  if (!ok) failures += 1;
}

function parseEnvFile(path) {
  const entries = new Map();
  const duplicates = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { error: `unparseable line: ${line.slice(0, eq < 0 ? 24 : eq)}` };
    const key = line.slice(0, eq);
    if (entries.has(key)) duplicates.push(key);
    entries.set(key, line.slice(eq + 1));
  }
  return { entries, duplicates };
}

function checkUnit(name, role) {
  const label = `unit ${name}`;
  const path = resolve(unitsDir, name);
  if (!existsSync(path)) {
    check(false, label, 'not installed');
    return;
  }
  const text = readFileSync(path, 'utf8');
  for (const directive of REQUIRED_UNIT_DIRECTIVES) {
    check(text.includes(directive), `${label} ${directive.split('=')[0]}`);
  }
  check(text.includes(`start --role ${role}`), `${label} exec role`);
  const directives = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  check(!directives.some((line) => /^Restart=always\s*$/.test(line.trim())), `${label} restart not always`);
  // No inline secret assignments in unit files: Environment=KEY=<non-empty>
  // for secret-shaped keys is a leak; EnvironmentFile references are fine.
  const inlineSecrets = directives
    .filter((line) => line.startsWith('Environment=') && SECRET_KEY.test(line.split('=')[1] ?? '')
      && line.split('=').slice(2).join('=').trim() !== '');
  check(inlineSecrets.length === 0, `${label} no inline secrets`);
}

function checkEnvFile(name, { requiredKeys = [], forbiddenValueKeys = [], secret = false }) {
  const label = `env ${name}`;
  const path = resolve(envDir, name);
  if (!existsSync(path)) {
    check(false, label, 'missing');
    return;
  }
  const stat = statSync(path);
  const mode = stat.mode & 0o777;
  // Secret files: owner-only (no group/other). Shared metadata: no other.
  const forbiddenBits = secret ? 0o077 : 0o007;
  check((mode & forbiddenBits) === 0 && (mode & 0o700) !== 0, `${label} mode`, `mode ${mode.toString(8)} too permissive`);
  const parsed = parseEnvFile(path);
  if (parsed.error) {
    check(false, label, parsed.error);
    return;
  }
  check(parsed.duplicates.length === 0, `${label} duplicates`, parsed.duplicates.join(','));
  for (const key of requiredKeys) {
    check(parsed.entries.has(key) && parsed.entries.get(key).trim() !== '', `${label} ${key}`, 'missing or empty');
  }
  for (const key of parsed.entries.keys()) {
    if (forbiddenValueKeys.includes(key) && parsed.entries.get(key).trim() !== '') {
      check(false, `${label} ${key}`, 'must not be set here');
    }
  }
}

for (const [name, role] of Object.entries(UNITS)) checkUnit(name, role);
check(existsSync(resolve(unitsDir, TARGET)), `unit ${TARGET}`, 'not installed');

checkEnvFile('common.env', {
  requiredKeys: ['MODEL_ROUTER_SAAS_DEPLOYMENT_ID', 'MODEL_ROUTER_SAAS_ENVIRONMENT_ID'],
  forbiddenValueKeys: [...ALL_DB_ENVS, 'MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY',
    'MODEL_ROUTER_SAAS_SOFTWARE_KMS_PREVIOUS_MASTER_KEYS'],
});
for (const [role, dbEnv] of Object.entries(ROLE_DB_ENV)) {
  const others = [...ALL_DB_ENVS].filter((key) => key !== dbEnv);
  checkEnvFile(`${role}.env`, {
    secret: true,
    requiredKeys: [dbEnv],
    forbiddenValueKeys: others,
  });
}

// Installed units must not drift from the reviewed repo copies.
for (const name of [...Object.keys(UNITS), TARGET]) {
  const installed = resolve(unitsDir, name);
  const reviewed = resolve(root, 'deploy/systemd/managed-saas', name);
  if (!existsSync(installed) || !existsSync(reviewed)) continue;
  check(readFileSync(installed, 'utf8') === readFileSync(reviewed, 'utf8'), `unit ${name} matches reviewed copy`);
}

process.exit(failures === 0 ? 0 : 1);
