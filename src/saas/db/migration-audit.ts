import { createHash } from 'node:crypto';
import { SAAS_MIGRATIONS, type SaasMigration } from './migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool } from './types.js';

/**
 * This is an operator audit, not a replacement for startup readiness or a
 * migration runner. It never creates a pool, discovers a URL, migrates, or
 * repairs a ledger. The caller must supply a pool for its explicit target.
 * Deployment/environment labels are caller attestations, not database facts.
 */
export interface SaasMigrationAuditTarget {
  deploymentId: string;
  environmentId: string;
  database: string;
  schema: string;
}

export const SAAS_AUDIT_CATALOG_PROFILE = 'saas-ddl-v1' as const;
export const SAAS_AUDIT_CATALOG_KINDS = [
  'relation', 'column', 'constraint', 'index', 'trigger', 'routine', 'view', 'sequence',
] as const;
export type SaasAuditCatalogKind = (typeof SAAS_AUDIT_CATALOG_KINDS)[number];
const unsupportedCatalogFeatures = ['relation', 'aggregate', 'type', 'policy', 'rule', 'inheritance'] as const;
type UnsupportedCatalogFeature = (typeof unsupportedCatalogFeatures)[number] | 'unknown';

/** No raw identifiers, function bodies, defaults, trigger arguments, or URLs. */
export interface SaasAuditCatalogObject {
  kind: SaasAuditCatalogKind;
  identityChecksum: string;
  definitionChecksum: string;
}

/**
 * An externally reviewed baseline, never inferred from SQL text or promoted
 * automatically from the target being audited. Same schema name and PG major
 * are required because PostgreSQL deparsers are not portable across majors.
 * A baseline proves only the stated catalog profile, not data, IAM, other
 * schemas, restore history, or eligibility to run an upgrade.
 */
export interface SaasAuditCatalogBaseline {
  profile: typeof SAAS_AUDIT_CATALOG_PROFILE;
  coverage: 'complete-profile' | 'partial';
  evidenceId: string;
  releaseId: string;
  schema: string;
  postgresMajor: number;
  migrationsChecksum: string;
  objects: readonly SaasAuditCatalogObject[];
}

export interface SaasMigrationAuditOptions {
  target: SaasMigrationAuditTarget;
  releaseId: string;
  migrations?: readonly SaasMigration[];
  catalogBaseline?: SaasAuditCatalogBaseline;
  /** Trusted historical evidence is diagnostic only; it never permits a mismatch. */
  legacyChecksums?: readonly { version: 22 | 23; checksum: string; evidenceId: string }[];
}

export type SaasAuditState = 'match' | 'missing' | 'drift' | 'unknown';
export interface SaasAuditMigrationEvidence {
  version: number;
  name: string | null;
  nameChecksum: string;
  checksum: string | null;
}
export interface SaasAuditMigrationComparison {
  version: number;
  state: SaasAuditState;
  expected: SaasAuditMigrationEvidence | null;
  actual: SaasAuditMigrationEvidence | null;
}
export interface SaasAuditCatalogComparison {
  kind: SaasAuditCatalogKind;
  identityChecksum: string;
  state: SaasAuditState;
  expected: SaasAuditCatalogObject | null;
  actual: SaasAuditCatalogObject | null;
}

