import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createProviderCredentialContext,
  type ProviderCredentialEnvelope,
  type ProviderCredentialKms,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import {
  type GatewayProviderCredentialAccount,
  type GatewayProviderCredentialCredential,
  GatewayProviderCredentialUnsealer,
} from '../../../src/saas/runtime/gateway-provider-credential-unsealer.js';
import type { ProviderCredentialValidationFetch } from '../../../src/saas/supply/credential-validation-adapters.js';
import { compileApprovedCredentialValidationTargets } from '../../../src/saas/supply/credential-validation-targets.js';
import {
  CREDENTIAL_VALIDATION_QUARANTINE_REVALIDATION_SECONDS,
  CredentialValidationWorker,
  CredentialValidationWorkerError,
  type CredentialValidationWorkerOptions,
  PostgresCredentialValidationWorkerStore,
  PROVIDER_ACCOUNT_QUARANTINE_AUDIT_ACTION,
  PROVIDER_ACCOUNT_QUARANTINE_FAILURE_THRESHOLD,
  type ProviderAccountQuarantineAuditEvent,
} from '../../../src/saas/supply/credential-validation-worker.js';
import { ProviderSupplyPersistenceService } from '../../../src/saas/supply/persistence-service.js';
import {
  approvedTarget,
  probeEnvelope,
  validationHttpsFixture,
  waitForValidationFixtureSignal,
} from './credential-validation-test-fixture.js';
import { FakeProviderSupplyRepository } from './fake-repository.js';

const DATA_KEY = Buffer.alloc(32, 23);
function contextKey(context: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(context).sort(([left], [right]) => left.localeCompare(right)));
}

class ContextBoundTestKms implements ProviderCredentialKms {
  readonly requestedContexts: string[] = [];
  private readonly entries = new Map<
    string,
    { readonly key: Buffer; readonly context: string; readonly kmsKeyId: string }
  >();
  private sequence = 0;

  async generateDataKey(request: Parameters<ProviderCredentialKms['generateDataKey']>[0]) {
    const plaintextKey = randomBytes(32);
    const ciphertextBlob = Buffer.from(`wrapped-persistence-${this.sequence}`, 'utf8');
    this.sequence += 1;
    const context = contextKey(request.encryptionContext);
    this.requestedContexts.push(context);
    this.entries.set(ciphertextBlob.toString('base64url'), {
      key: Buffer.from(plaintextKey),
      context,
      kmsKeyId: request.kmsKeyId,
    });
    return { plaintextKey, ciphertextBlob };
  }

  async decryptDataKey(request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]): Promise<Uint8Array> {
    const entry = this.entries.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    const context = contextKey(request.encryptionContext);
    this.requestedContexts.push(context);
    if (!entry || entry.kmsKeyId !== request.kmsKeyId || entry.context !== context) {
      throw new Error('KMS encryption context mismatch');
    }
    return Buffer.from(entry.key);
  }
}

interface WorkerTarget {
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly protocol: string;
  /** Defaults to api-key for the pre-existing fixtures. */
  readonly credentialType?: string;
}

function targetCredentialType(target: WorkerTarget): string {
  return target.credentialType ?? 'api-key';
}

const chatTarget: WorkerTarget = {
  providerId: 'kimi',
  productId: 'kimi-platform',
  model: 'model-a',
  endpoint: 'chat-completions',
  protocol: 'openai-compatible',
};
const messagesTargets = [
  {
    providerId: 'kimi',
    productId: 'kimi-code',
    model: 'kimi-for-coding',
    endpoint: 'messages',
    protocol: 'anthropic-compatible',
    url: 'https://api.kimi.com/coding/v1/messages',
  },
  {
    providerId: 'kimi',
    productId: 'kimi-code-global',
    model: 'kimi-for-coding',
    endpoint: 'messages',
    protocol: 'anthropic-compatible',
    url: 'https://api.kimi.ai/coding/v1/messages',
  },
  {
    providerId: 'deepseek',
    productId: 'deepseek-anthropic',
    model: 'deepseek-flash',
    endpoint: 'messages',
    protocol: 'anthropic-compatible',
    url: 'https://api.deepseek.com/anthropic/v1/messages',
  },
] as const;

