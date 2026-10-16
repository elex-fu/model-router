import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';
import {
  REGISTRATION_ENV_VARS,
  REGISTRATION_SETTINGS_KEYS,
  resolveRegistrationAdmissionSettings,
} from '../../../../src/saas/identity/registration-settings.js';
import { PLATFORM_SETTINGS_CONSUMER_REGISTRATION_ADMISSION } from '../../../../src/saas/platform/settings/registry.js';
import { PlatformSettingsError, PlatformSettingsService } from '../../../../src/saas/platform/settings/service.js';
import { DeterministicSettingsKms, FakeSettingsDatabase } from './fakes.js';

/**
 * G4 sealed-secret consumption: the registration-admission consumer wired
 * end-to-end. Store-carried sealed secrets (Turnstile siteverify secret, SMTP
 * AUTH password) resolve store-first through the audited withSettingSecret
 * path when an unsealing KMS is wired; absent rows keep the exact env
 * fallback; and every failure mode is fail-closed (typed errors, never
 * ciphertext, never a silent undefined, never a silent env fallback against
 * a present store envelope). Test fixtures assemble provider-shaped values
 * at runtime — no secret literals.
 */

const ACTOR = Object.freeze({ actorUserId: '11111111-1111-4111-8111-111111111111', requestId: 'req-g4' });
const CONSUMER = PLATFORM_SETTINGS_CONSUMER_REGISTRATION_ADMISSION;

// Provider-shaped fixtures assembled at runtime (the repo secret red line).
const turnstileSecretFixture = `0x4${'A'.repeat(39)}`;
const smtpPasswordFixture = `smtp-${'p'.repeat(24)}-relay`;

function createWiredService() {
  const fake = new FakeSettingsDatabase();
  const kms = new DeterministicSettingsKms();
  const service = new PlatformSettingsService(fake as unknown as SaasDatabase, {
    idFactory: () => '22222222-2222-4222-8222-222222222222',
    sealingKms: kms,
    unsealingKms: kms,
    kmsKeyId: 'settings-kms-key',
    sealContext: { deployment: 'deployment-a', environment: 'production' },
  });
  return { fake, kms, service };
}

function envBaseline(): Record<string, string> {
  return {
    [REGISTRATION_ENV_VARS.mode]: 'open',
    [REGISTRATION_ENV_VARS.turnstileEnabled]: 'true',
    [REGISTRATION_ENV_VARS.turnstileSiteKey]: '0x4AAAAAAABBBBB',
    [REGISTRATION_ENV_VARS.turnstileSecret]: `0x4${'E'.repeat(39)}`,
    [REGISTRATION_ENV_VARS.smtpHost]: 'smtp.example.test',
    [REGISTRATION_ENV_VARS.smtpFrom]: 'no-reply@example.test',
    [REGISTRATION_ENV_VARS.smtpUsername]: 'mailer',
    [REGISTRATION_ENV_VARS.smtpPassword]: `smtp-${'e'.repeat(24)}-relay`,
  };
}

test('registration secrets resolve store-first through the audited unseal path', async () => {
  const { fake, service } = createWiredService();
  await service.setSecret({
    key: REGISTRATION_SETTINGS_KEYS.turnstileSecret,
    secret: turnstileSecretFixture,
    expectedVersion: 0,
    actor: ACTOR,
  });
  await service.setSecret({
    key: REGISTRATION_SETTINGS_KEYS.smtpPassword,
    secret: smtpPasswordFixture,
    expectedVersion: 0,
    actor: ACTOR,
  });

  const overlay = {
    ...(await service.readRegistrationSettingsOverlay()),
    ...(await service.readRegistrationSecretsOverlay(CONSUMER)),
  };
  const resolved = resolveRegistrationAdmissionSettings(overlay, envBaseline());

  // Store-carried secrets win over the environment.
  assert.equal(resolved.turnstile.secret, turnstileSecretFixture);
  assert.equal(resolved.smtp?.password, smtpPasswordFixture);
  assert.equal(resolved.smtp?.host, 'smtp.example.test', 'plain SMTP keys still resolve from the environment');

  // Both unseals were audited with fully redacted summaries.
  const unsealEvents = fake.auditEvents.filter((values) => values.length === 3);
  assert.equal(unsealEvents.length, 2, 'one unseal audit event per present sealed key');
  assert.deepEqual(
    unsealEvents.map((values) => values[1]).sort(),
    [REGISTRATION_SETTINGS_KEYS.smtpPassword, REGISTRATION_SETTINGS_KEYS.turnstileSecret].sort(),
  );
  for (const values of unsealEvents) assert.equal(values[2], CONSUMER);
  assert.ok(
    fake.statements.filter((statement) => statement.includes("'platform.settings.secret_unsealed'")).length === 2,
  );
  // No plaintext anywhere in the recorded SQL traffic or audit rows.
  const recorded = JSON.stringify([fake.statements, fake.auditEvents, fake.auditDetails]);
  assert.ok(!recorded.includes(turnstileSecretFixture));
  assert.ok(!recorded.includes(smtpPasswordFixture));
});

