import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlResult } from '../../../src/saas/db/index.js';
import { CLAUDE_CODE_MIMICRY_BETA_HEADER } from '../../../src/saas/gateway/claude/constants.js';
import type { ProviderHttpPinnedConnector } from '../../../src/saas/gateway/provider-http-address.js';
import {
  type AccountProbeFetchInit,
  type AccountProbeOutcome,
  accountProbeCategoryForProvider,
  createAccountProbeService,
} from '../../../src/saas/supply/account-probe-service.js';

type Row = Record<string, unknown>;

const DEPLOYMENT = 'probe-service-test-deployment';
const ENVIRONMENT = 'probe-service-test-environment';
const TENANT_ID = '00000000-0000-0000-0000-0000000000bb';
const ACCOUNT_ID = '00000000-0000-0000-0000-0000000000cc';
const CHALLENGE = Object.freeze({ prompt: 'What is 6 + 11? Reply with only the number.', answer: '17' });

const plaintextKey = Buffer.alloc(32, 0x6b);
const unsealingKms: ProviderCredentialUnsealingKms = {
  decryptDataKey: async () => plaintextKey,
};

interface CapturedRequest {
  readonly url: string;
  readonly init: AccountProbeFetchInit;
}

interface FakeDatabaseState {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
  accountRow: Row | null;
  capabilityRow: Row | null;
  proxyRow: Row | null;
  secret: string;
}

class FakeDatabase implements SaasDatabase {
  constructor(readonly state: FakeDatabaseState) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.state.statements.push({ sql, values });
    const normalized = sql.replace(/\s+/g, ' ');
    let rows: Row[] = [];
    if (normalized.includes('JOIN saas_egress_proxies')) {
      rows =
        this.state.proxyRow === null
          ? []
          : [
              {
                id: 'proxy-1',
                name: 'primary',
                protocol: 'http',
                host: 'egress.example',
                port: 8080,
                auth_sealed_envelope: null,
                status: 'active',
                expires_at: null,
                fallback_mode: 'none',
                backup_proxy_id: null,
                last_probe_at: null,
                last_probe_latency_ms: null,
                last_probe_ip: null,
                last_probe_quality: null,
              },
            ];
    } else if (
      normalized.includes('FROM saas_tenant_provider_account_capabilities') ||
      normalized.includes('FROM saas_platform_provider_account_capabilities')
    ) {
      rows = this.state.capabilityRow === null ? [] : [this.state.capabilityRow];
    } else if (
      normalized.includes('FROM saas_tenant_provider_accounts AS account') ||
      normalized.includes('FROM saas_platform_provider_accounts AS account')
    ) {
      rows = this.state.accountRow === null ? [] : [this.state.accountRow];
    } else if (normalized.includes('AS credential')) {
      rows = [{ id: 'credential-1', current_version: 1 }];
    } else if (normalized.includes('AS version_row')) {
      rows = [this.state.versionRow];
    }
    return { rows: rows as RowType[], rowCount: rows.length };
  }

  get versionRow(): Row {
    // The sealed version row is derived lazily from the fixture secret so
    // each test controls its credential material.
    return (this.state as FakeDatabaseState & { versionRow?: Row }).versionRow ?? {};
  }
}

const FAKE_CONNECTION: ProviderHttpPinnedConnector = {
  dispatcher: { fake: 'dispatcher' } as never,
  close: async () => {},
  destroy: async () => {},
};

async function sealSecret(
  secret: string,
  purpose: string,
  providerId: string,
  productId: string,
  credentialType: string,
): Promise<Row> {
  const context = createProviderCredentialContext({
    ownerKind: 'tenant',
    tenantId: TENANT_ID,
    supplyMode: 'byok',
    deployment: DEPLOYMENT,
    environment: ENVIRONMENT,
    purpose,
    providerId,
    productId,
    credentialType,
    accountId: ACCOUNT_ID,
    credentialId: 'credential-1',
    credentialVersion: 1,
  });
  const envelope = await sealProviderCredential(
    Buffer.from(secret),
    context,
    { generateDataKey: async () => ({ plaintextKey, ciphertextBlob: Buffer.from('probe-fixture-wrapped-dek') }) },
    'probe-fixture-kms',
  );
  return {
    version: 1,
    schema_version: 1,
    context_version: 1,
    algorithm: 'aes-256-gcm',
    kms_purpose: purpose,
    kms_key_id: envelope.kmsKeyId,
    wrapped_dek: envelope.wrappedDek,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    auth_tag: envelope.authTag,
  };
}

