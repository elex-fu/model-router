import type {
  AppendProviderCredentialVersionInput,
  AppendProviderSupplyAuditEventInput,
  PersistedProviderAccountInput,
  PersistedProviderCredentialInput,
  PersistedTenantByokProfileAccountInput,
  ProviderSupplyRepository,
  UpdateProviderAccountLifecycleInput,
  UpdateProviderAccountValidationInput,
  UpdateProviderCredentialLifecycleInput,
  UpdateProviderCredentialValidationInput,
} from '../../../src/saas/supply/repository.js';
import type {
  ProviderAccountListFilter,
  ProviderAccountRecord,
  ProviderAccountReference,
  ProviderCredentialDispatchProof,
  ProviderCredentialListFilter,
  ProviderCredentialRecord,
  ProviderCredentialReference,
  ProviderCredentialValidationJobInput,
  ProviderCredentialValidationJobRecord,
  ProviderCredentialVersionRecord,
  ProviderSupplyOwner,
  ProviderValidationState,
  StoredProviderCredentialVersion,
} from '../../../src/saas/supply/types.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function error(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}

function ownerKey(owner: ProviderSupplyOwner, id: string): string {
  return `${owner.ownerKind}:${owner.tenantId ?? 'platform'}:${id}`;
}

function accountKey(reference: ProviderAccountReference): string {
  if (reference.ownerKind === 'tenant' && typeof reference.tenantId === 'string') {
    return ownerKey({ ownerKind: 'tenant', tenantId: reference.tenantId, supplyMode: 'byok' }, reference.accountId);
  }
  if (reference.ownerKind === 'platform' && reference.tenantId === null) {
    return ownerKey({ ownerKind: 'platform', tenantId: null, supplyMode: 'platform' }, reference.accountId);
  }
  throw error('INVALID_REFERENCE');
}

function snapshotOwner(owner: Pick<ProviderSupplyOwner, 'ownerKind' | 'tenantId' | 'supplyMode'>): ProviderSupplyOwner {
  if (owner.ownerKind === 'tenant' && typeof owner.tenantId === 'string' && owner.supplyMode === 'byok') {
    return { ownerKind: 'tenant', tenantId: owner.tenantId, supplyMode: 'byok' };
  }
  if (owner.ownerKind === 'platform' && owner.tenantId === null && owner.supplyMode === 'platform') {
    return { ownerKind: 'platform', tenantId: null, supplyMode: 'platform' };
  }
  throw error('INVALID_DISPATCH_PROOF_OWNER');
}

function credentialKey(reference: ProviderCredentialReference | ProviderCredentialRecord): string {
  const credentialId = 'credentialId' in reference ? reference.credentialId : reference.id;
  return `${accountKey(reference)}:${credentialId}`;
}

function versionKey(reference: ProviderCredentialReference & { readonly version: number }): string {
  return `${credentialKey(reference)}:${reference.version}`;
}

function publicVersion(record: StoredProviderCredentialVersion): ProviderCredentialVersionRecord {
  return {
    ownerKind: record.ownerKind,
    tenantId: record.tenantId,
    accountId: record.accountId,
    credentialId: record.credentialId,
    version: record.version,
    status: record.status,
    envelopeSchemaVersion: record.envelopeSchemaVersion,
    contextVersion: record.contextVersion,
    algorithm: record.algorithm,
    kmsPurpose: record.kmsPurpose,
    wrappingRevision: record.wrappingRevision,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    retiredAt: record.retiredAt,
    revokedAt: record.revokedAt,
  };
}

export class FakeProviderSupplyRepository implements ProviderSupplyRepository {
  accounts: ProviderAccountRecord[] = [];
  credentials: ProviderCredentialRecord[] = [];
  versions: StoredProviderCredentialVersion[] = [];
  auditEvents: AppendProviderSupplyAuditEventInput[] = [];
  validationJobs: ProviderCredentialValidationJobRecord[] = [];
  byokProfileAccountBindings: PersistedTenantByokProfileAccountInput[] = [];
  failAudit = false;
  failValidationEnqueue = false;
  dispatchProof: ProviderCredentialDispatchProof | null = null;

