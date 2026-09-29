import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';

const mode = process.argv[2];
const provider = process.argv[3];
if (!['unit', 'integration', 'live'].includes(mode) || (provider && !['kimi', 'deepseek', 'ollama'].includes(provider))) {
  console.error('Usage: node scripts/run-tests.mjs <unit|integration|live> [kimi|deepseek|ollama]');
  process.exit(2);
}
if (provider && mode !== 'live') {
  console.error('Provider selection is only available for live tests.');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const testsRoot = join(root, 'tests');
function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? discover(path) : entry.name.endsWith('.test.ts') ? [path] : [];
  });
}
const paths = discover(testsRoot).sort();
function isLive(path) {
  return path.startsWith(`integration${sep}`) && path.endsWith('-live.test.ts');
}
function isIntegration(path) {
  return ['integration', 'admin', 'control', 'storage'].some((directory) => path.startsWith(`${directory}${sep}`))
    || path.endsWith('.integration.test.ts');
}
const selected = paths.filter((path) => {
  const name = relative(testsRoot, path);
  if (mode === 'live') return isLive(name) && (!provider || name === join('integration', `${provider}-live.test.ts`));
  if (isLive(name)) return false;
  return mode === 'integration' ? isIntegration(name) : !isIntegration(name);
});
if (!selected.length) {
  console.error(`No ${mode} tests found${provider ? ` for ${provider}` : ''}.`);
  process.exit(2);
}

const env = { ...process.env };
if (provider) env[`RUN_${provider.toUpperCase()}_SMOKE`] = '1';
console.log(`Running ${selected.length} ${mode} test files${provider ? ` (${provider})` : ''}.`);
const result = spawnSync(process.execPath, ['--test', '--import', 'tsx', '--test-reporter=spec', ...selected], {
  cwd: root,
  env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
