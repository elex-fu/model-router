import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';

interface FakeWallet {
  id: string;
  tenant_id: string;
  currency: string;
  posted_balance_minor_units: string;
  created_at: string;
  updated_at: string;
}

interface FakeFreeze {
  tenant_id: string;
  reason_ref: string;
  frozen_at: string;
}

interface FakeReservation {
  id: string;
  tenant_id: string;
  wallet_id: string;
  currency: string;
  request_id: string;
  idempotency_namespace: string;
  business_key: string;
  amount_minor_units: string;
  state: string;
  price_snapshot_ref: string;
  metadata_ref: string;
  expires_at: string;
  settlement_id: string | null;
  settlement_amount_minor_units: string | null;
  usage_evidence_ref: string | null;
  reconciliation_reference: string | null;
  reconciliation_evidence_ref: string | null;
  release_id: string | null;
  release_evidence_ref: string | null;
  ledger_transaction_id: string | null;
  created_at: string;
  updated_at: string;
}

interface FakeLedgerTransaction {
  id: string;
  tenant_id: string;
  currency: string;
  idempotency_namespace: string;
  business_key: string;
  source_type: string;
  amount_minor_units: string;
  metadata_ref: string;
  source_order_ref: string | null;
  price_snapshot_ref: string | null;
  usage_evidence_ref: string | null;
  created_at: string;
}

interface FakeLedgerEntry {
  id: string;
  transaction_id: string;
  tenant_id: string;
  currency: string;
  direction: 'debit' | 'credit';
  amount_minor_units: string;
  account_type: string;
  account_ref: string;
  wallet_id: string | null;
  created_at: string;
}

interface FakeState {
  wallets: FakeWallet[];
  freezes: FakeFreeze[];
  refundWalletFreezes: Array<{
    refund_order_id: string;
    tenant_id: string;
    wallet_id: string;
    currency: string;
    amount_minor_units: string;
  }>;
  reservations: FakeReservation[];
  transactions: FakeLedgerTransaction[];
  entries: FakeLedgerEntry[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function result<Row>(rows: Row[] = []): SqlResult<Row> {
  return { rows: clone(rows), rowCount: rows.length };
}

function asString(value: unknown): string {
  return String(value);
}

function asBigInt(value: unknown): bigint {
  return BigInt(asString(value));
}

function uniqueError(): Error & { code: string } {
  return Object.assign(new Error('duplicate key'), { code: '23505' });
}

export class FakeBillingDatabase {
  state: FakeState = {
    wallets: [],
    freezes: [],
    refundWalletFreezes: [],
    reservations: [],
    transactions: [],
    entries: [],
  };

  private transactionTail: Promise<void> = Promise.resolve();

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.execute<Row>(sql, values);
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release = () => {};
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = clone(this.state);
    try {
      return await work({ query: (sql, values = []) => this.execute(sql, values) });
    } catch (error) {
      this.state = before;
      throw error;
    } finally {
      release();
    }
  }

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c, d, e, f, g, h, i, j, k, l] = values;

    if (statement.startsWith('select set_config')) return result<Row>();

    if (statement.startsWith('insert into saas_wallets')) {
      const exists = this.state.wallets.some((row) => row.tenant_id === a && row.currency === c);
      if (!exists) {
        this.state.wallets.push({
          id: asString(a),
          tenant_id: asString(b),
          currency: asString(c),
          posted_balance_minor_units: '0',
          created_at: asString(d),
          updated_at: asString(d),
        });
      }
      return result<Row>();
    }

    if (statement.startsWith('select id, tenant_id, currency, posted_balance_minor_units')) {
      const wallet = this.state.wallets.find((row) => row.tenant_id === a && row.currency === b);
      return result<Row>(wallet ? [wallet as Row] : []);
    }

    if (statement.startsWith('select tenant_id, reason_ref, frozen_at')) {
      const freeze = this.state.freezes.find((row) => row.tenant_id === a);
      return result<Row>(freeze ? [freeze as Row] : []);
    }

    if (statement.startsWith('insert into saas_billing_spending_freezes')) {
      if (!this.state.freezes.some((row) => row.tenant_id === a)) {
        this.state.freezes.push({ tenant_id: asString(a), reason_ref: asString(b), frozen_at: asString(c) });
      }
      return result<Row>();
    }

    if (statement.startsWith('delete from saas_billing_spending_freezes')) {
      this.state.freezes = this.state.freezes.filter((row) => row.tenant_id !== a);
      return result<Row>();
    }

