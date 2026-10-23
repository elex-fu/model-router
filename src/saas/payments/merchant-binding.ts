import { randomUUID } from 'node:crypto';
import type { SqlExecutor } from '../db/types.js';
import type { PaymentDatabase } from './types.js';
import type { PaymentProviderAdapter, PaymentProviderRefundAdapter } from './adapter.js';
import { PaymentError } from './errors.js';

export type PaymentOperatingMode = 'disabled' | 'draining' | 'enabled';
export interface PaymentMerchantBinding {
  readonly id: string;
  readonly providerKey: 'alipay';
  readonly merchantId: string;
  readonly sellerId: string;
  readonly currency: 'CNY';
  readonly descriptorDigest: string;
}
export interface LoadedPaymentBinding {
  readonly binding: PaymentMerchantBinding;
  readonly adapter: PaymentProviderAdapter;
  readonly refundAdapter: PaymentProviderRefundAdapter;
}
export interface PaymentBindingResolver {
  require(id: string): LoadedPaymentBinding;
  list(): readonly LoadedPaymentBinding[];
}
export interface PaymentControlSnapshot {
  readonly mode: PaymentOperatingMode;
  readonly activeBindingId: string | null;
  readonly revision: string;
}

/** Immutable, process-local credential lookup. Active admission belongs exclusively to PG. */
export class ReadonlyPaymentBindingResolver implements PaymentBindingResolver {
  private readonly bindings: ReadonlyMap<string, LoadedPaymentBinding>;
  constructor(bindings: readonly LoadedPaymentBinding[]) {
    const entries = new Map<string, LoadedPaymentBinding>();
    for (const entry of bindings) {
      const b = entry.binding;
      if (!b.id || b.providerKey !== 'alipay' || b.currency !== 'CNY' || !b.merchantId || !b.sellerId ||
          !/^[a-f0-9]{64}$/.test(b.descriptorDigest) || entries.has(b.id) ||
          entry.adapter.providerKey !== b.providerKey || entry.refundAdapter.providerKey !== b.providerKey ||
          entry.refundAdapter.merchantId !== b.merchantId) throw new TypeError('Invalid payment binding descriptor');
      entries.set(b.id, Object.freeze({ ...entry, binding: Object.freeze({ ...b }) }));
    }
    this.bindings = entries;
  }
  require(id: string): LoadedPaymentBinding {
    const entry = this.bindings.get(id);
    if (!entry) throw new PaymentError('PAYMENT_BINDING_UNAVAILABLE');
    return entry;
  }
  list(): readonly LoadedPaymentBinding[] { return Object.freeze([...this.bindings.values()]); }
}

export function isPaymentBindingResolver(value: PaymentProviderAdapter | PaymentProviderRefundAdapter | PaymentBindingResolver): value is PaymentBindingResolver {
  return 'require' in value && typeof value.require === 'function' && 'list' in value && typeof value.list === 'function';
}

interface ControlRow { mode: PaymentOperatingMode; active_binding_id: string | null; revision: string; }
function snapshot(row: ControlRow | undefined): PaymentControlSnapshot {
  if (!row || !['disabled', 'draining', 'enabled'].includes(row.mode) || !/^[1-9][0-9]*$/.test(String(row.revision))) throw new PaymentError('PAYMENTS_UNAVAILABLE');
  return { mode: row.mode, activeBindingId: row.active_binding_id, revision: String(row.revision) };
}

export async function readPaymentControl(executor: SqlExecutor, lock = false): Promise<PaymentControlSnapshot> {
  const result = await executor.query<ControlRow>(`SELECT mode, active_binding_id, revision::text FROM saas_payment_control WHERE singleton = TRUE${lock ? ' FOR SHARE' : ''}`);
  return snapshot(result.rows[0]);
}

/** Hold the shared control lock until the caller commits its immutable order snapshot. */
export async function admitPaymentBinding(executor: SqlExecutor, resolver: PaymentBindingResolver, currency: string): Promise<LoadedPaymentBinding> {
  const control = await readPaymentControl(executor, true);
  if (control.mode !== 'enabled' || !control.activeBindingId) throw new PaymentError('PAYMENTS_UNAVAILABLE');
  const loaded = resolver.require(control.activeBindingId);
  if (currency !== 'CNY' || loaded.binding.currency !== currency) throw new PaymentError('PAYMENT_CURRENCY_UNSUPPORTED');
  await assertRegisteredBinding(executor, loaded.binding);
  return loaded;
}

async function assertRegisteredBinding(executor: SqlExecutor, binding: PaymentMerchantBinding): Promise<void> {
  const result = await executor.query<{ id: string }>(`SELECT id FROM saas_payment_merchant_bindings WHERE id = $1 AND provider_key = $2 AND merchant_id = $3 AND seller_id = $4 AND currency = $5 AND descriptor_digest = $6`, [binding.id, binding.providerKey, binding.merchantId, binding.sellerId, binding.currency, binding.descriptorDigest]);
  if (result.rows.length !== 1) throw new PaymentError('PAYMENT_BINDING_UNAVAILABLE');
}

