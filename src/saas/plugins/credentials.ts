/**
 * Batch-5 §5.1 plugin credential boundary — the "envelope delivery +
 * restricted unseal" design (roadmap 批次五 5.1 KMS 边界; see types.ts
 * decision #2 for the full rationale).
 *
 * sub2api's ResolveOutboundIdentity mints a live access token and hands it
 * to the plugin over the reverse gRPC channel. Porting that verbatim would
 * serialize plaintext credential bytes onto a wire governed elsewhere by
 * the `gateway-provider-credential-unsealer.ts` discipline (unsealed
 * buffers exist only inside a finally-zeroized callback). This module
 * replaces it:
 *
 * 1. GRANT — a forward is only unsealable when the capability route is
 *    currently available, the plugin key matches the routed installation,
 *    the account is inside the stable rollout bucket, and the account's
 *    provider identity matches the capability's authorization scope. Grants
 *    are minted per request with a 60s TTL.
 *
 * 2. RESTRICTED UNSEAL — the sealed envelope is loaded from Postgres (the
 *    validation-worker precedent for a non-gateway role reading envelope
 *    rows) and unsealed in-process through a dedicated decrypt-only KMS
 *    module. The envelope AAD is frozen at seal time, so per-plugin scoping
 *    cannot ride inside the envelope crypto; it is enforced here, at the
 *    only unseal point a plugin can influence.
 *
 * 3. SESSION WRAP — the plaintext never leaves this callback. It is
 *    immediately re-encrypted under the per-runtime X25519 session key
 *    (AAD: pluginKey + requestId) and only THAT envelope crosses into the
 *    plugin child, which decrypts it in its own memory.
 */

import {
  createProviderCredentialContext,
  type ProviderCredentialEnvelope,
  type ProviderCredentialUnsealingKms,
  withUnsealedProviderCredential,
} from '../credentials/provider-crypto.js';
import type { SqlExecutor } from '../db/types.js';
import type { SessionWrappedCredential } from './protocol.js';
import type { PluginRuntime } from './runtime.js';
import {
  accountInPluginRollout,
  PLUGIN_CAPABILITY_AUTHORIZATIONS,
  type PluginCapabilityId,
  type PluginRouteSnapshot,
} from './types.js';

const GRANT_TTL_MS = 60_000;

export type PluginCredentialErrorCode =
  | 'GRANT_DENIED'
  | 'CREDENTIAL_NOT_FOUND'
  | 'CREDENTIAL_SCOPE_MISMATCH'
  | 'UNSEAL_FAILED';

export class PluginCredentialError extends Error {
  constructor(
    readonly code: PluginCredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginCredentialError';
  }
}

/** A short-lived, single-request unseal authorization. */
export interface PluginCredentialGrant {
  readonly pluginKey: string;
  readonly capability: PluginCapabilityId;
  readonly accountId: string;
  readonly expiresAtMs: number;
}

export interface PluginCredentialServiceOptions {
  readonly executor: SqlExecutor;
  readonly kms: ProviderCredentialUnsealingKms;
  /** Stable non-secret AAD identity (deployment/environment ids). */
  readonly deploymentId: string;
  readonly environmentId: string;
  /** Current route snapshot provider (the manager's authoritative view). */
  readonly getRoute: (capability: PluginCapabilityId) => PluginRouteSnapshot | undefined;
  readonly nowMs?: () => number;
}

interface EnvelopeRow {
  readonly provider_id: string;
  readonly product_id: string;
  readonly credential_type: string;
  readonly account_status: string;
  readonly credential_status: string;
  readonly version_status: string;
  readonly kms_purpose: string;
  readonly kms_key_id: string;
  readonly wrapped_dek: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly auth_tag: string;
}

export class PluginCredentialService {
  private readonly options: Required<Pick<PluginCredentialServiceOptions, 'nowMs'>> & PluginCredentialServiceOptions;

  constructor(options: PluginCredentialServiceOptions) {
    this.options = { ...options, nowMs: options.nowMs ?? (() => Date.now()) };
  }

  /**
   * Validate the grant for this forward against the current route snapshot
   * and the capability authorization table.
   */
  validateGrant(input: {
    pluginKey: string;
    capability: PluginCapabilityId;
    accountId: string;
  }): PluginCredentialGrant {
    const route = this.options.getRoute(input.capability);
    if (route === undefined || !route.available || route.pluginKey !== input.pluginKey) {
      throw new PluginCredentialError('GRANT_DENIED', 'no available plugin route authorizes this unseal');
    }
    if (!accountInPluginRollout(input.accountId, route.rolloutPercent)) {
      throw new PluginCredentialError('GRANT_DENIED', 'account is outside the plugin rollout bucket');
    }
    return {
      pluginKey: input.pluginKey,
      capability: input.capability,
      accountId: input.accountId,
      expiresAtMs: this.options.nowMs() + GRANT_TTL_MS,
    };
  }