function messagesResponse(model: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg-worker-test',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

interface FakeWorkerState {
  rightsCurrent: boolean;
  capabilityCurrent: boolean;
  capabilityProtocol: string;
  capabilityEvidenceSha256: string | null;
  leaseCurrent: boolean;
  requestedCapabilityProtocols: string[];
  jobStatus: string;
  leaseGeneration: number;
  attemptCount: number;
  /** D3: whether the account's revalidation cadence is configured and due. */
  revalidationDue: boolean;
  /** R5: whether the quarantine cadence ($2 sweep parameter) is due. */
  quarantineDue: boolean;
  credentialStatus: string;
  credentialValidationState: string;
  /** Raw credential health UPDATE statements, in write order (R4 force-flag assertions). */
  credentialHealthStatements: string[];
  accountStatus: string;
  accountValidationState: string;
  accountValidationErrorCode: string | null;
  /** Raw account health UPDATE statements, in write order (R5 CASE assertions). */
  accountHealthStatements: string[];
  /** R5 quarantine entries admitted by the fake's failed-only gate, in order. */
  quarantineEntries: { readonly reasonCode: string }[];
  healthWrites: string[];
  envelope: ProviderCredentialEnvelope;
}

class FakeValidationDatabase implements SaasDatabase {
  readonly state: FakeWorkerState;
  decryptCalls = 0;
  /** Owner queue polled per claim cycle, in worker poll order (tenant first). */
  readonly candidateQueries: string[] = [];
  /** Owner scope swept per D3 revalidation sweep, in worker scope order. */
  readonly sweepQueries: string[] = [];
  lastSweepBatchSize: number | null = null;
  /** R5: the $2 quarantine cadence observed on the latest sweep, per scope order. */
  lastSweepQuarantineSeconds: number | null = null;

  constructor(
    envelope: ProviderCredentialEnvelope,
    private readonly target: WorkerTarget = chatTarget,
    readonly owner: 'tenant' | 'platform' = 'tenant',
  ) {
    this.state = {
      rightsCurrent: true,
      capabilityCurrent: true,
      capabilityProtocol: target.protocol,
      capabilityEvidenceSha256: null,
      leaseCurrent: true,
      requestedCapabilityProtocols: [],
      jobStatus: 'queued',
      leaseGeneration: 0,
      attemptCount: 0,
      revalidationDue: false,
      quarantineDue: false,
      credentialStatus: 'pending',
      credentialValidationState: 'unverified',
      credentialHealthStatements: [],
      accountStatus: 'pending',
      accountValidationState: 'unverified',
      accountValidationErrorCode: null,
      accountHealthStatements: [],
      quarantineEntries: [],
      healthWrites: [],
      envelope,
    };
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const rows = this.execute(sql, values);
    return { rows: rows as Row[], rowCount: rows.length };
  }

  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work({ query: <Row>(sql: string, values?: readonly unknown[]) => this.query<Row>(sql, values) });
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  private execute(sql: string, values: readonly unknown[]): unknown[] {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (statement === 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE') return [];
    if (statement.startsWith('SELECT pg_advisory_xact_lock')) return [];
    if (
      statement.startsWith('SELECT id, tenant_id, account_id, credential_id, credential_version, provider_id') &&
      statement.includes('WHERE id = $1')
    ) {
      return [this.jobRow()];
    }
    if (
      statement.startsWith(
        'SELECT id, tenant_id, account_id, credential_id, credential_version FROM saas_tenant_provider_credential_validation_jobs',
      )
    ) {
      this.candidateQueries.push('tenant');
      // A platform-owner fixture owns no tenant queue: the worker must fall
      // through to the platform scope instead of claiming a tenant job.
      if (this.owner !== 'tenant') return [];
      // The real candidate select filters status = 'queued' (or an expired
      // lease): terminal jobs are never claimable until the D3 sweep
      // transitions them back to queued.
      if (this.isTerminal()) return [];
      return [
        {
          id: 'job-a',
          tenant_id: 'tenant-a',
          account_id: 'account-a',
          credential_id: 'credential-a',
          credential_version: 1,
        },
      ];
    }
    if (statement.startsWith('SELECT job.id FROM saas_tenant_provider_credential_validation_jobs AS job')) {
      return [{ id: 'job-a' }];
    }
    if (statement.includes('FROM saas_tenant_provider_accounts') && statement.startsWith('SELECT')) {
      return [
        {
          id: 'account-a',
          tenant_id: 'tenant-a',
          provider_id: this.target.providerId,
          product_id: this.target.productId,
          credential_type: targetCredentialType(this.target),
          region: 'test-region',
          purpose: 'inference',
          rights_id: 'rights-a',
          rights_version: 1,
          status: 'pending',
          validation_state: 'unverified',
          authz_version: 1,
        },
      ];
    }
    if (statement.includes('FROM saas_tenant_provider_credentials') && statement.startsWith('SELECT')) {
      return [
        {
          id: 'credential-a',
          tenant_id: 'tenant-a',
          account_id: 'account-a',
          provider_id: this.target.providerId,
          product_id: this.target.productId,
          credential_type: targetCredentialType(this.target),
          status: 'pending',
          validation_state: 'unverified',
          current_version: 1,
          expires_at: null,
          authz_version: 1,
        },
      ];
    }
    if (statement.includes('JOIN saas_provider_rights AS rights')) {
      assert.match(statement, /rights\.status = 'active'/);
      assert.match(
        statement,
        new RegExp(`rights\\.supply_mode = '${this.owner === 'platform' ? 'platform' : 'byok'}'`),
      );
      assert.match(statement, /rights\.model_scope @> ARRAY\[\$8\]::text\[\]/);
      assert.match(statement, /rights\.endpoint_scope @> ARRAY\[\$9\]::text\[\]/);
      assert.match(statement, /newer\.version > rights\.version/);
      assert.equal(values[0], this.target.providerId);
      assert.equal(values[1], this.target.productId);
      assert.equal(values[7], this.target.model);
      assert.equal(values[8], this.target.endpoint);
      return this.state.rightsCurrent ? [{ rights_id: 'rights-a' }] : [];
    }
    if (statement.includes('JOIN saas_tenant_provider_account_capabilities AS binding')) {
      assert.match(statement, /capability\.protocol = \$8/);
      assert.match(statement, /capability\.support_level = 'supported'/);
      assert.match(statement, /capability\.validation_state = 'verified'/);
      assert.match(statement, /newer\.version > capability\.version/);
      assert.equal(values[4], this.target.model);
      assert.equal(values[5], this.target.endpoint);
      assert.equal(values[6], 1);
      assert.ok(typeof values[7] === 'string');
      this.state.requestedCapabilityProtocols.push(values[7]);
      const digestMatches = values.length === 8 || values[8] === this.state.capabilityEvidenceSha256;
      if (values.length > 8) {
        assert.match(statement, /capability\.evidence_sha256 = \$9/);
        assert.match(statement, /\$10::timestamptz > clock_timestamp\(\)/);
      }
      return this.state.capabilityCurrent && this.state.capabilityProtocol === values[7] && digestMatches
        ? [{ version: 1 }]
        : [];
    }
    if (statement.includes('FROM saas_tenant_provider_credential_versions') && statement.startsWith('SELECT')) {
      return [
        {
          tenant_id: 'tenant-a',
          account_id: 'account-a',
          credential_id: 'credential-a',
          version: 1,
          status: 'active',
          schema_version: this.state.envelope.schemaVersion,
          context_version: this.state.envelope.contextVersion,
          algorithm: this.state.envelope.algorithm,
          kms_purpose: 'inference',
          kms_key_id: this.state.envelope.kmsKeyId,
          wrapping_revision: 1,
          wrapped_dek: this.state.envelope.wrappedDek,
          nonce: this.state.envelope.nonce,
          ciphertext: this.state.envelope.ciphertext,
          auth_tag: this.state.envelope.authTag,
          expires_at: null,
        },
      ];
    }
    if (
      statement.startsWith('UPDATE saas_tenant_provider_credential_validation_jobs AS job') &&
      statement.includes("SET status = 'queued'")
    ) {
      return this.sweepRevalidations('tenant', statement, values);
    }
    if (
      statement.startsWith('UPDATE saas_platform_provider_credential_validation_jobs AS job') &&
      statement.includes("SET status = 'queued'")
    ) {
      return this.sweepRevalidations('platform', statement, values);
    }
    if (statement.startsWith('UPDATE saas_tenant_provider_credential_validation_jobs AS job')) return [];
    if (
      statement.startsWith('UPDATE saas_tenant_provider_credential_validation_jobs') &&
      statement.includes("SET status = 'failed'")
    ) {
      return [];
    }
    if (statement.startsWith('WITH candidate AS')) {
      this.state.jobStatus = 'leased';
      this.state.attemptCount += 1;
      this.state.leaseGeneration += 1;
      return [this.jobRow()];
    }
    if (
      statement.startsWith('UPDATE saas_tenant_provider_credential_validation_jobs') &&
      statement.includes("SET status = 'leased'")
    ) {
      this.state.jobStatus = 'leased';
      this.state.attemptCount += 1;
      this.state.leaseGeneration += 1;
      return [this.jobRow()];
    }
    if (statement.startsWith('SELECT id FROM saas_tenant_provider_credential_validation_jobs')) {
      return this.state.leaseCurrent &&
        this.state.jobStatus === 'leased' &&
        this.state.leaseGeneration === Number(values[5])
        ? [{ id: 'job-a' }]
        : [];
    }
    if (
      statement.startsWith('UPDATE saas_tenant_provider_credential_validation_jobs') &&
      statement.includes("SET status = 'cancelled'")
    ) {
      if (this.state.jobStatus === 'leased' && this.state.leaseGeneration === Number(values[1])) {
        this.state.jobStatus = 'cancelled';
        this.state.leaseGeneration += 1;
      }
      return this.state.jobStatus === 'cancelled' ? [{ id: 'job-a' }] : [];
    }
    if (
      statement.startsWith('UPDATE saas_tenant_provider_credential_validation_jobs') &&
      statement.includes('SET status = $1')
    ) {
      if (this.state.jobStatus !== 'leased' || this.state.leaseGeneration !== Number(values[3])) return [];
      this.state.jobStatus = String(values[0]);
      this.state.leaseGeneration += 1;
      return [{ id: 'job-a' }];
    }
    if (statement.startsWith('UPDATE saas_tenant_provider_credentials')) {
      this.state.credentialStatus = String(values[0]);
      this.state.credentialValidationState = String(values[1]);
      this.state.credentialHealthStatements.push(statement);
      this.state.healthWrites.push('credential');
      return [{ id: 'credential-a' }];
    }
    if (statement.startsWith('UPDATE saas_tenant_provider_accounts')) {
      return this.updateAccount('tenant', statement, values);
    }
    // --- platform-owner scope: the 083 table family with no tenant dimension ---
    if (
      statement.startsWith(
        'SELECT id, account_id, credential_id, credential_version FROM saas_platform_provider_credential_validation_jobs',
      )
    ) {
      this.candidateQueries.push('platform');
      // Terminal jobs stay unclaimable until the D3 sweep requeues them.
      if (this.isTerminal()) return [];
      return [
        {
          id: 'job-a',
          account_id: 'account-a',
          credential_id: 'credential-a',
          credential_version: 1,
        },
      ];
    }
    if (
      statement.startsWith('SELECT id, account_id, credential_id, credential_version, provider_id') &&
      statement.includes('FROM saas_platform_provider_credential_validation_jobs') &&
      statement.includes('WHERE id = $1')
    ) {
      return [this.jobRow()];
    }
    if (statement.startsWith('SELECT job.id FROM saas_platform_provider_credential_validation_jobs AS job')) {
      return [{ id: 'job-a' }];
    }
    if (statement.includes('FROM saas_platform_provider_accounts') && statement.startsWith('SELECT')) {
      return [
        {
          id: 'account-a',
          provider_id: this.target.providerId,
          product_id: this.target.productId,
          credential_type: targetCredentialType(this.target),
          region: 'test-region',
          purpose: 'inference',
          rights_id: 'rights-a',
          rights_version: 1,
          status: 'pending',
          validation_state: 'unverified',
          authz_version: 1,
        },
      ];
    }
    if (statement.includes('FROM saas_platform_provider_credentials') && statement.startsWith('SELECT')) {
      return [
        {
          id: 'credential-a',
          account_id: 'account-a',
          provider_id: this.target.providerId,
          product_id: this.target.productId,
          credential_type: targetCredentialType(this.target),
          status: 'pending',
          validation_state: 'unverified',
          current_version: 1,
          expires_at: null,
          authz_version: 1,
        },
      ];
    }
    if (statement.includes('JOIN saas_platform_provider_account_capabilities AS binding')) {
      assert.match(statement, /binding\.account_id = \$3/);
      assert.match(statement, /capability\.protocol = \$7/);
      assert.match(statement, /capability\.support_level = 'supported'/);
      assert.match(statement, /capability\.validation_state = 'verified'/);
      assert.match(statement, /newer\.version > capability\.version/);
      assert.equal(values[2], 'account-a');
      assert.equal(values[3], this.target.model);
      assert.equal(values[4], this.target.endpoint);
      assert.equal(values[5], 1);
      assert.ok(typeof values[6] === 'string');
      this.state.requestedCapabilityProtocols.push(values[6]);
      const digestMatches = values.length === 7 || values[7] === this.state.capabilityEvidenceSha256;
      if (values.length > 7) {
        assert.match(statement, /capability\.evidence_sha256 = \$8/);
        assert.match(statement, /\$9::timestamptz > clock_timestamp\(\)/);
      }
      return this.state.capabilityCurrent && this.state.capabilityProtocol === values[6] && digestMatches
        ? [{ version: 1 }]
        : [];
    }
    if (statement.includes('FROM saas_platform_provider_credential_versions') && statement.startsWith('SELECT')) {
      return [
        {
          account_id: 'account-a',
          credential_id: 'credential-a',
          version: 1,
          status: 'active',
          schema_version: this.state.envelope.schemaVersion,
          context_version: this.state.envelope.contextVersion,
          algorithm: this.state.envelope.algorithm,
          kms_purpose: 'inference',
          kms_key_id: this.state.envelope.kmsKeyId,
          wrapping_revision: 1,
          wrapped_dek: this.state.envelope.wrappedDek,
          nonce: this.state.envelope.nonce,
          ciphertext: this.state.envelope.ciphertext,
          auth_tag: this.state.envelope.authTag,
          expires_at: null,
        },
      ];
    }
    if (
      statement.startsWith('UPDATE saas_platform_provider_credential_validation_jobs') &&
      statement.includes("SET status = 'failed'")
    ) {
      return [];
    }
    if (
      statement.startsWith('UPDATE saas_platform_provider_credential_validation_jobs') &&
      statement.includes("SET status = 'leased'")
    ) {
      this.state.jobStatus = 'leased';
      this.state.attemptCount += 1;
      this.state.leaseGeneration += 1;
      return [this.jobRow()];
    }
    if (
      statement.startsWith('UPDATE saas_platform_provider_credential_validation_jobs') &&
      statement.includes("SET status = 'cancelled'")
    ) {
      if (this.state.jobStatus === 'leased' && this.state.leaseGeneration === Number(values[1])) {
        this.state.jobStatus = 'cancelled';
        this.state.leaseGeneration += 1;
      }
      return this.state.jobStatus === 'cancelled' ? [{ id: 'job-a' }] : [];
    }
    if (
      statement.startsWith('UPDATE saas_platform_provider_credential_validation_jobs') &&
      statement.includes('SET status = $1')
    ) {
      if (this.state.jobStatus !== 'leased' || this.state.leaseGeneration !== Number(values[3])) return [];
      this.state.jobStatus = String(values[0]);
      this.state.leaseGeneration += 1;
      return [{ id: 'job-a' }];
    }
    if (statement.startsWith('SELECT id FROM saas_platform_provider_credential_validation_jobs')) {
      return this.state.leaseCurrent &&
        this.state.jobStatus === 'leased' &&
        this.state.leaseGeneration === Number(values[4])
        ? [{ id: 'job-a' }]
        : [];
    }
    if (statement.startsWith('UPDATE saas_platform_provider_credentials')) {
      this.state.credentialStatus = String(values[0]);
      this.state.credentialValidationState = String(values[1]);
      this.state.credentialHealthStatements.push(statement);
      this.state.healthWrites.push('credential');
      return [{ id: 'credential-a' }];
    }
    if (statement.startsWith('UPDATE saas_platform_provider_accounts')) {
      return this.updateAccount('platform', statement, values);
    }
    throw new Error(`Unexpected worker SQL: ${statement}`);
  }

  /**
   * Models the account-row writes against the 097 guard semantics. The R5
   * entry statement (literal 'quarantined') is admitted only from 'failed',
   * migrates the terminal error code into the quarantine reason and returns
   * the entered_at fact; the health statement carries the quarantine CASEs —
   * a failure against a quarantined account preserves state and facts, a
   * success exits with both fact columns cleared in the same statement.
   */
  private updateAccount(owner: 'tenant' | 'platform', statement: string, values: readonly unknown[]): unknown[] {
    if (statement.includes("SET validation_state = 'quarantined'")) {
      // The entry UPDATE re-gates on the live state (WHERE validation_state =
      // 'failed'); the 097 guard trigger is the real-PG enforcement layer.
      if (this.state.accountValidationState !== 'failed') return [];
      assert.match(statement, /validation_error_code = NULL/);
      assert.match(statement, /quarantine_entered_at = clock_timestamp\(\)/);
      assert.match(statement, /AND validation_state = 'failed'/);
      const reasonCode = String(values[owner === 'tenant' ? 4 : 3]);
      this.state.accountValidationState = 'quarantined';
      this.state.accountValidationErrorCode = null;
      this.state.quarantineEntries.push({ reasonCode });
      return [{ id: 'account-a', quarantine_entered_at: new Date('2026-09-29T00:00:00.000Z') }];
    }
    assert.match(statement, /validation_state = CASE WHEN validation_state = 'quarantined' AND \$2 = 'failed'/);
    assert.match(statement, /quarantine_entered_at = CASE WHEN \$2 = 'verified' THEN NULL/);
    assert.match(statement, /quarantine_reason_code = CASE WHEN \$2 = 'verified' THEN NULL/);
    const requested = String(values[1]);
    this.state.accountStatus = String(values[0]);
    if (!(requested === 'failed' && this.state.accountValidationState === 'quarantined')) {
      this.state.accountValidationState = requested;
      this.state.accountValidationErrorCode = values[2] === null ? null : String(values[2]);
    }
    this.state.accountHealthStatements.push(statement);
    this.state.healthWrites.push('account');
    return [{ id: 'account-a' }];
  }

  private isTerminal(): boolean {
    return (
      this.state.jobStatus === 'verified' || this.state.jobStatus === 'failed' || this.state.jobStatus === 'cancelled'
    );
  }

  /**
   * Models the D3 requeue-transition for one owner scope. The fixture has a
   * single job/account/credential; revalidationDue stands in for the account
   * cadence predicate (interval configured AND last completion older than it),
   * quarantineDue for the R5 quarantine cadence ($2), and the real
   * account/credential active + current-version gates are kept as SQL shape
   * assertions instead.
   */
  private sweepRevalidations(owner: 'tenant' | 'platform', statement: string, values: readonly unknown[]): unknown[] {
    this.sweepQueries.push(owner);
    this.lastSweepBatchSize = Number(values[0]);
    this.lastSweepQuarantineSeconds = Number(values[1]);
    assert.match(statement, /due\.status IN \('verified', 'failed'\)/);
    assert.match(statement, /due\.completed_at IS NOT NULL/);
    assert.match(statement, /due\.credential_version = credential\.current_version/);
    assert.match(statement, /credential\.status = 'active'/);
    assert.match(statement, /account\.status = 'active'/);
    assert.match(statement, /account\.revalidation_interval_seconds IS NOT NULL/);
    assert.match(statement, /make_interval\(secs => account\.revalidation_interval_seconds\)/);
    // R5 quarantine branch: the independent cadence arrives as $2 and admits
    // the pending states a quarantined account and its credential are parked in.
    assert.match(statement, /account\.validation_state <> 'quarantined'/);
    assert.match(statement, /account\.validation_state = 'quarantined'/);
    assert.match(statement, /credential\.status IN \('pending', 'active'\)/);
    assert.match(statement, /account\.status IN \('pending', 'active'\)/);
    assert.match(statement, /make_interval\(secs => \$2\)/);
    assert.match(statement, /LIMIT \$1/);
    assert.match(statement, /FOR UPDATE OF due SKIP LOCKED/);
    // Only the lease columns the restricted worker role may UPDATE appear in
    // the transition; the 035 completion shape forces completed_at back to NULL.
    assert.match(statement, /lease_generation = job\.lease_generation \+ 1/);
    assert.match(statement, /completed_at = NULL/);
    assert.match(statement, /last_error_code = NULL/);
    if (owner === 'tenant') {
      assert.match(statement, /account\.tenant_id = due\.tenant_id/);
      assert.match(statement, /credential\.tenant_id = due\.tenant_id/);
    } else {
      assert.doesNotMatch(statement, /tenant_id/);
    }
    const due =
      this.state.accountValidationState === 'quarantined' ? this.state.quarantineDue : this.state.revalidationDue;
    if (owner !== this.owner || !due) return [];
    if (this.state.jobStatus !== 'verified' && this.state.jobStatus !== 'failed') return [];
    this.state.jobStatus = 'queued';
    this.state.attemptCount = 0;
    this.state.leaseGeneration += 1;
    return [{ id: 'job-a' }];
  }

  private jobRow() {
    const now = new Date('2026-09-29T00:00:00.000Z');
    return {
      id: 'job-a',
      // The platform queue carries no tenant dimension; the worker maps its
      // absence to ownerKind 'platform' + tenantId null.
      ...(this.owner === 'tenant' ? { tenant_id: 'tenant-a' } : {}),
      account_id: 'account-a',
      credential_id: 'credential-a',
      credential_version: 1,
      provider_id: this.target.providerId,
      product_id: this.target.productId,
      credential_type: targetCredentialType(this.target),
      allowed_models: [this.target.model],
      target_model: this.target.model,
      target_endpoint: this.target.endpoint,
      capability_version: 1,
      idempotency_key: 'a'.repeat(64),
      status: 'leased',
      attempt_count: this.state.attemptCount,
      available_at: now,
      lease_until: new Date(now.getTime() + 30_000),
      lease_generation: this.state.leaseGeneration,
      last_error_code: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
  }
}

async function setupWorker(
  fetcher: ProviderCredentialValidationFetch,
  afterDecrypt?: (database: FakeValidationDatabase) => void | Promise<void>,
  target: WorkerTarget = chatTarget,
  extraOptions: Partial<CredentialValidationWorkerOptions> = {},
  secret: Buffer = Buffer.from('provider-test-token'),
  owner: 'tenant' | 'platform' = 'tenant',
): Promise<{
  readonly database: FakeValidationDatabase;
  readonly worker: CredentialValidationWorker;
}> {
  const sealingKms: ProviderCredentialKms = {
    async generateDataKey() {
      return { plaintextKey: Buffer.from(DATA_KEY), ciphertextBlob: Buffer.from('wrapped-test-key') };
    },
    async decryptDataKey() {
      return Buffer.from(DATA_KEY);
    },
  };
  const boundContext = createProviderCredentialContext(
    owner === 'platform'
      ? {
          ownerKind: 'platform',
          supplyMode: 'platform',
          deployment: 'worker-test',
          environment: 'test',
          purpose: 'inference',
          providerId: target.providerId,
          productId: target.productId,
          credentialType: targetCredentialType(target),
          accountId: 'account-a',
          credentialId: 'credential-a',
          credentialVersion: 1,
        }
      : {
          ownerKind: 'tenant',
          tenantId: 'tenant-a',
          supplyMode: 'byok',
          deployment: 'worker-test',
          environment: 'test',
          purpose: 'inference',
          providerId: target.providerId,
          productId: target.productId,
          credentialType: targetCredentialType(target),
          accountId: 'account-a',
          credentialId: 'credential-a',
          credentialVersion: 1,
        },
  );
  const envelope = await sealProviderCredential(secret, boundContext, sealingKms, 'kms/test');
  const database = new FakeValidationDatabase(envelope, target, owner);
  const kms: ProviderCredentialKms = {
    async generateDataKey() {
      throw new Error('worker must not seal credentials');
    },
    async decryptDataKey() {
      database.decryptCalls += 1;
      await afterDecrypt?.(database);
      return Buffer.from(DATA_KEY);
    },
  };
  const worker = new CredentialValidationWorker(database, kms, {
    deployment: 'worker-test',
    environment: 'test',
    fetch: fetcher,
    ...extraOptions,
  });
  return { database, worker };
}

test('opens a persistence-sealed tenant BYOK envelope in both validation worker and gateway', async () => {
  const repository = new FakeProviderSupplyRepository();
  const kms = new ContextBoundTestKms();
  const persistence = new ProviderSupplyPersistenceService(repository, {
    sealingKms: kms,
    kmsKeyId: 'kms/test',
    deployment: 'worker-test',
    environment: 'test',
    now: () => new Date('2026-09-29T00:00:00.000Z'),
  });
  const persistedAccount = await persistence.createProviderAccount({
    ownerKind: 'tenant',
    tenantId: 'tenant-a',
    id: 'account-a',
    displayName: 'Validation fixture',
    providerId: 'kimi',
    productId: 'kimi-platform',
    credentialType: 'api-key',
    region: 'test-region',
    purpose: 'inference',
    rightsId: 'rights-a',
    rightsVersion: 1,
    capability: { model: 'model-a', endpoint: 'chat-completions', version: 1 },
  });
  const persistedCredential = await persistence.createProviderCredential({
    account: { ownerKind: 'tenant', tenantId: 'tenant-a', accountId: persistedAccount.id },
    id: 'credential-a',
    secret: Buffer.from('provider-test-token'),
  });
  if (persistedAccount.ownerKind !== 'tenant' || persistedCredential.credential.ownerKind !== 'tenant') {
    throw new Error('Expected persistence fixture to remain tenant BYOK');
  }
  const storedVersion = repository.versions[0];
  assert.ok(storedVersion);
  assert.equal(storedVersion.envelope.schemaVersion, persistedCredential.version.envelopeSchemaVersion);
  assert.equal(kms.requestedContexts.length, 1);

  const database = new FakeValidationDatabase(storedVersion.envelope);
  const runtimeKms = {
    decryptDataKey: (request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]) => kms.decryptDataKey(request),
    checkReady: async () => undefined,
    close: async () => undefined,
  };
  const workerKms: ProviderCredentialUnsealingKms = runtimeKms;
  let workerFetches = 0;
  const worker = new CredentialValidationWorker(database, workerKms, {
    deployment: 'worker-test',
    environment: 'test',
    fetch: async (_url, init) => {
      workerFetches += 1;
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer provider-test-token');
      return new Response(null, { status: 200 });
    },
  });

  assert.equal(await worker.runOnce(), 'processed');
  assert.equal(workerFetches, 1);

  const gatewayAccount: GatewayProviderCredentialAccount = {
    ownerKind: 'tenant',
    tenantId: persistedAccount.tenantId,
    supplyMode: 'byok',
    id: persistedAccount.id,
    providerId: persistedAccount.providerId,
    productId: persistedAccount.productId,
    credentialType: persistedAccount.credentialType,
    purpose: persistedAccount.purpose,
  };
  const gatewayCredential: GatewayProviderCredentialCredential = {
    ownerKind: 'tenant',
    tenantId: persistedCredential.credential.tenantId,
    supplyMode: 'byok',
    id: persistedCredential.credential.id,
    accountId: persistedCredential.credential.accountId,
    providerId: persistedCredential.credential.providerId,
    productId: persistedCredential.credential.productId,
  };
  const gateway = new GatewayProviderCredentialUnsealer(runtimeKms, {
    deployment: 'worker-test',
    environment: 'test',
  });
  let gatewaySecret = '';
  assert.equal(
    await gateway.withCredential(
      { account: gatewayAccount, credential: gatewayCredential, version: storedVersion },
      (plaintext) => {
        gatewaySecret = plaintext.toString('utf8');
        return 'gateway-complete';
      },
    ),
    'gateway-complete',
  );
  assert.equal(gatewaySecret, 'provider-test-token');

  const distinctContexts = new Set(kms.requestedContexts);
  assert.equal(kms.requestedContexts.length, 3);
  assert.equal(distinctContexts.size, 1);
});

test('current rights and capability revocation stops validation before KMS decryption or network fetch', async () => {
  for (const revokedBinding of ['rights', 'capability'] as const) {
    let fetchCalls = 0;
    const { database, worker } = await setupWorker(async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    });
    if (revokedBinding === 'rights') database.state.rightsCurrent = false;
    else database.state.capabilityCurrent = false;

    assert.equal(await worker.runOnce(), 'stale');
    assert.equal(database.decryptCalls, 0, `${revokedBinding} revocation must prevent KMS decryption`);
    assert.equal(fetchCalls, 0, `${revokedBinding} revocation must prevent network fetch`);
    assert.deepEqual(database.state.healthWrites, []);
    assert.equal(database.state.jobStatus, 'cancelled');
  }
});

test('rights revoked after unsealing but before the provider request blocks the network call', async () => {
  let fetchCalls = 0;
  const { database, worker } = await setupWorker(
    async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    },
    (currentDatabase) => {
      currentDatabase.state.rightsCurrent = false;
    },
  );

  assert.equal(await worker.runOnce(), 'stale');
  assert.equal(database.decryptCalls, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(database.state.jobStatus, 'cancelled');
  assert.deepEqual(database.state.healthWrites, []);
});

test('rights revoked during provider fetch prevents verified job and health updates', async (t) => {
  let startFetch!: () => void;
  let finishFetch!: (response: Response) => void;
  const fetchStarted = new Promise<void>((resolve) => {
    startFetch = resolve;
  });
  const pendingResponse = new Promise<Response>((resolve) => {
    finishFetch = resolve;
  });
  let fetchCalls = 0;
  const { database, worker } = await setupWorker(async () => {
    fetchCalls += 1;
    startFetch();
    return pendingResponse;
  });
  t.after(async () => {
    finishFetch(new Response(null, { status: 503 }));
    await worker.close();
  });

  const run = worker.runOnce();
  await waitForValidationFixtureSignal(fetchStarted, run);
  database.state.rightsCurrent = false;
  finishFetch(new Response(null, { status: 200 }));

  assert.equal(await run, 'stale');
  assert.equal(database.decryptCalls, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(database.state.jobStatus, 'cancelled');
  assert.deepEqual(database.state.healthWrites, []);
  assert.equal(database.state.credentialValidationState, 'unverified');
  assert.equal(database.state.accountValidationState, 'unverified');
});

test('Messages credential worker preserves KMS identity and selects only current Anthropic-compatible capabilities', async (t) => {
  for (const target of messagesTargets) {
    await t.test(target.productId, async () => {
      let fetches = 0;
      const { database, worker } = await setupWorker(
        async (url, init) => {
          fetches += 1;
          assert.equal(url.href, target.url);
          assert.equal(init.method, 'POST');
          const headers = new Headers(init.headers);
          assert.equal(headers.get('x-api-key'), 'provider-test-token');
          assert.equal(headers.get('authorization'), null);
          assert.equal(headers.get('user-agent'), 'model-router');
          assert.ok(typeof init.body === 'string');
          assert.equal(JSON.parse(init.body).model, target.model);
          return messagesResponse(target.model);
        },
        undefined,
        target,
      );
      assert.equal(await worker.runOnce(), 'processed');
      assert.equal(fetches, 1);
      assert.equal(database.decryptCalls, 1);
      assert.equal(database.state.jobStatus, 'verified');
      assert.equal(database.state.credentialValidationState, 'verified');
      assert.equal(database.state.accountValidationState, 'verified');
      assert.deepEqual(database.state.healthWrites, ['credential', 'account']);
      assert.equal(
        database.state.requestedCapabilityProtocols.length,
        3,
        'authority is checked before KMS, fetch and completion',
      );
      assert.deepEqual(database.state.requestedCapabilityProtocols, Array(3).fill('anthropic-compatible'));
      assert.equal(database.state.rightsCurrent, true);
      assert.equal(database.state.capabilityCurrent, true);
      // FakeValidationDatabase rejects unexpected SQL, including any writes to
      // the catalog capability or rights tables. Only credential health changes.
    });
  }
});

test('Messages capability protocol mismatch or stale rights fails closed before KMS and transport', async (t) => {
  for (const target of messagesTargets) {
    for (const cause of ['openai capability', 'stale rights', 'stale capability'] as const) {
      await t.test(`${target.productId}: ${cause}`, async () => {
        let fetches = 0;
        const { database, worker } = await setupWorker(
          async () => {
            fetches += 1;
            return messagesResponse(target.model);
          },
          undefined,
          target,
        );
        if (cause === 'openai capability') database.state.capabilityProtocol = 'openai-compatible';
        else if (cause === 'stale rights') database.state.rightsCurrent = false;
        else database.state.capabilityCurrent = false;
        assert.equal(await worker.runOnce(), 'stale');
        assert.equal(database.decryptCalls, 0);
        assert.equal(fetches, 0);
        assert.equal(database.state.jobStatus, 'cancelled');
        assert.deepEqual(database.state.healthWrites, []);
        assert.equal(database.state.credentialValidationState, 'unverified');
        assert.equal(database.state.accountValidationState, 'unverified');
      });
    }
  }
});

test('Messages rights revoked after KMS still prevent the provider request', async () => {
  const target = messagesTargets[0];
  let fetches = 0;
  const { database, worker } = await setupWorker(
    async () => {
      fetches += 1;
      return messagesResponse(target.model);
    },
    (current) => {
      current.state.rightsCurrent = false;
    },
    target,
  );
  assert.equal(await worker.runOnce(), 'stale');
  assert.equal(database.decryptCalls, 1);
  assert.equal(fetches, 0);
  assert.equal(database.state.jobStatus, 'cancelled');
  assert.deepEqual(database.state.healthWrites, []);
});

test('Messages rights revoked during a successful probe prevent verified job or credential health writes', async (t) => {
  const target = messagesTargets[2];
  let announced!: () => void;
  const requested = new Promise<void>((resolve) => {
    announced = resolve;
  });
  let finish!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const { database, worker } = await setupWorker(
    async () => {
      announced();
      return response;
    },
    undefined,
    target,
  );
  t.after(async () => {
    finish(new Response(null, { status: 503 }));
    await worker.close();
  });
  const run = worker.runOnce();
  await waitForValidationFixtureSignal(requested, run);
  database.state.rightsCurrent = false;
  finish(messagesResponse(target.model));
  assert.equal(await run, 'stale');
  assert.equal(database.decryptCalls, 1);
  assert.equal(database.state.jobStatus, 'cancelled');
  assert.deepEqual(database.state.healthWrites, []);
  assert.equal(database.state.credentialValidationState, 'unverified');
  assert.equal(database.state.accountValidationState, 'unverified');
});

test('custom worker uses actual pinned HTTPS and current catalog digest, never its legacy unrestricted fetch seam', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(probeEnvelope(request.url?.endsWith('/messages') ? 'messages' : 'chat')));
  });
  for (const kind of ['chat', 'messages'] as const) {
    const target = approvedTarget({
      baseUrl: local.baseUrl,
      ...(kind === 'messages'
        ? ({
            productId: 'custom-anthropic',
            endpoint: 'messages',
            protocol: 'anthropic-compatible',
            authProfile: 'anthropic-api-key-2023-06-01',
          } as const)
        : {}),
    });
    let legacyFetches = 0;
    const { database, worker } = await setupWorker(
      async () => {
        legacyFetches += 1;
        throw new Error('custom must never use unrestricted fetch');
      },
      undefined,
      target,
      {
        approvedTargets: compileApprovedCredentialValidationTargets([target]),
        transportTestOptions: local.testOptions,
      },
    );
    t.after(() => worker.close());
    database.state.capabilityEvidenceSha256 = target.evidenceSha256;
    assert.equal(await worker.runOnce(), 'processed');
    assert.equal(legacyFetches, 0);
    assert.equal(database.decryptCalls, 1);
    assert.equal(database.state.jobStatus, 'verified');
    assert.deepEqual(database.state.requestedCapabilityProtocols, Array(4).fill(target.protocol));
    assert.deepEqual(database.state.healthWrites, ['credential', 'account']);
  }
  assert.equal(requests, 2);
});

