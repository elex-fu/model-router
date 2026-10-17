import net from 'node:net';
import { Agent, type buildConnector } from 'undici';
import {
  createPinnedProviderHttpConnector,
  type ProviderHttpConnectorInput,
  type ProviderHttpEgressProxyTarget,
  type ProviderHttpPinnedConnector,
} from './provider-http-address.js';

/**
 * TLS fingerprint sidecar connector (roadmap batch 2 §2.4, task #7).
 *
 * A small Go sidecar (sidecar/tlsfingerprint/) owns uTLS and dials provider
 * endpoints with a pinned ClientHello fingerprint; this module is the Node
 * half of its IPC protocol. The sidecar is deployed and supervised by the
 * deployment (compose/systemd) — the gateway only connects to its Unix
 * socket; it never spawns or kills the process (documented MVP decision).
 *
 * Wire protocol (one request per connection): u32be length-prefixed JSON
 * frames — dial request, then dial response — after which the socket is a
 * raw bidirectional byte tunnel to the fingerprinted TLS connection. The
 * tunneled socket is returned to undici as the connection socket; the
 * transport is HTTP/1.1 (the sidecar negotiates ALPN http/1.1).
 *
 * Fallback matrix (sub2api semantics):
 * - no fingerprint requested → the ordinary pinned connector (exact previous
 *   behavior, proxies included);
 * - fingerprint + https proxy → the ordinary pinned proxy connector (the
 *   sidecar cannot tunnel through TLS-wrapped proxies; drop the fingerprint,
 *   keep the proxy — never silently downgrade the egress path);
 * - fingerprint + direct / http proxy / socks5h → the sidecar (the proxy URL
 *   is forwarded; the sidecar owns the tunnel and the handshake).
 */

/** One ClientHello profile, column-shaped like saas_tls_fingerprint_profiles (migration 116). */
export interface ProviderTlsFingerprintProfileSpec {
  readonly name?: string;
  readonly enableGrease?: boolean;
  readonly cipherSuites?: readonly number[];
  readonly curves?: readonly number[];
  readonly pointFormats?: readonly number[];
  readonly signatureAlgorithms?: readonly number[];
  readonly alpnProtocols?: readonly string[];
  readonly supportedVersions?: readonly number[];
  readonly keyShareGroups?: readonly number[];
  readonly pskModes?: readonly number[];
  readonly extensions?: readonly number[];
}

/** The resolved per-account egress fingerprint descriptor. */
export interface ProviderTlsFingerprintEgress {
  /** 'default' = built-in Node.js 24.x ClientHello; 'random' = uTLS randomized; 'custom' = inline profile. */
  readonly selector: 'default' | 'random' | 'custom';
  /** Required exactly when selector is 'custom' (the resolved profile row). */
  readonly profile?: ProviderTlsFingerprintProfileSpec;
}

export type TlsFingerprintSidecarErrorCode = 'CONNECT_TIMEOUT' | 'PROTOCOL_ERROR' | 'DIAL_REJECTED';

export class TlsFingerprintSidecarError extends Error {
  constructor(readonly code: TlsFingerprintSidecarErrorCode) {
    super(
      code === 'CONNECT_TIMEOUT'
        ? 'the tls fingerprint sidecar connection timed out'
        : code === 'PROTOCOL_ERROR'
          ? 'the tls fingerprint sidecar sent a malformed reply'
          : 'the tls fingerprint sidecar rejected the dial request',
    );
    this.name = 'TlsFingerprintSidecarError';
  }
}

export const DEFAULT_TLS_FINGERPRINT_SIDECAR_CONNECT_TIMEOUT_MS = 10_000;

const MAX_FRAME_BYTES = 64 * 1024;

export interface TlsFingerprintSidecarOptions {
  /** The sidecar's Unix socket path (deployment-owned process). */
  readonly socketPath: string;
  /** Bounds the socket connect + dial-request/response exchange. */
  readonly connectTimeoutMs?: number;
}

interface DialResponseWire {
  readonly ok?: unknown;
  readonly error?: unknown;
}

function frame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

const BOUNDED_NUMBER_LISTS = [
  'cipherSuites',
  'curves',
  'pointFormats',
  'signatureAlgorithms',
  'supportedVersions',
  'keyShareGroups',
  'pskModes',
  'extensions',
] as const;

