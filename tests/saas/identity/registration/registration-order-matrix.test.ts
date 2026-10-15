import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';
import type { EmailSender } from '../../../../src/saas/identity/email-sender.js';
import { EmailVerificationService } from '../../../../src/saas/identity/email-verification-service.js';
import { hashPassword, verifyPassword } from '../../../../src/saas/identity/password.js';
import type {
  RegistrationAffiliatePort,
  RegistrationIdentityDirectory,
  RegistrationServiceOptions,
} from '../../../../src/saas/identity/register-service.js';
import { RegistrationError, RegistrationService } from '../../../../src/saas/identity/register-service.js';
import type { RegistrationAdmissionSettings } from '../../../../src/saas/identity/registration-settings.js';
import { SaasIdentityService } from '../../../../src/saas/identity/service.js';
import type { CaptchaProof } from '../../../../src/saas/identity/turnstile-service.js';
import { FakeSaasDatabase } from '../fake-database.js';

const EMAIL = 'unit.register@example.test';
const PASSWORD = 'unit-registration-password';
const INVITER_TENANT = '00000000-0000-0000-0000-000000000001';

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

/** Refuses every captcha token; pass-through proof is a separate stub. */
const strictCaptcha: CaptchaProof = {
  backend: 'turnstile',
  verify: async () => false,
};

const passthroughCaptcha: CaptchaProof = {
  backend: 'disabled',
  verify: async () => true,
};

/** Token-accepting proof: only the exact token passes (single-use semantics). */
function singleUseCaptcha(token: string): CaptchaProof {
  let consumed = false;
  return {
    backend: 'turnstile',
    verify: async (input) => {
      if (consumed || input.token !== token) return false;
      consumed = true;
      return true;
    },
  };
}

interface AffiliateCalls {
  resolved: string[];
  attributed: Array<{ inviteeTenantId: string; userId: string; inviteCode?: string }>;
}

function affiliatePort(result: { inviterTenantId: string | null; calls: AffiliateCalls }): RegistrationAffiliatePort {
  return {
    resolveInviteCode: async (code) => {
      result.calls.resolved.push(code);
      return result.inviterTenantId;
    },
    completeRegistrationAttribution: async (input) => {
      result.calls.attributed.push(input);
    },
  };
}