test('custom missing/stale approval, wrong evidence/protocol/rights/lease and private DNS fail before KMS and dispatch', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    requests += 1;
    response.end();
  });
  for (const cause of [
    'missing approval',
    'expired approval',
    'evidence',
    'protocol',
    'rights',
    'capability',
    'lease',
    'private DNS',
  ] as const) {
    const target = approvedTarget({
      baseUrl: cause === 'private DNS' ? 'https://validation.example/v1/' : local.baseUrl,
      ...(cause === 'expired approval' ? { expiresAt: '2000-01-01T00:00:00.000Z' } : {}),
    });
    let legacyFetches = 0;
    const { database, worker } = await setupWorker(
      async () => {
        legacyFetches += 1;
        throw new Error('unexpected fetch');
      },
      undefined,
      target,
      {
        approvedTargets: compileApprovedCredentialValidationTargets(cause === 'missing approval' ? [] : [target]),
        transportTestOptions: {
          ...local.testOptions,
          ...(cause === 'private DNS'
            ? {
                resolveAddresses: async () => [
                  { address: '8.8.8.8', family: 4 },
                  { address: '169.254.169.254', family: 4 },
                ],
              }
            : {}),
        },
      },
    );
    t.after(() => worker.close());
    database.state.capabilityEvidenceSha256 = cause === 'evidence' ? 'f'.repeat(64) : target.evidenceSha256;
    if (cause === 'protocol') database.state.capabilityProtocol = 'anthropic-compatible';
    if (cause === 'rights') database.state.rightsCurrent = false;
    if (cause === 'capability') database.state.capabilityCurrent = false;
    if (cause === 'lease') database.state.leaseCurrent = false;
    const result = await worker.runOnce();
    assert.ok(result === 'processed' || result === 'stale');
    assert.equal(database.decryptCalls, 0, cause);
    assert.equal(legacyFetches, 0, cause);
    assert.deepEqual(database.state.healthWrites, [], cause);
    assert.notEqual(database.state.jobStatus, 'verified', cause);
  }
  assert.equal(requests, 0);
});

