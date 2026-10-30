import { createHash, randomUUID } from 'node:crypto';
import { ControlError } from '../control/service.js';
import type { ControlStore } from '../control/store.js';
import { validatePricing } from './pricing.js';

/**
 * Batch import of model pricing profiles (plan O1: remote price-table import).
 *
 * Maps external price documents onto the existing admin pricing schema
 * (src/admin/pricing.ts — no new schema fields) and persists them through the
 * same ControlStore tables the admin console pricing handlers use
 * (pricing / pricing_versions / pricing_version_sequence plus audit events).
 * There is no second storage. Rows are validated and stored one by one; a
 * failing row never rolls back or blocks the rows around it.
 */

/** Typed rejection for documents that match no supported source shape. */
export class PricingImportShapeError extends Error {
  constructor(
    message: string,
    readonly sample: string,
  ) {
    super(message);
    this.name = 'PricingImportShapeError';
  }
}

export interface PricingImportOptions {
  /**
   * Relabels the currency code of every imported row WITHOUT converting
   * amounts. Currency conversion (fixed FX rates or live rates) is
   * intentionally out of scope: source numbers always enter the pricing
   * store exactly as published, only the ISO code label changes.
   */
  currencyOverride?: string;
  /** Provider label applied to rows that do not carry one. */
  defaultProvider?: string;
  /** upstreamId applied to rows that do not carry one. */
  defaultUpstreamId?: string;
  /** Validate every row and report the outcome without writing anything. */
  dryRun?: boolean;
  /** Audit actor recorded with each pricing.update / pricing.import event. */
  actor?: string;
}

export interface PricingImportRowFailure {
  model: string;
  reason: string;
}

export interface PricingImportResult {
  imported: number;
  skipped: number;
  failed: PricingImportRowFailure[];
  /** Per-row detail for skipped rows (length matches `skipped`). */
  skippedRows: PricingImportRowFailure[];
  dryRun: boolean;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fieldOf = (profile: object, field: string): unknown => (profile as Record<string, unknown>)[field];

/** Private per-row marker so mapping problems become row-level failures. */
class RowError extends Error {}

const offendingSample = (value: unknown): string => {
  try {
    return JSON.stringify(value)?.slice(0, 400) ?? 'null';
  } catch {
    return '<unserializable entry>';
  }
};

type SourceShape = 'models-dev' | 'local';

/**
 * Shape detection. models.dev-style entries carry `model_id` + `pricing`;
 * local entries match the admin pricing schema (`model` + per-million fields).
 * Mixed or unrecognised documents are rejected up front with a sample.
 */
function detectShape(document: unknown): SourceShape {
  if (!Array.isArray(document) || document.length === 0)
    throw new PricingImportShapeError(
      'Pricing document must be a non-empty array of model price entries',
      offendingSample(document),
    );
  const rows = document as unknown[];
  const firstNonObject = rows.find((row) => !isObject(row));
  if (firstNonObject !== undefined)
    throw new PricingImportShapeError('Pricing document entries must be JSON objects', offendingSample(firstNonObject));
  const objectRows = rows as Json[];
  const modelsDevMarker = objectRows.some((row) => isObject(row.pricing) || typeof row.model_id === 'string');
  const localMarker = objectRows.some((row) => typeof row.model === 'string');
  if (modelsDevMarker && !localMarker) return 'models-dev';
  if (localMarker && !modelsDevMarker) return 'local';
  throw new PricingImportShapeError(
    'Pricing document shape is not recognized; expected models.dev-style entries ({ model_id, pricing }) or local pricing profiles ({ model, inputPerMillion, ... })',
    offendingSample(objectRows[0]),
  );
}

/** Source pricing key -> local schema field. */
const RATE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['input', 'inputPerMillion'],
  ['output', 'outputPerMillion'],
  ['cache_read', 'cacheReadPerMillion'],
  // models.dev reports cache writes without TTL classification, so the plain
  // cache_write rate maps to the legacy aggregate field. Explicit TTL keys map
  // to the tiered 5m/1h fields when a source provides them.
  ['cache_write', 'cacheWritePerMillion'],
  ['cache_write_5m', 'cacheWrite5mPerMillion'],
  ['cache_write_1h', 'cacheWrite1hPerMillion'],
];

interface MappedRow {
  model: string;
  submitted: Json;
  explicitEffectiveFrom: boolean;
}

