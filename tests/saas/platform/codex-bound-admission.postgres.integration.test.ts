import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import { CODEX_RESPONSES_ENDPOINT } from '../../../src/saas/gateway/codex/transport.js';
import { createModelResolutionProvenance } from '../../../src/saas/gateway/contracts.js';
import type { ProviderNormalizedRequest } from '../../../src/saas/gateway/provider-payload-compiler.js';
import { hashPassword } from '../../../src/saas/identity/password.js';
import { createPlatformAdminAccessService } from '../../../src/saas/platform/access/service.js';
import {
  createPlatformAdminAuthHandler,
  PLATFORM_ADMIN_AUTH_PREFIX,
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_SESSION_COOKIE,
} from '../../../src/saas/platform/auth/http.js';
import { PlatformAdminAuthService } from '../../../src/saas/platform/auth/service.js';
import { totpCode } from '../../../src/saas/platform/auth/totp.js';
import { createCodexBoundAdminHttpHandler } from '../../../src/saas/platform/codex-bound-admin-http.js';
import { createBuiltinUsageUpperBoundEstimator } from '../../../src/saas/runtime/builtin-usage-bounds.js';
import { createDbCodexTrustedBoundProfileResolver } from '../../../src/saas/runtime/codex-bound-db-resolver.js';
import {
  type CodexTrustedBoundProfile,
  codexBoundCompilerVersion,
  codexTrustedProfileDigest,
} from '../../../src/saas/runtime/codex-trusted-bound-profiles.js';
import { CodexBoundAdmissionService } from '../../../src/saas/supply/codex-bound-admission-service.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls } from '../metering/normal-success-postgres-fixture.js';

const BOUNDS_PATH = '/admin/api/v1/codex-bounds';
const FIXTURE_KEY_ID = 'codex-approval-pg-fixture';