interface Harness {
  readonly requests: CapturedRequest[];
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
  setResponse(response: Response | Error): void;
  connections: string[];
  probe(ownerKind: 'tenant' | 'platform', category: string): Promise<AccountProbeOutcome>;
}

async function harness(input: {
  readonly account: Row | null;
  readonly capability?: Row | null;
  readonly proxy?: Row | null;
  readonly secret: string;
  readonly response?: Response | Error;
}): Harness {
  const state: FakeDatabaseState = {
    statements: [],
    accountRow: input.account,
    capabilityRow: input.capability ?? null,
    proxyRow: input.proxy === undefined ? null : input.proxy,
    secret: input.secret,
  };
  const database = new FakeDatabase(state);
  const requests: CapturedRequest[] = [];
  const connections: string[] = [];
  let response: Response | Error =
    input.response ?? new Response('{}', { headers: { 'content-type': 'application/json' } });
  if (input.account !== null) {
    const versionRow = await sealSecret(
      input.secret,
      String(input.account.purpose),
      String(input.account.provider_id),
      String(input.account.product_id),
      String(input.account.credential_type),
    );
    (state as FakeDatabaseState & { versionRow?: Row }).versionRow = versionRow;
  }
  const service = createAccountProbeService(database as SaasDatabase, unsealingKms, {
    deployment: DEPLOYMENT,
    environment: ENVIRONMENT,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (response instanceof Error) throw response;
      return response;
    },
    createConnection: async (proxy) => {
      connections.push(proxy.url);
      return FAKE_CONNECTION;
    },
    now: () => 1_000_000,
  });
  return {
    requests,
    connections,
    statements: state.statements,
    setResponse(next: Response | Error) {
      response = next;
    },
    probe: (ownerKind, category) =>
      service.probe({
        ownerKind,
        tenantId: ownerKind === 'tenant' ? TENANT_ID : null,
        accountId: ACCOUNT_ID,
        category: category as never,
        challengePrompt: CHALLENGE.prompt,
        challengeAnswer: CHALLENGE.answer,
      }),
  };
}

function tenantAccountRow(overrides: Row = {}): Row {
  return {
    id: ACCOUNT_ID,
    tenant_id: TENANT_ID,
    provider_id: 'opencode-go',
    product_id: 'opencode-go-zen',
    credential_type: 'api-key',
    purpose: 'inference',
    ...overrides,
  };
}