test('custom rights/evidence/lease changes after KMS prevent wire dispatch without health writes', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    requests += 1;
    response.end();
  });
  const target = approvedTarget({ baseUrl: local.baseUrl });
  for (const cause of ['rights', 'evidence', 'lease'] as const) {
    const { database, worker } = await setupWorker(
      async () => {
        throw new Error('unexpected fetch');
      },
      (current) => {
        if (cause === 'rights') current.state.rightsCurrent = false;
        if (cause === 'evidence') current.state.capabilityEvidenceSha256 = 'f'.repeat(64);
        if (cause === 'lease') current.state.leaseGeneration += 1;
      },
      target,
      {
        approvedTargets: compileApprovedCredentialValidationTargets([target]),
        transportTestOptions: local.testOptions,
      },
    );
    t.after(() => worker.close());
    database.state.capabilityEvidenceSha256 = target.evidenceSha256;
    assert.equal(await worker.runOnce(), 'stale', cause);
    assert.equal(database.decryptCalls, 1);
    assert.deepEqual(database.state.healthWrites, []);
  }
  assert.equal(requests, 0);
});

test('custom EOF is necessary but post-dispatch revoked rights/evidence/lease cannot publish verified health', async (t) => {
  let activeResponse: ServerResponse | undefined;
  let announce!: () => void;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    activeResponse = response;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(JSON.stringify(probeEnvelope('chat')));
    announce();
  });
  const target = approvedTarget({ baseUrl: local.baseUrl });
  for (const cause of ['rights', 'evidence', 'lease'] as const) {
    const { database, worker } = await setupWorker(
      async () => {
        throw new Error('unexpected fetch');
      },
      undefined,
      target,
      {
        approvedTargets: compileApprovedCredentialValidationTargets([target]),
        transportTestOptions: local.testOptions,
      },
    );
    t.after(async () => {
      activeResponse?.destroy();
      await worker.close();
    });
    database.state.capabilityEvidenceSha256 = target.evidenceSha256;
    const waiting = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const pending = worker.runOnce();
    await waitForValidationFixtureSignal(waiting, pending);
    await delay(10);
    assert.deepEqual(database.state.healthWrites, []);
    if (cause === 'rights') database.state.rightsCurrent = false;
    if (cause === 'evidence') database.state.capabilityEvidenceSha256 = 'f'.repeat(64);
    if (cause === 'lease') database.state.leaseGeneration += 1;
    activeResponse?.end();
    assert.equal(await pending, 'stale', cause);
    assert.deepEqual(database.state.healthWrites, []);
    assert.equal(database.state.credentialValidationState, 'unverified');
  }
});

