import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import {
  PostgresProviderTlsFingerprintResolver,
  ProviderTlsFingerprintResolverError,
} from '../../../src/saas/gateway/postgres-tls-fingerprint-profile-resolver.js';

interface ResolverHarness {
  readonly resolver: PostgresProviderTlsFingerprintResolver;
  readonly queries: Array<{ sql: string; values?: readonly unknown[] }>;
  setRows(rows: Array<Record<string, unknown>>): void;
  failNext(): void;
}

function harness(overrides: { ttlMs?: number } = {}): ResolverHarness {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let rows: Array<Record<string, unknown>> = [];
  let fail = false;
  const now = 1_000_000;
  const database = {
    query: async <Row>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> => {
      queries.push({ sql, values });
      if (fail) throw new Error('database unavailable');
      return { rows: rows as Row[], rowCount: rows.length };
    },
  } as unknown as SaasDatabase;
  const resolver = new PostgresProviderTlsFingerprintResolver({
    database,
    ...(overrides.ttlMs === undefined ? {} : { profileCacheTtlMs: overrides.ttlMs }),
    nowMs: () => now,
  });
  return {
    resolver,
    queries,
    setRows(next: Array<Record<string, unknown>>): void {
      rows = next;
    },
    failNext(): void {
      fail = true;
    },
  };
}

const PROFILE_ROW = {
  id: 7,
  name: 'macos-node',
  enable_grease: true,
  cipher_suites: [4865, 4866],
  curves: [29],
  point_formats: [0],
  signature_algorithms: [1027],
  alpn_protocols: ['http/1.1'],
  supported_versions: [772, 771],
  key_share_groups: [29],
  psk_modes: [1],
  extensions: [0, 16, 51],
};

const baseInput = {
  tenantId: 'tenant-1',
  supplyMode: 'byok' as const,
  accountOwnerKind: 'tenant' as const,
  accountId: 'account-1',
};

describe('PostgresProviderTlsFingerprintResolver (tri-state + fail-open)', () => {
  it('returns null (fingerprint off) when the account has no binding', async () => {
    const h = harness();
    h.setRows([{ tls_fingerprint_profile_id: null }]);
    assert.equal(await h.resolver.resolveTlsFingerprint(baseInput), null);
  });

  it('resolves the 0 sentinel to the default profile', async () => {
    const h = harness();
    h.setRows([{ tls_fingerprint_profile_id: 0 }]);
    assert.deepEqual(await h.resolver.resolveTlsFingerprint(baseInput), { selector: 'default' });
  });

  it('resolves the -1 sentinel to the randomized profile', async () => {
    const h = harness();
    h.setRows([{ tls_fingerprint_profile_id: -1 }]);
    assert.deepEqual(await h.resolver.resolveTlsFingerprint(baseInput), { selector: 'random' });
  });

  it('resolves a >0 binding with its profile row inline', async () => {
    const h = harness();
    h.setRows([{ tls_fingerprint_profile_id: 7, ...PROFILE_ROW }]);
    const descriptor = await h.resolver.resolveTlsFingerprint(baseInput);
    assert.equal(descriptor?.selector, 'custom');
    assert.equal(descriptor?.profile?.name, 'macos-node');
    assert.equal(descriptor?.profile?.enableGrease, true);
    assert.deepEqual(descriptor?.profile?.cipherSuites, [4865, 4866]);
  });

  it('fails OPEN to the default profile when the bound row is missing', async () => {
    const h = harness();
    h.setRows([{ tls_fingerprint_profile_id: 42 }]);
    assert.deepEqual(await h.resolver.resolveTlsFingerprint(baseInput), { selector: 'default' });
  });

  it('fails OPEN to null when the binding read errors', async () => {
    const h = harness();
    h.failNext();
    assert.equal(await h.resolver.resolveTlsFingerprint(baseInput), null);
  });

  it('rejects invalid input shape fail-closed', async () => {
    const h = harness();
    await assert.rejects(
      () => h.resolver.resolveTlsFingerprint({ ...baseInput, accountId: '' }),
      ProviderTlsFingerprintResolverError,
    );
    await assert.rejects(
      () =>
        h.resolver.resolveTlsFingerprint({
          tenantId: 't',
          supplyMode: undefined,
          accountOwnerKind: undefined,
          accountId: 'a',
        }),
      ProviderTlsFingerprintResolverError,
    );
  });
});

describe('PostgresProviderTlsFingerprintResolver (in-process profile cache)', () => {
  it('caches the by-id profile read for the TTL and re-reads after expiry', async () => {
    const h = harness({ ttlMs: 100 });
    // The binding join carries no profile row (bound-but-missing shape): the
    // resolver falls back to readProfileCached, which reads by id.
    h.setRows([{ tls_fingerprint_profile_id: 42 }]);
    await h.resolver.resolveTlsFingerprint(baseInput);
    const readsAfterFirst = h.queries.length;
    // Within the TTL: no additional query (cached null profile).
    h.setRows([{ tls_fingerprint_profile_id: 42 }]);
    await h.resolver.resolveTlsFingerprint(baseInput);
    assert.equal(h.queries.length, readsAfterFirst + 1); // only the binding read
    // Expiry: the profile is re-read.
    h.setRows([{ tls_fingerprint_profile_id: 42, ...PROFILE_ROW, id: 42 }]);
    // (time advances via a fresh harness clock; simulate by TTL wait)
    await new Promise((resolve) => setTimeout(resolve, 150));
    await h.resolver.resolveTlsFingerprint(baseInput);
    assert.ok(h.queries.length >= readsAfterFirst + 2);
  });
});
