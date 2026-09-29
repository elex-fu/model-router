import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ControlService } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';

const upstream = {
  id: 'upstream-one',
  name: 'Local upstream',
  provider: 'custom' as const,
  protocol: 'openai' as const,
  enabled: true,
  baseUrl: 'http://127.0.0.1:11434/v1',
  endpoints: { generate: 'chat/completions' },
  auth: { mode: 'none' as const },
  credentials: [],
  models: [],
  priority: 0,
  sortIndex: 0,
  policy: { allowInsecureHttp: true },
};

test('upstream.changed follows successful commits and is absent for failed config commits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-sse-config-'));
  const store = new ControlStore(dir);
  try {
    const control = new ControlService(join(dir, 'config.json'), store, undefined, async () => {
      throw new Error('runtime apply failed');
    });
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    control.subscribe(({ type, data }) => events.push({ type, data }));
    const initial = await control.raw();
    await control.commit({ ...initial, upstreams: [upstream] }, initial.revision, 'admin');
    assert.deepEqual(
      events.map((event) => event.type),
      ['config.apply_failed'],
    );

    const recovered = new ControlService(join(dir, 'config.json'), store);
    const current = await recovered.raw();
    const appliedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    recovered.subscribe(({ type, data }) => appliedEvents.push({ type, data }));
    const nextUpstreams = current.upstreams.length
      ? current.upstreams.map((item) => ({ ...item, name: 'Changed local upstream' }))
      : [upstream];
    await recovered.commit({ ...current, upstreams: nextUpstreams }, current.revision, 'admin');
    assert.deepEqual(
      appliedEvents.map((event) => event.type),
      ['config.persisted', 'upstream.changed'],
    );
    assert.deepEqual(
      appliedEvents[1].data.changedUpstreamIds,
      nextUpstreams.map((item) => item.id),
    );
    assert.equal(appliedEvents[1].data.persistedRevision, current.revision + 1);
    assert.equal(appliedEvents[1].data.effectiveRevision, current.revision);
    assert.equal(Object.hasOwn(appliedEvents[1].data, 'upstreamIds'), false);
    assert.equal(JSON.stringify(appliedEvents).includes('127.0.0.1'), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SSE event allowlists strip unexpected secrets, config and result fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-sse-allowlist-'));
  const store = new ControlStore(dir);
  try {
    const control = new ControlService(join(dir, 'config.json'), store);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    control.subscribe(({ type, data }) => events.push({ type, data }));
    control.publishEvent('upstream.changed', {
      persistedRevision: 2,
      effectiveRevision: 1,
      changedUpstreamIds: ['changed-only'],
      upstreamIds: ['changed-only', 'unchanged'],
      config: { credentials: 'private-config' },
      secret: 'credential-value',
    });
    control.publishEvent('request.completed', {
      requestId: 'request-1',
      outcome: 'success',
      status: 200,
      model: 'model-a',
      protocol: 'openai',
      source: 'production',
      durationMs: 12,
      result: { secret: 'private-result' },
      config: { private: true },
    });
    control.publishEvent('job.progress', {
      jobId: 'job-1',
      type: 'maintenance',
      state: 'completed',
      progress: 100,
      result: { secret: 'private-result' },
      error: 'private-error',
      config: { private: true },
    });

    assert.deepEqual(events[0].data, {
      persistedRevision: 2,
      effectiveRevision: 1,
      changedUpstreamIds: ['changed-only'],
    });
    assert.deepEqual(events[1].data, {
      requestId: 'request-1',
      outcome: 'success',
      status: 200,
      model: 'model-a',
      protocol: 'openai',
      source: 'production',
      durationMs: 12,
    });
    assert.deepEqual(events[2].data, {
      jobId: 'job-1',
      type: 'maintenance',
      state: 'completed',
      progress: 100,
    });
    assert.equal(JSON.stringify(events).includes('private'), false);
    assert.equal(JSON.stringify(events).includes('credential-value'), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
