import { createHash, createHmac, randomUUID } from 'node:crypto';

export const BULK_IMPORT_PROVIDERS = ['codex', 'claude', 'gemini', 'grok'] as const;
export type BulkImportProvider = (typeof BULK_IMPORT_PROVIDERS)[number];
export type BulkImportMaterial = Readonly<Record<string, unknown>>;

export interface BulkImportItemInput {
  readonly provider: BulkImportProvider;
  /** A parsed auth.json/credentials object or a provider-adapter DTO. */
  readonly material: BulkImportMaterial;
  readonly displayName?: string;
  readonly egressProxyId?: string;
}

export interface BulkImportAudit {
  readonly actorUserId: string;
  readonly sourceIp?: string | null;
  readonly userAgent?: string | null;
}

export interface BulkImportRequest {
  readonly items: readonly BulkImportItemInput[];
  readonly audit: BulkImportAudit;
}

export interface BulkImportSinkCapabilities {
  readonly displayName?: boolean;
  readonly egressProxyId?: boolean;
}

export interface BulkImportSinkInput {
  readonly envelope: BulkImportMaterial;
  readonly actorUserId: string;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly displayName: string | null;
  readonly egressProxyId: string | null;
}

/** Structural seam; provider adapters own conversion to each concrete envelope. */
export interface BulkImportCredentialSink {
  readonly capabilities?: BulkImportSinkCapabilities;
  accept(input: BulkImportSinkInput): Promise<{ readonly accountRef: string }>;
}

export interface BulkImportValidationRequest {
  readonly accountRef: string;
  readonly provider: BulkImportProvider;
  readonly importJobId: string;
  readonly itemIndex: number;
  readonly idempotencyKey: string;
  readonly reason: 'bulk_account_import';
  readonly audit: BulkImportAudit;
}

/** Optional first-validation seam; concrete requeue services need an adapter. */
export interface BulkImportValidationQueue {
  enqueue(input: BulkImportValidationRequest): Promise<void>;
}

export type BulkImportJobStatus = 'running' | 'completed';
export type BulkImportItemStatus = 'pending' | 'succeeded' | 'deduplicated' | 'failed';
export type BulkImportValidationState = 'pending_validation' | 'queued' | 'queue_failed' | 'not_requested';
export type BulkImportOptionWarning = 'DISPLAY_NAME_UNSUPPORTED' | 'EGRESS_PROXY_ID_UNSUPPORTED';

export interface BulkImportJobRecord {
  readonly id: string;
  readonly status: BulkImportJobStatus;
  readonly totalCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly createdBy: string;
  readonly errorSummary: Readonly<Record<string, number>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface BulkImportItemRecord {
  readonly jobId: string;
  readonly itemIndex: number;
  readonly provider: BulkImportProvider;
  readonly credentialFingerprint: string;
  readonly status: BulkImportItemStatus;
  readonly accountRef: string | null;
  readonly errorReason: string | null;
  readonly displayName: string | null;
  readonly egressProxyId: string | null;
  readonly validationState: BulkImportValidationState;
  readonly optionWarnings: readonly BulkImportOptionWarning[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface BulkImportJobCreate {
  readonly id: string;
  readonly totalCount: number;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface BulkImportItemClaim {
  readonly jobId: string;
  readonly itemIndex: number;
  readonly provider: BulkImportProvider;
  readonly credentialFingerprint: string;
  readonly displayName: string | null;
  readonly egressProxyId: string | null;
  readonly optionWarnings: readonly BulkImportOptionWarning[];
  readonly createdAt: string;
}

export interface BulkImportItemSuccess {
  readonly jobId: string;
  readonly itemIndex: number;
  readonly accountRef: string;
  readonly validationState: Exclude<BulkImportValidationState, 'not_requested'>;
  readonly errorReason: string | null;
  readonly completedAt: string;
}

export interface BulkImportItemFailure {
  readonly jobId: string;
  readonly itemIndex: number;
  readonly errorReason: string;
  readonly completedAt: string;
}

export type BulkImportClaimResult =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'deduplicated'; readonly item: BulkImportItemRecord };

/**
 * Persistence contract for the import state machine. Implementations must make
 * each method atomic. In particular, claimItem serializes equal
 * provider/fingerprint claims, persists a deduplicated item and increments the
 * job success count together; succeedItem/failItem update item and job counters
 * together. completeJob refuses to complete while any item remains pending.
 */
export interface BulkImportStore {
  createJob(input: BulkImportJobCreate): Promise<BulkImportJobRecord>;
  claimItem(input: BulkImportItemClaim): Promise<BulkImportClaimResult>;
  succeedItem(input: BulkImportItemSuccess): Promise<BulkImportItemRecord>;
  failItem(input: BulkImportItemFailure): Promise<BulkImportItemRecord>;
  completeJob(input: {
    readonly jobId: string;
    readonly errorSummary: Readonly<Record<string, number>>;
    readonly completedAt: string;
  }): Promise<BulkImportJobRecord>;
}

export interface BulkImportResult {
  readonly job: BulkImportJobRecord;
  readonly items: readonly BulkImportItemRecord[];
}

export interface BulkAccountImportServiceOptions {
  readonly store: BulkImportStore;
  readonly sinks: Readonly<Record<BulkImportProvider, BulkImportCredentialSink>>;
  /** Runtime-owned secret; copied on construction and never persisted. */
  readonly fingerprintKey: Uint8Array;
  readonly validationQueue?: BulkImportValidationQueue;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const FINGERPRINT_DOMAIN = 'model-router/bulk-account-import/v1';

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function optionalText(value: string | undefined, label: string, maximum: number): string | null {
  return value === undefined ? null : requiredText(value, label, maximum);
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('credential material must be finite JSON');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('credential material must be acyclic JSON');
  seen.add(value);
  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value.map((entry) => canonicalJson(entry, seen)).join(',')}]`;
  } else {
    const record = value as Record<string, unknown>;
    const entries: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${canonicalJson(entry, seen)}`);
    }
    serialized = `{${entries.join(',')}}`;
  }
  seen.delete(value);
  return serialized;
}

