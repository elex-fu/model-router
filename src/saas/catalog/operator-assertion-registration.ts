import { createHash } from 'node:crypto';
import { SaasCatalogError } from './errors.js';
import type { SaasCatalogService } from './service.js';
import type { CatalogTimestamp, ProviderRightsAuditContext, ProviderRightsRecord } from './types.js';

/** Rights evidence produced by an explicit, auditable operator declaration. */
export const OPERATOR_ASSERTION_EVIDENCE_KIND = 'operator_assertion' as const;

export interface OperatorAssertionEvidenceReference {
  readonly kind: typeof OPERATOR_ASSERTION_EVIDENCE_KIND;
  readonly assertedBy: string;
  readonly assertedAt: string;
  readonly description: string;
}

export interface RegisterOperatorAssertedRightsInput {
  readonly rightsId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly supplyMode: 'byok' | 'platform';
  readonly region: string;
  readonly purpose: string;
  readonly modelScope: readonly string[];
  readonly endpointScope: readonly string[];
  readonly effectiveAt: CatalogTimestamp;
  readonly expiresAt?: CatalogTimestamp | null;
  readonly assertedAt: CatalogTimestamp;
  readonly description: string;
  /** Required so the declaration and the catalog audit event name the operator. */
  readonly audit: ProviderRightsAuditContext;
  readonly approvalReference?: string;
}

const MAX_ASSERTION_TEXT_LENGTH = 200;

function assertionText(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_ASSERTION_TEXT_LENGTH ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new SaasCatalogError('INVALID_INPUT');
  }
  return normalized;
}

function assertionTimestamp(value: CatalogTimestamp): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new SaasCatalogError('INVALID_INPUT');
  return date.toISOString();
}

/**
 * Registers an operator-asserted rights version through the ordinary catalog
 * lifecycle. The JSON evidence reference records who asserted, when, and why;
 * the rights row remains authoritative for the full scope, effective/expiry
 * window, version, status, and later revocation. Its SHA-256 covers the exact
 * serialized evidence reference. Existing free-form evidence registrations
 * and all catalog, capability, entitlement, and route checks are unchanged.
 */
export async function registerOperatorAssertedRights(
  catalog: Pick<SaasCatalogService, 'registerProviderRightsVersion'>,
  input: RegisterOperatorAssertedRightsInput,
): Promise<ProviderRightsRecord> {
  const rightsId = assertionText(input.rightsId);
  const evidence: OperatorAssertionEvidenceReference = {
    kind: OPERATOR_ASSERTION_EVIDENCE_KIND,
    assertedBy: assertionText(input.audit.actorUserId),
    assertedAt: assertionTimestamp(input.assertedAt),
    description: assertionText(input.description),
  };
  const evidenceReference = JSON.stringify(evidence);
  return catalog.registerProviderRightsVersion({
    rightsId,
    providerId: input.providerId,
    productId: input.productId,
    credentialType: input.credentialType,
    supplyMode: input.supplyMode,
    region: input.region,
    purpose: input.purpose,
    modelScope: input.modelScope,
    endpointScope: input.endpointScope,
    effectiveAt: input.effectiveAt,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    approvalReference: input.approvalReference ?? `${OPERATOR_ASSERTION_EVIDENCE_KIND}:${rightsId}`,
    status: 'active',
    evidenceReference,
    evidenceSha256: createHash('sha256').update(evidenceReference, 'utf8').digest('hex'),
    audit: input.audit,
  });
}
