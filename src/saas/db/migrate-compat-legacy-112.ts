import { createHash } from 'node:crypto';
import { MIGRATION_LOCK_CLASS, MIGRATION_LOCK_ID } from './migrate.js';
import {
  getSaasAuditCatalogChecksum,
  getSaasMigrationAuditExpectations,
  isSaasAuditCatalogBaseline,
  SAAS_MIGRATION_AUDIT_CATALOG_SQL,
  type SaasAuditCatalogBaseline,
  type SaasAuditCatalogObject,
} from './migration-audit.js';
import { SAAS_MIGRATIONS, type SaasMigration } from './migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool } from './types.js';

/**
 * The explicit `legacy-main-112-to-129` compatibility plan
 * (docs/core-capability-alignment-technical-plan-2026-10-18.md §5.2).
 *
 * Old main (through 6ffa107) shipped the durable fault-classification
 * migration as version 112 on top of the shared 001..111 registry. The
 * capability-parity merge renumbered it to 129 because 112..128 were taken
 * by the parallel workstream; the name and SQL are byte-identical, so both
 * ledger identities carry the same SHA256(name + NUL + sql) checksum.
 *
 * This module is a SEPARATE, explicitly-invoked upgrade path. It never
 * weakens the normal migrator (`runSaasMigrations` /
 * `assertMigrationHistoryMatchesRelease` are untouched): the only ledger
 * rewrite it performs is the single known-identity move of the old-112 row
 * to 129, keyed on the exact known name AND checksum, and only after the
 * full source history has been re-verified inside the same transaction that
 * applies the pending target migrations. The compatibility receipt this
 * plan produces is audit evidence only — never a second migration
 * authority; nothing in the runtime reads it.
 */

export const LEGACY_MAIN_112_COMPAT_PLAN_ID = 'legacy-main-112-to-129' as const;

/** The old-main (6ffa107) version of the durable fault-classification migration. */
export const LEGACY_MAIN_112_SOURCE_VERSION = 112 as const;
/** The current registry version of the identical migration. */
export const LEGACY_MAIN_112_TARGET_VERSION = 129 as const;

export const LEGACY_MAIN_112_MIGRATION_NAME = 'provider_account_durable_fault_classification' as const;
/**
 * SHA256(name + NUL + sql) of the old-main 112 migration, which is
 * byte-identical to the current registry's 129 entry. Computed from
 * 6ffa107:src/saas/db/migrations/112_provider_account_durable_fault_classification.ts.
 */
export const LEGACY_MAIN_112_MIGRATION_CHECKSUM =
  '3a74754faaf5011fb0ae07970cf1a00a9957622db4d81895abff2f281d88320f' as const;

const HASH = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export interface SaasCompatLedgerRow {
  version: number;
  name: string;
  checksum: string;
}

/** A manifest expectation: version + the exact registered name/checksum identity. */
export interface SaasCompatManifestEntry {
  version: number;
  name: string;
  checksum: string;
}

export type SaasCompatLedgerStateKind =
  /** The complete source state (shared 001..111 + old 112): the compat plan applies. */
  | 'legacy-112-source'
  /** A clean prefix of the release registry at or below 111: use the normal saas:migrate. */
  | 'clean-prefix'
  /** A clean prefix that already includes current 112..: finish with the normal saas:migrate. */
  | 'current-chain-partial'
  /** The complete target state (current registry through 129): idempotent no-op. */
  | 'current-chain-complete'
  /** A row at a known position carries an unexpected checksum: refuse; locate the drift. */
  | 'drifted-checksum'
  /** Anything else (gaps, unknown versions/names, longer-than-registry): refuse. */
  | 'unknown-history';

export interface SaasCompatLedgerClassification {
  kind: SaasCompatLedgerStateKind;
  appliedCount: number;
  head: number;
  detail: string;
  firstMismatch?: {
    index: number;
    ledger: SaasCompatLedgerRow;
    expected: SaasCompatManifestEntry;
    reason: 'version' | 'name' | 'checksum';
  };
}

export type LegacyMain112CompatIssueCode =
  | 'INVALID_INPUT'
  | 'INVALID_REGISTRY'
  | 'IDENTITY_TARGET_MISSING'
  | 'LEDGER_READ_FAILED'
  | 'UNSUPPORTED_POSTGRES'
  | 'STATE_NOT_APPLICABLE'
  | 'STATE_DRIFTED'
  | 'STATE_UNKNOWN'
  | 'LOCK_FAILED'
  | 'REVERIFY_FAILED'
  | 'BASELINE_MISMATCH'
  | 'CATALOG_SNAPSHOT_FAILED'
  | 'MOVE_FAILED'
  | 'APPLY_FAILED'
  | 'VERIFY_FAILED'
  | 'ROLLBACK_FAILED'
  | 'UNLOCK_FAILED';

export interface LegacyMain112DataPreservationProbe {
  readonly probe: string;
  readonly before: string;
  readonly after: string;
}

export interface LegacyMain112CompatPlanOutcome {
  plan: typeof LEGACY_MAIN_112_COMPAT_PLAN_ID;
  status: 'dry-run' | 'applied' | 'already-current' | 'refused' | 'failed';
  classification: SaasCompatLedgerClassification | null;
  postgresMajor: number | null;
  /** Expectations digest (getSaasMigrationAuditExpectations) of the derived legacy source manifest. */
  sourceMigrationsChecksum: string | null;
  /** Expectations digest of the target manifest (current registry through 129). */
  targetMigrationsChecksum: string | null;
  catalogBaselineEvidenceId: string | null;
  catalogVerified: boolean;
  move: { fromVersion: number; toVersion: number; name: string; checksum: string } | null;
  applied: readonly SaasCompatManifestEntry[];
  pendingNormalMigrations: readonly SaasCompatManifestEntry[];
  verification: {
    targetHistoryVerified: boolean;
    catalogConstraintsVerified: number;
    dataPreservation: readonly LegacyMain112DataPreservationProbe[];
  } | null;
  issues: { code: LegacyMain112CompatIssueCode; detail: string }[];
}

