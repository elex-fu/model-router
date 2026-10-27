import { randomUUID } from 'node:crypto';
import { parseMinorUnits } from '../../billing/money.js';
import { WALLET_FENCE_SQL } from '../../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../../db/types.js';

export interface BoundedDeploymentSpec {
  readonly deploymentId: string;
  /** Digest of the entire fixed resource policy, not a supervisor generation. */
  readonly policyDigest: string;
  /** Applied separately to each tenant/currency; currencies are never added. */
  readonly creditCapMinorUnits: string;
}
export interface BoundedOwnerKey extends BoundedDeploymentSpec {
  readonly slot: 0 | 1;
  readonly epoch: string;
}
export interface BoundedOwnerActivation extends BoundedOwnerKey {
  readonly owner: string;
}
export interface BoundedOwnerSlot {
  readonly slot: 0 | 1;
  readonly owner: string;
  readonly epoch: string;
  readonly active: boolean;
  readonly retiredEpoch: string | null;
}

export function validateBoundedDeploymentSpec(spec: BoundedDeploymentSpec): void {
  if (
    !/^[a-zA-Z0-9_:-]{1,128}$/.test(spec.deploymentId) ||
    !/^[a-f0-9]{64}$/.test(spec.policyDigest) ||
    !/^[1-9][0-9]*$/.test(spec.creditCapMinorUnits)
  )
    throw new Error('BOUNDED_DEPLOYMENT_INVALID_POLICY');
  parseMinorUnits(spec.creditCapMinorUnits);
}
export function boundedOwnerName(deploymentId: string, slot: 0 | 1): string {
  if (!/^[a-zA-Z0-9_:-]{1,128}$/.test(deploymentId) || (slot !== 0 && slot !== 1))
    throw new Error('BOUNDED_DEPLOYMENT_INVALID_SLOT');
  return `${deploymentId}:bounded-slot-${slot}`;
}
function ownerKey(input: BoundedOwnerKey): string {
  validateBoundedDeploymentSpec(input);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.epoch))
    throw new Error('BOUNDED_DEPLOYMENT_INVALID_EPOCH');
  return boundedOwnerName(input.deploymentId, input.slot);
}
function one(count: number | null): void {
  if (count !== 1) throw new Error('BOUNDED_DEPLOYMENT_STATE_CONFLICT');
}
async function requirePolicy(tx: SqlExecutor, spec: BoundedDeploymentSpec): Promise<void> {
  const policy = await tx.query<{ policy_digest: string; credit_cap_minor_units: string }>(
    'SELECT policy_digest,credit_cap_minor_units::text FROM saas_fast_gateway_deployments WHERE deployment_id=$1',
    [spec.deploymentId],
  );
  if (
    policy.rows[0]?.policy_digest !== spec.policyDigest ||
    policy.rows[0]?.credit_cap_minor_units !== spec.creditCapMinorUnits
  )
    throw new Error('BOUNDED_DEPLOYMENT_POLICY_CONFLICT');
}

/** Startup control path only. Existing unregistered owner names are never adopted. */
export async function registerBoundedDeployment(database: SaasDatabase, spec: BoundedDeploymentSpec): Promise<void> {
  spec = Object.freeze({ ...spec });
  validateBoundedDeploymentSpec(spec);
  await database.transaction(async (tx) => {
    await tx.query(WALLET_FENCE_SQL, [`model-router:bounded-deployment:${spec.deploymentId}`]);
    const inserted = await tx.query(
      `INSERT INTO saas_fast_gateway_deployments(deployment_id,policy_digest,credit_cap_minor_units)
       VALUES($1,$2,$3) ON CONFLICT(deployment_id) DO NOTHING`,
      [spec.deploymentId, spec.policyDigest, spec.creditCapMinorUnits],
    );
    await requirePolicy(tx, spec);
    if (inserted.rowCount === 0) {
      const slots = await tx.query<{ owner: string; slot: number }>(
        'SELECT owner,slot FROM saas_fast_gateway_owner_slots WHERE deployment_id=$1 ORDER BY slot',
        [spec.deploymentId],
      );
      if (
        slots.rows.length !== 2 ||
        slots.rows.some(
          (row, slot) => row.slot !== slot || row.owner !== boundedOwnerName(spec.deploymentId, slot as 0 | 1),
        )
      )
        throw new Error('BOUNDED_DEPLOYMENT_SLOT_CONFLICT');
      return;
    }
    for (const slot of [0, 1] as const) {
      const owner = boundedOwnerName(spec.deploymentId, slot);
      const epoch = randomUUID();
      const created = await tx.query(
        'INSERT INTO saas_fast_gateway_owners(owner,epoch) VALUES($1,$2) ON CONFLICT(owner) DO NOTHING',
        [owner, epoch],
      );
      if (created.rowCount !== 1) throw new Error('BOUNDED_DEPLOYMENT_LEGACY_OWNER_CONFLICT');
      one(
        (
          await tx.query(
            `INSERT INTO saas_fast_gateway_owner_slots(owner,deployment_id,slot,epoch,active,retired_epoch)
         VALUES($1,$2,$3,$4,false,NULL)`,
            [owner, spec.deploymentId, slot, epoch],
          )
        ).rowCount,
      );
    }
  });
}

