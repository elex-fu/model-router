import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BULK_ACCOUNT_IMPORT_SAAS_MIGRATION } from '../../../src/saas/db/migrations/150_bulk_account_import.js';
import {
  BULK_IMPORT_PROVIDERS,
  BulkAccountImportService,
  type BulkImportCredentialSink,
  type BulkImportItemClaim,
  type BulkImportItemFailure,
  type BulkImportItemRecord,
  type BulkImportItemSuccess,
  type BulkImportJobCreate,
  type BulkImportJobRecord,
  type BulkImportProvider,
  type BulkImportSinkInput,
  type BulkImportStore,
  type BulkImportValidationRequest,
} from '../../../src/saas/supply/bulk-import-service.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const EGRESS_PROXY = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-02T03:04:05.000Z';

class FakeBulkImportStore implements BulkImportStore {
  readonly jobs: BulkImportJobRecord[] = [];
  readonly items: BulkImportItemRecord[] = [];

  private job(jobId: string): BulkImportJobRecord {
    const job = this.jobs.find((entry) => entry.id === jobId);
    assert.ok(job, `missing fake job ${jobId}`);
    return job;
  }

  private item(jobId: string, itemIndex: number): BulkImportItemRecord {
    const item = this.items.find((entry) => entry.jobId === jobId && entry.itemIndex === itemIndex);
    assert.ok(item, `missing fake item ${jobId}/${itemIndex}`);
    return item;
  }

  private putJob(job: BulkImportJobRecord): void {
    const index = this.jobs.findIndex((entry) => entry.id === job.id);
    assert.ok(index >= 0);
    this.jobs[index] = job;
  }

  private putItem(item: BulkImportItemRecord): void {
    const index = this.items.findIndex((entry) => entry.jobId === item.jobId && entry.itemIndex === item.itemIndex);
    assert.ok(index >= 0);
    this.items[index] = item;
  }

  private count(jobId: string, success: number, failure: number, updatedAt: string): void {
    const job = this.job(jobId);
    this.putJob({
      ...job,
      successCount: job.successCount + success,
      failureCount: job.failureCount + failure,
      updatedAt,
    });
  }

  async createJob(input: BulkImportJobCreate): Promise<BulkImportJobRecord> {
    const job: BulkImportJobRecord = {
      id: input.id,
      status: 'running',
      totalCount: input.totalCount,
      successCount: 0,
      failureCount: 0,
      createdBy: input.createdBy,
      errorSummary: {},
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      completedAt: null,
    };
    this.jobs.push(job);
    return job;
  }

  async claimItem(input: BulkImportItemClaim) {
    const existing = this.items.find(
      (entry) =>
        entry.provider === input.provider &&
        entry.credentialFingerprint === input.credentialFingerprint &&
        entry.status === 'succeeded',
    );
    if (existing?.accountRef) {
      const item: BulkImportItemRecord = {
        jobId: input.jobId,
        itemIndex: input.itemIndex,
        provider: input.provider,
        credentialFingerprint: input.credentialFingerprint,
        status: 'deduplicated',
        accountRef: existing.accountRef,
        errorReason: null,
        displayName: input.displayName,
        egressProxyId: input.egressProxyId,
        validationState: 'not_requested',
        optionWarnings: [...input.optionWarnings],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        completedAt: input.createdAt,
      };
      this.items.push(item);
      this.count(input.jobId, 1, 0, input.createdAt);
      return { kind: 'deduplicated' as const, item };
    }
    this.items.push({
      jobId: input.jobId,
      itemIndex: input.itemIndex,
      provider: input.provider,
      credentialFingerprint: input.credentialFingerprint,
      status: 'pending',
      accountRef: null,
      errorReason: null,
      displayName: input.displayName,
      egressProxyId: input.egressProxyId,
      validationState: 'pending_validation',
      optionWarnings: [...input.optionWarnings],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      completedAt: null,
    });
    return { kind: 'claimed' as const };
  }

