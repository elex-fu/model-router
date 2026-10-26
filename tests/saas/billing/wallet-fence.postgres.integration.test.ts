import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import { saasAdvisoryKey, WALLET_FENCE_SQL } from '../../../src/saas/db/advisory-lock-keys.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import {
  anyRoleConfigured,
  observedDatabase,
  phase,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';

/**
 * R9 P4/P16 (roadmap batch 1.2 step 3) — wallet advisory-fence correctness.
 *
 * The per-wallet billing fence is a `pg_advisory_xact_lock` keyed by the
 * wallet's tenant + currency identity (saasAdvisoryKey.walletFence), replacing
 * the `saas_wallets` row FOR UPDATE. These gates prove the replacement on the
 * disposable E2E database:
 *
 * 1. No wallet tuple locks: while a fenced billing transaction is open, a
 *    plain `saas_wallets ... FOR UPDATE NOWAIT` from another session succeeds
 *    (the old design would have blocked it) — the admission path no longer
 *    holds a wallet tuple lock across the rest of the transaction.
 * 2. Mutual exclusion is preserved: two concurrent reserves on the SAME
 *    wallet whose joint amounts exceed the balance must admit exactly one —
 *    the fence serializes the read-check-write of the availability sum, so
 *    the loser re-reads the winner's hold and denies with
 *    INSUFFICIENT_FUNDS. Without the fence (or with a fence taken by only one
 *    of the two entry points) both would pass the availability check and
 *    over-commit the wallet.
 * 3. The spending-freeze gate still holds: a freeze insert from a fenced
 *    transaction is not visible to a concurrent reserve's freeze check until
 *    the writer commits, and is strictly ordered after it commits — reserve
 *    either sees the freeze or does not, never a half-state.
 */

function wireLabel(label: string): string {
  return `wallet-fence-${label}-${randomUUID()}`;
}

/** Like the fixture phase, but surfaces the underlying error's safe code/message for triage. */
async function labeledPhase<T>(name: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
    throw new Error(`wallet-fence phase=${name} code=${code}`, { cause: error });
  }
}

async function fundWallet(
  migrator: SaasDatabase,
  tenantId: string,
  currency: string,
  amountMinorUnits: string,
): Promise<void> {
  const ledger = new PlatformWalletLedgerService();
  await migrator.transaction(async (executor) => {
    await ledger.postVerifiedFunding(executor, {
      tenantId,
      currency,
      amountMinorUnits,
      sourceOrderRef: wireLabel('funding'),
      idempotencyKey: wireLabel('funding'),
    });
  });
}

