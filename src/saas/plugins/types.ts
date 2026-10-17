/**
 * Batch-5 §5.1 plugin system (task #24; design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次五 5.1; sub2api reference:
 * backend/internal/service/plugin_{manager,package,manifest,runtime,host_services}.go,
 * backend/pkg/pluginapi/v1/plugin.proto, docs/PLUGIN_DEVELOPMENT.md).
 *
 * Two pre-decisions (recorded here because every later file builds on them):
 *
 * 1. DEPLOYMENT FORM — standalone plugin-host workload. The
 *    credential-validation-worker precedent (`--role credential-validation-worker`)
 *    is the established same-repo independent-workload pattern; plugins are
 *    third-party code, so keeping their child processes (and the plugin
 *    package bytes) out of the gateway/control-plane processes is strictly
 *    safer than an in-gateway spawn. The plugin-host workload owns: the
 *    reconcile loop, the plugin child processes (stdio JSON-RPC), and an
 *    internal-token-guarded HTTP surface the gateway calls for forwarding.
 *    The gateway gets an optional routing decorator at the Claude transport
 *    exit (`PreparedEvidenceTransport` seam — see
 *    gateway-plugin-router.ts); when no plugin is enabled the decorator is a
 *    byte-identical passthrough.
 *
 * 2. KMS BOUNDARY — envelope delivery with restricted unsealing, no plaintext
 *    on any inter-process wire. sub2api's ResolveOutboundIdentity hands the
 *    live access token to the plugin over gRPC; in model-router that would
 *    break the `gateway-provider-credential-unsealer.ts` discipline (the
 *    unsealed Buffer never leaves a `finally`-zeroized callback). Design:
 *    the plugin-host loads the SEALED envelope from Postgres, unseals it
 *    inside its own process through a dedicated decrypt-only KMS module
 *    (the validation-worker loader pattern — zero changes to the sealed
 *    envelope format or the KMS interfaces), and re-wraps the plaintext
 *    under a per-runtime X25519 session key negotiated in the handshake.
 *    The child receives only the AES-256-GCM session envelope and decrypts
 *    it in its own memory. The per-plugin scope is enforced at the
 *    plugin-host unseal boundary via short-lived grants minted from the
 *    enabled binding (see credentials.ts): the envelope AAD is frozen at
 *    seal time and cannot carry plugin identity, so key-policy isolation
 *    comes from the role-separated decrypt module, and plugin-level
 *    restriction from the grant registry. Plaintext token bytes never
 *    appear in any serialization: not DB→host (KMS decrypt is in-process),
 *    not host→plugin (session ciphertext only).
 */

/** Host version reported to plugins and matched against manifest `requires.model_router`. */
export const PLUGIN_HOST_VERSION = '0.1.0';

/** Wire protocol constants shared by the runtime and every plugin implementation. */
export const PLUGIN_PROTOCOL_VERSION = 1 as const;
export const PLUGIN_TRANSPORT_API_VERSION = 1 as const;
export const PLUGIN_MAGIC_COOKIE_ENV = 'MR_PLUGIN_MAGIC_COOKIE';
export const PLUGIN_MAGIC_COOKIE_VALUE = 'model-router-plugin-v1';

/** Only capabilities listed here may ever appear in a manifest (fail-closed). */
export const PLUGIN_CAPABILITY_IDS = ['claude.oauth.outbound_transport.v1'] as const;
export type PluginCapabilityId = (typeof PLUGIN_CAPABILITY_IDS)[number];

export interface PluginCapabilityAuthorization {
  /**
   * The platform/category this capability may bind to. A manifest cannot
   * widen this: `pluginCapabilityAuthorizations` is the single widening
   * point (the sub2api `pluginCapabilityAccountScopeGrants` rule).
   */
  readonly platform: string;
  /** Account type the capability applies to. */
  readonly accountType: string;
  /** Signed endpoint scope(s) whose traffic the capability may intercept. */
  readonly endpoints: readonly string[];
  /** Catalog provider identity whose accounts (and credentials) the scope covers. */
  readonly providerId: string;
}

/** The centralized capability → scope authorization table (const, not config). */
export const PLUGIN_CAPABILITY_AUTHORIZATIONS: Readonly<Record<PluginCapabilityId, PluginCapabilityAuthorization>> =
  Object.freeze({
    'claude.oauth.outbound_transport.v1': Object.freeze({
      platform: 'claude',
      accountType: 'oauth',
      endpoints: Object.freeze(['claude-messages']),
      providerId: 'anthropic-claude',
    }),
  });

/** All valid plugin installation states (mirrors sub2api; CHECK-constrained in migration 128). */
export const PLUGIN_INSTALLATION_STATES = ['disabled', 'starting', 'enabled', 'error', 'incompatible'] as const;
export type PluginInstallationState = (typeof PLUGIN_INSTALLATION_STATES)[number];

export type PluginSignatureStatus = 'trusted' | 'unsigned';

/** Parsed, validated manifest (see package/manifest.ts for the wire schema). */
export interface PluginManifest {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly requires: {
    readonly modelRouter: string;
    readonly pluginProtocol: number;
    readonly transportApi: number;
  };
  readonly capabilities: readonly { readonly id: PluginCapabilityId }[];
  readonly entrypoint: string;
  readonly files: Readonly<Record<string, string>>;
}

