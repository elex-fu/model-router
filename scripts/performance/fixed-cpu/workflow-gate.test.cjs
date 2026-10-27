'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { authorizedEvent, waitForCorrectness, REF, MARKER, TOKEN } = require('./workflow-gate.cjs');
const context = { repo: { owner: 'elex-fu', repo: 'model-router' }, ref: REF, eventName: 'push', sha: 'a'.repeat(40), payload: { head_commit: { message: MARKER } } };
test('only exact approved repository/ref/message or explicit dispatch authorization runs quota', () => {
  assert.equal(authorizedEvent(context), true);
  for (const other of [{ ...context, repo: { owner: 'someone', repo: 'model-router' } }, { ...context, ref: 'refs/heads/main' }, { ...context, eventName: 'pull_request' }, { ...context, payload: { head_commit: { message: `ordinary change mentioning ${MARKER}` } } }]) assert.equal(authorizedEvent(other, TOKEN), false);
  assert.equal(authorizedEvent({ ...context, eventName: 'workflow_dispatch' }, TOKEN), true);
  assert.equal(authorizedEvent({ ...context, eventName: 'workflow_dispatch' }, ''), false);
});
function githubWith(status, conclusion = null) {
  return { rest: { actions: { listWorkflowRuns: async ({ workflow_id }) => ({ data: { workflow_runs: [{ id: workflow_id, head_sha: context.sha, head_branch: REF.slice(11), status, conclusion }] } }), listJobsForWorkflowRun() {} } },
    paginate: async () => ['15', '18'].map(pg => ({ name: `Native fast gateway required (PG ${pg}, Redis, bounded-two)`, conclusion: 'success' })) };
}
test('same-SHA green CI and both actual bounded native jobs required', async () => {
  const result = await waitForCorrectness({ github: githubWith('completed', 'success'), context });
  assert.equal(result.accepted, true);
  const github = githubWith('completed', 'success'); github.paginate = async () => [];
  await assert.rejects(waitForCorrectness({ github, context }), /COMPILED_NATIVE_GATE_MISSING/);
  await assert.rejects(waitForCorrectness({ github: githubWith('completed', 'failure'), context }), /CORRECTNESS_FAILED/);
});
test('pending/wrong-SHA workflows wait only bounded time and never dispatch another run', async () => {
  let clock = 0, polls = 0;
  const github = githubWith('in_progress');
  const original = github.rest.actions.listWorkflowRuns;
  github.rest.actions.listWorkflowRuns = async input => { polls++; return original(input); };
  await assert.rejects(waitForCorrectness({ github, context, timeoutMs: 50, now: () => clock, sleep: async ms => { clock += ms; } }), /WAIT_TIMEOUT/);
  assert.equal(clock, 50); assert.equal(polls, 2);
  const wrong = githubWith('completed', 'success');
  wrong.rest.actions.listWorkflowRuns = async () => ({ data: { workflow_runs: [{ head_sha: 'wrong', status: 'completed', conclusion: 'success' }] } });
  clock = 0;
  await assert.rejects(waitForCorrectness({ github: wrong, context, timeoutMs: 50, now: () => clock, sleep: async ms => { clock += ms; } }), /WAIT_TIMEOUT/);
});