export interface LegacyMain112PlanOptions {
  /** Defaults to the release registry (SAAS_MIGRATIONS). */
  migrations?: readonly SaasMigration[];
  /** Target schema name (the migrator login's search_path schema). */
  schema: string;
  /** Operator release label; binds the reviewed catalog baseline. */
  releaseId: string;
  /** Reviewed source-schema catalog baseline; when supplied it must match exactly. */
  catalogBaseline?: SaasAuditCatalogBaseline;
  dryRun?: boolean;
  /**
   * Test/observability seam invoked at the plan's phase boundaries
   * ('after-lock', 'after-reverify', 'after-move', 'after-apply:<version>',
   * 'after-apply', 'after-verify', 'after-commit'). A throw simulates a kill
   * between steps and must roll the transaction back.
   */
  onPhase?: (phase: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry + manifests
// ---------------------------------------------------------------------------

/** Mirrors orderMigrations in migrate.ts (which stays the normal migrator's own). */
function orderCompatMigrations(migrations: readonly SaasMigration[]): SaasMigration[] {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new Error('Invalid SaaS migration registry');
  }
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const seenVersions = new Set<number>();
  const seenNames = new Set<string>();
  for (const migration of ordered) {
    if (
      !migration ||
      !Number.isSafeInteger(migration.version) ||
      migration.version < 1 ||
      typeof migration.name !== 'string' ||
      !migration.name.trim() ||
      typeof migration.sql !== 'string' ||
      !migration.sql.trim() ||
      seenVersions.has(migration.version) ||
      seenNames.has(migration.name)
    ) {
      throw new Error('Invalid SaaS migration registry');
    }
    seenVersions.add(migration.version);
    seenNames.add(migration.name);
  }
  return ordered;
}

export function compatMigrationChecksum(migration: { name: string; sql: string }): string {
  return createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex');
}

export interface LegacyMain112Manifests {
  /** The validated, ordered release registry. */
  registry: readonly SaasMigration[];
  /** Registry entries with version <= 111 — the prefix shared with old main. */
  shared: readonly SaasMigration[];
  /** The full old-main chain as expectations: shared + the old-112 identity. */
  legacySource: readonly SaasCompatManifestEntry[];
  /** The compat target: every registry entry with version <= 129, as expectations. */
  target: readonly SaasCompatManifestEntry[];
  /** The registry entry whose name+checksum is the old-112 identity (version 129). */
  identityTarget: SaasMigration;
  /** Registry entries beyond the compat target; the normal migrator owns them. */
  pendingNormal: readonly SaasMigration[];
}

/**
 * Builds the plan's manifests from the release registry. The identity target
 * is FOUND, never assumed: the registry must contain exactly the known
 * name+checksum identity at version 129, otherwise the plan does not apply
 * to this registry (fail-closed).
 */
export function getLegacyMain112Manifests(
  migrations: readonly SaasMigration[] = SAAS_MIGRATIONS,
): LegacyMain112Manifests {
  const registry = orderCompatMigrations(migrations);
  const identityMatches = registry.filter(
    (migration) =>
      migration.name === LEGACY_MAIN_112_MIGRATION_NAME &&
      compatMigrationChecksum(migration) === LEGACY_MAIN_112_MIGRATION_CHECKSUM,
  );
  if (identityMatches.length !== 1 || identityMatches[0].version !== LEGACY_MAIN_112_TARGET_VERSION) {
    throw new Error(
      'The legacy-main-112-to-129 compat plan requires the known fault-classification identity at registry version 129',
    );
  }
  const identityTarget = identityMatches[0];
  const shared = registry.filter((migration) => migration.version <= LEGACY_MAIN_112_SOURCE_VERSION - 1);
  if (shared.length === 0 || shared[shared.length - 1].version > LEGACY_MAIN_112_SOURCE_VERSION - 1) {
    throw new Error('Invalid SaaS migration registry');
  }
  const legacySource: SaasCompatManifestEntry[] = [
    ...shared.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: compatMigrationChecksum(migration),
    })),
    {
      version: LEGACY_MAIN_112_SOURCE_VERSION,
      name: LEGACY_MAIN_112_MIGRATION_NAME,
      checksum: LEGACY_MAIN_112_MIGRATION_CHECKSUM,
    },
  ];
  const target = registry
    .filter((migration) => migration.version <= LEGACY_MAIN_112_TARGET_VERSION)
    .map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: compatMigrationChecksum(migration),
    }));
  const pendingNormal = registry.filter((migration) => migration.version > LEGACY_MAIN_112_TARGET_VERSION);
  return { registry, shared, legacySource, target, identityTarget, pendingNormal };
}

/**
 * The expectations digest of the derived legacy source manifest — the
 * migrationsChecksum a reviewed source catalog baseline must carry.
 */
export function getLegacyMain112SourceManifestChecksum(migrations: readonly SaasMigration[] = SAAS_MIGRATIONS): string {
  const manifests = getLegacyMain112Manifests(migrations);
  // The old-112 SQL is byte-identical to the identity target's SQL, so the
  // re-versioned migration produces the same ledger checksum.
  const legacyRegistry: SaasMigration[] = [
    ...manifests.shared,
    {
      version: LEGACY_MAIN_112_SOURCE_VERSION,
      name: manifests.identityTarget.name,
      sql: manifests.identityTarget.sql,
    },
  ];
  return getSaasMigrationAuditExpectations(legacyRegistry).checksum;
}

