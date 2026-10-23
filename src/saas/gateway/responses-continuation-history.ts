/** Persistence contract shared by HTTP and WS; implementations store only authenticated ciphertext. */
export interface ResponsesHistoryIdentity {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
  readonly conversationId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  readonly credentialAuthzVersion: string;
  readonly publicModel: string;
  readonly resolvedModel: string;
}
export interface ResponsesHistoryReference {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
  readonly conversationId: string;
  readonly responseId: string;
}
export interface ResponsesHistoryRecord extends ResponsesHistoryReference {
  readonly identity: ResponsesHistoryIdentity;
  readonly canonicalContextDigest: string;
  readonly encryptionKeyId: string;
  /** AEAD ciphertext envelope includes nonce and authentication tag. */
  readonly encryptedContext: Uint8Array;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}
export interface ResponsesContinuationHistoryPort {
  /** Must scope the database query by every reference field, never response ID alone. */
  find(reference: ResponsesHistoryReference, nowMs: number): Promise<ResponsesHistoryRecord | null>;
  /** Immutable/idempotent insertion; same reference with a different digest must conflict. */
  insert(record: ResponsesHistoryRecord): Promise<'inserted' | 'identical' | 'conflict'>;
  delete(reference: ResponsesHistoryReference): Promise<void>;
  /** Bounded background collection; tenant/key deletion must also remove their history. */
  purgeExpired(nowMs: number, limit: number): Promise<number>;
}
export interface ResponsesHistoryCipherPort {
  /** Associated data binds the full immutable identity, reference, digest and expiry. */
  seal(plaintext: Uint8Array, associatedData: Uint8Array): Promise<{ readonly encryptionKeyId: string; readonly encryptedContext: Uint8Array }>;
  open(record: { readonly encryptionKeyId: string; readonly encryptedContext: Uint8Array }, associatedData: Uint8Array): Promise<Uint8Array>;
}