  async succeedItem(input: BulkImportItemSuccess): Promise<BulkImportItemRecord> {
    const pending = this.item(input.jobId, input.itemIndex);
    assert.equal(pending.status, 'pending');
    const item: BulkImportItemRecord = {
      ...pending,
      status: 'succeeded',
      accountRef: input.accountRef,
      validationState: input.validationState,
      errorReason: input.errorReason,
      updatedAt: input.completedAt,
      completedAt: input.completedAt,
    };
    this.putItem(item);
    this.count(input.jobId, 1, 0, input.completedAt);
    return item;
  }

  async failItem(input: BulkImportItemFailure): Promise<BulkImportItemRecord> {
    const pending = this.item(input.jobId, input.itemIndex);
    assert.equal(pending.status, 'pending');
    const item: BulkImportItemRecord = {
      ...pending,
      status: 'failed',
      errorReason: input.errorReason,
      validationState: 'not_requested',
      updatedAt: input.completedAt,
      completedAt: input.completedAt,
    };
    this.putItem(item);
    this.count(input.jobId, 0, 1, input.completedAt);
    return item;
  }

  async completeJob(input: {
    readonly jobId: string;
    readonly errorSummary: Readonly<Record<string, number>>;
    readonly completedAt: string;
  }): Promise<BulkImportJobRecord> {
    const current = this.job(input.jobId);
    assert.equal(current.successCount + current.failureCount, current.totalCount);
    assert.equal(
      this.items.some((item) => item.jobId === input.jobId && item.status === 'pending'),
      false,
    );
    const job: BulkImportJobRecord = {
      ...current,
      status: 'completed',
      errorSummary: { ...input.errorSummary },
      updatedAt: input.completedAt,
      completedAt: input.completedAt,
    };
    this.putJob(job);
    return job;
  }
}

class FakeSink implements BulkImportCredentialSink {
  readonly calls: BulkImportSinkInput[] = [];

  constructor(
    private readonly provider: BulkImportProvider,
    private readonly handler?: (input: BulkImportSinkInput) => Promise<{ readonly accountRef: string }>,
    readonly capabilities?: { readonly displayName?: boolean; readonly egressProxyId?: boolean },
  ) {}

  async accept(input: BulkImportSinkInput): Promise<{ readonly accountRef: string }> {
    this.calls.push(input);
    if (this.handler) return this.handler(input);
    return { accountRef: `account-${this.provider}-${this.calls.length}` };
  }
}

function sinks(): Record<BulkImportProvider, FakeSink> {
  return {
    codex: new FakeSink('codex'),
    claude: new FakeSink('claude'),
    gemini: new FakeSink('gemini'),
    grok: new FakeSink('grok'),
  };
}

function fixture(label: string) {
  const value = (part: string) => ['fixture', label, part].join(':');
  const access = value('access');
  return {
    access,
    material: {
      tokens: {
        access_token: access,
        refresh_token: value('refresh'),
        account_id: value('account'),
      },
    },
  };
}

function service(
  store: FakeBulkImportStore,
  providers: Record<BulkImportProvider, FakeSink>,
  validationQueue?: { enqueue(input: BulkImportValidationRequest): Promise<void> },
): BulkAccountImportService {
  let sequence = 0;
  return new BulkAccountImportService({
    store,
    sinks: providers,
    fingerprintKey: Buffer.alloc(32, sequence + 1),
    ...(validationQueue ? { validationQueue } : {}),
    now: () => new Date(NOW),
    newId: () => {
      sequence += 1;
      return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
    },
  });
}