test('real PostgreSQL authenticates Codex approval, audits transitions and resolves exact reviewed usage bounds', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? 'disposable restricted PostgreSQL roles required'
      : false,
  timeout: 30_000,
}, async (t) => {
  const [migratorUrl, controlUrl, gatewayUrl] = roleUrls();
  const migrator = createSaasDatabase({ connectionString: migratorUrl, max: 2 });
  const control = createSaasDatabase({ connectionString: controlUrl, max: 2 });
  const gateway = createSaasDatabase({ connectionString: gatewayUrl, max: 2 });
  const key = randomBytes(32);
  t.after(async () => {
    key.fill(0);
    await Promise.all([gateway.close(), control.close(), migrator.close()]);
  });
  await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
  await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');

  const id = randomUUID();
  const email = `codex-approval-${id}@example.test`;
  const password = randomBytes(24).toString('base64url');
  const passwordHash = await hashPassword(password);
  await migrator.transaction(async (tx) => {
    await tx.query('INSERT INTO saas_users (id, email, password_hash) VALUES ($1, $2, $3)', [id, email, passwordHash]);
    await tx.query("INSERT INTO saas_platform_role_assignments (user_id, role) VALUES ($1, 'superadmin')", [id]);
  });

  let clock = Date.now();
  const auth = new PlatformAdminAuthService(
    control,
    {
      getCurrentKey: () => ({ keyId: FIXTURE_KEY_ID, key: Buffer.from(key) }),
      getKey: (keyId) => (keyId === FIXTURE_KEY_ID ? Buffer.from(key) : undefined),
    },
    { now: () => new Date(clock) },
  );
  const enrollment = await auth.issueMfaEnrollmentToken(email, {
    operatorId: FIXTURE_KEY_ID,
    reasonCode: 'initial-enrollment',
    requestId: randomUUID(),
  });
  const pendingMfa = await auth.beginMfaEnrollment(enrollment.token, 'Codex approval fixture');
  const secret = new URL(pendingMfa.otpauthUri).searchParams.get('secret');
  assert.ok(secret);
  await auth.confirmMfaEnrollment(pendingMfa.confirmationToken, totpCode(secret, clock));
  clock += 30_000;

  const server = createServer();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const authHttp = createPlatformAdminAuthHandler({
    service: auth,
    publicOrigin: origin,
    sessionTtlSeconds: 1800,
    rateLimiter: {
      async take() {
        return undefined;
      },
    },
  });
  const boundsHttp = createCodexBoundAdminHttpHandler({
    publicOrigin: origin,
    authService: auth,
    access: createPlatformAdminAccessService({ authService: auth, database: control }),
    service: new CodexBoundAdmissionService(control, { now: () => clock }),
  });
  server.on('request', (req, res) => {
    void (async () => {
      if ((await authHttp(req, res)) || (await boundsHttp(req, res))) return;
      res.writeHead(404).end();
    })().catch(() => res.writeHead(500).end());
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  const login = await post(`${PLATFORM_ADMIN_AUTH_PREFIX}/session`, { email, password, code: totpCode(secret, clock) });
  assert.equal(login.status, 200);
  const cookies = login.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]);
  const sessionCookie = cookies.find(
    (cookie) => cookie.startsWith(PLATFORM_ADMIN_SESSION_COOKIE + '=') && !cookie.endsWith('='),
  );
  const csrfCookie = cookies.find(
    (cookie) => cookie.startsWith(PLATFORM_ADMIN_CSRF_COOKIE + '=') && !cookie.endsWith('='),
  );
  assert.ok(sessionCookie && csrfCookie);
  const headers = {
    cookie: [sessionCookie, csrfCookie].join('; '),
    'x-csrf-token': decodeURIComponent(csrfCookie.slice(PLATFORM_ADMIN_CSRF_COOKIE.length + 1)),
  };
  await login.body?.cancel();

  const profile: CodexTrustedBoundProfile = {
    scope: {
      endpoint: CODEX_RESPONSES_ENDPOINT,
      productId: 'codex-chatgpt',
      model: `fixture-${id}`,
      operation: 'responses',
      transport: 'http',
      continuationMode: 'full',
    },
    bounds: {
      inputTotalUpperBound: '100',
      inputUncachedUpperBound: '100',
      cacheReadUpperBound: '0',
      cacheWriteUpperBound: '0',
      cacheWrite5mUpperBound: '0',
      cacheWrite1hUpperBound: '0',
      outputTotalUpperBound: '20',
      reasoningOutputUpperBound: '20',
      feasibleInputBuckets: ['input'],
      perUnitUnitsUpperBound: null,
      sizeTier: null,
    },
    backendRevision: 'fixture-1',
    evidenceVersion: 'proof-v1',
    evidenceReference: `fixture-${id}`,
    validFromMs: clock - 60_000,
    expiresAtMs: clock + 900_000,
  };
  const body = { profile };
  async function denied(action: string, payload: unknown, expected: number, requestHeaders?: Record<string, string>) {
    const response = await post(`${BOUNDS_PATH}/${action}`, payload, requestHeaders);
    assert.equal(response.status, expected);
    await response.body?.cancel();
  }
  async function call<T>(action: string, payload: unknown): Promise<T> {
    const response = await post(`${BOUNDS_PATH}/${action}`, payload, headers);
    assert.equal(response.status, 200, `Codex approval action ${action} failed`);
    return ((await response.json()) as { data: T }).data;
  }

  await denied('submit', body, 401);
  await denied('submit', body, 403, { cookie: headers.cookie });
  await denied('submit', body, 403, { ...headers, origin: 'http://wrong-origin.invalid' });
  await denied(
    'submit',
    { profile: { ...profile, bounds: { ...profile.bounds, outputTotalUpperBound: '1' } } },
    400,
    headers,
  );
  await migrator.query("UPDATE saas_platform_role_assignments SET role = 'finance' WHERE user_id = $1", [id]);
  await denied('submit', body, 403, headers);
  await migrator.query("UPDATE saas_platform_role_assignments SET role = 'superadmin' WHERE user_id = $1", [id]);

  const digest = codexTrustedProfileDigest(profile);
  const resolver = await createDbCodexTrustedBoundProfileResolver({ database: gateway, now: () => clock });
  assert.equal(resolver.resolve(profile.scope), null);
  assert.deepEqual(await call('submit', body), { status: 'created', state: 'pending', digest });
  const pending = await call<{ items: { digest: string }[] }>('list', { state: 'pending' });
  assert.ok(pending.items.some((item) => item.digest === digest));
  await resolver.refresh();
  assert.equal(resolver.resolve(profile.scope), null);
  await assert.rejects(
    gateway.query("UPDATE saas_codex_trusted_bound_profiles SET state = 'approved' WHERE digest = $1", [digest]),
    {
      code: '42501',
    },
  );
  assert.equal((await call<{ state: string }>('approve', { digest })).state, 'approved');
  await resolver.refresh();
  assert.deepEqual(resolver.resolve(profile.scope), { profile, digest });
  assert.equal(resolver.resolve({ ...profile.scope, model: 'other-model' }), null);
  assert.equal(resolver.resolve(profile.scope, profile.expiresAtMs - 60_000), null);
  const version = codexBoundCompilerVersion('fixture-compiler', profile);
  assert.ok(resolver.sendProfile(version, 'fixture-compiler', profile.scope));
  assert.equal(resolver.sendProfile(version + '-drift', 'fixture-compiler', profile.scope), null);

  const model = profile.scope.model;
  const requestBody = { model, input: [], stream: true, store: false };
  const normalizedRequest: ProviderNormalizedRequest = {
    clientProtocol: 'responses',
    providerProtocol: 'responses',
    clientOperation: 'responses',
    providerOperation: 'responses',
    providerId: 'openai-codex',
    productId: 'codex-chatgpt',
    requestedModel: model,
    mappedModel: model,
    resolvedModel: model,
    modelResolution: createModelResolutionProvenance(model, model),
    upstreamTransport: 'http',
    continuationMode: 'full',
    body: requestBody,
  };
  const estimator = createBuiltinUsageUpperBoundEstimator({
    maxInputTokens: 1_000_000,
    maxOutputTokens: 100_000,
    codexProfileResolver: resolver,
  });
  const estimate = await estimator.estimate({
    normalizedRequest,
    request: normalizedRequest,
    providerId: normalizedRequest.providerId,
    productId: normalizedRequest.productId,
    providerModel: model,
    estimatorVersion: estimator.version,
    compiledPayloadBytes: Buffer.from(JSON.stringify(requestBody)),
  });
  assert.deepEqual(estimate, { bounds: profile.bounds, trustedBoundEvidenceDigest: digest });

  assert.equal((await call<{ state: string }>('retire', { digest })).state, 'retired');
  await resolver.refresh();
  assert.equal(resolver.resolve(profile.scope), null);
  const audits = await migrator.query<{ action: string }>(
    'SELECT action FROM saas_audit_events WHERE actor_user_id = $1 AND target_id = $2 ORDER BY occurred_at, action',
    [id, digest],
  );
  assert.deepEqual(audits.rows.map((row) => row.action).sort(), [
    'codex_bound_profile.approved',
    'codex_bound_profile.retired',
    'codex_bound_profile.submitted',
  ]);
});
