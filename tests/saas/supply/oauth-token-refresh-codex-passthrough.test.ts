import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import {
  CODEX_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
  type OauthCredentialRotationInput,
  type OauthTokenRefreshFetch,
  oauthEnvelopePassthroughFields,
  PostgresOauthTokenRefreshWorkerStore,
} from '../../../src/saas/supply/oauth-token-refresh-worker.js';

/**
 * P1c R4 passthrough coverage (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.3 + P1c handoff):
 * a codex rotation must keep the ChatGPT account metadata the gateway needs
 * (chatgpt_account_id/user_id, plan_type, client_id) even though the
 * refresh-token endpoint never returns it, while the anthropic binding keeps
 * the strict token-only envelope.
 */

type Row = Record<string, unknown>;

const DEPLOYMENT = 'r4-codex-passthrough-deployment';
const ENVIRONMENT = 'r4-codex-passthrough-env';

const codexCatalogBinding = { providerId: 'openai-codex', productId: 'codex-chatgpt', credentialType: 'oauth' };
const anthropicBinding = { providerId: 'anthropic', productId: 'claude-code', credentialType: 'oauth' };

const CODEX_OLD_ENVELOPE = JSON.stringify({
  access_token: 'accs-old-token',
  refresh_token: 'rfrsh-old-token',
  token_type: 'Bearer',
  expires_in: 1800,
  chatgpt_account_id: 'chatgpt-acct-1',
  chatgpt_user_id: 'chatgpt-user-1',
  plan_type: 'pro',
  client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
  email: 'operator@example.test',
});

const plaintextKey = Buffer.alloc(32, 0x71);
const sealingKms = {
  generateDataKey: async () => ({ plaintextKey, ciphertextBlob: Buffer.from('codex-passthrough-wrapped-dek') }),
};
const unsealingKms: ProviderCredentialUnsealingKms = {
  decryptDataKey: async () => plaintextKey,
};

async function sealCodexFixture(plaintext: string, providerId: string, productId: string): Promise<Row> {
  const context = createProviderCredentialContext({
    ownerKind: 'platform',
    supplyMode: 'platform',
    deployment: DEPLOYMENT,
    environment: ENVIRONMENT,
    purpose: 'inference',
    providerId,
    productId,
    credentialType: 'oauth',
    accountId: 'account-codex',
    credentialId: 'credential-codex',
    credentialVersion: 1,
  });
  const envelope = await sealProviderCredential(Buffer.from(plaintext), context, sealingKms, 'codex-passthrough-kms');
  return {
    version: 1,
    schema_version: 1,
    context_version: 1,
    algorithm: 'aes-256-gcm',
    kms_purpose: 'inference',
    kms_key_id: envelope.kmsKeyId,
    wrapped_dek: envelope.wrappedDek,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    auth_tag: envelope.authTag,
  };
}

interface FakeState {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
  updates: Array<{ sql: string; values: readonly unknown[] }>;
  candidateRows: Row[];
  versionRows: Row[];
}