test('worker close cannot cancel a pending KMS call; it waits, then prevents dispatch and verified completion', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    requests += 1;
    response.end();
  });
  const target = approvedTarget({ baseUrl: local.baseUrl });
  let kmsStarted!: () => void;
  let finishKms!: () => void;
  const started = new Promise<void>((resolve) => {
    kmsStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    finishKms = resolve;
  });
  const { database, worker } = await setupWorker(
    async () => {
      throw new Error('unexpected fetch');
    },
    async () => {
      kmsStarted();
      await blocked;
    },
    target,
    { approvedTargets: compileApprovedCredentialValidationTargets([target]), transportTestOptions: local.testOptions },
  );
  t.after(async () => {
    finishKms();
    await worker.close();
  });
  database.state.capabilityEvidenceSha256 = target.evidenceSha256;
  const run = worker.runOnce();
  await waitForValidationFixtureSignal(started, run);
  let closed = false;
  const close = worker.close().then(() => {
    closed = true;
  });
  await delay(10);
  assert.equal(closed, false, 'external KMS is not falsely claimed cancellable');
  finishKms();
  assert.equal(await run, 'stale');
  await close;
  assert.equal(requests, 0);
  assert.deepEqual(database.state.healthWrites, []);
  assert.equal(await worker.runOnce(), 'stale');
});

import {
  CANONICAL_CREDENTIAL_VALIDATION_ENDPOINT_EXPRESSION,
  SAAS_CREDENTIAL_VALIDATION_WORKER_SCHEMA_READINESS_SQL,
} from '../../../src/saas/db/credential-validation-worker-schema-readiness.js';
import { credentialValidationTargetEvidenceSha256 as canonicalWorkerDigest } from '../../../src/saas/supply/credential-validation-targets.js';
import type { ApprovedCredentialValidationTarget } from '../../../src/saas/supply/types.js';

function canonicalWorkerTarget(
  baseUrl: string,
  kind: 'chat' | 'messages' = 'chat',
  expiresAt: string | null = null,
): ApprovedCredentialValidationTarget {
  const descriptor: Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'> = {
    schemaVersion: 2,
    providerId: 'custom',
    credentialType: 'api-key',
    model: 'organisation/model-v1',
    capabilityVersion: 1,
    baseUrl,
    approvalReference: 'operator-review-worker-v2',
    expiresAt,
    ...(kind === 'chat'
      ? ({
          productId: 'custom-openai',
          endpoint: '/v1/chat/completions',
          protocol: 'openai',
          wirePath: 'chat/completions',
          wireProtocol: 'openai',
          authProfile: 'openai-bearer-v1',
        } as const)
      : ({
          productId: 'custom-anthropic',
          endpoint: '/v1/messages',
          protocol: 'anthropic',
          wirePath: 'messages',
          wireProtocol: 'anthropic',
          authProfile: 'anthropic-api-key-2023-06-01',
        } as const)),
  };
  return { ...descriptor, evidenceSha256: canonicalWorkerDigest(descriptor) };
}

/** Adds only the two exact new query protocols; the original fake rejects everything else. */
class CanonicalValidationDatabase extends FakeValidationDatabase {
  schemaReady = true;
  schemaQueries = 0;
  identityQueries = 0;

  constructor(
    envelope: ProviderCredentialEnvelope,
    readonly canonicalTarget: WorkerTarget,
    owner: 'tenant' | 'platform' = 'tenant',
  ) {
    super(envelope, canonicalTarget, owner);
  }

  override async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    if (sql === SAAS_CREDENTIAL_VALIDATION_WORKER_SCHEMA_READINESS_SQL) {
      this.schemaQueries += 1;
      assert.equal(values.length, 1);
      assert.equal(typeof values[0], 'string');
      const serialized = values[0];
      assert.ok(typeof serialized === 'string');
      const contract = JSON.parse(serialized);
      const endpointTable =
        this.owner === 'platform'
          ? 'saas_platform_provider_credential_validation_jobs'
          : 'saas_tenant_provider_credential_validation_jobs';
      assert.deepEqual(contract.endpointChecks, [
        {
          table_name: endpointTable,
          name: `${endpointTable}_endpoint_shape`.slice(0, 63),
          expression: CANONICAL_CREDENTIAL_VALIDATION_ENDPOINT_EXPRESSION,
        },
      ]);
      // 9 tenant/BYOK + 6 platform-owner relations (083), 3 tenant + 2 platform definer wrappers.
      assert.equal(contract.tables.length, 15);
      assert.equal(contract.routines.filter((routine: { definer: boolean }) => routine.definer).length, 5);
      const readiness = {
        server_ready: true,
        session_ready: true,
        owner_ready: true,
        tables_ready: true,
        columns_ready: true,
        keys_ready: true,
        indexes_ready: true,
        checks_ready: this.schemaReady,
        triggers_ready: true,
        routines_ready: true,
      };
      // SqlExecutor's generic row type is a driver projection, as in the original fixture.
      return { rows: [readiness as Row], rowCount: 1 };
    }
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (
      statement.startsWith('SELECT id FROM saas_tenant_provider_credential_validation_jobs') &&
      statement.includes('target_endpoint = $11')
    ) {
      this.identityQueries += 1;
      assert.match(statement, /lease_until > clock_timestamp\(\)/);
      assert.match(statement, /provider_id = \$7 AND product_id = \$8 AND credential_type = \$9/);
      assert.match(statement, /target_model = \$10 AND target_endpoint = \$11 AND capability_version = \$12/);
      assert.match(statement, /idempotency_key = \$13 AND allowed_models = \$14::text\[\]/);
      assert.ok(statement.endsWith('FOR UPDATE'));
      assert.equal(values.length, 14);
      const expected = [
        'job-a',
        'tenant-a',
        'account-a',
        'credential-a',
        1,
        this.state.leaseGeneration,
        this.canonicalTarget.providerId,
        this.canonicalTarget.productId,
        'api-key',
        this.canonicalTarget.model,
        this.canonicalTarget.endpoint,
        1,
        'a'.repeat(64),
      ];
      if (
        expected.some((value, index) => values[index] !== value) ||
        JSON.stringify(values[13]) !== JSON.stringify([this.canonicalTarget.model])
      ) {
        return { rows: [], rowCount: 0 };
      }
    }
    if (
      statement.startsWith('SELECT id FROM saas_platform_provider_credential_validation_jobs') &&
      statement.includes('target_endpoint = $10')
    ) {
      this.identityQueries += 1;
      assert.match(statement, /lease_until > clock_timestamp\(\)/);
      assert.match(statement, /provider_id = \$6 AND product_id = \$7 AND credential_type = \$8/);
      assert.match(statement, /target_model = \$9 AND target_endpoint = \$10 AND capability_version = \$11/);
      assert.match(statement, /idempotency_key = \$12 AND allowed_models = \$13::text\[\]/);
      assert.ok(statement.endsWith('FOR UPDATE'));
      assert.equal(values.length, 13);
      const expected = [
        'job-a',
        'account-a',
        'credential-a',
        1,
        this.state.leaseGeneration,
        this.canonicalTarget.providerId,
        this.canonicalTarget.productId,
        'api-key',
        this.canonicalTarget.model,
        this.canonicalTarget.endpoint,
        1,
        'a'.repeat(64),
      ];
      if (
        expected.some((value, index) => values[index] !== value) ||
        JSON.stringify(values[12]) !== JSON.stringify([this.canonicalTarget.model])
      ) {
        return { rows: [], rowCount: 0 };
      }
    }
    return super.query<Row>(sql, values);
  }
}

async function setupCanonicalWorker(
  target: ApprovedCredentialValidationTarget,
  transportTestOptions: CredentialValidationWorkerOptions['transportTestOptions'],
  afterDecrypt?: (database: CanonicalValidationDatabase) => void,
  owner: 'tenant' | 'platform' = 'tenant',
) {
  const sealingKms: ProviderCredentialKms = {
    async generateDataKey() {
      return { plaintextKey: Buffer.from(DATA_KEY), ciphertextBlob: Buffer.from('wrapped-test-key') };
    },
    async decryptDataKey() {
      return Buffer.from(DATA_KEY);
    },
  };
  // The platform KMS context omits the tenant dimension entirely (never a sentinel).
  const boundContext = createProviderCredentialContext(
    owner === 'platform'
      ? {
          ownerKind: 'platform',
          supplyMode: 'platform',
          deployment: 'worker-test',
          environment: 'test',
          purpose: 'inference',
          providerId: target.providerId,
          productId: target.productId,
          credentialType: target.credentialType,
          accountId: 'account-a',
          credentialId: 'credential-a',
          credentialVersion: 1,
        }
      : {
          ownerKind: 'tenant',
          tenantId: 'tenant-a',
          supplyMode: 'byok',
          deployment: 'worker-test',
          environment: 'test',
          purpose: 'inference',
          providerId: target.providerId,
          productId: target.productId,
          credentialType: target.credentialType,
          accountId: 'account-a',
          credentialId: 'credential-a',
          credentialVersion: 1,
        },
  );
  const envelope = await sealProviderCredential(
    Buffer.from('provider-test-token'),
    boundContext,
    sealingKms,
    'kms/test',
  );
  const database = new CanonicalValidationDatabase(envelope, target, owner);
  database.state.capabilityEvidenceSha256 = target.evidenceSha256;
  const kms: ProviderCredentialUnsealingKms = {
    async decryptDataKey() {
      database.decryptCalls += 1;
      afterDecrypt?.(database);
      return Buffer.from(DATA_KEY);
    },
  };
  const options: CredentialValidationWorkerOptions = {
    deployment: 'worker-test',
    environment: 'test',
    approvedTargets: compileApprovedCredentialValidationTargets([target]),
    transportTestOptions,
    fetch: async () => {
      throw new Error('canonical custom probe cannot use legacy fetch');
    },
  };
  return {
    database,
    worker: new CredentialValidationWorker(database, kms, options),
    store: new PostgresCredentialValidationWorkerStore(database, kms, options),
  };
}