test('mixed batch isolates item failure, preserves counters, passes options and enqueues successes', async () => {
  const store = new FakeBulkImportStore();
  const good = fixture('mixed-good');
  const bad = fixture('mixed-bad');
  const providers = sinks();
  providers.claude = new FakeSink('claude', async () => {
    throw Object.assign(new Error(`upstream rejected ${bad.access}`), { code: 'CREDENTIALS_JSON_INVALID' });
  });
  const validationCalls: BulkImportValidationRequest[] = [];
  const result = await service(store, providers, {
    enqueue: async (input) => {
      validationCalls.push(input);
    },
  }).importAccounts({
    audit: { actorUserId: ACTOR, sourceIp: '127.0.0.1', userAgent: 'operator-console' },
    items: [
      { provider: 'codex', material: good.material, displayName: 'Codex batch A', egressProxyId: EGRESS_PROXY },
      { provider: 'claude', material: bad.material },
      { provider: 'gemini', material: fixture('mixed-other').material },
    ],
  });

  assert.equal(result.job.status, 'completed');
  assert.equal(result.job.totalCount, 3);
  assert.equal(result.job.successCount, 2);
  assert.equal(result.job.failureCount, 1);
  assert.deepEqual(result.job.errorSummary, { CREDENTIALS_JSON_INVALID: 1 });
  assert.deepEqual(
    result.items.map((item) => item.status),
    ['succeeded', 'failed', 'succeeded'],
  );
  assert.equal(result.items[1]?.errorReason, 'CREDENTIALS_JSON_INVALID');
  assert.equal(JSON.stringify(store).includes(bad.access), false);
  assert.equal(validationCalls.length, 2);
  assert.deepEqual(
    validationCalls.map((call) => call.provider),
    ['codex', 'gemini'],
  );
  assert.equal(validationCalls[0]?.reason, 'bulk_account_import');
  assert.equal(validationCalls[0]?.audit.actorUserId, ACTOR);
  assert.match(validationCalls[0]?.idempotencyKey ?? '', /^[0-9a-f]{64}$/);
  assert.equal(result.items[0]?.validationState, 'queued');
  assert.equal(result.items[0]?.egressProxyId, EGRESS_PROXY);
  assert.deepEqual(result.items[0]?.optionWarnings, ['DISPLAY_NAME_UNSUPPORTED', 'EGRESS_PROXY_ID_UNSUPPORTED']);
  assert.equal(providers.codex.calls[0]?.displayName, 'Codex batch A');
  assert.equal(providers.codex.calls[0]?.egressProxyId, EGRESS_PROXY);
});

test('without a validation callback a new account remains pending_validation', async () => {
  const store = new FakeBulkImportStore();
  const result = await service(store, sinks()).importAccounts({
    audit: { actorUserId: ACTOR },
    items: [{ provider: 'grok', material: fixture('pending-validation').material }],
  });
  assert.equal(result.job.successCount, 1);
  assert.equal(result.items[0]?.validationState, 'pending_validation');
  assert.equal(result.items[0]?.status, 'succeeded');
});

test('canonical HMAC idempotency returns the original account without another sink call', async () => {
  const store = new FakeBulkImportStore();
  const providers = sinks();
  const validationCalls: BulkImportValidationRequest[] = [];
  const importer = service(store, providers, {
    enqueue: async (input) => {
      validationCalls.push(input);
    },
  });
  const original = fixture('canonical');
  const first = await importer.importAccounts({
    audit: { actorUserId: ACTOR },
    items: [{ provider: 'codex', material: original.material }],
  });
  const reordered = {
    tokens: {
      account_id: original.material.tokens.account_id,
      refresh_token: original.material.tokens.refresh_token,
      access_token: original.material.tokens.access_token,
    },
  };
  const second = await importer.importAccounts({
    audit: { actorUserId: ACTOR },
    items: [{ provider: 'codex', material: reordered }],
  });

  assert.equal(providers.codex.calls.length, 1);
  assert.equal(validationCalls.length, 1);
  assert.equal(second.items[0]?.status, 'deduplicated');
  assert.equal(second.items[0]?.accountRef, first.items[0]?.accountRef);
  assert.equal(second.items[0]?.credentialFingerprint, first.items[0]?.credentialFingerprint);
  assert.equal(second.items[0]?.validationState, 'not_requested');
  assert.equal(second.job.successCount, 1);
  assert.equal(second.job.failureCount, 0);
});

