import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { type TestContext, test } from 'node:test';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';
import { EmailVerificationService } from '../../../../src/saas/identity/email-verification-service.js';
import type { SaasIdentityRateLimiter } from '../../../../src/saas/identity/http.js';
import { createSaasIdentityHandler } from '../../../../src/saas/identity/http.js';
import type { RegistrationAffiliatePort } from '../../../../src/saas/identity/register-service.js';
import { RegistrationService } from '../../../../src/saas/identity/register-service.js';
import type { RegistrationAdmissionSettings } from '../../../../src/saas/identity/registration-settings.js';
import { SaasIdentityService } from '../../../../src/saas/identity/service.js';
import type { CaptchaProof } from '../../../../src/saas/identity/turnstile-service.js';
import { FakeSaasDatabase } from '../fake-database.js';

const EMAIL = 'unit.http.register@example.test';
const PASSWORD = 'unit-http-registration-password';
const CODE = '123456';

interface UnitHttpReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: Record<string, unknown>;
}

function settings(overrides: Partial<RegistrationAdmissionSettings> = {}): RegistrationAdmissionSettings {
  return {
    mode: 'open',
    emailVerificationRequired: true,
    emailDomainAllowlist: [],
    emailDomainDenylist: [],
    turnstile: { enabled: false },
    rewards: {
      currency: 'USD',
      grantMinorUnits: '0',
      codeFillerMinorUnits: '0',
      codeOwnerMinorUnits: '0',
      codeOwnerMinThresholdMinorUnits: '0',
    },
    ...overrides,
  };
}

const passthroughCaptcha: CaptchaProof = { backend: 'disabled', verify: async () => true };

function rejectingCaptcha(): CaptchaProof {
  return { backend: 'turnstile', verify: async () => false };
}

const affiliate: RegistrationAffiliatePort = {
  resolveInviteCode: async () => null,
  completeRegistrationAttribution: async () => {},
};

/** Fixed-window limiter that never limits unless armed. */
function unlimitedLimiter(): SaasIdentityRateLimiter {
  return { take: async () => undefined };
}

interface Fixture {
  database: FakeSaasDatabase;
  server: Server;
  origin: string;
  close: () => Promise<void>;
}

let current: Fixture | undefined;

function buildHandler(
  origin: string,
  overrides: {
    settings?: Partial<RegistrationAdmissionSettings>;
    captcha?: CaptchaProof;
    sendRateLimiter?: SaasIdentityRateLimiter;
  } = {},
): ReturnType<typeof createSaasIdentityHandler> {
  const database = current?.database ?? new FakeSaasDatabase();
  current = {
    database,
    server: current?.server ?? createServer(),
    origin,
    close: async () => {},
  };
  const identity = new SaasIdentityService(database as never);
  const registration = new RegistrationService({
    database: database as unknown as SaasDatabase,
    identity,
    verification: new EmailVerificationService({
      database: database as unknown as SaasDatabase,
      emailSender: { send: async () => {} },
      codeFactory: () => CODE,
    }),
    captcha: overrides.captcha ?? passthroughCaptcha,
    settings: settings(overrides.settings),
    sessionTtlSeconds: 900,
    affiliate,
  });
  return createSaasIdentityHandler({
    service: identity,
    registration: {
      service: registration,
      ...(overrides.sendRateLimiter === undefined ? {} : { sendRateLimiter: overrides.sendRateLimiter }),
    },
    ...(overrides.captcha === undefined ? {} : { captcha: overrides.captcha }),
    publicOrigin: origin,
    sessionTtlSeconds: 900,
    rateLimiter: unlimitedLimiter(),
  });
}

async function withServer(
  context: TestContext,
  overrides: {
    settings?: Partial<RegistrationAdmissionSettings>;
    captcha?: CaptchaProof;
    sendRateLimiter?: SaasIdentityRateLimiter;
  },
  work: (origin: string, database: FakeSaasDatabase) => Promise<void>,
): Promise<void> {
  current = { database: new FakeSaasDatabase(), server: createServer(), origin: '', close: async () => {} };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const handler = buildHandler(`http://127.0.0.1:${address.port}`, overrides);
      if (!(await handler(req, res))) {
        res.writeHead(404).end();
      }
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    server.close();
    await once(server, 'close');
  });
  await work(origin, current.database);
}

async function request(
  origin: string,
  path: string,
  init: { method: string; origin?: string; cookie?: string; body?: unknown; host?: string },
): Promise<UnitHttpReply> {
  const target = new URL(path, origin);
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      target,
      {
        method: init.method,
        agent: false,
        signal: AbortSignal.timeout(5000),
        headers: {
          ...(init.host === undefined ? {} : { host: init.host }),
          connection: 'close',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.origin === undefined ? {} : { origin: init.origin }),
          ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
        },
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: unknown) => {
          if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on('error', reject);
    if (payload !== undefined) outgoing.write(payload);
    outgoing.end();
  });
}

