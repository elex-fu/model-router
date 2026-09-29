import type { SaasDatabase } from '../db/types.js';
import { ProviderSupplyError } from '../supply/errors.js';
import { PostgresProviderSupplyRepository } from '../supply/repository.js';
import type { ProviderSupplyService } from '../supply/service.js';
import type { ProviderCredentialReference, StoredProviderCredentialVersion } from '../supply/types.js';

export type PlatformCredentialRewrapState = 'ready' | 'already_current' | 'not_eligible';
export type PlatformCredentialRewrapOutcome = 'succeeded' | 'unknown' | 'conflict' | 'error';

export interface PlatformCredentialWrappingStatus {
  readonly state: PlatformCredentialRewrapState;
  readonly credentialVersion: number | null;
  readonly wrappingRevision: number | null;
}

export interface PlatformCredentialRewrapResult {
  readonly outcome: PlatformCredentialRewrapOutcome;
  readonly credentialVersion: number;
  readonly expectedWrappingRevision: number;
  readonly wrappingRevision: number | null;
  readonly refreshRequired: boolean;
}

export interface PlatformCredentialRewrapOperations {
  getStatus(accountId: string, credentialId: string): Promise<PlatformCredentialWrappingStatus>;
  rewrap(input: {
    readonly accountId: string;
    readonly credentialId: string;
    readonly expectedVersion: number;
    readonly expectedWrappingRevision: number;
    readonly operationId: string;
    readonly actorUserId: string;
    readonly sourceIp: string | null;
    readonly userAgent: string | null;
  }): Promise<PlatformCredentialRewrapResult>;
}

export interface PlatformCredentialRewrapOperationsOptions {
  readonly database: SaasDatabase;
  readonly service: Pick<ProviderSupplyService, 'listPlatformProviderCredentials' | 'rewrapProviderCredential'>;
  /** Trusted deployment key policy; never read from HTTP input. */
  readonly destinationKmsKeyId: string;
}

class RewrapOperationsError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'STORAGE_ERROR') {
    super(code);
    this.name = 'RewrapOperationsError';
  }
}

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RewrapOperationsError('STORAGE_ERROR');
}

function serviceErrorCode(error: unknown): string | undefined {
  return error instanceof ProviderSupplyError ? error.code : undefined;
}

