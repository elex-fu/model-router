import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY } from '../../../../src/saas/billing/groups/multiplier.js';
import type {
  GenerateProviderCredentialDataKeyRequest,
  ProviderCredentialKms,
} from '../../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';
import { REGISTRATION_SETTINGS_KEYS } from '../../../../src/saas/identity/registration-settings.js';
import {
  type PlatformSettingRecord,
  PlatformSettingsError,
  PlatformSettingsService,
} from '../../../../src/saas/platform/settings/service.js';

/**
 * F1 platform settings store: the service contract (strict per-key parsing,
 * version CAS, audited mutations with redacted secret diffs, sealed-secret
 * round trip, and the registration/topup consumption reads). The fake
 * database is the scripted-results style of tests/saas/billing/groups.test.ts
 * with a small stateful settings table.
 */

interface FakeRow {
  key: string;
  value: unknown;
  version: number;
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

class FakeSettingsDatabase {
  readonly statements: string[] = [];
  readonly auditEvents: Array<readonly unknown[]> = [];
  readonly auditDetails: Array<readonly unknown[]> = [];
  readonly rows = new Map<string, FakeRow>();
  readonly now = '2026-10-16T00:00:00Z';

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.statements.push(`${sql.trim().replace(/\s+/g, ' ')} :: ${values.join('|')}`);
    return this.execute<Row>(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work({
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        this.statements.push(`${sql.trim().replace(/\s+/g, ' ')} :: ${values.join('|')}`);
        return this.execute<Row>(sql, values);
      },
    });
  }

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const flat = sql.trim().replace(/\s+/g, ' ');
    if (flat.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
    if (flat.includes('SELECT key, value, version FROM saas_platform_settings WHERE key = $1 FOR UPDATE')) {
      const row = this.rows.get(String(values[0]));
      return { rows: row === undefined ? [] : [row as Row], rowCount: row === undefined ? 0 : 1 };
    }
    if (flat.includes('INSERT INTO saas_platform_settings_audit_details')) {
      this.auditDetails.push(values);
      return { rows: [{ audit_event_id: values[0] } as Row], rowCount: 1 };
    }
    if (flat.includes('INSERT INTO saas_platform_settings (')) {
      const key = String(values[0]);
      if (this.rows.has(key)) return { rows: [], rowCount: 0 };
      const row: FakeRow = {
        key,
        value: JSON.parse(String(values[1])),
        version: 1,
        updated_by_user_id: (values[2] as string | null) ?? null,
        created_at: this.now,
        updated_at: this.now,
      };
      this.rows.set(key, row);
      return { rows: [row as Row], rowCount: 1 };
    }
    if (flat.includes('UPDATE saas_platform_settings')) {
      const key = String(values[0]);
      const row = this.rows.get(key);
      if (row === undefined || row.version !== Number(values[3])) return { rows: [], rowCount: 0 };
      row.value = JSON.parse(String(values[1]));
      row.version += 1;
      row.updated_by_user_id = (values[2] as string | null) ?? null;
      row.updated_at = this.now;
      return { rows: [row as Row], rowCount: 1 };
    }
    if (flat.includes('INSERT INTO saas_audit_events')) {
      this.auditEvents.push(values);
      return { rows: [{ id: values[0] } as Row], rowCount: 1 };
    }
    if (flat.includes('INSERT INTO saas_platform_settings_audit_details')) {
      this.auditDetails.push(values);
      return { rows: [{ audit_event_id: values[0] } as Row], rowCount: 1 };
    }
    if (flat.includes('WHERE key = ANY($1::text[])')) {
      const wanted = values[0] as readonly string[];
      const rows = wanted
        .map((key) => this.rows.get(key))
        .filter((row): row is FakeRow => row !== undefined)
        .map((row) => ({ key: row.key, value: row.value }));
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (flat.includes('SELECT value FROM saas_platform_settings WHERE key = $1')) {
      const row = this.rows.get(String(values[0]));
      return { rows: (row === undefined ? [] : [{ value: row.value }]) as Row[], rowCount: row === undefined ? 0 : 1 };
    }
    if (flat.includes('FROM saas_platform_settings')) {
      const rows = [...this.rows.values()].sort((left, right) => left.key.localeCompare(right.key));
      return { rows: rows as Row[], rowCount: rows.length };
    }
    throw new Error(`unhandled fake SQL: ${sql}`);
  }
}

class DeterministicKms implements ProviderCredentialKms {
  private readonly keys = new Map<string, Buffer>();
  private sequence = 0;