function mapModelsDevRow(row: Json, options: PricingImportOptions): MappedRow {
  const model = row.model_id;
  if (typeof model !== 'string' || model.trim() === '') throw new RowError('entry is missing a non-empty model_id');
  const pricing = row.pricing;
  if (!isObject(pricing)) throw new RowError('entry is missing a pricing object');
  const submitted: Json = { model };
  for (const [sourceKey, field] of RATE_KEYS) {
    const value = pricing[sourceKey];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' && typeof value !== 'string')
      throw new RowError(`pricing.${sourceKey} must be a number or numeric string`);
    submitted[field] = value;
  }
  // models.dev publishes USD-denominated per-token rates. currencyOverride
  // relabels the currency code only; amounts are never converted (see
  // PricingImportOptions.currencyOverride).
  submitted.currency = options.currencyOverride ?? 'USD';
  if (typeof row.id === 'string' && row.id !== '') submitted.id = row.id;
  const provider = typeof row.provider === 'string' && row.provider !== '' ? row.provider : options.defaultProvider;
  if (provider) submitted.provider = provider;
  if (options.defaultUpstreamId) submitted.upstreamId = options.defaultUpstreamId;
  const effectiveFrom = row.effectiveFrom;
  if (typeof effectiveFrom === 'string' && effectiveFrom !== '') submitted.effectiveFrom = effectiveFrom;
  return { model, submitted, explicitEffectiveFrom: submitted.effectiveFrom !== undefined };
}

const LOCAL_RATE_FIELDS = [
  'inputPerMillion',
  'outputPerMillion',
  'cacheReadPerMillion',
  'cacheWritePerMillion',
  'cacheWrite5mPerMillion',
  'cacheWrite1hPerMillion',
] as const;

function mapLocalRow(row: Json, options: PricingImportOptions): MappedRow {
  const model = row.model;
  if (typeof model !== 'string' || model.trim() === '') throw new RowError('entry is missing a non-empty model');
  const submitted: Json = { model };
  for (const field of LOCAL_RATE_FIELDS) {
    const value = row[field];
    if (value !== undefined && value !== null) submitted[field] = value;
  }
  // The override always wins over the row's own currency label — it forces
  // the label, never the amounts.
  if (options.currencyOverride) submitted.currency = options.currencyOverride;
  else if (typeof row.currency === 'string' && row.currency !== '') submitted.currency = row.currency;
  if (typeof row.id === 'string' && row.id !== '') submitted.id = row.id;
  if (row.cacheWriteIncludedInInput !== undefined) submitted.cacheWriteIncludedInInput = row.cacheWriteIncludedInInput;
  const provider = typeof row.provider === 'string' && row.provider !== '' ? row.provider : options.defaultProvider;
  if (provider) submitted.provider = provider;
  const upstreamId =
    typeof row.upstreamId === 'string' && row.upstreamId !== '' ? row.upstreamId : options.defaultUpstreamId;
  if (upstreamId) submitted.upstreamId = upstreamId;
  const effectiveFrom = row.effectiveFrom;
  if (typeof effectiveFrom === 'string' && effectiveFrom !== '') submitted.effectiveFrom = effectiveFrom;
  return { model, submitted, explicitEffectiveFrom: submitted.effectiveFrom !== undefined };
}

/** Stable, schema-conforming id derived from the upsert key (model, currency). */
function generatedProfileId(model: string, currency: string): string {
  const base = model.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  const digest = createHash('sha256').update(`${model}\n${currency}`).digest('hex').slice(0, 8);
  return `imp-${base ? `${base.slice(0, 112)}-` : ''}${digest}`.slice(0, 128);
}

function validationReason(error: unknown): string {
  if (error instanceof ControlError && Array.isArray(error.details)) {
    const issues = error.details as Array<{ path?: string; message?: string }>;
    const summary = issues
      .filter((issue) => issue.path !== undefined || issue.message !== undefined)
      .map((issue) => `${issue.path ?? ''}: ${issue.message ?? ''}`.replace(/^: /, ''))
      .join('; ');
    if (summary) return summary;
  }
  return error instanceof Error ? error.message : 'pricing profile validation failed';
}

interface ExistingProfile {
  id: string;
  profile: Json;
}

/** Current stored profiles indexed by the upsert key `${model}\n${currency}`. */
function loadExistingProfiles(store: ControlStore): Map<string, ExistingProfile> {
  const profiles = new Map<string, ExistingProfile>();
  const rows = store.db.prepare('SELECT id, body FROM pricing').all() as Array<{
    id: string;
    body: string;
  }>;
  for (const row of rows) {
    let profile: unknown;
    try {
      profile = JSON.parse(row.body);
    } catch {
      continue;
    }
    if (!isObject(profile)) continue;
    const model = profile.model;
    const currency = profile.currency;
    if (typeof model !== 'string' || typeof currency !== 'string') continue;
    profiles.set(`${model}\n${currency}`, { id: row.id, profile });
  }
  return profiles;
}

/**
 * Price-bearing fields used to decide whether a row changes the stored
 * profile. `effectiveFrom` participates only when the source row declares it
 * explicitly, so re-importing the same table (no explicit effectiveFrom)
 * stays idempotent instead of minting a fresh version on every run.
 */
const COMPARE_FIELDS = [
  'model',
  'currency',
  'inputPerMillion',
  'outputPerMillion',
  'cacheReadPerMillion',
  'cacheWritePerMillion',
  'cacheWrite5mPerMillion',
  'cacheWrite1hPerMillion',
  'cacheWriteIncludedInInput',
  'upstreamId',
  'provider',
] as const;