export async function readBoundedOwnerSlots(
  database: SqlExecutor,
  spec: BoundedDeploymentSpec,
): Promise<readonly BoundedOwnerSlot[]> {
  spec = Object.freeze({ ...spec });
  validateBoundedDeploymentSpec(spec);
  await requirePolicy(database, spec);
  const result = await database.query<{
    owner: string;
    slot: 0 | 1;
    epoch: string;
    active: boolean;
    retired_epoch: string | null;
  }>(
    'SELECT owner,slot,epoch,active,retired_epoch FROM saas_fast_gateway_owner_slots WHERE deployment_id=$1 ORDER BY slot',
    [spec.deploymentId],
  );
  if (
    result.rows.length !== 2 ||
    result.rows.some(
      (row, slot) => row.slot !== slot || row.owner !== boundedOwnerName(spec.deploymentId, slot as 0 | 1),
    )
  )
    throw new Error('BOUNDED_DEPLOYMENT_SLOT_CONFLICT');
  return result.rows.map(({ retired_epoch, ...row }) => Object.freeze({ ...row, retiredEpoch: retired_epoch }));
}

/** Requires an idle slot. Never expires or steals another process's epoch. */
export async function activateBoundedOwner(
  database: SaasDatabase,
  input: BoundedOwnerKey,
): Promise<BoundedOwnerActivation> {
  input = Object.freeze({ ...input });
  const owner = ownerKey(input);
  await database.transaction(async (tx) => {
    await requirePolicy(tx, input);
    // The existing reserve CTE holds SHARE on this row. Always lock it before
    // changing slot state, so activation/release cannot race an intent write.
    one((await tx.query('SELECT epoch FROM saas_fast_gateway_owners WHERE owner=$1 FOR UPDATE', [owner])).rowCount);
    const result = await tx.query<{ active: boolean; epoch: string }>(
      'SELECT active,epoch FROM saas_fast_gateway_owner_slots WHERE owner=$1 AND deployment_id=$2 AND slot=$3',
      [owner, input.deploymentId, input.slot],
    );
    const current = result.rows[0];
    if (!current) throw new Error('BOUNDED_DEPLOYMENT_SLOT_CONFLICT');
    if (current.active) {
      if (current.epoch === input.epoch) return; // Exact lost-ACK replay only.
      throw new Error('BOUNDED_DEPLOYMENT_SLOT_ACTIVE');
    }
    if (current.epoch === input.epoch) throw new Error('BOUNDED_DEPLOYMENT_REUSED_EPOCH');
    // Stable API error for known reuse; the slot transition's unique INSERT is
    // the database authority, including a race or direct supported-role SQL.
    const used = await tx.query('SELECT epoch FROM saas_fast_gateway_owner_activations WHERE epoch=$1', [input.epoch]);
    if (used.rowCount !== 0) throw new Error('BOUNDED_DEPLOYMENT_REUSED_EPOCH');
    one(
      (
        await tx.query(
          'UPDATE saas_fast_gateway_owner_slots SET active=true,epoch=$2 WHERE owner=$1 AND active=false AND epoch=$3',
          [owner, input.epoch, current.epoch],
        )
      ).rowCount,
    );
    one((await tx.query('UPDATE saas_fast_gateway_owners SET epoch=$2 WHERE owner=$1', [owner, input.epoch])).rowCount);
  });
  return Object.freeze({ ...input, owner });
}

/**
 * Control operation, never a timer/lease callback. The supervisor must first
 * prove the exact old process and its native pools are gone. This API does not
 * manufacture that external proof, retire money, or discard missing receipts.
 */