test('canonical worker verifies the original single account capability through real sealed-secret HTTPS and repeated schema/authority checks', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    requests += 1;
    const messages = request.url === '/v1/messages';
    assert.ok(messages || request.url === '/v1/chat/completions');
    assert.equal(request.method, 'POST');
    assert.equal(
      request.headers[messages ? 'x-api-key' : 'authorization'],
      messages ? 'provider-test-token' : 'Bearer provider-test-token',
    );
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(probeEnvelope(messages ? 'messages' : 'chat')));
  });
  for (const kind of ['chat', 'messages'] as const) {
    const target = canonicalWorkerTarget(local.baseUrl, kind);
    const { database, worker } = await setupCanonicalWorker(target, local.testOptions);
    t.after(() => worker.close());
    assert.equal(await worker.runOnce(), 'processed');
    assert.equal(database.decryptCalls, 1);
    assert.equal(database.state.jobStatus, 'verified');
    assert.equal(database.state.attemptCount, 1);
    assert.deepEqual(database.state.healthWrites, ['credential', 'account']);
    assert.deepEqual(database.state.requestedCapabilityProtocols, Array(4).fill(target.protocol));
    assert.equal(database.schemaQueries, 4);
    assert.equal(database.identityQueries, 4);
  }
  assert.equal(requests, 2);
});

test('canonical worker refuses old schema, revoked/stale bindings, wrong digest/protocol, expired approval and lost lease before secret or wire', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    requests += 1;
    response.end();
  });
  for (const cause of ['schema', 'rights', 'capability', 'evidence', 'protocol', 'expiry', 'lease'] as const) {
    const target = canonicalWorkerTarget(local.baseUrl, 'chat', cause === 'expiry' ? '2000-01-01T00:00:00.000Z' : null);
    const { database, worker } = await setupCanonicalWorker(target, local.testOptions);
    t.after(() => worker.close());
    if (cause === 'schema') database.schemaReady = false;
    if (cause === 'rights') database.state.rightsCurrent = false;
    if (cause === 'capability') database.state.capabilityCurrent = false;
    if (cause === 'evidence') database.state.capabilityEvidenceSha256 = 'f'.repeat(64);
    if (cause === 'protocol') database.state.capabilityProtocol = 'openai-compatible';
    if (cause === 'lease') database.state.leaseCurrent = false;
    if (cause === 'schema') {
      await assert.rejects(
        worker.runOnce(),
        (error: unknown) => error instanceof CredentialValidationWorkerError && error.code === 'STORE_UNAVAILABLE',
      );
      assert.ok(database.schemaQueries > 0);
    } else {
      const result = await worker.runOnce();
      assert.ok(result === 'processed' || result === 'stale');
    }
    assert.equal(database.decryptCalls, 0, cause);
    assert.deepEqual(database.state.healthWrites, [], cause);
    assert.notEqual(database.state.jobStatus, 'verified', cause);
  }
  assert.equal(requests, 0);
});

test('canonical worker repeats rights/digest/generation checks after KMS and cannot dispatch a stale target', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    requests += 1;
    response.end();
  });
  const target = canonicalWorkerTarget(local.baseUrl);
  for (const cause of ['rights', 'evidence', 'generation'] as const) {
    const { database, worker } = await setupCanonicalWorker(target, local.testOptions, (current) => {
      if (cause === 'rights') current.state.rightsCurrent = false;
      if (cause === 'evidence') current.state.capabilityEvidenceSha256 = 'f'.repeat(64);
      if (cause === 'generation') current.state.leaseGeneration += 1;
    });
    t.after(() => worker.close());
    assert.equal(await worker.runOnce(), 'stale', cause);
    assert.equal(database.decryptCalls, 1);
    assert.deepEqual(database.state.healthWrites, []);
  }
  assert.equal(requests, 0);
});

test('canonical successful wire EOF never overrides revoked rights/digest or stale completion generation', async (t) => {
  let activeResponse: ServerResponse | undefined;
  let announce: (() => void) | undefined;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    activeResponse = response;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(JSON.stringify(probeEnvelope('chat')));
    assert.ok(announce);
    announce();
  });
  const target = canonicalWorkerTarget(local.baseUrl);
  for (const cause of ['rights', 'evidence', 'generation'] as const) {
    const { database, worker } = await setupCanonicalWorker(target, local.testOptions);
    t.after(async () => {
      activeResponse?.destroy();
      await worker.close();
    });
    const waiting = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const run = worker.runOnce();
    await waitForValidationFixtureSignal(waiting, run);
    assert.deepEqual(database.state.healthWrites, [], 'body without EOF is not verified');
    if (cause === 'rights') database.state.rightsCurrent = false;
    if (cause === 'evidence') database.state.capabilityEvidenceSha256 = 'f'.repeat(64);
    if (cause === 'generation') database.state.leaseGeneration += 1;
    assert.ok(activeResponse);
    activeResponse.end();
    assert.equal(await run, 'stale', cause);
    assert.deepEqual(database.state.healthWrites, []);
    assert.equal(database.state.credentialValidationState, 'unverified');
    assert.equal(database.state.accountValidationState, 'unverified');
  }
});

test('canonical actual claimed job rejects copied scope, key, allowed models and generation before KMS instead of approving a new binding', async (t) => {
  const target = canonicalWorkerTarget('https://validation.example/v1/');
  for (const cause of ['scope', 'key', 'allowedModels', 'generation'] as const) {
    const { database, worker, store } = await setupCanonicalWorker(target, undefined);
    t.after(() => worker.close());
    const lease = await store.claimNext();
    assert.ok(lease);
    const copied = {
      job: {
        ...lease.job,
        ...(cause === 'scope' ? { tenantId: 'tenant-copied' } : {}),
        ...(cause === 'key' ? { idempotencyKey: 'b'.repeat(64) } : {}),
        ...(cause === 'allowedModels' ? { allowedModels: [target.model, 'other-model'] } : {}),
      },
      fencingToken: cause === 'generation' ? lease.fencingToken + 1 : lease.fencingToken,
    };
    await assert.rejects(
      store.withCredential(copied, () => {
        throw new Error('copied claim cannot receive plaintext');
      }),
      (error: unknown) => error instanceof CredentialValidationWorkerError && error.code === 'LEASE_LOST',
    );
    assert.equal(database.identityQueries, 1);
    assert.equal(database.decryptCalls, 0);
    assert.deepEqual(database.state.healthWrites, []);
    assert.equal(database.state.accountValidationState, 'unverified');
    assert.equal(database.state.credentialValidationState, 'unverified');
  }
});

test('platform worker polls tenant first, then claims, decrypts, probes and verifies through its own owner queue', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    requests += 1;
    const messages = request.url === '/v1/messages';
    assert.ok(messages || request.url === '/v1/chat/completions');
    assert.equal(request.method, 'POST');
    assert.equal(
      request.headers[messages ? 'x-api-key' : 'authorization'],
      messages ? 'provider-test-token' : 'Bearer provider-test-token',
    );
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(probeEnvelope(messages ? 'messages' : 'chat')));
  });
  for (const kind of ['chat', 'messages'] as const) {
    const target = canonicalWorkerTarget(local.baseUrl, kind);
    const { database, worker } = await setupCanonicalWorker(target, local.testOptions, undefined, 'platform');
    t.after(() => worker.close());
    assert.equal(await worker.runOnce(), 'processed');
    // The empty tenant queue is always polled before the platform scope.
    assert.deepEqual(database.candidateQueries, ['tenant', 'platform']);
    assert.equal(database.decryptCalls, 1);
    assert.equal(database.state.jobStatus, 'verified');
    assert.equal(database.state.attemptCount, 1);
    assert.deepEqual(database.state.healthWrites, ['credential', 'account']);
    assert.equal(database.state.credentialStatus, 'active');
    assert.equal(database.state.credentialValidationState, 'verified');
    assert.equal(database.state.accountStatus, 'active');
    assert.equal(database.state.accountValidationState, 'verified');
    assert.deepEqual(database.state.requestedCapabilityProtocols, Array(4).fill(target.protocol));
    assert.equal(database.schemaQueries, 4);
    assert.equal(database.identityQueries, 4);
  }
  assert.equal(requests, 2);
});

test('platform terminal probe failure parks account and credential below the scheduler eligibility gate', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    requests += 1;
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'invalid key' } }));
  });
  const target = canonicalWorkerTarget(local.baseUrl, 'chat');
  const { database, worker } = await setupCanonicalWorker(target, local.testOptions, undefined, 'platform');
  t.after(() => worker.close());
  assert.equal(await worker.runOnce(), 'processed');
  assert.equal(requests, 1);
  assert.equal(database.decryptCalls, 1);
  assert.equal(database.state.jobStatus, 'failed');
  // Terminal failure health: pending + failed validation on both rows is
  // exactly what the scheduler eligibility SQL excludes from dispatch.
  assert.deepEqual(database.state.healthWrites, ['credential', 'account']);
  assert.equal(database.state.credentialStatus, 'pending');
  assert.equal(database.state.credentialValidationState, 'failed');
  assert.equal(database.state.accountStatus, 'pending');
  assert.equal(database.state.accountValidationState, 'failed');
  // R4 (migration 094): a 401-class terminal auth failure raises the
  // force-refresh flag on the credential row; every other terminal failure
  // class leaves it untouched (the CASE keys on the error-code parameter).
  assert.equal(database.state.credentialHealthStatements.length, 1);
  const credentialHealth = database.state.credentialHealthStatements[0] as string;
  assert.match(
    credentialHealth,
    /oauth_force_refresh_requested = CASE WHEN \$3 = 'credential_rejected' THEN true ELSE oauth_force_refresh_requested END/,
  );
});

test('a retryable-then-terminal non-auth failure keeps the force-refresh flag untouched', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    requests += 1;
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'no such endpoint' } }));
  });
  const target = canonicalWorkerTarget(local.baseUrl, 'chat');
  const { database, worker } = await setupCanonicalWorker(target, local.testOptions, undefined, 'platform');
  t.after(() => worker.close());
  assert.equal(await worker.runOnce(), 'processed');
  assert.equal(requests, 1);
  assert.equal(database.state.jobStatus, 'failed');
  assert.deepEqual(database.state.healthWrites, ['credential', 'account']);
  assert.equal(database.state.credentialHealthStatements.length, 1);
  const credentialHealth = database.state.credentialHealthStatements[0] as string;
  // The flag write is keyed strictly on the 401-class code: the SQL carries
  // the CASE but the provider_endpoint_unsupported error code can never satisfy it.
  assert.match(
    credentialHealth,
    /CASE WHEN \$3 = 'credential_rejected' THEN true ELSE oauth_force_refresh_requested END/,
  );
});

test('platform rights or capability revocation stops validation before KMS decryption or network fetch', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    requests += 1;
    response.end();
  });
  for (const revokedBinding of ['rights', 'capability'] as const) {
    const target = canonicalWorkerTarget(local.baseUrl, 'chat');
    const { database, worker } = await setupCanonicalWorker(target, local.testOptions, undefined, 'platform');
    t.after(() => worker.close());
    if (revokedBinding === 'rights') database.state.rightsCurrent = false;
    else database.state.capabilityCurrent = false;

    assert.equal(await worker.runOnce(), 'stale');
    assert.equal(database.decryptCalls, 0, `${revokedBinding} revocation must prevent KMS decryption`);
    assert.deepEqual(database.state.healthWrites, []);
    assert.equal(database.state.jobStatus, 'cancelled');
  }
  assert.equal(requests, 0);
});

