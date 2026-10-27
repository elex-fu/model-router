import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const command = "python3 -m unittest discover -s scripts/performance -p 'sub2api_fresh_*_test.py'";
const stepName = '      - name: Run pinned Sub2api diagnostic runner unit tests\n';

function validate(source: string): void {
  const build = source.split('\n  build-and-test:\n')[1]?.split(/^ {2}[a-z][a-z-]+:\n/m)[0];
  assert.ok(build, 'reuse existing offline build-and-test job');
  assert.doesNotMatch(build, /^ {4}(?:if|continue-on-error):/m);
  const step = build.split(stepName)[1]?.split('\n      - ')[0];
  assert.ok(step, 'pure Python tests must execute, not just exist');
  assert.equal(step.trim(), `run: ${command}`);
  assert.doesNotMatch(step, /--execute|--generation|continue-on-error|\|\|\s*true/);
  assert.ok(build.indexOf('run: npm test') < build.indexOf(stepName));
}

test('pinned Sub2api runner pure tests execute in the existing offline CI job', () => validate(workflow));
test('Sub2api diagnostic wiring rejects skipped, swallowed or real-workload commands', () => {
  for (const [before, after] of [
    [command, 'echo skipped'],
    [command, `${command} || true`],
    [command, 'python3 scripts/performance/sub2api_fresh_performance_pilot.py --execute'],
    [stepName, `${stepName}        if: false\n`],
    ['  build-and-test:\n', '  build-and-test:\n    continue-on-error: true\n'],
  ])
    assert.throws(() => validate(workflow.replace(before, after)));
});
