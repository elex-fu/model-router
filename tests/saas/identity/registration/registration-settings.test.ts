import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isEmailDomainAdmitted,
  parseRegistrationAdmissionSettings,
  parseRegistrationSettingValue,
  REGISTRATION_ENV_VARS,
  REGISTRATION_SECRET_SETTINGS_KEYS,
  REGISTRATION_SETTINGS_KEYS,
  RegistrationSettingsError,
  resolveRegistrationAdmissionSettings,
} from '../../../../src/saas/identity/registration-settings.js';

/** R4 registration admission: the strict settings normalizer (fail-closed defaults). */

const env = (overrides: Record<string, string> = {}): Record<string, string | undefined> => ({
  ...Object.fromEntries(Object.values(REGISTRATION_ENV_VARS).map((name) => [name, undefined])),
  ...overrides,
});

test('defaults are fail-closed: closed mode, verification required, no captcha, no SMTP, zero rewards', () => {
  const settings = parseRegistrationAdmissionSettings(env());
  assert.equal(settings.mode, 'closed');
  assert.equal(settings.emailVerificationRequired, true);
  assert.deepEqual(settings.emailDomainAllowlist, []);
  assert.deepEqual(settings.emailDomainDenylist, []);
  assert.deepEqual(settings.turnstile, { enabled: false });
  assert.equal(settings.smtp, undefined);
  assert.deepEqual(settings.rewards, {
    currency: 'USD',
    grantMinorUnits: '0',
    codeFillerMinorUnits: '0',
    codeOwnerMinorUnits: '0',
    codeOwnerMinThresholdMinorUnits: '0',
  });
});

test('a full open-mode configuration parses with normalization', () => {
  const settings = parseRegistrationAdmissionSettings(
    env({
      [REGISTRATION_ENV_VARS.mode]: 'open',
      [REGISTRATION_ENV_VARS.emailVerification]: 'false',
      [REGISTRATION_ENV_VARS.domainAllowlist]: ' Example.COM , trusted.test ',
      [REGISTRATION_ENV_VARS.domainDenylist]: 'burner.test',
      [REGISTRATION_ENV_VARS.turnstileEnabled]: 'true',
      [REGISTRATION_ENV_VARS.turnstileSiteKey]: 'unit-site-key',
      [REGISTRATION_ENV_VARS.turnstileSecret]: 'unit-secret',
      [REGISTRATION_ENV_VARS.smtpHost]: 'smtp.example.test',
      [REGISTRATION_ENV_VARS.smtpPort]: '465',
      [REGISTRATION_ENV_VARS.smtpSecure]: 'true',
      [REGISTRATION_ENV_VARS.smtpUsername]: 'postmaster',
      [REGISTRATION_ENV_VARS.smtpPassword]: 'unit-smtp-password',
      [REGISTRATION_ENV_VARS.smtpFrom]: 'noreply@example.test',
      [REGISTRATION_ENV_VARS.rewardCurrency]: 'eur',
      [REGISTRATION_ENV_VARS.rewardGrant]: '1000',
      [REGISTRATION_ENV_VARS.rewardCodeFiller]: '500',
      [REGISTRATION_ENV_VARS.rewardCodeOwner]: '300',
      [REGISTRATION_ENV_VARS.rewardCodeOwnerMinThreshold]: '100',
    }),
  );
  assert.equal(settings.mode, 'open');
  assert.equal(settings.emailVerificationRequired, false);
  assert.deepEqual(settings.emailDomainAllowlist, ['example.com', 'trusted.test']);
  assert.deepEqual(settings.emailDomainDenylist, ['burner.test']);
  assert.deepEqual(settings.turnstile, { enabled: true, siteKey: 'unit-site-key', secret: 'unit-secret' });
  assert.deepEqual(settings.smtp, {
    host: 'smtp.example.test',
    port: 465,
    secure: true,
    username: 'postmaster',
    password: 'unit-smtp-password',
    from: 'noreply@example.test',
  });
  assert.deepEqual(settings.rewards, {
    currency: 'EUR',
    grantMinorUnits: '1000',
    codeFillerMinorUnits: '500',
    codeOwnerMinorUnits: '300',
    codeOwnerMinThresholdMinorUnits: '100',
  });
});