    if (statement.startsWith('select coalesce(sum(amount_minor_units), 0)::text as active_hold_minor_units')) {
      const sum = this.state.reservations
        .filter(
          (row) =>
            row.tenant_id === a &&
            row.currency === b &&
            (row.state === 'reserved' || row.state === 'reconciliation_pending'),
        )
        .reduce((total, row) => total + asBigInt(row.amount_minor_units), 0n);
      return result<Row>([{ active_hold_minor_units: sum.toString() } as Row]);
    }

    if (statement.startsWith('select coalesce(sum(amount_minor_units), 0)::text as active_refund_freeze_minor_units')) {
      const sum = this.state.refundWalletFreezes
        .filter((row) => row.tenant_id === a && row.currency === b && row.refund_order_id !== c)
        .reduce((total, row) => total + asBigInt(row.amount_minor_units), 0n);
      return result<Row>([{ active_refund_freeze_minor_units: sum.toString() } as Row]);
    }

    if (
      statement.startsWith(
        'select refund_order_id, tenant_id, wallet_id, currency, amount_minor_units from saas_refund_wallet_freezes',
      )
    ) {
      const freeze = this.state.refundWalletFreezes.find((row) => row.refund_order_id === a);
      return result<Row>(freeze ? [freeze as Row] : []);
    }

    if (statement.startsWith('select id, tenant_id, wallet_id, currency, request_id')) {
      const reservation = this.state.reservations.find(
        (row) => row.tenant_id === a && row.idempotency_namespace === b && row.business_key === c,
      );
      return result<Row>(reservation ? [reservation as Row] : []);
    }

    if (statement.startsWith('insert into saas_billing_reservations')) {
      if (
        this.state.reservations.some(
          (row) =>
            (row.tenant_id === b && row.idempotency_namespace === f && row.business_key === g) ||
            (row.tenant_id === b && row.request_id === e && row.business_key === g),
        )
      ) {
        throw uniqueError();
      }
      const reservation: FakeReservation = {
        id: asString(a),
        tenant_id: asString(b),
        wallet_id: asString(c),
        currency: asString(d),
        request_id: asString(e),
        idempotency_namespace: asString(f),
        business_key: asString(g),
        amount_minor_units: asString(h),
        state: 'reserved',
        price_snapshot_ref: asString(i),
        metadata_ref: asString(j),
        expires_at: asString(k),
        settlement_id: null,
        settlement_amount_minor_units: null,
        usage_evidence_ref: null,
        reconciliation_reference: null,
        reconciliation_evidence_ref: null,
        release_id: null,
        release_evidence_ref: null,
        ledger_transaction_id: null,
        created_at: asString(l),
        updated_at: asString(l),
      };
      this.state.reservations.push(reservation);
      return result<Row>([reservation as Row]);
    }

    if (statement.startsWith("update saas_billing_reservations set state = 'reconciliation_pending'")) {
      if (statement.includes('settlement_id = coalesce')) {
        const reservation = this.reservationById(asString(a), asString(g));
        if (!reservation || !['reserved', 'reconciliation_pending'].includes(reservation.state)) return result<Row>();
        reservation.state = 'reconciliation_pending';
        reservation.settlement_id ??= asString(b);
        reservation.settlement_amount_minor_units ??= asString(c);
        reservation.usage_evidence_ref ??= asString(d);
        reservation.reconciliation_evidence_ref ??= e === null ? null : asString(e);
        reservation.updated_at = asString(f);
        return result<Row>([reservation as Row]);
      }
      const reservation = this.reservationById(asString(a), asString(d));
      if (reservation?.state !== 'reserved') return result<Row>();
      reservation.state = 'reconciliation_pending';
      reservation.reconciliation_reference = asString(b);
      reservation.updated_at = asString(c);
      return result<Row>([reservation as Row]);
    }

    if (statement.startsWith("update saas_billing_reservations set state = 'settled'")) {
      const reservation = this.reservationById(asString(a), asString(h));
      if (!reservation || !['reserved', 'reconciliation_pending'].includes(reservation.state)) return result<Row>();
      reservation.state = 'settled';
      reservation.settlement_id = asString(b);
      reservation.settlement_amount_minor_units = asString(c);
      reservation.usage_evidence_ref = asString(d);
      if (e !== null) reservation.reconciliation_evidence_ref = asString(e);
      reservation.ledger_transaction_id = f === null ? null : asString(f);
      reservation.updated_at = asString(g);
      return result<Row>([reservation as Row]);
    }

