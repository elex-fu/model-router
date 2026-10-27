import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const nodeCommand =
  'node --test scripts/performance/bounded-business-cluster.test.cjs scripts/performance/bounded-business-capacity-probe.test.cjs';
const pythonCommand = "python3 -m unittest discover -s scripts/performance -p 'bounded_business_*_test.py'";

function validate(source: string): void {
  const buildJob = source.split('\n  build-and-test:\n')[1]?.split(/^ {2}[a-z][a-z-]+:\n/m)[0];
  assert.ok(buildJob, 'reuse the existing build-and-test job, not another matrix');
  assert.doesNotMatch(buildJob, /^ {4}(?:if|continue-on-error):/m);
  const step = buildJob
    .split('      - name: Run bounded business diagnostic harness tests\n')[1]
    ?.split('\n      - ')[0];
  assert.ok(step, 'diagnostic tests must execute in CI, not merely exist in scripts/');
  assert.doesNotMatch(step, /(?:if|continue-on-error):|\|\|\s*true|--execute|--scene|--pending-term/);
  assert.equal(step.trim(), `run: |\n          ${nodeCommand}\n          ${pythonCommand}`);
  assert.ok(
    buildJob.indexOf('run: npm test') < buildJob.indexOf('name: Run bounded business diagnostic harness tests'),
  );
}

test('bounded diagnostic lifecycle and Python harness tests execute in existing offline CI job', () =>
  validate(workflow));
test('diagnostic CI wiring rejects omitted, replaced, conditional or swallowed test execution', () => {
  for (const [before, after] of [
    [nodeCommand, 'echo skipped lifecycle'],
    [pythonCommand, 'echo skipped adapter'],
    [nodeCommand, `${nodeCommand} || true`],
    [
      '      - name: Run bounded business diagnostic harness tests\n',
      '      - name: Run bounded business diagnostic harness tests\n        if: false\n',
    ],
    ['  build-and-test:\n', '  build-and-test:\n    continue-on-error: true\n'],
  ])
    assert.throws(() => validate(workflow.replace(before, after)));
});
