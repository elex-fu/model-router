import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdminJobs } from '../../src/admin/jobs.js';
import { ControlStore } from '../../src/control/store.js';

test('job.progress reports queued, running and terminal transitions without job output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-sse-jobs-'));
  const store = new ControlStore(dir);
  const events: Array<Record<string, unknown>> = [];
  const jobs = new AdminJobs(store, (event) => events.push(event));
  try {
    const started = jobs.start('maintenance', 'admin', async () => ({ privateOutput: 'credential-value' }));
    assert.equal(started.state, 'queued');
    for (let attempt = 0; attempt < 100 && jobs.get(started.jobId).state !== 'completed'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(jobs.get(started.jobId).state, 'completed');
    assert.deepEqual(
      events.map((event) => event.state),
      ['queued', 'running', 'completed'],
    );
    assert.ok(events.every((event) => event.jobId === started.jobId && event.type === 'maintenance'));
    assert.equal(JSON.stringify(events).includes('credential-value'), false);
  } finally {
    jobs.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancellation is scoped, idempotent and cannot rewrite a completed job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-cancel-jobs-'));
  const store = new ControlStore(dir);
  const jobs = new AdminJobs(store);
  let finish!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  try {
    const running = jobs.start('upstream-test', 'admin', (jobSignal) => {
      signal = jobSignal;
      return new Promise((resolve) => { finish = resolve; });
    }, 'upstream-a');
    for (let attempt = 0; attempt < 100 && !finish; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(jobs.get(running.jobId).state, 'running');
    assert.throws(() => jobs.cancel(running.jobId, 'admin', 'upstream-test', 'upstream-b'), /does not match/);
    assert.equal(jobs.cancel(running.jobId, 'admin', 'upstream-test', 'upstream-a').state, 'cancelled');
    assert.equal(signal?.aborted, true);
    assert.equal(jobs.cancel(running.jobId, 'admin', 'upstream-test', 'upstream-a').state, 'cancelled');
    finish({ late: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(jobs.get(running.jobId).state, 'cancelled');
    assert.equal(jobs.get(running.jobId).result, null);

    const done = jobs.start('upstream-test', 'admin', async () => ({ ok: true }), 'upstream-a');
    for (let attempt = 0; attempt < 100 && jobs.get(done.jobId).state !== 'completed'; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(jobs.cancel(done.jobId, 'admin', 'upstream-test', 'upstream-a').state, 'completed');
    assert.deepEqual(jobs.get(done.jobId).result, { ok: true });

    const maintenance = jobs.start('maintenance', 'admin', async () => ({}));
    assert.throws(() => jobs.cancel(maintenance.jobId, 'admin', 'upstream-test'), /does not match/);
  } finally {
    jobs.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
