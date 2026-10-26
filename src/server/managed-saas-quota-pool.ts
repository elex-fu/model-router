/** Keep quota writeback off connections held by admission locks without
 * increasing the operator's per-process PostgreSQL connection budget.
 * A one-connection deployment cannot be isolated and keeps the shared path.
 * Injected/custom pools opt out because their capacity and ownership are unknown.
 */
export function managedQuotaPoolBudget(
  total: number,
  isolate: boolean,
): {
  readonly business: number;
  readonly quota: number;
} {
  if (!Number.isSafeInteger(total) || total < 1) throw new TypeError('Invalid managed PostgreSQL pool budget');
  const quota = !isolate || total === 1 ? 0 : total < 4 ? 1 : 2;
  return { business: total - quota, quota };
}