  async generateDataKey(_request: GenerateProviderCredentialDataKeyRequest) {
    const plaintextKey = Buffer.alloc(32, this.sequence + 1);
    const ciphertextBlob = Buffer.from(`wrapped-settings-${this.sequence}`, 'utf-8');
    this.sequence += 1;
    this.keys.set(ciphertextBlob.toString('base64url'), Buffer.from(plaintextKey));
    return { plaintextKey, ciphertextBlob };
  }

  async decryptDataKey(request: { readonly ciphertextBlob: Uint8Array }): Promise<Uint8Array> {
    const key = this.keys.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    if (!key) throw new Error('unknown wrapped key');
    return Buffer.from(key);
  }
}

const ACTOR = Object.freeze({ actorUserId: '11111111-1111-4111-8111-111111111111', requestId: 'req-1' });

function createService(overrides: { readonly rows?: readonly FakeRow[] } = {}) {
  const fake = new FakeSettingsDatabase();
  for (const row of overrides.rows ?? []) fake.rows.set(row.key, row);
  const service = new PlatformSettingsService(fake as unknown as SaasDatabase, {
    idFactory: () => '22222222-2222-4222-8222-222222222222',
  });
  return { fake, service };
}

function createSealingService() {
  const fake = new FakeSettingsDatabase();
  // One KMS instance plays both roles (the local master-key seam): the
  // wrapped data keys it generates are the ones it can decrypt.
  const kms = new DeterministicKms();
  const service = new PlatformSettingsService(fake as unknown as SaasDatabase, {
    idFactory: () => '22222222-2222-4222-8222-222222222222',
    sealingKms: kms,
    unsealingKms: kms,
    kmsKeyId: 'settings-kms-key',
    sealContext: { deployment: 'deployment-a', environment: 'production' },
  });
  return { fake, service };
}

test('set validates through the strict per-key parser and creates an audited version-1 row', async () => {
  const { fake, service } = createService();
  const record = await service.set({
    key: REGISTRATION_SETTINGS_KEYS.mode,
    value: 'open',
    expectedVersion: 0,
    actor: ACTOR,
  });
  assert.equal(record.key, REGISTRATION_SETTINGS_KEYS.mode);
  assert.equal(record.value, 'open');
  assert.equal(record.version, 1);
  assert.equal(record.secret, false);
  assert.equal(fake.rows.size, 1);
  assert.deepEqual(fake.rows.get(REGISTRATION_SETTINGS_KEYS.mode)?.value, { value: 'open' });
  assert.equal(fake.auditEvents.length, 1);
  assert.equal(fake.auditDetails.length, 1);
  const [auditEventId, actorUserId, targetKey] = fake.auditEvents[0] ?? [];
  assert.equal(auditEventId, '22222222-2222-4222-8222-222222222222');
  assert.equal(actorUserId, ACTOR.actorUserId);
  assert.equal(targetKey, REGISTRATION_SETTINGS_KEYS.mode);
  assert.ok(
    fake.statements.some(
      (statement) => statement.includes("'platform.settings.updated'") && statement.includes("'platform_settings'"),
    ),
    'the audit event carries the platform.settings.updated action and platform_settings target type',
  );
  const details = fake.auditDetails[0] ?? [];
  assert.equal(details[0], auditEventId);
  assert.equal(details[1], REGISTRATION_SETTINGS_KEYS.mode);
  assert.equal(details[2], null, 'before_version is null on creation');
  assert.equal(details[3], 1);
  assert.deepEqual(JSON.parse(String(details[4])), ['value: <missing> → open']);
});

test('set rejects values the strict parser refuses, without writing', async () => {
  const { fake, service } = createService();
  await assert.rejects(
    service.set({ key: REGISTRATION_SETTINGS_KEYS.mode, value: 'public', expectedVersion: 0, actor: ACTOR }),
    (error: unknown) => error instanceof PlatformSettingsError && error.code === 'INVALID_VALUE',
  );
  await assert.rejects(
    service.set({
      key: REGISTRATION_SETTINGS_KEYS.emailDomainAllowlist,
      value: 'not a domain',
      expectedVersion: 0,
      actor: ACTOR,
    }),
    (error: unknown) => error instanceof PlatformSettingsError && error.code === 'INVALID_VALUE',
  );
  await assert.rejects(
    service.set({
      key: TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY,
      value: { nope: true },
      expectedVersion: 0,
      actor: ACTOR,
    }),
    (error: unknown) => error instanceof PlatformSettingsError && error.code === 'INVALID_VALUE',
  );
  assert.equal(fake.rows.size, 0);
  assert.equal(fake.auditEvents.length, 0);
});

test('set rejects unregistered keys and the plain path on sealed keys', async () => {
  const { service } = createService();
  await assert.rejects(
    service.set({ key: 'saas.unknown.key', value: 'x', expectedVersion: 0, actor: ACTOR }),
    (error: unknown) => error instanceof PlatformSettingsError && error.code === 'INVALID_KEY',
  );
  await assert.rejects(
    service.set({ key: REGISTRATION_SETTINGS_KEYS.turnstileSecret, value: 'x', expectedVersion: 0, actor: ACTOR }),
    (error: unknown) => error instanceof PlatformSettingsError && error.code === 'INVALID_VALUE',
  );
});

test('update path enforces optimistic version CAS and records the before/after diff', async () => {
  const { fake, service } = createService({
    rows: [
      {
        key: REGISTRATION_SETTINGS_KEYS.mode,
        value: { value: 'open' },
        version: 3,
        updated_by_user_id: null,
        created_at: '2026-10-15T00:00:00Z',
        updated_at: '2026-10-15T00:00:00Z',
      },
    ],
  });
  await assert.rejects(
    service.set({ key: REGISTRATION_SETTINGS_KEYS.mode, value: 'invite', expectedVersion: 2, actor: ACTOR }),
    (error: unknown) => error instanceof PlatformSettingsError && error.code === 'VERSION_CONFLICT',
  );
  await assert.rejects(
    service.set({
      key: REGISTRATION_SETTINGS_KEYS.emailVerificationRequired,
      value: 'true',
      expectedVersion: 1,
      actor: ACTOR,
    }),
    (error: unknown) => error instanceof PlatformSettingsError && error.code === 'NOT_FOUND',
  );
  const updated = await service.set({
    key: REGISTRATION_SETTINGS_KEYS.mode,
    value: 'invite',
    expectedVersion: 3,
    actor: ACTOR,
  });
  assert.equal(updated.version, 4);
  const details = fake.auditDetails[0] ?? [];
  assert.equal(details[2], 3, 'before_version');
  assert.equal(details[3], 4, 'after_version');
  assert.deepEqual(JSON.parse(String(details[4])), ['value: open → invite']);
});

test('an identical-value write is rejected as UNCHANGED with no audit rows', async () => {
  const { fake, service } = createService({
    rows: [
      {
        key: REGISTRATION_SETTINGS_KEYS.mode,
        value: { value: 'open' },
        version: 1,
        updated_by_user_id: null,
        created_at: '2026-10-15T00:00:00Z',
        updated_at: '2026-10-15T00:00:00Z',
      },
    ],
  });
  await assert.rejects(
    service.set({ key: REGISTRATION_SETTINGS_KEYS.mode, value: 'open', expectedVersion: 1, actor: ACTOR }),
    (error: unknown) => error instanceof PlatformSettingsError && error.code === 'UNCHANGED',
  );
  assert.equal(fake.auditEvents.length, 0);
  assert.equal(fake.auditDetails.length, 0);
});

test('sealed secrets round-trip through the KMS seam and never persist plaintext', async () => {
  const { fake, service } = createSealingService();
  const record = await service.setSecret({
    key: REGISTRATION_SETTINGS_KEYS.turnstileSecret,
    secret: 'turnstile-secret-value',
    expectedVersion: 0,
    actor: ACTOR,
  });
  assert.equal(record.secret, true);
  assert.equal(record.value, undefined, 'sealed records never expose a value');
  const stored = fake.rows.get(REGISTRATION_SETTINGS_KEYS.turnstileSecret)?.value as Record<string, unknown>;
  assert.equal(stored.algorithm, 'aes-256-gcm');
  assert.equal(stored.kmsKeyId, 'settings-kms-key');
  assert.ok(typeof stored.wrappedDek === 'string');
  assert.ok(typeof stored.ciphertext === 'string');
  assert.ok(!('value' in stored), 'the sealed envelope carries no plain value key');
  assert.ok(!JSON.stringify(stored).includes('turnstile-secret-value'));
  // The audit diff is fully redacted and carries no envelope bytes.
  const details = fake.auditDetails[0] ?? [];
  assert.deepEqual(JSON.parse(String(details[4])), ['[redacted] → [redacted]']);
  assert.ok(!JSON.stringify(fake.auditDetails).includes('turnstile-secret-value'));

  const unsealed = await service.withSettingSecret(REGISTRATION_SETTINGS_KEYS.turnstileSecret, (secret) => secret);
  assert.equal(unsealed, 'turnstile-secret-value');
});

test('sealed secrets fail closed without the KMS seams', async () => {
  const { service } = createService();
  await assert.rejects(
    service.setSecret({
      key: REGISTRATION_SETTINGS_KEYS.smtpPassword,
      secret: 'smtp-password',
      expectedVersion: 0,
      actor: ACTOR,
    }),
    (error: unknown) => error instanceof PlatformSettingsError && error.code === 'SEALING_UNAVAILABLE',
  );
  await assert.rejects(
    service.withSettingSecret(REGISTRATION_SETTINGS_KEYS.turnstileSecret, (secret) => secret),
    (error: unknown) => error instanceof PlatformSettingsError && error.code === 'UNSEALING_UNAVAILABLE',
  );
});

test('list exposes plain values and marks sealed rows without values', async () => {
  const { service } = createSealingService();
  await service.set({ key: REGISTRATION_SETTINGS_KEYS.mode, value: 'invite', expectedVersion: 0, actor: ACTOR });
  await service.setSecret({
    key: REGISTRATION_SETTINGS_KEYS.smtpPassword,
    secret: 'smtp-password-value',
    expectedVersion: 0,
    actor: ACTOR,
  });
  const records: readonly PlatformSettingRecord[] = await service.list();
  assert.equal(records.length, 2);
  const mode = records.find((record) => record.key === REGISTRATION_SETTINGS_KEYS.mode);
  assert.equal(mode?.value, 'invite');
  assert.equal(mode?.secret, false);
  const password = records.find((record) => record.key === REGISTRATION_SETTINGS_KEYS.smtpPassword);
  assert.equal(password?.secret, true);
  assert.equal(password?.value, undefined);
});

test('readRegistrationSettingsOverlay returns only present plain registration values', async () => {
  const { service } = createService({
    rows: [
      {
        key: REGISTRATION_SETTINGS_KEYS.mode,
        value: { value: 'invite' },
        version: 1,
        updated_by_user_id: null,
        created_at: '2026-10-15T00:00:00Z',
        updated_at: '2026-10-15T00:00:00Z',
      },
      {
        key: REGISTRATION_SETTINGS_KEYS.rewardGrant,
        value: { value: '2500' },
        version: 1,
        updated_by_user_id: null,
        created_at: '2026-10-15T00:00:00Z',
        updated_at: '2026-10-15T00:00:00Z',
      },
    ],
  });
  const overlay = await service.readRegistrationSettingsOverlay();
  assert.deepEqual(overlay, {
    [REGISTRATION_SETTINGS_KEYS.mode]: 'invite',
    [REGISTRATION_SETTINGS_KEYS.rewardGrant]: '2500',
  });
});

test('readTopupAmountTierDiscounts: absent key is no tiers; stored value re-parses strictly', async () => {
  const { service } = createService();
  assert.deepEqual(await service.readTopupAmountTierDiscounts(), []);
  const { service: seeded } = createService({
    rows: [
      {
        key: TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY,
        value: {
          value: [
            { thresholdMinorUnits: '100000', discountNumerator: '95', discountDenominator: '100' },
            { thresholdMinorUnits: '1000000', discountNumerator: '9', discountDenominator: '10' },
          ],
        },
        version: 1,
        updated_by_user_id: null,
        created_at: '2026-10-15T00:00:00Z',
        updated_at: '2026-10-15T00:00:00Z',
      },
    ],
  });
  const tiers = await seeded.readTopupAmountTierDiscounts();
  assert.equal(tiers.length, 2);
  assert.equal(tiers[0]?.thresholdMinorUnits, 100000n);
  assert.deepEqual(tiers[0]?.discountMultiplier, { numerator: 95n, denominator: 100n });
  assert.deepEqual(tiers[1]?.discountMultiplier, { numerator: 9n, denominator: 10n });
});

test('the stored topup-tier value comes from the same strict parser as set()', async () => {
  const { fake, service } = createService();
  await service.set({
    key: TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY,
    value: [
      { thresholdMinorUnits: '100000', discountNumerator: 95, discountDenominator: 100 },
      { thresholdMinorUnits: '50000', discountNumerator: 97, discountDenominator: 100 },
    ],
    expectedVersion: 0,
    actor: ACTOR,
  });
  const stored = fake.rows.get(TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY)?.value as { value: unknown[] };
  // Normalized: ascending thresholds, stringified rational parts.
  assert.deepEqual(stored.value, [
    { thresholdMinorUnits: '50000', discountNumerator: '97', discountDenominator: '100' },
    { thresholdMinorUnits: '100000', discountNumerator: '95', discountDenominator: '100' },
  ]);
  const tiers = await service.readTopupAmountTierDiscounts();
  assert.deepEqual(tiers[0]?.discountMultiplier, { numerator: 97n, denominator: 100n });
});
