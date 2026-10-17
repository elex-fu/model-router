import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  readTlsFingerprintBindingForAccount,
  readTlsFingerprintProfileById,
} from '../../../src/saas/supply/tls-fingerprint-profile-lookup.js';

type QueryHandler = (sql: string, values?: readonly unknown[]) => SqlResult<Record<string, unknown>>;

function executor(handler: QueryHandler): SqlExecutor {
  return {
    query: async <Row>(sql: string, values?: readonly unknown[]) => {
      const result = handler(sql, values);
      return result as SqlResult<Row>;
    },
  };
}

const PROFILE_ROW = {
  id: 7,
  name: 'macos-node',
  enable_grease: true,
  cipher_suites: [4865, 4866],
  curves: [29, 23, 24],
  point_formats: [0],
  signature_algorithms: [1027, 2052],
  alpn_protocols: ['http/1.1'],
  supported_versions: [772, 771],
  key_share_groups: [29],
  psk_modes: [1],
  extensions: [0, 16, 51],
};

describe('readTlsFingerprintBindingForAccount (tri-state column mapping)', () => {
  const base = { ownerKind: 'tenant' as const, tenantId: 'tenant-1', accountId: 'account-1' };

  it('returns null/null when the account has no binding (fingerprint off)', async () => {
    const db = executor(() => ({ rows: [{ tls_fingerprint_profile_id: null }], rowCount: 1 }));
    const binding = await readTlsFingerprintBindingForAccount(db, base);
    assert.deepEqual(binding, { boundProfileId: null, profile: null });
  });

  it('maps the 0 sentinel (built-in default) without a profile row', async () => {
    const db = executor(() => ({ rows: [{ tls_fingerprint_profile_id: 0 }], rowCount: 1 }));
    const binding = await readTlsFingerprintBindingForAccount(db, base);
    assert.deepEqual(binding, { boundProfileId: 0, profile: null });
  });

  it('maps the -1 sentinel (randomized) without a profile row', async () => {
    const db = executor(() => ({ rows: [{ tls_fingerprint_profile_id: -1 }], rowCount: 1 }));
    const binding = await readTlsFingerprintBindingForAccount(db, base);
    assert.deepEqual(binding, { boundProfileId: -1, profile: null });
  });

  it('joins the profile row for a >0 binding', async () => {
    const db = executor(() => ({ rows: [{ tls_fingerprint_profile_id: 7, ...PROFILE_ROW }], rowCount: 1 }));
    const binding = await readTlsFingerprintBindingForAccount(db, base);
    assert.equal(binding?.boundProfileId, 7);
    assert.equal(binding?.profile?.name, 'macos-node');
    assert.equal(binding?.profile?.enableGrease, true);
    assert.deepEqual(binding?.profile?.cipherSuites, [4865, 4866]);
    assert.deepEqual(binding?.profile?.alpnProtocols, ['http/1.1']);
    assert.deepEqual(binding?.profile?.extensions, [0, 16, 51]);
  });

  it('reports a bound-but-missing profile row as boundProfileId>0 with profile null (fail-open input)', async () => {
    const db = executor(() => ({ rows: [{ tls_fingerprint_profile_id: 42 }], rowCount: 1 }));
    const binding = await readTlsFingerprintBindingForAccount(db, base);
    assert.deepEqual(binding, { boundProfileId: 42, profile: null });
  });

  it('returns null when the account row does not exist', async () => {
    const db = executor(() => ({ rows: [], rowCount: 0 }));
    const binding = await readTlsFingerprintBindingForAccount(db, base);
    assert.equal(binding, null);
  });

  it('scopes tenant lookups by (tenant_id, id) and platform lookups by id', async () => {
    let seen: { sql: string; values: readonly unknown[] } | undefined;
    const db = executor((sql, values) => {
      seen = { sql, values };
      return { rows: [], rowCount: 0 };
    });
    await readTlsFingerprintBindingForAccount(db, base);
    assert.match(seen?.sql ?? '', /saas_tenant_provider_accounts/);
    assert.match(seen?.sql ?? '', /account\.tenant_id = \$1 AND account\.id = \$2/);
    assert.deepEqual(seen?.values, ['tenant-1', 'account-1']);

    await readTlsFingerprintBindingForAccount(db, { ownerKind: 'platform', accountId: 'account-2' });
    assert.match(seen?.sql ?? '', /saas_platform_provider_accounts/);
    assert.match(seen?.sql ?? '', /account\.id = \$1/);
  });

  it('throws on a malformed row (fail-closed read validation)', async () => {
    const db = executor(() => ({ rows: [{ tls_fingerprint_profile_id: 'not-a-number' }], rowCount: 1 }));
    await assert.rejects(() => readTlsFingerprintBindingForAccount(db, base), /malformed row/);
  });
});

describe('readTlsFingerprintProfileById', () => {
  it('maps a full profile row with bounded list re-validation', async () => {
    const db = executor(() => ({ rows: [PROFILE_ROW], rowCount: 1 }));
    const profile = await readTlsFingerprintProfileById(db, 7);
    assert.equal(profile?.id, 7);
    assert.deepEqual(profile?.signatureAlgorithms, [1027, 2052]);
  });

  it('degrades malformed list payloads to empty arrays (sidecar uses defaults)', async () => {
    const db = executor(() => ({
      rows: [{ ...PROFILE_ROW, cipher_suites: 'oops', extensions: [70000, -1] }],
      rowCount: 1,
    }));
    const profile = await readTlsFingerprintProfileById(db, 7);
    assert.deepEqual(profile?.cipherSuites, []);
    assert.deepEqual(profile?.extensions, []);
  });

  it('returns null for a missing row', async () => {
    const db = executor(() => ({ rows: [], rowCount: 0 }));
    assert.equal(await readTlsFingerprintProfileById(db, 99), null);
  });
});
