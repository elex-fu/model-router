import type {
  GenerateProviderCredentialDataKeyRequest,
  ProviderCredentialKms,
} from '../../../../src/saas/credentials/provider-crypto.js';
import type { SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';

/**
 * F1/G4 platform settings store: the shared scripted fake database (a small
 * stateful settings table plus recorded audit inserts) and the deterministic
 * in-memory KMS used by the settings service tests. One KMS instance plays
 * both roles (the local master-key seam): the wrapped data keys it generates
 * are the ones it can decrypt; a second instance is the wrong-key posture.
 */

export interface FakeSettingsRow {
  key: string;
  value: unknown;
  version: number;
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export class FakeSettingsDatabase {
  readonly statements: string[] = [];
  readonly auditEvents: Array<readonly unknown[]> = [];
  readonly auditDetails: Array<readonly unknown[]> = [];
  readonly rows = new Map<string, FakeSettingsRow>();
  readonly now = '2026-10-16T00:00:00Z';
  failAuditInserts = false;

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.statements.push(`${sql.trim().replace(/\s+/g, ' ')} :: ${values.join('|')}`);
    return this.execute<Row>(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work({
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        this.statements.push(`${sql.trim().replace(/\s+/g, ' ')} :: ${values.join('|')}`);
        return this.execute<Row>(sql, values);
      },
    });
  }

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const flat = sql.trim().replace(/\s+/g, ' ');
    if (flat.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
    if (flat.includes('SELECT key, value, version FROM saas_platform_settings WHERE key = $1 FOR UPDATE')) {
      const row = this.rows.get(String(values[0]));
      return { rows: row === undefined ? [] : [row as Row], rowCount: row === undefined ? 0 : 1 };
    }
    if (flat.includes('INSERT INTO saas_platform_settings (')) {
      const key = String(values[0]);
      if (this.rows.has(key)) return { rows: [], rowCount: 0 };
      const row: FakeSettingsRow = {
        key,
        value: JSON.parse(String(values[1])),
        version: 1,
        updated_by_user_id: (values[2] as string | null) ?? null,
        created_at: this.now,
        updated_at: this.now,
      };
      this.rows.set(key, row);
      return { rows: [row as Row], rowCount: 1 };
    }
    if (flat.includes('UPDATE saas_platform_settings')) {
      const key = String(values[0]);
      const row = this.rows.get(key);
      if (row === undefined || row.version !== Number(values[3])) return { rows: [], rowCount: 0 };
      row.value = JSON.parse(String(values[1]));
      row.version += 1;
      row.updated_by_user_id = (values[2] as string | null) ?? null;
      row.updated_at = this.now;
      return { rows: [row as Row], rowCount: 1 };
    }
    if (flat.includes('INSERT INTO saas_audit_events')) {
      if (this.failAuditInserts) throw new Error('audit storage unavailable');
      this.auditEvents.push(values);
      return { rows: [{ id: values[0] } as Row], rowCount: 1 };
    }
    if (flat.includes('INSERT INTO saas_platform_settings_audit_details')) {
      this.auditDetails.push(values);
      return { rows: [{ audit_event_id: values[0] } as Row], rowCount: 1 };
    }
    if (flat.includes('WHERE key = ANY($1::text[])')) {
      const wanted = values[0] as readonly string[];
      const rows = wanted
        .map((key) => this.rows.get(key))
        .filter((row): row is FakeSettingsRow => row !== undefined)
        .map((row) => ({ key: row.key, value: row.value }));
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (flat.includes('SELECT value, version FROM saas_platform_settings WHERE key = $1')) {
      const row = this.rows.get(String(values[0]));
      return {
        rows: (row === undefined ? [] : [{ value: row.value, version: row.version }]) as Row[],
        rowCount: row === undefined ? 0 : 1,
      };
    }
    if (flat.includes('FROM saas_platform_settings')) {
      const rows = [...this.rows.values()].sort((left, right) => left.key.localeCompare(right.key));
      return { rows: rows as Row[], rowCount: rows.length };
    }
    throw new Error(`unhandled fake SQL: ${sql}`);
  }
}

export class DeterministicSettingsKms implements ProviderCredentialKms {
  private readonly keys = new Map<string, Buffer>();
  private sequence = 0;

  async generateDataKey(_request: GenerateProviderCredentialDataKeyRequest) {
    const plaintextKey = Buffer.alloc(32, this.sequence + 1);
    const ciphertextBlob = Buffer.from(`wrapped-settings-${this.sequence}`, 'utf-8');
    this.sequence += 1;
    this.keys.set(ciphertextBlob.toString('base64url'), Buffer.from(plaintextKey));
    return { plaintextKey, ciphertextBlob };
  }

  async decryptDataKey(request: { readonly ciphertextBlob: Uint8Array }): Promise<Uint8Array> {
    const key = this.keys.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    if (!key) throw new Error('unknown wrapped key');
    return Buffer.from(key);
  }
}
