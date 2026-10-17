import { SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL } from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';

/** Shape is deliberately NOT authority: only IdentityService's private WeakMap
 * can establish origin. No raw cookie, session identity or digest is exposed. */
export interface CustomerKeyMutationSessionHandle {
  readonly purpose: 'customer-key-mutation-session-v1';
}
export class CustomerKeyMutationSessionError extends Error {
  constructor(readonly status: 401 | 403 | 503) {
    super(status === 503 ? 'Customer key authentication is unavailable' : 'Customer key authentication was rejected');
    this.name = 'CustomerKeyMutationSessionError';
  }
}
const ownedWrites = new WeakMap<SqlExecutor, SaasDatabase>();
/** Executes the SAME original KeyService four-statement write entry, then brands
 * only this actual DB-owned callback executor. No caller executor/lock Boolean. */
export async function runCustomerKeyMutationWrite<T>(
  database: SaasDatabase,
  work: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    if (ownedWrites.has(tx)) throw new CustomerKeyMutationSessionError(503);
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await tx.query("SET LOCAL lock_timeout = '2s'");
    await tx.query("SET LOCAL statement_timeout = '10s'");
    await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
    ownedWrites.set(tx, database);
    try {
      return await work(tx);
    } finally {
      ownedWrites.delete(tx);
    }
  });
}
export function assertCustomerKeyMutationWrite(database: SaasDatabase, tx: SqlExecutor): void {
  if (ownedWrites.get(tx) !== database) throw new CustomerKeyMutationSessionError(503);
}
// Fixed real native predicates. LIMIT2 permits duplicate/malformed result refusal.
// No row lock: all inspected customer-session service writers acquire G FIRST.
// This is not a claim that migration046 guards the customer table or arbitrary SQL.
export const CUSTOMER_KEY_MUTATION_ISSUE_SQL = `/* customer-key-session:issue */
 SELECT s.id,s.user_id,s.token_hash,s.csrf_token_hash
 FROM saas_sessions s JOIN saas_users u ON u.id=s.user_id
 WHERE s.token_hash=$1 AND s.csrf_token_hash=$2
   AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
   AND u.disabled_at IS NULL
 LIMIT 2`;
export const CUSTOMER_KEY_MUTATION_CURRENT_SQL = `/* customer-key-session:current */
 SELECT s.id,s.user_id,s.token_hash,s.csrf_token_hash
 FROM saas_sessions s JOIN saas_users u ON u.id=s.user_id
 WHERE s.id=$1::uuid AND s.user_id=$2::uuid
   AND s.token_hash=$3 AND s.csrf_token_hash=$4
   AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
   AND u.disabled_at IS NULL
 LIMIT 2`;
export interface CustomerKeyMutationSessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly token_hash: string;
  readonly csrf_token_hash: string;
}
export function readCustomerKeyMutationSessionRow(
  value: unknown,
  tokenHash: string,
  csrfHash: string,
): CustomerKeyMutationSessionRow {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== 4)
    throw new CustomerKeyMutationSessionError(503);
  const field = (name: string): unknown => {
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (!d || !('value' in d)) throw new CustomerKeyMutationSessionError(503);
    return d.value;
  };
  const id = field('id'),
    userId = field('user_id');
  const token = field('token_hash'),
    csrf = field('csrf_token_hash');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    typeof id !== 'string' ||
    !uuid.test(id) ||
    typeof userId !== 'string' ||
    !uuid.test(userId) ||
    typeof token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(token) ||
    token !== tokenHash ||
    typeof csrf !== 'string' ||
    !/^[a-f0-9]{64}$/.test(csrf) ||
    csrf !== csrfHash
  ) {
    throw new CustomerKeyMutationSessionError(503);
  }
  return { id, user_id: userId, token_hash: token, csrf_token_hash: csrf };
}