test('absent sealed rows keep the exact env fallback (empty store posture)', async () => {
  const { fake, service } = createWiredService();
  const overlay = {
    ...(await service.readRegistrationSettingsOverlay()),
    ...(await service.readRegistrationSecretsOverlay(CONSUMER)),
  };
  const env = envBaseline();
  const resolved = resolveRegistrationAdmissionSettings(overlay, env);
  assert.equal(resolved.turnstile.secret, env[REGISTRATION_ENV_VARS.turnstileSecret]);
  assert.equal(resolved.smtp?.password, env[REGISTRATION_ENV_VARS.smtpPassword]);
  assert.equal(fake.auditEvents.length, 0, 'no unseal happened for an empty store');
});

test('a partial store overlays only the present secret; the absent one falls back to env', async () => {
  const { service } = createWiredService();
  await service.setSecret({
    key: REGISTRATION_SETTINGS_KEYS.turnstileSecret,
    secret: turnstileSecretFixture,
    expectedVersion: 0,
    actor: ACTOR,
  });
  const overlay = {
    ...(await service.readRegistrationSettingsOverlay()),
    ...(await service.readRegistrationSecretsOverlay(CONSUMER)),
  };
  assert.deepEqual(Object.keys(overlay), [REGISTRATION_SETTINGS_KEYS.turnstileSecret]);
  const env = envBaseline();
  const resolved = resolveRegistrationAdmissionSettings(overlay, env);
  assert.equal(resolved.turnstile.secret, turnstileSecretFixture, 'store secret wins');
  assert.equal(resolved.smtp?.password, env[REGISTRATION_ENV_VARS.smtpPassword], 'absent key keeps env');
});

test('without an unsealing KMS the secrets overlay fails closed with a typed error', async () => {
  const fake = new FakeSettingsDatabase();
  const kms = new DeterministicSettingsKms();
  // Seal through a fully wired service, then read through a service that
  // holds no unsealing key provider (the split control-plane posture).
  const sealer = new PlatformSettingsService(fake as unknown as SaasDatabase, {
    idFactory: () => '22222222-2222-4222-8222-222222222222',
    sealingKms: kms,
    kmsKeyId: 'settings-kms-key',
    sealContext: { deployment: 'deployment-a', environment: 'production' },
  });
  await sealer.setSecret({
    key: REGISTRATION_SETTINGS_KEYS.turnstileSecret,
    secret: turnstileSecretFixture,
    expectedVersion: 0,
    actor: ACTOR,
  });
  const reader = new PlatformSettingsService(fake as unknown as SaasDatabase, {
    idFactory: () => '22222222-2222-4222-8222-222222222222',
  });
  await assert.rejects(
    reader.readRegistrationSecretsOverlay(CONSUMER),
    (error: unknown) => error instanceof PlatformSettingsError && error.code === 'UNSEALING_UNAVAILABLE',
  );
  assert.equal(fake.auditEvents.length, 1, 'only the setSecret audit event exists');
});

test('a corrupt stored envelope fails closed (UNSEAL_FAILED) instead of falling back to env', async () => {
  const { fake, service } = createWiredService();
  fake.rows.set(REGISTRATION_SETTINGS_KEYS.smtpPassword, {
    key: REGISTRATION_SETTINGS_KEYS.smtpPassword,
    value: {
      schemaVersion: 1,
      contextVersion: 1,
      algorithm: 'aes-256-gcm',
      kmsKeyId: 'settings-kms-key',
      wrappedDek: Buffer.from('not-a-real-wrapped-key').toString('base64url'),
      nonce: Buffer.alloc(12, 7).toString('base64url'),
      ciphertext: Buffer.from('forged-ciphertext').toString('base64url'),
      authTag: Buffer.alloc(16, 9).toString('base64url'),
    },
    version: 1,
    updated_by_user_id: null,
    created_at: '2026-10-15T00:00:00Z',
    updated_at: '2026-10-15T00:00:00Z',
  });
  await assert.rejects(
    service.readRegistrationSecretsOverlay(CONSUMER),
    (error: unknown) => error instanceof PlatformSettingsError && error.code === 'UNSEAL_FAILED',
  );
  assert.equal(fake.auditEvents.length, 0, 'a failed unseal records no consumption event');
});

test('the resolver-facing merged overlay keeps plain store keys winning alongside sealed keys', async () => {
  const { service } = createWiredService();
  await service.set({ key: REGISTRATION_SETTINGS_KEYS.mode, value: 'invite', expectedVersion: 0, actor: ACTOR });
  await service.setSecret({
    key: REGISTRATION_SETTINGS_KEYS.smtpPassword,
    secret: smtpPasswordFixture,
    expectedVersion: 0,
    actor: ACTOR,
  });
  const overlay = {
    ...(await service.readRegistrationSettingsOverlay()),
    ...(await service.readRegistrationSecretsOverlay(CONSUMER)),
  };
  const resolved = resolveRegistrationAdmissionSettings(overlay, envBaseline());
  assert.equal(resolved.mode, 'invite', 'plain store key wins over env');
  assert.equal(resolved.smtp?.password, smtpPasswordFixture, 'sealed store key wins over env');
});
