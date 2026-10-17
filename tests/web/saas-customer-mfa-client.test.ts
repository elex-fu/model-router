import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { CustomerMfaDeploymentUnavailableError, SaasApiError, saasClient } from '../../web/src/api/saas-client.ts';

const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
});
const csrf = 'synthetic-customer-csrf-001';
const password = 'synthetic-password-not-a-real-key';
const token = 'synthetic-confirmation-token-001';
const secret = 'JBSWY3DPEHPK3PXP';
const uri = `otpauth://totp/model-router:customer?secret=${secret}&issuer=model-router`;
const setup = { secret, confirmationToken: token, otpauthUri: uri, expiresAt: '2030-01-01T00:05:00.000Z' };
function wire(
  handler: (path: string, init: RequestInit) => Response | Promise<Response>,
  cookie = `mr_saas_csrf=${csrf}`,
) {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie } });
  globalThis.fetch = async (input, init) => handler(String(input), init ?? {});
}
function response(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

test('customer MFA uses only the four original routes with exact POST bodies, cookie CSRF even on GET and no-store', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  wire((path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/start')) return response(setup);
    if (path.endsWith('/confirm')) return response({ enabled: true, sessionsRevoked: 2, signInRequired: true });
    if (path.endsWith('/revoke')) return response({ enabled: false, sessionsRevoked: 1, signInRequired: true });
    return response({ enabled: false, ignoredSecret: 'must-not-project' });
  });
  assert.deepEqual(await saasClient.getCustomerMfaStatus(), { enabled: false });
  assert.deepEqual(await saasClient.startCustomerMfaEnrollment({ password }), setup);
  await saasClient.confirmCustomerMfaEnrollment({ password, confirmationToken: token, code: '123456' });
  await saasClient.revokeCustomerMfa({ password, code: '234567' });
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/console/api/v1/auth/mfa',
      '/console/api/v1/auth/mfa/enrollment/start',
      '/console/api/v1/auth/mfa/enrollment/confirm',
      '/console/api/v1/auth/mfa/revoke',
    ],
  );
  assert.deepEqual(
    calls.map((call) => call.init.method),
    ['GET', 'POST', 'POST', 'POST'],
  );
  assert.equal(calls[0]?.init.body, undefined);
  assert.deepEqual(
    calls.slice(1).map((call) => JSON.parse(String(call.init.body))),
    [{ password }, { password, confirmationToken: token, code: '123456' }, { password, code: '234567' }],
  );
  for (const { path, init } of calls) {
    assert.equal(path.includes('?'), false);
    assert.equal(path.includes(password), false);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('x-csrf-token'), csrf);
    assert.equal(headers.has('Origin'), false); // Browser owns Origin; no client-forged proof.
    assert.equal(headers.has('Authorization'), false);
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.mode, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.referrerPolicy, 'no-referrer');
  }
});

test('replacement carries real currentTotpCode on both start and confirm, revoke still uses code', async () => {
  const bodies: unknown[] = [];
  wire((path, init) => {
    bodies.push(JSON.parse(String(init.body)));
    return response(path.endsWith('/start') ? setup : { enabled: true, sessionsRevoked: 1, signInRequired: true });
  });
  await saasClient.startCustomerMfaEnrollment({ password, currentTotpCode: '111111' });
  await saasClient.confirmCustomerMfaEnrollment({
    password,
    currentTotpCode: '222222',
    confirmationToken: token,
    code: '333333',
  });
  assert.deepEqual(bodies, [
    { password, currentTotpCode: '111111' },
    { password, currentTotpCode: '222222', confirmationToken: token, code: '333333' },
  ]);
});

test('missing or invalid readable CSRF fails closed before any request, including status', async () => {
  for (const cookie of ['', 'mr_saas_csrf=short']) {
    let calls = 0;
    wire(() => {
      ++calls;
      return response({ enabled: true });
    }, cookie);
    await assert.rejects(
      saasClient.getCustomerMfaStatus(),
      (error) => error instanceof SaasApiError && error.code === 'CSRF_REJECTED',
    );
    await assert.rejects(
      saasClient.startCustomerMfaEnrollment({ password }),
      (error) => error instanceof SaasApiError && error.code === 'CSRF_REJECTED',
    );
    assert.equal(calls, 0);
  }
});

test('known MFA denial is allowlisted but never retains raw message, details or response data', async () => {
  const poison = `${password} ${token} ${uri}`;
  wire(
    () =>
      new Response(
        JSON.stringify({ error: { code: 'MFA_CODE_REJECTED', message: poison, details: { poison } }, data: setup }),
        { status: 403 },
      ),
  );
  await assert.rejects(
    saasClient.confirmCustomerMfaEnrollment({ password, code: '123456', confirmationToken: token }),
    (error) => {
      assert.ok(error instanceof SaasApiError);
      assert.equal(error.code, 'MFA_CODE_REJECTED');
      assert.equal(error.message.includes(poison), false);
      assert.equal(error.details, undefined);
      assert.equal(error.data, undefined);
      return true;
    },
  );
});

