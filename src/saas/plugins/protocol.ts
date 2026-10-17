/**
 * Batch-5 §5.1 plugin wire protocol (sub2api pkg/pluginapi/v1/plugin.proto
 * ported to newline-delimited JSON-RPC 2.0 over stdio — the gRPC broker is
 * replaced because model-router keeps a zero-dependency runtime).
 *
 * Channel: the host owns the child's stdin (host→plugin) and stdout
 * (plugin→host); every message is ONE JSON value on ONE line terminated by
 * `\n` (UTF-8, no embedded newlines — JSON.stringify never emits them).
 * The child's stderr is diagnostics-only (bounded capture).
 *
 * Message families:
 *
 * - host→plugin REQUESTS (JSON-RPC `id`): `initialize` (handshake: protocol
 *   versions + the binary SHA-256 gate + the X25519 session key exchange),
 *   `getInfo` (manifest identity echo), `health`, `validateConfig`,
 *   `applyConfig` (atomic swap — on failure the plugin MUST keep its
 *   previous config and connections), `forward.begin`.
 * - host→plugin NOTIFICATIONS (no id; request-scoped stream frames):
 *   `forward.body`, `forward.end`, `forward.abort`.
 * - plugin→host NOTIFICATIONS (response stream frames): `response.start`,
 *   `response.body`, `response.end`, `response.error`.
 * - plugin→host REQUESTS (reverse channel — host services): `kv.get`,
 *   `kv.set`, `kv.delete`, `kv.list`, `accounts.list`. The pluginKey is
 *   bound server-side by the host; a plugin can never address another
 *   plugin's KV namespace.
 *
 * REQUEST_SENT SEMANTICS (the non-replayability rule): once `forward.begin`
 * has been accepted, the host cannot prove the plugin did not already send
 * the request upstream. Every failure from that point on — plugin crash,
 * protocol violation, mid-stream error — is surfaced with
 * `requestSent: true` and the caller is forbidden from automatically
 * replaying or failing over. Only failures strictly BEFORE the begin frame
 * is accepted (runtime down, begin send/reject with request_sent false) may
 * fail over.
 */

export const PLUGIN_RPC_PROTOCOL = '2.0' as const;

/** Hard cap on one wire line (request/response/notification). */
export const PLUGIN_MAX_WIRE_LINE_BYTES = 8 * 1024 * 1024;
/** Largest single body chunk the host sends or accepts (raw bytes pre-base64). */
export const PLUGIN_BODY_CHUNK_MAX_BYTES = 32 * 1024;
/** Bounded stderr capture for diagnostics (sub2api discards; we keep a ring). */
export const PLUGIN_STDERR_RING_BYTES = 64 * 1024;

export type PluginRpcId = number;

export interface PluginRpcRequest {
  readonly jsonrpc: typeof PLUGIN_RPC_PROTOCOL;
  readonly id: PluginRpcId;
  readonly method: string;
  readonly params: unknown;
}

export interface PluginRpcNotification {
  readonly jsonrpc: typeof PLUGIN_RPC_PROTOCOL;
  readonly method: string;
  readonly params: unknown;
}

export interface PluginRpcSuccess {
  readonly jsonrpc: typeof PLUGIN_RPC_PROTOCOL;
  readonly id: PluginRpcId;
  readonly result: unknown;
}

export interface PluginRpcWireError {
  readonly code: number;
  readonly message: string;
  /** Optional structured payload (e.g. `{ request_sent: true }`). */
  readonly data?: unknown;
}

export interface PluginRpcFailure {
  readonly jsonrpc: typeof PLUGIN_RPC_PROTOCOL;
  readonly id: PluginRpcId;
  readonly error: PluginRpcWireError;
}

// ---------------------------------------------------------------------------
// host→plugin: handshake and lifecycle
// ---------------------------------------------------------------------------

export interface InitializeParams {
  readonly protocol_version: number;
  readonly host_version: string;
  /** The plugin's own installation key — the HKDF `info` of the session key. */
  readonly plugin_key: string;
  /** base64 raw 32-byte X25519 public key for the per-runtime session key. */
  readonly host_session_public_key: string;
}

export interface InitializeResult {
  readonly protocol_version: number;
  /**
   * SHA-256 (hex) of the plugin's own entrypoint file, computed by the
   * plugin at handshake. Combined with the host re-hashing the entrypoint
   * immediately before spawn, this is the TOCTOU gate: both must equal the
   * manifest `files` hash.
   */
  readonly entrypoint_sha256: string;
  /** base64 raw 32-byte X25519 public key of the plugin's ephemeral keypair. */
  readonly session_public_key: string;
}

export interface GetInfoResult {
  readonly plugin_id: string;
  readonly plugin_version: string;
  readonly protocol_version: number;
  readonly transport_api_version: number;
}

