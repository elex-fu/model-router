import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';
import type { TrustedPreparedRequestVerifierKey } from '../gateway/prepared-request-evidence-service.js';

export type TrustedPreparedRequestVerifierKeyStatus = 'active' | 'retired';

/** One non-secret public-key declaration supplied by deployment composition. */
export interface TrustedPreparedRequestVerifierKeyDefinition {
  readonly keyId: string;
  readonly publicKey: TrustedPreparedRequestVerifierKey;
  readonly status: TrustedPreparedRequestVerifierKeyStatus;
}

export interface TrustedPreparedRequestVerifierKeyRegistryConfig {
  readonly keys: readonly TrustedPreparedRequestVerifierKeyDefinition[];
}

export interface TrustedPreparedRequestVerifierKeyRecord {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly status: TrustedPreparedRequestVerifierKeyStatus;
}

export type TrustedPreparedRequestVerifierKeyRegistryErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_KEY_ID'
  | 'DUPLICATE_KEY_ID'
  | 'INVALID_KEY_STATUS'
  | 'INVALID_KEY_MATERIAL'
  | 'UNSUPPORTED_KEY_ALGORITHM'
  | 'NO_ACTIVE_KEYS'
  | 'UNKNOWN_KEY_ID';

const ERROR_MESSAGES: Readonly<Record<TrustedPreparedRequestVerifierKeyRegistryErrorCode, string>> = Object.freeze({
  INVALID_CONFIGURATION: 'Trusted prepared-evidence verifier key configuration is invalid',
  INVALID_KEY_ID: 'Trusted prepared-evidence verifier key id is invalid',
  DUPLICATE_KEY_ID: 'Trusted prepared-evidence verifier key ids must be unique',
  INVALID_KEY_STATUS: 'Trusted prepared-evidence verifier key status is invalid',
  INVALID_KEY_MATERIAL: 'Trusted prepared-evidence verifier key material is invalid',
  UNSUPPORTED_KEY_ALGORITHM: 'Trusted prepared-evidence verifier key must be Ed25519',
  NO_ACTIVE_KEYS: 'At least one active trusted prepared-evidence verifier key is required',
  UNKNOWN_KEY_ID: 'Trusted prepared-evidence verifier key id is not configured',
});

