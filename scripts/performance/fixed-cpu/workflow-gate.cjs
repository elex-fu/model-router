'use strict';
// Read-only correctness gate for an explicitly authorized diagnostic commit.
const REPOSITORY = 'elex-fu/model-router';
const REF = 'refs/heads/perf/db-hotpath-20261026';
const MARKER = '[run-fixed-cpu-quota]';
const TOKEN = 'RUN_FIXED_CPU_DIAGNOSTIC';
function authorizedEvent(context, authorization) {
  if (`${context.repo.owner}/${context.repo.repo}` !== REPOSITORY || context.ref !== REF) return false;
  if (context.eventName === 'push') return context.payload?.head_commit?.message === MARKER;
  return context.eventName === 'workflow_dispatch' && authorization === TOKEN;
}
async function waitForCorrectness({ github, context, authorization, observe = () => {},
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 15 * 60000 }) {
  if (!authorizedEvent(context, authorization)) throw new Error('QUOTA_EXPLICIT_REPOSITORY_REF_MARKER_AUTHORIZATION_REQUIRED');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60000) throw new Error('QUOTA_GATE_WAIT_BOUND');
  const deadline = now() + timeoutMs;
  const evidence = { sourceSha: context.sha, repository: REPOSITORY, ref: REF, event: context.eventName, checks: [], accepted: false };
  while (now() < deadline) {
    const checks = [];
    for (const workflow_id of ['ci.yml', 'fast-gateway-required.yml']) {
      const response = await github.rest.actions.listWorkflowRuns({ ...context.repo, workflow_id, head_sha: context.sha, per_page: 100 });
      const run = response.data.workflow_runs.find(candidate => candidate.head_sha === context.sha && candidate.head_branch === REF.slice('refs/heads/'.length));
      const check = { workflow: workflow_id, runId: run?.id ?? null, status: run?.status ?? 'not-created', conclusion: run?.conclusion ?? null };
      checks.push(check);
      if (run?.status === 'completed' && run.conclusion !== 'success') {
        evidence.checks = checks; observe(evidence);
        throw new Error(`QUOTA_CORRECTNESS_FAILED:${workflow_id}:${run.conclusion}`);
      }
    }
    evidence.checks = checks;
    observe(evidence);
    if (checks.every(check => check.status === 'completed' && check.conclusion === 'success')) {
      const fast = checks.find(check => check.workflow === 'fast-gateway-required.yml');
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { ...context.repo, run_id: fast.runId, per_page: 100 });
      for (const pg of ['15', '18']) {
        const name = `Native fast gateway required (PG ${pg}, Redis, bounded-two)`;
        if (!jobs.some(job => job.name === name && job.conclusion === 'success')) throw new Error(`QUOTA_COMPILED_NATIVE_GATE_MISSING:${name}`);
      }
      evidence.accepted = true;
      observe(evidence);
      return evidence;
    }
    await sleep(Math.min(15000, Math.max(1, deadline - now())));
  }
  throw new Error('QUOTA_CORRECTNESS_WAIT_TIMEOUT');
}
module.exports = { authorizedEvent, waitForCorrectness, REPOSITORY, REF, MARKER, TOKEN };