test('the option-gated D3 sweep requeues a due terminal job and the same cycle revalidates it', async () => {
  let fetchCalls = 0;
  const { database, worker } = await setupWorker(
    async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    },
    undefined,
    undefined,
    { revalidationSweep: { intervalMs: 1_000, batchSize: 25 } },
  );
  database.state.jobStatus = 'verified';
  database.state.attemptCount = 3;
  database.state.revalidationDue = true;

  assert.equal(await worker.runOnce(), 'processed');

  // Both owner scopes are swept in poll order before the claim; the tenant
  // scope owns this fixture's queue, so the platform sweep is a no-op.
  assert.deepEqual(database.sweepQueries, ['tenant', 'platform']);
  assert.equal(database.lastSweepBatchSize, 25);
  // The requeue-transition reset attempts (3 -> 0) and the claim consumed one.
  assert.equal(database.state.attemptCount, 1);
  // Sweep + claim + completion each bump the lease generation once.
  assert.equal(database.state.leaseGeneration, 3);
  assert.equal(database.decryptCalls, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(database.state.jobStatus, 'verified');
  assert.deepEqual(database.state.healthWrites, ['credential', 'account']);
});

test('the D3 sweep leaves not-due terminal jobs untouched and runs only when configured', async () => {
  // Configured but not due: the sweep runs, the terminal job stays terminal.
  const idle = await setupWorker(async () => new Response(null, { status: 200 }), undefined, undefined, {
    revalidationSweep: { intervalMs: 1_000, batchSize: 10 },
  });
  idle.database.state.jobStatus = 'failed';

  assert.equal(await idle.worker.runOnce(), 'idle');
  assert.deepEqual(idle.database.sweepQueries, ['tenant', 'platform']);
  assert.equal(idle.database.state.jobStatus, 'failed');
  assert.equal(idle.database.decryptCalls, 0);
  assert.deepEqual(idle.database.state.healthWrites, []);

  // Due but the sweep option is absent: pre-D3 behavior, nothing is requeued.
  const disabled = await setupWorker(async () => new Response(null, { status: 200 }));
  disabled.database.state.jobStatus = 'verified';
  disabled.database.state.revalidationDue = true;

  assert.equal(await disabled.worker.runOnce(), 'idle');
  assert.deepEqual(disabled.database.sweepQueries, []);
  assert.equal(disabled.database.state.jobStatus, 'verified');
  assert.equal(disabled.database.decryptCalls, 0);
});

test('the D3 sweep interval gates repeat worker cycles', async () => {
  const { database, worker } = await setupWorker(
    async () => new Response(null, { status: 200 }),
    undefined,
    undefined,
    { revalidationSweep: { intervalMs: 60_000, batchSize: 10 } },
  );
  database.state.jobStatus = 'verified';

  assert.equal(await worker.runOnce(), 'idle');
  assert.equal(await worker.runOnce(), 'idle');
  // One sweep across both scopes for two cycles: the second cycle is gated.
  assert.deepEqual(database.sweepQueries, ['tenant', 'platform']);
});

test('the D3 sweep requeues due terminal jobs in the platform owner scope and bounds the batch', async () => {
  const sealingKms: ProviderCredentialKms = {
    async generateDataKey() {
      return { plaintextKey: Buffer.from(DATA_KEY), ciphertextBlob: Buffer.from('wrapped-test-key') };
    },
    async decryptDataKey() {
      return Buffer.from(DATA_KEY);
    },
  };
  const context = createProviderCredentialContext({
    ownerKind: 'platform',
    supplyMode: 'platform',
    deployment: 'worker-test',
    environment: 'test',
    purpose: 'inference',
    providerId: chatTarget.providerId,
    productId: chatTarget.productId,
    credentialType: 'api-key',
    accountId: 'account-a',
    credentialId: 'credential-a',
    credentialVersion: 1,
  });
  const envelope = await sealProviderCredential(Buffer.from('provider-test-token'), context, sealingKms, 'kms/test');
  const database = new FakeValidationDatabase(envelope, chatTarget, 'platform');
  const store = new PostgresCredentialValidationWorkerStore(database, sealingKms, {
    deployment: 'worker-test',
    environment: 'test',
  });
  database.state.jobStatus = 'failed';
  database.state.attemptCount = 4;
  database.state.revalidationDue = true;

  assert.equal(await store.requeueDueRevalidations(50), 1);
  assert.deepEqual(database.sweepQueries, ['tenant', 'platform']);
  assert.equal(database.lastSweepBatchSize, 50);
  assert.equal(database.state.jobStatus, 'queued');
  assert.equal(database.state.attemptCount, 0);
  assert.equal(database.state.leaseGeneration, 1);

  await assert.rejects(store.requeueDueRevalidations(0), (error: unknown) => {
    assert.ok(error instanceof CredentialValidationWorkerError);
    assert.equal(error.code, 'STORE_UNAVAILABLE');
    return true;
  });
});

// --- R5 credential quarantine (migration 097) --------------------------------
//
// Between cycles the fake queue is re-armed by direct state assignment: the
// D3 sweep only requeues verified/active accounts, so consecutive terminal
// failures reach the worker through external requeue drivers (the 061 audited
// channel, rotation-enqueued jobs). Counting, entry, exit and sweep cadence
// separation are what these tests pin; the 097 guard trigger's 55006 matrix
// is pinned against real PostgreSQL in account-quarantine.postgres.integration.test.ts.

const r5UnauthorizedFetch: ProviderCredentialValidationFetch = async () => new Response(null, { status: 401 });

/** One claim -> 401 probe -> terminal failure cycle; the job ends 'failed'. */
async function r5FailCycle(worker: CredentialValidationWorker, database: FakeValidationDatabase): Promise<void> {
  database.state.healthWrites.length = 0;
  // The external requeue driver resets the per-cycle attempt budget.
  database.state.jobStatus = 'queued';
  database.state.attemptCount = 0;
  assert.equal(await worker.runOnce(), 'processed');
  assert.equal(database.state.jobStatus, 'failed');
  assert.deepEqual(database.state.healthWrites, ['credential', 'account']);
}

async function r5SetupPlatformWorker(
  fetcher: ProviderCredentialValidationFetch,
  extraOptions: Partial<CredentialValidationWorkerOptions> = {},
): Promise<{ readonly database: FakeValidationDatabase; readonly worker: CredentialValidationWorker }> {
  const sealingKms: ProviderCredentialKms = {
    async generateDataKey() {
      return { plaintextKey: Buffer.from(DATA_KEY), ciphertextBlob: Buffer.from('wrapped-test-key') };
    },
    async decryptDataKey() {
      return Buffer.from(DATA_KEY);
    },
  };
  const context = createProviderCredentialContext({
    ownerKind: 'platform',
    supplyMode: 'platform',
    deployment: 'worker-test',
    environment: 'test',
    purpose: 'inference',
    providerId: chatTarget.providerId,
    productId: chatTarget.productId,
    credentialType: 'api-key',
    accountId: 'account-a',
    credentialId: 'credential-a',
    credentialVersion: 1,
  });
  const envelope = await sealProviderCredential(Buffer.from('provider-test-token'), context, sealingKms, 'kms/test');
  const database = new FakeValidationDatabase(envelope, chatTarget, 'platform');
  const worker = new CredentialValidationWorker(database, sealingKms, {
    deployment: 'worker-test',
    environment: 'test',
    fetch: fetcher,
    ...extraOptions,
  });
  return { database, worker };
}

test('R5 quarantine entry: consecutive terminal failures enter quarantine only at the threshold', async () => {
  const audits: ProviderAccountQuarantineAuditEvent[] = [];
  const { database, worker } = await setupWorker(r5UnauthorizedFetch, undefined, undefined, {
    onAccountQuarantined: (event) => {
      audits.push(event);
    },
  });
  try {
    for (let cycle = 1; cycle < PROVIDER_ACCOUNT_QUARANTINE_FAILURE_THRESHOLD; cycle += 1) {
      await r5FailCycle(worker, database);
      assert.equal(database.state.accountValidationState, 'failed');
      assert.equal(database.state.accountValidationErrorCode, 'credential_rejected');
      assert.equal(database.state.quarantineEntries.length, 0, `cycle ${cycle} must stay below the entry threshold`);
      assert.equal(audits.length, 0);
    }

    await r5FailCycle(worker, database);
    assert.equal(database.state.accountValidationState, 'quarantined');
    assert.equal(
      database.state.accountValidationErrorCode,
      null,
      'the terminal error code migrates into the quarantine reason in the same statement',
    );
    assert.equal(database.state.quarantineEntries.length, 1);
    assert.equal(database.state.quarantineEntries[0]?.reasonCode, 'credential_rejected');
    assert.equal(audits.length, 1, 'exactly one entry audit per actual transition');
    const event = audits[0];
    assert.equal(event?.action, PROVIDER_ACCOUNT_QUARANTINE_AUDIT_ACTION);
    assert.equal(event?.action, 'provider_supply.account.quarantined');
    assert.equal(event?.ownerKind, 'tenant');
    assert.equal(event?.tenantId, 'tenant-a');
    assert.equal(event?.accountId, 'account-a');
    assert.equal(event?.reasonCode, 'credential_rejected');
    assert.ok(!Number.isNaN(Date.parse(event?.enteredAt ?? '')), 'enteredAt is the persisted DB-clock timestamp');

    // A failed probe against the quarantined account keeps it quarantined:
    // the preserving CASE admits only last_validated_at advancement, the
    // entry facts stay immutable, and no second entry/audit can occur.
    const healthBefore = database.state.accountHealthStatements.length;
    await r5FailCycle(worker, database);
    assert.equal(database.state.accountValidationState, 'quarantined');
    assert.equal(database.state.quarantineEntries.length, 1);
    assert.equal(audits.length, 1);
    assert.equal(database.state.accountHealthStatements.length, healthBefore + 1);
  } finally {
    await worker.close();
  }
});

test('R5 quarantine re-entry while already quarantined is a no-op without a duplicate audit', async () => {
  const audits: ProviderAccountQuarantineAuditEvent[] = [];
  const { database, worker } = await setupWorker(r5UnauthorizedFetch, undefined, undefined, {
    onAccountQuarantined: (event) => {
      audits.push(event);
    },
  });
  try {
    for (let cycle = 0; cycle < PROVIDER_ACCOUNT_QUARANTINE_FAILURE_THRESHOLD; cycle += 1) {
      await r5FailCycle(worker, database);
    }
    assert.equal(database.state.accountValidationState, 'quarantined');
    assert.equal(audits.length, 1);

    // Even after the in-memory count reaches the threshold again, the entry
    // UPDATE re-gates on validation_state = 'failed': zero rows, zero audits.
    for (let cycle = 0; cycle < PROVIDER_ACCOUNT_QUARANTINE_FAILURE_THRESHOLD; cycle += 1) {
      await r5FailCycle(worker, database);
    }
    assert.equal(database.state.accountValidationState, 'quarantined');
    assert.equal(database.state.quarantineEntries.length, 1);
    assert.equal(audits.length, 1);
  } finally {
    await worker.close();
  }
});