// ---------------------------------------------------------------------------
// Ledger state classification
// ---------------------------------------------------------------------------

interface PrefixMatch {
  status: 'exact' | 'prefix' | 'mismatch' | 'longer';
  matched: number;
  mismatch?: {
    index: number;
    ledger: SaasCompatLedgerRow;
    expected: SaasCompatManifestEntry;
    reason: 'version' | 'name' | 'checksum';
  };
}

function matchLedgerPrefix(
  rows: readonly SaasCompatLedgerRow[],
  manifest: readonly SaasCompatManifestEntry[],
): PrefixMatch {
  let index = 0;
  for (; index < rows.length && index < manifest.length; index += 1) {
    const row = rows[index];
    const expected = manifest[index];
    if (row.version !== expected.version) {
      return { status: 'mismatch', matched: index, mismatch: { index, ledger: row, expected, reason: 'version' } };
    }
    if (row.name !== expected.name) {
      return { status: 'mismatch', matched: index, mismatch: { index, ledger: row, expected, reason: 'name' } };
    }
    if (row.checksum !== expected.checksum) {
      return { status: 'mismatch', matched: index, mismatch: { index, ledger: row, expected, reason: 'checksum' } };
    }
  }
  if (rows.length === manifest.length) return { status: 'exact', matched: index };
  if (rows.length > manifest.length) return { status: 'longer', matched: index };
  return { status: 'prefix', matched: index };
}

/**
 * Classifies an applied ledger against the release registry precisely —
 * never on the head version alone. Pure; unit-tested exhaustively.
 */
export function classifyLegacyMain112Ledger(
  rows: readonly SaasCompatLedgerRow[],
  migrations: readonly SaasMigration[] = SAAS_MIGRATIONS,
): SaasCompatLedgerClassification {
  const manifests = getLegacyMain112Manifests(migrations);
  const base = {
    appliedCount: rows.length,
    head: rows.length === 0 ? 0 : rows[rows.length - 1].version,
  };
  const legacyMatch = matchLedgerPrefix(rows, manifests.legacySource);
  if (legacyMatch.status === 'exact') {
    return {
      ...base,
      kind: 'legacy-112-source',
      detail:
        `complete legacy source state: shared 001..${manifests.shared[manifests.shared.length - 1].version} prefix plus the old-main 112 ` +
        `${LEGACY_MAIN_112_MIGRATION_NAME} identity; the legacy-main-112-to-129 compat plan applies`,
    };
  }
  const targetMatch = matchLedgerPrefix(rows, manifests.target);
  if (targetMatch.status === 'exact') {
    return {
      ...base,
      kind: 'current-chain-complete',
      detail: `complete target state: the ledger matches this release registry through version ${LEGACY_MAIN_112_TARGET_VERSION}; the compat plan is an idempotent no-op`,
    };
  }
  if (targetMatch.status === 'prefix') {
    if (rows.length <= manifests.shared.length) {
      return {
        ...base,
        kind: 'clean-prefix',
        detail: `clean registry prefix (${rows.length} applied, head ${base.head}); this is not a legacy-main-112 fork — complete it with the normal saas:migrate`,
      };
    }
    return {
      ...base,
      kind: 'current-chain-partial',
      detail: `partial current chain (${rows.length} applied, head ${base.head}); complete it with the normal saas:migrate — the compat plan only matches the complete source or complete target state`,
    };
  }
  if (
    (targetMatch.mismatch?.reason === 'checksum' && targetMatch.mismatch.index < manifests.target.length) ||
    legacyMatch.mismatch?.reason === 'checksum'
  ) {
    const mismatch = targetMatch.mismatch ?? legacyMatch.mismatch;
    return {
      ...base,
      kind: 'drifted-checksum',
      detail: `applied migration at ledger position ${mismatch ? mismatch.index + 1 : '?'} (version ${mismatch?.ledger.version ?? '?'}) does not carry the expected checksum; refusing — locate the drift with saas:migration-audit before any upgrade`,
      firstMismatch: mismatch,
    };
  }
  return {
    ...base,
    kind: 'unknown-history',
    detail:
      `the applied history is neither the legacy source state nor a clean prefix of this release registry` +
      (targetMatch.mismatch
        ? ` (first mismatch at position ${targetMatch.mismatch.index + 1}: expected version ${targetMatch.mismatch.expected.version}, found version ${targetMatch.mismatch.ledger.version} / ${targetMatch.mismatch.reason} mismatch)`
        : ''),
    firstMismatch: targetMatch.status === 'mismatch' ? targetMatch.mismatch : undefined,
  };
}

// ---------------------------------------------------------------------------
// Catalog snapshot (in-transaction schema verification)
// ---------------------------------------------------------------------------

interface CompatCatalogSnapshot {
  objects: SaasAuditCatalogObject[];
  /** Raw (unhashed) identity texts keyed by kind for the derived-name checks. */
  rawIdentities: Map<string, string[]>;
  unsupportedFeatures: string[];
  checksum: string;
}

const catalogKinds = new Set(['relation', 'column', 'constraint', 'index', 'trigger', 'routine', 'view', 'sequence']);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * Runs the same read-only catalog inventory SQL as the migration audit
 * (pg_catalog-only, fixed search_path expectations, no business data) inside
 * the caller's transaction. Raw identities never leave this module.
 */
