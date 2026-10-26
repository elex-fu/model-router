import assert from 'node:assert/strict';
import { test } from 'node:test';
import { managedQuotaPoolBudget } from '../../src/server/managed-saas-quota-pool.js';

test('quota isolation reserves a bounded lane without increasing configured connections', () => {
  assert.deepEqual(managedQuotaPoolBudget(16, true), { business: 14, quota: 2 });
  assert.deepEqual(managedQuotaPoolBudget(1, true), { business: 1, quota: 0 });
  assert.deepEqual(managedQuotaPoolBudget(2, true), { business: 1, quota: 1 });
  assert.deepEqual(managedQuotaPoolBudget(3, true), { business: 2, quota: 1 });
  for (const total of [1, 2, 3, 4, 16, 32, 100]) {
    const budget = managedQuotaPoolBudget(total, true);
    assert.equal(budget.business + budget.quota, total);
    assert.ok(budget.business >= 1 && budget.quota <= 2);
    assert.deepEqual(managedQuotaPoolBudget(total, false), { business: total, quota: 0 });
  }
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => managedQuotaPoolBudget(invalid, true));
  }
});
