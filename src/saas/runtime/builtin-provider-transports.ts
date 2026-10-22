import { AsyncLocalStorage } from 'node:async_hooks';
import type { ManagedSaasGatewayProductionOptions } from '../../server/managed-saas-gateway.js';
import type { SaasDatabase } from '../db/types.js';
import { BedrockPreparedEvidenceTransport, parseBedrockCredentialMaterial } from '../gateway/bedrock/transport.js';
import { ClaudePreparedEvidenceTransport } from '../gateway/claude/transport.js';
import { CnProvidersPreparedEvidenceTransport } from '../gateway/cn-providers/transport.js';
import { buildCanonicalIdentity } from '../gateway/codex/identity.js';
import { CodexPreparedEvidenceTransport } from '../gateway/codex/transport.js';
import { applyGeminiCodeAssistTransform } from '../gateway/gemini/transform.js';
import { GeminiPreparedEvidenceTransport } from '../gateway/gemini/transport.js';
import { parseGrokApiKeyMaterial, parseGrokOAuthCredentialMaterial } from '../gateway/grok/identity.js';
import { GrokPreparedEvidenceTransport } from '../gateway/grok/transport.js';
import type {
  PreparedEvidenceTransport,
  PreparedEvidenceTransportRequest,
} from '../gateway/prepared-evidence-dispatch-service.js';
import {
  createPinnedProviderHttpConnector,
  type ProviderHttpAddressResolver,
  type ProviderHttpEgressAllowlist,
  type ProviderHttpPinnedConnector,
  type ProviderHttpPinnedConnectorFactory,
  resolveEgressProxyTarget,
  resolveProviderHttpAddresses,
  selectPinnedProviderAddress,
} from '../gateway/provider-http-address.js';
import {
  type ProviderHttpCredentialResolveInput,
  type ProviderHttpDispatchProfile,
  type ProviderHttpDispatchProfileResolveInput,
  type ProviderHttpFetch,
  ProviderHttpTransport,
} from '../gateway/provider-http-transport.js';
import { VertexPreparedEvidenceTransport } from '../gateway/vertex/transport.js';
import { vertexUpstreamCredentialFromMaterial } from '../platform/vertex-sa/service-account.js';
import {
  createProviderQuotaSnapshotSinks,
  PostgresProviderQuotaSnapshotStore,
} from '../supply/provider-account-quota-snapshot-store-postgres.js';
import type { ProviderCredentialDispatchProofReader } from '../supply/types.js';
import type { GatewayProviderCredentialUnsealer } from './gateway-provider-credential-unsealer.js';
import type { ProviderBundleConfiguration } from './gateway-runtime-module.js';
import { providerBundleManifest } from './provider-bundles.js';
import { assertAuthorizedProviderCredentialDispatchProof } from './provider-supply-http-credential-resolver.js';

export interface GatewayProviderEvidenceTransportContext {
  readonly genericTransport: PreparedEvidenceTransport;
  readonly proofReader: ProviderCredentialDispatchProofReader;
  readonly unsealer: Pick<GatewayProviderCredentialUnsealer, 'withCredential'>;
  readonly resolveEgressProfile?: (
    input: ProviderHttpDispatchProfileResolveInput,
  ) => Promise<Pick<ProviderHttpDispatchProfile, 'egressProxy' | 'tlsFingerprint'>>;
  readonly createConnector?: ProviderHttpPinnedConnectorFactory;
  readonly egressAllowlist?: ProviderHttpEgressAllowlist;
  /** Core-owned resolver seam, primarily for deterministic transport policy tests. */
  readonly resolveAddresses?: ProviderHttpAddressResolver;
}

export type GatewayProviderEvidenceTransports = {
  -readonly [K in keyof Partial<
    Pick<
      ManagedSaasGatewayProductionOptions,
      | 'codexEvidenceTransport'
      | 'claudeEvidenceTransport'
      | 'geminiEvidenceTransport'
      | 'opencodeGoEvidenceTransport'
      | 'cnProvidersEvidenceTransport'
      | 'grokEvidenceTransport'
      | 'bedrockEvidenceTransport'
      | 'vertexEvidenceTransport'
      | 'responsesCompactEvidenceTransport'
    >
  >]: ManagedSaasGatewayProductionOptions[K];
};

