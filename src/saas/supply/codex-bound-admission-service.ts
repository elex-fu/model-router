import type { SaasDatabase } from '../db/types.js';
import type { PreparedRequestUsageEnvelope } from '../gateway/prepared-request-evidence-service.js';
import type { PlatformAdminActor } from '../platform/access/index.js';
import { verifyGovernanceActor } from '../platform/governance/actor.js';
import {
  governanceConflict,
  governanceInvalid,
  governanceNotFound,
  governanceStorage,
  PlatformGovernanceError,
} from '../platform/governance/errors.js';
import { appendGovernanceAudit } from '../platform/governance/users.js';
import {
  DEFAULT_CODEX_BOUND_APPROVAL_EXPIRY_MARGIN_MS,
  validateCodexTrustedBoundProfile,
} from '../runtime/codex-trusted-bound-profile-validation.js';
import {
  type CodexTrustedBoundProfile,
  type CodexTrustedBoundScope,
  codexTrustedProfileDigest,
} from '../runtime/codex-trusted-bound-profiles.js';

const CODEX_BOUND_WRITE_ROLES = ['superadmin', 'operations'] as const;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_KEYS = [
  'scope',
  'backendRevision',
  'evidenceVersion',
  'evidenceReference',
  'validFromMs',
  'expiresAtMs',
  'bounds',
] as const;
const SCOPE_KEYS = ['endpoint', 'productId', 'model', 'operation', 'transport', 'continuationMode'] as const;
const BOUNDS_REQUIRED_INTEGER_KEYS = [
  'inputTotalUpperBound',
  'inputUncachedUpperBound',
  'cacheReadUpperBound',
  'cacheWriteUpperBound',
  'cacheWrite5mUpperBound',
  'cacheWrite1hUpperBound',
  'outputTotalUpperBound',
  'reasoningOutputUpperBound',
] as const;
const BOUNDS_KEYS = [
  ...BOUNDS_REQUIRED_INTEGER_KEYS,
  'feasibleInputBuckets',
  'perUnitUnitsUpperBound',
  'sizeTier',
] as const;
const STATES = ['pending', 'approved', 'rejected', 'retired'] as const;

export type CodexBoundProfileState = (typeof STATES)[number];

export interface CodexBoundAdmissionView {
  readonly digest: string;
  readonly scope: CodexTrustedBoundScope;
  readonly bounds: PreparedRequestUsageEnvelope;
  readonly backendRevision: string;
  readonly evidenceVersion: string;
  readonly evidenceReference: string;
  readonly validFromMs: string;
  readonly expiresAtMs: string;
  readonly state: CodexBoundProfileState;
  readonly submittedByUserId: string;
  readonly approvedByUserId: string | null;
  readonly approvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CodexBoundSubmissionResult {
  readonly status: 'created' | 'duplicate';
  readonly digest: string;
  readonly state: CodexBoundProfileState;
}

export interface CodexBoundListResult {
  readonly items: readonly CodexBoundAdmissionView[];
  readonly total: string;
}

export interface CodexBoundTransitionResult {
  readonly digest: string;
  readonly state: CodexBoundProfileState;
  readonly approvedByUserId: string | null;
  readonly approvedAt: string | null;
  readonly updatedAt: string;
}

interface AdmissionRow extends Record<string, unknown> {
  digest: unknown;
  endpoint: unknown;
  product_id: unknown;
  model: unknown;
  operation: unknown;
  transport: unknown;
  continuation_mode: unknown;
  bounds: unknown;
  backend_revision: unknown;
  evidence_version: unknown;
  evidence_reference: unknown;
  valid_from_ms: unknown;
  expires_at_ms: unknown;
  state: unknown;
  submitted_by_user_id: unknown;
  approved_by_user_id: unknown;
  approved_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function exactKeys(input: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) governanceInvalid();
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    [...value].some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)
  ) {
    governanceInvalid();
  }
  return value;
}

function integerText(value: unknown, label: string): string {
  if (typeof value === 'bigint') {
    if (value < 0n || value > 9_007_199_254_740_991n) governanceInvalid();
    return value.toString(10);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) governanceInvalid();
    return String(value);
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value)) return value;
  governanceInvalid();
  return label;
}

function epochMs(value: unknown): number {
  const text = integerText(value, 'epoch');
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) governanceInvalid();
  return parsed;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) governanceInvalid();
  return value as T;
}

/**
 * The wire profile is normalized to the single canonical in-memory shape the
 * digest is defined over (epoch milliseconds as numbers, envelope integers as
 * decimal strings, optional envelope fields always present as null). The
 * normalized form is what gets stored, so a jsonb round-trip reproduces the
 * exact digest the admission recorded.
 */