export function createPlatformCredentialRewrapOperations(
  options: PlatformCredentialRewrapOperationsOptions,
): PlatformCredentialRewrapOperations {
  if (!options?.database || typeof options.database.query !== 'function') {
    throw new TypeError('database is required');
  }
  if (
    !options.service ||
    typeof options.service.listPlatformProviderCredentials !== 'function' ||
    typeof options.service.rewrapProviderCredential !== 'function'
  ) {
    throw new TypeError('platform provider supply service is required');
  }
  if (typeof options.destinationKmsKeyId !== 'string' || options.destinationKmsKeyId.trim() === '') {
    throw new TypeError('trusted destination KMS key is required');
  }

  const repository = new PostgresProviderSupplyRepository(options.database);

  async function platformCredential(accountId: string, credentialId: string) {
    const records = await options.service.listPlatformProviderCredentials(accountId);
    const matches = records.filter((record) => record.id === credentialId);
    if (matches.length !== 1) throw new RewrapOperationsError('NOT_FOUND');
    const credential = matches[0];
    if (
      credential?.ownerKind !== 'platform' ||
      credential.tenantId !== null ||
      credential.supplyMode !== 'platform' ||
      credential.accountId !== accountId
    ) {
      throw new RewrapOperationsError('NOT_FOUND');
    }
    return credential;
  }

  async function currentVersion(
    reference: ProviderCredentialReference,
    version: number,
  ): Promise<StoredProviderCredentialVersion | null> {
    const stored = await repository.getCredentialVersionEnvelope({ ...reference, version });
    if (!stored) return null;
    if (
      stored.ownerKind !== 'platform' ||
      stored.tenantId !== null ||
      stored.accountId !== reference.accountId ||
      stored.credentialId !== reference.credentialId ||
      stored.version !== version
    ) {
      throw new RewrapOperationsError('NOT_FOUND');
    }
    return stored;
  }

  async function readStatus(accountId: string, credentialId: string): Promise<PlatformCredentialWrappingStatus> {
    const credential = await platformCredential(accountId, credentialId);
    if (credential.currentVersion === null) {
      return { state: 'not_eligible', credentialVersion: null, wrappingRevision: null };
    }
    const reference: ProviderCredentialReference = {
      ownerKind: 'platform',
      tenantId: null,
      accountId,
      credentialId,
    };
    const version = await currentVersion(reference, credential.currentVersion);
    if (!version) throw new RewrapOperationsError('NOT_FOUND');
    if (version.status !== 'active' || version.retiredAt !== null || version.revokedAt !== null) {
      return {
        state: 'not_eligible',
        credentialVersion: version.version,
        wrappingRevision: version.wrappingRevision,
      };
    }
    return {
      state: version.kmsKeyId === options.destinationKmsKeyId ? 'already_current' : 'ready',
      credentialVersion: version.version,
      wrappingRevision: version.wrappingRevision,
    };
  }

  return {
    getStatus: readStatus,

    async rewrap(input): Promise<PlatformCredentialRewrapResult> {
      assertPositiveInteger(input.expectedVersion);
      assertPositiveInteger(input.expectedWrappingRevision);
      const credential = await platformCredential(input.accountId, input.credentialId);
      const reference: ProviderCredentialReference & { readonly version: number } = {
        ownerKind: 'platform',
        tenantId: null,
        accountId: input.accountId,
        credentialId: input.credentialId,
        version: input.expectedVersion,
      };
      const before = await currentVersion(reference, input.expectedVersion);
      if (!before) throw new RewrapOperationsError('NOT_FOUND');
      if (
        credential.currentVersion !== input.expectedVersion ||
        before.wrappingRevision !== input.expectedWrappingRevision
      ) {
        return {
          outcome: 'conflict',
          credentialVersion: credential.currentVersion ?? input.expectedVersion,
          expectedWrappingRevision: input.expectedWrappingRevision,
          wrappingRevision: before.wrappingRevision,
          refreshRequired: true,
        };
      }
      if (before.status !== 'active' || before.revokedAt !== null || before.retiredAt !== null) {
        return {
          outcome: 'error',
          credentialVersion: before.version,
          expectedWrappingRevision: input.expectedWrappingRevision,
          wrappingRevision: before.wrappingRevision,
          refreshRequired: false,
        };
      }

      try {
        const result = await options.service.rewrapProviderCredential({
          credential: reference,
          version: input.expectedVersion,
          expectedWrappingRevision: input.expectedWrappingRevision,
          destinationKmsKeyId: options.destinationKmsKeyId,
          operationId: input.operationId,
          reasonCode: 'operator_requested_key_rotation',
          audit: {
            actorKind: 'user',
            actorUserId: input.actorUserId,
            entryPoint: 'platform_admin',
            requestId: input.operationId,
            sourceIp: input.sourceIp,
            userAgent: input.userAgent,
          },
        });
        return {
          outcome: 'succeeded',
          credentialVersion: result.version,
          expectedWrappingRevision: input.expectedWrappingRevision,
          wrappingRevision: result.wrappingRevision,
          refreshRequired: false,
        };
      } catch (error) {
        const current = await currentVersion(reference, input.expectedVersion).catch(() => null);
        const accepted = await repository
          .getCredentialWrapperRevisionByOperation(reference, input.operationId)
          .catch(() => null);
        if (accepted) {
          return {
            outcome: 'succeeded',
            credentialVersion: accepted.credentialVersion,
            expectedWrappingRevision: input.expectedWrappingRevision,
            wrappingRevision: accepted.wrappingRevision,
            refreshRequired: false,
          };
        }
        const code = serviceErrorCode(error);
        return {
          outcome:
            code === 'CREDENTIAL_VERSION_CONFLICT'
              ? 'conflict'
              : code === 'KMS_REWRAP_FAILED' || code === 'SUPPLY_STORAGE_ERROR'
                ? 'unknown'
                : 'error',
          credentialVersion: input.expectedVersion,
          expectedWrappingRevision: input.expectedWrappingRevision,
          wrappingRevision: current?.wrappingRevision ?? null,
          refreshRequired: true,
        };
      }
    },
  };
}
