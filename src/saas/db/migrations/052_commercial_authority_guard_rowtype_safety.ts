import type { SaasMigration } from './001_initial_schema.js';
import { COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION } from './023_commercial_metering_policy_authority.js';

const guardStart = 'CREATE FUNCTION saas_route_config_commercial_authority_guard() RETURNS trigger';
const guardEnd = '\n$$;';
const source = COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql;
const start = source.indexOf(guardStart);
const end = start < 0 ? -1 : source.indexOf(guardEnd, start);

if (start < 0 || end < 0) {
  throw new Error('Migration 023 commercial authority guard definition is missing');
}

function replaceExactlyOnce(sql: string, before: string, after: string): string {
  const first = sql.indexOf(before);
  if (first < 0 || sql.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Migration 052 expected exactly one ${before}`);
  }
  return `${sql.slice(0, first)}${after}${sql.slice(first + before.length)}`;
}

let guardSql = source.slice(start, end + guardEnd.length);
guardSql = replaceExactlyOnce(
  guardSql,
  guardStart,
  'CREATE OR REPLACE FUNCTION saas_route_config_commercial_authority_guard() RETURNS trigger',
);
guardSql = replaceExactlyOnce(
  guardSql,
  '  price_record record;',
  '  price_effective_at timestamptz;\n  price_expires_at timestamptz;',
);
guardSql = replaceExactlyOnce(
  guardSql,
  '  cost_record record;',
  '  cost_effective_at timestamptz;\n  cost_expires_at timestamptz;',
);
guardSql = replaceExactlyOnce(guardSql, '      INTO price_record\n', '      INTO price_effective_at, price_expires_at\n');
guardSql = replaceExactlyOnce(guardSql, '      INTO cost_record\n', '      INTO cost_effective_at, cost_expires_at\n');
guardSql = replaceExactlyOnce(
  guardSql,
  `  IF NEW.customer_price_version IS NOT NULL
    AND (price_record.effective_at IS NULL OR price_record.effective_at > locked_at
      OR (price_record.expires_at IS NOT NULL AND price_record.expires_at <= locked_at))
  THEN
    RAISE EXCEPTION 'Customer price version is not effective at authority binding'
      USING ERRCODE = '23514';
  END IF;`,
  `  IF NEW.customer_price_version IS NOT NULL
    AND (price_effective_at IS NULL OR price_effective_at > locked_at
      OR (price_expires_at IS NOT NULL AND price_expires_at <= locked_at))
  THEN
    RAISE EXCEPTION 'Customer price version is not effective at authority binding'
      USING ERRCODE = '23514';
  END IF;`,
);
guardSql = replaceExactlyOnce(
  guardSql,
  `  IF NEW.supplier_cost_version IS NOT NULL
    AND (cost_record.effective_at IS NULL OR cost_record.effective_at > locked_at
      OR (cost_record.expires_at IS NOT NULL AND cost_record.expires_at <= locked_at))
  THEN
    RAISE EXCEPTION 'Supplier cost version is not effective at authority binding'
      USING ERRCODE = '23514';
  END IF;`,
  `  IF NEW.supplier_cost_version IS NOT NULL
    AND (cost_effective_at IS NULL OR cost_effective_at > locked_at
      OR (cost_expires_at IS NOT NULL AND cost_expires_at <= locked_at))
  THEN
    RAISE EXCEPTION 'Supplier cost version is not effective at authority binding'
      USING ERRCODE = '23514';
  END IF;`,
);

export const COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION: SaasMigration = {
  version: 52,
  name: 'commercial_authority_guard_rowtype_safety',
  sql: `${guardSql}\n\nGRANT SELECT (version, name, checksum)\n  ON TABLE model_router_saas.saas_schema_migrations\n  TO model_router_saas_gateway;`,
};