  async transaction<T>(work: (repository: ProviderSupplyRepository) => Promise<T>): Promise<T> {
    const child = new FakeProviderSupplyRepository();
    child.accounts = clone(this.accounts);
    child.credentials = clone(this.credentials);
    child.versions = clone(this.versions);
    child.auditEvents = clone(this.auditEvents);
    child.validationJobs = clone(this.validationJobs);
    child.byokProfileAccountBindings = clone(this.byokProfileAccountBindings);
    child.failAudit = this.failAudit;
    child.failValidationEnqueue = this.failValidationEnqueue;
    child.dispatchProof = this.dispatchProof === null ? null : clone(this.dispatchProof);
    const result = await work(child);
    this.accounts = child.accounts;
    this.credentials = child.credentials;
    this.versions = child.versions;
    this.auditEvents = child.auditEvents;
    this.validationJobs = child.validationJobs;
    this.byokProfileAccountBindings = child.byokProfileAccountBindings;
    this.failAudit = child.failAudit;
    this.failValidationEnqueue = child.failValidationEnqueue;
    this.dispatchProof = child.dispatchProof;
    return result;
  }

  async appendAuditEvent(input: AppendProviderSupplyAuditEventInput): Promise<void> {
    if (this.failAudit) throw error('AUDIT_WRITE_FAILED');
    this.auditEvents.push(clone(input));
  }

  async createTenantByokProfileAccount(input: PersistedTenantByokProfileAccountInput): Promise<void> {
    this.byokProfileAccountBindings.push(clone(input));
  }

  async readDispatchProof(evidenceId: string): Promise<ProviderCredentialDispatchProof | null> {
    if (this.dispatchProof === null || this.dispatchProof.evidence.evidenceId !== evidenceId) return null;
    return clone(this.dispatchProof);
  }

  async createAccount(input: PersistedProviderAccountInput): Promise<ProviderAccountRecord> {
    const key = ownerKey(input.owner, input.id);
    if (this.accounts.some((account) => ownerKey(account, account.id) === key)) throw error('23505');
    const account: ProviderAccountRecord = {
      ...clone(input.owner),
      id: input.id,
      displayName: input.displayName,
      providerId: input.providerId,
      productId: input.productId,
      credentialType: input.credentialType,
      region: input.region,
      purpose: input.purpose,
      rightsId: input.rightsId,
      rightsVersion: input.rightsVersion,
      capabilities: clone(input.capabilities),
      status: input.status,
      validationState: input.validationState,
      validationErrorCode: null,
      lastValidatedAt: null,
      authzVersion: 1,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      disabledAt: null,
      revokedAt: null,
    };
    this.accounts.push(account);
    return clone(account);
  }

  async getAccount(reference: ProviderAccountReference): Promise<ProviderAccountRecord | null> {
    const account = this.accounts.find((candidate) => ownerKey(candidate, candidate.id) === accountKey(reference));
    return account ? clone(account) : null;
  }

  async listAccounts(filter: ProviderAccountListFilter = {}): Promise<readonly ProviderAccountRecord[]> {
    return clone(
      this.accounts.filter(
        (account) =>
          (filter.ownerKind === undefined || account.ownerKind === filter.ownerKind) &&
          (filter.tenantId === undefined || account.tenantId === filter.tenantId) &&
          (filter.providerId === undefined || account.providerId === filter.providerId) &&
          (filter.productId === undefined || account.productId === filter.productId) &&
          (filter.status === undefined || account.status === filter.status) &&
          (filter.validationState === undefined || account.validationState === filter.validationState),
      ),
    );
  }

  async updateAccountLifecycle(input: UpdateProviderAccountLifecycleInput): Promise<ProviderAccountRecord | null> {
    const index = this.accounts.findIndex((candidate) => ownerKey(candidate, candidate.id) === accountKey(input.account));
    const account = this.accounts[index];
    if (!account || account.authzVersion !== input.expectedAuthzVersion) return null;
    const updated: ProviderAccountRecord = {
      ...account,
      status: input.status,
      disabledAt: input.disabledAt,
      revokedAt: input.revokedAt,
      updatedAt: input.updatedAt,
      authzVersion: account.authzVersion + 1,
    };
    this.accounts[index] = updated;
    return clone(updated);
  }