function pricingFingerprint(profile: object, includeEffectiveFrom: boolean): string {
  const picked: Json = {};
  for (const field of COMPARE_FIELDS) picked[field] = fieldOf(profile, field);
  if (includeEffectiveFrom) picked.effectiveFrom = fieldOf(profile, 'effectiveFrom');
  return JSON.stringify(picked);
}

/**
 * Persists one profile version through the same statements the admin console
 * pricing POST/PATCH handler runs (src/admin/server.ts): an immutable
 * pricing_versions row, its sequence row, and the pricing upsert, all in one
 * transaction, followed by the pricing.update audit event.
 */
function writePricingVersion(store: ControlStore, profile: object, actor: string): void {
  const id = fieldOf(profile, 'id');
  const effectiveFrom = fieldOf(profile, 'effectiveFrom');
  if (typeof id !== 'string' || typeof effectiveFrom !== 'string')
    throw new Error('Validated pricing profile is missing id or effectiveFrom');
  const versionId = `pv_${randomUUID()}`;
  const version = { ...profile, versionId };
  const createdAt = new Date().toISOString();
  store.db.transaction(() => {
    store.db
      .prepare('INSERT INTO pricing_versions (version_id,profile_id,body,effective_from,created_at) VALUES(?,?,?,?,?)')
      .run(versionId, id, JSON.stringify(version), effectiveFrom, createdAt);
    store.db.prepare('INSERT INTO pricing_version_sequence (version_id) VALUES(?)').run(versionId);
    store.db
      .prepare(
        'INSERT INTO pricing (id,body,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at',
      )
      .run(id, JSON.stringify(version), createdAt);
  })();
  store.audit(actor, 'pricing.update', { id, versionId, effectiveFrom });
}

/**
 * Imports a parsed price document into the control-store pricing tables.
 * Upsert key is (model, currency): an existing profile with that key is
 * versioned in place (its id is reused); otherwise a profile id is taken from
 * the row or derived deterministically. Rows whose content matches the stored
 * profile are skipped; invalid rows are reported per row and never abort the
 * batch.
 */
export function importPricingProfiles(
  document: unknown,
  store: ControlStore,
  options: PricingImportOptions = {},
): PricingImportResult {
  const shape = detectShape(document);
  const actor = options.actor ?? 'cli';
  const existing = loadExistingProfiles(store);
  const seen = new Set<string>();
  const result: PricingImportResult = {
    imported: 0,
    skipped: 0,
    failed: [],
    skippedRows: [],
    dryRun: options.dryRun === true,
  };
  for (const row of document as Json[]) {
    const label =
      typeof row.model === 'string' ? row.model : typeof row.model_id === 'string' ? row.model_id : '<unknown model>';
    let mapped: MappedRow;
    try {
      mapped = shape === 'models-dev' ? mapModelsDevRow(row, options) : mapLocalRow(row, options);
    } catch (error) {
      result.failed.push({
        model: label,
        reason: error instanceof RowError ? error.message : 'entry could not be mapped',
      });
      continue;
    }
    const key = `${mapped.model}\n${String(mapped.submitted.currency ?? '')}`;
    if (seen.has(key)) {
      result.skipped += 1;
      result.skippedRows.push({ model: mapped.model, reason: 'duplicate model+currency row in this import' });
      continue;
    }
    seen.add(key);
    const prior = existing.get(key);
    const id =
      prior !== undefined
        ? prior.id
        : typeof mapped.submitted.id === 'string'
          ? mapped.submitted.id
          : generatedProfileId(mapped.model, String(mapped.submitted.currency ?? ''));
    const effectiveFrom =
      mapped.explicitEffectiveFrom && typeof mapped.submitted.effectiveFrom === 'string'
        ? mapped.submitted.effectiveFrom
        : new Date().toISOString();
    let profile: object;
    try {
      profile = validatePricing({ ...mapped.submitted, id, effectiveFrom });
    } catch (error) {
      result.failed.push({ model: mapped.model, reason: validationReason(error) });
      continue;
    }
    if (
      prior !== undefined &&
      pricingFingerprint(prior.profile, mapped.explicitEffectiveFrom) ===
        pricingFingerprint(profile, mapped.explicitEffectiveFrom)
    ) {
      result.skipped += 1;
      result.skippedRows.push({ model: mapped.model, reason: 'identical to the stored pricing profile' });
      continue;
    }
    if (result.dryRun) {
      result.imported += 1;
      continue;
    }
    writePricingVersion(store, profile, actor);
    result.imported += 1;
  }
  if (!result.dryRun)
    store.audit(actor, 'pricing.import', {
      shape,
      imported: result.imported,
      skipped: result.skipped,
      failed: result.failed.length,
    });
  return result;
}
