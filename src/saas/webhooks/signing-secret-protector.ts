import { assertWebhookUuid } from './events.js';

export interface WebhookSigningSecretContext {
  readonly tenantId: string;
  readonly endpointId: string;
  readonly secretVersion: number;
}

/**
 * A dedicated envelope boundary for customer webhook signing keys. Production
 * implementations must not reuse provider-credential crypto purposes or keys.
 * The caller supplies the canonical AAD on both protect and unprotect.
 */
export interface WebhookSigningSecretProtector {
  readonly purpose: 'customer-webhook-signing-secret-v1';
  protect(plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  unprotect(envelope: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
}

export function webhookSigningSecretAad(context: WebhookSigningSecretContext): Buffer {
  assertWebhookUuid(context.tenantId, 'tenantId');
  assertWebhookUuid(context.endpointId, 'endpointId');
  if (
    !Number.isSafeInteger(context.secretVersion) ||
    context.secretVersion < 1 ||
    context.secretVersion > 999_999_999
  ) {
    throw new RangeError('secretVersion must be a positive bounded integer');
  }
  return Buffer.from(
    `model-router/customer-webhook-signing-secret/v1\ntenant=${context.tenantId.toLowerCase()}\nendpoint=${context.endpointId.toLowerCase()}\nversion=${context.secretVersion}`,
    'utf8',
  );
}

export function assertProtectedWebhookEnvelope(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 16_384) {
    throw new TypeError('webhook signing-secret protector returned an invalid envelope');
  }
}

export function assertUnprotectedWebhookSecret(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 256) {
    throw new TypeError('webhook signing-secret protector returned an invalid plaintext key');
  }
}
