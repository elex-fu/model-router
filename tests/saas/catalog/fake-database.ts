import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';

interface FakeState {
  products: Array<Record<string, unknown>>;
  publicModels: Array<Record<string, unknown>>;
  publicModelVersions: Array<Record<string, unknown>>;
  capabilities: Array<Record<string, unknown>>;
  rights: Array<Record<string, unknown>>;
  rightsEvents: Array<Record<string, unknown>>;
  auditEvents: Array<Record<string, unknown>>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function result<Row>(rows: Row[] = []): SqlResult<Row> {
  return { rows: copy(rows), rowCount: rows.length };
}

function uniqueError(): Error & { code: string } {
  return Object.assign(new Error('duplicate key'), { code: '23505' });
}

function productKey(providerId: unknown, productId: unknown): string {
  return `${String(providerId)}\u0000${String(productId)}`;
}

export class FakeCatalogDatabase implements SaasDatabase {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];

  state: FakeState = {
    products: [],
    publicModels: [],
    publicModelVersions: [],
    capabilities: [],
    rights: [],
    rightsEvents: [],
    auditEvents: [],
  };

  transactionCount = 0;
  commitCount = 0;
  rollbackCount = 0;
  activeTransactionCount = 0;
  maxConcurrentTransactionCount = 0;
  failAudit = false;
  failCapabilityInsert = false;

  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private readonly serializeTransactions = true) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.execute<Row>(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    if (!this.serializeTransactions) return this.runTransaction(work);

    const previous = this.transactionTail;
    let release = () => {};
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return this.runTransaction(work, release);
  }

  private async runTransaction<T>(work: (tx: SqlExecutor) => Promise<T>, release: () => void = () => {}): Promise<T> {
    this.activeTransactionCount += 1;
    this.maxConcurrentTransactionCount = Math.max(this.maxConcurrentTransactionCount, this.activeTransactionCount);
    const before = copy(this.state);
    try {
      const value = await work({ query: (sql, values = []) => this.execute(sql, values) });
      this.commitCount += 1;
      return value;
    } catch (error) {
      this.state = before;
      this.rollbackCount += 1;
      throw error;
    } finally {
      this.activeTransactionCount -= 1;
      release();
    }
  }

  async migrate(): Promise<void> {}

  async verifySchema(): Promise<void> {}

  async ping(): Promise<void> {}

  async close(): Promise<void> {}

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    this.statements.push({ sql, values: [...values] });
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q] = values;

    // Fake acceptance only; catalog tests assert emitted fence SQL separately and do not model PostgreSQL locks.
    if (statement.startsWith('select set_config(')) return result<Row>();
    if (statement.startsWith('select pg_advisory_xact_lock')) return result<Row>();

    if (
      statement.startsWith(
        'select product.provider_id, product.product_id, product.display_name, product.status, product.created_at from saas_provider_products as product join saas_provider_rights as rights_identity',
      )
    ) {
      const rightsIdentity = this.state.rights.find((row) => row.rights_id === a);
      const product = this.state.products.find(
        (row) =>
          productKey(row.provider_id, row.product_id) ===
          productKey(rightsIdentity?.provider_id, rightsIdentity?.product_id),
      );
      return result<Row>(product ? [product as Row] : []);
    }

    if (
      statement.startsWith(
        'select provider_id, product_id, display_name, status, created_at from saas_provider_products',
      )
    ) {
      return result<Row>(
        this.state.products.filter((row) => productKey(row.provider_id, row.product_id) === productKey(a, b)) as Row[],
      );
    }

    if (statement.startsWith('insert into saas_provider_products')) {
      if (this.state.products.some((row) => productKey(row.provider_id, row.product_id) === productKey(a, b))) {
        throw uniqueError();
      }
      const row = {
        provider_id: a,
        product_id: b,
        display_name: c,
        status: d,
        created_at: e,
      };
      this.state.products.push(row);
      return result<Row>([row as Row]);
    }

    if (statement.startsWith('insert into saas_public_models')) {
      if (this.state.publicModels.some((row) => row.id === a || row.alias === b)) throw uniqueError();
      this.state.publicModels.push({ id: a, alias: b, display_name: c, status: d, created_at: e });
      return result<Row>();
    }

    if (statement.startsWith('insert into saas_public_model_versions')) {
      const version = statement.includes('values ($1, 1,') ? 1 : Number(b);
      if (this.state.publicModelVersions.some((row) => row.public_model_id === a && row.version === version)) {
        throw uniqueError();
      }
      const row = statement.includes('values ($1, 1,')
        ? {
            public_model_id: a,
            version,
            provider_id: b,
            product_id: c,
            model: d,
            endpoint_scope: e,
            status: f,
            created_at: g,
          }
        : {
            public_model_id: a,
            version,
            provider_id: c,
            product_id: d,
            model: e,
            endpoint_scope: f,
            status: g,
            created_at: h,
          };
      this.state.publicModelVersions.push(row);
      return result<Row>();
    }

    if (statement.startsWith('select v.public_model_id, v.version, m.alias, m.display_name')) {
      const model = this.state.publicModels.find((row) => row.id === a);
      const versions = this.state.publicModelVersions
        .filter((row) => row.public_model_id === a)
        .sort((left, right) => Number(right.version) - Number(left.version));
      return result<Row>(
        versions.slice(0, 1).map((row) => ({ ...row, alias: model?.alias, display_name: model?.display_name }) as Row),
      );
    }

    if (statement.startsWith('select version from saas_provider_capabilities')) {
      const versions = this.state.capabilities
        .filter((row) => row.provider_id === a && row.product_id === b && row.model === c && row.endpoint === d)
        .sort((left, right) => Number(right.version) - Number(left.version));
      return result<Row>(versions.slice(0, 1).map((row) => ({ version: row.version }) as Row));
    }

    if (statement.startsWith('insert into saas_provider_capabilities')) {
      if (this.failCapabilityInsert) throw new Error('injected capability insert failure');
      const key = [a, b, c, d, f].join('\u0000');
      if (
        this.state.capabilities.some(
          (row) => [row.provider_id, row.product_id, row.model, row.endpoint, row.version].join('\u0000') === key,
        )
      ) {
        throw uniqueError();
      }
      const row = {
        provider_id: a,
        product_id: b,
        model: c,
        endpoint: d,
        protocol: e,
        version: f,
        support_level: g,
        validation_state: h,
        evidence_version: i,
        discovery_source: j,
        evidence_ref: k,
        evidence_sha256: l,
        created_at: m,
      };
      this.state.capabilities.push(row);
      return result<Row>([row as Row]);
    }

    if (statement.startsWith('select protocol, version, support_level, validation_state')) {
      const rows = this.state.capabilities
        .filter((row) => row.provider_id === a && row.product_id === b && row.model === c && row.endpoint === d)
        .sort((left, right) => Number(right.version) - Number(left.version));
      return result<Row>(
        rows.map(
          (row) =>
            ({
              protocol: row.protocol,
              version: row.version,
              support_level: row.support_level,
              validation_state: row.validation_state,
            }) as Row,
        ),
      );
    }

    if (statement.startsWith('select version, status, provider_id, product_id, credential_type')) {
      const rows = this.state.rights
        .filter((row) => row.rights_id === a)
        .sort((left, right) => Number(right.version) - Number(left.version));
      return result<Row>(
        rows.slice(0, 1).map(
          (row) =>
            ({
              version: row.version,
              status: row.status,
              provider_id: row.provider_id,
              product_id: row.product_id,
              credential_type: row.credential_type,
              supply_mode: row.supply_mode,
              region: row.region,
              purpose: row.purpose,
            }) as Row,
        ),
      );
    }

    if (statement.startsWith('select rights_id, version, status, provider_id, product_id, credential_type')) {
      const rows = this.state.rights
        .filter((row) => row.rights_id === a)
        .sort((left, right) => Number(right.version) - Number(left.version));
      return result<Row>(rows.slice(0, 1) as Row[]);
    }

    if (statement.startsWith('select provider_id, product_id from saas_provider_rights')) {
      const rows = this.state.rights
        .filter((row) => row.rights_id === a)
        .sort((left, right) => Number(right.version) - Number(left.version));
      return result<Row>(rows.slice(0, 1).map(({ provider_id, product_id }) => ({ provider_id, product_id }) as Row));
    }

    if (statement.startsWith('insert into saas_provider_rights ')) {
      const isRevocation = statement.includes("'revoked'");
      const row = isRevocation
        ? {
            rights_id: a,
            version: b,
            provider_id: c,
            product_id: d,
            credential_type: e,
            supply_mode: f,
            region: g,
            purpose: h,
            model_scope: i,
            endpoint_scope: j,
            effective_at: k,
            expires_at: null,
            approval_ref: l,
            status: 'revoked',
            evidence_ref: m,
            evidence_sha256: n,
            created_at: o,
          }
        : {
            rights_id: a,
            version: b,
            provider_id: c,
            product_id: d,
            credential_type: e,
            supply_mode: f,
            region: g,
            purpose: h,
            model_scope: i,
            endpoint_scope: j,
            effective_at: k,
            expires_at: l,
            approval_ref: m,
            status: n,
            evidence_ref: o,
            evidence_sha256: p,
            created_at: q,
          };
      if (
        this.state.rights.some((existing) => existing.rights_id === row.rights_id && existing.version === row.version)
      ) {
        throw uniqueError();
      }
      this.state.rights.push(row);
      return result<Row>([row as Row]);
    }

    if (statement.startsWith('insert into saas_provider_rights_events')) {
      const isRevocation = statement.includes("values ($1, $2, $3, $4, 'revoked', 'revoked', $5)");
      this.state.rightsEvents.push(
        isRevocation
          ? {
              id: a,
              rights_id: b,
              rights_version: c,
              from_status: d,
              to_status: 'revoked',
              event_type: 'revoked',
              occurred_at: e,
            }
          : {
              id: a,
              rights_id: b,
              rights_version: c,
              from_status: d,
              to_status: e,
              event_type: f,
              occurred_at: g,
            },
      );
      return result<Row>();
    }

    if (statement.startsWith('insert into saas_audit_events')) {
      if (this.failAudit) throw new Error('injected audit failure');
      this.state.auditEvents.push({
        id: a,
        tenant_id: b,
        actor_user_id: c,
        action: d,
        target_type: 'saas_provider_rights',
        target_id: e,
        occurred_at: f,
        source_ip: g,
        user_agent: h,
        entry_point: i,
        request_id: j,
      });
      return result<Row>();
    }

    if (statement.startsWith('select rights_id, version, provider_id, product_id, credential_type')) {
      const rows = this.state.rights
        .filter((row) => row.provider_id === a && row.product_id === b)
        .sort(
          (left, right) =>
            String(left.rights_id).localeCompare(String(right.rights_id)) ||
            Number(right.version) - Number(left.version),
        );
      return result<Row>(rows as Row[]);
    }

    throw new Error(`Unhandled fake SQL: ${statement}`);
  }
}
