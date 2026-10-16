import {
  createProviderCredentialContext,
  PROVIDER_CREDENTIAL_CONTEXT_VERSION,
  PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
  PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
  type ProviderCredentialContext,
  type ProviderCredentialEnvelope,
  type ProviderCredentialUnsealingKms,
  withUnsealedProviderCredential,
} from '../credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import { CLAUDE_MESSAGES_ENDPOINT } from '../gateway/claude/catalog-identity.js';
import {
  CLAUDE_ANTHROPIC_VERSION,
  CLAUDE_CLIENT_IDENTITY_HEADERS,
  CLAUDE_CODE_MIMICRY_BETA_HEADER,
  CLAUDE_STAINLESS_HEADERS,
} from '../gateway/claude/constants.js';
import { buildClaudeUserAgent, resolveClaudeCliVersionFromEnv } from '../gateway/claude/identity.js';
import { applyClaudeOAuthTransform } from '../gateway/claude/transform.js';
import { claudeMetadataUserId } from '../gateway/claude/transport.js';
import { buildCanonicalIdentity } from '../gateway/codex/identity.js';
import { CODEX_FALLBACK_INSTRUCTIONS } from '../gateway/codex/instructions.js';
import { CODEX_RESPONSES_ENDPOINT } from '../gateway/codex/transport.js';
import { GEMINI_CLI_BASE_URL } from '../gateway/gemini/catalog-identity.js';
import { GEMINI_CLI_USER_AGENT } from '../gateway/gemini/constants.js';
import { normalizeGeminiTierId } from '../gateway/gemini/identity.js';
import { applyGeminiCodeAssistTransform } from '../gateway/gemini/transform.js';
import { OPENCODE_GO_CHAT_COMPLETIONS_URL } from '../gateway/opencode-go/catalog-identity.js';
import { OPENCODE_GO_TEST_MODEL } from '../gateway/opencode-go/model-catalog.js';
import { createProviderEgressProxyConnection } from '../gateway/provider-http-address.js';
import { resolveFixedCredentialProbeEndpoint } from './credential-validation-adapters.js';
import { type EgressProxyOwnerKind, type EgressProxyRecord, readEgressProxyForAccount } from './egress-proxy-lookup.js';
import { assembleEgressProxyUrl } from './egress-proxy-record.js';
import { withUnsealedEgressProxyCredentials } from './egress-proxy-seal.js';
import { parseRetryAfterMs } from './opencode-go-usage-worker.js';

/**
 * R6a active probing (docs/token-resale-implementation-plan-2026-10-15.md
 * §R6a, task #32; migration 109): the per-provider account probe service
 * behind both the scheduled probe-monitor worker and the admin manual
 * trigger.
 *
 * Probe categories (sub2api parity, adapted to this repo's builders):
 * - claude: a full-mimicry minimal /v1/messages request — the beta set,
 *   CLI user-agent, stainless/client-identity headers and the OAuth body
 *   transform are reused READ-ONLY from src/saas/gateway/claude/** so the
 *   probe is indistinguishable from a real dispatch at the protocol layer.
 * - codex: a small non-streaming /responses request with the canonical
 *   codex_cli_rs identity headers (gateway/codex/** read-only imports).
 * - opencode-go: the Chat Completions probe with the pinned test model
 *   glm-5.3 (the R5b-4 credential-validation FIXED_ADAPTERS precedent).
 * - gemini: the Code Assist v1internal:generateContent probe with the pinned
 *   GeminiCLI user agent and the `{model, project, request}` dispatch wrap —
 *   gateway/gemini/** is reused READ-ONLY exactly like the claude probe.
 * - api-key: the existing credential-validation fixed-adapter endpoints
 *   (kimi/deepseek and friends); chat/messages probes carry the arithmetic
 *   few-shot challenge, models probes keep their list semantics.
 *
 * The challenge is the sub2api contract: the response must be digits only
 * and exactly equal the configured answer. A wrong or non-numeric answer is
 * a probe protocol failure, never a success.
 *
 * Every probe goes through the account's egress proxy when one is bound
 * (R3's createProviderEgressProxyConnection) — the provider must see the
 * same exit IP as real traffic. Proxy credentials are unsealed only inside
 * the KMS callback and the assembled URL never outlives the call site.
 *
 * Result taxonomy (plan §6a): {ok, rate_limited(resetAt), auth_revoked,
 * banned, error} with 401→auth_revoked, 403→banned and 429→rate_limited +
 * Retry-After deadline — the sub2api SetError/SetRateLimited classification.
 *
 * Billing isolation (plan §6a-3): probe usage is metered into the returned
 * outcome's `usage` field ONLY. There is no internal metering namespace in
 * this repo's billing path (surveyed: saas_usage_events has no namespace
 * column), so the R5b-3 cost-isolation precedent applies verbatim — probe
 * traffic never enters the metering/billing path and never touches the user
 * ledger; the observed token counts ride the probe run's detail payload for
 * operator cost attribution. sub2api/new-api keep probe usage out of the
 * channel success-rate denominator for the same reason.
 *
 * Red lines: no secrets in results, logs, or thrown errors; the credential
 * plaintext exists only inside the unseal callback; gateway/claude/** and
 * gateway/codex/** are imported read-only and never modified.
 */