test('R5 quarantine exit: a successful probe returns to verified, clears facts and restarts the count', async () => {
  let fail = true;
  const audits: ProviderAccountQuarantineAuditEvent[] = [];
  const { database, worker } = await setupWorker(
    async () => new Response(null, { status: fail ? 401 : 200 }),
    undefined,
    undefined,
    {
      onAccountQuarantined: (event) => {
        audits.push(event);
      },
    },
  );
  try {
    for (let cycle = 0; cycle < PROVIDER_ACCOUNT_QUARANTINE_FAILURE_THRESHOLD; cycle += 1) {
      await r5FailCycle(worker, database);
    }
    assert.equal(database.state.accountValidationState, 'quarantined');
    assert.equal(audits.length, 1);

    fail = false;
    database.state.jobStatus = 'queued';
    database.state.attemptCount = 0;
    assert.equal(await worker.runOnce(), 'processed');
    assert.equal(database.state.jobStatus, 'verified');
    assert.equal(database.state.accountValidationState, 'verified');
    assert.equal(database.state.accountStatus, 'active');
    const exitStatement = database.state.accountHealthStatements.at(-1) ?? '';
    assert.match(exitStatement, /quarantine_entered_at = CASE WHEN \$2 = 'verified' THEN NULL/);
    assert.match(exitStatement, /quarantine_reason_code = CASE WHEN \$2 = 'verified' THEN NULL/);

    // The consecutive count restarted at zero: two fresh failures stay failed.
    fail = true;
    await r5FailCycle(worker, database);
    await r5FailCycle(worker, database);
    assert.equal(database.state.accountValidationState, 'failed');
    assert.equal(database.state.quarantineEntries.length, 1);
    assert.equal(audits.length, 1);
  } finally {
    await worker.close();
  }
});

test('R5 quarantine counting is consecutive: a verified completion resets the episode', async () => {
  let fail = true;
  const audits: ProviderAccountQuarantineAuditEvent[] = [];
  const { database, worker } = await setupWorker(
    async () => new Response(null, { status: fail ? 401 : 200 }),
    undefined,
    undefined,
    {
      onAccountQuarantined: (event) => {
        audits.push(event);
      },
    },
  );
  try {
    await r5FailCycle(worker, database);
    await r5FailCycle(worker, database);
    fail = false;
    database.state.jobStatus = 'queued';
    database.state.attemptCount = 0;
    assert.equal(await worker.runOnce(), 'processed');
    assert.equal(database.state.accountValidationState, 'verified');

    fail = true;
    await r5FailCycle(worker, database);
    await r5FailCycle(worker, database);
    assert.equal(database.state.accountValidationState, 'failed');
    assert.equal(database.state.quarantineEntries.length, 0, 'interleaved success must reset consecutiveness');
    assert.equal(audits.length, 0);

    await r5FailCycle(worker, database);
    assert.equal(database.state.accountValidationState, 'quarantined');
    assert.equal(audits.length, 1);
  } finally {
    await worker.close();
  }
});

test('R5 quarantine entry works in the platform owner scope', async () => {
  const audits: ProviderAccountQuarantineAuditEvent[] = [];
  const { database, worker } = await r5SetupPlatformWorker(r5UnauthorizedFetch, {
    onAccountQuarantined: (event) => {
      audits.push(event);
    },
  });
  try {
    for (let cycle = 1; cycle < PROVIDER_ACCOUNT_QUARANTINE_FAILURE_THRESHOLD; cycle += 1) {
      await r5FailCycle(worker, database);
      assert.equal(database.state.accountValidationState, 'failed');
      assert.equal(audits.length, 0);
    }
    await r5FailCycle(worker, database);
    assert.equal(database.state.accountValidationState, 'quarantined');
    assert.equal(database.state.quarantineEntries.length, 1);
    assert.equal(database.state.quarantineEntries[0]?.reasonCode, 'credential_rejected');
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.ownerKind, 'platform');
    assert.equal(audits[0]?.tenantId, null);
    assert.equal(audits[0]?.accountId, 'account-a');
  } finally {
    await worker.close();
  }
});

test('R5 sweep: quarantined accounts requeue on the independent cadence, others keep their interval', async () => {
  const sealingKms: ProviderCredentialKms = {
    async generateDataKey() {
      return { plaintextKey: Buffer.from(DATA_KEY), ciphertextBlob: Buffer.from('wrapped-test-key') };
    },
    async decryptDataKey() {
      return Buffer.from(DATA_KEY);
    },
  };
  const envelope = await sealProviderCredential(
    Buffer.from('provider-test-token'),
    createProviderCredentialContext({
      ownerKind: 'tenant',
      tenantId: 'tenant-a',
      supplyMode: 'byok',
      deployment: 'worker-test',
      environment: 'test',
      purpose: 'inference',
      providerId: chatTarget.providerId,
      productId: chatTarget.productId,
      credentialType: 'api-key',
      accountId: 'account-a',
      credentialId: 'credential-a',
      credentialVersion: 1,
    }),
    sealingKms,
    'kms/test',
  );
  const storeFor = (quarantineRevalidationSeconds?: number) => {
    const database = new FakeValidationDatabase(envelope, chatTarget);
    const store = new PostgresCredentialValidationWorkerStore(database, sealingKms, {
      deployment: 'worker-test',
      environment: 'test',
      ...(quarantineRevalidationSeconds === undefined ? {} : { quarantineRevalidationSeconds }),
    });
    return { database, store };
  };

  // Quarantined and due on the option cadence: requeued even though the
  // account's own interval path is not due (revalidationDue stays false).
  const quarantined = storeFor(3_600);
  quarantined.database.state.jobStatus = 'failed';
  quarantined.database.state.accountValidationState = 'quarantined';
  quarantined.database.state.quarantineDue = true;
  assert.equal(await quarantined.store.requeueDueRevalidations(50), 1);
  assert.equal(quarantined.database.state.jobStatus, 'queued');
  assert.equal(quarantined.database.state.attemptCount, 0);
  assert.equal(quarantined.database.lastSweepQuarantineSeconds, 3_600);

  // Quarantined but not yet due on the option cadence: untouched.
  const early = storeFor(3_600);
  early.database.state.jobStatus = 'failed';
  early.database.state.accountValidationState = 'quarantined';
  assert.equal(await early.store.requeueDueRevalidations(50), 0);
  assert.equal(early.database.state.jobStatus, 'failed');

  // Non-quarantined accounts ignore the quarantine cadence entirely: the 084
  // interval predicate is unchanged.
  const failed = storeFor(3_600);
  failed.database.state.jobStatus = 'failed';
  failed.database.state.accountValidationState = 'failed';
  failed.database.state.revalidationDue = true;
  assert.equal(await failed.store.requeueDueRevalidations(50), 1);
  assert.equal(failed.database.state.jobStatus, 'queued');

  // The default cadence is the 6h constant.
  const defaulted = storeFor();
  defaulted.database.state.jobStatus = 'failed';
  await defaulted.store.requeueDueRevalidations(50);
  assert.equal(defaulted.database.lastSweepQuarantineSeconds, CREDENTIAL_VALIDATION_QUARANTINE_REVALIDATION_SECONDS);
  assert.equal(CREDENTIAL_VALIDATION_QUARANTINE_REVALIDATION_SECONDS, 21_600);
});

test('R5 quarantine cadence option is bounded to the 084 interval range', async () => {
  const sealingKms: ProviderCredentialKms = {
    async generateDataKey() {
      return { plaintextKey: Buffer.from(DATA_KEY), ciphertextBlob: Buffer.from('wrapped-test-key') };
    },
    async decryptDataKey() {
      return Buffer.from(DATA_KEY);
    },
  };
  const envelope = await sealProviderCredential(
    Buffer.from('provider-test-token'),
    createProviderCredentialContext({
      ownerKind: 'tenant',
      tenantId: 'tenant-a',
      supplyMode: 'byok',
      deployment: 'worker-test',
      environment: 'test',
      purpose: 'inference',
      providerId: chatTarget.providerId,
      productId: chatTarget.productId,
      credentialType: 'api-key',
      accountId: 'account-a',
      credentialId: 'credential-a',
      credentialVersion: 1,
    }),
    sealingKms,
    'kms/test',
  );
  const construct = (quarantineRevalidationSeconds: number) =>
    new PostgresCredentialValidationWorkerStore(new FakeValidationDatabase(envelope, chatTarget), sealingKms, {
      deployment: 'worker-test',
      environment: 'test',
      quarantineRevalidationSeconds,
    });
  for (const invalid of [899, 604_801, 0, -1, Number.NaN, 1.5]) {
    assert.throws(
      () => construct(invalid),
      (error: unknown) => error instanceof CredentialValidationWorkerError && error.code === 'STORE_UNAVAILABLE',
    );
  }
  construct(900);
  construct(604_800);
});

test('OAuth onboarding job probes the sealed grant and marks the platform account verified', async () => {
  const target: WorkerTarget = {
    providerId: 'openai-codex',
    productId: 'codex-chatgpt',
    model: 'gpt-5.3-codex',
    endpoint: 'codex-responses',
    protocol: 'responses',
    credentialType: 'oauth',
  };
  const secret = Buffer.from(
    JSON.stringify({
      access_token: 'codex-access-token',
      refresh_token: 'codex-refresh-token',
      token_type: 'Bearer',
      chatgpt_account_id: 'acct-123',
    }),
  );
  let requests = 0;
  const { database, worker } = await setupWorker(
    async (url, init) => {
      requests += 1;
      assert.equal(url.href, 'https://chatgpt.com/backend-api/codex/responses');
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), 'Bearer codex-access-token');
      assert.equal(headers.get('chatgpt-account-id'), 'acct-123');
      assert.equal(headers.get('openai-beta'), 'responses=experimental');
      const body = JSON.parse(String(init.body)) as {
        input?: Array<{ content?: Array<{ text?: unknown }> }>;
      };
      const prompt = body.input?.[0]?.content?.[0]?.text;
      const challenge = /([0-9]{6})/.exec(String(prompt))?.[1];
      assert.ok(challenge);
      return new Response(
        JSON.stringify({
          id: 'resp_worker_test',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: challenge }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
    undefined,
    target,
    {},
    secret,
    'platform',
  );
  try {
    assert.equal(await worker.runOnce(), 'processed');
    assert.equal(requests, 1);
    assert.equal(database.state.jobStatus, 'verified');
    assert.deepEqual(database.state.healthWrites, ['credential', 'account']);
    assert.equal(database.state.credentialStatus, 'active');
    assert.equal(database.state.credentialValidationState, 'verified');
    assert.equal(database.state.accountStatus, 'active');
    assert.equal(database.state.accountValidationState, 'verified');
    assert.ok(database.state.requestedCapabilityProtocols.length >= 3);
    assert.ok(database.state.requestedCapabilityProtocols.every((protocol) => protocol === 'responses'));
  } finally {
    await worker.close();
  }
});