async function snapshotCompatCatalog(client: SaasDatabaseClient, schema: string): Promise<CompatCatalogSnapshot> {
  // The audit fixes search_path TO pg_catalog for stable, non-shadowable
  // deparsing (regclass literals and function references in defaults,
  // index/constraint/trigger definitions would otherwise qualify differently
  // under the migrator login's application search_path). The same policy is
  // required here so snapshots compare equal with reviewed baselines.
  await client.query('SET search_path TO pg_catalog');
  let result: { rows: Array<{ kind?: unknown; identity?: unknown; definition?: unknown }> };
  try {
    result = await client.query<{ kind?: unknown; identity?: unknown; definition?: unknown }>(
      SAAS_MIGRATION_AUDIT_CATALOG_SQL,
      [schema],
    );
  } finally {
    try {
      await client.query('RESET search_path');
    } catch {
      // The transaction aborted (the snapshot query failed); the ROLLBACK in
      // the caller's error path restores the session search_path anyway.
    }
  }
  const objects: SaasAuditCatalogObject[] = [];
  const rawIdentities = new Map<string, string[]>();
  const unsupportedFeatures: string[] = [];
  let invalid = false;
  for (const row of result.rows) {
    if (row?.kind === 'unsupported') {
      const feature = typeof row.identity === 'string' ? row.identity : 'unknown';
      if (!unsupportedFeatures.includes(feature)) unsupportedFeatures.push(feature);
      continue;
    }
    if (
      !row ||
      typeof row.kind !== 'string' ||
      !catalogKinds.has(row.kind) ||
      typeof row.identity !== 'string' ||
      !row.identity ||
      typeof row.definition !== 'string' ||
      !row.definition
    ) {
      invalid = true;
      continue;
    }
    objects.push({
      kind: row.kind as SaasAuditCatalogObject['kind'],
      identityChecksum: digest(row.identity),
      definitionChecksum: digest(row.definition),
    });
    const list = rawIdentities.get(row.kind) ?? [];
    list.push(row.identity);
    rawIdentities.set(row.kind, list);
  }
  if (invalid || objects.length === 0 || unsupportedFeatures.length > 0) {
    throw new Error('Invalid SaaS compat catalog snapshot');
  }
  return { objects, rawIdentities, unsupportedFeatures, checksum: getSaasAuditCatalogChecksum(objects) };
}

/** Strict baseline comparison: every baseline object present and identical, no unknown extras. */
function compareCatalogToBaseline(
  snapshot: CompatCatalogSnapshot,
  baseline: SaasAuditCatalogBaseline,
): { ok: boolean; missing: string[]; drifted: string[]; unknown: string[] } {
  const actualByKey = new Map(snapshot.objects.map((object) => [`${object.kind}:${object.identityChecksum}`, object]));
  const missing: string[] = [];
  const drifted: string[] = [];
  for (const expected of baseline.objects) {
    const actual = actualByKey.get(`${expected.kind}:${expected.identityChecksum}`);
    if (!actual) missing.push(`${expected.kind}:${expected.identityChecksum.slice(0, 12)}`);
    else if (actual.definitionChecksum !== expected.definitionChecksum)
      drifted.push(`${expected.kind}:${expected.identityChecksum.slice(0, 12)}`);
    actualByKey.delete(`${expected.kind}:${expected.identityChecksum}`);
  }
  const unknown = [...actualByKey.keys()];
  return { ok: missing.length === 0 && drifted.length === 0 && unknown.length === 0, missing, drifted, unknown };
}

// ---------------------------------------------------------------------------
// Derived catalog-name verification (step 5: key catalog constraints)
// ---------------------------------------------------------------------------

const CREATE_NAME_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'relation', pattern: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_.]+)/gi },
  {
    kind: 'index',
    pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_.]+)/gi,
  },
  { kind: 'trigger', pattern: /\bCREATE\s+TRIGGER\s+([a-z0-9_]+)/gi },
  { kind: 'constraint', pattern: /\bADD\s+CONSTRAINT\s+([a-z0-9_]+)/gi },
  { kind: 'constraint', pattern: /\bCONSTRAINT\s+([a-z0-9_]+)/gi },
  { kind: 'routine', pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z0-9_.]+)/gi },
];

const DROP_NAME_PATTERNS: ReadonlyArray<{ pattern: RegExp }> = [
  { pattern: /\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([a-z0-9_]+)/gi },
  { pattern: /\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([a-z0-9_.]+)/gi },
  { pattern: /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z0-9_.]+)/gi },
  { pattern: /\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?([a-z0-9_]+)/gi },
];

const SAFE_NAME = /^[a-z0-9_]+$/;

function baseName(name: string): string {
  const lastDot = name.lastIndexOf('.');
  return lastDot >= 0 ? name.slice(lastDot + 1) : name;
}

function collectMatches(
  sql: string,
  patterns: ReadonlyArray<{ kind?: string; pattern: RegExp }>,
): Array<{ kind: string; name: string }> {
  const found: Array<{ kind: string; name: string }> = [];
  for (const { kind, pattern } of patterns) {
    pattern.lastIndex = 0;
    for (const match of sql.matchAll(pattern)) {
      const name = baseName(match[1]);
      if (SAFE_NAME.test(name)) found.push({ kind: kind ?? 'any', name });
    }
  }
  return found;
}

/**
 * Names the migration's DDL must materialize (CREATE/ADD) and names it must
 * remove (DROP). Derived from our own trusted registry SQL; conservative
 * (single lowercase identifiers only).
 */
export function extractCatalogNames(sql: string): {
  created: Array<{ kind: string; name: string }>;
  dropped: string[];
} {
  const created = collectMatches(sql, CREATE_NAME_PATTERNS);
  const dropped = collectMatches(sql, DROP_NAME_PATTERNS).map((entry) => entry.name);
  return { created, dropped: [...new Set(dropped)] };
}