/** A fully verified package on disk + DB row (installation identity). */
export interface PluginInstallationRecord {
  readonly id: number;
  readonly pluginKey: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly manifest: PluginManifest;
  /** SHA-256 of the raw manifest.json bytes — the signature-chain root. */
  readonly manifestSha256: string;
  readonly entrypointPath: string;
  readonly binarySha256: string;
  readonly signatureStatus: PluginSignatureStatus;
  readonly state: PluginInstallationState;
  readonly configJson: Readonly<Record<string, unknown>> | null;
  readonly lastError: string;
  /** The original signed package bytes (BYTEA) for multi-instance recovery. */
  readonly artifactData: Uint8Array;
  readonly artifactSha256: string;
  readonly installedBy: string | null;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly enabledAt: string | null;
}

export interface PluginBindingRecord {
  readonly id: number;
  readonly installationId: number;
  readonly pluginKey: string;
  readonly capability: PluginCapabilityId;
  readonly platform: string;
  readonly accountType: string;
  readonly enabled: boolean;
  readonly rolloutPercent: number;
}

/**
 * The authoritative routing snapshot for one capability. `available: false`
 * means "an enabled binding exists but the runtime cannot serve traffic" —
 * consumers must fail closed for routed accounts, never silently fall back
 * to the native path (the reconcile fail-closed rule).
 */
export interface PluginRouteSnapshot {
  readonly capability: PluginCapabilityId;
  readonly pluginKey: string;
  readonly rolloutPercent: number;
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

/** Host-service KV entry shape (PG-backed; saas_plugin_kv). */
export interface PluginKvEntry {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
  readonly expiresAt: string | null;
}

/** Read-only account directory entry (metadata snapshot only — never credentials). */
export interface PluginAccountCatalogEntry {
  readonly id: string;
  readonly ownerKind: 'tenant' | 'platform';
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly status: string;
  readonly displayName: string;
}

/**
 * The store contract the manager depends on. Postgres implementation:
 * src/saas/plugins/store.ts (migration 128). Every state transition is a CAS
 * on (id, expected state, expected binary_sha256) — 0 rows updated means a
 * concurrent admin/reconcile change won and must be re-read.
 */
export interface PluginStore {
  listInstallations(): Promise<PluginInstallationRecord[]>;
  getInstallation(pluginKey: string): Promise<PluginInstallationRecord | null>;
  /**
   * Insert or replace (re-upload) an installation. Must refuse (throw) when
   * the existing row is starting/enabled or has an enabled binding — the
   * caller maps that to "disable before replacing".
   */
  upsertInstallation(input: {
    pluginKey: string;
    name: string;
    version: string;
    description: string;
    author: string;
    manifest: PluginManifest;
    manifestSha256: string;
    entrypointPath: string;
    binarySha256: string;
    signatureStatus: PluginSignatureStatus;
    artifactData: Uint8Array;
    artifactSha256: string;
    installedBy: string | null;
  }): Promise<PluginInstallationRecord>;
  /** CAS state transition; null expectedState matches any current state. */
  updateInstallationState(input: {
    id: number;
    expectedState: PluginInstallationState | null;
    expectedBinarySha256: string;
    state: PluginInstallationState;
    lastError?: string;
  }): Promise<PluginInstallationRecord | null>;
  /**
   * CAS "runtime healthy": only succeeds when the row is starting/error with
   * a matching binary hash, and an enabled binding exists. 0 rows = benign
   * concurrent change (sub2api ErrPluginStateChanged).
   */
  markRuntimeHealthy(input: { id: number; expectedBinarySha256: string }): Promise<boolean>;
  updateConfigJson(input: {
    id: number;
    configJson: Readonly<Record<string, unknown>> | null;
  }): Promise<PluginInstallationRecord | null>;
  /** Replace the full binding set of one installation (delete+insert, tx). */
  replaceBindings(input: {
    installationId: number;
    bindings: readonly {
      capability: PluginCapabilityId;
      platform: string;
      accountType: string;
      enabled: boolean;
      rolloutPercent: number;
    }[];
  }): Promise<void>;
  listBindings(): Promise<PluginBindingRecord[]>;
  deleteInstallation(id: number): Promise<boolean>;
  kvGet(pluginKey: string, namespace: string, key: string): Promise<PluginKvEntry | null>;
  kvSet(pluginKey: string, namespace: string, key: string, value: string, ttlSeconds: number | null): Promise<void>;
  kvDelete(pluginKey: string, namespace: string, key: string): Promise<boolean>;
  kvList(pluginKey: string, namespace: string, keyPrefix: string, limit: number): Promise<string[]>;
}

/** Structured forward failure carrying the non-replayability verdict. */
export class PluginTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** true = the request may have reached upstream; automatic replay/failover is forbidden. */
    readonly requestSent: boolean,
  ) {
    super(message);
    this.name = 'PluginTransportError';
  }
}

/**
 * Stable per-account grayscale bucket (sub2api stablePluginBucket port).
 * Deterministic across processes; must never change once shipped.
 */
export function stablePluginBucket(accountId: string): number {
  // FNV-1a 64 over the UTF-8 id, then the sub2api finalizer mix.
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(accountId, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffff_ffff_ffff_ffffn;
  }
  let v = hash;
  v ^= v >> 33n;
  v = (v * 0xff51afd7ed558ccdn) & 0xffff_ffff_ffff_ffffn;
  v ^= v >> 33n;
  return Number(v % 100n);
}

/** Whether an account is routed by the given rollout percent (stable bucketing). */
export function accountInPluginRollout(accountId: string, rolloutPercent: number): boolean {
  if (rolloutPercent <= 0) return false;
  if (rolloutPercent >= 100) return true;
  return stablePluginBucket(accountId) < rolloutPercent;
}
