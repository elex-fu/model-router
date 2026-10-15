import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isEmailDomainAdmitted,
  parseRegistrationAdmissionSettings,
  REGISTRATION_ENV_VARS,
  REGISTRATION_SETTINGS_KEYS,
  RegistrationSettingsError,
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