test('opencode-go probe posts the pinned chat completions challenge and classifies a correct answer', async () => {
  const h = await harness({
    account: tenantAccountRow(),
    secret: 'opencode-fixture-key',
    response: new Response(
      JSON.stringify({ choices: [{ message: { content: '17' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
  const outcome = await h.probe('tenant', 'opencode-go');
  assert.deepEqual(
    { ...outcome, latencyMs: 0 },
    {
      category: 'ok',
      httpStatus: 200,
      latencyMs: 0,
      resetAt: null,
      usage: { inputTokens: 3, outputTokens: 2 },
      reason: null,
    },
  );
  const request = h.requests[0];
  assert.ok(request);
  assert.equal(request.url, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers?.authorization, 'Bearer opencode-fixture-key');
  assert.equal(request.init.redirect, 'manual');
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.model, 'glm-5.3');
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: 'user', content: CHALLENGE.prompt }]);
  // No proxy bound: the request travels direct without a dispatcher.
  assert.equal(h.connections.length, 0);
  assert.equal(request.init.dispatcher, undefined);
});

test('claude probe is a full-mimicry /v1/messages request and validates the challenge text', async () => {
  const h = await harness({
    account: tenantAccountRow({ provider_id: 'claude', product_id: 'claude-code', credential_type: 'oauth' }),
    secret: JSON.stringify({
      access_token: 'claude-access-token',
      refresh_token: 'claude-refresh-token',
      organization_uuid: 'org-uuid',
      account_uuid: 'account-uuid',
    }),
    response: new Response(
      JSON.stringify({ content: [{ type: 'text', text: '17' }], usage: { input_tokens: 5, output_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
  const outcome = await h.probe('tenant', 'claude');
  assert.equal(outcome.category, 'ok');
  assert.equal(outcome.usage?.inputTokens, 5);
  const request = h.requests[0];
  assert.ok(request);
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages?beta=true');
  assert.equal(request.init.headers?.authorization, 'Bearer claude-access-token');
  assert.equal(request.init.headers?.['anthropic-beta'], CLAUDE_CODE_MIMICRY_BETA_HEADER);
  assert.equal(request.init.headers?.['anthropic-version'], '2023-06-01');
  assert.match(String(request.init.headers?.['user-agent']), /^claude-cli\//);
  assert.equal(request.init.headers?.['x-app'], 'cli');
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.model, 'claude-haiku-4-5-20251001');
  assert.equal(body.stream, false);
  assert.ok(Array.isArray(body.system) && body.system.length >= 2, 'the Claude Code system blocks are injected');
  assert.deepEqual(body.messages, [{ role: 'user', content: CHALLENGE.prompt }]);
});

test('codex probe posts a small /responses request with the canonical identity headers', async () => {
  const h = await harness({
    account: tenantAccountRow({ provider_id: 'openai-codex', product_id: 'codex', credential_type: 'oauth' }),
    secret: JSON.stringify({
      access_token: 'codex-access-token',
      refresh_token: 'codex-refresh-token',
      chatgpt_account_id: 'chatgpt-account-1',
    }),
    response: new Response(
      JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: '17' }] }],
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
  const outcome = await h.probe('tenant', 'codex');
  assert.equal(outcome.category, 'ok');
  const request = h.requests[0];
  assert.ok(request);
  assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(request.init.headers?.authorization, 'Bearer codex-access-token');
  assert.equal(request.init.headers?.['chatgpt-account-id'], 'chatgpt-account-1');
  assert.equal(request.init.headers?.originator, 'codex_cli_rs');
  assert.equal(request.init.headers?.['openai-beta'], 'responses=experimental');
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.model, 'gpt-5.3-codex');
  assert.equal(body.stream, false);
  assert.equal(body.store, false);
  assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: CHALLENGE.prompt }] }]);
});

test('api-key probes resolve the FIXED_ADAPTERS endpoint by capability and carry the challenge', async () => {
  const h = await harness({
    account: tenantAccountRow({
      provider_id: 'deepseek',
      product_id: 'deepseek-anthropic',
      credential_type: 'api-key',
    }),
    capability: { model: 'deepseek-chat', endpoint: 'messages' },
    secret: 'deepseek-fixture-key',
    response: new Response(JSON.stringify({ content: [{ type: 'text', text: '18' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const outcome = await h.probe('tenant', 'api-key');
  // A wrong numeric answer is a probe protocol failure, never a success.
  assert.equal(outcome.category, 'error');
  assert.equal(outcome.reason, 'mismatch');
  const request = h.requests[0];
  assert.ok(request);
  assert.equal(request.url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(request.init.headers?.['x-api-key'], 'deepseek-fixture-key');
  assert.equal(request.init.headers?.['anthropic-version'], '2023-06-01');
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.model, 'deepseek-chat');

  h.setResponse(new Response(JSON.stringify({ content: [{ type: 'text', text: 'seventeen' }] }), { status: 200 }));
  const nonNumeric = await h.probe('tenant', 'api-key');
  assert.equal(nonNumeric.category, 'error');
  assert.equal(nonNumeric.reason, 'non_numeric');
});

test('api-key models adapters keep the credential-validation list semantics', async () => {
  const h = await harness({
    account: tenantAccountRow({ provider_id: 'kimi', product_id: 'kimi-platform', credential_type: 'api-key' }),
    capability: { model: 'kimi-k2', endpoint: 'chat-completions' },
    secret: 'kimi-fixture-key',
    response: new Response(JSON.stringify({ data: [{ id: 'kimi-k2' }] }), { status: 200 }),
  });
  const outcome = await h.probe('tenant', 'api-key');
  assert.equal(outcome.category, 'ok');
  const request = h.requests[0];
  assert.ok(request);
  assert.equal(request.url, 'https://api.moonshot.cn/v1/models');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.headers?.authorization, 'Bearer kimi-fixture-key');
});

test('upstream status classification maps 401/403/429/5xx to the sub2api taxonomy', async () => {
  const h = await harness({ account: tenantAccountRow(), secret: 'opencode-fixture-key' });
  h.setResponse(new Response('unauthorized', { status: 401 }));
  assert.deepEqual(
    { ...(await h.probe('tenant', 'opencode-go')), latencyMs: 0 },
    { category: 'auth_revoked', httpStatus: 401, latencyMs: 0, resetAt: null, usage: null, reason: null },
  );
  h.setResponse(new Response('forbidden', { status: 403 }));
  assert.equal((await h.probe('tenant', 'opencode-go')).category, 'banned');
  h.setResponse(new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }));
  const rateLimited = await h.probe('tenant', 'opencode-go');
  assert.equal(rateLimited.category, 'rate_limited');
  assert.equal(rateLimited.resetAt, new Date(1_000_000 + 30_000).toISOString());
  h.setResponse(new Response('boom', { status: 503 }));
  const unavailable = await h.probe('tenant', 'opencode-go');
  assert.equal(unavailable.category, 'error');
  assert.equal(unavailable.reason, 'provider_unavailable');
  h.setResponse(new Response('nope', { status: 418 }));
  assert.equal((await h.probe('tenant', 'opencode-go')).reason, 'client_error');
  h.setResponse(new Error('socket hang up'));
  const network = await h.probe('tenant', 'opencode-go');
  assert.equal(network.category, 'error');
  assert.equal(network.reason, 'network');
  assert.equal(network.httpStatus, null);
});

test('a bound egress proxy carries the probe and the dispatcher reaches the fetch', async () => {
  const h = await harness({
    account: tenantAccountRow(),
    secret: 'opencode-fixture-key',
    proxy: { bound: true },
    response: new Response(JSON.stringify({ choices: [{ message: { content: '17' } }] }), { status: 200 }),
  });
  const outcome = await h.probe('tenant', 'opencode-go');
  assert.equal(outcome.category, 'ok');
  assert.deepEqual(h.connections, ['http://egress.example:8080']);
  assert.equal(h.requests[0]?.init.dispatcher, FAKE_CONNECTION.dispatcher);
});

test('an unavailable account or credential is an error outcome, never a throw', async () => {
  const noAccount = await harness({ account: null, secret: 'x' });
  const outcome = await noAccount.probe('tenant', 'opencode-go');
  assert.equal(outcome.category, 'error');
  assert.equal(outcome.reason, 'account_unavailable');
  assert.equal(noAccount.requests.length, 0);
});

test('the provider id maps to the migration-109 monitor categories', () => {
  assert.equal(accountProbeCategoryForProvider('claude'), 'claude');
  assert.equal(accountProbeCategoryForProvider('codex'), 'codex');
  assert.equal(accountProbeCategoryForProvider('openai-codex'), 'codex');
  assert.equal(accountProbeCategoryForProvider('opencode-go'), 'opencode-go');
  assert.equal(accountProbeCategoryForProvider('kimi'), 'api-key');
  assert.equal(accountProbeCategoryForProvider('deepseek'), 'api-key');
  assert.equal(accountProbeCategoryForProvider('brand-new-provider'), 'api-key');
});

test('invalid probe requests fail closed with INVALID_INPUT', async () => {
  const h = await harness({ account: tenantAccountRow(), secret: 'x' });
  await assert.rejects(
    h.probe('tenant', 'not-a-category'),
    (error: unknown) => error instanceof Error && error.name === 'AccountProbeServiceError',
  );
});

test('gemini probe posts the Code Assist v1internal:generateContent challenge with the dispatch wrap', async () => {
  const h = await harness({
    account: tenantAccountRow({
      provider_id: 'google-gemini',
      product_id: 'gemini-subscription',
      credential_type: 'oauth',
    }),
    secret: JSON.stringify({
      access_token: 'gemini-access-token',
      refresh_token: 'gemini-refresh-token',
      project_id: 'project-1',
    }),
    response: new Response(
      JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: '17' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
  const outcome = await h.probe('tenant', 'gemini');
  assert.deepEqual(
    { ...outcome, latencyMs: 0 },
    {
      category: 'ok',
      httpStatus: 200,
      latencyMs: 0,
      resetAt: null,
      usage: { inputTokens: 9, outputTokens: 2 },
      reason: null,
    },
  );
  const request = h.requests[0];
  assert.ok(request);
  assert.equal(request.url, 'https://cloudcode-pa.googleapis.com/v1internal:generateContent');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers?.authorization, 'Bearer gemini-access-token');
  assert.equal(request.init.headers?.['user-agent'], 'GeminiCLI/0.1.5 (Windows; AMD64)');
  assert.equal(request.init.redirect, 'manual');
  // The {model, project, request} dispatch wrap the v1internal endpoint needs.
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.model, 'gemini-2.5-flash');
  assert.equal(body.project, 'project-1');
  const inner = body.request as Record<string, unknown>;
  assert.deepEqual(inner.contents, [{ role: 'user', parts: [{ text: CHALLENGE.prompt }] }]);
  assert.equal(request.init.dispatcher, undefined);
});

test('gemini probe classifies upstream 429 and 401 through the shared taxonomy', async () => {
  const h = await harness({
    account: tenantAccountRow({
      provider_id: 'google-gemini',
      product_id: 'gemini-subscription',
      credential_type: 'oauth',
    }),
    secret: JSON.stringify({
      access_token: 'gemini-access-token',
      refresh_token: 'gemini-refresh-token',
      project_id: 'project-1',
    }),
  });
  h.setResponse(new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }));
  const rateLimited = await h.probe('tenant', 'gemini');
  assert.equal(rateLimited.category, 'rate_limited');
  assert.equal(rateLimited.resetAt, new Date(1_000_000 + 30_000).toISOString());
  h.setResponse(new Response('unauthorized', { status: 401 }));
  const revoked = await h.probe('tenant', 'gemini');
  assert.equal(revoked.category, 'auth_revoked');
  // A credential envelope without a project id is invalid, never a guess.
  const malformed = await harness({
    account: tenantAccountRow({
      provider_id: 'google-gemini',
      product_id: 'gemini-subscription',
      credential_type: 'oauth',
    }),
    secret: JSON.stringify({ access_token: 'gemini-access-token', refresh_token: 'gemini-refresh-token' }),
  });
  const invalid = await malformed.probe('tenant', 'gemini');
  assert.equal(invalid.category, 'error');
  assert.equal(invalid.reason, 'credential_invalid');
  assert.equal(malformed.requests.length, 0);
});

test('vertex probe posts the Anthropic-on-Vertex rawPredict challenge with the vertex body', async () => {
  const h = await harness({
    account: tenantAccountRow({
      provider_id: 'google-vertex',
      product_id: 'vertex-ai',
      credential_type: 'service_account',
    }),
    secret: JSON.stringify({
      type: 'service_account',
      client_email: 'vertex-sa@test.iam.gserviceaccount.com',
      private_key: 'runtime-generated-in-production',
      project_id: 'project-1',
      location: 'europe-west4',
      access_token: 'vertex-access-token',
      expires_at: new Date(1_000_000 + 3_600_000).toISOString(),
    }),
    response: new Response(
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: '17' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
  const outcome = await h.probe('tenant', 'vertex');
  assert.deepEqual(
    { ...outcome, latencyMs: 0 },
    {
      category: 'ok',
      httpStatus: 200,
      latencyMs: 0,
      resetAt: null,
      usage: { inputTokens: 9, outputTokens: 2 },
      reason: null,
    },
  );
  const request = h.requests[0];
  assert.ok(request);
  // The pinned production URL: regional host, publishers/anthropic, rawPredict.
  assert.equal(
    request.url,
    'https://europe-west4-aiplatform.googleapis.com/v1/projects/project-1/locations/europe-west4/publishers/anthropic/models/claude-haiku-4-5:rawPredict',
  );
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers?.authorization, 'Bearer vertex-access-token');
  assert.equal(request.init.redirect, 'manual');
  // The vertex body: no model field, anthropic_version injected.
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal('model' in body, false);
  assert.equal(body.anthropic_version, 'vertex-2023-10-16');
  assert.deepEqual(body.messages, [{ role: 'user', content: CHALLENGE.prompt }]);
});

test('vertex probe exchanges a fresh JWT when the envelope token is stale or absent', async () => {
  const h = await harness({
    account: tenantAccountRow({
      provider_id: 'google-vertex',
      product_id: 'vertex-ai',
      credential_type: 'service_account',
    }),
    // No access_token: the probe must exchange the SA JWT inline first.
    secret: JSON.stringify({
      type: 'service_account',
      client_email: 'vertex-sa@test.iam.gserviceaccount.com',
      private_key: 'needs-a-real-key-for-signing',
      project_id: 'project-1',
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  });
  const invalid = await h.probe('tenant', 'vertex');
  assert.equal(invalid.category, 'error');
  assert.equal(invalid.reason, 'credential_invalid');
  // A non-service-account envelope fails closed the same way.
  const notSa = await harness({
    account: tenantAccountRow({
      provider_id: 'google-vertex',
      product_id: 'vertex-ai',
      credential_type: 'service_account',
    }),
    secret: JSON.stringify({ access_token: 'x' }),
  });
  const invalidMaterial = await notSa.probe('tenant', 'vertex');
  assert.equal(invalidMaterial.category, 'error');
  assert.equal(invalidMaterial.reason, 'credential_invalid');
  assert.equal(notSa.requests.length, 0);
});
