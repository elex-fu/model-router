import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool as PgPool, type PoolClient } from 'pg';
import {
  correctBillingGroupSpend,
  releaseBillingGroupSpend,
  reserveBillingGroupSpend,
  selectFrozenGroupSpendTerms,
  settleBillingGroupSpend,
} from '../../../src/saas/billing/groups/spend-store.js';
import {
  BillingGroupSpendAdmissionDeniedError,
  createPostgresBillingGroupSpendAdmission,
} from '../../../src/saas/gateway/postgres-billing-group-spend.js';
import {
  selectKeyBudgetRollingChargeWindows,
  settleKeyBudgetReservation,
} from '../../../src/saas/keys/budget-store.js';

/**
 * R1 billing-group limit enforcement, phase 3 (migration 114): the group
 * spend reserve/settle/release/correct lifecycle and the API key rolling
 * 5h/7d window sums, exercised against the real disposable PostgreSQL
 * database (isolated schema, dropped on exit). The minimal tables mirror the
 * migration DDL for exactly the columns the stores touch.
 */
function isolatedTarget(value: string | undefined): { connectionString?: string; skipReason?: string } {
  if (!value || value.trim() === '') return { skipReason: 'set SAAS_GROUP_SPEND_TEST_DATABASE_URL' };
  try {
    const parsed = new URL(value);
    const databaseName = decodeURIComponent(parsed.pathname.slice(1));
    const port = Number(parsed.port);
    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      !parsed.port ||
      !Number.isInteger(port) ||
      port === 5432 ||
      port < 1 ||
      port > 65_535 ||
      !/^model_router_test_[a-zA-Z0-9_]+$/.test(databaseName) ||
      parsed.hash ||
      [...parsed.searchParams.keys()].some((key) => ['host', 'port'].includes(key.toLowerCase()))
    ) {
      return {
        skipReason:
          'group spend integration requires a dedicated model_router_test_* database and explicit non-5432 port',
      };
    }
    return { connectionString: value };
  } catch {
    return { skipReason: 'SAAS_GROUP_SPEND_TEST_DATABASE_URL is not a valid PostgreSQL URL' };
  }
}