/** Invoked by the core only after its proof reader, unsealer and generic transport exist. */
export type GatewayProviderEvidenceTransportFactory = (
  context: GatewayProviderEvidenceTransportContext,
) => GatewayProviderEvidenceTransports;

function unavailable(): never {
  throw new Error('Built-in provider credential is unavailable');
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || !/^[\x21-\x7e]+$/.test(value))
    return unavailable();
  return value;
}
function material(secret: Uint8Array): Record<string, unknown> {
  if (secret.byteLength > 128 * 1024) return unavailable();
  try {
    return record(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(secret)));
  } catch {
    return unavailable();
  }
}

/**
 * Dedicated transports use the same complete claimed-evidence proof as the
 * generic transport. No category may unseal a credential by account id alone.
 * AsyncLocalStorage binds concurrent callbacks to their own dispatch; it never
 * stores plaintext. The unsealer clears its buffer when the callback finishes.
 */
export function createBuiltinProviderEvidenceTransportFactory(options: {
  readonly database: SaasDatabase;
  readonly providerBundles: readonly ProviderBundleConfiguration[];
  readonly fetch: ProviderHttpFetch;
  readonly timeoutMs: number;
}): { readonly factory: GatewayProviderEvidenceTransportFactory; readonly assembled: boolean; close(): void } {
  const requests = new AsyncLocalStorage<
    PreparedEvidenceTransportRequest & {
      readonly proxyKeyId: string;
      readonly productId: string;
      readonly credentialType: string;
    }
  >();
  const enabled = new Set(
    options.providerBundles
      .filter((bundle) => bundle.enabled)
      .map((bundle) => providerBundleManifest(bundle.bundle)?.dispatch),
  );
  let closed = false;
  let mounted = false;
  const factory: GatewayProviderEvidenceTransportFactory = (core) => {
    if (closed || mounted) throw new Error('Built-in provider transports are already assembled or closed');
    mounted = true;
    const sinks = createProviderQuotaSnapshotSinks(
      new PostgresProviderQuotaSnapshotStore(options.database),
      async (accountId) => {
        const evidence = requests.getStore()?.evidence;
        const ownerKind = evidence?.accountOwnerKind ?? (evidence?.supplyMode === 'platform' ? 'platform' : 'tenant');
        return evidence?.accountId === accountId
          ? {
              accountId,
              ownerKind,
              tenantId: ownerKind === 'tenant' ? evidence.tenantId : null,
            }
          : null;
      },
    );
    async function withSecret<T>(
      input: { accountId: string; credentialId: string; credentialVersion: string; signal: AbortSignal },
      use: (secret: Uint8Array) => Promise<T>,
    ): Promise<T> {
      const request = requests.getStore();
      if (closed || !request || request.signal.aborted || input.signal.aborted) return unavailable();
      const evidence = request.evidence;
      if (
        evidence.accountId !== input.accountId ||
        evidence.credentialId !== input.credentialId ||
        evidence.credentialVersion !== input.credentialVersion
      )
        return unavailable();
      const resolveInput: ProviderHttpCredentialResolveInput = {
        tenantId: evidence.tenantId,
        projectId: evidence.projectId,
        requestId: evidence.requestId,
        attemptId: request.attemptId,
        evidenceId: evidence.evidenceId,
        accountId: evidence.accountId,
        upstreamId: evidence.upstreamId,
        credentialId: evidence.credentialId,
        credentialVersion: evidence.credentialVersion,
        signal: input.signal,
      };
      const proof = await core.proofReader.readDispatchProof(evidence.evidenceId);
      if (!proof || input.signal.aborted) return unavailable();
      const version = Number(input.credentialVersion);
      if (!Number.isSafeInteger(version) || version < 1 || String(version) !== input.credentialVersion)
        return unavailable();
      assertAuthorizedProviderCredentialDispatchProof(proof, resolveInput, evidence.evidenceId, version, new Date());
      let count = 0;
      let result: T | undefined;
      let callbacksOpen = true;
      let callbackFailed = false;
      try {
        await core.unsealer.withCredential(
          { account: proof.account, credential: proof.credential, version: proof.version },
          async (secret) => {
            try {
              if (!callbacksOpen || ++count !== 1 || input.signal.aborted || !(secret instanceof Uint8Array)) {
                callbackFailed = true;
                return unavailable();
              }
              result = await use(secret);
              if (!callbacksOpen || input.signal.aborted) {
                callbackFailed = true;
                return unavailable();
              }
            } catch {
              callbackFailed = true;
              return unavailable();
            } finally {
              if (secret instanceof Uint8Array) secret.fill(0);
            }
          },
        );
      } finally {
        callbacksOpen = false;
      }
      if (count !== 1 || result === undefined || callbackFailed || input.signal.aborted) return unavailable();
      return result;
    }
    function bound(transport: PreparedEvidenceTransport): PreparedEvidenceTransport {
      return {
        async send(input) {
          if (closed) throw new Error('Built-in provider transports are closed');
          const [rows, proof] = await Promise.all([
            options.database.query<{ proxy_key_id: string }>(
              "SELECT proxy_key_id FROM saas_prepared_request_evidence WHERE id=$1 AND tenant_id=$2 AND status='claimed' AND claimed_attempt_id=$3 LIMIT 2",
              [input.evidence.evidenceId, input.tenantId, input.attemptId],
            ),
            core.proofReader.readDispatchProof(input.evidence.evidenceId),
          ]);
          if (rows.rows.length !== 1 || !proof) return unavailable();
          return requests.run(
            {
              ...input,
              proxyKeyId: text(rows.rows[0]?.proxy_key_id),
              productId: proof.evidence.productId,
              credentialType: proof.account.credentialType,
            },
            () => transport.send(input),
          );
        },
      };
    }
    function body(): Record<string, unknown> {
      const request = requests.getStore();
      if (!request) return unavailable();
      return record(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(request.payloadBytes)));
    }
    function dispatchProfileInput(signal: AbortSignal): ProviderHttpDispatchProfileResolveInput {
      const request = requests.getStore();
      if (!request) return unavailable();
      const evidence = request.evidence;
      return {
        tenantId: request.tenantId,
        projectId: request.projectId,
        requestId: request.requestId,
        attemptId: request.attemptId,
        evidenceId: evidence.evidenceId,
        accountId: evidence.accountId,
        upstreamId: evidence.upstreamId,
        protocol: evidence.protocol,
        endpoint: evidence.endpoint,
        providerProtocol: evidence.providerProtocol,
        providerOperation: evidence.providerOperation,
        supplyMode: evidence.supplyMode,
        accountOwnerKind: evidence.accountOwnerKind,
        signal,
      };
    }
    function responseWithConnector(
      response: Response,
      connector: ProviderHttpPinnedConnector,
      signal: AbortSignal,
    ): Response {
      let disposed = false;
      const dispose = async (destroy = false) => {
        if (disposed) return;
        disposed = true;
        signal.removeEventListener('abort', abort);
        try {
          if (destroy) await connector.destroy();
          else await connector.close();
        } catch {}
      };
      const abort = () => {
        void dispose(true);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (!response.body) {
        void dispose();
        return response;
      }
      const reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                controller.close();
                await dispose();
              } else controller.enqueue(next.value);
            } catch (error) {
              controller.error(error);
              await dispose(true);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              await dispose(true);
            }
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    const common = {
      fetch: async (url: string, init: RequestInit): Promise<Response> => {
        // A dedicated transport's optional dispatcher has already resolved its
        // account egress. Otherwise share core address/proxy/TLS policy here.
        if ('dispatcher' in init && init.dispatcher !== undefined)
          return options.fetch(url, init as unknown as Parameters<ProviderHttpFetch>[1]);
        const signal = init.signal ?? requests.getStore()?.signal;
        if (!signal || signal.aborted) return unavailable();
        const target = new URL(url);
        if (target.protocol !== 'https:' || target.username || target.password) return unavailable();
        const profile = (await core.resolveEgressProfile?.(dispatchProfileInput(signal))) ?? {};
        const resolveAddresses = core.resolveAddresses ?? resolveProviderHttpAddresses;
        const resolved = await resolveAddresses(target.hostname, signal);
        const address = selectPinnedProviderAddress(target.hostname, resolved, undefined, core.egressAllowlist);
        const proxy = profile.egressProxy
          ? await resolveEgressProxyTarget(profile.egressProxy, {
              resolveAddresses,
              signal,
              egressAllowlist: core.egressAllowlist,
            })
          : undefined;
        const connector = (core.createConnector ?? createPinnedProviderHttpConnector)({
          hostname: target.hostname,
          port: target.port === '' ? 443 : Number(target.port),
          ...address,
          ...(proxy ? { proxy } : {}),
          ...(profile.tlsFingerprint ? { tlsFingerprint: profile.tlsFingerprint } : {}),
        });
        try {
          return responseWithConnector(
            await options.fetch(url, {
              ...init,
              dispatcher: connector.dispatcher,
            } as unknown as Parameters<ProviderHttpFetch>[1]),
            connector,
            signal,
          );
        } catch (error) {
          await connector.destroy().catch(() => undefined);
          throw error;
        }
      },
      timeoutMs: options.timeoutMs,
    };
    const transports: GatewayProviderEvidenceTransports = {};
    if (enabled.has('codex'))
      transports.codexEvidenceTransport = bound(
        new CodexPreparedEvidenceTransport({
          ...common,
          resolveCredential: (input, use) =>
            withSecret(input, async (secret) => {
              const value = material(secret);
              return use({
                accessToken: text(value.access_token),
                chatgptAccountId: text(value.chatgpt_account_id),
                chatgptUserId: text(value.chatgpt_user_id),
              });
            }),
          resolveRequestContext: () => ({
            proxyKeyId: text(requests.getStore()?.proxyKeyId),
            clientSessionId: null,
            clientConversationId: null,
            fingerprintMode: 'off',
            fingerprintSeed: null,
          }),
          writeQuotaSnapshot: sinks.codexQuotaSnapshot,
        }),
      );
    if (enabled.has('codex')) {
      const accounts = new AsyncLocalStorage<string>();
      transports.responsesCompactEvidenceTransport = bound(
        new ProviderHttpTransport({
          fetch: (url, init) => {
            const accountId = accounts.getStore();
            if (!accountId) return unavailable();
            const identity = buildCanonicalIdentity();
            return options.fetch(url, {
              ...init,
              headers: {
                ...(init.headers as Record<string, string>),
                'chatgpt-account-id': accountId,
                'user-agent': identity.userAgent,
                originator: identity.originator,
                version: identity.version,
                'openai-beta': 'responses=experimental',
              },
            });
          },
          resolveDispatchProfile: async (input) =>
            input.endpoint === 'codex-responses' &&
            input.providerProtocol === 'responses' &&
            input.providerOperation === 'responses.compact'
              ? {
                  url: 'https://chatgpt.com/backend-api/codex/responses/compact',
                  ...(await core.resolveEgressProfile?.(input)),
                }
              : null,
          resolveCredential: (input, use) =>
            withSecret(input, async (secret) => {
              const value = material(secret);
              const token = Buffer.from(`Bearer ${text(value.access_token)}`, 'utf8');
              try {
                return await accounts.run(text(value.chatgpt_account_id), () =>
                  use({ headerName: 'authorization', value: token }),
                );
              } finally {
                token.fill(0);
              }
            }),
          endpointPolicy: { allowedHosts: ['chatgpt.com'], allowedPorts: [443] },
          ...(core.createConnector ? { createConnector: core.createConnector } : {}),
          ...(core.egressAllowlist ? { egressAllowlist: core.egressAllowlist } : {}),
          ...(core.resolveAddresses ? { resolveAddresses: core.resolveAddresses } : {}),
          timeoutMs: options.timeoutMs,
        }),
      );
    }
    if (enabled.has('claude'))
      transports.claudeEvidenceTransport = bound(
        new ClaudePreparedEvidenceTransport({
          ...common,
          resolveCredential: (input, use) =>
            withSecret(input, async (secret) => {
              const value = material(secret);
              return use({
                accessToken: text(value.access_token),
                organizationUuid: text(value.organization_uuid),
                accountUuid: text(value.account_uuid),
              });
            }),
          resolveRequestContext: () => ({ proxyKeyId: text(requests.getStore()?.proxyKeyId) }),
          writeQuotaSnapshot: sinks.claudeQuotaSnapshot,
          writeRateLimit: sinks.claudeRateLimit,
        }),
      );
    if (enabled.has('gemini')) {
      // The signed bytes are the native Gemini request. The account-specific
      // Code Assist envelope is added only inside its authorized secret callback.
      const projects = new AsyncLocalStorage<string>();
      transports.geminiEvidenceTransport = bound(
        new GeminiPreparedEvidenceTransport({
          ...common,
          fetch: (url, init) => {
            const projectId = projects.getStore();
            if (!projectId) return unavailable();
            const transformed = applyGeminiCodeAssistTransform(body(), { projectId });
            return common.fetch(url, { ...init, body: JSON.stringify(transformed.body) });
          },
          resolveCredential: (input, use) =>
            withSecret(input, async (secret) => {
              const value = material(secret);
              const projectId = text(value.project_id);
              return projects.run(projectId, () =>
                use({
                  accessToken: text(value.access_token),
                  projectId,
                  tierId: typeof value.tier_id === 'string' ? value.tier_id : null,
                }),
              );
            }),
          resolveRequestContext: (evidence) => ({
            model: text(evidence.resolvedModel),
            stream: body().stream === true,
          }),
          writeRateLimit: sinks.geminiRateLimit,
        }),
      );
    }
    if (enabled.has('grok'))
      transports.grokEvidenceTransport = bound(
        new GrokPreparedEvidenceTransport({
          ...common,
          resolveCredential: (input, use) =>
            withSecret(input, async (secret) => {
              const value =
                requests.getStore()?.credentialType === 'oauth'
                  ? parseGrokOAuthCredentialMaterial(secret)
                  : parseGrokApiKeyMaterial(secret);
              if (!value) return unavailable();
              return use(value);
            }),
          resolveRequestContext: (evidence) => ({
            model: text(evidence.resolvedModel),
            stream: body().stream === true,
            upstreamPath: 'responses',
            credentialKind: requests.getStore()?.productId === 'grok-api' ? 'api-key' : 'oauth',
            conversationId: null,
          }),
          writeQuotaSnapshot: sinks.grokQuotaSnapshot,
        }),
      );
    if (enabled.has('bedrock'))
      transports.bedrockEvidenceTransport = bound(
        new BedrockPreparedEvidenceTransport({
          ...common,
          resolveCredential: (input, use) =>
            withSecret(input, async (secret) => {
              const value = parseBedrockCredentialMaterial(material(secret));
              if (!value) return unavailable();
              return use(value);
            }),
          resolveRequestContext: (evidence) => ({
            model: text(evidence.resolvedModel),
            stream: body().stream === true,
          }),
          writeRateLimit: sinks.bedrockRateLimit,
        }),
      );
    if (enabled.has('vertex'))
      transports.vertexEvidenceTransport = bound(
        new VertexPreparedEvidenceTransport({
          ...common,
          resolveCredential: (input, use) =>
            withSecret(input, async (secret) => {
              const value = vertexUpstreamCredentialFromMaterial(material(secret));
              if (!value || (value.expiresAtMs !== null && value.expiresAtMs <= Date.now())) return unavailable();
              return use(value);
            }),
          resolveRequestContext: (evidence) => {
            if (evidence.providerProtocol !== 'anthropic' && evidence.providerProtocol !== 'gemini')
              return unavailable();
            return {
              protocol: evidence.providerProtocol,
              model: text(evidence.resolvedModel),
              stream: body().stream === true,
            };
          },
          writeRateLimit: sinks.vertexRateLimit,
        }),
      );
    if (enabled.has('cn-providers'))
      transports.cnProvidersEvidenceTransport = new CnProvidersPreparedEvidenceTransport({
        inner: core.genericTransport,
      });
    if (enabled.has('opencode-go'))
      transports.opencodeGoEvidenceTransport = {
        send: (input) => core.genericTransport.send(input),
      };
    return Object.freeze(transports);
  };
  return {
    factory,
    get assembled() {
      return mounted && !closed;
    },
    close() {
      closed = true;
      requests.disable();
    },
  };
}
