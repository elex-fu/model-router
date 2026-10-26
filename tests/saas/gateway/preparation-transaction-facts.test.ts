import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import { observePreparationExecutor } from '../../../src/saas/gateway/postgres-preparation-observer.js';
import {
  readPreparationTransactionRecords,
  takePreparationTransactionFacts,
} from '../../../src/saas/gateway/postgres-request-admission-guard.js';
import * as statements from '../../../src/saas/gateway/preparation-fact-preserving-statements.js';
import * as scopeApi from '../../../src/saas/gateway/preparation-transaction-facts.js';

function mustContext(tx: SqlExecutor) {
  const context = scopeApi.preparationTransactionContext(tx);
  assert.ok(context);
  return context;
}

const identity = { tenantId: 't', requestId: 'r', attemptId: 'a', payloadSha256: 'f'.repeat(64) };
const safeSql = '/* postgres-request-admission:clock */ SELECT clock_timestamp() AS locked_at';
const executor: SqlExecutor = {
  async query() {
    return { rows: [], rowCount: 0 };
  },
};

test('only concrete successful guard can mint facts; exported APIs cannot forge a context or alias', async () => {
  assert.equal('rememberPreparationTransactionFacts' in scopeApi, false);
  assert.equal('inheritPreparationTransactionFacts' in scopeApi, false);
  assert.equal('PREPARATION_FACT_PRESERVING_STATEMENTS' in statements, false);
  await scopeApi.withPreparationTransactionFacts(executor, identity, async (tx) => {
    scopeApi.bindPreparationTransactionEvidence(tx, 'signed');
    assert.equal(takePreparationTransactionFacts(tx, identity, 'signed', []), undefined);
    assert.equal(await readPreparationTransactionRecords(tx, 't', 'r', 'a'), undefined);
    assert.equal(scopeApi.preparationTransactionContext({ ...tx }), undefined);
    assert.equal(scopeApi.preparationTransactionContext(executor), undefined);
    const context = mustContext(tx);
    assert.throws(() => Object.assign(context.identity, { tenantId: 'forged' }), TypeError);
    assert.throws(() => Object.assign(context, { token: {} }), TypeError);
  });
});

test('scope binds actual observed executor and ends before callback commit/rollback, even with pooled reuse', async () => {
  let escaped: SqlExecutor | undefined;
  let token: object | undefined;
  await scopeApi.withPreparationTransactionFacts(executor, identity, async (tx) => {
    escaped = tx;
    token = mustContext(tx).token;
    const observed = observePreparationExecutor(tx, 'admission', () => {});
    assert.throws(() => Object.assign(tx, { query: executor.query }), TypeError);
    assert.throws(() => Object.assign(observed, { query: executor.query }), TypeError);
    assert.equal(mustContext(observed).token, token);
    assert.equal(scopeApi.preparationTransactionContext({ ...observed }), undefined);
    await observed.query(safeSql);
    assert.equal(mustContext(observed).token, token);
  });
  assert.ok(escaped);
  assert.equal(scopeApi.preparationTransactionContext(escaped), undefined);
  await assert.rejects(escaped.query(safeSql), /scope has ended/);
  await scopeApi.withPreparationTransactionFacts(executor, identity, async (tx) => {
    assert.notEqual(mustContext(tx).token, token);
  });
  await assert.rejects(
    scopeApi.withPreparationTransactionFacts(executor, identity, async (tx) => {
      escaped = tx;
      throw new Error('cancel');
    }),
    /cancel/,
  );
  assert.ok(escaped);
  assert.equal(scopeApi.preparationTransactionContext(escaped), undefined);
});

for (const sql of [
  "UPDATE saas_api_keys SET status='revoked'",
  'COMMIT',
  'ROLLBACK TO SAVEPOINT prior',
  '/* postgres-request-admission:clock */ SELECT clock_timestamp() AS locked_at; DELETE FROM saas_requests',
  'SELECT malicious_authority_mutator()',
  `${safeSql} /* unfamiliar */`,
]) {
  test(`unreviewed SQL permanently revokes same-transaction facts: ${sql}`, async () => {
    await scopeApi.withPreparationTransactionFacts(executor, identity, async (tx) => {
      assert.ok(scopeApi.preparationTransactionContext(tx));
      await tx.query(sql);
      assert.equal(scopeApi.preparationTransactionContext(tx), undefined);
      await tx.query(safeSql);
      assert.equal(scopeApi.preparationTransactionContext(tx), undefined);
    });
  });
}

test('queued unknown write cannot race issuance after a safe fact read', async () => {
  let settle: (() => void) | undefined;
  const queued: SqlExecutor = {
    async query(sql) {
      if (sql === 'UPDATE authority') await new Promise<void>((resolve) => (settle = resolve));
      return { rows: [], rowCount: 0 };
    },
  };
  await scopeApi.withPreparationTransactionFacts(queued, identity, async (tx) => {
    const mutation = tx.query('UPDATE authority');
    await tx.query(safeSql);
    assert.equal(scopeApi.preparationTransactionContext(tx), undefined, 'in-flight write forbids issuance');
    assert.ok(settle);
    settle();
    await mutation;
    // A mutation completed before any issuance can be followed by a fresh
    // guard read; it can never validate a captured earlier revision.
    const old = mustContext(tx);
    const second = tx.query('UPDATE authority');
    assert.equal(scopeApi.preparationTransactionContext(tx), undefined);
    assert.ok(settle);
    settle();
    await second;
    assert.equal(scopeApi.preparationTransactionContext(tx), undefined);
    assert.ok(old);
  });
});

test('native prepared-query forwarding uses the same immutable executor and revocation policy', async () => {
  const native: SqlExecutor = {
    ...executor,
    async queryPrepared() {
      return { rows: [], rowCount: 0 };
    },
  };
  await scopeApi.withPreparationTransactionFacts(native, identity, async (tx) => {
    const context = mustContext(tx);
    assert.ok(tx.queryPrepared);
    await tx.queryPrepared({ name: 'safe-clock', text: safeSql });
    assert.equal(mustContext(tx).token, context.token);
    assert.ok(tx.queryPrepared);
    await tx.queryPrepared({ name: 'same-name-cannot-authorize', text: 'UPDATE saas_api_keys SET status=$1' }, [
      'revoked',
    ]);
    assert.equal(scopeApi.preparationTransactionContext(tx), undefined);
  });
});

test('prepared statement accessor cannot change the executed text after the allowlist check', async () => {
  let textReads = 0;
  let executed = '';
  const native: SqlExecutor = {
    ...executor,
    async queryPrepared(statement) {
      executed = statement.text;
      return { rows: [], rowCount: 0 };
    },
  };
  await scopeApi.withPreparationTransactionFacts(native, identity, async (tx) => {
    assert.ok(tx.queryPrepared);
    mustContext(tx);
    await tx.queryPrepared({
      name: 'mutable-descriptor',
      get text() {
        return textReads++ === 0 ? safeSql : "UPDATE saas_api_keys SET status='revoked'";
      },
    });
    assert.equal(executed, safeSql);
    assert.equal(textReads, 1);
    assert.ok(scopeApi.preparationTransactionContext(tx));
  });
});