export interface HealthResult {
  readonly healthy: boolean;
  readonly message?: string;
}

export interface ValidateConfigParams {
  readonly config_json: Readonly<Record<string, unknown>>;
}

export interface ValidateConfigResult {
  readonly valid: boolean;
  readonly message?: string;
  readonly normalized_config_json?: Readonly<Record<string, unknown>>;
}

export interface ApplyConfigResult {
  readonly applied: boolean;
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// forward stream (request side host→plugin)
// ---------------------------------------------------------------------------

export interface ForwardAccountContext {
  readonly id: string;
  readonly platform: string;
  readonly account_type: string;
}

/**
 * AES-256-GCM envelope under the per-runtime X25519 session key. The AAD is
 * `${pluginKey}\0${requestId}`; the tag is appended to the ciphertext. This
 * is the ONLY form in which credential material ever crosses the wire.
 */
export interface SessionWrappedCredential {
  readonly nonce: string;
  readonly ciphertext: string;
  readonly aad: string;
}

export interface ForwardBeginParams {
  readonly request_id: string;
  readonly method: string;
  readonly url: string;
  /** Header name → values. `authorization` is NEVER present; the plugin injects it after decrypting the session envelope. */
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly content_length: number | null;
  readonly has_body: boolean;
  readonly account: ForwardAccountContext;
  readonly credential_envelope: SessionWrappedCredential | null;
}

export interface ForwardBodyParams {
  readonly request_id: string;
  /** base64 of ≤ PLUGIN_BODY_CHUNK_MAX_BYTES raw bytes. */
  readonly data: string;
}

export interface ForwardEndParams {
  readonly request_id: string;
}

export interface ForwardAbortParams {
  readonly request_id: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// forward stream (response side plugin→host)
// ---------------------------------------------------------------------------

export interface ResponseStartParams {
  readonly request_id: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, readonly string[]>>;
}

export interface ResponseBodyParams {
  readonly request_id: string;
  readonly data: string;
}

export interface ResponseEndParams {
  readonly request_id: string;
}

export interface ResponseErrorParams {
  readonly request_id: string;
  readonly code: string;
  readonly message: string;
  /**
   * The plugin must report `false` ONLY when it can prove the upstream HTTP
   * transport was never invoked for this request.
   */
  readonly request_sent: boolean;
}

// ---------------------------------------------------------------------------
// plugin→host host services (reverse channel)
// ---------------------------------------------------------------------------

export interface KvGetParams {
  readonly namespace: string;
  readonly key: string;
}

export interface KvGetResult {
  readonly found: boolean;
  readonly value: string | null;
}

export interface KvSetParams {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
  readonly ttl_seconds: number | null;
}

export interface KvDeleteParams {
  readonly namespace: string;
  readonly key: string;
}

export interface KvListParams {
  readonly namespace: string;
  readonly key_prefix: string;
  readonly limit: number;
}

export interface KvListResult {
  readonly keys: readonly string[];
}

export interface AccountsListParams {
  readonly platform: string | null;
  readonly account_type: string | null;
}

export interface AccountsListResult {
  readonly accounts: readonly {
    readonly id: string;
    readonly owner_kind: 'tenant' | 'platform';
    readonly provider_id: string;
    readonly product_id: string;
    readonly credential_type: string;
    readonly status: string;
    readonly display_name: string;
  }[];
}

/** The host-service method registry the runtime dispatches reverse calls into. */
export type PluginHostServiceHandler = (params: unknown) => Promise<unknown>;

export interface PluginHostServices {
  readonly 'kv.get': PluginHostServiceHandler;
  readonly 'kv.set': PluginHostServiceHandler;
  readonly 'kv.delete': PluginHostServiceHandler;
  readonly 'kv.list': PluginHostServiceHandler;
  readonly 'accounts.list': PluginHostServiceHandler;
}

export const PLUGIN_HOST_SERVICE_METHODS = ['kv.get', 'kv.set', 'kv.delete', 'kv.list', 'accounts.list'] as const;

export type PluginHostServiceMethod = (typeof PLUGIN_HOST_SERVICE_METHODS)[number];

/** Capability carried on the forward API between gateway and plugin-host. */
export interface PluginForwardRequestWire {
  readonly request_id: string;
  readonly capability: import('./types.js').PluginCapabilityId;
  readonly account: {
    readonly id: string;
    readonly owner_kind: 'tenant' | 'platform';
    readonly tenant_id: string | null;
    readonly credential_id: string | null;
    readonly credential_version: number;
  };
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body_base64: string | null;
}

export interface PluginRouteSnapshotWire {
  readonly plugin_key: string;
  readonly rollout_percent: number;
  readonly available: boolean;
  readonly unavailable_reason: string | null;
}

export type PluginRoutesWire = Readonly<Record<string, PluginRouteSnapshotWire>>;
