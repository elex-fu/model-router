import { type RequestInit as UndiciRequestInit, fetch as undiciFetch } from 'undici';
import type { ProviderCredentialUnsealingKms } from '../credentials/provider-crypto.js';
import type { SqlExecutor } from '../db/types.js';
import {
  createProviderEgressProxyConnection,
  type ProviderHttpEgressAllowlist,
  type ProviderHttpPinnedConnector,
} from '../gateway/provider-http-address.js';
import { type EgressProxyRecord, readEgressProxyForAccount } from './egress-proxy-lookup.js';
import { assembleEgressProxyUrl } from './egress-proxy-record.js';
import { withUnsealedEgressProxyCredentials } from './egress-proxy-seal.js';

export type AccountOutboundFetch = (
  url: string | URL,
  init: RequestInit & { readonly dispatcher?: unknown },
) => Promise<Response>;
export type AccountOutboundConnectionFactory = typeof createProviderEgressProxyConnection;

export interface AccountOutboundOptions {
  readonly deployment: string;
  readonly environment: string;
  readonly signal?: AbortSignal;
  readonly egressAllowlist?: ProviderHttpEgressAllowlist;
  /** Test seam; production always uses local Undici, including proxy requests. */
  readonly fetch?: AccountOutboundFetch;
  readonly createEgressConnection?: AccountOutboundConnectionFactory;
}

export class AccountOutboundError extends Error {
  readonly code = 'egress_proxy_unavailable' as const;

  constructor() {
    super('Account outbound connection is unavailable');
    this.name = 'AccountOutboundError';
  }
}

/** A proxy URL exists only inside the request scope and is never returned as a result. */
async function accountEgressProxyDescriptor(
  proxy: EgressProxyRecord | null,
  kms: ProviderCredentialUnsealingKms,
  options: Pick<AccountOutboundOptions, 'deployment' | 'environment'>,
): Promise<{ readonly url: string } | undefined> {
  if (proxy === null) return undefined;
  try {
    const url = await withUnsealedEgressProxyCredentials(
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
    return { url };
  } catch {
    throw new AccountOutboundError();
  }
}

/**
 * Run all calls in an account lifecycle operation through one bound proxy.
 * Connection/decryption failures never retry directly. A dispatcher stays
 * alive through response consumption and is destroyed when the scope ends.
 */
export async function withAccountOutbound<T>(
  executor: SqlExecutor,
  kms: ProviderCredentialUnsealingKms,
  account: { readonly ownerKind: 'tenant' | 'platform'; readonly tenantId: string | null; readonly accountId: string },
  options: AccountOutboundOptions,
  callback: (outbound: {
    readonly fetch: AccountOutboundFetch;
    readonly proxy: { readonly url: string } | undefined;
  }) => Promise<T>,
): Promise<T> {
  let proxy: { readonly url: string } | undefined;
  try {
    proxy = await accountEgressProxyDescriptor(
      await readEgressProxyForAccount(executor, {
        ownerKind: account.ownerKind,
        ...(account.ownerKind === 'tenant' ? { tenantId: account.tenantId ?? undefined } : {}),
        accountId: account.accountId,
      }),
      kms,
      options,
    );
  } catch {
    throw new AccountOutboundError();
  }
  const baseFetch: AccountOutboundFetch =
    options.fetch ?? (async (url, init) => (await undiciFetch(url, init as UndiciRequestInit)) as unknown as Response);
  let connection: Promise<ProviderHttpPinnedConnector> | undefined;
  const fetcher: AccountOutboundFetch = async (url, init) => {
    const signal =
      options.signal === undefined
        ? init.signal
        : init.signal === undefined || init.signal === null
          ? options.signal
          : AbortSignal.any([options.signal, init.signal]);
    const request = { ...init, ...(signal === undefined ? {} : { signal }) };
    signal?.throwIfAborted();
    if (proxy === undefined) return baseFetch(url, request);
    try {
      connection ??= (options.createEgressConnection ?? createProviderEgressProxyConnection)(proxy, {
        ...(signal === undefined || signal === null ? {} : { signal }),
        ...(options.egressAllowlist === undefined ? {} : { egressAllowlist: options.egressAllowlist }),
      });
      const connector = await connection;
      return await baseFetch(url, { ...request, dispatcher: connector.dispatcher, redirect: 'manual' });
    } catch {
      throw new AccountOutboundError();
    }
  };
  try {
    return await callback({ fetch: fetcher, proxy });
  } finally {
    if (connection !== undefined) {
      await connection
        .then(
          (connector) => connector.destroy(),
          () => undefined,
        )
        .catch(() => undefined);
    }
  }
}