/**
 * PostgreSQL truncates identifiers to 63 bytes (NAMEDATALEN-1); several
 * registered constraint names are longer, so the stored name is the
 * truncated prefix of the name our SQL text spells out.
 */
function storedIdentifier(name: string): string {
  return name.length > 63 ? name.slice(0, 63) : name;
}

function verifyDerivedCatalogNames(
  snapshot: CompatCatalogSnapshot,
  migrations: readonly SaasMigration[],
): { verified: number; problems: string[] } {
  const problems: string[] = [];
  let verified = 0;
  for (const migration of migrations) {
    const { created, dropped } = extractCatalogNames(migration.sql);
    const readded = new Set(created.map((entry) => storedIdentifier(entry.name)));
    for (const entry of created) {
      const stored = storedIdentifier(entry.name);
      const raws = snapshot.rawIdentities.get(entry.kind) ?? [];
      if (!raws.some((raw) => raw.includes(`"${stored}"`))) {
        problems.push(
          `migration ${migration.version}: expected ${entry.kind} "${entry.name}" is absent from the post-apply catalog`,
        );
      } else {
        verified += 1;
      }
    }
    for (const name of dropped) {
      const stored = storedIdentifier(name);
      if (readded.has(stored)) continue;
      const stillPresent = [...snapshot.rawIdentities.values()].some((raws) =>
        raws.some((raw) => raw.includes(`"${stored}"`)),
      );
      if (stillPresent) {
        problems.push(`migration ${migration.version}: dropped object "${name}" is still present after the upgrade`);
      }
    }
  }
  return { verified, problems };
}

// ---------------------------------------------------------------------------
// Data preservation probes (step 5: balances, reservations, record counts)
// ---------------------------------------------------------------------------

/** Relations that must exist in the legacy source schema; row counts must not move. */
const PRESERVATION_COUNT_TABLES: readonly string[] = [
  'saas_tenants',
  'saas_projects',
  'saas_wallets',
  'saas_ledger_transactions',
  'saas_ledger_entries',
  'saas_billing_reservations',
  'saas_billing_spending_freezes',
  'saas_tenant_provider_accounts',
  'saas_tenant_provider_credentials',
  'saas_tenant_provider_credential_versions',
  'saas_platform_provider_credentials',
  'saas_platform_provider_credential_versions',
  'saas_provider_account_runtime_health',
  'saas_probe_monitors',
];

const PRESERVATION_COUNTS_SQL = `SELECT table_name, rows::text AS rows FROM (
  ${PRESERVATION_COUNT_TABLES.map((table) => `SELECT '${table}' AS table_name, count(*) AS rows FROM ${table}`).join('\n  UNION ALL\n  ')}
) AS compat_data_preservation_counts`;

const PRESERVATION_SUMMARIES_SQL = `SELECT
  (SELECT coalesce(sum(posted_balance_minor_units), 0)::text FROM saas_wallets) AS wallets_posted_balance_sum,
  (SELECT count(*)::text FROM saas_billing_reservations WHERE state = 'reserved') AS reservations_reserved_count,
  (SELECT coalesce(sum(amount_minor_units), 0)::text FROM saas_billing_reservations WHERE state = 'reserved') AS reservations_reserved_sum,
  (SELECT coalesce(sum(amount_minor_units), 0)::text FROM saas_ledger_entries) AS ledger_entries_amount_sum,
  (SELECT count(*)::text FROM saas_tenant_provider_credential_versions) AS tenant_credential_versions_count,
  (SELECT coalesce(sum(pg_catalog.hashtext(wrapped_dek || ':' || nonce || ':' || ciphertext || ':' || auth_tag)), 0)::text FROM saas_tenant_provider_credential_versions) AS tenant_credential_envelope_hash_sum,
  (SELECT count(*)::text FROM saas_platform_provider_credential_versions) AS platform_credential_versions_count,
  (SELECT coalesce(sum(pg_catalog.hashtext(wrapped_dek || ':' || nonce || ':' || ciphertext || ':' || auth_tag)), 0)::text FROM saas_platform_provider_credential_versions) AS platform_credential_envelope_hash_sum`;

async function captureDataPreservation(client: SaasDatabaseClient): Promise<Map<string, string>> {
  const captured = new Map<string, string>();
  const counts = await client.query<{ table_name?: unknown; rows?: unknown }>(PRESERVATION_COUNTS_SQL);
  for (const row of counts.rows) {
    if (typeof row?.table_name !== 'string' || typeof row?.rows !== 'string')
      throw new Error('Invalid preservation counts');
    captured.set(`count:${row.table_name}`, row.rows);
  }
  const summaries = await client.query<Record<string, unknown>>(PRESERVATION_SUMMARIES_SQL);
  const summary = summaries.rows[0];
  if (!summary) throw new Error('Invalid preservation summaries');
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value !== 'string') throw new Error('Invalid preservation summaries');
    captured.set(`summary:${key}`, value);
  }
  return captured;
}

// ---------------------------------------------------------------------------
// Non-transactional statement guard (the plan must be one atomic transaction)
// ---------------------------------------------------------------------------

const NON_TRANSACTIONAL_SQL =
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b|\bDROP\s+INDEX\s+CONCURRENTLY\b|\bREINDEX\b|\bVACUUM\b|\bANALYZE\b|\bCREATE\s+DATABASE\b|\bDROP\s+DATABASE\b|\bALTER\s+SYSTEM\b|\bCLUSTER\b/i;

