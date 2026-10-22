import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { PostgresProviderQuotaSnapshotStore } from '../../../src/saas/supply/provider-account-quota-snapshot-store-postgres.js';

test('Claude rate-limit anchors bind reset and observation timestamps in both owner scopes', async () => {
  const observedAtMs = Date.parse('2026-10-21T12:00:00Z');
  const resetAtMs = observedAtMs + 3_600_000;
  for (const ownerKind of ['tenant', 'platform'] as const) {
    const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
    const database = {
      query: async (sql: string, values: readonly unknown[]) => {
        statements.push({ sql, values });
        return { rows: [], rowCount: 1 };
      },
    } as unknown as SaasDatabase;
    await new PostgresProviderQuotaSnapshotStore(database).writeClaudeRateLimit(
      {
        ownerKind,
        tenantId: ownerKind === 'tenant' ? 'tenant-a' : null,
        accountId: 'account-a',
      },
      {
        window: '5h',
        resetAtMs,
        fiveHourResetAtMs: resetAtMs,
        sessionWindowStartMs: resetAtMs - 5 * 3_600_000,
        sessionWindowEndMs: resetAtMs,
      },
      observedAtMs,
    );
    const statement = statements[0];
    assert.ok(statement);
    const start = ownerKind === 'tenant' ? 3 : 2;
    assert.match(statement.sql, new RegExp(`THEN \\$${start}::timestamptz - interval '5 hours'`));
    assert.match(statement.sql, new RegExp(`claude_usage_updated_at = \\$${start + 1}::timestamptz`));
    assert.equal(statement.values[start - 1], new Date(resetAtMs).toISOString());
    assert.equal(statement.values[start], new Date(observedAtMs).toISOString());
    const indexes = [...statement.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    assert.equal(Math.max(...indexes), statement.values.length, 'all SQL parameters must be bound');
  }
});