function isProfileSpecShape(value: unknown): value is ProviderTlsFingerprintProfileSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const spec = value as Record<string, unknown>;
  for (const key of BOUNDED_NUMBER_LISTS) {
    const list = spec[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 64 || list.some((entry) => typeof entry !== 'number')) return false;
  }
  const alpn = spec.alpnProtocols;
  if (alpn !== undefined && (!Array.isArray(alpn) || alpn.some((entry) => typeof entry !== 'string'))) return false;
  if (spec.name !== undefined && (typeof spec.name !== 'string' || spec.name.length > 128)) return false;
  if (spec.enableGrease !== undefined && typeof spec.enableGrease !== 'boolean') return false;
  return true;
}

/**
 * Validate the dispatch-profile fingerprint descriptor. Deliberately strict
 * (unknown keys rejected) so a malformed profile fails closed at the
 * dispatch-profile boundary instead of inside the connector.
 */
export function isProviderTlsFingerprintEgress(value: unknown): value is ProviderTlsFingerprintEgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const descriptor = value as Record<string, unknown>;
  const keys = Object.keys(descriptor);
  if (descriptor.selector === 'default' || descriptor.selector === 'random') {
    return keys.length === 1;
  }
  if (descriptor.selector === 'custom') {
    return keys.length === 2 && isProfileSpecShape(descriptor.profile);
  }
  return false;
}

/** Build the sidecar dial request body for one connection. */
export function buildSidecarDialRequest(input: {
  readonly hostname: string;
  readonly port: number;
  readonly fingerprint: ProviderTlsFingerprintEgress;
  readonly proxyUrl?: string;
}): Record<string, unknown> {
  const profile = input.fingerprint.profile;
  return {
    host: input.hostname,
    port: input.port,
    profile_id: input.fingerprint.selector,
    ...(input.fingerprint.selector === 'custom' && profile !== undefined
      ? {
          profile: {
            name: profile.name ?? '',
            enable_grease: profile.enableGrease === true,
            ...(profile.cipherSuites === undefined ? {} : { cipher_suites: profile.cipherSuites }),
            ...(profile.curves === undefined ? {} : { curves: profile.curves }),
            ...(profile.pointFormats === undefined ? {} : { point_formats: profile.pointFormats }),
            ...(profile.signatureAlgorithms === undefined ? {} : { signature_algorithms: profile.signatureAlgorithms }),
            ...(profile.alpnProtocols === undefined ? {} : { alpn_protocols: profile.alpnProtocols }),
            ...(profile.supportedVersions === undefined ? {} : { supported_versions: profile.supportedVersions }),
            ...(profile.keyShareGroups === undefined ? {} : { key_share_groups: profile.keyShareGroups }),
            ...(profile.pskModes === undefined ? {} : { psk_modes: profile.pskModes }),
            ...(profile.extensions === undefined ? {} : { extensions: profile.extensions }),
          },
        }
      : {}),
    ...(input.proxyUrl === undefined ? {} : { proxy_url: input.proxyUrl }),
  };
}

/**
 * One sidecar dial exchange: connect to the Unix socket, send the frame,
 * await the response frame. The returned socket is the raw tunnel (undici
 * speaks HTTP/1.1 over it; TLS already terminated inside the sidecar).
 */