  async updateAccountValidation(input: UpdateProviderAccountValidationInput): Promise<ProviderAccountRecord | null> {
    const index = this.accounts.findIndex((candidate) => ownerKey(candidate, candidate.id) === accountKey(input.account));
    const account = this.accounts[index];
    if (!account || account.authzVersion !== input.expectedAuthzVersion) return null;
    const updated: ProviderAccountRecord = {
      ...account,
      validationState: input.validationState,
      validationErrorCode: input.validationErrorCode,
      lastValidatedAt: input.lastValidatedAt,
      updatedAt: input.updatedAt,
      authzVersion: account.authzVersion + 1,
    };
    this.accounts[index] = updated;
    return clone(updated);
  }

  async createCredential(input: PersistedProviderCredentialInput): Promise<ProviderCredentialRecord> {
    const key = credentialKey({
      ownerKind: input.owner.ownerKind,
      tenantId: input.owner.tenantId,
      accountId: input.accountId,
      credentialId: input.id,
    });
    if (this.credentials.some((credential) => credentialKey(credential) === key)) throw error('23505');
    const credential: ProviderCredentialRecord = {
      ...clone(input.owner),
      id: input.id,
      accountId: input.accountId,
      providerId: input.providerId,
      productId: input.productId,
      credentialType: input.credentialType,
      status: input.status,
      validationState: input.validationState,
      validationErrorCode: null,
      lastValidatedAt: null,
      currentVersion: null,
      expiresAt: input.expiresAt,
      authzVersion: 1,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      disabledAt: null,
      revokedAt: null,
    };
    this.credentials.push(credential);
    return clone(credential);
  }