export class TrustedPreparedRequestVerifierKeyRegistryError extends Error {
  constructor(readonly code: TrustedPreparedRequestVerifierKeyRegistryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'TrustedPreparedRequestVerifierKeyRegistryError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type KeyEntry = readonly [string, KeyObject];

interface PreparedRegistryInput {
  readonly records: readonly TrustedPreparedRequestVerifierKeyRecord[];
  readonly trustedEntries: readonly KeyEntry[];
  readonly activeEntries: readonly KeyEntry[];
  readonly retiredEntries: readonly KeyEntry[];
}

function registryError(
  code: TrustedPreparedRequestVerifierKeyRegistryErrorCode,
): TrustedPreparedRequestVerifierKeyRegistryError {
  return new TrustedPreparedRequestVerifierKeyRegistryError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKeyId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw registryError('INVALID_KEY_ID');
  return value.trim();
}

function normalizeStatus(value: unknown): TrustedPreparedRequestVerifierKeyStatus {
  if (value === 'active' || value === 'retired') return value;
  throw registryError('INVALID_KEY_STATUS');
}

function rejectPrivateKeyMaterial(value: string | Uint8Array): void {
  try {
    if (typeof value === 'string') {
      createPrivateKey(value);
    } else {
      createPrivateKey({ key: Buffer.from(value), format: 'der', type: 'pkcs8' });
    }
  } catch {
    return;
  }
  throw registryError('INVALID_KEY_MATERIAL');
}

function parsePublicKey(value: unknown): KeyObject {
  if (value instanceof KeyObject) {
    const key = value;
    if (key.type !== 'public') throw registryError('INVALID_KEY_MATERIAL');
    if (key.asymmetricKeyType !== 'ed25519') throw registryError('UNSUPPORTED_KEY_ALGORITHM');
    return key;
  }

  if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
    throw registryError('INVALID_KEY_MATERIAL');
  }

  rejectPrivateKeyMaterial(value);

  let key: KeyObject;
  try {
    key =
      typeof value === 'string'
        ? createPublicKey(value)
        : createPublicKey({ key: Buffer.from(value), format: 'der', type: 'spki' });
  } catch {
    throw registryError('INVALID_KEY_MATERIAL');
  }

  if (key.type !== 'public') throw registryError('INVALID_KEY_MATERIAL');
  if (key.asymmetricKeyType !== 'ed25519') throw registryError('UNSUPPORTED_KEY_ALGORITHM');
  return key;
}

function parseConfig(config: unknown): readonly TrustedPreparedRequestVerifierKeyDefinition[] {
  if (!isRecord(config) || !Array.isArray(config.keys)) throw registryError('INVALID_CONFIGURATION');
  return config.keys as readonly TrustedPreparedRequestVerifierKeyDefinition[];
}

function prepareRegistryInput(config: unknown): PreparedRegistryInput {
  const definitions = parseConfig(config);
  const records: TrustedPreparedRequestVerifierKeyRecord[] = [];
  const trustedEntries: KeyEntry[] = [];
  const activeEntries: KeyEntry[] = [];
  const retiredEntries: KeyEntry[] = [];
  const seen = new Set<string>();

  for (const definition of definitions) {
    if (!isRecord(definition)) throw registryError('INVALID_CONFIGURATION');

    const keyId = normalizeKeyId(definition.keyId);
    if (seen.has(keyId)) throw registryError('DUPLICATE_KEY_ID');
    seen.add(keyId);

    const status = normalizeStatus(definition.status);
    const publicKey = parsePublicKey(definition.publicKey);
    const record = Object.freeze({ keyId, publicKey, status });
    records.push(record);

    const entry = Object.freeze([keyId, publicKey] as const);
    trustedEntries.push(entry);
    (status === 'active' ? activeEntries : retiredEntries).push(entry);
  }

  if (activeEntries.length === 0) throw registryError('NO_ACTIVE_KEYS');

  return {
    records: Object.freeze(records),
    trustedEntries: Object.freeze(trustedEntries),
    activeEntries: Object.freeze(activeEntries),
    retiredEntries: Object.freeze(retiredEntries),
  };
}

function frozenPublicKeyRecord(entries: readonly KeyEntry[]): Readonly<Record<string, KeyObject>> {
  const record = Object.create(null) as Record<string, KeyObject>;
  for (const [keyId, publicKey] of entries) {
    Object.defineProperty(record, keyId, {
      configurable: false,
      enumerable: true,
      value: publicKey,
      writable: false,
    });
  }
  return Object.freeze(record);
}

/**
 * A map-shaped read-only view for callers that prefer the service's Map form.
 * Its backing entries are frozen and it intentionally exposes no mutators.
 */
class ReadonlyPublicKeyMap implements ReadonlyMap<string, KeyObject> {
  readonly #entries: readonly KeyEntry[];

  constructor(entries: readonly KeyEntry[]) {
    this.#entries = entries;
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.length;
  }

