import { createHash } from 'node:crypto';
import type { SaasDatabase } from '../db/types.js';
import { CLAUDE_CREDENTIAL_TYPE, CLAUDE_PRODUCT_ID, CLAUDE_PROVIDER_ID } from '../gateway/claude/catalog-identity.js';
import { CODEX_CREDENTIAL_TYPE, CODEX_PRODUCT_ID, CODEX_PROVIDER_ID } from '../gateway/codex/catalog-identity.js';
import { GEMINI_CREDENTIAL_TYPE, GEMINI_PRODUCT_ID, GEMINI_PROVIDER_ID } from '../gateway/gemini/catalog-identity.js';
import {
  GROK_CREDENTIAL_TYPE_OAUTH,
  GROK_OAUTH_PRODUCT_ID,
  GROK_PROVIDER_ID,
} from '../gateway/grok/catalog-identity.js';
import type {
  BulkImportProvider,
  BulkImportValidationQueue,
  BulkImportValidationRequest,
} from './bulk-import-service.js';

const BINDINGS = Object.freeze({
  codex: Object.freeze({
    providerId: CODEX_PROVIDER_ID,
    productId: CODEX_PRODUCT_ID,
    credentialType: CODEX_CREDENTIAL_TYPE,
  }),
  claude: Object.freeze({
    providerId: CLAUDE_PROVIDER_ID,
    productId: CLAUDE_PRODUCT_ID,
    credentialType: CLAUDE_CREDENTIAL_TYPE,
  }),
  gemini: Object.freeze({
    providerId: GEMINI_PROVIDER_ID,
    productId: GEMINI_PRODUCT_ID,
    credentialType: GEMINI_CREDENTIAL_TYPE,
  }),
  grok: Object.freeze({
    providerId: GROK_PROVIDER_ID,
    productId: GROK_OAUTH_PRODUCT_ID,
    credentialType: GROK_CREDENTIAL_TYPE_OAUTH,
  }),
} satisfies Readonly<Record<BulkImportProvider, { providerId: string; productId: string; credentialType: string }>>);

const CONSUMED_OR_PENDING_STATES = new Set(['queued', 'leased', 'verified', 'failed']);

export type BulkImportValidationErrorCode =
  | 'BULK_IMPORT_VALIDATION_JOB_MISSING'
  | 'BULK_IMPORT_VALIDATION_JOB_MISMATCH'
  | 'BULK_IMPORT_VALIDATION_JOB_CANCELLED'
  | 'BULK_IMPORT_VALIDATION_ROW_INVALID';

export class BulkImportValidationError extends Error {
  constructor(readonly code: BulkImportValidationErrorCode) {
    super(code);
    this.name = 'BulkImportValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function rowText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BulkImportValidationError('BULK_IMPORT_VALIDATION_ROW_INVALID');
  }
  return value;
}

function rowVersion(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new BulkImportValidationError('BULK_IMPORT_VALIDATION_ROW_INVALID');
  }
  return parsed;
}

/**
 * Acknowledges the first-validation job automatically inserted by
 * createPlatformProviderCredential. It never inserts or leases a job: queued,
 * leased and terminal jobs all prove that the automatic task was consumed by
 * the normal validation pipeline, and terminal failures must not be requeued.
 */
export class PostgresBulkImportValidationQueue implements BulkImportValidationQueue {
  constructor(private readonly database: Pick<SaasDatabase, 'query'>) {
    if (!database || typeof database.query !== 'function') throw new TypeError('validation database is required');
  }

  async enqueue(input: BulkImportValidationRequest): Promise<void> {
    const binding = BINDINGS[input.provider];
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT j.id, j.account_id, j.credential_id, j.credential_version,
              j.provider_id, j.product_id, j.credential_type, j.idempotency_key, j.status
       FROM saas_platform_provider_credential_validation_jobs AS j
       JOIN saas_platform_provider_credentials AS c
         ON c.id = j.credential_id AND c.account_id = j.account_id
       WHERE j.account_id = $1 AND j.provider_id = $2 AND j.product_id = $3
         AND j.credential_type = $4 AND c.current_version = j.credential_version`,
      [input.accountRef, binding.providerId, binding.productId, binding.credentialType],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) {
      throw new BulkImportValidationError('BULK_IMPORT_VALIDATION_JOB_MISSING');
    }
    const status = rowText(row.status);
    if (status === 'cancelled') throw new BulkImportValidationError('BULK_IMPORT_VALIDATION_JOB_CANCELLED');
    if (!CONSUMED_OR_PENDING_STATES.has(status)) {
      throw new BulkImportValidationError('BULK_IMPORT_VALIDATION_ROW_INVALID');
    }
    const accountId = rowText(row.account_id);
    const credentialId = rowText(row.credential_id);
    const credentialVersion = rowVersion(row.credential_version);
    const providerId = rowText(row.provider_id);
    const productId = rowText(row.product_id);
    const credentialType = rowText(row.credential_type);
    const expectedKey = createHash('sha256')
      .update(
        [
          'provider-credential-validation-v1',
          'platform',
          accountId,
          credentialId,
          String(credentialVersion),
          providerId,
          productId,
        ].join('\u0000'),
      )
      .digest('hex');
    if (
      accountId !== input.accountRef ||
      providerId !== binding.providerId ||
      productId !== binding.productId ||
      credentialType !== binding.credentialType ||
      rowText(row.idempotency_key) !== expectedKey
    ) {
      throw new BulkImportValidationError('BULK_IMPORT_VALIDATION_JOB_MISMATCH');
    }
    rowText(row.id);
  }
}
