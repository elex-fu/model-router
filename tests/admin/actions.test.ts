import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminServer } from '../../src/admin/server.js';

test('configured upstream discovery and bounded test run use real HTTP and durable jobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-actions-'));
  let tested = false;
  let holdTests = false;
  const upstream = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder:7b' }] }));
    } else if (req.url === '/v1/chat/completions') {
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      const input = JSON.parse(raw) as { model: string; max_tokens: number };
      tested = input.model === 'qwen2.5-coder:7b' && input.max_tokens === 16 && !req.headers.authorization;
      if (holdTests) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          res.once('close', () => { clearTimeout(timer); resolve(); });
        });
        if (res.destroyed) return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          model: input.model,
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
  let origin = 'http://127.0.0.1:15006';
  const app = createAdminServer({
    configPath: join(dir, 'config.json'),
    bootstrapToken: 'bootstrap',
    bootstrapExpiresAt: Date.now() + 60_000,
    publicOrigin: () => origin,
  });
  try {
    await app.control.entity(
      'upstreams',
      'create',
      undefined,
      {
        id: 'ollama',
        name: 'Ollama',
        provider: 'custom',
        protocol: 'openai',
        enabled: true,
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
        endpoints: { models: 'models', generate: 'chat/completions' },
        auth: { mode: 'none' },
        credentials: [],
        models: [
          { id: 'qwen2.5-coder:7b', enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'manual' },
        ],
        priority: 0,
        sortIndex: 0,
        policy: { allowInsecureHttp: true },
      },
      1,
      'admin',
    );
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    const base = `${origin}/admin/api/v1`;
    await fetch(`${base}/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'bootstrap', name: 'admin', password: 'long-password-123' }),
    });
    const login = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'admin', password: 'long-password-123' }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const csrf = ((await login.json()) as { data: { csrfToken: string } }).data.csrfToken;
    const post = async (path: string, input: unknown) => {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { cookie, origin, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const getJob = async (jobId: string) => {
      const response = await fetch(`${base}/jobs/${jobId}`, { headers: { cookie } });
      return ((await response.json()) as any).data;
    };
    const discovered = await post('/upstreams/ollama/discover-models', {});
    assert.equal(discovered.status, 200);
    assert.deepEqual(discovered.body.data, [{ id: 'qwen2.5-coder:7b', source: 'discovered' }]);
    const started = await post('/upstreams/ollama/test', { model: 'qwen2.5-coder:7b' });
    assert.equal(started.status, 202);
    const jobId = started.body.data.jobId;
    let job: any;
    for (let i = 0; i < 30; i++) {
      const response = await fetch(`${base}/jobs/${jobId}`, { headers: { cookie } });
      job = ((await response.json()) as any).data;
      if (job.state !== 'queued' && job.state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(job.state, 'completed');
    assert.equal(job.result.ok, true);
    assert.equal(job.result.usage.inputTotal, 3);
    assert.equal(tested, true);
    assert.equal(JSON.stringify(job).includes('OK'), false);

    holdTests = true;
    const cancellable = await post('/upstreams/ollama/test', { model: 'qwen2.5-coder:7b' });
    const cancelJobId = cancellable.body.data.jobId;
    for (let i = 0; i < 50 && (await getJob(cancelJobId)).state !== 'running'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await getJob(cancelJobId)).state, 'running');
    const noCsrf = await fetch(`${base}/upstreams/ollama/test-jobs/${cancelJobId}/cancel`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(noCsrf.status, 403);
    const unauthenticated = await fetch(`${base}/upstreams/ollama/test-jobs/${cancelJobId}/cancel`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(unauthenticated.status, 401);
    const otherUpstream = await post(`/upstreams/other/test-jobs/${cancelJobId}/cancel`, {});
    assert.equal(otherUpstream.status, 409);
    const wrongJobType = await post(`/upstreams/ollama/test-jobs/${(await post('/maintenance/jobs', { type: 'integrity-check' })).body.data.jobId}/cancel`, {});
    assert.equal(wrongJobType.status, 409);
    const cancelled = await post(`/upstreams/ollama/test-jobs/${cancelJobId}/cancel`, {});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.state, 'cancelled');
    assert.equal((await post(`/upstreams/ollama/test-jobs/${cancelJobId}/cancel`, {})).body.data.state, 'cancelled');
    for (let i = 0; i < 50 && (await getJob(cancelJobId)).state !== 'cancelled'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await getJob(cancelJobId)).state, 'cancelled');
    holdTests = false;
    const maintenance = await post('/maintenance/jobs', { type: 'integrity-check' });
    assert.equal(maintenance.status, 202);
    let maintenanceJob: any;
    for (let i = 0; i < 30; i++) {
      const response = await fetch(`${base}/jobs/${maintenance.body.data.jobId}`, { headers: { cookie } });
      maintenanceJob = ((await response.json()) as any).data;
      if (maintenanceJob.state !== 'queued' && maintenanceJob.state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(maintenanceJob.state, 'completed');
    assert.equal(maintenanceJob.result.ok, true);
  } finally {
    const cleanupErrors: unknown[] = [];
    app.server.closeAllConnections();
    try {
      await app.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') cleanupErrors.push(error);
    }
    upstream.closeAllConnections();
    try {
      await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    } catch (error) {
      cleanupErrors.push(error);
    }
    rmSync(dir, { recursive: true, force: true });
    if (cleanupErrors.length) {
      process.emitWarning(new AggregateError(cleanupErrors, 'Admin actions test cleanup failed'));
    }
  }
});