function normalizeProfile(input: unknown): CodexTrustedBoundProfile {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) governanceInvalid();
  const profile = input as Record<string, unknown>;
  exactKeys(profile, PROFILE_KEYS);
  const scopeInput = profile.scope;
  if (scopeInput === null || typeof scopeInput !== 'object' || Array.isArray(scopeInput)) governanceInvalid();
  const scope = scopeInput as Record<string, unknown>;
  exactKeys(scope, SCOPE_KEYS);
  const boundsInput = profile.bounds;
  if (boundsInput === null || typeof boundsInput !== 'object' || Array.isArray(boundsInput)) governanceInvalid();
  const bounds = boundsInput as Record<string, unknown>;
  exactKeys(bounds, BOUNDS_KEYS);

  const envelope: Record<string, unknown> = {};
  for (const key of BOUNDS_REQUIRED_INTEGER_KEYS) envelope[key] = integerText(bounds[key], key);
  const feasible = bounds.feasibleInputBuckets;
  if (
    !Array.isArray(feasible) ||
    feasible.length > 64 ||
    feasible.some((bucket) => typeof bucket !== 'string' || bucket.length === 0 || bucket.length > 128)
  ) {
    governanceInvalid();
  }
  envelope.feasibleInputBuckets = [...feasible];
  envelope.perUnitUnitsUpperBound =
    bounds.perUnitUnitsUpperBound === undefined || bounds.perUnitUnitsUpperBound === null
      ? null
      : integerText(bounds.perUnitUnitsUpperBound, 'perUnitUnitsUpperBound');
  envelope.sizeTier =
    bounds.sizeTier === undefined || bounds.sizeTier === null ? null : boundedText(bounds.sizeTier, 64);

  const normalizedScope: CodexTrustedBoundScope = {
    endpoint: boundedText(scope.endpoint, 512),
    productId: boundedText(scope.productId, 256),
    model: boundedText(scope.model, 256),
    operation: boundedText(scope.operation, 128),
    transport: enumValue(scope.transport, ['http', 'websocket'] as const),
    continuationMode: enumValue(scope.continuationMode, [
      'full',
      'canonical-replay',
      'remote-history',
      'compact',
    ] as const),
  };
  const validFromMs = epochMs(profile.validFromMs);
  const expiresAtMs = epochMs(profile.expiresAtMs);
  const normalized: CodexTrustedBoundProfile = {
    scope: normalizedScope,
    bounds: Object.freeze(envelope) as unknown as PreparedRequestUsageEnvelope,
    backendRevision: boundedText(profile.backendRevision, 256),
    evidenceVersion: boundedText(profile.evidenceVersion, 128),
    evidenceReference: boundedText(profile.evidenceReference, 512),
    validFromMs,
    expiresAtMs,
  };
  if (!validateCodexTrustedBoundProfile(normalized).ok) governanceInvalid();
  return normalized;
}

function digestInput(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) governanceInvalid();
  return value;
}