function errorReason(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    if (typeof code === 'string' && SAFE_ERROR_CODE.test(code)) return code;
  }
  return fallback;
}

export class BulkAccountImportService {
  private readonly store: BulkImportStore;
  private readonly sinks: Readonly<Record<BulkImportProvider, BulkImportCredentialSink>>;
  private readonly fingerprintKey: Buffer;
  private readonly validationQueue?: BulkImportValidationQueue;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: BulkAccountImportServiceOptions) {
    if (!options?.store) throw new TypeError('bulk import store is required');
    if (!options.sinks) throw new TypeError('bulk import sinks are required');
    for (const provider of BULK_IMPORT_PROVIDERS) {
      if (typeof options.sinks[provider]?.accept !== 'function') {
        throw new TypeError(`${provider} bulk import sink is required`);
      }
    }
    if (!(options.fingerprintKey instanceof Uint8Array) || options.fingerprintKey.byteLength < 32) {
      throw new TypeError('a bulk import fingerprint key of at least 32 bytes is required');
    }
    if (options.validationQueue !== undefined && typeof options.validationQueue.enqueue !== 'function') {
      throw new TypeError('bulk import validation queue is invalid');
    }
    this.store = options.store;
    this.sinks = options.sinks;
    this.fingerprintKey = Buffer.from(options.fingerprintKey);
    this.validationQueue = options.validationQueue;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      throw new TypeError('bulk import clock is invalid');
    return value.toISOString();
  }

  private fingerprint(provider: BulkImportProvider, material: BulkImportMaterial): string {
    if (material === null || typeof material !== 'object' || Array.isArray(material)) {
      throw new TypeError('credential material must be a JSON object');
    }
    const canonical = canonicalJson(material);
    return createHmac('sha256', this.fingerprintKey)
      .update(FINGERPRINT_DOMAIN)
      .update('\0')
      .update(provider)
      .update('\0')
      .update(canonical, 'utf8')
      .digest('hex');
  }

  async importAccounts(input: BulkImportRequest): Promise<BulkImportResult> {
    if (!input || !Array.isArray(input.items) || input.items.length === 0 || input.items.length > 10_000) {
      throw new TypeError('bulk import requires between 1 and 10000 items');
    }
    if (!input.audit || !UUID.test(input.audit.actorUserId)) throw new TypeError('bulk import actor is invalid');
    const audit: BulkImportAudit = Object.freeze({
      actorUserId: input.audit.actorUserId,
      sourceIp:
        input.audit.sourceIp === null || input.audit.sourceIp === undefined
          ? null
          : requiredText(input.audit.sourceIp, 'source IP', 128),
      userAgent:
        input.audit.userAgent === null || input.audit.userAgent === undefined
          ? null
          : requiredText(input.audit.userAgent, 'user agent', 512),
    });
    const jobId = this.newId();
    if (!UUID.test(jobId)) throw new TypeError('bulk import job id is invalid');
    const prepared = input.items.map((item, itemIndex) => {
      if (!item || !BULK_IMPORT_PROVIDERS.includes(item.provider))
        throw new TypeError('bulk import provider is invalid');
      const provider: BulkImportProvider = item.provider;
      const displayName = optionalText(item.displayName, 'display name', 256);
      const egressProxyId = optionalText(item.egressProxyId, 'egress proxy id', 36);
      if (egressProxyId !== null && !UUID.test(egressProxyId)) throw new TypeError('egress proxy id is invalid');
      return Object.freeze({
        itemIndex,
        provider,
        material: item.material,
        displayName,
        egressProxyId,
        credentialFingerprint: this.fingerprint(provider, item.material),
      });
    });

    const createdAt = this.timestamp();
    await this.store.createJob({ id: jobId, totalCount: prepared.length, createdBy: audit.actorUserId, createdAt });
    const items: BulkImportItemRecord[] = [];
    const errorSummary: Record<string, number> = {};

    for (const entry of prepared) {
      const sink = this.sinks[entry.provider];
      const optionWarnings: BulkImportOptionWarning[] = [];
      if (entry.displayName !== null && sink.capabilities?.displayName !== true) {
        optionWarnings.push('DISPLAY_NAME_UNSUPPORTED');
      }
      if (entry.egressProxyId !== null && sink.capabilities?.egressProxyId !== true) {
        optionWarnings.push('EGRESS_PROXY_ID_UNSUPPORTED');
      }
      const claimedAt = this.timestamp();
      const claim = await this.store.claimItem({
        jobId,
        itemIndex: entry.itemIndex,
        provider: entry.provider,
        credentialFingerprint: entry.credentialFingerprint,
        displayName: entry.displayName,
        egressProxyId: entry.egressProxyId,
        optionWarnings,
        createdAt: claimedAt,
      });
      if (claim.kind === 'deduplicated') {
        items.push(claim.item);
        continue;
      }

      let accountRef: string;
      try {
        const accepted = await sink.accept({
          envelope: entry.material,
          actorUserId: audit.actorUserId,
          sourceIp: audit.sourceIp ?? null,
          userAgent: audit.userAgent ?? null,
          displayName: entry.displayName,
          egressProxyId: entry.egressProxyId,
        });
        accountRef = requiredText(accepted?.accountRef, 'sink account reference', 200);
      } catch (error) {
        const reason = errorReason(error, 'SINK_ACCEPT_FAILED');
        const failed = await this.store.failItem({
          jobId,
          itemIndex: entry.itemIndex,
          errorReason: reason,
          completedAt: this.timestamp(),
        });
        errorSummary[reason] = (errorSummary[reason] ?? 0) + 1;
        items.push(failed);
        continue;
      }

      let validationState: BulkImportItemSuccess['validationState'] = 'pending_validation';
      let validationError: string | null = null;
      if (this.validationQueue) {
        try {
          await this.validationQueue.enqueue({
            accountRef,
            provider: entry.provider,
            importJobId: jobId,
            itemIndex: entry.itemIndex,
            idempotencyKey: createHash('sha256')
              .update(jobId)
              .update('\0')
              .update(String(entry.itemIndex))
              .update('\0')
              .update(entry.credentialFingerprint)
              .digest('hex'),
            reason: 'bulk_account_import',
            audit,
          });
          validationState = 'queued';
        } catch (error) {
          validationState = 'queue_failed';
          validationError = errorReason(error, 'VALIDATION_ENQUEUE_FAILED');
        }
      }
      items.push(
        await this.store.succeedItem({
          jobId,
          itemIndex: entry.itemIndex,
          accountRef,
          validationState,
          errorReason: validationError,
          completedAt: this.timestamp(),
        }),
      );
    }

    const job = await this.store.completeJob({ jobId, errorSummary, completedAt: this.timestamp() });
    return Object.freeze({ job, items: Object.freeze(items) });
  }
}