    if (statement.startsWith("update saas_billing_reservations set state = 'released'")) {
      const reservation = this.reservationById(asString(a), asString(f));
      if (!reservation || !['reserved', 'reconciliation_pending'].includes(reservation.state)) return result<Row>();
      reservation.state = 'released';
      reservation.release_id = asString(b);
      reservation.release_evidence_ref = asString(c);
      if (d !== null) reservation.reconciliation_evidence_ref = asString(d);
      reservation.updated_at = asString(e);
      return result<Row>([reservation as Row]);
    }

    if (statement.startsWith('insert into saas_ledger_transactions')) {
      const duplicate = this.state.transactions.some(
        (row) =>
          (row.tenant_id === b && row.idempotency_namespace === d && row.business_key === e) ||
          (f === 'wallet_funding' && row.tenant_id === b && row.source_order_ref === i),
      );
      if (duplicate) return result<Row>();
      const transaction: FakeLedgerTransaction = {
        id: asString(a),
        tenant_id: asString(b),
        currency: asString(c),
        idempotency_namespace: asString(d),
        business_key: asString(e),
        source_type: asString(f),
        amount_minor_units: asString(g),
        metadata_ref: asString(h),
        source_order_ref: i === null ? null : asString(i),
        price_snapshot_ref: j === null ? null : asString(j),
        usage_evidence_ref: k === null ? null : asString(k),
        created_at: asString(l),
      };
      this.state.transactions.push(transaction);
      return result<Row>([transaction as Row]);
    }

    if (statement.includes('from saas_ledger_transactions') && statement.includes('source_order_ref =')) {
      const transaction = this.state.transactions.find((row) => row.tenant_id === a && row.source_order_ref === b);
      return result<Row>(transaction ? [transaction as Row] : []);
    }

    if (statement.startsWith('select id, tenant_id, currency, idempotency_namespace, business_key, source_type')) {
      const transaction = this.state.transactions.find(
        (row) => row.tenant_id === a && row.idempotency_namespace === b && row.business_key === c,
      );
      return result<Row>(transaction ? [transaction as Row] : []);
    }

    if (statement.startsWith('insert into saas_ledger_entries')) {
      this.state.entries.push({
        id: asString(a),
        transaction_id: asString(b),
        tenant_id: asString(c),
        currency: asString(d),
        direction: asString(e) as 'debit' | 'credit',
        amount_minor_units: asString(f),
        account_type: asString(g),
        account_ref: asString(h),
        wallet_id: i === null ? null : asString(i),
        created_at: asString(j),
      });
      return result<Row>();
    }

    if (statement.startsWith('update saas_wallets set posted_balance_minor_units = posted_balance_minor_units +')) {
      const wallet = this.state.wallets.find((row) => row.id === a && row.tenant_id === b && row.currency === c);
      if (!wallet) return result<Row>();
      const next = asBigInt(wallet.posted_balance_minor_units) + asBigInt(d);
      if (next < 0n) return result<Row>();
      wallet.posted_balance_minor_units = next.toString();
      wallet.updated_at = asString(e);
      return result<Row>([wallet as Row]);
    }

    if (statement.startsWith("select coalesce(sum(case when direction = 'credit'")) {
      const projected = this.state.entries
        .filter((entry) => entry.wallet_id === a && entry.tenant_id === b && entry.currency === c)
        .reduce(
          (total, entry) =>
            total +
            (entry.direction === 'credit' ? asBigInt(entry.amount_minor_units) : -asBigInt(entry.amount_minor_units)),
          0n,
        );
      return result<Row>([{ posted_balance_minor_units: projected.toString() } as Row]);
    }

    if (statement.startsWith('update saas_wallets set posted_balance_minor_units = $2')) {
      const wallet = this.state.wallets.find((row) => row.id === a && row.tenant_id === d && row.currency === e);
      if (!wallet) return result<Row>();
      wallet.posted_balance_minor_units = asString(b);
      wallet.updated_at = asString(c);
      return result<Row>([wallet as Row]);
    }

    throw new Error(`Unhandled fake SQL: ${statement}`);
  }

  private reservationById(id: string, tenantId: string): FakeReservation | undefined {
    return this.state.reservations.find((row) => row.id === id && row.tenant_id === tenantId);
  }
}