function admissionView(row: AdmissionRow): CodexBoundAdmissionView {
  const state = enumValue(row.state, STATES);
  const bounds =
    row.bounds !== null && typeof row.bounds === 'object' && !Array.isArray(row.bounds)
      ? (row.bounds as PreparedRequestUsageEnvelope)
      : null;
  if (bounds === null) governanceStorage();
  return {
    digest: digestInput(row.digest),
    scope: {
      endpoint: String(row.endpoint),
      productId: String(row.product_id),
      model: String(row.model),
      operation: String(row.operation),
      transport: enumValue(row.transport, ['http', 'websocket'] as const),
      continuationMode: enumValue(row.continuation_mode, [
        'full',
        'canonical-replay',
        'remote-history',
        'compact',
      ] as const),
    },
    bounds,
    backendRevision: String(row.backend_revision),
    evidenceVersion: String(row.evidence_version),
    evidenceReference: String(row.evidence_reference),
    validFromMs: String(row.valid_from_ms),
    expiresAtMs: String(row.expires_at_ms),
    state,
    submittedByUserId: String(row.submitted_by_user_id),
    approvedByUserId: row.approved_by_user_id === null ? null : String(row.approved_by_user_id),
    approvedAt: row.approved_at === null ? null : String(row.approved_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export interface CodexBoundAdmissionServiceOptions {
  readonly now?: () => number;
  readonly expiryMarginMs?: number;
}

/**
 * The operator-side approval workflow over saas_codex_trusted_bound_profiles
 * (migration 155). Every write re-verifies the actor against the live
 * platform-session/role tables and audits into saas_audit_events in the same
 * transaction. The digest is always recomputed server-side from the strictly
 * validated profile; a wire-supplied digest is never accepted.
 */
export class CodexBoundAdmissionService {
  private readonly now: () => number;
  private readonly expiryMarginMs: number;

  constructor(
    private readonly database: Pick<SaasDatabase, 'query' | 'transaction'>,
    options: CodexBoundAdmissionServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.expiryMarginMs = options.expiryMarginMs ?? DEFAULT_CODEX_BOUND_APPROVAL_EXPIRY_MARGIN_MS;
    if (!Number.isSafeInteger(this.expiryMarginMs) || this.expiryMarginMs < 0) {
      throw new TypeError('Invalid Codex bound approval expiry margin');
    }
  }

  async submit(actor: PlatformAdminActor, input: unknown): Promise<CodexBoundSubmissionResult> {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) governanceInvalid();
    const profile = normalizeProfile(input);
    const digest = codexTrustedProfileDigest(profile);
    try {
      return await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, actor, CODEX_BOUND_WRITE_ROLES);
        const now = new Date().toISOString();
        const inserted = await tx.query<{ digest: string; state: string }>(
          `INSERT INTO saas_codex_trusted_bound_profiles
             (digest, endpoint, product_id, model, operation, transport, continuation_mode,
              bounds, backend_revision, evidence_version, evidence_reference,
              valid_from_ms, expires_at_ms, state, submitted_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, 'pending', $14)
           ON CONFLICT (digest) DO NOTHING
           RETURNING digest, state`,
          [
            digest,
            profile.scope.endpoint,
            profile.scope.productId,
            profile.scope.model,
            profile.scope.operation,
            profile.scope.transport,
            profile.scope.continuationMode,
            JSON.stringify(profile.bounds),
            profile.backendRevision,
            profile.evidenceVersion,
            profile.evidenceReference,
            profile.validFromMs,
            profile.expiresAtMs,
            actor.userId,
          ],
        );
        if (inserted.rows.length === 1) {
          const row = inserted.rows[0];
          if (!row || typeof row.digest !== 'string' || typeof row.state !== 'string') governanceStorage();
          await appendGovernanceAudit(tx, {
            action: 'codex_bound_profile.submitted',
            targetType: 'codex_trusted_bound_profile',
            targetId: digest,
            actorUserId: actor.userId,
            occurredAt: now,
          });
          return { status: 'created', digest, state: 'pending' };
        }
        const existing = await tx.query<{ state: string }>(
          'SELECT state FROM saas_codex_trusted_bound_profiles WHERE digest = $1',
          [digest],
        );
        const state = existing.rows[0]?.state;
        if (existing.rows.length !== 1 || typeof state !== 'string' || !(STATES as readonly string[]).includes(state)) {
          governanceStorage();
        }
        return { status: 'duplicate', digest, state: state as CodexBoundProfileState };
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }

  async list(actor: PlatformAdminActor, input: unknown): Promise<CodexBoundListResult> {
    let state: CodexBoundProfileState | undefined;
    let limit = 20;
    let offset = 0;
    if (input !== undefined) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) governanceInvalid();
      const body = input as Record<string, unknown>;
      exactKeys(body, ['state', 'limit', 'offset']);
      if (body.state !== undefined && body.state !== null) state = enumValue(body.state, STATES);
      if (body.limit !== undefined) {
        if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100) {
          governanceInvalid();
        }
        limit = body.limit;
      }
      if (body.offset !== undefined) {
        if (
          typeof body.offset !== 'number' ||
          !Number.isInteger(body.offset) ||
          body.offset < 0 ||
          body.offset > 1_000_000
        ) {
          governanceInvalid();
        }
        offset = body.offset;
      }
    }
    try {
      return await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, actor, CODEX_BOUND_WRITE_ROLES);
        const filters = state === undefined ? [] : [state];
        const where = state === undefined ? '' : 'WHERE state = $1';
        const rows = await tx.query<AdmissionRow>(
          `SELECT digest, endpoint, product_id, model, operation, transport, continuation_mode,
                  bounds, backend_revision, evidence_version, evidence_reference,
                  valid_from_ms::text, expires_at_ms::text, state,
                  submitted_by_user_id::text, approved_by_user_id::text, approved_at::text,
                  created_at::text, updated_at::text
             FROM saas_codex_trusted_bound_profiles ${where}
            ORDER BY created_at DESC, id DESC
            LIMIT ${limit} OFFSET ${offset}`,
          filters,
        );
        const counted = await tx.query<{ total: string }>(
          `SELECT count(*)::text AS total FROM saas_codex_trusted_bound_profiles ${where}`,
          filters,
        );
        const total = counted.rows[0]?.total;
        if (counted.rows.length !== 1 || typeof total !== 'string') governanceStorage();
        return { items: rows.rows.map(admissionView), total };
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }

  async approve(actor: PlatformAdminActor, input: unknown): Promise<CodexBoundTransitionResult> {
    return this.transition(actor, input, 'approved', 'codex_bound_profile.approved');
  }

  async reject(actor: PlatformAdminActor, input: unknown): Promise<CodexBoundTransitionResult> {
    return this.transition(actor, input, 'rejected', 'codex_bound_profile.rejected');
  }

  async retire(actor: PlatformAdminActor, input: unknown): Promise<CodexBoundTransitionResult> {
    return this.transition(actor, input, 'retired', 'codex_bound_profile.retired');
  }

  private async transition(
    actor: PlatformAdminActor,
    input: unknown,
    target: CodexBoundProfileState,
    auditAction: string,
  ): Promise<CodexBoundTransitionResult> {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) governanceInvalid();
    const body = input as Record<string, unknown>;
    exactKeys(body, ['digest']);
    const digest = digestInput(body.digest);
    const from = target === 'approved' ? 'pending' : target === 'rejected' ? 'pending' : 'approved';
    try {
      return await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, actor, CODEX_BOUND_WRITE_ROLES);
        if (target === 'approved') {
          const pending = await tx.query<AdmissionRow>(
            `SELECT digest, endpoint, product_id, model, operation, transport, continuation_mode,
                    bounds, backend_revision, evidence_version, evidence_reference,
                    valid_from_ms::text, expires_at_ms::text
               FROM saas_codex_trusted_bound_profiles
              WHERE digest = $1 AND state = 'pending'
              FOR UPDATE`,
            [digest],
          );
          const pendingRow = pending.rows[0];
          if (pendingRow) {
            const candidate = normalizeProfile({
              scope: {
                endpoint: pendingRow.endpoint,
                productId: pendingRow.product_id,
                model: pendingRow.model,
                operation: pendingRow.operation,
                transport: pendingRow.transport,
                continuationMode: pendingRow.continuation_mode,
              },
              backendRevision: pendingRow.backend_revision,
              evidenceVersion: pendingRow.evidence_version,
              evidenceReference: pendingRow.evidence_reference,
              validFromMs: pendingRow.valid_from_ms,
              expiresAtMs: pendingRow.expires_at_ms,
              bounds: pendingRow.bounds,
            });
            if (codexTrustedProfileDigest(candidate) !== digest) governanceStorage();
            if (
              !validateCodexTrustedBoundProfile(candidate, {
                nowMs: this.now(),
                expiryMarginMs: this.expiryMarginMs,
              }).ok
            ) {
              governanceInvalid();
            }
          }
        }
        const now = new Date().toISOString();
        const updated = await tx.query<AdmissionRow>(
          `UPDATE saas_codex_trusted_bound_profiles
              SET state = $3,
                  approved_by_user_id = CASE WHEN $3 = 'approved' THEN $2 ELSE approved_by_user_id END,
                  approved_at = CASE WHEN $3 = 'approved' THEN clock_timestamp() ELSE approved_at END,
                  updated_at = clock_timestamp()
            WHERE digest = $1 AND state = $4
            RETURNING digest, state, approved_by_user_id::text, approved_at::text, updated_at::text`,
          [digest, actor.userId, target, from],
        );
        if (updated.rows.length === 1) {
          const row = updated.rows[0];
          if (!row || typeof row.digest !== 'string' || typeof row.state !== 'string') governanceStorage();
          await appendGovernanceAudit(tx, {
            action: auditAction,
            targetType: 'codex_trusted_bound_profile',
            targetId: digest,
            actorUserId: actor.userId,
            occurredAt: now,
          });
          return {
            digest,
            state: enumValue(row.state, STATES),
            approvedByUserId: row.approved_by_user_id === null ? null : String(row.approved_by_user_id),
            approvedAt: row.approved_at === null ? null : String(row.approved_at),
            updatedAt: String(row.updated_at),
          };
        }
        const existing = await tx.query<{ state: string }>(
          'SELECT state FROM saas_codex_trusted_bound_profiles WHERE digest = $1',
          [digest],
        );
        if (existing.rows.length !== 1) governanceNotFound();
        const state = existing.rows[0]?.state;
        if (typeof state !== 'string' || !(STATES as readonly string[]).includes(state)) governanceStorage();
        if (state !== from) governanceConflict();
        return governanceStorage();
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }
}