export type AccountProbeCategory = 'claude' | 'codex' | 'opencode-go' | 'api-key' | 'gemini';
export type AccountProbeResultCategory = 'ok' | 'rate_limited' | 'auth_revoked' | 'banned' | 'error';

export interface AccountProbeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AccountProbeOutcome {
  readonly category: AccountProbeResultCategory;
  readonly httpStatus: number | null;
  readonly latencyMs: number;
  /** ISO deadline for rate_limited results; null otherwise. */
  readonly resetAt: string | null;
  /** Probe-internal metering only — never enters the billing path. */
  readonly usage: AccountProbeUsage | null;
  /** Stable machine reason for error results; null otherwise. */
  readonly reason: string | null;
}

export interface AccountProbeRequest {
  readonly ownerKind: EgressProxyOwnerKind;
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly category: AccountProbeCategory;
  readonly challengePrompt: string;
  readonly challengeAnswer: string;
}

export type AccountProbeFetchInit = RequestInit & { readonly dispatcher?: unknown };

export type AccountProbeConnectionFactory = typeof createProviderEgressProxyConnection;

export interface AccountProbeServiceOptions {
  readonly deployment: string;
  readonly environment: string;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly claudeProbeModel?: string;
  readonly codexProbeModel?: string;
  readonly geminiProbeModel?: string;
  readonly fetch?: (url: string, init: AccountProbeFetchInit) => Promise<Response>;
  readonly createConnection?: AccountProbeConnectionFactory;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface AccountProbeService {
  probe(request: AccountProbeRequest): Promise<AccountProbeOutcome>;
}

export class AccountProbeServiceError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'PROBE_FAILED') {
    super(code === 'INVALID_INPUT' ? 'invalid account probe request' : 'the account probe could not be executed');
    this.name = 'AccountProbeServiceError';
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_CLAUDE_PROBE_MODEL = 'claude-haiku-4-5';
const DEFAULT_CODEX_PROBE_MODEL = 'gpt-5.3-codex';
const DEFAULT_GEMINI_PROBE_MODEL = 'gemini-2.5-flash';
const PROBE_PROXY_KEY_ID = 'probe';

const ACCOUNT_TABLES = Object.freeze({
  tenant: 'saas_tenant_provider_accounts',
  platform: 'saas_platform_provider_accounts',
} as const);

const CAPABILITY_TABLES = Object.freeze({
  tenant: 'saas_tenant_provider_account_capabilities',
  platform: 'saas_platform_provider_account_capabilities',
} as const);

const CREDENTIAL_TABLES = Object.freeze({
  tenant: 'saas_tenant_provider_credentials',
  platform: 'saas_platform_provider_credentials',
} as const);

const VERSION_TABLES = Object.freeze({
  tenant: 'saas_tenant_provider_credential_versions',
  platform: 'saas_platform_provider_credential_versions',
} as const);

const WRAPPING_TABLES = Object.freeze({
  tenant: 'saas_tenant_provider_credential_wrappings',
  platform: 'saas_platform_provider_credential_wrappings',
} as const);

interface AccountBindingRow {
  readonly id: unknown;
  readonly tenant_id: unknown;
  readonly provider_id: unknown;
  readonly product_id: unknown;
  readonly credential_type: unknown;
  readonly purpose: unknown;
}

interface CapabilityRow {
  readonly model: unknown;
  readonly endpoint: unknown;
}

interface CurrentCredentialRow {
  readonly id: unknown;
  readonly current_version: unknown;
}

interface LockedVersionRow {
  readonly version: unknown;
  readonly schema_version: unknown;
  readonly context_version: unknown;
  readonly algorithm: unknown;
  readonly kms_purpose: unknown;
  readonly kms_key_id: unknown;
  readonly wrapped_dek: unknown;
  readonly nonce: unknown;
  readonly ciphertext: unknown;
  readonly auth_tag: unknown;
}

interface AccountBinding {
  readonly ownerKind: EgressProxyOwnerKind;
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly purpose: string;
  readonly capabilityModel: string | null;
  readonly capabilityEndpoint: string | null;
}

function probeError(
  reason: string,
  latencyMs = 0,
  httpStatus: number | null = null,
  usage: AccountProbeUsage | null = null,
): AccountProbeOutcome {
  return { category: 'error', httpStatus, latencyMs, resetAt: null, usage, reason };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps a provider id to the probe category the monitor stores (migration 109). */
export function accountProbeCategoryForProvider(providerId: string): AccountProbeCategory | null {
  switch (providerId) {
    case 'claude':
      return 'claude';
    case 'codex':
    case 'openai-codex':
      return 'codex';
    case 'opencode-go':
      return 'opencode-go';
    case 'google-gemini':
      return 'gemini';
    default:
      return 'api-key';
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const textBody = await response.text();
    return Buffer.byteLength(textBody) > maxBytes ? null : textBody;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function usageTokens(body: unknown): AccountProbeUsage | null {
  if (!isRecord(body)) return null;
  const usage = body.usage;
  if (isRecord(usage)) {
    const anthropicInput = nonNegativeInteger(usage.input_tokens);
    const anthropicOutput = nonNegativeInteger(usage.output_tokens);
    if (anthropicInput >= 0 || anthropicOutput >= 0) {
      return {
        inputTokens: Math.max(0, anthropicInput),
        outputTokens: Math.max(0, anthropicOutput),
      };
    }
    const openaiInput = nonNegativeInteger(usage.prompt_tokens);
    const openaiOutput = nonNegativeInteger(usage.completion_tokens);
    if (openaiInput >= 0 || openaiOutput >= 0) {
      return { inputTokens: Math.max(0, openaiInput), outputTokens: Math.max(0, openaiOutput) };
    }
  }
  // Gemini native (usageMetadata; unwrapped when the Code Assist envelope carries it).
  const geminiInner = isRecord(body.response) ? (body.response as Record<string, unknown>) : body;
  const metadata = geminiInner.usageMetadata;
  if (isRecord(metadata)) {
    const geminiPrompt = nonNegativeInteger(metadata.promptTokenCount);
    const geminiOutput = nonNegativeInteger(metadata.candidatesTokenCount);
    if (geminiPrompt >= 0 || geminiOutput >= 0) {
      return { inputTokens: Math.max(0, geminiPrompt), outputTokens: Math.max(0, geminiOutput) };
    }
  }
  return null;
}

/** sub2api challenge semantics: digits only, exact compare. */
function challengeMatches(answer: string, extracted: string | null): 'ok' | 'non_numeric' | 'mismatch' | 'missing' {
  if (extracted === null || extracted.trim() === '') return 'missing';
  const trimmed = extracted.trim();
  if (!/^[0-9]+$/.test(trimmed)) return 'non_numeric';
  return trimmed === answer ? 'ok' : 'mismatch';
}

function firstAnthropicText(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.content)) return null;
  for (const block of body.content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return null;
}

function firstChatText(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) return null;
  const message = body.choices[0].message;
  if (!isRecord(message) || typeof message.content !== 'string') return null;
  return message.content;
}

function firstResponsesText(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.output)) return null;
  for (const item of body.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (isRecord(block) && block.type === 'output_text' && typeof block.text === 'string') {
        return block.text;
      }
    }
  }
  return null;
}