test('register/options returns the public admission descriptor', async (context) => {
  await withServer(
    context,
    { settings: { mode: 'invite', turnstile: { enabled: true, siteKey: 'unit-key' } } },
    async (origin) => {
      const reply = await request(origin, '/console/api/v1/auth/register/options', { method: 'GET' });
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.json.data, {
        mode: 'invite',
        emailVerificationRequired: true,
        turnstile: { enabled: true, siteKey: 'unit-key' },
      });
    },
  );
});

test('register send-code issues a code and enforces the 2/30s per-IP window', async (context) => {
  // Deterministic counting limiter: 2 allowed, then limited with retry-after.
  let calls = 0;
  const sendRateLimiter: SaasIdentityRateLimiter = {
    take: async () => {
      calls += 1;
      return calls > 2 ? 17 : undefined;
    },
  };
  await withServer(context, { sendRateLimiter }, async (origin) => {
    // Distinct addresses: the email cooldown must not fire before the IP window.
    const first = await request(origin, '/console/api/v1/auth/register/send-code', {
      method: 'POST',
      origin,
      body: { email: 'first@example.test' },
    });
    assert.equal(first.status, 200);
    const second = await request(origin, '/console/api/v1/auth/register/send-code', {
      method: 'POST',
      origin,
      body: { email: 'second@example.test' },
    });
    assert.equal(second.status, 200);
    const third = await request(origin, '/console/api/v1/auth/register/send-code', {
      method: 'POST',
      origin,
      body: { email: 'third@example.test' },
    });
    assert.equal(third.status, 429);
    assert.equal(third.headers['retry-after'], '17');
    assert.equal(third.json.error?.code, 'RATE_LIMITED');
  });
});

test('register send-code maps the 60s email cooldown to 429 with retry-after', async (context) => {
  await withServer(context, {}, async (origin) => {
    const first = await request(origin, '/console/api/v1/auth/register/send-code', {
      method: 'POST',
      origin,
      body: { email: EMAIL },
    });
    assert.equal(first.status, 200);
    const second = await request(origin, '/console/api/v1/auth/register/send-code', {
      method: 'POST',
      origin,
      body: { email: EMAIL },
    });
    assert.equal(second.status, 429);
    assert.equal(second.json.error?.code, 'COOLDOWN_ACTIVE');
    assert.equal(Number(second.headers['retry-after']) > 0, true);
  });
});

test('register: closed mode and domain rejection surface as 403 with safe codes', async (context) => {
  await withServer(context, { settings: { mode: 'closed' } }, async (origin) => {
    const reply = await request(origin, '/console/api/v1/auth/register', {
      method: 'POST',
      origin,
      body: { email: EMAIL, password: PASSWORD, verificationCode: CODE },
    });
    assert.equal(reply.status, 403);
    assert.equal(reply.json.error?.code, 'REGISTRATION_CLOSED');
  });

  await withServer(context, { settings: { emailDomainDenylist: ['example.test'] } }, async (origin) => {
    const reply = await request(origin, '/console/api/v1/auth/register', {
      method: 'POST',
      origin,
      body: { email: EMAIL, password: PASSWORD, verificationCode: CODE },
    });
    assert.equal(reply.status, 403);
    assert.equal(reply.json.error?.code, 'EMAIL_DOMAIN_REJECTED');
  });
});

test('register: missing same-origin / wrong host / wrong method are boundary-rejected', async (context) => {
  await withServer(context, { settings: { emailVerificationRequired: false } }, async (origin) => {
    const noOrigin = await request(origin, '/console/api/v1/auth/register', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.json.error?.code, 'ORIGIN_REJECTED');

    const badHost = await request(origin, '/console/api/v1/auth/register', {
      method: 'POST',
      origin,
      host: 'evil.example.test',
      body: { email: EMAIL, password: PASSWORD },
    });
    assert.equal(badHost.status, 403);
    assert.equal(badHost.json.error?.code, 'HOST_REJECTED');

    const wrongMethod = await request(origin, '/console/api/v1/auth/register', {
      method: 'GET',
      origin,
    });
    assert.equal(wrongMethod.status, 405);

    const unknownField = await request(origin, '/console/api/v1/auth/register', {
      method: 'POST',
      origin,
      body: { email: EMAIL, password: PASSWORD, role: 'admin' },
    });
    assert.equal(unknownField.status, 400);
    assert.equal(unknownField.json.error?.code, 'INVALID_BODY');
  });
});

