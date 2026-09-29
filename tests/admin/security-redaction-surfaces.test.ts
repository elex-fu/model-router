import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminServer } from '../../src/admin/server.js';
import { defaultConfigV2, type ConfigV2 } from '../../src/config/v2-schema.js';
import { ControlStore } from '../../src/control/store.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

test('admin responses, logs, exports, audit and HTML do not disclose a configured secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-security-surfaces-'));
  const configDir = join(dir, 'config');
  const dataDir = join(dir, 'data');
  const webDir = join(dir, 'web');
  mkdirSync(configDir);
  mkdirSync(dataDir);
  mkdirSync(webDir);
  const configPath = join(configDir, 'config.json');
  const webDistPath = join(webDir, 'dist');
  mkdirSync(webDistPath);
  writeFileSync(join(webDistPath, 'index.html'), '<!doctype html><html><body>admin console</body></html>');
  const initialConfig = defaultConfigV2(configPath, 'security-test');
  initialConfig.storage.dataDir = dataDir;
  writeFileSync(configPath, JSON.stringify(initialConfig), { mode: 0o600 });
  const controlStore = new ControlStore(dataDir);
  const telemetry = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await telemetry.init();
  const sentinel = 'SECURITY_SENTINEL_ADMIN_SECRET_7f4a9c2e';
  const now = Date.now();
  await telemetry.upsertRequest({
    id: 'redaction-request',
    proxyKeyId: null,
    source: 'production',
    clientProtocol: 'openai',
    requestModel: 'redaction-model',
    routeId: null,
    configRevision: 1,
    state: 'failed',
    finalHttpStatus: 502,
    startedAtMs: now,
    endedAtMs: now,
    durationMs: 0,
    firstByteMs: null,
    firstEventMs: null,
    firstTextMs: null,
    finalUpstreamId: 'redaction-upstream',
  });
  await telemetry.upsertAttempt({
    id: 'redaction-attempt',
    requestId: 'redaction-request',
    ordinal: 1,
    upstreamId: 'redaction-upstream',
    credentialId: null,
    resolvedModel: 'redaction-model',
    reportedModel: null,
    protocol: 'openai',
    outcome: 'failed',
    status: 502,
    retryReason: `upstream rejected authorization: ${sentinel}`,
    startedAtMs: now,
    endedAtMs: now,
    usage: null,
    pricingVersion: null,
    costMicros: null,
    currency: null,
  });
  let origin = 'http://127.0.0.1:15006';
  const app = createAdminServer({
    configPath,
    controlStore,
    telemetryStore: telemetry,
    webDistPath,
    bootstrapToken: 'bootstrap-token',
    bootstrapExpiresAt: now + 60_000,
    publicOrigin: () => origin,
  });
  await app.control.entity(
    'upstreams',
    'create',
    undefined,
    {
      id: 'redaction-upstream',
      name: 'Redaction upstream',
      provider: 'custom',
      protocol: 'openai',
      enabled: false,
      baseUrl: 'https://example.invalid/v1',
      endpoints: { generate: 'chat/completions' },
      auth: { mode: 'bearer' },
      credentials: [],
      models: [
        { id: 'redaction-model', enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'manual' },
      ],
      priority: 0,
      sortIndex: 0,
      policy: {},
    },
    1,
    'admin',
  );
  await app.control.credential(
    'redaction-upstream',
    'create',
    undefined,
    { label: 'Primary', value: sentinel },
    2,
    'admin',
  );
  await app.control.entity('upstreams', 'update', 'redaction-upstream', { enabled: true }, 3, 'admin');
  const inlineSentinel = 'INLINE_CONFIG_SECRET_SENTINEL_2b8c741d';
  const inlineConfig = await app.control.raw();
  const inlineUpstream = inlineConfig.upstreams[0];
  assert.ok(inlineUpstream);
  inlineUpstream.credentials.push({
    id: 'inline-credential',
    label: 'Inline config credential',
    enabled: true,
    secret: { type: 'inline', value: inlineSentinel },
  });
  await app.control.commit(inlineConfig, inlineConfig.revision, 'admin');
  const historyText = JSON.stringify(controlStore.db.prepare('SELECT config_json FROM config_history').all());
  assert.equal(historyText.includes(inlineSentinel), false, 'config history must encrypt inline values');
  const restoredHistory = controlStore.configHistoryConfig(inlineConfig.revision + 1) as ConfigV2 | undefined;
  assert.ok(restoredHistory);
  const restoredCredential = restoredHistory.upstreams[0]?.credentials.find((item) => item.id === 'inline-credential');
  assert.ok(restoredCredential);
  assert.equal(restoredCredential.secret.type, 'inline');
  if (restoredCredential.secret.type !== 'inline') throw new Error('Expected inline credential in config history');
  assert.equal(
    restoredCredential.secret.value,
    inlineSentinel,
    'encrypted config history must remain usable for rollback',
  );
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  const base = `${origin}/admin/api/v1`;
  const leaks: string[] = [];
  const assertNoSecret = (surface: string, text: string) => {
    if (text.includes(sentinel) || text.includes(inlineSentinel)) leaks.push(surface);
  };
  const raw = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal(
      (await raw('/bootstrap', 'POST', { token: 'bootstrap-token', name: 'admin', password: 'secure-password-123' }))
        .status,
      201,
    );
    const login = await raw('/session', 'POST', { name: 'admin', password: 'secure-password-123' });
    const loginBody = (await login.json()) as { data: { csrfToken: string } };
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const auth = { cookie, origin, 'x-csrf-token': loginBody.data.csrfToken };

    const configExport = await raw('/config/export', 'GET', undefined, auth);
    assert.equal(configExport.status, 200);
    assertNoSecret('configuration export', await configExport.text());
    const configView = await raw('/config', 'GET', undefined, auth);
    assert.equal(configView.status, 200);
    const configViewText = await configView.text();
    assertNoSecret('configuration response', configViewText);
    const safeConfig = (JSON.parse(configViewText) as { data: ConfigV2 }).data;
    const safeCredential = safeConfig.upstreams[0]?.credentials.find((item) => item.id === 'inline-credential');
    assert.ok(safeCredential);
    assert.equal(safeCredential.secret.type, 'inline');
    if (safeCredential.secret.type !== 'inline') throw new Error('Expected inline credential in admin config view');
    assert.equal(safeCredential.secret.value, '');
    const validation = await raw('/config/validate', 'POST', { config: safeConfig }, auth);
    const validationText = await validation.text();
    assert.equal(validation.status, 200, validationText);
    assertNoSecret('configuration validation response', validationText);
    const preview = await raw('/config/import-preview', 'POST', { config: safeConfig, mode: 'replace' }, auth);
    const previewText = await preview.text();
    assert.equal(preview.status, 200, previewText);
    assertNoSecret('configuration import preview', previewText);
    const editConfig = structuredClone(safeConfig);
    editConfig.server.maxAttempts += 1;
    const updatedConfig = await raw('/config', 'PUT', editConfig, {
      ...auth,
      'if-match': `"cfg-${safeConfig.revision}"`,
    });
    assert.equal(updatedConfig.status, 200);
    assertNoSecret('configuration update response', await updatedConfig.text());
    const upstreamList = await raw('/upstreams', 'GET', undefined, auth);
    assert.equal(upstreamList.status, 200);
    assertNoSecret('upstream list', await upstreamList.text());
    const historyAfterCommit = JSON.stringify(controlStore.db.prepare('SELECT config_json FROM config_history').all());
    assert.equal(historyAfterCommit.includes(inlineSentinel), false, 'updated config history must remain encrypted');

    const managementError = await raw('/exports', 'POST', { type: sentinel, format: 'csv' }, auth);
    assert.equal(managementError.status, 400);
    assertNoSecret('management error response', await managementError.text());

    for (const path of ['/requests/redaction-request', '/requests/redaction-request/attempts']) {
      const response = await raw(path, 'GET', undefined, auth);
      assert.equal(response.status, 200);
      const body = await response.text();
      assertNoSecret(path, body);
      const parsed = JSON.parse(body) as { data: any };
      if (path.endsWith('/attempts')) {
        assert.equal(parsed.data[0].retryReason, 'upstream rejected authorization: [REDACTED]');
        assert.equal(parsed.data[0].error.message, 'upstream rejected authorization: [REDACTED]');
      } else {
        assert.equal(parsed.data.error.message, 'upstream rejected authorization: [REDACTED]');
      }
    }
    const requests = await raw('/requests', 'GET', undefined, auth);
    assert.equal(requests.status, 200);
    const requestListing = await requests.text();
    assertNoSecret('request listing', requestListing);
    const listed = JSON.parse(requestListing) as { data: any[] };
    assert.equal(listed.data[0].error.message, 'upstream rejected authorization: [REDACTED]');

    const exportResponse = await raw(
      '/exports',
      'POST',
      {
        type: 'requests',
        format: 'csv',
        filters: {
          from: new Date(now - 60_000).toISOString(),
          to: new Date(now + 60_000).toISOString(),
          source: 'production',
        },
      },
      auth,
    );
    assert.equal(exportResponse.status, 202);
    const exportBody = (await exportResponse.json()) as { data: { exportId: string; jobId: string } };
    let job: any;
    for (let i = 0; i < 100; i++) {
      const response = await raw(`/jobs/${exportBody.data.jobId}`, 'GET', undefined, auth);
      job = ((await response.json()) as any).data;
      if (job.state === 'completed' || job.state === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.state, 'completed', job.error ?? 'CSV export did not complete');
    const csvResponse = await raw(`/exports/${exportBody.data.exportId}/download`, 'GET', undefined, auth);
    assert.equal(csvResponse.status, 200);
    const csv = await csvResponse.text();
    assertNoSecret('CSV export', csv);

    const auditResponse = await raw('/audit-events', 'GET', undefined, auth);
    assert.equal(auditResponse.status, 200);
    assertNoSecret('audit API', await auditResponse.text());

    const page = await fetch(`${origin}/admin/`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assertNoSecret('page HTML', await page.text());

    const formulaRequestId = 'formula-payload-request';
    await telemetry.upsertRequest({
      id: formulaRequestId,
      proxyKeyId: null,
      source: 'production',
      clientProtocol: 'openai',
      requestModel: '  =HYPERLINK("bad")',
      routeId: null,
      configRevision: 1,
      state: 'completed',
      finalHttpStatus: 200,
      startedAtMs: now,
      endedAtMs: now,
      durationMs: 0,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    });
    const formulaExport = await raw(
      '/exports',
      'POST',
      {
        type: 'requests',
        format: 'csv',
        filters: {
          from: new Date(now - 60_000).toISOString(),
          to: new Date(now + 60_000).toISOString(),
          source: 'production',
        },
      },
      auth,
    );
    const formulaJob = ((await formulaExport.json()) as any).data;
    for (let i = 0; i < 100; i++) {
      const response = await raw(`/jobs/${formulaJob.jobId}`, 'GET', undefined, auth);
      job = ((await response.json()) as any).data;
      if (job.state === 'completed' || job.state === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.state, 'completed', job.error ?? 'Formula CSV export did not complete');
    const formulaCsvResponse = await raw(`/exports/${formulaJob.exportId}/download`, 'GET', undefined, auth);
    assert.equal(formulaCsvResponse.status, 200);
    assert.match(await formulaCsvResponse.text(), /'  =HYPERLINK\(""bad""\)/);
    assert.deepEqual(leaks, [], `Sentinel leaked through: ${leaks.join(', ')}`);
  } finally {
    app.server.closeAllConnections();
    await app.close();
    await telemetry.close();
    controlStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