test('only HMAC fingerprints and safe error codes are persisted, never plaintext material or messages', async () => {
  const store = new FakeBulkImportStore();
  const first = fixture('fingerprint-a');
  const second = fixture('fingerprint-b');
  const result = await service(store, sinks()).importAccounts({
    audit: { actorUserId: ACTOR },
    items: [
      { provider: 'codex', material: first.material },
      { provider: 'codex', material: second.material },
    ],
  });
  const firstFingerprint = result.items[0]?.credentialFingerprint ?? '';
  const secondFingerprint = result.items[1]?.credentialFingerprint ?? '';
  assert.match(firstFingerprint, /^[0-9a-f]{64}$/);
  assert.match(secondFingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(firstFingerprint, secondFingerprint);
  assert.notEqual(firstFingerprint, first.access);
  assert.equal(JSON.stringify(store).includes(first.access), false);
  assert.equal(JSON.stringify(store).includes(second.access), false);
});

test('validation enqueue failure does not roll back a created account or corrupt success counters', async () => {
  const store = new FakeBulkImportStore();
  const result = await service(store, sinks(), {
    enqueue: async () => {
      throw Object.assign(new Error('queue transport detail must not persist'), { code: 'QUEUE_UNAVAILABLE' });
    },
  }).importAccounts({
    audit: { actorUserId: ACTOR },
    items: [{ provider: 'claude', material: fixture('queue-failure').material }],
  });
  assert.equal(result.items[0]?.status, 'succeeded');
  assert.equal(result.items[0]?.validationState, 'queue_failed');
  assert.equal(result.items[0]?.errorReason, 'QUEUE_UNAVAILABLE');
  assert.equal(result.job.successCount, 1);
  assert.equal(result.job.failureCount, 0);
  assert.deepEqual(result.job.errorSummary, {});
});

test('declared sink option support suppresses unsupported-option reports', async () => {
  const store = new FakeBulkImportStore();
  const providers = sinks();
  providers.gemini = new FakeSink('gemini', undefined, { displayName: true, egressProxyId: true });
  const result = await service(store, providers).importAccounts({
    audit: { actorUserId: ACTOR },
    items: [
      {
        provider: 'gemini',
        material: fixture('supported-options').material,
        displayName: 'Gemini batch A',
        egressProxyId: EGRESS_PROXY,
      },
    ],
  });
  assert.deepEqual(result.items[0]?.optionWarnings, []);
  assert.equal(providers.gemini.calls[0]?.displayName, 'Gemini batch A');
  assert.equal(providers.gemini.calls[0]?.egressProxyId, EGRESS_PROXY);
});

test('migration 150 is standalone and constrains jobs, items, fingerprints and idempotency indexes', () => {
  const migration = BULK_ACCOUNT_IMPORT_SAAS_MIGRATION;
  assert.equal(migration.version, 150);
  assert.equal(migration.name, 'bulk_account_import');
  assert.doesNotMatch(migration.sql, /SAAS_MIGRATIONS|001_initial_schema/);
  assert.match(migration.sql, /CREATE TABLE saas_bulk_import_job \(/);
  assert.match(migration.sql, /CREATE TABLE saas_bulk_import_item \(/);
  assert.match(migration.sql, /PRIMARY KEY \(job_id, item_index\)/);
  assert.match(migration.sql, /provider IN \('codex', 'claude', 'gemini', 'grok'\)/);
  assert.match(migration.sql, /credential_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration.sql, /CREATE UNIQUE INDEX saas_bulk_import_item_active_credential_uidx/);
  assert.match(migration.sql, /WHERE status IN \('pending', 'succeeded'\)/);
  assert.match(migration.sql, /FOREIGN KEY \(account_ref\) REFERENCES saas_platform_provider_accounts \(id\)/);
  assert.match(migration.sql, /success_count \+ failure_count = total_count/);
  assert.match(
    migration.sql,
    /validation_state IN \('pending_validation', 'queued', 'queue_failed', 'not_requested'\)/,
  );
  assert.doesNotMatch(migration.sql, /(?:access_token|refresh_token|credential_material|secret)\s+(?:text|jsonb)/i);
  assert.deepEqual(BULK_IMPORT_PROVIDERS, ['codex', 'claude', 'gemini', 'grok']);
});
