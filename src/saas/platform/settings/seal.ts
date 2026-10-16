import {
  createProviderCredentialContext,
  type ProviderCredentialEnvelope,
  type ProviderCredentialSealingKms,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
  withUnsealedProviderCredential,
} from '../../credentials/provider-crypto.js';

/**
 * F1 platform settings store: the KMS seal/unseal path for secret settings
 * values (Turnstile secret, SMTP password).
 *
 * The envelope is the exact same object shape used for provider credentials
 * (sealProviderCredential output — the egress-proxy-seal.ts precedent) and is
 * stored directly as the `value` jsonb of the secret-suffixed settings row
 * (the saas_egress_proxies.auth_sealed_envelope convention; migration 110's
 * CHECK pins that shape). The crypto context is bound to the settings key
 * through a dedicated purpose/credentialType pair, so a settings envelope can
 * never be confused with — or decrypted in place of — a provider-credential
 * or egress-proxy envelope sealed under the same KMS key (the context doubles
 * as the KMS encryption context and the AES-GCM AAD).
 *
 * Red lines: secrets are never plaintext at rest, the plaintext exists only
 * inside the unseal callback, all buffers are wiped, and no error message
 * ever contains envelope bytes or secret material.
 */

export const PLATFORM_SETTINGS_PURPOSE = 'platform-settings';
export const PLATFORM_SETTINGS_CREDENTIAL_TYPE = 'platform-setting-secret';
export const PLATFORM_SETTINGS_PROVIDER_ID = 'platform-settings';
export const PLATFORM_SETTINGS_CREDENTIAL_VERSION = 1;

export interface PlatformSettingSealContextInput {
  readonly settingsKey: string;
  readonly deployment: string;
  readonly environment: string;
}

function platformSettingContext(input: PlatformSettingSealContextInput) {
  return createProviderCredentialContext({
    ownerKind: 'platform',
    supplyMode: 'platform',
    deployment: input.deployment,
    environment: input.environment,
    purpose: PLATFORM_SETTINGS_PURPOSE,
    providerId: PLATFORM_SETTINGS_PROVIDER_ID,
    productId: PLATFORM_SETTINGS_PROVIDER_ID,
    accountId: input.settingsKey,
    credentialId: input.settingsKey,
    credentialVersion: PLATFORM_SETTINGS_CREDENTIAL_VERSION,
    credentialType: PLATFORM_SETTINGS_CREDENTIAL_TYPE,
  });
}

function normalizeSealContextInput(input: PlatformSettingSealContextInput): PlatformSettingSealContextInput {
  if (
    !input ||
    typeof input.settingsKey !== 'string' ||
    input.settingsKey === '' ||
    input.settingsKey.includes(' ') ||
    input.settingsKey.length > 128
  ) {
    throw new Error('platform setting seal context requires a bounded settings key');
  }
  for (const field of ['deployment', 'environment'] as const) {
    const value = input[field];
    if (typeof value !== 'string' || value === '' || value.length > 256) {
      throw new Error(`platform setting seal context requires a bounded ${field}`);
    }
  }
  return input;
}

/** Seal a secret settings value into a KMS envelope for the settings row. */
export async function sealPlatformSettingSecret(
  secret: string,
  context: PlatformSettingSealContextInput,
  kms: ProviderCredentialSealingKms,
  kmsKeyId: string,
): Promise<ProviderCredentialEnvelope> {
  const plaintext = Buffer.from(secret, 'utf-8');
  try {
    return await sealProviderCredential(
      plaintext,
      platformSettingContext(normalizeSealContextInput(context)),
      kms,
      kmsKeyId,
    );
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Unseal a stored settings envelope and hand the plaintext secret to the
 * callback. The secret exists only inside the callback; every buffer is wiped
 * on exit.
 */
export async function withUnsealedPlatformSettingSecret<T>(
  envelope: unknown,
  context: PlatformSettingSealContextInput,
  kms: ProviderCredentialUnsealingKms,
  callback: (secret: string) => T | PromiseLike<T>,
): Promise<T> {
  return await withUnsealedProviderCredential(
    envelope as ProviderCredentialEnvelope,
    platformSettingContext(normalizeSealContextInput(context)),
    kms,
    async (secret) => {
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(secret);
      } catch {
        throw new Error('platform setting secret plaintext is not valid UTF-8');
      } finally {
        secret.fill(0);
      }
      try {
        return await callback(decoded);
      } finally {
        decoded = '';
      }
    },
  );
}