  /**
   * Load the sealed envelope, unseal it inside the zeroize-disciplined
   * callback, and return the session-wrapped form for `forward.begin`.
   * Returns null when the account has no active credential version (the
   * plugin then forwards without a credential envelope — the upstream will
   * reject it, which is the honest outcome).
   */
  async wrapCredentialForForward(input: {
    grant: PluginCredentialGrant;
    runtime: PluginRuntime;
    requestId: string;
    ownerKind: 'tenant' | 'platform';
    tenantId: string | null;
    accountId: string;
    credentialId: string;
    credentialVersion: number;
  }): Promise<SessionWrappedCredential | null> {
    if (this.options.nowMs() >= input.grant.expiresAtMs) {
      throw new PluginCredentialError('GRANT_DENIED', 'plugin credential grant expired');
    }
    if (input.grant.accountId !== input.accountId) {
      throw new PluginCredentialError('GRANT_DENIED', 'grant does not cover this account');
    }
    const authorization = PLUGIN_CAPABILITY_AUTHORIZATIONS[input.grant.capability];
    const row = await this.loadEnvelopeRow(input);
    if (row === null) return null;
    if (row.provider_id !== authorization.providerId) {
      // The capability scope (anthropic-claude) is fixed; a credential from
      // any other provider can never be unsealed for this plugin path.
      throw new PluginCredentialError(
        'CREDENTIAL_SCOPE_MISMATCH',
        'credential provider is outside the capability scope',
      );
    }
    if (row.account_status !== 'active' || row.credential_status !== 'active' || row.version_status !== 'active') {
      return null;
    }
    const context = createProviderCredentialContext(
      input.ownerKind === 'tenant'
        ? {
            ownerKind: 'tenant',
            tenantId: input.tenantId ?? failGrant('GRANT_DENIED', 'tenant credential without tenant id'),
            supplyMode: 'byok',
            deployment: this.options.deploymentId,
            environment: this.options.environmentId,
            purpose: row.kms_purpose,
            providerId: row.provider_id,
            productId: row.product_id,
            credentialType: row.credential_type,
            accountId: input.accountId,
            credentialId: input.credentialId,
            credentialVersion: input.credentialVersion,
          }
        : {
            ownerKind: 'platform',
            supplyMode: 'platform',
            deployment: this.options.deploymentId,
            environment: this.options.environmentId,
            purpose: row.kms_purpose,
            providerId: row.provider_id,
            productId: row.product_id,
            credentialType: row.credential_type,
            accountId: input.accountId,
            credentialId: input.credentialId,
            credentialVersion: input.credentialVersion,
          },
    );
    const envelope: ProviderCredentialEnvelope = {
      schemaVersion: 1,
      contextVersion: 1,
      algorithm: 'aes-256-gcm',
      kmsKeyId: row.kms_key_id,
      wrappedDek: row.wrapped_dek,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authTag: row.auth_tag,
    };
    try {
      return await withUnsealedProviderCredential(envelope, context, this.options.kms, (plaintext) => {
        // The ONLY transformation applied to plaintext bytes: re-encryption
        // under the per-runtime session key. `wrapCredential` reads them
        // synchronously; the helper zeroizes its copy on return.
        return input.runtime.wrapCredential(plaintext, input.requestId);
      });
    } catch {
      throw new PluginCredentialError('UNSEAL_FAILED', 'credential envelope could not be unsealed');
    }
  }

  private async loadEnvelopeRow(input: {
    ownerKind: 'tenant' | 'platform';
    tenantId: string | null;
    accountId: string;
    credentialId: string;
    credentialVersion: number;
  }): Promise<EnvelopeRow | null> {
    if (input.ownerKind === 'tenant') {
      if (input.tenantId === null) return null;
      const result = await this.options.executor.query<EnvelopeRow>(
        `SELECT a.provider_id, a.product_id, a.credential_type, a.status AS account_status,
                c.status AS credential_status, v.status AS version_status,
                v.kms_purpose, v.kms_key_id, v.wrapped_dek, v.nonce, v.ciphertext, v.auth_tag
           FROM saas_tenant_provider_accounts a
           JOIN saas_tenant_provider_credentials c
             ON c.tenant_id = a.tenant_id AND c.account_id = a.id
           JOIN saas_tenant_provider_credential_versions v
             ON v.tenant_id = c.tenant_id AND v.credential_id = c.id AND v.account_id = c.account_id
          WHERE a.tenant_id = $1 AND a.id = $2 AND c.id = $3 AND v.version = $4
            AND c.provider_id = a.provider_id AND c.product_id = a.product_id
            AND c.credential_type = a.credential_type`,
        [input.tenantId, input.accountId, input.credentialId, input.credentialVersion],
      );
      return result.rows[0] ?? null;
    }
    const result = await this.options.executor.query<EnvelopeRow>(
      `SELECT a.provider_id, a.product_id, a.credential_type, a.status AS account_status,
              c.status AS credential_status, v.status AS version_status,
              v.kms_purpose, v.kms_key_id, v.wrapped_dek, v.nonce, v.ciphertext, v.auth_tag
         FROM saas_platform_provider_accounts a
         JOIN saas_platform_provider_credentials c
           ON c.account_id = a.id
         JOIN saas_platform_provider_credential_versions v
           ON v.credential_id = c.id AND v.account_id = c.account_id
        WHERE a.id = $1 AND c.id = $2 AND v.version = $3
          AND c.provider_id = a.provider_id AND c.product_id = a.product_id
          AND c.credential_type = a.credential_type`,
      [input.accountId, input.credentialId, input.credentialVersion],
    );
    return result.rows[0] ?? null;
  }
}

function failGrant(code: PluginCredentialErrorCode, message: string): never {
  throw new PluginCredentialError(code, message);
}