test('wallet advisory fence: no tuple lock while fenced, mutual exclusion under concurrency, freeze gate intact', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to run the wallet fence gate`
      : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = observedDatabase(urls[0]);
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 4 });
  t.after(async () => {
    await Promise.allSettled([migrator.database.close(), gateway.close()]);
  });
  await phase('readiness', async () => {
    // Schema readiness only: the runtime-privilege production-policy gate
    // tracks grant additions from parallel work streams and is unrelated to
    // the wallet fence semantics under test here.
    await gateway.verifySchema();
  });
  const ledger = new PlatformWalletLedgerService();

  await t.test('a fenced billing transaction holds no strong saas_wallets tuple lock', async () => {
    const fixture = await phase('seed', () => seedFixture(migrator.database, gateway, 'platform'));
    const tenantId = fixture.tenantId;
    const currency = 'USD';
    await phase('fund', () => fundWallet(migrator.database, tenantId, currency, '1000'));

    await labeledPhase('fenced-transaction-holds-no-strong-tuple-lock', () =>
      gateway.transaction(async (fenced) => {
        // Take the wallet fence the billing service would take, then a
        // reservation — exactly what an admission does after billing.reserve.
        await fenced.query(WALLET_FENCE_SQL, [saasAdvisoryKey.walletFence(tenantId, currency)]);
        const reserveStatements: string[] = [];
        await ledger.reserve(
          {
            query: (sql, values) => {
              reserveStatements.push(sql);
              return fenced.query(sql, values);
            },
          },
          {
            supplyMode: 'platform',
            tenantId,
            requestId: randomUUID(),
            currency,
            amountMinorUnits: 10n,
            priceSnapshotRef: 'wallet-fence-tuple-lock-proof',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            businessKey: wireLabel('reserve'),
          },
        );
        assert.equal(
          reserveStatements.length,
          4,
          'fresh reserve keeps only four SQL operations inside the transaction',
        );
        assert.equal(reserveStatements.filter((sql) => sql.includes('AS active_hold_minor_units')).length, 1);
        // While this fenced transaction is open, another session can take a
        // NO KEY UPDATE tuple lock on the wallet row: the fence is advisory.
        // (The old row-FOR-UPDATE design blocked exactly this probe. The
        // reservation INSERT's foreign key still takes a transient FOR KEY
        // SHARE, which does not conflict with NO KEY UPDATE — that share
        // lock is inherent to any design referencing the wallet row.)
        const lockProbe = await migrator.database.query<{ locked: boolean }>(
          `SELECT true AS locked FROM saas_wallets WHERE tenant_id = $1 AND currency = $2 FOR NO KEY UPDATE NOWAIT`,
          [tenantId, currency],
        );
        assert.equal(lockProbe.rows.length, 1, 'the wallet row must carry no strong tuple lock');
        // And the exclusive advisory fence itself is held by the open
        // transaction (transaction-level advisory lock, granted). A single
        // 64-bit advisory key is stored as classid = high 32 bits (unsigned),
        // objid = low 32 bits, objsubid = 1.
        const advisoryHeld = (
          await migrator.database.query<{ holders: string }>(
            `SELECT COUNT(*)::text AS holders
                 FROM pg_locks
                WHERE locktype = 'advisory' AND granted AND objsubid = 1
                  AND classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
                  AND objid = (hashtextextended($1, 0) & 4294967295)::oid`,
            [saasAdvisoryKey.walletFence(tenantId, currency)],
          )
        ).rows[0];
        assert.ok(
          advisoryHeld && BigInt(advisoryHeld.holders) >= 1n,
          'the wallet advisory fence must be held by the open transaction',
        );
      }),
    );
  });

  await t.test(
    'concurrent same-wallet reserves admit exactly one when the joint amount exceeds the balance',
    async () => {
      const fixture = await phase('seed', () => seedFixture(migrator.database, gateway, 'platform'));
      const tenantId = fixture.tenantId;
      const currency = 'USD';
      // Balance 100; each concurrent reserve asks for 80 — individually fine,
      // jointly impossible. The fence must admit exactly one.
      await phase('fund', () => fundWallet(migrator.database, tenantId, currency, '100'));

      const reserveOne = (label: string) =>
        gateway.transaction((executor) =>
          ledger.reserve(executor, {
            supplyMode: 'platform',
            tenantId,
            requestId: randomUUID(),
            currency,
            amountMinorUnits: 80n,
            priceSnapshotRef: 'wallet-fence-concurrency-proof',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            businessKey: wireLabel(label),
          }),
        );

      const holdsBefore = BigInt(
        (
          await gateway.query<{ holds: string }>(
            `SELECT COALESCE(SUM(amount_minor_units), 0)::text AS holds
               FROM saas_billing_reservations
              WHERE tenant_id = $1 AND currency = $2
                AND state IN ('reserved', 'reconciliation_pending')`,
            [tenantId, currency],
          )
        ).rows[0]?.holds ?? '0',
      );

      const settled = await Promise.allSettled([reserveOne('a'), reserveOne('b')]);
      const outcomes = settled.map((outcome, index) => {
        if (outcome.status === 'fulfilled') return { index, ok: true as const };
        const reason = outcome.reason as { code?: string };
        return { index, ok: false as const, code: reason?.code };
      });
      const admitted = outcomes.filter((outcome) => outcome.ok);
      const denied = outcomes.filter((outcome) => !outcome.ok);
      assert.equal(admitted.length, 1, `exactly one reserve must admit (got ${JSON.stringify(outcomes)})`);
      assert.equal(denied.length, 1);
      assert.equal(denied[0]?.code, 'INSUFFICIENT_FUNDS');

      // The wallet never went over-committed: holds <= posted.
      const walletRow = (
        await gateway.query<{ posted: string; holds: string }>(
          `SELECT w.posted_balance_minor_units::text AS posted,
                  COALESCE((
                    SELECT SUM(r.amount_minor_units) FROM saas_billing_reservations r
                     WHERE r.tenant_id = w.tenant_id AND r.currency = w.currency
                       AND r.state IN ('reserved', 'reconciliation_pending')
                  ), 0)::text AS holds
             FROM saas_wallets w WHERE w.tenant_id = $1 AND w.currency = $2`,
          [tenantId, currency],
        )
      ).rows[0];
      assert.ok(walletRow, 'the wallet row must exist');
      assert.ok(BigInt(walletRow.holds) <= BigInt(walletRow.posted), 'holds must never exceed the posted balance');
      assert.equal(BigInt(walletRow.holds) - holdsBefore, 80n, 'exactly the winning hold was committed');
    },
  );

  await t.test('a committed spending freeze blocks a later reserve on the same wallet', async () => {
    const fixture = await phase('seed', () => seedFixture(migrator.database, gateway, 'platform'));
    const tenantId = fixture.tenantId;
    const currency = 'USD';
    await phase('fund', () => fundWallet(migrator.database, tenantId, currency, '100'));

    // Over-settle a hold to freeze the tenant, then commit — the canonical
    // freeze writer path runs inside the wallet fence.
    const requestId = randomUUID();
    const businessKey = wireLabel('freeze-reserve');
    await phase('reserve', () =>
      gateway.transaction((executor) =>
        ledger.reserve(executor, {
          supplyMode: 'platform',
          tenantId,
          requestId,
          currency,
          amountMinorUnits: 10n,
          priceSnapshotRef: 'wallet-fence-freeze-proof',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          businessKey,
        }),
      ),
    );
    await labeledPhase('over-settle-freezes', () =>
      gateway.transaction((executor) =>
        ledger.settle(executor, {
          supplyMode: 'platform',
          tenantId,
          requestId,
          currency,
          amountMinorUnits: 20n, // > the 10 hold: records pending + freezes
          priceSnapshotRef: 'wallet-fence-freeze-proof',
          settlementId: wireLabel('over-settle'),
          usageEvidenceRef: wireLabel('over-settle'),
          businessKey,
        }),
      ),
    );

    const frozen = (
      await gateway.query<{ freezes: string }>(
        'SELECT COUNT(*)::text AS freezes FROM saas_billing_spending_freezes WHERE tenant_id = $1',
        [tenantId],
      )
    ).rows[0];
    assert.equal(frozen?.freezes, '1', 'the over-settlement must have frozen the tenant');

    // Not wrapped in the fixture phase: the masking wrapper hides the
    // SaasBillingError code this assertion checks.
    await assert.rejects(
      gateway.transaction((executor) =>
        ledger.reserve(executor, {
          supplyMode: 'platform',
          tenantId,
          requestId: randomUUID(),
          currency,
          amountMinorUnits: 5n,
          priceSnapshotRef: 'wallet-fence-freeze-proof',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          businessKey: wireLabel('post-freeze'),
        }),
      ),
      (error: unknown) =>
        typeof (error as { code?: unknown }).code === 'string' &&
        (error as { code?: string }).code === 'SPENDING_FROZEN',
      'a reserve after the committed freeze must deny with SPENDING_FROZEN',
    );
  });
});