async function seedSchema(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE saas_request_customer_price_snapshots (
      tenant_id uuid NOT NULL,
      request_id uuid NOT NULL,
      billing_group_id text,
      group_daily_limit_minor_units bigint,
      group_weekly_limit_minor_units bigint,
      group_monthly_limit_minor_units bigint,
      UNIQUE (tenant_id, request_id)
    );
    CREATE TABLE saas_billing_group_spend_counters (
      billing_group_id text NOT NULL,
      window_kind text NOT NULL CHECK (window_kind IN ('daily', 'weekly', 'monthly')),
      window_start date NOT NULL,
      charge_outstanding_reserved bigint NOT NULL DEFAULT 0 CHECK (charge_outstanding_reserved >= 0),
      charge_settled bigint NOT NULL DEFAULT 0 CHECK (charge_settled >= 0),
      charge_currency text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (billing_group_id, window_kind, window_start)
    );
    CREATE TABLE saas_billing_group_spend_reservations (
      tenant_id uuid NOT NULL,
      request_id uuid NOT NULL,
      billing_group_id text NOT NULL,
      window_kind text NOT NULL CHECK (window_kind IN ('daily', 'weekly', 'monthly')),
      window_start date NOT NULL,
      amount_minor_units bigint NOT NULL CHECK (amount_minor_units >= 0),
      charge_currency text NOT NULL CHECK (charge_currency ~ '^[A-Z]{3}$'),
      settled_amount_minor_units bigint CHECK (settled_amount_minor_units IS NULL OR settled_amount_minor_units >= 0),
      state text NOT NULL DEFAULT 'outstanding' CHECK (state IN ('outstanding', 'settled', 'released')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, request_id, window_kind),
      CHECK (
        (state = 'outstanding' AND settled_amount_minor_units IS NULL)
        OR (state IN ('settled', 'released') AND settled_amount_minor_units IS NOT NULL)
      )
    );
    CREATE TABLE saas_api_key_budget_reservations (
      tenant_id uuid NOT NULL,
      project_id uuid NOT NULL,
      lineage_id uuid NOT NULL,
      request_id uuid NOT NULL,
      day date NOT NULL,
      token_units bigint NOT NULL,
      charge_minor_units bigint NOT NULL,
      charge_currency text,
      settled_charge_minor_units bigint,
      state text NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, request_id)
    );
    CREATE TABLE saas_api_key_budget_counters (
      tenant_id uuid NOT NULL,
      project_id uuid NOT NULL,
      lineage_id uuid NOT NULL,
      window_kind text NOT NULL,
      day date NOT NULL,
      token_settled bigint NOT NULL DEFAULT 0,
      token_outstanding_reserved bigint NOT NULL DEFAULT 0,
      charge_settled bigint NOT NULL DEFAULT 0,
      charge_outstanding_reserved bigint NOT NULL DEFAULT 0,
      charge_currency text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, lineage_id, window_kind, day)
    );
  `);
}

const NOW = new Date('2026-10-17T12:00:00.000Z');

test('group spend lifecycle enforces, settles, releases, and corrects exactly', {
  skip: isolatedTarget(process.env.SAAS_GROUP_SPEND_TEST_DATABASE_URL).skipReason,
}, async () => {
  const target = isolatedTarget(process.env.SAAS_GROUP_SPEND_TEST_DATABASE_URL);
  assert.ok(target.connectionString);
  const pool = new PgPool({ connectionString: target.connectionString, max: 2 });
  const schema = `group_spend_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const tenantId = randomUUID();
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      await seedSchema(client);
      await client.query('BEGIN');
      const requestA = randomUUID();
      const requestB = randomUUID();
      const requestC = randomUUID();
      await client.query(
        `INSERT INTO saas_request_customer_price_snapshots
           (tenant_id, request_id, billing_group_id, group_daily_limit_minor_units, group_weekly_limit_minor_units)
         VALUES ($1, $2, 'vip', 1000, 5000), ($1, $3, 'vip', 1000, 5000), ($1, $4, 'vip', 1000, 5000)`,
        [tenantId, requestA, requestB, requestC],
      );

      // The frozen terms come from the snapshot, not the group table.
      const terms = await selectFrozenGroupSpendTerms(client, tenantId, requestA);
      assert.deepEqual(terms, {
        billingGroupId: 'vip',
        dailyLimitMinorUnits: '1000',
        weeklyLimitMinorUnits: '5000',
        monthlyLimitMinorUnits: null,
      });

      const windows = [
        { kind: 'daily' as const, windowStart: '', limitMinorUnits: '1000' },
        { kind: 'weekly' as const, windowStart: '', limitMinorUnits: '5000' },
      ];
      const chargeOf = (amount: string) => ({ chargeMinorUnits: amount, chargeCurrency: 'USD' });

      // First reservation: 600 inside the 1000 daily ceiling.
      const first = await reserveBillingGroupSpend(
        client,
        { tenantId, requestId: requestA, billingGroupId: 'vip', windows, ...chargeOf('600') },
        NOW,
      );
      assert.equal(first.length, 2);
      assert.equal(first[0]?.settled, '0');
      assert.equal(first[0]?.outstandingReserved, '600');

      // Second admission: projected 1200 > 1000 denies on the daily window.
      // The denial rides the admission port (the store only reserves; the
      // projection check is the port's), and its rollback removes the
      // reservation — verified here inside the same transaction.
      const admission = createPostgresBillingGroupSpendAdmission({ now: () => NOW });
      // A SAVEPOINT models the production boundary: the denied admission's
      // writes roll back with the surrounding transaction.
      await client.query('SAVEPOINT denied_admission');
      await assert.rejects(
        admission.reserve(client, {
          tenantId,
          requestId: requestB,
          supplyMode: 'platform',
          charge: { currency: 'USD', amountMinorUnits: '600' },
        }),
        (error: unknown) => error instanceof BillingGroupSpendAdmissionDeniedError && error.deniedWindow === 'daily',
      );
      await client.query('ROLLBACK TO SAVEPOINT denied_admission');
      const deniedRows = await client.query(
        `SELECT 1 FROM saas_billing_group_spend_reservations WHERE request_id = $1`,
        [requestB],
      );
      assert.equal(deniedRows.rowCount, 0);

      // Settle the first reservation with the ACTUAL 500: outstanding drops
      // to 100, settled rises to 500, on both windows.
      assert.equal(await settleBillingGroupSpend(client, tenantId, requestA, '500', 'USD'), true);
      const daily = async () =>
        (
          await client.query<{ charge_outstanding_reserved: string; charge_settled: string }>(
            `SELECT charge_outstanding_reserved::text, charge_settled::text
               FROM saas_billing_group_spend_counters
              WHERE billing_group_id = 'vip' AND window_kind = 'daily'`,
          )
        ).rows[0];
      let counter = await daily();
      // Settle moves the FULL reserved amount out of outstanding and the
      // ACTUAL amount into settled (the KEY-BUD semantics).
      assert.equal(counter?.charge_outstanding_reserved, '0');
      assert.equal(counter?.charge_settled, '500');
      // Settle is idempotent.
      assert.equal(await settleBillingGroupSpend(client, tenantId, requestA, '500', 'USD'), false);

      // A 400 reservation lands exactly at the inclusive 1000 ceiling.
      await admission.reserve(client, {
        tenantId,
        requestId: requestC,
        supplyMode: 'platform',
        charge: { currency: 'USD', amountMinorUnits: '400' },
      });
      counter = await daily();
      assert.equal(counter?.charge_outstanding_reserved, '400');
      assert.equal(counter?.charge_settled, '500');

      // Release drops the outstanding side without recording settled usage.
      assert.equal(await releaseBillingGroupSpend(client, tenantId, requestC), true);
      counter = await daily();
      assert.equal(counter?.charge_outstanding_reserved, '0');
      assert.equal(counter?.charge_settled, '500');

      // A correction moves only the settled side of the ORIGINAL windows.
      assert.equal(await correctBillingGroupSpend(client, tenantId, requestA, '50'), true);
      counter = await daily();
      assert.equal(counter?.charge_outstanding_reserved, '0');
      assert.equal(counter?.charge_settled, '550');
      const weekly = (
        await client.query<{ charge_settled: string }>(
          `SELECT charge_settled::text FROM saas_billing_group_spend_counters
            WHERE billing_group_id = 'vip' AND window_kind = 'weekly'`,
        )
      ).rows[0];
      assert.equal(weekly?.charge_settled, '550');

      await client.query('COMMIT');
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // already resolved
      }
      client.release();
    }
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