export async function releaseBoundedOwner(database: SaasDatabase, input: BoundedOwnerKey): Promise<void> {
  input = Object.freeze({ ...input });
  const owner = ownerKey(input);
  await database.transaction(async (tx) => {
    await requirePolicy(tx, input);
    one((await tx.query('SELECT epoch FROM saas_fast_gateway_owners WHERE owner=$1 FOR UPDATE', [owner])).rowCount);
    const result = await tx.query<{ active: boolean; epoch: string; retired_epoch: string | null }>(
      'SELECT active,epoch,retired_epoch FROM saas_fast_gateway_owner_slots WHERE owner=$1 AND deployment_id=$2 AND slot=$3',
      [owner, input.deploymentId, input.slot],
    );
    const current = result.rows[0];
    if (current && !current.active && current.retired_epoch === input.epoch) return;
    if (!current?.active || current.epoch !== input.epoch) throw new Error('BOUNDED_DEPLOYMENT_RELEASE_CONFLICT');
    const fenceEpoch = randomUUID();
    one(
      (
        await tx.query(
          `UPDATE saas_fast_gateway_owner_slots SET active=false,epoch=$2,retired_epoch=$3
       WHERE owner=$1 AND active=true AND epoch=$3`,
          [owner, fenceEpoch, input.epoch],
        )
      ).rowCount,
    );
    one((await tx.query('UPDATE saas_fast_gateway_owners SET epoch=$2 WHERE owner=$1', [owner, fenceEpoch])).rowCount);
  });
}

export async function verifyBoundedOwner(database: SqlExecutor, input: BoundedOwnerActivation): Promise<void> {
  input = Object.freeze({ ...input });
  if (ownerKey(input) !== input.owner) throw new Error('BOUNDED_DEPLOYMENT_OWNER_CONFLICT');
  const result = await database.query(
    `SELECT o.owner FROM saas_fast_gateway_owners o
     JOIN saas_fast_gateway_owner_slots s ON s.owner=o.owner AND s.epoch=o.epoch AND s.active
     JOIN saas_fast_gateway_owner_activations h ON h.owner=o.owner AND h.epoch=o.epoch
     JOIN saas_fast_gateway_deployments d ON d.deployment_id=s.deployment_id
     WHERE o.owner=$1 AND o.epoch=$2 AND s.deployment_id=$3 AND s.slot=$4
       AND d.policy_digest=$5 AND d.credit_cap_minor_units=$6::bigint`,
    [input.owner, input.epoch, input.deploymentId, input.slot, input.policyDigest, input.creditCapMinorUnits],
  );
  if (result.rowCount !== 1) throw new Error('BOUNDED_DEPLOYMENT_OWNER_NOT_ACTIVE');
}

/** Caller MUST hold the existing wallet fence. Slow refill path, never reserve. */
export async function ensureBoundedCreditBudget(
  tx: SqlExecutor,
  spec: BoundedDeploymentSpec,
  tenantId: string,
  currency: string,
): Promise<bigint> {
  await tx.query(
    `INSERT INTO saas_fast_gateway_credit_budgets
       (tenant_id,currency,deployment_id,credit_cap_minor_units,allocated_minor_units)
     SELECT $1,$2,$3,$4::bigint,COALESCE(SUM(backing_minor_units),0)
       FROM saas_fast_credit_allocations WHERE tenant_id=$1 AND currency=$2
     ON CONFLICT(tenant_id,currency) DO NOTHING`,
    [tenantId, currency, spec.deploymentId, spec.creditCapMinorUnits],
  );
  const result = await tx.query<{ credit_cap_minor_units: string; allocated_minor_units: string }>(
    `SELECT credit_cap_minor_units::text,allocated_minor_units::text FROM saas_fast_gateway_credit_budgets
     WHERE tenant_id=$1 AND currency=$2`,
    [tenantId, currency],
  );
  const budget = result.rows[0];
  if (!budget || budget.credit_cap_minor_units !== spec.creditCapMinorUnits)
    throw new Error('BOUNDED_DEPLOYMENT_GLOBAL_CAP_CONFLICT');
  const remaining = BigInt(budget.credit_cap_minor_units) - BigInt(budget.allocated_minor_units);
  if (remaining < 0n) throw new Error('BOUNDED_DEPLOYMENT_EXISTING_BACKING_EXCEEDS_CAP');
  return remaining;
}