/** Gemini native text: candidates[0].content.parts[].text (unwrapped when wrapped). */
function firstGeminiText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const inner = isRecord(body.response) ? (body.response as Record<string, unknown>) : body;
  if (!isRecord(inner) || !Array.isArray(inner.candidates) || !isRecord(inner.candidates[0])) return null;
  const content = (inner.candidates[0] as Record<string, unknown>).content;
  if (!isRecord(content) || !Array.isArray(content.parts)) return null;
  for (const part of content.parts) {
    if (isRecord(part) && typeof part.text === 'string' && part.text.trim() !== '') return part.text;
  }
  return null;
}

function modelsListLooksValid(body: unknown): boolean {
  return isRecord(body) && Array.isArray(body.data);
}

export function createAccountProbeService(
  database: SaasDatabase,
  kms: ProviderCredentialUnsealingKms,
  options: AccountProbeServiceOptions,
): AccountProbeService {
  if (!database || typeof database.query !== 'function') throw new AccountProbeServiceError('INVALID_INPUT');
  if (!kms || typeof kms.decryptDataKey !== 'function') throw new AccountProbeServiceError('INVALID_INPUT');
  if (!options || typeof options !== 'object') throw new AccountProbeServiceError('INVALID_INPUT');
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const claudeProbeModel = options.claudeProbeModel ?? DEFAULT_CLAUDE_PROBE_MODEL;
  const codexProbeModel = options.codexProbeModel ?? DEFAULT_CODEX_PROBE_MODEL;
  const geminiProbeModel = options.geminiProbeModel ?? DEFAULT_GEMINI_PROBE_MODEL;
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const connectionFactory = options.createConnection ?? createProviderEgressProxyConnection;
  const now = options.now ?? Date.now;

  const executor = (): SqlExecutor => database;

  async function readAccountBinding(request: AccountProbeRequest): Promise<AccountBinding | null> {
    const scope = ACCOUNT_TABLES[request.ownerKind];
    const capabilities = CAPABILITY_TABLES[request.ownerKind];
    const tenantPredicate = request.ownerKind === 'tenant' ? 'account.tenant_id = $2 AND ' : '';
    const accountValues = request.ownerKind === 'tenant' ? [request.tenantId, request.accountId] : [request.accountId];
    const accounts = await database.query<AccountBindingRow>(
      `SELECT account.id${request.ownerKind === 'tenant' ? ', account.tenant_id' : ''},
              account.provider_id, account.product_id, account.credential_type, account.purpose
         FROM ${scope} AS account
        WHERE ${tenantPredicate}account.id = $${request.ownerKind === 'tenant' ? 3 : 2}
          AND account.status = 'active' AND account.validation_state = 'verified'
        LIMIT 1`,
      accountValues,
    );
    const account = accounts.rows[0];
    if (account === undefined) return null;
    const capabilityRows = await database.query<CapabilityRow>(
      request.ownerKind === 'tenant'
        ? `SELECT capability.model, capability.endpoint
             FROM ${capabilities} AS capability
            WHERE capability.tenant_id = $1 AND capability.account_id = $2
              AND capability.provider_id = $3 AND capability.product_id = $4
            ORDER BY capability.capability_version DESC
            LIMIT 1`
        : `SELECT capability.model, capability.endpoint
             FROM ${capabilities} AS capability
            WHERE capability.account_id = $1
              AND capability.provider_id = $2 AND capability.product_id = $3
            ORDER BY capability.capability_version DESC
            LIMIT 1`,
      request.ownerKind === 'tenant'
        ? [request.tenantId, request.accountId, text(account.provider_id), text(account.product_id)]
        : [request.accountId, text(account.provider_id), text(account.product_id)],
    );
    const capability = capabilityRows.rows[0];
    const providerId = text(account.provider_id);
    const productId = text(account.product_id);
    const accountId = text(account.id);
    if (providerId === null || productId === null || accountId === null) return null;
    return {
      ownerKind: request.ownerKind,
      tenantId: request.ownerKind === 'tenant' ? text(account.tenant_id) : null,
      accountId,
      providerId,
      productId,
      credentialType: text(account.credential_type) ?? '',
      purpose: text(account.purpose) ?? '',
      capabilityModel: text(capability?.model),
      capabilityEndpoint: text(capability?.endpoint),
    };
  }

  /**
   * Resolves the account's current verified credential envelope and invokes
   * the callback with the unsealed secret (quota-sync/opencode-usage worker
   * pattern: binding re-read, version row + latest wrapping join, KMS
   * decrypt-only unseal). Resolves null when no usable credential exists.
   */
  async function withUnsealedAccountCredential<T>(
    binding: AccountBinding,
    callback: (secret: Buffer) => Promise<T>,
  ): Promise<T | null> {
    const credentials = CREDENTIAL_TABLES[binding.ownerKind];
    const versions = VERSION_TABLES[binding.ownerKind];
    const wrappings = WRAPPING_TABLES[binding.ownerKind];
    const tenantOnly = binding.ownerKind === 'tenant';
    const credentialRows = await database.query<CurrentCredentialRow>(
      tenantOnly
        ? `SELECT credential.id, credential.current_version
             FROM ${credentials} AS credential
            WHERE credential.tenant_id = $1 AND credential.account_id = $2
              AND credential.provider_id = $3 AND credential.product_id = $4
              AND credential.credential_type = $5
              AND credential.status = 'active' AND credential.validation_state = 'verified'
              AND credential.current_version IS NOT NULL
              AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
            ORDER BY credential.id
            LIMIT 1`
        : `SELECT credential.id, credential.current_version
             FROM ${credentials} AS credential
            WHERE credential.account_id = $1
              AND credential.provider_id = $2 AND credential.product_id = $3
              AND credential.credential_type = $4
              AND credential.status = 'active' AND credential.validation_state = 'verified'
              AND credential.current_version IS NOT NULL
              AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
            ORDER BY credential.id
            LIMIT 1`,
      tenantOnly
        ? [binding.tenantId, binding.accountId, binding.providerId, binding.productId, binding.credentialType]
        : [binding.accountId, binding.providerId, binding.productId, binding.credentialType],
    );
    const credential = credentialRows.rows[0];
    if (credential === undefined) return null;
    const credentialId = text(credential.id);
    const credentialVersion = nonNegativeInteger(credential.current_version);
    if (credentialId === null || credentialVersion < 1) return null;

    const versionRows = await database.query<LockedVersionRow>(
      tenantOnly
        ? `SELECT version_row.version, version_row.schema_version, version_row.context_version,
                  version_row.algorithm, version_row.kms_purpose,
                  COALESCE(wrapping.kms_key_id, version_row.kms_key_id) AS kms_key_id,
                  COALESCE(wrapping.wrapped_dek, version_row.wrapped_dek) AS wrapped_dek,
                  version_row.nonce, version_row.ciphertext, version_row.auth_tag
             FROM ${versions} AS version_row
             LEFT JOIN LATERAL (
               SELECT kms_key_id, wrapped_dek
                 FROM ${wrappings}
                WHERE tenant_id = version_row.tenant_id AND account_id = version_row.account_id
                  AND credential_id = version_row.credential_id
                  AND credential_version = version_row.version
                ORDER BY wrapping_revision DESC
                LIMIT 1
             ) AS wrapping ON TRUE
            WHERE version_row.tenant_id = $1 AND version_row.account_id = $2
              AND version_row.credential_id = $3 AND version_row.version = $4
              AND version_row.status = 'active'
              AND (version_row.expires_at IS NULL OR version_row.expires_at > clock_timestamp())`
        : `SELECT version_row.version, version_row.schema_version, version_row.context_version,
                  version_row.algorithm, version_row.kms_purpose,
                  COALESCE(wrapping.kms_key_id, version_row.kms_key_id) AS kms_key_id,
                  COALESCE(wrapping.wrapped_dek, version_row.wrapped_dek) AS wrapped_dek,
                  version_row.nonce, version_row.ciphertext, version_row.auth_tag
             FROM ${versions} AS version_row
             LEFT JOIN LATERAL (
               SELECT kms_key_id, wrapped_dek
                 FROM ${wrappings}
                WHERE account_id = version_row.account_id
                  AND credential_id = version_row.credential_id
                  AND credential_version = version_row.version
                ORDER BY wrapping_revision DESC
                LIMIT 1
             ) AS wrapping ON TRUE
            WHERE version_row.account_id = $1
              AND version_row.credential_id = $2 AND version_row.version = $3
              AND version_row.status = 'active'
              AND (version_row.expires_at IS NULL OR version_row.expires_at > clock_timestamp())`,
      tenantOnly
        ? [binding.tenantId, binding.accountId, credentialId, credentialVersion]
        : [binding.accountId, credentialId, credentialVersion],
    );
    const version = versionRows.rows[0];
    if (version === undefined || version.kms_purpose !== binding.purpose) return null;
    if (
      nonNegativeInteger(version.schema_version) !== PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION ||
      nonNegativeInteger(version.context_version) !== PROVIDER_CREDENTIAL_CONTEXT_VERSION ||
      version.algorithm !== PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM
    ) {
      return null;
    }

    const context: ProviderCredentialContext = createProviderCredentialContext(
      binding.ownerKind === 'platform'
        ? {
            ownerKind: 'platform',
            supplyMode: 'platform',
            deployment: options.deployment,
            environment: options.environment,
            purpose: binding.purpose,
            providerId: binding.providerId,
            productId: binding.productId,
            credentialType: binding.credentialType,
            accountId: binding.accountId,
            credentialId,
            credentialVersion,
          }
        : {
            ownerKind: 'tenant',
            tenantId: binding.tenantId as string,
            supplyMode: 'byok',
            deployment: options.deployment,
            environment: options.environment,
            purpose: binding.purpose,
            providerId: binding.providerId,
            productId: binding.productId,
            credentialType: binding.credentialType,
            accountId: binding.accountId,
            credentialId,
            credentialVersion,
          },
    );
    const envelope: ProviderCredentialEnvelope = {
      schemaVersion: PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
      contextVersion: PROVIDER_CREDENTIAL_CONTEXT_VERSION,
      algorithm: PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
      kmsKeyId: text(version.kms_key_id) ?? '',
      wrappedDek: text(version.wrapped_dek) ?? '',
      nonce: text(version.nonce) ?? '',
      ciphertext: text(version.ciphertext) ?? '',
      authTag: text(version.auth_tag) ?? '',
    };

    let result: T | undefined;
    let invoked = false;
    try {
      await withUnsealedProviderCredential(envelope, context, kms, async (secret) => {
        invoked = true;
        result = await callback(secret);
      });
    } catch (error) {
      if (!invoked) return null;
      throw error;
    }
    return invoked ? (result as T) : null;
  }

  interface BuiltProbeRequest {
    readonly url: string;
    readonly method: 'GET' | 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | null;
    readonly responseKind: 'claude' | 'responses' | 'chat' | 'messages' | 'models' | 'gemini';
  }

  function buildClaudeProbe(
    request: AccountProbeRequest,
    accessToken: string,
    accountUuid: string | null,
  ): BuiltProbeRequest {
    const cliVersion = resolveClaudeCliVersionFromEnv();
    const body = applyClaudeOAuthTransform(
      {
        model: claudeProbeModel,
        max_tokens: 16,
        stream: false,
        messages: [{ role: 'user', content: request.challengePrompt }],
      },
      {
        cliVersion,
        metadataUserId: accountUuid === null ? null : claudeMetadataUserId(PROBE_PROXY_KEY_ID, accountUuid),
      },
    );
    return {
      url: `${CLAUDE_MESSAGES_ENDPOINT}?beta=true`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-version': CLAUDE_ANTHROPIC_VERSION,
        'anthropic-beta': CLAUDE_CODE_MIMICRY_BETA_HEADER,
        'user-agent': buildClaudeUserAgent(cliVersion),
        accept: 'application/json',
        'content-type': 'application/json',
        ...CLAUDE_STAINLESS_HEADERS,
        ...CLAUDE_CLIENT_IDENTITY_HEADERS,
      },
      body: JSON.stringify(body),
      responseKind: 'claude',
    };
  }

  function buildCodexProbe(
    request: AccountProbeRequest,
    accessToken: string,
    chatgptAccountId: string | null,
  ): BuiltProbeRequest {
    const identity = buildCanonicalIdentity();
    return {
      url: CODEX_RESPONSES_ENDPOINT,
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(chatgptAccountId === null ? {} : { 'chatgpt-account-id': chatgptAccountId }),
        'user-agent': identity.userAgent,
        originator: identity.originator,
        version: identity.version,
        'openai-beta': 'responses=experimental',
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: codexProbeModel,
        instructions: CODEX_FALLBACK_INSTRUCTIONS,
        input: [{ role: 'user', content: [{ type: 'input_text', text: request.challengePrompt }] }],
        max_output_tokens: 16,
        stream: false,
        store: false,
      }),
      responseKind: 'responses',
    };
  }

  function buildGeminiProbe(
    request: AccountProbeRequest,
    accessToken: string,
    projectId: string,
    _tierId: string | null,
  ): BuiltProbeRequest {
    const { body } = applyGeminiCodeAssistTransform(
      {
        model: geminiProbeModel,
        contents: [{ role: 'user', parts: [{ text: request.challengePrompt }] }],
        generationConfig: { maxOutputTokens: 512 },
      },
      { projectId },
    );
    return {
      url: `${GEMINI_CLI_BASE_URL}/v1internal:generateContent`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': GEMINI_CLI_USER_AGENT,
      },
      body: JSON.stringify(body),
      responseKind: 'gemini',
    };
  }

  function buildChatCompletionsProbe(
    request: AccountProbeRequest,
    url: string,
    model: string,
    token: string,
  ): BuiltProbeRequest {
    return {
      url,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'model-router',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        stream: false,
        messages: [{ role: 'user', content: request.challengePrompt }],
      }),
      responseKind: 'chat',
    };
  }

  function buildAnthropicMessagesProbe(
    request: AccountProbeRequest,
    url: string,
    model: string,
    token: string,
  ): BuiltProbeRequest {
    return {
      url,
      method: 'POST',
      headers: {
        'x-api-key': token,
        'anthropic-version': CLAUDE_ANTHROPIC_VERSION,
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'model-router',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        stream: false,
        messages: [{ role: 'user', content: request.challengePrompt }],
      }),
      responseKind: 'messages',
    };
  }

  function buildModelsProbe(url: string, token: string): BuiltProbeRequest {
    return {
      url,
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'user-agent': 'model-router',
      },
      body: null,
      responseKind: 'models',
    };
  }

  async function probeThrough(
    built: BuiltProbeRequest,
    request: AccountProbeRequest,
    proxy: EgressProxyRecord | null,
  ): Promise<AccountProbeOutcome> {
    const started = now();
    const deadline = AbortSignal.timeout(requestTimeoutMs);
    const signal = options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]);
    let dispatcher: unknown;
    let connection: Awaited<ReturnType<AccountProbeConnectionFactory>> | null = null;
    try {
      if (proxy !== null) {
        const proxyUrl = await withUnsealedEgressProxyCredentials(
          proxy.authSealedEnvelope,
          { deployment: options.deployment, environment: options.environment, proxyId: proxy.id },
          kms,
          (credentials) =>
            assembleEgressProxyUrl({
              protocol: proxy.protocol,
              host: proxy.host,
              port: proxy.port,
              ...(credentials.username === undefined ? {} : { username: credentials.username }),
              ...(credentials.password === undefined ? {} : { password: credentials.password }),
            }).url,
        );
        connection = await connectionFactory({ url: proxyUrl }, { signal });
        dispatcher = connection.dispatcher;
      }
      const response = await fetcher(built.url, {
        method: built.method,
        headers: { ...built.headers },
        ...(built.body === null ? {} : { body: built.body }),
        redirect: 'manual',
        signal,
        ...(dispatcher === undefined ? {} : { dispatcher }),
      });
      const latencyMs = Math.max(0, Math.round(now() - started));
      const resetAt = (() => {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), now());
        return retryAfterMs === null ? null : new Date(now() + retryAfterMs).toISOString();
      })();
      if (response.status === 401) {
        return { category: 'auth_revoked', httpStatus: 401, latencyMs, resetAt: null, usage: null, reason: null };
      }
      if (response.status === 403) {
        return { category: 'banned', httpStatus: 403, latencyMs, resetAt: null, usage: null, reason: null };
      }
      if (response.status === 429) {
        return { category: 'rate_limited', httpStatus: 429, latencyMs, resetAt, usage: null, reason: null };
      }
      if (response.status < 200 || response.status >= 300) {
        return {
          category: 'error',
          httpStatus: response.status,
          latencyMs,
          resetAt: null,
          usage: null,
          reason: response.status >= 500 ? 'provider_unavailable' : 'client_error',
        };
      }
      const bodyText = await readBoundedBody(response, maxResponseBytes);
      if (bodyText === null) {
        return {
          category: 'error',
          httpStatus: response.status,
          latencyMs,
          resetAt: null,
          usage: null,
          reason: 'response_too_large',
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        return {
          category: 'error',
          httpStatus: response.status,
          latencyMs,
          resetAt: null,
          usage: null,
          reason: 'response_invalid_json',
        };
      }
      const usage = usageTokens(parsed);
      if (built.responseKind === 'models') {
        return modelsListLooksValid(parsed)
          ? { category: 'ok', httpStatus: response.status, latencyMs, resetAt: null, usage, reason: null }
          : {
              category: 'error',
              httpStatus: response.status,
              latencyMs,
              resetAt: null,
              usage,
              reason: 'response_invalid_shape',
            };
      }
      const extracted =
        built.responseKind === 'claude' || built.responseKind === 'messages'
          ? firstAnthropicText(parsed)
          : built.responseKind === 'chat'
            ? firstChatText(parsed)
            : built.responseKind === 'gemini'
              ? firstGeminiText(parsed)
              : firstResponsesText(parsed);
      const match = challengeMatches(request.challengeAnswer, extracted);
      if (match === 'ok') {
        return { category: 'ok', httpStatus: response.status, latencyMs, resetAt: null, usage, reason: null };
      }
      return {
        category: 'error',
        httpStatus: response.status,
        latencyMs,
        resetAt: null,
        usage,
        reason: match === 'missing' ? 'challenge_missing' : match,
      };
    } catch (error) {
      const latencyMs = Math.max(0, Math.round(now() - started));
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network';
      return { category: 'error', httpStatus: null, latencyMs, resetAt: null, usage: null, reason };
    } finally {
      if (connection !== null) {
        const captured = connection;
        void captured.close().catch(() => undefined);
      }
    }
  }

  return {
    async probe(request: AccountProbeRequest): Promise<AccountProbeOutcome> {
      if (
        !request ||
        (request.ownerKind !== 'tenant' && request.ownerKind !== 'platform') ||
        (request.ownerKind === 'tenant' && typeof request.tenantId !== 'string') ||
        typeof request.accountId !== 'string' ||
        request.accountId === '' ||
        (request.category !== 'claude' &&
          request.category !== 'codex' &&
          request.category !== 'opencode-go' &&
          request.category !== 'api-key' &&
          request.category !== 'gemini') ||
        typeof request.challengePrompt !== 'string' ||
        typeof request.challengeAnswer !== 'string' ||
        !/^[0-9]{1,6}$/.test(request.challengeAnswer)
      ) {
        throw new AccountProbeServiceError('INVALID_INPUT');
      }
      const binding = await readAccountBinding(request);
      if (binding === null) {
        return probeError('account_unavailable');
      }
      const proxy = await readEgressProxyForAccount(executor(), {
        ownerKind: request.ownerKind,
        ...(request.ownerKind === 'tenant' ? { tenantId: request.tenantId ?? undefined } : {}),
        accountId: request.accountId,
      });

      return withUnsealedAccountCredential(binding, async (secret) => {
        let built: BuiltProbeRequest | null = null;
        if (request.category === 'gemini') {
          let material: Record<string, unknown>;
          try {
            material = JSON.parse(secret.toString('utf8')) as Record<string, unknown>;
          } catch {
            return probeError('credential_invalid');
          }
          const accessToken = typeof material.access_token === 'string' ? material.access_token : null;
          const projectId = typeof material.project_id === 'string' ? material.project_id : null;
          if (accessToken === null || accessToken === '' || projectId === null || projectId === '') {
            return probeError('credential_invalid');
          }
          built = buildGeminiProbe(
            request,
            accessToken,
            projectId,
            typeof material.tier_id === 'string' ? normalizeGeminiTierId(material.tier_id) : null,
          );
        } else if (request.category === 'claude' || request.category === 'codex') {
          let material: Record<string, unknown>;
          try {
            material = JSON.parse(secret.toString('utf8')) as Record<string, unknown>;
          } catch {
            return probeError('credential_invalid');
          }
          const accessToken = typeof material.access_token === 'string' ? material.access_token : null;
          if (accessToken === null || accessToken === '') {
            return probeError('credential_invalid');
          }
          built =
            request.category === 'claude'
              ? buildClaudeProbe(
                  request,
                  accessToken,
                  typeof material.account_uuid === 'string' ? material.account_uuid : null,
                )
              : buildCodexProbe(
                  request,
                  accessToken,
                  typeof material.chatgpt_account_id === 'string' ? material.chatgpt_account_id : null,
                );
        } else if (request.category === 'opencode-go') {
          const token = secret.toString('utf8').trim();
          if (token === '') {
            return probeError('credential_invalid');
          }
          built = buildChatCompletionsProbe(request, OPENCODE_GO_CHAT_COMPLETIONS_URL, OPENCODE_GO_TEST_MODEL, token);
        } else {
          const token = secret.toString('utf8').trim();
          if (token === '') {
            return probeError('credential_invalid');
          }
          const endpoint =
            binding.capabilityEndpoint === null
              ? null
              : resolveFixedCredentialProbeEndpoint({
                  providerId: binding.providerId,
                  productId: binding.productId,
                  credentialType: binding.credentialType,
                  capabilityEndpoint: binding.capabilityEndpoint,
                });
          if (endpoint === null) {
            return probeError('probe_endpoint_unsupported');
          }
          const model = binding.capabilityModel;
          if (endpoint.probe === 'models') {
            built = buildModelsProbe(endpoint.url, token);
          } else if (model === null) {
            return probeError('capability_model_missing');
          } else if (endpoint.probe === 'messages') {
            built = buildAnthropicMessagesProbe(request, endpoint.url, model, token);
          } else {
            built = buildChatCompletionsProbe(request, endpoint.url, model, token);
          }
        }
        return probeThrough(built, request, proxy);
      }).then((outcome) =>
        outcome === null
          ? {
              category: 'error',
              httpStatus: null,
              latencyMs: 0,
              resetAt: null,
              usage: null,
              reason: 'credential_unavailable',
            }
          : outcome,
      );
    },
  };
}
