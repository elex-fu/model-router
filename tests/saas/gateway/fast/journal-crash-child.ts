// Test-only real process death boundary. No runtime fault hooks or provider calls.
import { randomUUID } from 'node:crypto';
import { createSaasDatabase } from '../../../../src/saas/db/index.js';
import type { SaasDatabase, SqlResult } from '../../../../src/saas/db/types.js';
import {
  type FastReceiptInput,
  type FastReserveIntentInput,
  PostgresFastGatewayJournal,
} from '../../../../src/saas/gateway/fast/journal.js';
import { roleUrls } from '../../metering/normal-success-postgres-fixture.js';

const permitted = new Set([
  'fast-journal:worker-claim',
  'fast-journal:worker-ledger',
  'fast-journal:worker-balance-check',
  'fast-journal:worker-wallet',
  'fast-journal:worker-credit-lock',
  'fast-journal:worker-credit',
  'fast-journal:worker-complete',
  'fast-journal:reserve-intent',
  'fast-journal:append-receipt',
]);
process.once(
  'message',
  async (raw: {
    boundary: string;
    intent?: FastReserveIntentInput;
    receipt?: FastReceiptInput;
    beforeReceiptCommit?: boolean;
  }) => {
    if (!permitted.has(raw.boundary)) throw new Error('test boundary not allowed');
    const database = createSaasDatabase({ connectionString: roleUrls()[2], max: 2 });
    async function pause(): Promise<never> {
      process.send?.({ kind: 'paused', boundary: raw.boundary });
      return new Promise<never>(() => {});
    }
    const wrapped: SaasDatabase = {
      ...database,
      query: async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
        if (raw.beforeReceiptCommit && sql.includes('fast-journal:append-receipt */')) {
          return database.transaction(async (tx) => {
            const result = await tx.query<Row>(sql, values);
            await pause();
            return result;
          });
        }
        const result = await database.query<Row>(sql, values);
        if (sql.includes(`${raw.boundary} */`)) await pause();
        return result;
      },
      transaction: (work) =>
        database.transaction((tx) =>
          work({
            query: async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
              const result = await tx.query<Row>(sql, values);
              if (sql.includes(`${raw.boundary} */`)) await pause();
              return result;
            },
          }),
        ),
    };
    const journal = new PostgresFastGatewayJournal(wrapped, {
      allocationOwner: raw.intent?.allocationOwner ?? randomUUID(),
      allocationTrancheMinorUnits: '100',
    });
    if (raw.intent) {
      await journal.replenish(raw.intent.tenantId, 'USD', raw.intent.maxCostMinorUnits);
      await journal.reserveIntent(raw.intent);
    } else if (raw.receipt) await journal.appendReceipt(raw.receipt);
    else await journal.runOnce();
    throw new Error('test failed to reach requested crash boundary');
  },
);
process.send?.({ kind: 'ready' });