test('the rolling 5h/7d key windows sum actual settled and outstanding charges exactly', {
  skip: isolatedTarget(process.env.SAAS_GROUP_SPEND_TEST_DATABASE_URL).skipReason,
}, async () => {
  const target = isolatedTarget(process.env.SAAS_GROUP_SPEND_TEST_DATABASE_URL);
  assert.ok(target.connectionString);
  const pool = new PgPool({ connectionString: target.connectionString, max: 2 });
  const schema = `key_rolling_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const tenantId = randomUUID();
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      await seedSchema(client);
      await client.query('BEGIN');
      const lineageId = randomUUID();
      const projectId = randomUUID();
      const insertReservation = (
        requestId: string,
        charge: string,
        currency: string,
        state: 'outstanding' | 'settled' | 'released',
        createdAt: string,
        settledCharge: string | null = null,
      ) =>
        client.query(
          `INSERT INTO saas_api_key_budget_reservations
             (tenant_id, project_id, lineage_id, request_id, day, token_units,
              charge_minor_units, charge_currency, settled_charge_minor_units, state, created_at)
           VALUES ($1, $2, $3, $4, DATE '2026-10-17', 0, $5, $6, $7, $8, $9)`,
          [tenantId, projectId, lineageId, requestId, charge, currency, settledCharge, state, createdAt],
        );
      // settled 1h ago: reserved 300, ACTUAL 250 → contributes 250.
      await insertReservation(randomUUID(), '300', 'USD', 'settled', '2026-10-17T11:00:00.000Z', '250');
      // outstanding 3h ago: contributes its reserved 100.
      const outstandingRequest = randomUUID();
      await insertReservation(outstandingRequest, '100', 'USD', 'outstanding', '2026-10-17T09:00:00.000Z');
      // released 1h ago: never counts.
      await insertReservation(randomUUID(), '999', 'USD', 'released', '2026-10-17T11:00:00.000Z', '0');
      // settled 6h ago: outside the 5h window, inside the 7d window.
      await insertReservation(randomUUID(), '500', 'USD', 'settled', '2026-10-17T06:00:00.000Z', '500');
      // settled 8 days ago: outside both windows.
      await insertReservation(randomUUID(), '777', 'USD', 'settled', '2026-10-09T12:00:00.000Z', '777');
      // a different currency never counts against the USD windows.
      await insertReservation(randomUUID(), '555', 'EUR', 'settled', '2026-10-17T11:00:00.000Z', '555');

      const rolling = await selectKeyBudgetRollingChargeWindows(client, {
        tenantId,
        lineageId,
        chargeCurrency: 'USD',
        now: NOW,
      });
      assert.equal(rolling.fiveHour, '350', 'actual settled 250 + outstanding 100');
      assert.equal(rolling.sevenDay, '850', '350 + the 6h-old settled 500');

      // Settling the outstanding reservation records its ACTUAL 120 and the
      // rolling 5h window immediately reflects it.
      await client.query(
        `INSERT INTO saas_api_key_budget_counters
           (tenant_id, project_id, lineage_id, window_kind, day,
            token_outstanding_reserved, charge_outstanding_reserved, charge_currency)
         VALUES ($1, $2, $3, 'daily', DATE '2026-10-17', 0, 100, 'USD')`,
        [tenantId, projectId, lineageId],
      );
      await client.query(
        `INSERT INTO saas_api_key_budget_counters
           (tenant_id, project_id, lineage_id, window_kind, day,
            charge_outstanding_reserved, charge_currency)
         VALUES ($1, $2, $3, 'lifetime', DATE '0001-01-01', 100, 'USD')`,
        [tenantId, projectId, lineageId],
      );
      assert.equal(await settleKeyBudgetReservation(client, tenantId, outstandingRequest, '0', '120'), true);
      const afterSettle = await selectKeyBudgetRollingChargeWindows(client, {
        tenantId,
        lineageId,
        chargeCurrency: 'USD',
        now: NOW,
      });
      assert.equal(afterSettle.fiveHour, '370', 'actual settled 250 + newly settled 120');
      assert.equal(afterSettle.sevenDay, '870');

      await client.query('COMMIT');
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // already resolved
      }
      client.release();
    }
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});