export type SaasMigrationAuditCode =
  | 'INVALID_INPUT' | 'INVALID_REGISTRY' | 'INVALID_BASELINE' | 'BASELINE_MISSING'
  | 'BASELINE_PARTIAL' | 'BASELINE_BINDING_MISMATCH' | 'CONNECT_FAILED'
  | 'SNAPSHOT_FAILED' | 'TARGET_MISMATCH' | 'TARGET_UNAVAILABLE' | 'UNSUPPORTED_POSTGRES'
  | 'LEDGER_MISSING' | 'LEDGER_NOT_TABLE' | 'LEDGER_INVALID' | 'LEDGER_READ_FAILED'
  | 'MIGRATION_MISSING' | 'MIGRATION_OUT_OF_ORDER' | 'MIGRATION_UNKNOWN'
  | 'NAME_MISMATCH' | 'CHECKSUM_MISMATCH' | 'CHECKSUM_MISMATCH_022_023'
  | 'KNOWN_LEGACY_CHECKSUM' | 'CATALOG_READ_FAILED' | 'CATALOG_INVALID'
  | 'CATALOG_UNSUPPORTED_OBJECTS' | 'CATALOG_MISSING' | 'CATALOG_DRIFT'
  | 'CATALOG_UNKNOWN' | 'ROLLBACK_FAILED' | 'RELEASE_FAILED';

export interface SaasMigrationAuditReport {
  format: 'saas-migration-audit-v1';
  /** A match is limited to this release's ledger and the declared catalog profile. */
  compatibility: 'unverified' | 'mismatch' | 'matches-trusted-baseline';
  target: SaasMigrationAuditTarget | null;
  actualTarget: { database: string | null; databaseChecksum: string; schemaPresent: boolean; postgresMajor: number } | null;
  releaseId: string | null;
  expectedMigrationsChecksum: string | null;
  migrations: SaasAuditMigrationComparison[];
  catalog: {
    profile: typeof SAAS_AUDIT_CATALOG_PROFILE;
    coverage: readonly string[];
    exclusions: readonly string[];
    unsupportedFeatures: UnsupportedCatalogFeature[];
    baselineEvidenceId: string | null;
    baselineCoverage: 'complete-profile' | 'partial' | null;
    expectedChecksum: string | null;
    actualChecksum: string | null;
    actual: SaasAuditCatalogObject[];
    comparisons: SaasAuditCatalogComparison[];
  };
  issues: { code: SaasMigrationAuditCode; version?: number; identityChecksum?: string }[];
}

const HASH = /^[0-9a-f]{64}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const catalogKinds = new Set<string>(SAAS_AUDIT_CATALOG_KINDS);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function isSaasMigrationAuditTarget(target: SaasMigrationAuditTarget | undefined): target is SaasMigrationAuditTarget {
  return !!target && typeof target.deploymentId === 'string' && LABEL.test(target.deploymentId)
    && typeof target.environmentId === 'string' && LABEL.test(target.environmentId)
    && typeof target.database === 'string' && IDENTIFIER.test(target.database)
    && typeof target.schema === 'string' && IDENTIFIER.test(target.schema)
    && !['pg_catalog', 'information_schema', 'pg_temp', 'pg_toast'].includes(target.schema)
    && !target.schema.startsWith('pg_');
}

/** Uses exactly the migration runner's SHA256(name + NUL + sql) algorithm. */
export function getSaasMigrationAuditExpectations(
  migrations: readonly SaasMigration[] = SAAS_MIGRATIONS,
): { migrations: SaasAuditMigrationEvidence[]; checksum: string } {
  if (!Array.isArray(migrations) || migrations.length === 0 || migrations.length > 10_000) {
    throw new Error('Invalid SaaS audit migration registry');
  }
  const versions = new Set<number>();
  const names = new Set<string>();
  // Validate before sorting: malformed inputs must not leak through comparator errors.
  for (const migration of migrations) {
    if (!migration || !Number.isSafeInteger(migration.version) || migration.version < 1
      || typeof migration.name !== 'string' || !migration.name.trim()
      || typeof migration.sql !== 'string' || !migration.sql.trim()
      || versions.has(migration.version) || names.has(migration.name)) {
      throw new Error('Invalid SaaS audit migration registry');
    }
    versions.add(migration.version);
    names.add(migration.name);
  }
  const expected = [...migrations].sort((a, b) => a.version - b.version).map((migration) => ({
    version: migration.version,
    // Registry names are emitted only if they are safe metadata labels.
    name: LABEL.test(migration.name) ? migration.name : null,
    nameChecksum: digest(migration.name),
    checksum: createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex'),
  }));
  return { migrations: expected, checksum: digest(JSON.stringify(expected)) };
}