test('invalid values fail closed at parse time', () => {
  const rejected = (overrides: Record<string, string>) =>
    assert.throws(
      () => parseRegistrationAdmissionSettings(env(overrides)),
      (error: unknown) => error instanceof RegistrationSettingsError,
    );
  rejected({ [REGISTRATION_ENV_VARS.mode]: 'public' });
  rejected({ [REGISTRATION_ENV_VARS.emailVerification]: 'yes' });
  rejected({ [REGISTRATION_ENV_VARS.domainAllowlist]: 'not a domain' });
  rejected({ [REGISTRATION_ENV_VARS.domainAllowlist]: 'dup.test', [REGISTRATION_ENV_VARS.domainDenylist]: 'dup.test' });
  rejected({ [REGISTRATION_ENV_VARS.turnstileEnabled]: 'true' }); // missing site key + secret
  rejected({ [REGISTRATION_ENV_VARS.turnstileEnabled]: 'true', [REGISTRATION_ENV_VARS.turnstileSiteKey]: 'k' }); // missing secret
  rejected({ [REGISTRATION_ENV_VARS.smtpHost]: 'smtp.example.test' }); // missing From
  rejected({
    [REGISTRATION_ENV_VARS.smtpHost]: 'smtp.example.test',
    [REGISTRATION_ENV_VARS.smtpFrom]: 'noreply@example.test',
    [REGISTRATION_ENV_VARS.smtpUsername]: 'postmaster',
  }); // username without password
  rejected({
    [REGISTRATION_ENV_VARS.smtpHost]: 'smtp.example.test',
    [REGISTRATION_ENV_VARS.smtpFrom]: 'noreply@example.test',
    [REGISTRATION_ENV_VARS.smtpPort]: '99999',
  });
  rejected({ [REGISTRATION_ENV_VARS.rewardCurrency]: 'dollars' });
  rejected({ [REGISTRATION_ENV_VARS.rewardGrant]: '-5' });
  rejected({ [REGISTRATION_ENV_VARS.rewardGrant]: '1.5' });
});

test('domain admission: denylist wins; a non-empty allowlist is exhaustive', () => {
  const denied = parseRegistrationAdmissionSettings(env({ [REGISTRATION_ENV_VARS.domainDenylist]: 'blocked.test' }));
  assert.equal(isEmailDomainAdmitted(denied, 'user@blocked.test'), false);
  assert.equal(isEmailDomainAdmitted(denied, 'user@other.test'), true);

  const allowlisted = parseRegistrationAdmissionSettings(
    env({ [REGISTRATION_ENV_VARS.domainAllowlist]: 'trusted.test' }),
  );
  assert.equal(isEmailDomainAdmitted(allowlisted, 'user@trusted.test'), true);
  assert.equal(isEmailDomainAdmitted(allowlisted, 'user@untrusted.test'), false);
  assert.equal(isEmailDomainAdmitted(allowlisted, 'user@sub.trusted.test'), false, 'no subdomain wildcarding');

  const open = parseRegistrationAdmissionSettings(env());
  assert.equal(isEmailDomainAdmitted(open, 'user@anywhere.test'), true);
});

test('every reserved settings key lives in the saas.identity.registration namespace', () => {
  for (const key of Object.values(REGISTRATION_SETTINGS_KEYS)) {
    assert.match(key, /^saas\.identity\.registration\.[a-z0-9_.]+$/, `namespaced key: ${key}`);
  }
  assert.equal(Object.keys(REGISTRATION_SETTINGS_KEYS).length, 18);
});

test('parseRegistrationSettingValue enforces the same per-key grammar, fail-closed', () => {
  const key = REGISTRATION_SETTINGS_KEYS;
  assert.equal(parseRegistrationSettingValue(key.mode, 'invite'), 'invite');
  assert.equal(parseRegistrationSettingValue(key.emailVerificationRequired, 'false'), 'false');
  assert.equal(
    parseRegistrationSettingValue(key.emailDomainAllowlist, ' Example.COM , trusted.test '),
    'example.com,trusted.test',
  );
  assert.equal(parseRegistrationSettingValue(key.smtpPort, '465'), '465');
  assert.equal(parseRegistrationSettingValue(key.rewardCurrency, 'eur'), 'EUR');
  assert.equal(parseRegistrationSettingValue(key.rewardGrant, '1500'), '1500');
  for (const [settingsKey, value] of [
    [key.mode, 'public'],
    [key.emailVerificationRequired, 'yes'],
    [key.emailDomainAllowlist, 'not a domain'],
    [key.turnstileSiteKey, ' has space '],
    [key.smtpPort, '99999'],
    [key.rewardCurrency, 'dollars'],
    [key.rewardGrant, '-5'],
    ['saas.identity.registration.unknown', 'x'],
  ] as const) {
    assert.throws(
      () => parseRegistrationSettingValue(settingsKey, value),
      (error: unknown) => error instanceof RegistrationSettingsError,
      `${settingsKey} = ${JSON.stringify(value)} must fail closed`,
    );
  }
  for (const secretKey of REGISTRATION_SECRET_SETTINGS_KEYS) {
    assert.throws(
      () => parseRegistrationSettingValue(secretKey, 'plaintext-secret'),
      (error: unknown) => error instanceof RegistrationSettingsError,
      'secret keys have no plaintext grammar',
    );
  }
});