class FakeDatabase implements SaasDatabase {
  constructor(
    private readonly state: FakeState,
    private readonly ownerTables: { candidates: string; versions: string },
  ) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.state.statements.push({ sql, values });
    if (sql.startsWith('UPDATE')) {
      this.state.updates.push({ sql, values });
      return { rows: [] as RowType[], rowCount: 1 };
    }
    let rows: Row[];
    if (sql.includes('FOR UPDATE OF credential SKIP LOCKED')) {
      rows = this.state.candidateRows;
    } else if (sql.includes('_provider_credential_versions')) {
      rows = this.state.versionRows;
    } else if (sql.includes('_provider_credentials')) {
      rows = sql.includes(this.ownerTables.candidates) ? this.state.candidateRows : [];
    } else {
      throw new Error(`unexpected SQL statement: ${sql.slice(0, 120)}`);
    }
    return { rows: rows as RowType[], rowCount: rows.length };
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }
  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function codexFakeState(versionRow: Row): FakeState {
  return {
    statements: [],
    updates: [],
    candidateRows: [
      {
        id: 'credential-codex',
        account_id: 'account-codex',
        provider_id: codexCatalogBinding.providerId,
        product_id: codexCatalogBinding.productId,
        credential_type: 'oauth',
        current_version: 1,
        oauth_refresh_state: 'idle',
        oauth_next_refresh_at: new Date('2026-01-01T00:00:00Z'),
        oauth_last_refresh_at: new Date('2025-12-31T23:00:00Z'),
        purpose: 'inference',
      },
    ],
    versionRows: [versionRow],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

function fetchReturning(response: Response): OauthTokenRefreshFetch {
  return async () => response;
}

interface RecordedRotation {
  readonly input: OauthCredentialRotationInput;
  readonly secretJson: unknown;
}

async function runRefresh(
  state: FakeState,
  fetch: OauthTokenRefreshFetch,
): Promise<{ outcome: unknown; recorded: RecordedRotation[] }> {
  const recorded: RecordedRotation[] = [];
  const store = new PostgresOauthTokenRefreshWorkerStore(
    new FakeDatabase(state, {
      candidates: 'saas_platform_provider_credentials',
      versions: 'saas_platform_provider_credential_versions',
    }),
    unsealingKms,
    { deployment: DEPLOYMENT, environment: ENVIRONMENT, fetch },
  );
  const outcome = await store.refreshNext(async (input) => {
    recorded.push({ input, secretJson: JSON.parse(Buffer.from(input.secret).toString('utf8')) });
    return { version: input.expectedVersion + 1 };
  });
  return { outcome, recorded };
}

test('codex bindings declare the ChatGPT envelope passthrough fields; anthropic does not', () => {
  assert.deepEqual(oauthEnvelopePassthroughFields(codexCatalogBinding), CODEX_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS);
  assert.deepEqual(oauthEnvelopePassthroughFields(anthropicBinding), []);
  assert.deepEqual(
    oauthEnvelopePassthroughFields({ providerId: 'unknown', productId: 'unknown', credentialType: 'oauth' }),
    [],
  );
});

test('a codex rotation preserves the old envelope ChatGPT metadata (P1c R4 passthrough)', async () => {
  const versionRow = await sealCodexFixture(
    CODEX_OLD_ENVELOPE,
    codexCatalogBinding.providerId,
    codexCatalogBinding.productId,
  );
  const state = codexFakeState(versionRow);
  // The endpoint returns tokens only — no chatgpt metadata in the response.
  const { outcome, recorded } = await runRefresh(
    state,
    fetchReturning(
      jsonResponse({ access_token: 'accs-new-token', refresh_token: 'rfrsh-new-token', expires_in: 3600 }),
    ),
  );
  assert.equal(outcome.outcome, 'refreshed');
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0]?.secretJson, {
    access_token: 'accs-new-token',
    refresh_token: 'rfrsh-new-token',
    token_type: 'Bearer',
    expires_in: 3600,
    chatgpt_account_id: 'chatgpt-acct-1',
    chatgpt_user_id: 'chatgpt-user-1',
    plan_type: 'pro',
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
  });
});

test('a value the token endpoint actually returns overrides the old envelope metadata', async () => {
  const versionRow = await sealCodexFixture(
    CODEX_OLD_ENVELOPE,
    codexCatalogBinding.providerId,
    codexCatalogBinding.productId,
  );
  const state = codexFakeState(versionRow);
  const { outcome, recorded } = await runRefresh(
    state,
    fetchReturning(
      jsonResponse({
        access_token: 'accs-new-token',
        refresh_token: 'rfrsh-new-token',
        expires_in: 3600,
        plan_type: 'business',
      }),
    ),
  );
  assert.equal(outcome.outcome, 'refreshed');
  assert.deepEqual(recorded[0]?.secretJson, {
    access_token: 'accs-new-token',
    refresh_token: 'rfrsh-new-token',
    token_type: 'Bearer',
    expires_in: 3600,
    chatgpt_account_id: 'chatgpt-acct-1',
    chatgpt_user_id: 'chatgpt-user-1',
    plan_type: 'business',
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
  });
});

test('an anthropic rotation never carries passthrough fields even when the envelope had them', async () => {
  // The anthropic envelope legitimately carries none of the codex fields, but
  // the guard must be structural (binding identity), not accidental.
  const versionRow = await sealCodexFixture(
    JSON.stringify({
      access_token: 'accs-old-token',
      refresh_token: 'rfrsh-old-token',
      token_type: 'Bearer',
      expires_in: 1800,
      chatgpt_account_id: 'chatgpt-acct-1',
    }),
    anthropicBinding.providerId,
    anthropicBinding.productId,
  );
  const state: FakeState = {
    statements: [],
    updates: [],
    candidateRows: [
      {
        id: 'credential-codex',
        account_id: 'account-codex',
        provider_id: anthropicBinding.providerId,
        product_id: anthropicBinding.productId,
        credential_type: 'oauth',
        current_version: 1,
        oauth_refresh_state: 'idle',
        oauth_next_refresh_at: new Date('2026-01-01T00:00:00Z'),
        oauth_last_refresh_at: new Date('2025-12-31T23:00:00Z'),
        purpose: 'inference',
      },
    ],
    versionRows: [versionRow],
  };
  const { outcome, recorded } = await runRefresh(
    state,
    fetchReturning(
      jsonResponse({ access_token: 'accs-new-token', refresh_token: 'rfrsh-new-token', expires_in: 3600 }),
    ),
  );
  assert.equal(outcome.outcome, 'refreshed');
  assert.deepEqual(recorded[0]?.secretJson, {
    access_token: 'accs-new-token',
    refresh_token: 'rfrsh-new-token',
    token_type: 'Bearer',
    expires_in: 3600,
  });
});