  get(key: string): KeyObject | undefined {
    for (const [entryKey, publicKey] of this.#entries) {
      if (entryKey === key) return publicKey;
    }
    return undefined;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  entries(): MapIterator<[string, KeyObject]> {
    return this.#entries.map(([keyId, publicKey]) => [keyId, publicKey])[Symbol.iterator]() as MapIterator<
      [string, KeyObject]
    >;
  }

  keys(): MapIterator<string> {
    return this.#entries.map(([keyId]) => keyId)[Symbol.iterator]() as MapIterator<string>;
  }

  values(): MapIterator<KeyObject> {
    return this.#entries.map(([, publicKey]) => publicKey)[Symbol.iterator]() as MapIterator<KeyObject>;
  }

  forEach(
    callbackfn: (value: KeyObject, key: string, map: ReadonlyMap<string, KeyObject>) => void,
    thisArg?: unknown,
  ): void {
    for (const [keyId, publicKey] of this.#entries) callbackfn.call(thisArg, publicKey, keyId, this);
  }

  [Symbol.iterator](): MapIterator<[string, KeyObject]> {
    return this.entries();
  }
}

/**
 * Immutable trusted-key material for SaasPreparedRequestEvidenceService.
 *
 * The service contract has one key map for both registration and claim-time
 * verification. Consequently, retired keys stay in `trustedVerifierPublicKeys`
 * so a proof created before rotation can still be re-verified during a later
 * claim. Retirement is metadata for deployment key selection; it is not a
 * cryptographic revocation. Remove a retired key only after its historical
 * proofs no longer need to be claimed.
 */
export class TrustedPreparedRequestVerifierKeyRegistry {
  readonly trustedVerifierPublicKeys: Readonly<Record<string, KeyObject>>;
  readonly activeVerifierPublicKeys: Readonly<Record<string, KeyObject>>;
  readonly retiredVerifierPublicKeys: Readonly<Record<string, KeyObject>>;
  readonly trustedVerifierPublicKeyMap: ReadonlyMap<string, KeyObject>;
  readonly activeVerifierPublicKeyMap: ReadonlyMap<string, KeyObject>;
  readonly retiredVerifierPublicKeyMap: ReadonlyMap<string, KeyObject>;
  readonly records: readonly TrustedPreparedRequestVerifierKeyRecord[];
  readonly activeKeyIds: readonly string[];
  readonly retiredKeyIds: readonly string[];

  constructor(config: TrustedPreparedRequestVerifierKeyRegistryConfig) {
    const prepared = prepareRegistryInput(config);
    this.records = prepared.records;
    this.activeKeyIds = Object.freeze(prepared.activeEntries.map(([keyId]) => keyId));
    this.retiredKeyIds = Object.freeze(prepared.retiredEntries.map(([keyId]) => keyId));
    this.trustedVerifierPublicKeys = frozenPublicKeyRecord(prepared.trustedEntries);
    this.activeVerifierPublicKeys = frozenPublicKeyRecord(prepared.activeEntries);
    this.retiredVerifierPublicKeys = frozenPublicKeyRecord(prepared.retiredEntries);
    this.trustedVerifierPublicKeyMap = new ReadonlyPublicKeyMap(prepared.trustedEntries);
    this.activeVerifierPublicKeyMap = new ReadonlyPublicKeyMap(prepared.activeEntries);
    this.retiredVerifierPublicKeyMap = new ReadonlyPublicKeyMap(prepared.retiredEntries);
    Object.freeze(this);
  }

  get(keyId: string): KeyObject | undefined {
    return this.trustedVerifierPublicKeyMap.get(keyId);
  }

  has(keyId: string): boolean {
    return this.trustedVerifierPublicKeyMap.has(keyId);
  }

  getStatus(keyId: string): TrustedPreparedRequestVerifierKeyStatus | undefined {
    for (const record of this.records) {
      if (record.keyId === keyId) return record.status;
    }
    return undefined;
  }

  getRequired(keyId: string): KeyObject {
    const publicKey = this.get(keyId);
    if (!publicKey) throw registryError('UNKNOWN_KEY_ID');
    return publicKey;
  }

  getRecord(keyId: string): TrustedPreparedRequestVerifierKeyRecord | undefined {
    return this.records.find((record) => record.keyId === keyId);
  }
}

/** Build a deployment-injected registry without reading environment state. */
export function loadTrustedPreparedRequestVerifierKeyRegistry(
  config: TrustedPreparedRequestVerifierKeyRegistryConfig,
): TrustedPreparedRequestVerifierKeyRegistry {
  return new TrustedPreparedRequestVerifierKeyRegistry(config);
}

/** Descriptive factory alias for composition code that prefers create semantics. */
export const createTrustedPreparedRequestVerifierKeyRegistry = loadTrustedPreparedRequestVerifierKeyRegistry;