test('arbitrary error code and network error payload are never projected', async () => {
  wire(() => new Response(JSON.stringify({ error: { code: uri, message: password } }), { status: 503 }));
  await assert.rejects(
    saasClient.getCustomerMfaStatus(),
    (error) => error instanceof SaasApiError && error.code === 'HTTP_ERROR' && !error.message.includes(password),
  );
  wire(() => {
    throw new Error(uri);
  });
  await assert.rejects(
    saasClient.startCustomerMfaEnrollment({ password }),
    (error) => error instanceof SaasApiError && error.code === 'NETWORK' && !error.message.includes(uri),
  );
});

test('status string, malformed setup, mismatched secret and false confirmation never fabricate MFA state', async () => {
  wire(() => response({ enabled: 'true' }));
  await assert.rejects(
    saasClient.getCustomerMfaStatus(),
    (error) => error instanceof SaasApiError && error.code === 'INVALID_RESPONSE',
  );
  for (const invalid of [
    { ...setup, confirmationToken: '' },
    { ...setup, expiresAt: 'not-a-date' },
    { ...setup, otpauthUri: `https://example.test/?secret=${secret}` },
    { ...setup, otpauthUri: 'otpauth://totp/customer?secret=AAAAAAAAAAAAAAAA' },
    { ...setup, otpauthUri: `${uri}&secret=${secret}` },
  ]) {
    wire(() => response(invalid));
    await assert.rejects(
      saasClient.startCustomerMfaEnrollment({ password }),
      (error) => error instanceof SaasApiError && error.code === 'INVALID_RESPONSE',
    );
  }
  for (const invalid of [
    { enabled: false, sessionsRevoked: 1, signInRequired: true },
    { enabled: true, sessionsRevoked: 1, signInRequired: false },
    { enabled: true, sessionsRevoked: 0, signInRequired: true },
    { enabled: true, sessionsRevoked: 1.5, signInRequired: true },
  ]) {
    wire(() => response(invalid));
    await assert.rejects(
      saasClient.confirmCustomerMfaEnrollment({ password, confirmationToken: token, code: '123456' }),
      (error) => error instanceof SaasApiError && error.code === 'INVALID_RESPONSE',
    );
  }
});

test('abort signal reaches the actual fetch and unreadable success is uncertain, never auto-retried', async () => {
  const controller = new AbortController();
  let calls = 0;
  wire((_path, init) => {
    ++calls;
    assert.equal(init.signal, controller.signal);
    return new Response('{broken', { status: 200 });
  });
  await assert.rejects(
    saasClient.revokeCustomerMfa({ password, code: '123456' }, { signal: controller.signal }),
    (error) => error instanceof SaasApiError && error.code === 'INVALID_RESPONSE',
  );
  assert.equal(calls, 1);
});

test('only the exact no-store 503 absent-capability contract becomes deployment unavailable; generic failures stay unknown', async () => {
  wire(
    () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'UNAVAILABLE',
            availability: 'deployment-unavailable-v1',
            message: password,
            requestId: 'synthetic-unit-request',
          },
        }),
        { status: 503, headers: { 'cache-control': 'no-store' } },
      ),
  );
  await assert.rejects(saasClient.getCustomerMfaStatus(), (error) => {
    assert.ok(error instanceof CustomerMfaDeploymentUnavailableError);
    assert.equal(error.status, 503);
    assert.equal(error.code, 'UNAVAILABLE');
    assert.equal(error.message.includes(password), false);
    assert.equal(error.details, undefined);
    assert.equal(error.data, undefined);
    return true;
  });
  for (const invalid of [
    { status: 503, marker: undefined, cache: 'no-store', data: false },
    { status: 503, marker: 'deployment-unavailable-v2', cache: 'no-store', data: false },
    { status: 403, marker: 'deployment-unavailable-v1', cache: 'no-store', data: false },
    { status: 503, marker: 'deployment-unavailable-v1', cache: 'public', data: false },
    { status: 503, marker: 'deployment-unavailable-v1', cache: 'no-store', data: true },
  ]) {
    wire(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'UNAVAILABLE', availability: invalid.marker },
            ...(invalid.data ? { data: setup } : {}),
          }),
          { status: invalid.status, headers: { 'cache-control': invalid.cache } },
        ),
    );
    await assert.rejects(
      saasClient.getCustomerMfaStatus(),
      (error) => error instanceof SaasApiError && !(error instanceof CustomerMfaDeploymentUnavailableError),
    );
  }
  wire(() => {
    throw new Error('UNAVAILABLE deployment-unavailable-v1');
  });
  await assert.rejects(
    saasClient.getCustomerMfaStatus(),
    (error) =>
      error instanceof SaasApiError &&
      error.code === 'NETWORK' &&
      !(error instanceof CustomerMfaDeploymentUnavailableError),
  );
});