test('register: captcha rejection and invalid code surface as their own safe codes', async (context) => {
  await withServer(context, { captcha: rejectingCaptcha() }, async (origin) => {
    const reply = await request(origin, '/console/api/v1/auth/register', {
      method: 'POST',
      origin,
      body: { email: EMAIL, password: PASSWORD, verificationCode: CODE, captchaToken: 'unit-token' },
    });
    assert.equal(reply.status, 403);
    assert.equal(reply.json.error?.code, 'CAPTCHA_REJECTED');
  });

  await withServer(context, {}, async (origin) => {
    await request(origin, '/console/api/v1/auth/register/send-code', {
      method: 'POST',
      origin,
      body: { email: EMAIL },
    });
    const reply = await request(origin, '/console/api/v1/auth/register', {
      method: 'POST',
      origin,
      body: { email: EMAIL, password: PASSWORD, verificationCode: '000000' },
    });
    assert.equal(reply.status, 400);
    assert.equal(reply.json.error?.code, 'VERIFICATION_CODE_INVALID');
  });
});

test('register happy path issues session cookies and 201', async (context) => {
  await withServer(context, {}, async (origin) => {
    await request(origin, '/console/api/v1/auth/register/send-code', {
      method: 'POST',
      origin,
      body: { email: EMAIL },
    });
    const reply = await request(origin, '/console/api/v1/auth/register', {
      method: 'POST',
      origin,
      body: { email: EMAIL, password: PASSWORD, verificationCode: CODE, displayName: 'Unit HTTP' },
    });
    assert.equal(reply.status, 201);
    assert.ok(reply.json.data?.session);
    const cookies = reply.headers['set-cookie'];
    assert.ok(Array.isArray(cookies));
    const cookieText = cookies.join('\n');
    assert.match(cookieText, /mr_saas_session=/);
    assert.match(cookieText, /mr_saas_csrf=/);
    assert.match(cookieText, /SameSite=Strict/);
    // The issued session authenticates immediately.
    const session = await request(origin, '/console/api/v1/auth/session', {
      method: 'GET',
      cookie: cookies
        .map((cookie) => cookie.split(';')[0])
        .filter((cookie) => cookie.startsWith('mr_saas_session='))
        .join('; '),
    });
    assert.equal(session.status, 200);
  });
});

test('password reset end-to-end: send-code (no oracle) then confirm', async (context) => {
  await withServer(context, {}, async (origin) => {
    // Unknown address: same 200 shape (no account oracle), no code stored.
    const unknown = await request(origin, '/console/api/v1/auth/password-reset/send-code', {
      method: 'POST',
      origin,
      body: { email: 'unknown@example.test' },
    });
    assert.equal(unknown.status, 200);

    await request(origin, '/console/api/v1/auth/register/send-code', {
      method: 'POST',
      origin,
      body: { email: EMAIL },
    });
    await request(origin, '/console/api/v1/auth/register', {
      method: 'POST',
      origin,
      body: { email: EMAIL, password: PASSWORD, verificationCode: CODE },
    });

    const sent = await request(origin, '/console/api/v1/auth/password-reset/send-code', {
      method: 'POST',
      origin,
      body: { email: EMAIL },
    });
    assert.equal(sent.status, 200);

    const wrong = await request(origin, '/console/api/v1/auth/password-reset/confirm', {
      method: 'POST',
      origin,
      body: { email: EMAIL, code: '000000', newPassword: 'unit-new-password-1' },
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.error?.code, 'VERIFICATION_CODE_INVALID');

    const right = await request(origin, '/console/api/v1/auth/password-reset/confirm', {
      method: 'POST',
      origin,
      body: { email: EMAIL, code: CODE, newPassword: 'unit-new-password-1' },
    });
    assert.equal(right.status, 200);
    assert.equal(right.json.data?.reset, true);
  });
});

test('login requires the captcha token when a proof is wired', async (context) => {
  await withServer(context, { captcha: rejectingCaptcha() }, async (origin) => {
    const reply = await request(origin, '/console/api/v1/auth/session', {
      method: 'POST',
      origin,
      body: { email: EMAIL, password: PASSWORD },
    });
    assert.equal(reply.status, 403);
    assert.equal(reply.json.error?.code, 'CAPTCHA_REJECTED');
  });
});

test('login still accepts bodies without captchaToken when no proof is wired', async (context) => {
  await withServer(context, {}, async (origin) => {
    // Pre-R4 shape: unknown credentials but the body parses (401, not 400).
    const reply = await request(origin, '/console/api/v1/auth/session', {
      method: 'POST',
      origin,
      body: { email: EMAIL, password: PASSWORD },
    });
    assert.equal(reply.status, 401);
    assert.equal(reply.json.error?.code, 'INVALID_CREDENTIALS');
  });
});

test('unrelated paths fall through to the identity handler chain', async (context) => {
  await withServer(context, {}, async (origin) => {
    const response = await new Promise<{ status: number }>((resolve, reject) => {
      const outgoing = httpRequest(
        new URL('/console/api/v1/auth/register/unknown', origin),
        {
          method: 'POST',
          agent: false,
          signal: AbortSignal.timeout(5000),
          headers: { origin, connection: 'close', 'content-type': 'application/json' },
        },
        (incoming) => {
          incoming.resume();
          incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0 }));
        },
      );
      outgoing.on('error', reject);
      outgoing.end('{}');
    });
    assert.equal(response.status, 404);
  });
});