function assertCompatMigrationsTransactional(migrations: readonly SaasMigration[]): void {
  for (const migration of migrations) {
    if (NON_TRANSACTIONAL_SQL.test(migration.sql)) {
      throw new Error(
        `Migration ${migration.version} contains statements that cannot run inside the compat transaction`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Plan execution
// ---------------------------------------------------------------------------

interface LedgerQueryRow {
  version?: unknown;
  name?: unknown;
  checksum?: unknown;
}

async function readLedger(client: SaasDatabaseClient): Promise<SaasCompatLedgerRow[]> {
  const result = await client.query<LedgerQueryRow>(
    'SELECT version, name, checksum FROM saas_schema_migrations ORDER BY version ASC',
  );
  const rows: SaasCompatLedgerRow[] = [];
  const seenVersions = new Set<number>();
  const seenNames = new Set<string>();
  for (const raw of result.rows) {
    const version = typeof raw?.version === 'number' ? raw.version : Number(raw?.version);
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      typeof raw?.name !== 'string' ||
      typeof raw?.checksum !== 'string' ||
      !HASH.test(raw.checksum) ||
      seenVersions.has(version) ||
      seenNames.has(raw.name)
    ) {
      throw new Error('Invalid SaaS migration history');
    }
    seenVersions.add(version);
    seenNames.add(raw.name);
    rows.push({ version, name: raw.name, checksum: raw.checksum });
  }
  return rows;
}

export class LegacyMain112CompatError extends Error {
  constructor(
    readonly code: LegacyMain112CompatIssueCode,
    message: string,
  ) {
    super(message);
    this.name = 'LegacyMain112CompatError';
  }
}

/** An internal read-only-phase refusal; the runner releases the client and reports it. */
class CompatRefusal extends Error {
  constructor(
    readonly code: LegacyMain112CompatIssueCode,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/**
 * Runs the compat plan against one database. Steps 3–5 of the plan execute
 * inside a single transaction under the SAME advisory lock class/id the
 * normal migrator takes; any failure rolls back and the ledger is left in
 * its complete source (or complete target) state.
 */
export async function runLegacyMain112CompatPlan(
  pool: SaasDatabasePool,
  options: LegacyMain112PlanOptions,
): Promise<LegacyMain112CompatPlanOutcome> {
  const outcome: LegacyMain112CompatPlanOutcome = {
    plan: LEGACY_MAIN_112_COMPAT_PLAN_ID,
    status: 'failed',
    classification: null,
    postgresMajor: null,
    sourceMigrationsChecksum: null,
    targetMigrationsChecksum: null,
    catalogBaselineEvidenceId: options.catalogBaseline?.evidenceId ?? null,
    catalogVerified: false,
    move: null,
    applied: [],
    pendingNormalMigrations: [],
    verification: null,
    issues: [],
  };
  // fail() is only used on the pre-lock refusal paths; failures inside the
  // guarded write phase throw LegacyMain112CompatError and roll back instead.
  const fail = (code: LegacyMain112CompatIssueCode, detail: string): LegacyMain112CompatPlanOutcome => {
    outcome.status = 'refused';
    outcome.issues.push({ code, detail });
    return outcome;
  };

  if (
    !options ||
    typeof options.schema !== 'string' ||
    !IDENTIFIER.test(options.schema) ||
    ['pg_catalog', 'information_schema', 'pg_temp', 'pg_toast'].includes(options.schema) ||
    options.schema.startsWith('pg_') ||
    typeof options.releaseId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.releaseId) ||
    !pool ||
    typeof pool.connect !== 'function'
  ) {
    return fail('INVALID_INPUT', 'invalid compat plan options');
  }

  let manifests: LegacyMain112Manifests;
  try {
    manifests = getLegacyMain112Manifests(options.migrations ?? SAAS_MIGRATIONS);
  } catch (error) {
    return fail(
      error instanceof Error && error.message.includes('identity') ? 'IDENTITY_TARGET_MISSING' : 'INVALID_REGISTRY',
      'the release registry does not carry the known legacy-main-112 identity at version 129; the compat plan does not apply',
    );
  }
  const baseline = options.catalogBaseline;
  if (baseline !== undefined) {
    if (!isSaasAuditCatalogBaseline(baseline)) return fail('INVALID_INPUT', 'invalid source catalog baseline');
    const sourceChecksum = getLegacyMain112SourceManifestChecksum(options.migrations ?? SAAS_MIGRATIONS);
    if (
      baseline.migrationsChecksum !== sourceChecksum ||
      baseline.schema !== options.schema ||
      baseline.releaseId !== options.releaseId ||
      baseline.coverage !== 'complete-profile'
    ) {
      return fail(
        'BASELINE_MISMATCH',
        'the source catalog baseline is not bound to this release, schema, and legacy source manifest',
      );
    }
  }
  // After the move the ledger holds 001..111 + the moved 129; the pending
  // compat migrations are exactly the current registry's 112..128.
  const pendingCompat = manifests.registry.filter(
    (migration) =>
      migration.version >= LEGACY_MAIN_112_SOURCE_VERSION && migration.version < LEGACY_MAIN_112_TARGET_VERSION,
  );
  try {
    assertCompatMigrationsTransactional(pendingCompat);
  } catch {
    return fail('INVALID_REGISTRY', 'a pending target migration cannot run inside the compat transaction');
  }
  outcome.sourceMigrationsChecksum = getLegacyMain112SourceManifestChecksum(options.migrations ?? SAAS_MIGRATIONS);
  outcome.targetMigrationsChecksum = getSaasMigrationAuditExpectations(
    manifests.registry.filter((migration) => migration.version <= LEGACY_MAIN_112_TARGET_VERSION),
  ).checksum;
  outcome.pendingNormalMigrations = manifests.pendingNormal.map((migration) => ({
    version: migration.version,
    name: migration.name,
    checksum: compatMigrationChecksum(migration),
  }));

  let client: SaasDatabaseClient;
  try {
    client = await pool.connect();
  } catch {
    return fail('LEDGER_READ_FAILED', 'unable to connect to the SaaS database');
  }
  let discardClient = false;

  const finish = (): LegacyMain112CompatPlanOutcome => {
    client.release(discardClient);
    return outcome;
  };

  try {
    // ---------- step 1: read-only dry-run verification ----------
    // Refusals throw CompatRefusal so the client is ALWAYS released; a leaked
    // checked-out client would hang the caller's pool teardown.
    const serverResult = await client.query<{ server_version_num?: unknown }>(
      "SELECT current_setting('server_version_num') AS server_version_num",
    );
    const serverVersionNum = Number(serverResult.rows[0]?.server_version_num);
    if (!Number.isSafeInteger(serverVersionNum) || serverVersionNum < 1) {
      throw new CompatRefusal('UNSUPPORTED_POSTGRES', 'unable to read the PostgreSQL server version');
    }
    outcome.postgresMajor = Math.floor(serverVersionNum / 10_000);
    if (outcome.postgresMajor < 15) {
      throw new CompatRefusal(
        'UNSUPPORTED_POSTGRES',
        `PostgreSQL 15 or later is required (major ${outcome.postgresMajor})`,
      );
    }
    if (baseline && baseline.postgresMajor !== outcome.postgresMajor) {
      throw new CompatRefusal(
        'BASELINE_MISMATCH',
        'the source catalog baseline was reviewed on a different PostgreSQL major',
      );
    }

    let rows: SaasCompatLedgerRow[];
    try {
      rows = await readLedger(client);
    } catch {
      throw new CompatRefusal(
        'LEDGER_READ_FAILED',
        'unable to read the SaaS migration ledger (a fresh database must use the normal saas:migrate first)',
      );
    }
    const classification = classifyLegacyMain112Ledger(rows, options.migrations ?? SAAS_MIGRATIONS);
    outcome.classification = classification;

    if (classification.kind === 'current-chain-complete') {
      outcome.status = 'already-current';
      outcome.verification = { targetHistoryVerified: true, catalogConstraintsVerified: 0, dataPreservation: [] };
      return finish();
    }
    if (classification.kind !== 'legacy-112-source') {
      const code =
        classification.kind === 'drifted-checksum'
          ? 'STATE_DRIFTED'
          : classification.kind === 'unknown-history'
            ? 'STATE_UNKNOWN'
            : 'STATE_NOT_APPLICABLE';
      throw new CompatRefusal(code, classification.detail);
    }
    if (options.dryRun === true) {
      // Catalog verification (when a reviewed baseline is supplied) is part
      // of the dry-run evidence; it is re-verified inside the transaction.
      if (baseline) {
        let snapshot: CompatCatalogSnapshot;
        try {
          snapshot = await snapshotCompatCatalog(client, options.schema);
        } catch {
          throw new CompatRefusal('CATALOG_SNAPSHOT_FAILED', 'unable to snapshot the source catalog');
        }
        const comparison = compareCatalogToBaseline(snapshot, baseline);
        if (!comparison.ok) {
          throw new CompatRefusal(
            'BASELINE_MISMATCH',
            `the source catalog does not match the reviewed baseline (missing ${comparison.missing.length}, drifted ${comparison.drifted.length}, unknown ${comparison.unknown.length})`,
          );
        }
        outcome.catalogVerified = true;
      }
      outcome.status = 'dry-run';
      return finish();
    }

    // ---------- steps 3–5: lock, transaction, move + apply + verify ----------
    try {
      await client.query('SELECT pg_advisory_lock($1, $2)', [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_ID]);
    } catch {
      discardClient = true;
      outcome.status = 'failed';
      outcome.issues.push({ code: 'LOCK_FAILED', detail: 'unable to acquire the SaaS migration advisory lock' });
      return finish();
    }
    let lockHeld = true;
    let began = false;
    try {
      await options.onPhase?.('after-lock');
      await client.query('BEGIN');
      began = true;

      // Re-verify the source fingerprints inside the transaction (never just head=112).
      const inTransactionRows = await readLedger(client);
      const inTransactionClassification = classifyLegacyMain112Ledger(
        inTransactionRows,
        options.migrations ?? SAAS_MIGRATIONS,
      );
      if (inTransactionClassification.kind !== 'legacy-112-source') {
        throw new LegacyMain112CompatError(
          'REVERIFY_FAILED',
          `the ledger changed under the lock (${inTransactionClassification.kind}); rolling back — re-run the compat plan after reconciling`,
        );
      }

      // Re-verify the actual schema against the reviewed baseline.
      let sourceSnapshot: CompatCatalogSnapshot;
      try {
        sourceSnapshot = await snapshotCompatCatalog(client, options.schema);
      } catch {
        throw new LegacyMain112CompatError(
          'CATALOG_SNAPSHOT_FAILED',
          'unable to snapshot the source catalog inside the transaction',
        );
      }
      if (baseline) {
        const comparison = compareCatalogToBaseline(sourceSnapshot, baseline);
        if (!comparison.ok) {
          throw new LegacyMain112CompatError(
            'BASELINE_MISMATCH',
            `the source schema drifted from the reviewed baseline (missing ${comparison.missing.length}, drifted ${comparison.drifted.length}, unknown ${comparison.unknown.length})`,
          );
        }
      }
      const before = await captureDataPreservation(client);
      await options.onPhase?.('after-reverify');

      // The one known-identity ledger move, keyed on exact name AND checksum.
      const moveResult = await client.query(
        'UPDATE saas_schema_migrations SET version = $1 WHERE version = $2 AND name = $3 AND checksum = $4',
        [
          LEGACY_MAIN_112_TARGET_VERSION,
          LEGACY_MAIN_112_SOURCE_VERSION,
          LEGACY_MAIN_112_MIGRATION_NAME,
          LEGACY_MAIN_112_MIGRATION_CHECKSUM,
        ],
      );
      if (moveResult.rowCount !== 1) {
        throw new LegacyMain112CompatError(
          'MOVE_FAILED',
          'the old-main 112 ledger row did not match the known identity exactly; refusing to rewrite anything',
        );
      }
      outcome.move = {
        fromVersion: LEGACY_MAIN_112_SOURCE_VERSION,
        toVersion: LEGACY_MAIN_112_TARGET_VERSION,
        name: LEGACY_MAIN_112_MIGRATION_NAME,
        checksum: LEGACY_MAIN_112_MIGRATION_CHECKSUM,
      };
      await options.onPhase?.('after-move');

      // Apply the not-yet-applied target migrations, registering original identities.
      const appliedEntries: SaasCompatManifestEntry[] = [];
      for (const migration of pendingCompat) {
        await client.query(migration.sql);
        await client.query('INSERT INTO saas_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          migration.version,
          migration.name,
          compatMigrationChecksum(migration),
        ]);
        appliedEntries.push({
          version: migration.version,
          name: migration.name,
          checksum: compatMigrationChecksum(migration),
        });
        await options.onPhase?.(`after-apply:${migration.version}`);
      }
      outcome.applied = appliedEntries;
      await options.onPhase?.('after-apply');

      // Same-transaction verification: full target history, key catalog
      // constraints, data preservation.
      const finalRows = await readLedger(client);
      const finalMatch = matchLedgerPrefix(finalRows, manifests.target);
      if (finalMatch.status !== 'exact' || finalRows.length !== manifests.target.length) {
        throw new LegacyMain112CompatError(
          'VERIFY_FAILED',
          'the post-apply ledger does not equal the complete target history',
        );
      }
      let postSnapshot: CompatCatalogSnapshot;
      try {
        postSnapshot = await snapshotCompatCatalog(client, options.schema);
      } catch {
        throw new LegacyMain112CompatError('CATALOG_SNAPSHOT_FAILED', 'unable to snapshot the post-apply catalog');
      }
      const derivedCheck = verifyDerivedCatalogNames(postSnapshot, [...pendingCompat, manifests.identityTarget]);
      if (derivedCheck.problems.length > 0) {
        throw new LegacyMain112CompatError(
          'VERIFY_FAILED',
          `key catalog verification failed: ${derivedCheck.problems.slice(0, 5).join('; ')}`,
        );
      }
      const after = await captureDataPreservation(client);
      const preservation: LegacyMain112DataPreservationProbe[] = [];
      for (const [probe, beforeValue] of before) {
        const afterValue = after.get(probe);
        if (afterValue === undefined || afterValue !== beforeValue) {
          throw new LegacyMain112CompatError(
            'VERIFY_FAILED',
            `data preservation probe "${probe}" changed during the upgrade`,
          );
        }
        preservation.push({ probe, before: beforeValue, after: afterValue });
      }
      outcome.verification = {
        targetHistoryVerified: true,
        catalogConstraintsVerified: derivedCheck.verified,
        dataPreservation: preservation,
      };
      await options.onPhase?.('after-verify');

      await client.query('COMMIT');
      began = false;
      await options.onPhase?.('after-commit');
      outcome.status = 'applied';
      if (baseline) outcome.catalogVerified = true;
    } catch (error) {
      const code = error instanceof LegacyMain112CompatError ? error.code : 'APPLY_FAILED';
      if (began) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discardClient = true;
          outcome.issues.push({
            code: 'ROLLBACK_FAILED',
            detail: 'the compat transaction rollback itself failed; the client is discarded',
          });
        }
      }
      outcome.issues.push({
        code,
        detail:
          error instanceof Error
            ? error.message
            : 'the compat plan failed; the transaction rolled back and the ledger keeps its previous complete state',
      });
      outcome.status = 'failed';
    } finally {
      if (lockHeld) {
        lockHeld = false;
        try {
          const unlock = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1, $2) AS unlocked', [
            MIGRATION_LOCK_CLASS,
            MIGRATION_LOCK_ID,
          ]);
          if (unlock.rows[0]?.unlocked !== true) {
            outcome.issues.push({
              code: 'UNLOCK_FAILED',
              detail: 'failed to release the SaaS migration advisory lock',
            });
            discardClient = true;
          }
        } catch {
          outcome.issues.push({ code: 'UNLOCK_FAILED', detail: 'failed to release the SaaS migration advisory lock' });
          discardClient = true;
        }
      }
    }
    return finish();
  } catch (error) {
    if (error instanceof CompatRefusal) {
      // A read-only-phase refusal: no writes were made; release the client.
      outcome.status = 'refused';
      outcome.issues.push({ code: error.code, detail: error.detail });
      return finish();
    }
    // Any unexpected failure outside the guarded phases (e.g. reading the
    // server version) is a failure, never a partial write.
    if (outcome.issues.length === 0) {
      outcome.issues.push({ code: 'APPLY_FAILED', detail: 'unexpected compat plan failure; no writes were made' });
    }
    outcome.status = 'failed';
    return finish();
  }
}