function orderedCatalog(objects: readonly SaasAuditCatalogObject[]): SaasAuditCatalogObject[] {
  return [...objects].sort((a, b) => {
    const left = `${a.kind}:${a.identityChecksum}`;
    const right = `${b.kind}:${b.identityChecksum}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Stable digest of already-hashed inventory; useful when reviewing baseline candidates offline. */
export function getSaasAuditCatalogChecksum(objects: readonly SaasAuditCatalogObject[]): string {
  return digest(JSON.stringify(orderedCatalog(objects).map(({ kind, identityChecksum, definitionChecksum }) => ({
    kind, identityChecksum, definitionChecksum,
  }))));
}

function validCatalog(objects: readonly SaasAuditCatalogObject[]): boolean {
  if (!Array.isArray(objects) || objects.length === 0 || objects.length > 100_000) return false;
  const seen = new Set<string>();
  for (const object of objects) {
    if (!object || !catalogKinds.has(object.kind) || typeof object.identityChecksum !== 'string'
      || !HASH.test(object.identityChecksum) || typeof object.definitionChecksum !== 'string'
      || !HASH.test(object.definitionChecksum)) return false;
    const key = `${object.kind}:${object.identityChecksum}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** Structural validation only: an evidenceId is an operator attestation, not a signature. */
export function isSaasAuditCatalogBaseline(value: unknown): value is SaasAuditCatalogBaseline {
  if (!value || typeof value !== 'object') return false;
  const baseline = value as SaasAuditCatalogBaseline;
  return baseline.profile === SAAS_AUDIT_CATALOG_PROFILE
    && ['complete-profile', 'partial'].includes(baseline.coverage)
    && typeof baseline.evidenceId === 'string' && LABEL.test(baseline.evidenceId)
    && typeof baseline.releaseId === 'string' && LABEL.test(baseline.releaseId)
    && typeof baseline.schema === 'string' && IDENTIFIER.test(baseline.schema)
    && Number.isSafeInteger(baseline.postgresMajor) && baseline.postgresMajor >= 15
    && typeof baseline.migrationsChecksum === 'string' && HASH.test(baseline.migrationsChecksum)
    && validCatalog(baseline.objects);
}

/**
 * All names/definitions are used only for hashing inside this module. No
 * business tables (including credentials) are read by this inventory.
 * search_path is fixed to pg_catalog for stable, non-shadowable deparsing.
 * OIDs, owner/ACLs, sequence current values and physical storage are excluded.
 * Unsupported relation/routine/type/policy/rule/partition objects block a
 * complete-profile comparison instead of silently extending its coverage.
 */
export const SAAS_MIGRATION_AUDIT_CATALOG_SQL = `
WITH ns AS (
  SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1
), relations AS (
  SELECT c.* FROM pg_catalog.pg_class c JOIN ns ON ns.oid = c.relnamespace
), inventory AS (
  SELECT 'relation'::text AS kind,
    pg_catalog.jsonb_build_array(c.relname)::text AS identity,
    pg_catalog.jsonb_build_array(c.relkind, c.relpersistence, c.relrowsecurity,
      c.relforcerowsecurity, c.relreplident)::text AS definition
  FROM relations c WHERE c.relkind IN ('r', 'v', 'm', 'S')
  UNION ALL
  SELECT 'column', pg_catalog.jsonb_build_array(c.relname, a.attname)::text,
    pg_catalog.jsonb_build_array(a.attnum, pg_catalog.format_type(a.atttypid, a.atttypmod),
      a.attnotnull, a.attidentity, a.attgenerated,
      pg_catalog.pg_get_expr(d.adbin, d.adrelid, false), cn.nspname, coll.collname)::text
  FROM relations c
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  LEFT JOIN pg_catalog.pg_collation coll ON coll.oid = a.attcollation
  LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = coll.collnamespace
  WHERE c.relkind IN ('r', 'v', 'm', 'S')
  UNION ALL
  SELECT 'constraint', pg_catalog.jsonb_build_array(c.relname, con.conname)::text,
    pg_catalog.jsonb_build_array(pg_catalog.pg_get_constraintdef(con.oid, false),
      con.convalidated, con.condeferrable, con.condeferred, con.connoinherit)::text
  FROM pg_catalog.pg_constraint con JOIN relations c ON c.oid = con.conrelid
  UNION ALL
  SELECT 'index', pg_catalog.jsonb_build_array(c.relname, ic.relname)::text,
    pg_catalog.jsonb_build_array(pg_catalog.pg_get_indexdef(i.indexrelid, 0, false),
      i.indisvalid, i.indisready, i.indislive, i.indisreplident, i.indisclustered)::text
  FROM pg_catalog.pg_index i JOIN relations c ON c.oid = i.indrelid
  JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
  UNION ALL
  SELECT 'trigger',
    pg_catalog.jsonb_build_array(c.relname, t.tgisinternal,
      CASE WHEN t.tgisinternal THEN con.conname ELSE t.tgname END,
      pn.nspname, p.proname, t.tgtype)::text,
    pg_catalog.jsonb_build_array(t.tgenabled, t.tgdeferrable, t.tginitdeferred,
      pg_catalog.encode(t.tgargs, 'hex'),
      CASE WHEN NOT t.tgisinternal THEN pg_catalog.pg_get_triggerdef(t.oid, false) ELSE NULL END)::text
  FROM pg_catalog.pg_trigger t JOIN relations c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
  JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
  LEFT JOIN pg_catalog.pg_constraint con ON con.oid = t.tgconstraint
  UNION ALL
  SELECT 'routine', pg_catalog.jsonb_build_array(p.proname,
      pg_catalog.pg_get_function_identity_arguments(p.oid))::text,
    pg_catalog.pg_get_functiondef(p.oid)
  FROM pg_catalog.pg_proc p JOIN ns ON ns.oid = p.pronamespace WHERE p.prokind IN ('f', 'p', 'w')
  UNION ALL
  SELECT 'view', pg_catalog.jsonb_build_array(c.relname)::text,
    pg_catalog.jsonb_build_array(pg_catalog.pg_get_viewdef(c.oid, false), c.reloptions)::text
  FROM relations c WHERE c.relkind IN ('v', 'm')
  UNION ALL
  SELECT 'sequence', pg_catalog.jsonb_build_array(c.relname)::text,
    pg_catalog.jsonb_build_array(pg_catalog.format_type(s.seqtypid, NULL), s.seqstart,
      s.seqincrement, s.seqmax, s.seqmin, s.seqcache, s.seqcycle,
      owned.relname, a.attname, dep.deptype)::text
  FROM relations c JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid
  LEFT JOIN pg_catalog.pg_depend dep ON dep.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND dep.objid = c.oid AND dep.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND dep.deptype IN ('a', 'i')
  LEFT JOIN pg_catalog.pg_class owned ON owned.oid = dep.refobjid
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = dep.refobjid AND a.attnum = dep.refobjsubid
), unsupported AS (
  SELECT 'relation'::text AS kind FROM relations WHERE relkind NOT IN ('r', 'v', 'm', 'S', 'i')
  UNION ALL SELECT 'aggregate' FROM pg_catalog.pg_proc p JOIN ns ON ns.oid = p.pronamespace WHERE p.prokind = 'a'
  UNION ALL SELECT 'type' FROM pg_catalog.pg_type t JOIN ns ON ns.oid = t.typnamespace
    WHERE t.typrelid = 0 AND t.typelem = 0
  UNION ALL SELECT 'policy' FROM pg_catalog.pg_policy p JOIN relations c ON c.oid = p.polrelid
  UNION ALL SELECT 'rule' FROM pg_catalog.pg_rewrite r JOIN relations c ON c.oid = r.ev_class WHERE r.rulename <> '_RETURN'
  UNION ALL SELECT 'inheritance' FROM pg_catalog.pg_inherits i JOIN relations c ON c.oid = i.inhrelid OR c.oid = i.inhparent
)
SELECT kind, identity, definition FROM inventory
UNION ALL
SELECT 'unsupported', kind, kind FROM unsupported
`;

const TARGET_SQL = `SELECT pg_catalog.current_database() AS database,
  pg_catalog.current_setting('server_version_num') AS server_version_num,
  pg_catalog.current_setting('transaction_read_only') AS read_only,
  pg_catalog.current_setting('transaction_isolation') AS isolation,
  EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS schema_present`;
const LEDGER_SQL = `SELECT c.relkind FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = 'saas_schema_migrations'`;

export async function auditSaasMigrationCompatibility(
  pool: SaasDatabasePool,
  options: SaasMigrationAuditOptions,
): Promise<SaasMigrationAuditReport> {
  const report: SaasMigrationAuditReport = {
    format: 'saas-migration-audit-v1', compatibility: 'unverified', target: null,
    actualTarget: null, releaseId: null, expectedMigrationsChecksum: null, migrations: [],
    catalog: {
      profile: SAAS_AUDIT_CATALOG_PROFILE,
      coverage: ['relations/RLS flags', 'columns/types/defaults', 'constraints/validation',
        'indexes/validity', 'triggers/enabled/internal-FK state', 'routine definitions', 'views', 'sequence definitions/ownership'],
      exclusions: ['roles/ACL/IAM', 'business data and sequence current values',
        'other-schema definitions/dependencies', 'deployment identity attestation', 'physical storage/owner settings',
        'upgrade path and restore provenance'],
      unsupportedFeatures: [],
      baselineEvidenceId: null, baselineCoverage: null, expectedChecksum: null,
      actualChecksum: null, actual: [], comparisons: [],
    }, issues: [],
  };
  const issue = (code: SaasMigrationAuditCode, version?: number, identityChecksum?: string): void => {
    report.issues.push({ code, ...(version === undefined ? {} : { version }),
      ...(identityChecksum === undefined ? {} : { identityChecksum }) });
  };
  if (!options || !isSaasMigrationAuditTarget(options.target) || typeof options.releaseId !== 'string'
    || !LABEL.test(options.releaseId) || !pool || typeof pool.connect !== 'function') {
    issue('INVALID_INPUT');
    return report;
  }
  report.target = { deploymentId: options.target.deploymentId, environmentId: options.target.environmentId,
    database: options.target.database, schema: options.target.schema };
  report.releaseId = options.releaseId;
  let expected: SaasAuditMigrationEvidence[];
  try {
    const expectations = getSaasMigrationAuditExpectations(options.migrations ?? SAAS_MIGRATIONS);
    expected = expectations.migrations;
    report.expectedMigrationsChecksum = expectations.checksum;
  } catch {
    issue('INVALID_REGISTRY');
    return report;
  }
  report.migrations = expected.map((migration) => ({
    version: migration.version, state: 'unknown', expected: migration, actual: null,
  }));
  const legacy = options.legacyChecksums ?? [];
  if (!Array.isArray(legacy) || legacy.some((entry) => !entry || ![22, 23].includes(entry.version)
    || typeof entry.checksum !== 'string' || !HASH.test(entry.checksum)
    || typeof entry.evidenceId !== 'string' || !LABEL.test(entry.evidenceId))) {
    issue('INVALID_INPUT');
    return report;
  }
  const suppliedBaseline = options.catalogBaseline;
  let baseline: SaasAuditCatalogBaseline | undefined;
  if (!suppliedBaseline) issue('BASELINE_MISSING');
  else if (!isSaasAuditCatalogBaseline(suppliedBaseline)) {
    issue('INVALID_BASELINE');
  } else {
    // Copy only the public contract; do not retain extra fields from untrusted JSON inputs.
    baseline = {
      profile: suppliedBaseline.profile, coverage: suppliedBaseline.coverage,
      evidenceId: suppliedBaseline.evidenceId, releaseId: suppliedBaseline.releaseId,
      schema: suppliedBaseline.schema, postgresMajor: suppliedBaseline.postgresMajor,
      migrationsChecksum: suppliedBaseline.migrationsChecksum,
      objects: suppliedBaseline.objects.map(({ kind, identityChecksum, definitionChecksum }) => ({
        kind, identityChecksum, definitionChecksum,
      })),
    };
    report.catalog.baselineEvidenceId = baseline.evidenceId;
    report.catalog.baselineCoverage = baseline.coverage;
    report.catalog.expectedChecksum = getSaasAuditCatalogChecksum(baseline.objects);
    if (baseline.coverage !== 'complete-profile') issue('BASELINE_PARTIAL');
    if (baseline.releaseId !== report.releaseId || baseline.schema !== report.target.schema
      || baseline.migrationsChecksum !== report.expectedMigrationsChecksum) issue('BASELINE_BINDING_MISMATCH');
  }

  let client: SaasDatabaseClient;
  try { client = await pool.connect(); } catch {
    issue('CONNECT_FAILED');
    return report;
  }
  let began = false;
  let discard = false;
  let phase: SaasMigrationAuditCode = 'SNAPSHOT_FAILED';
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    began = true;
    await client.query('SET LOCAL search_path TO pg_catalog');
    const targetResult = await client.query<Record<string, unknown>>(TARGET_SQL, [report.target.schema]);
    const row = targetResult.rows[0];
    const serverVersion = positiveInteger(row?.server_version_num);
    if (targetResult.rows.length !== 1 || !row || typeof row.database !== 'string'
      || serverVersion === null || typeof row.schema_present !== 'boolean'
      || row.read_only !== 'on' || row.isolation !== 'repeatable read') {
      issue('TARGET_UNAVAILABLE');
    } else {
      report.actualTarget = {
        database: row.database === report.target.database ? row.database : null,
        databaseChecksum: digest(row.database), schemaPresent: row.schema_present,
        postgresMajor: Math.floor(serverVersion / 10_000),
      };
      if (row.database !== report.target.database) issue('TARGET_MISMATCH');
      else if (!row.schema_present) issue('TARGET_UNAVAILABLE');
      else if (report.actualTarget.postgresMajor < 15) issue('UNSUPPORTED_POSTGRES');
      else {
        if (baseline && baseline.postgresMajor !== report.actualTarget.postgresMajor) issue('BASELINE_BINDING_MISMATCH');
        phase = 'LEDGER_READ_FAILED';
        const ledger = await client.query<{ relkind: unknown }>(LEDGER_SQL, [report.target.schema]);
        if (ledger.rows.length === 0) {
          issue('LEDGER_MISSING');
          for (const comparison of report.migrations) comparison.state = 'missing';
        } else if (ledger.rows.length !== 1 || ledger.rows[0]?.relkind !== 'r') issue('LEDGER_NOT_TABLE');
        else {
          const history = await client.query<Record<string, unknown>>(
            `SELECT version, name, checksum FROM ${quoteIdentifier(report.target.schema)}."saas_schema_migrations" ORDER BY version ASC`,
          );
          const seenVersions = new Set<number>();
          const seenNames = new Set<string>();
          const byVersion = new Map(report.migrations.map((comparison) => [comparison.version, comparison]));
          for (const applied of history.rows) {
            const version = positiveInteger(applied?.version);
            if (version === null) {
              issue('LEDGER_INVALID');
              continue;
            }
            if (typeof applied.name !== 'string' || typeof applied.checksum !== 'string'
              || !HASH.test(applied.checksum) || seenVersions.has(version) || seenNames.has(applied.name)) {
              issue('LEDGER_INVALID', version);
              const comparison = byVersion.get(version);
              const actual: SaasAuditMigrationEvidence = {
                version, name: null, nameChecksum: digest(typeof applied.name === 'string' ? applied.name : ''),
                checksum: typeof applied.checksum === 'string' && HASH.test(applied.checksum) ? applied.checksum : null,
              };
              if (comparison) { comparison.state = 'unknown'; comparison.actual ??= actual; }
              else report.migrations.push({ version, state: 'unknown', expected: null, actual });
              continue;
            }
            seenVersions.add(version);
            seenNames.add(applied.name);
            const comparison = byVersion.get(version);
            const actual: SaasAuditMigrationEvidence = {
              version, name: comparison?.expected?.nameChecksum === digest(applied.name)
                ? comparison.expected.name : null,
              nameChecksum: digest(applied.name), checksum: applied.checksum,
            };
            if (!comparison) {
              report.migrations.push({ version, state: 'unknown', expected: null, actual });
              issue('MIGRATION_UNKNOWN', version);
              continue;
            }
            comparison.actual = actual;
            comparison.state = 'match';
            if (actual.nameChecksum !== comparison.expected?.nameChecksum) {
              comparison.state = 'drift';
              issue('NAME_MISMATCH', version);
            }
            if (actual.checksum !== comparison.expected?.checksum) {
              comparison.state = 'drift';
              issue(version === 22 || version === 23 ? 'CHECKSUM_MISMATCH_022_023' : 'CHECKSUM_MISMATCH', version);
              if (legacy.some((entry) => entry.version === version && entry.checksum === actual.checksum)) {
                issue('KNOWN_LEGACY_CHECKSUM', version);
              }
            }
          }
          for (const comparison of report.migrations) {
            if (comparison.expected && !comparison.actual) {
              comparison.state = 'missing';
              issue('MIGRATION_MISSING', comparison.version);
              if ([...seenVersions].some((version) => version > comparison.version)) {
                issue('MIGRATION_OUT_OF_ORDER', comparison.version);
              }
            }
          }
          report.migrations.sort((a, b) => a.version - b.version);
        }

        // Inventory remains useful without a ledger or baseline, but cannot grant compatibility.
        phase = 'CATALOG_READ_FAILED';
        const catalog = await client.query<Record<string, unknown>>(SAAS_MIGRATION_AUDIT_CATALOG_SQL, [report.target.schema]);
        const actual: SaasAuditCatalogObject[] = [];
        let invalid = false;
        for (const object of catalog.rows) {
          if (object?.kind === 'unsupported') {
            const feature: UnsupportedCatalogFeature = unsupportedCatalogFeatures.some((kind) => kind === object.identity)
              ? object.identity as UnsupportedCatalogFeature : 'unknown';
            if (!report.catalog.unsupportedFeatures.includes(feature)) {
              report.catalog.unsupportedFeatures.push(feature);
              issue('CATALOG_UNSUPPORTED_OBJECTS');
            }
            continue;
          }
          if (!object || typeof object.kind !== 'string' || !catalogKinds.has(object.kind)
            || typeof object.identity !== 'string' || !object.identity
            || typeof object.definition !== 'string' || !object.definition) {
            invalid = true;
            continue;
          }
          actual.push({ kind: object.kind as SaasAuditCatalogKind,
            identityChecksum: digest(object.identity), definitionChecksum: digest(object.definition) });
        }
        if (invalid || !validCatalog(actual)) issue('CATALOG_INVALID');
        else {
          report.catalog.actual = orderedCatalog(actual);
          report.catalog.actualChecksum = getSaasAuditCatalogChecksum(actual);
          if (baseline) {
            const actualByKey = new Map(actual.map((object) => [`${object.kind}:${object.identityChecksum}`, object]));
            for (const expectedObject of orderedCatalog(baseline.objects)) {
              const key = `${expectedObject.kind}:${expectedObject.identityChecksum}`;
              const actualObject = actualByKey.get(key) ?? null;
              const state = !actualObject ? 'missing'
                : actualObject.definitionChecksum !== expectedObject.definitionChecksum ? 'drift' : 'match';
              report.catalog.comparisons.push({ kind: expectedObject.kind, identityChecksum: expectedObject.identityChecksum,
                state, expected: expectedObject, actual: actualObject });
              if (state !== 'match') issue(state === 'missing' ? 'CATALOG_MISSING' : 'CATALOG_DRIFT', undefined, expectedObject.identityChecksum);
              actualByKey.delete(key);
            }
            for (const actualObject of orderedCatalog([...actualByKey.values()])) {
              report.catalog.comparisons.push({ kind: actualObject.kind, identityChecksum: actualObject.identityChecksum,
                state: 'unknown', expected: null, actual: actualObject });
              issue('CATALOG_UNKNOWN', undefined, actualObject.identityChecksum);
            }
          }
        }
      }
    }
  } catch {
    // Never attach a driver error, cause, query text, or connection configuration.
    issue(phase);
    if (!began) discard = true;
  } finally {
    if (began) {
      try { await client.query('ROLLBACK'); } catch { discard = true; issue('ROLLBACK_FAILED'); }
    }
    try { client.release(discard); } catch { issue('RELEASE_FAILED'); }
  }
  const unverified = new Set<SaasMigrationAuditCode>([
    'BASELINE_MISSING', 'BASELINE_PARTIAL', 'INVALID_BASELINE', 'BASELINE_BINDING_MISMATCH',
    'CONNECT_FAILED', 'SNAPSHOT_FAILED', 'TARGET_UNAVAILABLE', 'LEDGER_READ_FAILED',
    'CATALOG_READ_FAILED', 'CATALOG_INVALID', 'CATALOG_UNSUPPORTED_OBJECTS', 'ROLLBACK_FAILED', 'RELEASE_FAILED',
  ]);
  if (report.issues.length === 0) report.compatibility = 'matches-trusted-baseline';
  else if (report.issues.some(({ code }) => !unverified.has(code))) report.compatibility = 'mismatch';
  return report;
}

export class SaasMigrationAuditError extends Error {
  constructor() {
    super('SaaS migration audit has not established a match to the trusted ledger/catalog baseline');
    this.name = 'SaasMigrationAuditError';
  }
}

/** This gate is necessary evidence, not permission to migrate or proof of a safe upgrade path. */
export function assertSaasMigrationAuditMatches(report: SaasMigrationAuditReport): void {
  if (report.compatibility !== 'matches-trusted-baseline' || report.issues.length !== 0
    || !report.target || !report.actualTarget || report.actualTarget.database !== report.target.database
    || !report.actualTarget.schemaPresent || report.actualTarget.postgresMajor < 15
    || report.catalog.baselineCoverage !== 'complete-profile' || !report.catalog.baselineEvidenceId
    || report.catalog.unsupportedFeatures.length !== 0
    || !report.catalog.actualChecksum || report.catalog.actualChecksum !== report.catalog.expectedChecksum
    || !validCatalog(report.catalog.actual)
    || getSaasAuditCatalogChecksum(report.catalog.actual) !== report.catalog.actualChecksum
    || report.catalog.comparisons.length !== report.catalog.actual.length
    || report.catalog.comparisons.some(({ state, expected, actual }) => state !== 'match'
      || !expected || !actual || expected.definitionChecksum !== actual.definitionChecksum)
    || report.migrations.length === 0 || report.migrations.some(({ state, expected, actual }) => state !== 'match'
      || !expected || !actual || expected.version !== actual.version
      || expected.nameChecksum !== actual.nameChecksum || expected.checksum !== actual.checksum)) {
    throw new SaasMigrationAuditError();
  }
}