export function sidecarDial(
  options: TlsFingerprintSidecarOptions,
  dial: Record<string, unknown>,
  callback: buildConnector.Callback,
): net.Socket {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_TLS_FINGERPRINT_SIDECAR_CONNECT_TIMEOUT_MS;
  let settled = false;
  let buffer: Buffer = Buffer.alloc(0);

  const socket = net.connect(options.socketPath);
  socket.setNoDelay(true);

  const timer = setTimeout(() => {
    settle(new TlsFingerprintSidecarError('CONNECT_TIMEOUT'), null);
  }, timeoutMs);

  function settle(error: Error | null, result: net.Socket | null): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.removeListener('data', onData);
    socket.removeListener('error', onError);
    socket.removeListener('close', onClose);
    if (error !== null || result === null) {
      socket.destroy();
      callback(error ?? new TlsFingerprintSidecarError('PROTOCOL_ERROR'), null);
      return;
    }
    callback(null, result);
  }

  function onError(error: Error): void {
    settle(error, null);
  }

  function onClose(): void {
    settle(new TlsFingerprintSidecarError('PROTOCOL_ERROR'), null);
  }

  function onData(chunk: Buffer): void {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    if (buffer.byteLength < 4) return;
    const length = buffer.readUInt32BE(0);
    if (length === 0 || length > MAX_FRAME_BYTES) {
      settle(new TlsFingerprintSidecarError('PROTOCOL_ERROR'), null);
      return;
    }
    if (buffer.byteLength < 4 + length) return;
    const payload = buffer.subarray(4, 4 + length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    } catch {
      settle(new TlsFingerprintSidecarError('PROTOCOL_ERROR'), null);
      return;
    }
    const response = parsed as DialResponseWire;
    if (typeof response?.ok !== 'boolean') {
      settle(new TlsFingerprintSidecarError('PROTOCOL_ERROR'), null);
      return;
    }
    if (response.ok !== true) {
      settle(new TlsFingerprintSidecarError('DIAL_REJECTED'), null);
      return;
    }
    // From here the socket is a raw tunnel. Bytes already received past the
    // response frame (TCP coalescing) must not be lost: pause (explicit, so
    // the unshifted chunk buffers instead of re-emitting into a listenerless
    // flowing stream), unshift, and resume on the consumer's first
    // 'data'/'readable' listener (an explicit pause is not auto-resumed by
    // attaching a listener). Bytes arriving later buffer in paused mode and
    // flow once the consumer attaches.
    const remainder = buffer.subarray(4 + length);
    if (remainder.byteLength > 0) {
      socket.pause();
      const pending = Buffer.allocUnsafe(remainder.byteLength);
      remainder.copy(pending);
      socket.unshift(pending);
      const resumeOnConsumer = (event: string | symbol): void => {
        if (event === 'data' || event === 'readable') {
          socket.removeListener('newListener', resumeOnConsumer);
          socket.resume();
        }
      };
      socket.on('newListener', resumeOnConsumer);
    }
    settle(null, socket);
  }

  function onConnect(): void {
    socket.write(frame(JSON.stringify(dial)));
  }

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  socket.once('connect', onConnect);

  return socket;
}

function sidecarProxyUrl(proxy: ProviderHttpEgressProxyTarget | undefined): string | undefined {
  if (proxy === undefined) return undefined;
  // The sidecar only tunnels through plain HTTP CONNECT and socks5h proxies;
  // https proxies are handled by the fallback below before reaching here.
  if (proxy.protocol === 'https') return undefined;
  const userinfo =
    proxy.username === '' ? '' : `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`;
  return `${proxy.protocol}://${userinfo}${proxy.hostname}:${proxy.port}`;
}

/**
 * The composing connector factory. Wire this as the transport's
 * `createConnector` when TLS fingerprinting is enabled; it delegates every
 * non-fingerprinted connection to the ordinary pinned connector, so the
 * default composition stays byte-identical for accounts without a bound
 * profile.
 */
export function createTlsFingerprintSidecarConnectorFactory(
  sidecar: TlsFingerprintSidecarOptions,
): (input: ProviderHttpConnectorInput) => ProviderHttpPinnedConnector {
  if (typeof sidecar?.socketPath !== 'string' || sidecar.socketPath === '') {
    throw new Error('the tls fingerprint sidecar requires a socket path');
  }
  return (input) => {
    const fingerprint = input.tlsFingerprint;
    if (fingerprint === undefined) {
      return createPinnedProviderHttpConnector(input);
    }
    // An HTTPS egress proxy cannot carry the sidecar tunnel: fall back to the
    // ordinary pinned proxy connector (drop the fingerprint, keep the proxy —
    // an egress downgrade would be the exact risk-control trigger the proxy
    // exists to prevent).
    if (input.proxy !== undefined && input.proxy.protocol === 'https') {
      return createPinnedProviderHttpConnector(input);
    }
    const dial = buildSidecarDialRequest({
      hostname: input.hostname,
      port: input.port,
      fingerprint,
      ...(input.proxy === undefined ? {} : { proxyUrl: sidecarProxyUrl(input.proxy) }),
    });
    const agent = new Agent({
      connect: (_connectOptions, callback) => sidecarDial(sidecar, dial, callback),
      connections: 1,
      maxRedirections: 0,
    });
    return {
      dispatcher: agent,
      close: () => agent.close(),
      destroy: (error) => agent.destroy(error ?? null),
    };
  };
}