test('store-first resolution: a store hit wins, an empty store keeps the env posture', () => {
  const key = REGISTRATION_SETTINGS_KEYS;
  const envBaseline = env({
    [REGISTRATION_ENV_VARS.mode]: 'closed',
    [REGISTRATION_ENV_VARS.domainDenylist]: 'burner.test',
    [REGISTRATION_ENV_VARS.rewardGrant]: '100',
  });
  // Empty store: exactly the env behavior.
  const fallback = resolveRegistrationAdmissionSettings({}, envBaseline);
  assert.equal(fallback.mode, 'closed');
  assert.deepEqual(fallback.emailDomainDenylist, ['burner.test']);
  assert.equal(fallback.rewards.grantMinorUnits, '100');
  // Store hit wins over env for the same key; env-only keys stay env-backed.
  const overridden = resolveRegistrationAdmissionSettings(
    {
      [key.mode]: 'open',
      [key.emailDomainDenylist]: 'spam.test',
    },
    envBaseline,
  );
  assert.equal(overridden.mode, 'open');
  assert.deepEqual(overridden.emailDomainDenylist, ['spam.test']);
  assert.equal(overridden.rewards.grantMinorUnits, '100', 'untouched keys keep the env value');
  // An empty-string store value is treated as absent (env fallback), matching
  // the env parser's blank-means-default semantics.
  const blank = resolveRegistrationAdmissionSettings({ [key.mode]: '' }, envBaseline);
  assert.equal(blank.mode, 'closed');
});

test('store-first resolution keeps the full parser cross-field rules fail-closed', () => {
  const envBaseline = env();
  // Enabling Turnstile from the store without any secret anywhere fails
  // exactly like the env-only path would.
  assert.throws(
    () => resolveRegistrationAdmissionSettings({ [REGISTRATION_SETTINGS_KEYS.turnstileEnabled]: 'true' }, envBaseline),
    (error: unknown) => error instanceof RegistrationSettingsError,
  );
  // With the secret still env-backed, the store-side enable works.
  const enabled = resolveRegistrationAdmissionSettings(
    { [REGISTRATION_SETTINGS_KEYS.turnstileEnabled]: 'true' },
    env({
      [REGISTRATION_ENV_VARS.turnstileSiteKey]: 'unit-site-key',
      [REGISTRATION_ENV_VARS.turnstileSecret]: 'unit-secret',
    }),
  );
  assert.deepEqual(enabled.turnstile, { enabled: true, siteKey: 'unit-site-key', secret: 'unit-secret' });
});

test('registration store-first fail-closed wiring: resolution failure degrades to closed defaults', async () => {
  // Mirrors managed-saas.ts's resolveRegistrationSettingsFailClosed: a broken
  // overlay (a value the strict parser rejects) must degrade to the parser's
  // empty-source defaults rather than admitting traffic.
  const { RegistrationService } = await import('../../../../src/saas/identity/register-service.js');
  const brokenOverlay = { 'saas.identity.registration.mode': 'not-a-mode' };
  const service = new RegistrationService({
    database: { transaction: async () => undefined } as never,
    identity: { findUserAccountByEmail: async () => undefined } as never,
    verification: { issueCode: async () => undefined, verifyCode: async () => undefined } as never,
    captcha: { backend: 'disabled', verify: async () => true },
    settings: parseRegistrationAdmissionSettings(env({ [REGISTRATION_ENV_VARS.mode]: 'open' })),
    settingsResolver: async () => resolveRegistrationAdmissionSettings(brokenOverlay, env()),
    sessionTtlSeconds: 3600,
  });
  const descriptor = await service.resolveAdmissionDescriptor();
  assert.equal(descriptor.mode, 'closed', 'a broken overlay fails closed, ignoring the open env snapshot');
  await assert.rejects(
    service.sendRegistrationCode({ email: 'user@example.test' }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'REGISTRATION_CLOSED',
  );
});