function fixture(
  overrides: {
    settings?: Partial<RegistrationAdmissionSettings>;
    captcha?: CaptchaProof;
    affiliate?: RegistrationAffiliatePort;
    identity?: Partial<RegistrationIdentityDirectory>;
  } = {},
): {
  database: FakeSaasDatabase;
  service: RegistrationService;
  advance: (ms: number) => void;
} {
  const database = new FakeSaasDatabase();
  let nowMs = Date.UTC(2026, 9, 15, 8, 0, 0);
  const now = () => new Date(nowMs);
  const identity = new SaasIdentityService(database as never, { now });
  const sender: EmailSender = {
    send: async () => {
      // Codes are deterministic; the matrix only needs the service to record them.
    },
  };
  const verification = new EmailVerificationService({
    database: database as unknown as SaasDatabase,
    emailSender: sender,
    now,
    codeFactory: () => '123456',
  });
  const service = new RegistrationService({
    database: database as unknown as SaasDatabase,
    identity: {
      findUserAccountByEmail: (email) => identity.findUserAccountByEmail(email),
      issueSessionForUser: (userId, ttl) => identity.issueSessionForUser(userId, ttl),
      createTenant: (userId, input) => identity.createTenant(userId, input),
      ...(overrides.identity ?? {}),
    },
    verification,
    captcha: overrides.captcha ?? passthroughCaptcha,
    settings: settings(overrides.settings),
    sessionTtlSeconds: 900,
    ...(overrides.affiliate === undefined ? {} : { affiliate: overrides.affiliate }),
    now,
  } as RegistrationServiceOptions);
  return {
    database,
    service,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const rejected = (code: string) => (error: unknown) => error instanceof RegistrationError && error.code === code;

async function seedVerifiedCode(
  service: RegistrationService,
  database: FakeSaasDatabase,
  email = EMAIL,
): Promise<string> {
  await service.sendRegistrationCode({ email, createdIp: '127.0.0.1' });
  return String(database.state.emailVerificationCodes.at(-1)?.code_hash);
}

test('closed mode refuses before anything else (no code send, no user probe ordering assumptions)', async () => {
  const fxt = fixture({ settings: { mode: 'closed' } });
  await assert.rejects(
    () =>
      fxt.service.register({
        email: EMAIL,
        password: PASSWORD,
        verificationCode: '123456',
      }),
    rejected('REGISTRATION_CLOSED'),
  );
  await assert.rejects(() => fxt.service.sendRegistrationCode({ email: EMAIL }), rejected('REGISTRATION_CLOSED'));
  assert.equal(fxt.database.state.users.length, 0);
});

test('invite mode requires a resolvable invite code before domain/captcha/code checks', async () => {
  const fxt = fixture({
    settings: { mode: 'invite' },
    captcha: strictCaptcha,
    affiliate: affiliatePort({ inviterTenantId: null, calls: { resolved: [], attributed: [] } }),
  });
  await assert.rejects(
    () => fxt.service.register({ email: EMAIL, password: PASSWORD }),
    rejected('INVITE_CODE_REQUIRED'),
  );
  await assert.rejects(
    () => fxt.service.register({ email: EMAIL, password: PASSWORD, inviteCode: 'BADCODE!' }),
    rejected('INVITE_CODE_INVALID'),
  );
  await assert.rejects(
    () => fxt.service.register({ email: EMAIL, password: PASSWORD, inviteCode: 'ABC234DEF567' }),
    rejected('INVITE_CODE_INVALID'),
  );
  // The strict captcha never ran: the invite gate fails first.
  assert.equal(fxt.database.state.emailVerificationCodes.length, 0);
});

test('domain denylist rejects before captcha and code verification', async () => {
  const fxt = fixture({
    settings: { emailDomainDenylist: ['example.test'] },
    captcha: strictCaptcha,
  });
  await assert.rejects(
    () => fxt.service.register({ email: EMAIL, password: PASSWORD, verificationCode: '123456' }),
    rejected('EMAIL_DOMAIN_REJECTED'),
  );
  await assert.rejects(() => fxt.service.sendRegistrationCode({ email: EMAIL }), rejected('EMAIL_DOMAIN_REJECTED'));
});

test('domain allowlist admits only listed domains', async () => {
  const fxt = fixture({
    settings: { emailDomainAllowlist: ['trusted.test'] },
    captcha: strictCaptcha,
  });
  await assert.rejects(
    () => fxt.service.register({ email: EMAIL, password: PASSWORD, verificationCode: '123456' }),
    rejected('EMAIL_DOMAIN_REJECTED'),
  );
  // trusted.test passes the domain gate and fails at the strict captcha,
  // proving the ordering (domain before captcha).
  await assert.rejects(
    () => fxt.service.register({ email: 'user@trusted.test', password: PASSWORD, verificationCode: '123456' }),
    rejected('CAPTCHA_REJECTED'),
  );
});

test('turnstile rejection happens before code verification (a rejected captcha burns no code)', async () => {
  const fxt = fixture({ captcha: strictCaptcha });
  await seedVerifiedCode(fxt.service, fxt.database);
  await assert.rejects(
    () => fxt.service.register({ email: EMAIL, password: PASSWORD, verificationCode: '123456' }),
    rejected('CAPTCHA_REJECTED'),
  );
  // The code is still live: the row was not consumed.
  assert.equal(fxt.database.state.emailVerificationCodes[0]?.consumed_at, null);
});

test('email-existence probe runs before captcha and code (already-registered burns neither)', async () => {
  const fxt = fixture({ captcha: strictCaptcha });
  fxt.database.state.users.push({
    id: randomUUID(),
    email: EMAIL,
    email_canonical: EMAIL,
    password_hash: 'scrypt$x$y$z$s$d',
    display_name: null,
    email_verified_at: null,
    disabled_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  });
  await assert.rejects(
    () => fxt.service.register({ email: EMAIL, password: PASSWORD, verificationCode: '123456' }),
    rejected('EMAIL_ALREADY_EXISTS'),
  );
  assert.equal(fxt.database.state.emailVerificationCodes.length, 0);
});

test('missing or wrong verification code is refused when verification is required', async () => {
  const fxt = fixture();
  await seedVerifiedCode(fxt.service, fxt.database);
  await assert.rejects(
    () => fxt.service.register({ email: EMAIL, password: PASSWORD }),
    rejected('VERIFICATION_CODE_REQUIRED'),
  );
  await assert.rejects(
    () => fxt.service.register({ email: EMAIL, password: PASSWORD, verificationCode: '000000' }),
    rejected('VERIFICATION_CODE_INVALID'),
  );
});

test('full happy path: code verified, user created verified, tenant provisioned, session issued', async () => {
  const calls: AffiliateCalls = { resolved: [], attributed: [] };
  const fxt = fixture({ affiliate: affiliatePort({ inviterTenantId: INVITER_TENANT, calls }) });
  await fxt.service.sendRegistrationCode({ email: EMAIL, createdIp: '127.0.0.1' });
  const session = await fxt.service.register({
    email: EMAIL,
    password: PASSWORD,
    verificationCode: '123456',
    displayName: 'Unit User',
    inviteCode: 'ABC234WXYZ89',
  });
  assert.ok(session.token);
  const user = fxt.database.state.users[0];
  assert.equal(user?.email_canonical, EMAIL);
  assert.notEqual(user?.email_verified_at, null, 'email_verified_at is backfilled');
  assert.equal(await verifyPassword(PASSWORD, user?.password_hash), true);
  assert.equal(fxt.database.state.tenants.length, 1, 'personal tenant provisioned');
  assert.equal(fxt.database.state.emailVerificationCodes[0]?.consumed_at !== null, true);
  assert.equal(calls.resolved.length, 1);
  assert.equal(calls.attributed.length, 1);
  assert.equal(calls.attributed[0]?.inviteCode, 'ABC234WXYZ89');
});

test('happy path without an invite code skips the affiliate surface entirely', async () => {
  const calls: AffiliateCalls = { resolved: [], attributed: [] };
  const fxt = fixture({ affiliate: affiliatePort({ inviterTenantId: INVITER_TENANT, calls }) });
  await fxt.service.sendRegistrationCode({ email: EMAIL });
  await fxt.service.register({ email: EMAIL, password: PASSWORD, verificationCode: '123456' });
  assert.equal(calls.resolved.length, 0);
  assert.equal(calls.attributed.length, 0);
  assert.equal(fxt.database.state.tenants.length, 1);
});

test('email verification optional: no code needed when the switch is off', async () => {
  const fxt = fixture({ settings: { emailVerificationRequired: false } });
  const session = await fxt.service.register({ email: EMAIL, password: PASSWORD });
  assert.ok(session.token);
  assert.equal(fxt.database.state.emailVerificationCodes.length, 0);
});

test('weak passwords are refused (12-character minimum, repo convention)', async () => {
  const fxt = fixture({ settings: { emailVerificationRequired: false } });
  await assert.rejects(() => fxt.service.register({ email: EMAIL, password: 'short' }), rejected('INVALID_INPUT'));
});

test('concurrent same-email race past the probe is caught by the unique constraint', async () => {
  // The probe misses (race) but the INSERT hits the canonical-email unique
  // constraint: the registration must surface EMAIL_ALREADY_EXISTS, not 503.
  const fxt = fixture({ settings: { emailVerificationRequired: false } });
  fxt.database.state.users.push({
    id: randomUUID(),
    email: EMAIL,
    email_canonical: EMAIL,
    password_hash: 'scrypt$x$y$z$s$d',
    display_name: null,
    email_verified_at: null,
    disabled_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  });
  const service = new RegistrationService({
    database: fxt.database as unknown as SaasDatabase,
    identity: {
      findUserAccountByEmail: async () => undefined,
      issueSessionForUser: async () => {
        throw new Error('unreachable');
      },
      createTenant: async () => {
        throw new Error('unreachable');
      },
    },
    verification: new EmailVerificationService({
      database: fxt.database as unknown as SaasDatabase,
      emailSender: { send: async () => {} },
      codeFactory: () => '123456',
    }),
    captcha: passthroughCaptcha,
    settings: settings({ emailVerificationRequired: false }),
    sessionTtlSeconds: 900,
  });
  await assert.rejects(() => service.register({ email: EMAIL, password: PASSWORD }), rejected('EMAIL_ALREADY_EXISTS'));
});

test('provisioning failures never fail the registration', async () => {
  const fxt = fixture({
    identity: {
      createTenant: async () => {
        throw new Error('unit tenant failure');
      },
    },
    settings: { emailVerificationRequired: false },
  });
  const errors: Array<{ stage: string }> = [];
  const database = fxt.database;
  const service = new RegistrationService({
    database: database as unknown as SaasDatabase,
    identity: {
      findUserAccountByEmail: async () => undefined,
      issueSessionForUser: async () => ({
        token: 'unit-token',
        csrfToken: 'unit-csrf',
        session: { userId: 'unit' },
      }),
      createTenant: async () => {
        throw new Error('unit tenant failure');
      },
    },
    verification: new EmailVerificationService({
      database: database as unknown as SaasDatabase,
      emailSender: { send: async () => {} },
      codeFactory: () => '123456',
    }),
    captcha: passthroughCaptcha,
    settings: settings({ emailVerificationRequired: false }),
    sessionTtlSeconds: 900,
    onProvisioningError: (error, stage) => {
      errors.push({ stage });
      void error;
    },
  });
  const session = await service.register({ email: EMAIL, password: PASSWORD });
  assert.ok(session.token);
  assert.deepEqual(
    errors.map(({ stage }) => stage),
    ['tenant'],
  );
});

test('admission descriptor exposes the switch surface for the register view', () => {
  const fxt = fixture({
    settings: { mode: 'invite', turnstile: { enabled: true, siteKey: 'unit-site-key', secret: 'unit-secret' } },
  });
  assert.deepEqual(fxt.service.admissionDescriptor(), {
    mode: 'invite',
    emailVerificationRequired: true,
    turnstile: { enabled: true, siteKey: 'unit-site-key' },
  });
});

test('password reset: code issue is a silent no-op for unknown addresses', async () => {
  const fxt = fixture();
  await fxt.service.requestPasswordResetCode({ email: 'unknown@example.test' });
  assert.equal(fxt.database.state.emailVerificationCodes.length, 0);
});

test('password reset: confirm updates the hash and revokes every session', async () => {
  const fxt = fixture();
  // Seed an account with a known password and two live sessions.
  const userId = randomUUID();
  fxt.database.state.users.push({
    id: userId,
    email: EMAIL,
    email_canonical: EMAIL,
    password_hash: await hashPassword(PASSWORD),
    display_name: null,
    email_verified_at: null,
    disabled_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  });
  fxt.database.state.sessions.push(
    {
      id: randomUUID(),
      user_id: userId,
      token_hash: 'hash-one',
      csrf_token_hash: 'csrf-one',
      created_at: new Date(0).toISOString(),
      expires_at: new Date(Date.UTC(2030, 0, 1)).toISOString(),
      revoked_at: null,
    },
    {
      id: randomUUID(),
      user_id: userId,
      token_hash: 'hash-two',
      csrf_token_hash: 'csrf-two',
      created_at: new Date(0).toISOString(),
      expires_at: new Date(Date.UTC(2030, 0, 1)).toISOString(),
      revoked_at: null,
    },
  );
  await fxt.service.requestPasswordResetCode({ email: EMAIL });
  assert.equal(fxt.database.state.emailVerificationCodes.length, 1);
  const newPassword = 'unit-reset-password-2';
  await fxt.service.confirmPasswordReset({ email: EMAIL, code: '123456', newPassword });
  const user = fxt.database.state.users[0];
  assert.equal(await verifyPassword(newPassword, user?.password_hash), true);
  assert.equal(await verifyPassword(PASSWORD, user?.password_hash), false);
  assert.equal(
    fxt.database.state.sessions.every((session) => session.revoked_at !== null),
    true,
    'all sessions revoked',
  );
  // One-time: replaying the consumed code cannot reset again.
  await assert.rejects(
    () => fxt.service.confirmPasswordReset({ email: EMAIL, code: '123456', newPassword: 'another-unit-password' }),
    rejected('VERIFICATION_CODE_INVALID'),
  );
});

test('single-use captcha token is consumed exactly once (widget parity)', async () => {
  const fxt = fixture({ captcha: singleUseCaptcha('unit-captcha-token') });
  await fxt.service.sendRegistrationCode({ email: EMAIL });
  const session = await fxt.service.register({
    email: EMAIL,
    password: PASSWORD,
    verificationCode: '123456',
    captchaToken: 'unit-captcha-token',
  });
  assert.ok(session.token);
});