/** Registration is insert-only. Reusing an id for different public facts fails closed. */
export async function registerPaymentBindings(executor: SqlExecutor, resolver: PaymentBindingResolver): Promise<void> {
  for (const { binding: b } of resolver.list()) {
    await executor.query(`INSERT INTO saas_payment_merchant_bindings (id, provider_key, merchant_id, seller_id, currency, descriptor_digest, created_at) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [b.id, b.providerKey, b.merchantId, b.sellerId, b.currency, b.descriptorDigest]);
    await assertRegisteredBinding(executor, b);
  }
}

export async function assertPaymentBindingsReady(executor: SqlExecutor, resolver: PaymentBindingResolver, activating = false): Promise<PaymentControlSnapshot> {
  const control = await readPaymentControl(executor);
  const required = await executor.query<{ binding_id: string }>(`SELECT DISTINCT binding_id FROM (
    SELECT binding_id FROM saas_payment_orders WHERE binding_id IS NOT NULL
    UNION SELECT binding_id FROM saas_service_plan_orders WHERE binding_id IS NOT NULL
    UNION SELECT binding_id FROM saas_payment_inbox WHERE binding_id IS NOT NULL
    UNION SELECT binding_id FROM saas_refund_orders WHERE binding_id IS NOT NULL
  ) historical`);
  const ids = new Set(required.rows.map(row => row.binding_id));
  if (control.activeBindingId) ids.add(control.activeBindingId);
  for (const id of ids) await assertRegisteredBinding(executor, resolver.require(id).binding);
  if (control.mode === 'enabled' && !control.activeBindingId) throw new PaymentError('PAYMENTS_UNAVAILABLE');
  // Legacy facts cannot be attributed to credentials merely by matching current config.
  const legacy = await executor.query<{ present: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM saas_payment_orders WHERE binding_id IS NULL
    UNION ALL SELECT 1 FROM saas_service_plan_orders WHERE binding_id IS NULL AND provider_key IS NOT NULL
    UNION ALL SELECT 1 FROM saas_payment_inbox WHERE binding_id IS NULL
    UNION ALL SELECT 1 FROM saas_refund_orders WHERE binding_id IS NULL
  ) AS present`);
  if ((activating || control.mode === 'enabled') && legacy.rows[0]?.present) throw new PaymentError('PAYMENT_BINDING_UNAVAILABLE');
  return control;
}

export const getPaymentControl = readPaymentControl;

export interface SetPaymentControlInput {
  readonly expectedRevision: string;
  readonly mode: PaymentOperatingMode;
  readonly activeBindingId: string | null;
  readonly actorId: string;
  readonly sessionId: string;
  readonly actorRoles: readonly string[];
  readonly requestId?: string;
}

/** Authenticated platform surface only. Admission locks and the CAS update serialize in PG. */
export async function setPaymentControl(database: PaymentDatabase, resolver: PaymentBindingResolver, input: SetPaymentControlInput): Promise<PaymentControlSnapshot> {
  if (!/^[1-9][0-9]*$/.test(input.expectedRevision) || !['disabled','draining','enabled'].includes(input.mode) ||
      !input.actorId || !input.sessionId || !Array.isArray(input.actorRoles) || new Set(input.actorRoles).size !== input.actorRoles.length ||
      (input.activeBindingId !== null && (typeof input.activeBindingId !== 'string' || !input.activeBindingId || input.activeBindingId.length > 200))) throw new PaymentError('INVALID_INPUT');
  return database.transaction(async tx => {
    await tx.query(`SET LOCAL lock_timeout = '2s'`);
    await tx.query(`SET LOCAL statement_timeout = '10s'`);
    await tx.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))`, [input.actorId]);
    const authority = await tx.query<{ session_id: string; roles: string[] }>(`SELECT s.id AS session_id,
      COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), ARRAY[]::text[]) AS roles
      FROM saas_platform_sessions s JOIN saas_users u ON u.id=s.user_id
      JOIN saas_mfa_credentials c ON c.id=s.credential_id AND c.user_id=s.user_id
      LEFT JOIN saas_platform_role_assignments r ON r.user_id=u.id
      WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND u.disabled_at IS NULL AND u.anonymized_at IS NULL
      AND c.kind='totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL GROUP BY s.id`, [input.sessionId,input.actorId]);
    const roles = authority.rows[0]?.roles;
    if (!Array.isArray(roles) || !roles.some(role => role === 'operations' || role === 'superadmin') ||
        JSON.stringify([...roles].sort()) !== JSON.stringify([...input.actorRoles].sort())) throw new PaymentError('PAYMENT_CONTROL_FORBIDDEN');
    if (input.activeBindingId) await assertRegisteredBinding(tx, resolver.require(input.activeBindingId).binding);
    if (input.mode === 'enabled' && !input.activeBindingId) throw new PaymentError('INVALID_INPUT');
    // This also refuses activation while any original financial facts lack proven binding attribution.
    if (input.mode === 'enabled') await assertPaymentBindingsReady(tx, resolver, true);
    const changed = await tx.query<ControlRow>(`UPDATE saas_payment_control SET mode=$2,active_binding_id=$3,revision=revision+1,updated_by_user_id=$4,updated_at=clock_timestamp()
      WHERE singleton=TRUE AND revision=$1::bigint RETURNING mode,active_binding_id,revision::text`, [input.expectedRevision,input.mode,input.activeBindingId,input.actorId]);
    if (changed.rows.length !== 1) throw new PaymentError('PAYMENT_CONTROL_CONFLICT');
    const next = snapshot(changed.rows[0]);
    await tx.query(`INSERT INTO saas_audit_events (id,tenant_id,actor_user_id,action,target_type,target_id,occurred_at,entry_point,request_id)
      VALUES ($1,NULL,$2,'platform.payments.control_changed','payment_control',$3,clock_timestamp(),'platform_payments',$4)`, [randomUUID(),input.actorId,`wallet_and_byok_plan:CNY:${next.revision}:${next.mode}:${next.activeBindingId ?? 'none'}`,input.requestId ?? null]);
    return next;
  });
}
