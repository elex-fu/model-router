import type { SqlResult } from '../../../../src/saas/db/types.js';
import type { PlatformCatalogQueryDatabase } from '../../../../src/saas/platform/catalog/types.js';

export interface FakeCatalogCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class FakeCatalogExecutor implements PlatformCatalogQueryDatabase {
  readonly calls: FakeCatalogCall[] = [];

  private responses: Array<readonly Record<string, unknown>[]> = [];
  private failure: Error | null = null;

  enqueue(...responses: Array<readonly Record<string, unknown>[]>): void {
    this.responses.push(...responses);
  }

  failWith(error: Error): void {
    this.failure = error;
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ sql, values: [...values] });
    if (this.failure) throw this.failure;
    const rows = this.responses.shift() ?? [];
    return { rows: clone(rows) as Row[], rowCount: rows.length };
  }
}