  async enqueueProviderCredentialValidationJob(
    input: ProviderCredentialValidationJobInput,
  ): Promise<ProviderCredentialValidationJobRecord> {
    if (this.failValidationEnqueue) throw error('VALIDATION_JOB_WRITE_FAILED');
    const existing = this.validationJobs.find(
      (job) =>
        job.tenantId === input.tenantId &&
        job.credentialId === input.credentialId &&
        job.credentialVersion === input.credentialVersion,
    );
    if (existing) {
      const existingSnapshot = {
        tenantId: existing.tenantId,
        accountId: existing.accountId,
        credentialId: existing.credentialId,
        credentialVersion: existing.credentialVersion,
        providerId: existing.providerId,
        productId: existing.productId,
        credentialType: existing.credentialType,
        allowedModels: existing.allowedModels,
        target: existing.target,
        idempotencyKey: existing.idempotencyKey,
      };
      const inputSnapshot = {
        tenantId: input.tenantId,
        accountId: input.accountId,
        credentialId: input.credentialId,
        credentialVersion: input.credentialVersion,
        providerId: input.providerId,
        productId: input.productId,
        credentialType: input.credentialType,
        allowedModels: input.allowedModels,
        target: input.target,
        idempotencyKey: input.idempotencyKey,
      };
      if (JSON.stringify(existingSnapshot) !== JSON.stringify(inputSnapshot)) {
        throw error('VALIDATION_JOB_IDEMPOTENCY_CONFLICT');
      }
      return clone(existing);
    }
    const now = '2026-09-28T00:00:00.000Z';
    const job: ProviderCredentialValidationJobRecord = {
      ...clone(input),
      id: `validation-job-${this.validationJobs.length + 1}`,
      allowedModels: [...input.allowedModels],
      state: 'queued',
      attemptCount: 0,
      availableAt: now,
      leaseUntil: null,
      leaseGeneration: 0,
      lastErrorCode: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.validationJobs.push(job);
    return clone(job);
  }

  async getCredential(reference: ProviderCredentialReference): Promise<ProviderCredentialRecord | null> {
    const credential = this.credentials.find((candidate) => credentialKey(candidate) === credentialKey(reference));
    return credential ? clone(credential) : null;
  }

  async listCredentials(filter: ProviderCredentialListFilter = {}): Promise<readonly ProviderCredentialRecord[]> {
    return clone(
      this.credentials.filter(
        (credential) =>
          (filter.ownerKind === undefined || credential.ownerKind === filter.ownerKind) &&
          (filter.tenantId === undefined || credential.tenantId === filter.tenantId) &&
          (filter.account === undefined ||
            (credential.ownerKind === filter.account.ownerKind &&
              credential.tenantId === filter.account.tenantId &&
              credential.accountId === filter.account.accountId)) &&
          (filter.status === undefined || credential.status === filter.status) &&
          (filter.validationState === undefined || credential.validationState === filter.validationState),
      ),
    );
  }

  async appendCredentialVersion(
    input: AppendProviderCredentialVersionInput,
  ): Promise<{ readonly credential: ProviderCredentialRecord; readonly version: ProviderCredentialVersionRecord }> {
    const credentialReference: ProviderCredentialReference = input.credential;
    const credentialIndex = this.credentials.findIndex(
      (candidate) => credentialKey(candidate) === credentialKey(credentialReference),
    );
    const credential = this.credentials[credentialIndex];
    if (!credential) throw error('CREDENTIAL_NOT_FOUND');
    if (credential.status === 'revoked') throw error('CREDENTIAL_REVOKED');
    if (credential.currentVersion !== input.expectedCurrentVersion) throw error('CREDENTIAL_VERSION_CONFLICT');
    const key = versionKey(input.credential);
    if (this.versions.some((version) => versionKey(version) === key)) throw error('23505');
    const currentVersion = credential.currentVersion;
    if (currentVersion !== null) {
      const previousIndex = this.versions.findIndex(
        (version) => versionKey(version) === versionKey({ ...credentialReference, version: currentVersion }),
      );
      const previous = this.versions[previousIndex];
      if (previous) {
        this.versions[previousIndex] = { ...previous, status: 'retired', retiredAt: input.createdAt };
      }
    }
    const version: StoredProviderCredentialVersion = {
      ownerKind: credential.ownerKind,
      tenantId: credential.tenantId,
      accountId: credential.accountId,
      credentialId: credential.id,
      version: input.credential.version,
      status: 'active',
      envelopeSchemaVersion: input.envelope.schemaVersion,
      contextVersion: input.envelope.contextVersion,
      algorithm: input.envelope.algorithm,
      kmsPurpose: input.kmsPurpose,
      wrappingRevision: input.wrappingRevision,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      retiredAt: null,
      revokedAt: null,
      kmsKeyId: input.envelope.kmsKeyId,
      envelope: clone(input.envelope),
    };
    this.versions.push(version);
    const updated: ProviderCredentialRecord = {
      ...credential,
      currentVersion: input.credential.version,
      status: credential.status === 'active' ? 'pending' : credential.status,
      validationState: 'unverified',
      validationErrorCode: null,
      lastValidatedAt: null,
      expiresAt: input.expiresAt,
      updatedAt: input.createdAt,
      authzVersion: credential.authzVersion + 1,
    };
    this.credentials[credentialIndex] = updated;
    this.validationJobs = this.validationJobs.map((job): ProviderCredentialValidationJobRecord => {
      if (
        job.tenantId === credential.tenantId &&
        job.credentialId === credential.id &&
        (job.state === 'queued' || job.state === 'leased')
      ) {
        return {
          ...job,
          state: 'cancelled',
          leaseUntil: null,
          leaseGeneration: job.leaseGeneration + 1,
          lastErrorCode: 'credential_changed',
          completedAt: input.createdAt,
          updatedAt: input.createdAt,
        };
      }
      return job;
    });
    return { credential: clone(updated), version: publicVersion(version) };
  }

  async updateCredentialLifecycle(
    input: UpdateProviderCredentialLifecycleInput,
  ): Promise<ProviderCredentialRecord | null> {
    const credentialIndex = this.credentials.findIndex(
      (candidate) => credentialKey(candidate) === credentialKey(input.credential),
    );
    const credential = this.credentials[credentialIndex];
    if (!credential || credential.authzVersion !== input.expectedAuthzVersion) return null;
    const updated: ProviderCredentialRecord = {
      ...credential,
      status: input.status,
      disabledAt: input.disabledAt,
      revokedAt: input.revokedAt,
      updatedAt: input.updatedAt,
      authzVersion: credential.authzVersion + 1,
    };
    this.credentials[credentialIndex] = updated;
    const currentVersion = credential.currentVersion;
    if (input.status === 'revoked' && currentVersion !== null) {
      const currentIndex = this.versions.findIndex(
        (version) => versionKey(version) === versionKey({ ...input.credential, version: currentVersion }),
      );
      const current = this.versions[currentIndex];
      if (current) {
        this.versions[currentIndex] = {
          ...current,
          status: 'revoked',
          revokedAt: input.revokedAt ?? input.updatedAt,
        };
      }
    }
    return clone(updated);
  }

  async updateCredentialValidation(
    input: UpdateProviderCredentialValidationInput,
  ): Promise<ProviderCredentialRecord | null> {
    const credentialIndex = this.credentials.findIndex(
      (candidate) => credentialKey(candidate) === credentialKey(input.credential),
    );
    const credential = this.credentials[credentialIndex];
    if (!credential || credential.authzVersion !== input.expectedAuthzVersion) return null;
    const updated: ProviderCredentialRecord = {
      ...credential,
      validationState: input.validationState,
      validationErrorCode: input.validationErrorCode,
      lastValidatedAt: input.lastValidatedAt,
      status: credential.status === 'revoked' || credential.status === 'disabled'
        ? credential.status : input.validationState === 'verified' ? 'active' : 'pending',
      updatedAt: input.updatedAt,
      authzVersion: credential.authzVersion + 1,
    };
    this.credentials[credentialIndex] = updated;
    return clone(updated);
  }

  async getCredentialVersion(
    reference: ProviderCredentialReference & { readonly version: number },
  ): Promise<ProviderCredentialVersionRecord | null> {
    const value = this.versions.find((version) => versionKey(version) === versionKey(reference));
    return value ? publicVersion(value) : null;
  }

  async listCredentialVersions(
    credential: ProviderCredentialReference,
  ): Promise<readonly ProviderCredentialVersionRecord[]> {
    return clone(
      this.versions.filter(
        (version) => versionKey(version) === versionKey({ ...credential, version: version.version }),
      ),
    ).map(publicVersion);
  }

  async getCredentialVersionEnvelope(
    reference: ProviderCredentialReference & { readonly version: number },
  ): Promise<StoredProviderCredentialVersion | null> {
    const value = this.versions.find((version) => versionKey(version) === versionKey(reference));
    return value ? clone(value) : null;
  }

  resetValidation(reference: ProviderAccountReference): void {
    const index = this.accounts.findIndex((candidate) => ownerKey(candidate, candidate.id) === accountKey(reference));
    const account = this.accounts[index];
    if (account) this.accounts[index] = { ...account, validationState: 'unverified' satisfies ProviderValidationState };
  }
}

export function createTenantDispatchProof(
  repository: FakeProviderSupplyRepository,
  overrides: {
    readonly evidence?: Partial<ProviderCredentialDispatchProof['evidence']>;
    readonly attempt?: Partial<ProviderCredentialDispatchProof['attempt']>;
    readonly account?: Partial<ProviderCredentialDispatchProof['account']>;
    readonly credential?: Partial<ProviderCredentialDispatchProof['credential']>;
    readonly profile?: Partial<ProviderCredentialDispatchProof['profile']>;
    readonly profileAccount?: Partial<NonNullable<ProviderCredentialDispatchProof['profileAccount']>>;
  } = {},
): ProviderCredentialDispatchProof {
  const account = repository.accounts[0];
  const credential = repository.credentials[0];
  const version = repository.versions.find((candidate) => candidate.version === credential?.currentVersion);
  if (!account || !credential || !version || account.ownerKind !== 'tenant' || credential.ownerKind !== 'tenant') {
    throw new Error('tenant dispatch proof fixture requires one tenant account, credential, and version');
  }
  const credentialVersion = credential.currentVersion ?? version.version;
  const binding = {
    tenantId: account.tenantId,
    requestId: 'request-a',
    attemptId: 'attempt-a',
    attemptOrdinal: 1,
    supplyMode: 'byok' as const,
    accountOwnerKind: 'tenant' as const,
    accountId: account.id,
    providerId: account.providerId,
    productId: account.productId,
    protocol: 'openai' as const,
    endpoint: 'chat-completions',
    routeConfigId: 'route-a',
    routeConfigVersion: 1,
    routePublicModelId: 'public-model-a',
    routePublicModelVersion: 1,
    routeProtocol: 'openai' as const,
    routeTargetMode: 'tenant_account' as const,
    routeUpstreamId: 'upstream-a',
    upstreamId: 'upstream-a',
    resolvedModel: 'model-a',
    dispatchProfileId: 'profile-a',
    supplyProfileAuthzVersion: 1,
    credentialId: credential.id,
    credentialVersion,
    credentialAuthzVersion: credential.authzVersion,
    accountAuthzVersion: account.authzVersion,
    profileAccountAuthzVersion: 1,
    poolId: null,
    poolAuthzVersion: null,
    poolMemberAccountAuthzVersion: null,
    poolMemberAuthzVersion: null,
    poolGrantAuthzVersion: null,
    poolGrantProfileAuthzVersion: null,
    poolGrantPoolAuthzVersion: null,
  };
  const evidence: ProviderCredentialDispatchProof['evidence'] = {
    ...binding,
    evidenceId: 'evidence-a',
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 1,
    publicModel: 'public-model-a',
    status: 'claimed',
    claimedAt: '2026-09-28T00:00:01.000Z',
    claimedAttemptId: 'attempt-a',
    dispatchDeadline: '2026-09-28T00:05:00.000Z',
    expiresAt: '2026-09-28T00:10:00.000Z',
    ...overrides.evidence,
  };
  const attempt: ProviderCredentialDispatchProof['attempt'] = {
    ...binding,
    preparedEvidenceId: 'evidence-a',
    dispatchAuthorityState: 'bound',
    dispatchState: 'dispatching',
    resultState: 'pending',
    responseStarted: false,
    ...overrides.attempt,
  };
  const accountSnapshotValues = {
    ownerKind: account.ownerKind,
    tenantId: account.tenantId,
    supplyMode: account.supplyMode,
    id: account.id,
    providerId: account.providerId,
    productId: account.productId,
    credentialType: account.credentialType,
    purpose: account.purpose,
    status: account.status,
    validationState: account.validationState,
    authzVersion: account.authzVersion,
    ...overrides.account,
  };
  const accountSnapshot: ProviderCredentialDispatchProof['account'] = {
    ...accountSnapshotValues,
    ...snapshotOwner(accountSnapshotValues),
  };
  const credentialSnapshotValues = {
    ownerKind: credential.ownerKind,
    tenantId: credential.tenantId,
    supplyMode: credential.supplyMode,
    id: credential.id,
    accountId: credential.accountId,
    providerId: credential.providerId,
    productId: credential.productId,
    status: credential.status,
    validationState: credential.validationState,
    currentVersion: credential.currentVersion,
    expiresAt: credential.expiresAt,
    authzVersion: credential.authzVersion,
    ...overrides.credential,
  };
  const credentialSnapshot: ProviderCredentialDispatchProof['credential'] = {
    ...credentialSnapshotValues,
    ...snapshotOwner(credentialSnapshotValues),
  };
  const profile: ProviderCredentialDispatchProof['profile'] = {
    tenantId: account.tenantId,
    id: 'profile-a',
    supplyMode: 'byok',
    status: 'active',
    authzVersion: 1,
    ...overrides.profile,
  };
  const profileAccount: NonNullable<ProviderCredentialDispatchProof['profileAccount']> = {
    tenantId: account.tenantId,
    supplyProfileId: 'profile-a',
    supplyMode: 'byok',
    accountId: account.id,
    providerId: account.providerId,
    productId: account.productId,
    accountAuthzVersion: account.authzVersion,
    status: 'active',
    authzVersion: 1,
    effectiveAt: '2026-09-27T00:00:00.000Z',
    expiresAt: null,
    ...overrides.profileAccount,
  };
  return {
    evidence,
    attempt,
    account: accountSnapshot,
    credential: credentialSnapshot,
    version: clone(version),
    profile,
    profileAccount,
    pool: null,
    poolMember: null,
    poolGrant: null,
    claimAudit: {
      action: 'saas_prepared_request_evidence.claimed',
      targetType: 'saas_prepared_request_evidence',
      targetId: 'evidence-a',
    },
  };
}
